import type { Graph, GraphEdge, GraphNode } from '../graph.ts';
import { RULES } from '../rules.ts';
import type { Scene } from '../scene.ts';
import { GRID, GUTTER } from '../tokens.ts';
import {
  narrowPill,
  PILL_CLEAR,
  PILL_EDGE_CLEAR,
  PILL_NODE_CLEAR,
  STANDOFF,
  TURN,
  roundUp,
  simplify,
  slidePills,
  wrapPill,
  type ChannelLayout,
  type Pill,
  type SeatedPill,
} from './channels.ts';
import { isBoxyShape, LEAF_CENTRE_OFFSET, LEAF_GAP, LEAF_INDENT, TRUNK_OFFSET } from './stack.ts';

/**
 * DESIGN 2.7, phase 3a: the channel engine's general flowchart families —
 * trees (2.8's centring, applied recursively), decision diamonds and
 * reconverging branches (6.3's merged fan-in arrival), chain/fan hybrids,
 * loop-backs (6.7/6.8's side corridor), and the LR/TB variants of all of
 * them, in one planner with the axes swapped rather than separate code.
 *
 * The same floor-plan/plan/derive/realize order the fan and chain planners
 * use, generalized:
 *   FLOOR PLAN — ranks are rows, the bands between them and the corridors
 *     beside/between columns are first-class, reserved before placement;
 *   PLAN — every route is symbolic (which band lane, which corridor, which
 *     face); a node side that receives an edge never emits one (DESIGN 6.2's
 *     side exclusivity, held by construction: forward flow arrives on the
 *     flow-in face, leaves the flow-out face, and loop-backs exit a free
 *     side face);
 *   DERIVE — a band's height is what must live in it (turn legs, each pill
 *     plus clearance, its lanes at the 16 pitch), uniform per chart at the
 *     largest any band needs; a corridor's offset is derived from clearances
 *     and the pill that rides it;
 *   REALIZE — coordinates last, pills on their own edge's longest exclusive
 *     run, centre on the path.
 *
 * Unlike the fan and chain planners this one may DECLINE (return null): once
 * real sizes are known it verifies the seated result against the same
 * budgets the gate measures — width, aspect, crossings, clearances, 7.4's
 * even whitespace, 6.7's loop length — and a chart that cannot hold them
 * falls through to the old path unchanged rather than shipping a layout the
 * gate would fail.
 */

/** Room below a stacked parent before its first leaf (DESIGN 1.5). */
const FIRST_GAP = 24;
/** DESIGN 6.7: a corridor keeps this clear beyond the boxes it passes. */
const LOOP_CLEAR = 24;
/** Track pitch between parallel runs (DESIGN 6.4). */
const TRACK = 16;
/** DESIGN 6.1/6.8: an edge keeps this clear of a node it does not connect. */
const EDGE_NODE_CLEAR = 16;
/** DESIGN 2.9: visible line either side of a flank pill, before the stub and
 *  the arrowhead — what makes the run read as a line rather than two nubs. */
const FLANK_STUB = 16;
/** DESIGN 2.7: visible line either side of a branch pill on a fan's
 *  horizontal leg — the same 16 a flank run shows, for the same reason. */
const BRANCH_STUB = 16;

/** Development aid: `GC_GRID_DEBUG=1` logs why a chart fell back. Browser
 *  bundles have no `process`, so the read is through `globalThis`. */
const DEBUG = Boolean(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    'GC_GRID_DEBUG'
  ],
);
const decline = (why: string): null => {
  if (DEBUG) console.warn(`[grid] decline: ${why}`);
  return null;
};

interface FlowPt {
  u: number;
  v: number;
}

interface PlannedEdge {
  edge: GraphEdge;
  pts: FlowPt[];
  exempt?: 'bus' | 'wrap';
  /** DESIGN 6.14: a branch of a merged return bus. */
  isReturn?: boolean;
  /** The straight run the pill may sit on (flow coords), when labeled. */
  pillRun?: [FlowPt, FlowPt];
  /** Preferred pill centre along the run (flow coords), else run midpoint. */
  pillAt?: FlowPt;
}

interface SubExt {
  lo: number;
  hi: number;
  anchor: number;
  /** Child subtree offsets: the child's own `lo` sits at this offset. */
  kidAt: Map<string, number>;
  /**
   * DESIGN 2.8's extent, in the same frame as `lo`/`hi`: the boxes of this
   * node and of the ranks below it — the column the eye reads as
   * "this branch". It leaves
   * out the two things that hang off a column rather than belonging to it:
   * a 2.9 flank leaf (which sits in the flank gutter on its parent's own
   * row) and a stacked leaf list (which the leaf-stacking rule indents under
   * its parent on purpose). Those keep `lo`/`hi` — the packing extent — from
   * being the same number.
   */
  coreLo: number;
  coreHi: number;
}

export function layoutGrid(
  graph: Graph,
  scene: Scene,
  measureLine: (s: string) => number,
  packToDisplay = false,
): ChannelLayout | null {
  const TB = graph.direction === 'TB';
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  for (const e of graph.edges) if (!byId.has(e.from) || !byId.has(e.to)) return null;

  const su = (n: GraphNode): number => (TB ? n.width! : n.height!);
  const sv = (n: GraphNode): number => (TB ? n.height! : n.width!);
  const pu = (p: Pill): number => (TB ? p.width : p.height);
  const pv = (p: Pill): number => (TB ? p.height : p.width);

  const forward = graph.edges.filter((e) => !e.backward);
  const loops = graph.edges.filter((e) => e.backward);

  // Connectivity: one picture, not several — a disconnected paste keeps the
  // old path, which already knows how to pack islands.
  {
    const adj = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
    for (const e of graph.edges) {
      adj.get(e.from)!.push(e.to);
      adj.get(e.to)!.push(e.from);
    }
    const seen = new Set<string>([graph.nodes[0]!.id]);
    const stack = [graph.nodes[0]!.id];
    while (stack.length) {
      for (const nx of adj.get(stack.pop()!)!) {
        if (!seen.has(nx)) {
          seen.add(nx);
          stack.push(nx);
        }
      }
    }
    if (seen.size !== graph.nodes.length) return decline('disconnected');
  }

  // FLOOR PLAN 1: ranks, by longest path over the forward edges.
  const rank = new Map<string, number>();
  {
    const indeg = new Map<string, number>(graph.nodes.map((n) => [n.id, 0]));
    for (const e of forward) indeg.set(e.to, indeg.get(e.to)! + 1);
    const queue = graph.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
    for (const id of queue) rank.set(id, 0);
    let head = 0;
    while (head < queue.length) {
      const id = queue[head++]!;
      for (const e of forward) {
        if (e.from !== id) continue;
        rank.set(e.to, Math.max(rank.get(e.to) ?? 0, rank.get(id)! + 1));
        indeg.set(e.to, indeg.get(e.to)! - 1);
        if (indeg.get(e.to) === 0) queue.push(e.to);
      }
    }
    if (queue.length !== graph.nodes.length) return decline('forward cycle');
  }
  for (const e of loops) if (rank.get(e.to)! >= rank.get(e.from)! + 1) return decline('loop ranks');
  let maxRank = Math.max(...graph.nodes.map((n) => rank.get(n.id)!));
  if (maxRank === 0) return decline('single rank');

  // FLOOR PLAN 2: the seating tree. A node's primary parent is its first
  // in-edge from the rank directly above (one always exists — that is what
  // longest-path ranking means), so every tree edge spans exactly one band.
  // The rest of the forward edges are joins: reconvergence, handled with
  // 6.3's fan-in arrival — every arrival on a face shares one point.
  const treeEdge = new Map<string, GraphEdge>(); // child id -> its tree edge
  const kidsOf = new Map<string, GraphEdge[]>(graph.nodes.map((n) => [n.id, []]));
  const joins: GraphEdge[] = [];
  for (const e of forward) {
    if (!treeEdge.has(e.to) && rank.get(e.from)! === rank.get(e.to)! - 1) {
      treeEdge.set(e.to, e);
      kidsOf.get(e.from)!.push(e);
    } else {
      joins.push(e);
    }
  }

  const warnings: string[] = [];
  const pills = new Map<string, Pill>();
  for (const e of graph.edges) {
    const p = wrapPill(e, scene, measureLine, warnings);
    if (p) pills.set(e.id, p);
  }

  const roots = graph.nodes.filter((n) => !treeEdge.has(n.id));

  const touched = new Set<string>();
  for (const e of [...joins, ...loops]) {
    touched.add(e.from);
    touched.add(e.to);
  }
  const loopTouched = new Set<string>();
  for (const e of loops) {
    loopTouched.add(e.from);
    loopTouched.add(e.to);
  }

  /**
   * DESIGN 2.9: a terminal branch off a decision's side sits on the
   * decision's own row. Candidates are structural — the two guards the rule
   * names are the target being terminal (checked here) and the flank fitting
   * the declared display (checked by seating the chart with them and falling
   * back to today's ranks when it does not fit).
   *
   * At most one leaf per side (the rule's own limit), and at most one child
   * left below: with a single child below, that child sits on the parent's
   * own axis and leaves through the flow face, so nothing else wants the
   * side vertex the leaf run uses (DESIGN 6.2's side exclusivity, held by
   * construction). Two children left below would each want a vertex, so
   * that decision keeps today's ranks.
   */
  interface SideLeaf {
    edge: GraphEdge;
    parent: string;
    dir: -1 | 1;
  }
  const sideLeafCandidates: SideLeaf[] = [];
  {
    // DESIGN 2.9's first guard is about FORWARD exits. An edge that only
    // loops back to an earlier rank orders nothing downstream — the ranker
    // ignores back edges outright — so a leaf whose single exit is such a
    // loop is still terminal for seating purposes. A branch that continues
    // *forward* does have downstream order to keep, and still ranks down.
    const fwdOutDeg = new Map<string, number>(graph.nodes.map((n) => [n.id, 0]));
    for (const e of forward) fwdOutDeg.set(e.from, fwdOutDeg.get(e.from)! + 1);
    // Arrivals are unchanged: the leaf's only way in is its own tree edge, so
    // no join or loop lands on it and asks for a face the run wants.
    const arrivedAt = new Set<string>();
    for (const e of [...joins, ...loops]) arrivedAt.add(e.to);
    const terminal = (id: string): boolean =>
      fwdOutDeg.get(id) === 0 && !arrivedAt.has(id) && treeEdge.has(id);
    if (TB) {
      for (const p of graph.nodes) {
        if (p.shape !== 'diamond' || loopTouched.has(p.id)) continue;
        const kids = kidsOf.get(p.id)!;
        const cont = kids.filter((e) => !terminal(e.to));
        const term = kids.filter((e) => terminal(e.to));
        if (!term.length || cont.length > 1) continue;
        let low: GraphEdge[];
        let high: GraphEdge[];
        if (cont.length === 1) {
          // The branch that continues holds the axis; a leaf sits on the
          // side of it that reading order already put it on.
          const ci = kids.indexOf(cont[0]!);
          low = term.filter((e) => kids.indexOf(e) < ci);
          high = term.filter((e) => kids.indexOf(e) > ci);
        } else {
          // Both outcomes end: one leaf each side, in reading order.
          if (term.length !== 2) continue;
          low = [term[0]!];
          high = [term[1]!];
        }
        // Two leaves off the same side rank down as before.
        if (low.length > 1 || high.length > 1) continue;
        for (const e of low) sideLeafCandidates.push({ edge: e, parent: p.id, dir: -1 });
        for (const e of high) sideLeafCandidates.push({ edge: e, parent: p.id, dir: 1 });
      }
    }
  }

  const baseRank = new Map(rank);
  /** Leaf id -> its plan, for the leaves seated on their decision's row. */
  let sideRow = new Map<string, SideLeaf>();
  /** Tree children that still sit a rank below: everything but those. */
  let rowKidsOf = kidsOf;

  const height = new Map<string, number>();
  const subHeight = (id: string): number => {
    const cached = height.get(id);
    if (cached !== undefined) return cached;
    const kids = rowKidsOf.get(id)!;
    const h = kids.length ? 1 + Math.max(...kids.map((e) => subHeight(e.to))) : 1;
    height.set(id, h);
    return h;
  };

  /**
   * Re-rank for one attempt. With `on`, every 2.9 candidate is pulled up to
   * its decision's rank; a rank left empty by the move disappears and the
   * ranks below it slide up — the chart gets shorter.
   */
  const applySameRow = (on: boolean): boolean => {
    sideRow = new Map();
    for (const [id, r] of baseRank) rank.set(id, r);
    if (on) {
      for (const c of sideLeafCandidates) {
        sideRow.set(c.edge.to, c);
        rank.set(c.edge.to, baseRank.get(c.parent)!);
      }
    }
    rowKidsOf = on
      ? new Map(
          graph.nodes.map(
            (n) => [n.id, kidsOf.get(n.id)!.filter((e) => !sideRow.has(e.to))] as const,
          ),
        )
      : kidsOf;
    const used = [...new Set(graph.nodes.map((n) => rank.get(n.id)!))].sort((a, b) => a - b);
    if (used.length < 2) return false;
    const remap = new Map(used.map((r, i) => [r, i] as const));
    for (const n of graph.nodes) rank.set(n.id, remap.get(rank.get(n.id)!)!);
    maxRank = used.length - 1;
    // Every tree edge still spans exactly one band, every loop still points
    // back: the invariants the rest of the planner is written against.
    for (const [child, e] of treeEdge) {
      if (sideRow.has(child)) {
        if (rank.get(child)! !== rank.get(e.from)!) return false;
      } else if (rank.get(child)! !== rank.get(e.from)! + 1) return false;
    }
    for (const e of joins) if (rank.get(e.to)! <= rank.get(e.from)!) return false;
    for (const e of loops) if (rank.get(e.to)! > rank.get(e.from)!) return false;
    height.clear();
    for (const n of graph.nodes) subHeight(n.id);
    return true;
  };

  // DESIGN 1.5: leaf stacking, the packing move a too-wide tree gets before
  // being declined. All-or-nothing on the last rank, so the stacks replace a
  // whole row rather than hanging beside one (2.3's shared rows).
  const stackableParents = (): Set<string> | null => {
    if (!TB) return null;
    const parents = new Set<string>();
    for (const n of graph.nodes) {
      if (rank.get(n.id)! !== maxRank) continue;
      const te = treeEdge.get(n.id);
      if (!te || pills.has(te.id)) return null;
      if (kidsOf.get(n.id)!.length > 0 || touched.has(n.id)) return null;
      parents.add(te.from);
    }
    if (!parents.size) return null;
    for (const p of parents) {
      const kids = kidsOf.get(p)!;
      if (kids.length < 2) return null;
      if (kids.some((e) => rank.get(e.to)! !== maxRank)) return null;
    }
    return parents;
  };

  // SEAT — recursive tidy tree over the cross axis. Subtrees are seated
  // first, then each parent is centred on the geometric extent of its
  // entire subtree (DESIGN 2.8, applied at every level); when depths differ,
  // the deepest branch keeps the
  // parent's own axis (the decision-cascade spine) and shallow branches sit
  // beside it.
  const seatAll = (
    stacked: Set<string>,
    flipShallow: boolean,
    mirrorLegs = true,
  ): { anchor: Map<string, number>; width: number } | null => {
    const exts = new Map<string, SubExt>();
    // DESIGN 2.9's geometry: the flank gutter is one CHART-WIDE value, so
    // same-flank leaves on different rows share an exact x (2.3 applied to
    // flanks) — two-diamonds' Beta and Gamma line up, and so do
    // diamond-cascade's two Rejects. Derived the way 2.7 derives any channel,
    // from what has to live in the gap: the widest flank pill, 16 of visible
    // line either side of it (so no pill is left with 7-unit nubs), the
    // arrowhead at the leaf's face and the stub at the decision's vertex.
    // Never less than a sibling gutter.
    const flankGap = sideRow.size
      ? Math.max(
          GUTTER.sibling,
          roundUp(
            Math.max(
              0,
              ...[...sideRow.values()].map((s) => {
                const pill = pills.get(s.edge.id);
                return pill ? pu(pill) : 0;
              }),
            ) +
              2 * FLANK_STUB +
              scene.edgeGap +
              scene.edgeGapStart,
            GRID,
          ),
        )
      : 0;
    const build = (id: string): SubExt => {
      const cached = exts.get(id);
      if (cached) return cached;
      const node = byId.get(id)!;
      const w = su(node);
      const flanks = kidsOf.get(id)!.filter((e) => sideRow.has(e.to));
      const flankOf = (dir: -1 | 1): { edge: GraphEdge; gap: number; width: number } | null => {
        for (const e of flanks) {
          if (sideRow.get(e.to)!.dir !== dir) continue;
          return { edge: e, gap: flankGap, width: su(byId.get(e.to)!) };
        }
        return null;
      };
      const flankLo = flankOf(-1);
      const flankHi = flankOf(1);
      const padLo = flankLo ? flankLo.gap + flankLo.width : 0;
      const padHi = flankHi ? flankHi.gap + flankHi.width : 0;
      /** Seat the row-mates around a parent box centred at `anchor`. */
      const seatFlanks = (kidAt: Map<string, number>, anchorAt: number): void => {
        if (flankLo) {
          build(flankLo.edge.to);
          kidAt.set(flankLo.edge.to, anchorAt - w / 2 - padLo);
        }
        if (flankHi) {
          build(flankHi.edge.to);
          kidAt.set(flankHi.edge.to, anchorAt + w / 2 + flankHi.gap);
        }
      };
      let ext: SubExt;
      if (stacked.has(id)) {
        const kids = kidsOf.get(id)!;
        const boxy = isBoxyShape(node.shape);
        const colLo = boxy ? LEAF_INDENT : w / 2 + LEAF_CENTRE_OFFSET;
        const kidW = Math.max(...kids.map((e) => su(byId.get(e.to)!)));
        const kidAt = new Map<string, number>();
        for (const e of kids) {
          build(e.to); // a stacked leaf still needs its own (trivial) extent
          kidAt.set(e.to, colLo);
        }
        // The stacked leaf column is indented under the node by its own rule,
        // so 2.8's extent is the node's box alone.
        ext = { lo: 0, hi: Math.max(w, colLo + kidW), anchor: w / 2, kidAt, coreLo: 0, coreHi: w };
      } else {
        const kidEdges = rowKidsOf.get(id)!;
        if (!kidEdges.length) {
          const kidAt = new Map<string, number>();
          seatFlanks(kidAt, w / 2);
          // Flanks sit in the gutter beside this box, not under it.
          ext = { lo: -padLo, hi: w + padHi, anchor: w / 2, kidAt, coreLo: 0, coreHi: w };
        } else {
          const hs = kidEdges.map((e) => subHeight(e.to));
          const deepest = Math.max(...hs);
          const allEqual = hs.every((h) => h === deepest);
          let ordered = kidEdges;
          if (!allEqual && flipShallow) {
            // The flip variant: shallow branches to alternating sides by the
            // parent's rank parity — the "go side by side instead" DESIGN
            // 1.4 asks of a cascade whose exits all fell on one side.
            const deep = kidEdges.filter((e) => subHeight(e.to) === deepest);
            const shallow = kidEdges.filter((e) => subHeight(e.to) !== deepest);
            ordered = rank.get(id)! % 2 === 0 ? [...shallow, ...deep] : [...deep, ...shallow];
          }
          const kidExts = ordered.map((e) => build(e.to));
          const kidAt = new Map<string, number>();
          let cur = 0;
          const anchorsRel: number[] = [];
          for (let i = 0; i < ordered.length; i++) {
            const ke = kidExts[i]!;
            let gap = GUTTER.sibling;
            if (i > 0) {
              const prev = kidExts[i - 1]!;
              const pill0 = pills.get(ordered[i - 1]!.id);
              const pill1 = pills.get(ordered[i]!.id);
              const need =
                ((pill0 ? pu(pill0) : 0) + (pill1 ? pu(pill1) : 0)) / 2 + PILL_CLEAR;
              const dist = prev.hi - prev.anchor + gap + ke.anchor - ke.lo;
              if (dist < need) gap += need - dist;
              cur += gap;
            }
            kidAt.set(ordered[i]!.to, cur);
            anchorsRel.push(cur + (ke.anchor - ke.lo));
            cur += ke.hi - ke.lo;
          }
          const anchorKids = allEqual
            ? ordered.map((_, i) => i)
            : ordered.map((_, i) => i).filter((i) => subHeight(ordered[i]!.to) === deepest);
          // DESIGN 2.8 (revised 2026-09-04): what decides where the parent
          // sits is each child's WHOLE subtree, not the child's own box. The
          // subtrees are seated first (this is the recursion's return trip),
          // so `coreLo..coreHi` is already the union of every box in the
          // child's column; the midpoint of those columns is the axis the eye
          // weighs. A childless child's column is just its box, so pure fans
          // and even trees do not move; only a parent whose children carry
          // uneven subtrees does. org-chart's director was 46 off the centre
          // of its five-leaf bottom row because Careers' branch is one leaf
          // wide and its two siblings are two.
          const kidCore = (i: number): [number, number] => {
            const base = kidAt.get(ordered[i]!.to)! - kidExts[i]!.lo;
            return [base + kidExts[i]!.coreLo, base + kidExts[i]!.coreHi];
          };
          const centreOfKids = (): number => {
            const subLo = Math.min(...anchorKids.map((i) => kidCore(i)[0]));
            const subHi = Math.max(...anchorKids.map((i) => kidCore(i)[1]));
            return (subLo + subHi) / 2;
          };
          let anchor = centreOfKids();
          // DESIGN 2.7: a fan's horizontal branch legs are ONE shared derived
          // length — the widest pill any branch carries, 16 of visible line
          // either side of it, and the two turns the leg spends getting off
          // the trunk and onto the drop. Derived once and applied to every
          // off-axis branch, so the labels mirror across the trunk instead of
          // one hanging below the bus because its own leg came up short. The
          // push travels outward (an outer branch moves with the branch that
          // asked), so every packing gap this loop just derived survives it,
          // and it is symmetric where the branches are, so 2.8's centring
          // holds — the anchor is re-derived after each pass all the same.
          const branchPill = Math.max(
            0,
            ...ordered.map((e) => {
              const pill = pills.get(e.id);
              return pill ? pu(pill) : 0;
            }),
          );
          // Two branches only: three or more ride one bus (6.12), where the
          // pills share a single horizontal line and the packing gap above
          // already keeps them apart.
          const legNeed =
            branchPill && mirrorLegs && ordered.length === 2
              ? roundUp(branchPill + 2 * BRANCH_STUB + 2 * TURN, GRID)
              : 0;
          for (let pass = 0; legNeed && pass < 4; pass++) {
            let moved = false;
            for (const side of [-1, 1] as const) {
              const outward = ordered
                .map((_, i) => i)
                .filter((i) => Math.sign(anchorsRel[i]! - anchor) === side)
                .filter((i) => Math.abs(anchorsRel[i]! - anchor) >= 1)
                .sort((a, b) => Math.abs(anchorsRel[a]! - anchor) - Math.abs(anchorsRel[b]! - anchor));
              let cum = 0;
              for (const i of outward) {
                const d = Math.abs(anchorsRel[i]! - anchor) + cum;
                if (d < legNeed - 0.5) cum += legNeed - d;
                if (!cum) continue;
                anchorsRel[i]! += side * cum;
                kidAt.set(ordered[i]!.to, kidAt.get(ordered[i]!.to)! + side * cum);
                moved = true;
              }
            }
            if (!moved) break;
            anchor = centreOfKids();
          }
          const childLo = Math.min(...ordered.map((e) => kidAt.get(e.to)!));
          const childHi = Math.max(
            ...ordered.map((e, i) => kidAt.get(e.to)! + kidExts[i]!.hi - kidExts[i]!.lo),
          );
          seatFlanks(kidAt, anchor);
          const lo = Math.min(childLo, anchor - w / 2 - padLo);
          const hi = Math.max(childHi, anchor + w / 2 + padHi);
          // This column, for the rank above: every child's column plus this
          // box. Only the ANCHOR kids count — with uneven depths the shallow
          // branches sit beside the spine rather than under it, the same set
          // 2.8's centring above uses.
          const coreLo = Math.min(anchor - w / 2, ...anchorKids.map((i) => kidCore(i)[0]));
          const coreHi = Math.max(anchor + w / 2, ...anchorKids.map((i) => kidCore(i)[1]));
          ext = { lo, hi, anchor, kidAt, coreLo, coreHi };
        }
      }
      exts.set(id, ext);
      return ext;
    };

    const anchor = new Map<string, number>();
    const placeSub = (id: string, base: number): void => {
      const ext = exts.get(id)!;
      anchor.set(id, base - ext.lo + ext.anchor);
      for (const [kid, at] of ext.kidAt) placeSub(kid, base - ext.lo + at);
    };
    let cursor = 0;
    for (let i = 0; i < roots.length; i++) {
      const ext = build(roots[i]!.id);
      if (i > 0) cursor += GUTTER.panel;
      placeSub(roots[i]!.id, cursor);
      cursor += ext.hi - ext.lo;
    }
    return { anchor, width: cursor };
  };

  const room = scene.canvas.width - scene.canvas.margin * 2;

  /**
   * DESIGN 2.7 + 6.5: give the widest one-line branch label a second line.
   *
   * The shared branch-leg length is derived from that label, so it can ask
   * for more width than the canvas has. A second pill line is much the
   * cheaper way to pay for it — the layout keeps its width and every branch
   * label keeps its place on a run — so the derivation buys it before it
   * gives up on the placement. Returns false when nothing can wrap further.
   */
  const narrowWidestBranchPill = (): boolean => {
    let best: { id: string; pill: Pill; was: number } | null = null;
    for (const n of graph.nodes) {
      const kids = rowKidsOf.get(n.id)!;
      if (kids.length !== 2) continue;
      for (const e of kids) {
        const pill = pills.get(e.id);
        if (!pill || (best && pill.width <= best.was)) continue;
        const narrower = narrowPill(pill, scene, measureLine);
        if (narrower) best = { id: e.id, pill: narrower, was: pill.width };
      }
    }
    if (!best) return false;
    pills.set(best.id, best.pill);
    return true;
  };

  const attempt = (flipShallow: boolean, sameRow: boolean): ChannelLayoutPlan | null => {
    if (!applySameRow(sameRow)) return decline('same-row ranks');
    let stacked = new Set<string>();
    let seated = seatAll(stacked, flipShallow);
    if (!seated) return null;
    if (seated.width > room && !packToDisplay) {
      // The derived legs (2.7) are what overflowed if the same seating fits
      // without them: wrap the branch label and derive again. Only when no
      // label can wrap any further does the fan seat as if the rule were not
      // there — and then its pills hang below the bus together (`legHosts`),
      // mirrored on the drops rather than one up and one down.
      const plain = seatAll(stacked, flipShallow, false);
      if (plain && plain.width <= room) {
        while (seated && seated.width > room && narrowWidestBranchPill())
          seated = seatAll(stacked, flipShallow);
        if (!seated || seated.width > room) seated = plain;
      }
    }
    if (!seated) return null;
    if (seated.width > room) {
      // Under a declared display the old path owns packing — its widest-
      // first stacking, fold and sibling wrap (DESIGN 1.5/1.2/1.6) are
      // richer than the all-or-nothing stack this planner knows.
      if (packToDisplay)
        return decline(`declared display needs packing (${Math.round(seated.width)} > ${room})`);
      const parents = stackableParents();
      if (!parents) return decline(`too wide unstacked (${Math.round(seated.width)} > ${room})`);
      stacked = parents;
      seated = seatAll(stacked, flipShallow);
      if (!seated || seated.width > room)
        return decline(`too wide stacked (${Math.round(seated?.width ?? -1)} > ${room})`);
    }
    return plan(seated.anchor, stacked);
  };

  interface ChannelLayoutPlan {
    layout: ChannelLayout;
    commit: () => void;
  }

  // PLAN + DERIVE + REALIZE, over one seating. Everything is computed into
  // local structures; nothing touches the graph until `commit`.
  const plan = (
    anchorU: Map<string, number>,
    stacked: Set<string>,
  ): ChannelLayoutPlan | null => {
    const stackedLeaves = new Set<string>();
    for (const p of stacked) for (const e of kidsOf.get(p)!) stackedLeaves.add(e.to);
    const lastRow = stackedLeaves.size ? maxRank - 1 : maxRank;

    const rowNodes: GraphNode[][] = [];
    for (let r = 0; r <= lastRow; r++) rowNodes.push([]);
    for (const n of graph.nodes) {
      if (stackedLeaves.has(n.id)) continue;
      rowNodes[rank.get(n.id)!]!.push(n);
    }
    for (const row of rowNodes) {
      if (!row.length) return null;
      row.sort((a, b) => anchorU.get(a.id)! - anchorU.get(b.id)!);
    }
    const rowSv = rowNodes.map((row) => Math.max(...row.map(sv)));

    const arrowRoom = scene.edgeGap + 4;

    /**
     * How each tree edge leaves its parent. DESIGN 6.4 wants separate
     * attachment points; the shared-trunk bus is the exemption 6.12 grants
     * a fan of three or more. A two-branch parent gets genuinely separate
     * exits: the axis child straight out of the flow face's centre; a side
     * child out of a diamond's own side face (the classic decision shape)
     * or, for a boxy parent, from its own port on the flow face, 16 off
     * centre (6.8's ordered ports).
     */
    type TreeMode =
      | { kind: 'straight' }
      | { kind: 'bus' }
      | { kind: 'trunk' }
      | { kind: 'side'; faceU: number }
      | { kind: 'rowleaf'; dir: -1 | 1 }
      | { kind: 'port'; portU: number };
    const treeMode = new Map<string, TreeMode>();
    for (const p of graph.nodes) {
      for (const e of kidsOf.get(p.id)!) {
        const s = sideRow.get(e.to);
        if (s) treeMode.set(e.id, { kind: 'rowleaf', dir: s.dir });
      }
      const kids = rowKidsOf.get(p.id)!;
      if (!kids.length || stacked.has(p.id)) continue;
      const pU = anchorU.get(p.id)!;
      const r = rank.get(p.id)!;
      if (kids.length >= 3) {
        for (const e of kids) treeMode.set(e.id, { kind: 'bus' });
        continue;
      }
      for (const e of kids) {
        const kU = anchorU.get(e.to)!;
        if (Math.abs(kU - pU) < 1) {
          treeMode.set(e.id, { kind: 'straight' });
          continue;
        }
        const kid = byId.get(e.to)!;
        const dir = Math.sign(kU - pU);
        if (!isBoxyShape(p.shape)) {
          const faceU = pU + (dir * su(p)) / 2;
          const boxesOverlap =
            pU - su(p) / 2 < kU + su(kid) / 2 && kU - su(kid) / 2 < pU + su(p) / 2;
          const loA = dir > 0 ? faceU : kU - EDGE_NODE_CLEAR;
          const hiA = dir > 0 ? kU + EDGE_NODE_CLEAR : faceU;
          const blocked = rowNodes[r]!.some((n) => {
            if (n.id === p.id) return false;
            const a = anchorU.get(n.id)!;
            return a + su(n) / 2 > loA && a - su(n) / 2 < hiA;
          });
          treeMode.set(e.id, !boxesOverlap && !blocked ? { kind: 'side', faceU } : { kind: 'trunk' });
        } else {
          treeMode.set(e.id, { kind: 'port', portU: pU + dir * TRACK });
        }
      }
    }
    const modeOf = (e: GraphEdge): TreeMode => treeMode.get(e.id) ?? { kind: 'straight' };

    /**
     * DESIGN 2.7: the horizontal branch legs of one fan share a derived
     * length, so their labels mirror across the trunk. The answer is
     * therefore the fan's, not the branch's: either every branch pill fits
     * its own leg — the seating is derived so that it does — or none of them
     * rides one and they hang below the bus together. A pill on its run
     * beside a sibling's hanging off its drop is exactly the tell the rule
     * names.
     */
    const legRoom = (from: number, kU: number, pill: Pill): boolean =>
      Math.abs(kU - from) - 2 * TURN - 2 >= pu(pill);
    const fanLegs = new Map<string, boolean>();
    const legHosts = (pid: string): boolean => {
      const cached = fanLegs.get(pid);
      if (cached !== undefined) return cached;
      let all = true;
      for (const e of rowKidsOf.get(pid)!) {
        const pill = pills.get(e.id);
        if (!pill) continue;
        const mode = modeOf(e);
        if (mode.kind !== 'port' && mode.kind !== 'trunk') continue;
        const from = mode.kind === 'port' ? mode.portU : anchorU.get(pid)!;
        if (!legRoom(from, anchorU.get(e.to)!, pill)) all = false;
      }
      fanLegs.set(pid, all);
      return all;
    };

    // Lane allocation per band (band b sits between rows b and b+1). Same-
    // band joins ride a lane below the buses; a multi-rank join takes one
    // lane in its source band and one in its arrival band; a loop-back takes
    // an arrival lane in the band above its target (or the reserved strip
    // above row 0 / below the last row when there is no band there).
    //
    // A lane belongs to a *route*, not to an edge. DESIGN 6.14's return bus
    // puts several loop-backs on one drawn line by construction, exactly as
    // 1.5's leaf-stack trunk and 6.12's row bus do on the forward side; a
    // lane each is precisely the nest of concentric rings 6.14 forbids.
    const laneEdges: GraphEdge[][] = Array.from({ length: lastRow }, () => []);
    const laneSlots: number[] = Array.from({ length: lastRow }, () => 0);
    const laneIndex = new Map<string, number>(); // `${edgeId}@${band}` -> k
    /** Lanes that must hold a pill, not just a line: `${edgeId}@${band}`. */
    const lanePills = new Set<string>();
    const allocLane = (band: number, es: GraphEdge[]): boolean => {
      if (band < 0 || band >= lastRow) return false;
      const k = laneSlots[band]!++;
      for (const e of es) {
        laneIndex.set(`${e.id}@${band}`, k);
        laneEdges[band]!.push(e);
      }
      return true;
    };
    // Strips outside the rows: one slot per route, same as a lane.
    const stripTop: GraphEdge[][] = [];
    const stripBottom: GraphEdge[][] = [];
    const stripSlot = new Map<string, number>(); // `${edgeId}@top|bottom` -> k
    const allocStrip = (where: 'top' | 'bottom', es: GraphEdge[]): void => {
      const strip = where === 'top' ? stripTop : stripBottom;
      const k = strip.length;
      strip.push(es);
      for (const e of es) stripSlot.set(`${e.id}@${where}`, k);
    };

    for (const e of joins) {
      const rs = rank.get(e.from)!;
      const rt = rank.get(e.to)!;
      if (stackedLeaves.has(e.from) || stackedLeaves.has(e.to)) return decline('join touches stack');
      if (rt === rs + 1) {
        if (!allocLane(rs, [e])) return decline('join lane');
        if (pills.has(e.id)) lanePills.add(`${e.id}@${rs}`);
      } else {
        if (!allocLane(rs, [e]) || !allocLane(rt - 1, [e])) return decline('join lanes');
      }
    }

    /**
     * DESIGN 6.14: one plan per *target*, not per loop-back. Every return
     * into one node is one bus — one corridor on one flank, one trunk in it,
     * each source's branch joining the trunk, and one arrival carrying 6.3's
     * single head.
     */
    interface LoopPlan {
      target: string;
      edges: GraphEdge[];
      side: -1 | 1; // -1 = low-u side, 1 = high-u side
      exit: 'side' | 'flow';
      corridorU: number;
      /** Rows the corridor leg spans: the target's rank to the deepest source's. */
      rLo: number;
      rHi: number;
      /** Two or more sources: the merged bus. One source is just a loop-back. */
      bus: boolean;
    }
    const loopPlans: LoopPlan[] = [];
    const corridorLegs: { u: number; rLo: number; rHi: number; pillU: number }[] = [];

    /**
     * Every shape's widest lateral extent in the rows a corridor spans.
     *
     * DESIGN 6.7 (clarified 2026-09-03): nothing is exempt — the loop's own
     * source and target are shapes the corridor passes just like any other,
     * and a diamond's `su` is its side-vertex width, so the extent used is
     * the vertex, not the label box. The old connected-shape exemption is
     * what let git-workflow's CHANGES corridor turn up 8 from Review?'s
     * right vertex while the same chart's other loop stood 24 off Merge.
     */
    const rowSpanBoxes = (rLo: number, rHi: number) => {
      const boxes: { lo: number; hi: number }[] = [];
      for (let r = rLo; r <= rHi && r <= lastRow; r++) {
        for (const n of rowNodes[r]!) {
          const a = anchorU.get(n.id)!;
          boxes.push({ lo: a - su(n) / 2, hi: a + su(n) / 2 });
        }
      }
      // DESIGN 2.9: the flank between a decision and its row-mate is not
      // empty — the labeled run lives there, so a corridor clears it the way
      // it clears a box.
      for (const [leafId, s] of sideRow) {
        const r = rank.get(leafId)!;
        if (r < rLo || r > rHi) continue;
        const p = byId.get(s.parent)!;
        const faceU = anchorU.get(s.parent)! + (s.dir * su(p)) / 2;
        const nearU = anchorU.get(leafId)! - (s.dir * su(byId.get(leafId)!)) / 2;
        boxes.push({ lo: Math.min(faceU, nearU), hi: Math.max(faceU, nearU) });
      }
      if (rHi >= maxRank && stackedLeaves.size) {
        for (const id of stackedLeaves) {
          const n = byId.get(id)!;
          const a = anchorU.get(id)!;
          boxes.push({ lo: a - su(n) / 2, hi: a + su(n) / 2 });
        }
      }
      return boxes;
    };

    /** Push a corridor outward until it clears every box in its rows by
     *  `clear` — 6.7's 24 for a return, 6.1's 16 for a forward join — and
     *  every already-placed leg (track pitch, pill widths included). */
    const settleCorridor = (
      side: -1 | 1,
      start: number,
      rLo: number,
      rHi: number,
      myPillU: number,
      clear: number,
    ): number => {
      const boxes = rowSpanBoxes(rLo, rHi);
      let u = start;
      for (let guard = 0; guard < 64; guard++) {
        let moved = false;
        for (const b of boxes) {
          if (u > b.lo - clear && u < b.hi + clear) {
            u = side === -1 ? b.lo - clear : b.hi + clear;
            moved = true;
          }
        }
        for (const leg of corridorLegs) {
          if (leg.rHi < rLo || leg.rLo > rHi) continue;
          const sep = Math.max(TRACK, myPillU / 2 + 4, leg.pillU / 2 + 4);
          if (Math.abs(u - leg.u) < sep) {
            u = side === -1 ? leg.u - sep : leg.u + sep;
            moved = true;
          }
        }
        if (!moved) return u;
      }
      return u;
    };

    // DESIGN 6.14: group the loop-backs by target first. Widest span first,
    // so a long return claims its flank before a short one and the short one
    // is never left nested inside it.
    const loopGroups: { target: string; edges: GraphEdge[] }[] = [];
    {
      const byTarget = new Map<string, GraphEdge[]>();
      for (const e of loops) {
        if (stackedLeaves.has(e.from) || stackedLeaves.has(e.to))
          return decline('loop touches stack');
        const list = byTarget.get(e.to);
        if (list) list.push(e);
        else byTarget.set(e.to, [e]);
      }
      for (const [target, edges] of byTarget) loopGroups.push({ target, edges });
      const span = (g: { target: string; edges: GraphEdge[] }): number =>
        Math.max(...g.edges.map((e) => rank.get(e.from)!)) - rank.get(g.target)!;
      loopGroups.sort((a, b) => span(b) - span(a));
    }
    /** Flanks already carrying a return, with the rows it encloses. */
    const flankTaken: { side: -1 | 1; rLo: number; rHi: number }[] = [];

    for (const g of loopGroups) {
      const t = byId.get(g.target)!;
      const rt = rank.get(g.target)!;
      const rsMax = Math.max(...g.edges.map((e) => rank.get(e.from)!));
      const bus = g.edges.length > 1;
      const members = [t, ...g.edges.map((e) => byId.get(e.from)!)];
      const myPillU = Math.max(
        0,
        ...g.edges.map((e) => (pills.has(e.id) ? pu(pills.get(e.id)!) : 0)),
      );
      const clearAt = (u: number): boolean => {
        for (const b of rowSpanBoxes(rt, rsMax)) {
          if (u > b.lo - LOOP_CLEAR + 0.5 && u < b.hi + LOOP_CLEAR - 0.5) return false;
        }
        for (const leg of corridorLegs) {
          if (leg.rHi < rt || leg.rLo > rsMax) continue;
          const sep = Math.max(TRACK, myPillU / 2 + 4, leg.pillU / 2 + 4);
          if (Math.abs(u - leg.u) < sep - 0.5) return false;
        }
        return true;
      };
      const candidates: LoopPlan[] = [];
      for (const side of [-1, 1] as const) {
        // The corridor clears every node the bus serves, target included —
        // one flank for the whole group, not one per branch.
        const outerStart =
          side === -1
            ? Math.min(...members.map((n) => anchorU.get(n.id)! - su(n) / 2)) - LOOP_CLEAR
            : Math.max(...members.map((n) => anchorU.get(n.id)! + su(n) / 2)) + LOOP_CLEAR;
        const options = [settleCorridor(side, outerStart, rt, rsMax, myPillU, LOOP_CLEAR)];
        // The snug inner corridor: the nearest one DESIGN 6.8 allows, which
        // is 6.7's own 24 off the source's widest point on this flank — not
        // a jog's width off it. A lone return may stand there when nothing
        // else in the rows is nearer; a bus has to clear every source it
        // serves, so it only ever gets the outer corridor.
        if (!bus) {
          const s = byId.get(g.edges[0]!.from)!;
          const inner =
            side === -1
              ? anchorU.get(s.id)! - su(s) / 2 - LOOP_CLEAR
              : anchorU.get(s.id)! + su(s) / 2 + LOOP_CLEAR;
          if (clearAt(inner) && !options.some((u) => Math.abs(u - inner) < 1)) {
            options.unshift(inner);
          }
        }
        for (const u of options) {
          // A side-face exit needs a clear straight shot from the face to
          // the corridor across the source's own row. A bus never takes one:
          // its branches merge in a shared band below their own row, which
          // only a flow-face exit reaches (DESIGN 6.14's drawn shape).
          let exit: 'side' | 'flow' = 'flow';
          if (!bus) {
            const s = byId.get(g.edges[0]!.from)!;
            const sLo = anchorU.get(s.id)! - su(s) / 2;
            const sHi = anchorU.get(s.id)! + su(s) / 2;
            const blocked = rowNodes[rsMax]!.some((n) => {
              if (n.id === s.id) return false;
              const a = anchorU.get(n.id)!;
              const lo = a - su(n) / 2;
              const hi = a + su(n) / 2;
              const from = side === -1 ? Math.min(u, sLo) : Math.min(sHi, u);
              const to = side === -1 ? Math.max(u, sLo) : Math.max(sHi, u);
              return hi > from && lo < to;
            });
            exit = blocked ? 'flow' : 'side';
          }
          if (
            exit === 'flow' &&
            g.edges.some((e) => Math.abs(anchorU.get(e.from)! - u) < LOOP_CLEAR)
          )
            continue;
          candidates.push({
            target: g.target,
            edges: g.edges,
            side,
            exit,
            corridorU: u,
            rLo: rt,
            rHi: rsMax,
            bus,
          });
        }
      }
      if (!candidates.length) return decline(`loop into ${g.target} has no corridor`);
      // DESIGN 6.14: prefer the flank that encloses least — the return
      // hugs the content instead of lassoing it — and never a flank already
      // carrying a return over these rows (at most one corridor per flank,
      // and two loop routes that never nest).
      const enclosure = (c: LoopPlan): number =>
        members.reduce((acc, n) => acc + Math.abs(c.corridorU - anchorU.get(n.id)!), 0) +
        (c.exit === 'flow' ? 64 : 0) +
        (flankTaken.some((f) => f.side === c.side && f.rHi >= c.rLo && f.rLo <= c.rHi) ? 4096 : 0);
      candidates.sort(
        (a, b) =>
          enclosure(a) - enclosure(b) ||
          // A tie is a symmetric picture. The bus starts at the last source
          // in reading order, so it turns up the high-u flank; a lone return
          // keeps the low-u one it has always taken.
          (bus ? b.side - a.side : a.side - b.side),
      );
      const pick = candidates[0]!;
      loopPlans.push(pick);
      flankTaken.push({ side: pick.side, rLo: pick.rLo, rHi: pick.rHi });
      corridorLegs.push({ u: pick.corridorU, rLo: rt, rHi: rsMax, pillU: myPillU });
      // Arrival: one lane for the whole group — the band above the target,
      // or the strip above row 0. One lane is what merges the heads (6.3).
      if (rt > 0) {
        if (!allocLane(rt - 1, g.edges)) return decline('loop arrival lane');
      } else {
        allocStrip('top', g.edges);
      }
      // A flow-face exit needs a band below the sources' row too — one lane
      // per row, shared by every branch leaving from it (the shared band).
      if (pick.exit === 'flow') {
        const byRow = new Map<number, GraphEdge[]>();
        for (const e of g.edges) {
          const rs = rank.get(e.from)!;
          const list = byRow.get(rs);
          if (list) list.push(e);
          else byRow.set(rs, [e]);
        }
        for (const [rs, es] of byRow) {
          if (rs === lastRow) allocStrip('bottom', es);
          else {
            if (!allocLane(rs, es)) return decline('loop exit lane');
            for (const e of es) if (pills.has(e.id)) lanePills.add(`${e.id}@${rs}`);
          }
        }
      }
    }

    // Corridors for multi-rank joins: adjacent to the target's own column
    // (DESIGN 6.13's shared corridor), on whichever side is clear.
    const joinCorridor = new Map<string, number>();
    for (const e of joins) {
      const rs = rank.get(e.from)!;
      const rt = rank.get(e.to)!;
      if (rt === rs + 1) {
        // Same band: the lane run from source to target must cross no other
        // rank-rt drop (a foreign forward vertical), or the two would cross.
        const sU = anchorU.get(e.from)!;
        const tU = anchorU.get(e.to)!;
        const crossed = rowNodes[rt]!.some((n) => {
          if (n.id === e.to) return false;
          const a = anchorU.get(n.id)!;
          return a > Math.min(sU, tU) && a < Math.max(sU, tU);
        });
        if (crossed) return decline(`join ${e.id} crosses a drop`);
        continue;
      }
      const t = byId.get(e.to)!;
      const tLo = anchorU.get(t.id)! - su(t) / 2;
      const tHi = anchorU.get(t.id)! + su(t) / 2;
      const myPillU = pills.has(e.id) ? pu(pills.get(e.id)!) : 0;
      let placed: number | null = null;
      for (const side of [1, -1] as const) {
        const start = side === -1 ? tLo - LOOP_CLEAR : tHi + LOOP_CLEAR;
        const u = settleCorridor(side, start, rs + 1, rt - 1, myPillU, EDGE_NODE_CLEAR);
        const sU = anchorU.get(e.from)!;
        const tU = anchorU.get(e.to)!;
        // The source-band run must cross only the source's own drops; the
        // arrival-band run must cross none.
        const srcBad = rowNodes[rs + 1]!.some((n) => {
          const a = anchorU.get(n.id)!;
          if (!(a > Math.min(sU, u) && a < Math.max(sU, u))) return false;
          return treeEdge.get(n.id)?.from !== e.from;
        });
        const dstBad = rowNodes[rt]!.some((n) => {
          if (n.id === e.to) return false;
          const a = anchorU.get(n.id)!;
          return a > Math.min(u, tU) && a < Math.max(u, tU);
        });
        if (srcBad || dstBad) continue;
        placed = u;
        corridorLegs.push({ u, rLo: rs + 1, rHi: rt - 1, pillU: myPillU });
        break;
      }
      if (placed === null) return decline(`join ${e.id} has no clean corridor`);
      joinCorridor.set(e.id, placed);
    }

    // DERIVE — the uniform band height, from what must live in each band
    // (DESIGN 2.7): trunk turn legs, each drop pill plus clearances, the
    // lanes at their pitch.
    let bandNeed = 48;
    const laneSlot: number[] = [];
    for (let b = 0; b < lastRow; b++) {
      const halfTurn = STANDOFF + 2 * TURN;
      let fanPillBelow = 0;
      let straightNeed = 0;
      let busy = false;
      for (const p of rowNodes[b]!) {
        // A 2.9 row-mate's run lives in its own row, so it asks nothing of
        // any band: `rowKidsOf` is what this band has to hold.
        const kids = rowKidsOf.get(p.id)!;
        if (!kids.length || stacked.has(p.id)) continue;
        for (const ke of kids) {
          const mode = modeOf(ke);
          const kU = anchorU.get(ke.to)!;
          const pU0 = anchorU.get(p.id)!;
          if (
            mode.kind === 'bus' ||
            mode.kind === 'trunk' ||
            (mode.kind === 'port' && Math.abs(kU - pU0) >= 1)
          ) {
            busy = true; // a turn lives in this band
          }
          const pill = pills.get(ke.id);
          if (!pill) continue;
          const onLine = (): void => {
            // Pill centred on a line the band hosts: pill plus 8 each side.
            straightNeed = Math.max(straightNeed, pv(pill) + 2 * PILL_NODE_CLEAR);
          };
          const belowBus = (): void => {
            // The pill lives entirely on the exclusive drop below the bus
            // line — the band must hold it in that half (bus is centred).
            straightNeed = Math.max(straightNeed, 2 * (PILL_CLEAR + pv(pill) + PILL_NODE_CLEAR));
          };
          switch (mode.kind) {
            case 'straight': {
              const shared = kids.some(
                (o) => o !== ke && (modeOf(o).kind === 'trunk' || modeOf(o).kind === 'bus'),
              );
              if (shared) belowBus();
              else onLine();
              break;
            }
            case 'side':
              // Rides the row-level run beside the diamond, or its own drop
              // through the band when that run is too short for it.
              if (Math.abs(kU - mode.faceU) - TURN - PILL_CLEAR < pu(pill)) onLine();
              break;
            case 'port':
              if (legHosts(p.id)) onLine();
              else {
                fanPillBelow = Math.max(
                  fanPillBelow,
                  pv(pill) + PILL_NODE_CLEAR + arrowRoom + PILL_CLEAR,
                );
              }
              break;
            case 'trunk':
              if (legHosts(p.id)) onLine();
              else {
                fanPillBelow = Math.max(
                  fanPillBelow,
                  pv(pill) + PILL_NODE_CLEAR + arrowRoom + PILL_CLEAR,
                );
              }
              break;
            case 'bus': {
              if (busRunFor(p.id, ke) !== null) {
                onLine();
              } else if (Math.abs(kU - pU0) < 1) {
                belowBus();
              } else {
                // The 16 above the hanging pill is owed to a *sibling's*
                // bus run passing over this drop (DESIGN 2.7: derived from
                // what is really there).
                const crossedAbove = kids.some((other) => {
                  if (other === ke) return false;
                  const oU = anchorU.get(other.to)!;
                  return kU > Math.min(pU0, oU) + 1 && kU < Math.max(pU0, oU) - 1;
                });
                fanPillBelow = Math.max(
                  fanPillBelow,
                  (crossedAbove ? PILL_EDGE_CLEAR : 0) + pv(pill) + PILL_NODE_CLEAR + arrowRoom,
                );
              }
              break;
            }
          }
        }
      }
      const lanes = laneSlots[b]!;
      // Only a same-band join's pill rides its lane, plus a return-bus
      // branch's pill on its own band run (6.14); a lone loop's pill rides
      // its corridor leg instead.
      const lanePill = laneEdges[b]!.some((e) => lanePills.has(`${e.id}@${b}`));
      const slot = lanePill ? 24 : TRACK;
      laneSlot.push(slot);
      const laneZone = lanes ? 8 + slot * lanes : 0;
      bandNeed = Math.max(
        bandNeed,
        straightNeed,
        busy ? 2 * Math.max(halfTurn, fanPillBelow) : 0,
        busy && lanes ? 2 * (TRACK + laneZone) : 0,
        lanes ? laneZone + TRACK : 0,
      );
    }
    const bandV = roundUp(bandNeed, GRID);

    // Strips above the first row / below the last, for loops that arrive at
    // a root or leave the last row through the flow face. The first slot
    // stands off by DESIGN 6.7's own 24 — a return runs *around* the
    // content, and 16 would be exactly the clearance floor 6.8 measures.
    const stripSlotTop = TRACK;
    const stripSlotBottom = TRACK;
    const stripTopV = stripTop.length ? LOOP_CLEAR + stripSlotTop * (stripTop.length - 1) : 0;

    // Row centres along the flow axis.
    const rowC: number[] = [];
    let vCursor = stripTopV;
    for (let r = 0; r <= lastRow; r++) {
      rowC.push(vCursor + rowSv[r]! / 2);
      vCursor += rowSv[r]!;
      if (r < lastRow) vCursor += bandV;
    }
    const rowTopMin = (r: number): number => rowC[r]! - rowSv[r]! / 2;
    const rowBottomMax = (r: number): number => rowC[r]! + rowSv[r]! / 2;
    const topOf = (n: GraphNode): number => rowC[rank.get(n.id)!]! - sv(n) / 2;
    const bottomOf = (n: GraphNode): number => rowC[rank.get(n.id)!]! + sv(n) / 2;

    // Stacked leaves hang below their parent's row.
    const stackV = new Map<string, number>(); // leaf id -> centre v
    let stackBottom = lastRow >= 0 ? rowBottomMax(lastRow) : 0;
    for (const p of stacked) {
      let v = bottomOf(byId.get(p)!) + FIRST_GAP;
      for (const e of kidsOf.get(p)!) {
        const leaf = byId.get(e.to)!;
        stackV.set(e.to, v + sv(leaf) / 2);
        v += sv(leaf) + LEAF_GAP;
      }
      stackBottom = Math.max(stackBottom, v - LEAF_GAP);
    }

    const laneV = (b: number, e: GraphEdge): number => {
      const k = laneIndex.get(`${e.id}@${b}`)!;
      const slot = laneSlot[b]!;
      return rowTopMin(b + 1) - 8 - slot * k - slot / 2;
    };
    const stripTopLaneV = (e: GraphEdge): number =>
      rowTopMin(0) - LOOP_CLEAR - stripSlotTop * stripSlot.get(`${e.id}@top`)!;
    const stripBottomLaneV = (e: GraphEdge): number =>
      stackBottom + LOOP_CLEAR + stripSlotBottom * stripSlot.get(`${e.id}@bottom`)!;

    /**
     * DESIGN 6.5: the exclusive stretch of a fan branch's bus run — from
     * just past the nearest same-side sibling (whose own run covers the
     * footage before it) out to this branch's own turn — as a [from, to]
     * u-interval for the pill's run, or null when the branch is on the
     * trunk's own axis or the stretch cannot hold the pill.
     */
    function busRunFor(parentId: string, ke: GraphEdge): [number, number] | null {
      const pill = pills.get(ke.id);
      if (!pill) return null;
      const pU0 = anchorU.get(parentId)!;
      const kU = anchorU.get(ke.to)!;
      if (Math.abs(kU - pU0) < 1) return null;
      let bound = pU0;
      for (const other of rowKidsOf.get(parentId)!) {
        if (other === ke) continue;
        const oU = anchorU.get(other.to)!;
        if ((oU - pU0) * (kU - pU0) <= 0) continue; // other side
        if (Math.abs(oU - pU0) >= Math.abs(kU - pU0)) continue; // beyond us
        if (Math.abs(oU - pU0) > Math.abs(bound - pU0)) bound = oU;
      }
      const inner = bound === pU0 ? bound : bound + Math.sign(kU - bound) * (TURN + PILL_CLEAR);
      const outer = kU - Math.sign(kU - bound) * TURN;
      const lo = Math.min(inner, outer);
      const hi = Math.max(inner, outer);
      if (hi - lo < pu(pill) + 2) return null;
      return [lo, hi];
    }

    // PLAN routes.
    const planned: PlannedEdge[] = [];

    // Tree edges: the parent's bus (or a straight drop), centred between the
    // parent's own bottom face and its nearest child's top face — exactly
    // the wall-to-wall centre 6.8 asks of a Z's middle run.
    for (const p of graph.nodes) {
      const kids = rowKidsOf.get(p.id)!;
      const pU = anchorU.get(p.id)!;
      const pBottom = bottomOf(p);
      // DESIGN 2.9: one straight labeled run from the decision's side vertex
      // to the leaf's near face. No rank drop, no bends, one arrowhead, and
      // the pill on the run itself (6.5).
      for (const e of kidsOf.get(p.id)!) {
        const s = sideRow.get(e.to);
        if (!s) continue;
        const k = byId.get(e.to)!;
        const v = rowC[rank.get(p.id)!]!;
        const faceU = pU + (s.dir * su(p)) / 2;
        const nearU = anchorU.get(e.to)! - (s.dir * su(k)) / 2;
        const pill = pills.get(e.id);
        planned.push({
          edge: e,
          pts: [
            { u: faceU, v },
            { u: nearU, v },
          ],
          pillRun: pill
            ? [
                { u: Math.min(faceU, nearU) + PILL_CLEAR, v },
                { u: Math.max(faceU, nearU) - PILL_CLEAR, v },
              ]
            : undefined,
        });
      }
      if (!kids.length) continue;
      if (stacked.has(p.id)) {
        const boxy = isBoxyShape(p.shape);
        const trunkU = boxy ? pU - su(p) / 2 + TRUNK_OFFSET : pU;
        for (const e of kids) {
          const leaf = byId.get(e.to)!;
          const lv = stackV.get(e.to)!;
          const leafLo = anchorU.get(e.to)! - su(leaf) / 2;
          planned.push({
            edge: e,
            pts: [
              { u: trunkU, v: pBottom },
              { u: trunkU, v: lv },
              { u: leafLo, v: lv },
            ],
            exempt: 'bus',
          });
        }
        continue;
      }
      const kidTops = kids.map((e) => topOf(byId.get(e.to)!));
      const busV = (pBottom + Math.min(...kidTops)) / 2;
      const pCv = rowC[rank.get(p.id)!]!;
      for (const e of kids) {
        const k = byId.get(e.to)!;
        const kU = anchorU.get(e.to)!;
        const kTop = topOf(k);
        const pill = pills.get(e.id);
        const mode = modeOf(e);
        let pts: FlowPt[];
        let pillRun: [FlowPt, FlowPt] | undefined;
        let pillAt: FlowPt | undefined;
        if (mode.kind === 'side') {
          pts = [
            { u: mode.faceU, v: pCv },
            { u: kU, v: pCv },
            { u: kU, v: kTop },
          ];
          if (pill) {
            if (Math.abs(kU - mode.faceU) - TURN - PILL_CLEAR >= pu(pill)) {
              const lo = Math.min(mode.faceU, kU);
              const hi = Math.max(mode.faceU, kU);
              const trimLo = mode.faceU < kU ? PILL_CLEAR : TURN;
              const trimHi = mode.faceU < kU ? TURN : PILL_CLEAR;
              pillRun = [
                { u: lo + trimLo, v: pCv },
                { u: hi - trimHi, v: pCv },
              ];
            } else {
              pillRun = [
                { u: kU, v: rowBottomMax(rank.get(p.id)!) + PILL_CLEAR },
                { u: kU, v: kTop - scene.edgeGap },
              ];
            }
          }
        } else {
          const fromU =
            mode.kind === 'port' ? mode.portU : pU; // straight/trunk/bus leave the centre
          pts = simplify([
            { x: fromU, y: pBottom },
            { x: fromU, y: busV },
            { x: kU, y: busV },
            { x: kU, y: kTop },
          ]).map((q) => ({ u: q.x, v: q.y }));
          if (pill) {
            const busRun = mode.kind === 'bus' ? busRunFor(p.id, e) : null;
            const sharedStraight =
              mode.kind === 'straight' &&
              kids.some((o) => o !== e && (modeOf(o).kind === 'trunk' || modeOf(o).kind === 'bus'));
            if (busRun) {
              pillRun = [
                { u: busRun[0], v: busV },
                { u: busRun[1], v: busV },
              ];
            } else if (mode.kind === 'straight' && !sharedStraight) {
              pillRun = [
                { u: kU, v: pBottom + STANDOFF },
                { u: kU, v: kTop - scene.edgeGap },
              ];
            } else if ((mode.kind === 'port' || mode.kind === 'trunk') && legHosts(p.id)) {
              pillRun = [
                { u: Math.min(fromU, kU) + TURN, v: busV },
                { u: Math.max(fromU, kU) - TURN, v: busV },
              ];
            } else {
              // Below the bus line, on the drop — the exclusive stretch.
              pillRun = [
                { u: kU, v: busV + PILL_CLEAR },
                { u: kU, v: kTop - scene.edgeGap },
              ];
              pillAt = { u: kU, v: busV + PILL_CLEAR + pv(pill) / 2 };
            }
          }
        }
        planned.push({ edge: e, pts, pillRun, pillAt });
      }
    }

    // Joins.
    for (const e of joins) {
      const s = byId.get(e.from)!;
      const t = byId.get(e.to)!;
      const rs = rank.get(e.from)!;
      const rt = rank.get(e.to)!;
      const sU = anchorU.get(e.from)!;
      const tU = anchorU.get(e.to)!;
      const sBottom = bottomOf(s);
      const tTop = topOf(t);
      const pill = pills.get(e.id);
      if (rt === rs + 1) {
        const lv = laneV(rs, e);
        planned.push({
          edge: e,
          pts: simplify([
            { x: sU, y: sBottom },
            { x: sU, y: lv },
            { x: tU, y: lv },
            { x: tU, y: tTop },
          ]).map((q) => ({ u: q.x, v: q.y })),
          pillRun: pill
            ? Math.abs(sU - tU) >= 2 * TURN + 24
              ? [
                  { u: Math.min(sU, tU) + TURN, v: lv },
                  { u: Math.max(sU, tU) - TURN, v: lv },
                ]
              : [
                  { u: sU, v: sBottom + STANDOFF },
                  { u: sU, v: lv - TURN },
                ]
            : undefined,
        });
      } else {
        const cu = joinCorridor.get(e.id)!;
        const lvS = laneV(rs, e);
        const lvT = laneV(rt - 1, e);
        const pts = simplify([
          { x: sU, y: sBottom },
          { x: sU, y: lvS },
          { x: cu, y: lvS },
          { x: cu, y: lvT },
          { x: tU, y: lvT },
          { x: tU, y: tTop },
        ]).map((q) => ({ u: q.x, v: q.y }));
        planned.push({
          edge: e,
          pts,
          exempt: 'wrap',
          pillRun: pill
            ? [
                { u: cu, v: lvS + TURN },
                { u: cu, v: lvT - TURN },
              ]
            : undefined,
          pillAt: pill ? { u: cu, v: nearestBandCentre(lvS, lvT) } : undefined,
        });
      }
    }

    // Loop-backs: out a free side face (or the flow face when the row blocks
    // the shot), around via the corridor, arriving on the same face the
    // target's forward traffic arrives on (DESIGN 6.8), at the same point —
    // which is what merges the heads (6.3).
    for (const lp of loopPlans) {
      const rt = rank.get(lp.target)!;
      const t = byId.get(lp.target)!;
      const tU = anchorU.get(lp.target)!;
      const tTop = topOf(t);
      const cu = lp.corridorU;
      // One arrival for the whole group, so 6.3's head cannot be doubled.
      const arriveV = rt > 0 ? laneV(rt - 1, lp.edges[0]!) : stripTopLaneV(lp.edges[0]!);
      for (const e of lp.edges) {
        const s = byId.get(e.from)!;
        const rs = rank.get(e.from)!;
        const sU = anchorU.get(e.from)!;
        const legFarV =
          lp.exit === 'side' ? rowC[rs]! : rs === lastRow ? stripBottomLaneV(e) : laneV(rs, e);
        let pts: FlowPt[];
        if (lp.exit === 'side') {
          const face = lp.side === -1 ? sU - su(s) / 2 : sU + su(s) / 2;
          pts = simplify([
            { x: face, y: rowC[rs]! },
            { x: cu, y: rowC[rs]! },
            { x: cu, y: arriveV },
            { x: tU, y: arriveV },
            { x: tU, y: tTop },
          ]).map((q) => ({ u: q.x, v: q.y }));
        } else {
          pts = simplify([
            { x: sU, y: bottomOf(s) },
            { x: sU, y: legFarV },
            { x: cu, y: legFarV },
            { x: cu, y: arriveV },
            { x: tU, y: arriveV },
            { x: tU, y: tTop },
          ]).map((q) => ({ u: q.x, v: q.y }));
        }
        const pill = pills.get(e.id);
        let pillRun: [FlowPt, FlowPt] | undefined;
        let pillAt: FlowPt | undefined;
        if (pill && lp.bus) {
          // DESIGN 6.5 on a bus: the trunk is shared footage, so the pill
          // belongs on this branch's own exclusive stretch of the band —
          // from just past the neighbour nearer the corridor out to this
          // branch's own turn — exactly as `busRunFor` does on the forward
          // side. When that stretch is too short, its own drop instead.
          const run = returnRunFor(lp, e, legFarV);
          if (run) pillRun = run;
          else {
            pillRun = [
              { u: sU, v: bottomOf(s) + STANDOFF },
              { u: sU, v: legFarV - TURN },
            ];
          }
        } else if (pill) {
          const legTop = arriveV + TURN;
          const legBottom = legFarV - TURN;
          pillRun = [
            { u: cu, v: Math.min(legTop, legBottom) },
            { u: cu, v: Math.max(legTop, legBottom) },
          ];
          pillAt = { u: cu, v: nearestBandCentre(arriveV, legFarV) };
        }
        planned.push({
          edge: e,
          pts,
          exempt: lp.bus ? 'bus' : undefined,
          isReturn: lp.bus,
          pillRun,
          pillAt,
        });
      }
    }

    /**
     * DESIGN 6.5/6.14: the exclusive stretch of a return-bus branch's band
     * run — from just past the nearest branch between it and the corridor
     * (whose own run covers the footage past that point) out to this
     * branch's own turn into its source — or null when it cannot hold the
     * pill.
     */
    function returnRunFor(lp: LoopPlan, e: GraphEdge, bandV: number): [FlowPt, FlowPt] | null {
      const pill = pills.get(e.id);
      if (!pill) return null;
      const sU = anchorU.get(e.from)!;
      const cu = lp.corridorU;
      let bound = cu;
      for (const other of lp.edges) {
        if (other === e) continue;
        if (rank.get(other.from)! !== rank.get(e.from)!) continue;
        const oU = anchorU.get(other.from)!;
        if ((oU - sU) * (cu - sU) <= 0) continue; // the far side of us
        if (Math.abs(oU - sU) >= Math.abs(cu - sU)) continue; // beyond the corridor
        if (Math.abs(oU - sU) < Math.abs(bound - sU)) bound = oU;
      }
      const inner = bound + Math.sign(sU - bound) * (TURN + PILL_CLEAR);
      const outer = sU + Math.sign(bound - sU) * TURN;
      const lo = Math.min(inner, outer);
      const hi = Math.max(inner, outer);
      if (hi - lo < pu(pill) + 2) return null;
      return [
        { u: lo, v: bandV },
        { u: hi, v: bandV },
      ];
    }

    function nearestBandCentre(vA: number, vB: number): number {
      const lo = Math.min(vA, vB);
      const hi = Math.max(vA, vB);
      const mid = (lo + hi) / 2;
      let best = mid;
      let bestD = Infinity;
      for (let b = 0; b < lastRow; b++) {
        const c = (rowBottomMax(b) + rowTopMin(b + 1)) / 2;
        if (c < lo + 16 || c > hi - 16) continue;
        const d = Math.abs(c - mid);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      return best;
    }

    // REALIZE — flow coords to real coords.
    const X = (p: FlowPt): { x: number; y: number } => (TB ? { x: p.u, y: p.v } : { x: p.v, y: p.u });
    type Side = 'top' | 'bottom' | 'left' | 'right';
    const faceReal = (f: 'u-' | 'u+' | 'v-' | 'v+'): Side =>
      TB
        ? f === 'u-'
          ? 'left'
          : f === 'u+'
            ? 'right'
            : f === 'v-'
              ? 'top'
              : 'bottom'
        : f === 'u-'
          ? 'top'
          : f === 'u+'
            ? 'bottom'
            : f === 'v-'
              ? 'left'
              : 'right';
    /** The face the first segment leaves through: its own travel direction. */
    const startSideOf = (a: FlowPt, b: FlowPt): Side => {
      const du = b.u - a.u;
      const dv = b.v - a.v;
      return faceReal(Math.abs(dv) >= Math.abs(du) ? (dv > 0 ? 'v+' : 'v-') : du > 0 ? 'u+' : 'u-');
    };
    /** The face the last segment arrives on: opposite its travel direction. */
    const endSideOf = (a: FlowPt, b: FlowPt): Side => {
      const du = b.u - a.u;
      const dv = b.v - a.v;
      return faceReal(Math.abs(dv) >= Math.abs(du) ? (dv > 0 ? 'v-' : 'v+') : du > 0 ? 'u-' : 'u+');
    };

    // Node positions (real).
    const nodePos = new Map<string, { x: number; y: number }>();
    for (const n of graph.nodes) {
      const uC = anchorU.get(n.id)!;
      const vC = stackedLeaves.has(n.id) ? stackV.get(n.id)! : rowC[rank.get(n.id)!]!;
      const p = X({ u: uC - su(n) / 2, v: vC - sv(n) / 2 });
      nodePos.set(n.id, p);
    }

    const realPts = new Map<string, { x: number; y: number }[]>();
    for (const pe of planned) realPts.set(pe.edge.id, pe.pts.map(X));

    /**
     * DESIGN 6.5/10.3: a run's DRAWN extent — the line as painted. `draw.ts`
     * stops the path `scene.edgeGapStart` after its first point and
     * `scene.edgeGap` before its last, which is where the arrowhead lives, so
     * a pill centred on the vertex-to-face span sits visibly off centre on
     * the ink. Clipped here, once, for every pill the engine seats.
     */
    const drawnRun = (
      pts: { x: number; y: number }[],
      a: { x: number; y: number },
      b: { x: number; y: number },
    ): [{ x: number; y: number }, { x: number; y: number }] => {
      if (pts.length < 2) return [a, b];
      const drawn = pts.map((p) => ({ ...p }));
      const pull = (i: number, j: number, by: number): void => {
        const dx = drawn[j]!.x - drawn[i]!.x;
        const dy = drawn[j]!.y - drawn[i]!.y;
        const len = Math.hypot(dx, dy);
        if (len < 0.01) return;
        const t = Math.min(by, len) / len;
        drawn[i] = { x: drawn[i]!.x + dx * t, y: drawn[i]!.y + dy * t };
      };
      pull(0, 1, scene.edgeGapStart);
      pull(drawn.length - 1, drawn.length - 2, scene.edgeGap);
      const vertical = Math.abs(a.x - b.x) < 0.01;
      const mid = vertical ? (a.y + b.y) / 2 : (a.x + b.x) / 2;
      for (let i = 1; i < drawn.length; i++) {
        const p = drawn[i - 1]!;
        const q = drawn[i]!;
        const segVertical = Math.abs(p.x - q.x) < 0.01;
        if (segVertical !== vertical) continue;
        if (Math.abs((vertical ? p.x : p.y) - (vertical ? a.x : a.y)) > 1) continue;
        const lo = Math.min(vertical ? p.y : p.x, vertical ? q.y : q.x);
        const hi = Math.max(vertical ? p.y : p.x, vertical ? q.y : q.x);
        // The plan's own run sits on this segment: clip it to the ink.
        const aAt = vertical ? a.y : a.x;
        const bAt = vertical ? b.y : b.x;
        if (mid < Math.min(lo, hi) - 1 || mid > Math.max(lo, hi) + 1) continue;
        const clamp = (v: number): number => Math.min(hi, Math.max(lo, v));
        return vertical
          ? [
              { x: a.x, y: clamp(aAt) },
              { x: b.x, y: clamp(bAt) },
            ]
          : [
              { x: clamp(aAt), y: a.y },
              { x: clamp(bAt), y: b.y },
            ];
      }
      return [a, b];
    };

    // Pills, seated on their runs in real coordinates, then slid apart.
    const seatedPills: SeatedPill[] = [];
    for (const pe of planned) {
      const pill = pills.get(pe.edge.id);
      if (!pill || !pe.pillRun) continue;
      const [a, b] = drawnRun(
        realPts.get(pe.edge.id)!,
        X(pe.pillRun[0]),
        X(pe.pillRun[1]),
      );
      const at = pe.pillAt ? X(pe.pillAt) : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      seatedPills.push({
        edge: pe.edge,
        pill,
        cx: at.x,
        cy: at.y,
        run: { x1: a.x, y1: a.y, x2: b.x, y2: b.y },
      });
    }
    // DESIGN 6.5: the only movement a pill is allowed is a slide along its
    // own run. First off foreign edge segments (runs the edge genuinely
    // shares with the pill's own path are exempt), then apart from other
    // pills.
    for (const sp of seatedPills) {
      const own = realPts.get(sp.edge.id)!;
      const vertical = Math.abs(sp.run.x1 - sp.run.x2) < 0.01;
      const lo = vertical
        ? Math.min(sp.run.y1, sp.run.y2) + sp.pill.height / 2
        : Math.min(sp.run.x1, sp.run.x2) + sp.pill.width / 2;
      const hi = vertical
        ? Math.max(sp.run.y1, sp.run.y2) - sp.pill.height / 2
        : Math.max(sp.run.x1, sp.run.x2) - sp.pill.width / 2;
      if (hi < lo) continue;
      const bad: [number, number][] = [];
      for (const pe of planned) {
        if (pe.edge.id === sp.edge.id) continue;
        const pts = realPts.get(pe.edge.id)!;
        for (let i = 1; i < pts.length; i++) {
          const raw = {
            x1: pts[i - 1]!.x,
            y1: pts[i - 1]!.y,
            x2: pts[i]!.x,
            y2: pts[i]!.y,
          };
          for (const s2 of trimAgainstOwn(raw, own)) {
            if (vertical) {
              const sx1 = Math.min(s2.x1, s2.x2);
              const sx2 = Math.max(s2.x1, s2.x2);
              if (sx2 <= sp.cx - sp.pill.width / 2 || sx1 >= sp.cx + sp.pill.width / 2) continue;
              bad.push([
                Math.min(s2.y1, s2.y2) - sp.pill.height / 2 - 1,
                Math.max(s2.y1, s2.y2) + sp.pill.height / 2 + 1,
              ]);
            } else {
              const sy1 = Math.min(s2.y1, s2.y2);
              const sy2 = Math.max(s2.y1, s2.y2);
              if (sy2 <= sp.cy - sp.pill.height / 2 || sy1 >= sp.cy + sp.pill.height / 2) continue;
              bad.push([
                Math.min(s2.x1, s2.x2) - sp.pill.width / 2 - 1,
                Math.max(s2.x1, s2.x2) + sp.pill.width / 2 + 1,
              ]);
            }
          }
        }
      }
      const cur = vertical ? sp.cy : sp.cx;
      const clearOf = (v: number): boolean => bad.every(([a, b]) => v <= a || v >= b);
      if (!clearOf(cur)) {
        let best: number | null = null;
        const consider = (v: number): void => {
          if (v < lo || v > hi || !clearOf(v)) return;
          if (best === null || Math.abs(v - cur) < Math.abs(best - cur)) best = v;
        };
        consider(lo);
        consider(hi);
        for (const [a, b] of bad) {
          consider(a);
          consider(b);
        }
        if (best !== null) {
          if (vertical) sp.cy = best;
          else sp.cx = best;
        }
      }
    }
    slidePills(seatedPills);

    // VERIFY — the same predicates the gate measures, run on the planned
    // geometry. Any failure declines the whole plan.
    interface Box {
      id: string;
      x: number;
      y: number;
      w: number;
      h: number;
    }
    const nodeBoxes: Box[] = graph.nodes.map((n) => {
      const p = nodePos.get(n.id)!;
      return { id: n.id, x: p.x, y: p.y, w: n.width!, h: n.height! };
    });

    // Edge clearance from foreign nodes (6.1/6.8's 16), skipping the short
    // corner-scale segments the gate itself skips.
    for (const pe of planned) {
      const pts = realPts.get(pe.edge.id)!;
      for (let i = 1; i < pts.length; i++) {
        const x1 = Math.min(pts[i - 1]!.x, pts[i]!.x);
        const x2 = Math.max(pts[i - 1]!.x, pts[i]!.x);
        const y1 = Math.min(pts[i - 1]!.y, pts[i]!.y);
        const y2 = Math.max(pts[i - 1]!.y, pts[i]!.y);
        if (x2 - x1 < 13 && y2 - y1 < 13) continue;
        for (const b of nodeBoxes) {
          if (b.id === pe.edge.from || b.id === pe.edge.to) continue;
          const clear = EDGE_NODE_CLEAR - 1;
          if (x1 < b.x + b.w + clear && x2 > b.x - clear && y1 < b.y + b.h + clear && y2 > b.y - clear) {
            return decline(`edge ${pe.edge.id} hugs ${b.id}`);
          }
        }
      }
    }

    // Forward edges never cross (6.1); pairs sharing a start or end point —
    // a bus's branches, a fan-in's merged arrivals — are the exemption.
    const fwdPlanned = planned.filter((pe) => !pe.edge.backward);
    const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.abs(a.x - b.x) < 1.5 && Math.abs(a.y - b.y) < 1.5;
    for (let i = 0; i < fwdPlanned.length; i++) {
      for (let j = i + 1; j < fwdPlanned.length; j++) {
        const A = realPts.get(fwdPlanned[i]!.edge.id)!;
        const B = realPts.get(fwdPlanned[j]!.edge.id)!;
        if (near(A[0]!, B[0]!) || near(A[A.length - 1]!, B[B.length - 1]!)) continue;
        for (let a = 1; a < A.length; a++) {
          for (let b = 1; b < B.length; b++) {
            const p1 = A[a - 1]!;
            const p2 = A[a]!;
            const p3 = B[b - 1]!;
            const p4 = B[b]!;
            const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
            if (Math.abs(d) < 1e-6) continue;
            const t1 = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
            const t2 = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
            if (t1 > 0.02 && t1 < 0.98 && t2 > 0.02 && t2 < 0.98)
              return decline(
                `${fwdPlanned[i]!.edge.id} crosses ${fwdPlanned[j]!.edge.id}`,
              );
          }
        }
      }
    }

    // Shared and crowded parallel runs (6.4), same exemption.
    for (let i = 0; i < planned.length; i++) {
      for (let j = i + 1; j < planned.length; j++) {
        const A = realPts.get(planned[i]!.edge.id)!;
        const B = realPts.get(planned[j]!.edge.id)!;
        const exemptPair = near(A[0]!, B[0]!) || near(A[A.length - 1]!, B[B.length - 1]!);
        for (let a = 1; a < A.length; a++) {
          for (let b = 1; b < B.length; b++) {
            const s1 = { x1: A[a - 1]!.x, y1: A[a - 1]!.y, x2: A[a]!.x, y2: A[a]!.y };
            const s2 = { x1: B[b - 1]!.x, y1: B[b - 1]!.y, x2: B[b]!.x, y2: B[b]!.y };
            const v1 = Math.abs(s1.x1 - s1.x2) < 0.5;
            const v2 = Math.abs(s2.x1 - s2.x2) < 0.5;
            const h1 = Math.abs(s1.y1 - s1.y2) < 0.5;
            const h2 = Math.abs(s2.y1 - s2.y2) < 0.5;
            if (v1 && v2) {
              const gap = Math.abs(s1.x1 - s2.x1);
              const o = Math.min(Math.max(s1.y1, s1.y2), Math.max(s2.y1, s2.y2)) -
                Math.max(Math.min(s1.y1, s1.y2), Math.min(s2.y1, s2.y2));
              if (gap <= 1.5 && o > 8 && !exemptPair)
                return decline(`${planned[i]!.edge.id}/${planned[j]!.edge.id} share a v-run`);
              if (gap > 1.5 && gap < TRACK && o > TRACK)
                return decline(`${planned[i]!.edge.id}/${planned[j]!.edge.id} crowd v-runs`);
            } else if (h1 && h2) {
              const gap = Math.abs(s1.y1 - s2.y1);
              const o = Math.min(Math.max(s1.x1, s1.x2), Math.max(s2.x1, s2.x2)) -
                Math.max(Math.min(s1.x1, s1.x2), Math.min(s2.x1, s2.x2));
              if (gap <= 1.5 && o > 8 && !exemptPair)
                return decline(`${planned[i]!.edge.id}/${planned[j]!.edge.id} share an h-run`);
              if (gap > 1.5 && gap < TRACK && o > TRACK)
                return decline(`${planned[i]!.edge.id}/${planned[j]!.edge.id} crowd h-runs`);
            }
          }
        }
      }
    }

    // Pills: never overlapping a node or each other (6.5), and no foreign
    // edge running through a plate (6.5's on-other-edge, measured with the
    // plate as the conservative stand-in for the text box). Runs a foreign
    // edge shares with the pill's own path (the merged trunk) are exempt.
    for (const sp of seatedPills) {
      const px = sp.cx - sp.pill.width / 2;
      const py = sp.cy - sp.pill.height / 2;
      for (const b of nodeBoxes) {
        if (px < b.x + b.w - 1 && b.x < px + sp.pill.width - 1 && py < b.y + b.h - 1 && b.y < py + sp.pill.height - 1) {
          return decline(`pill ${sp.edge.id} overlaps ${b.id}`);
        }
      }
      const own = realPts.get(sp.edge.id)!;
      for (const pe of planned) {
        if (pe.edge.id === sp.edge.id) continue;
        const pts = realPts.get(pe.edge.id)!;
        for (let i = 1; i < pts.length; i++) {
          const sx1 = pts[i - 1]!.x;
          const sy1 = pts[i - 1]!.y;
          const sx2 = pts[i]!.x;
          const sy2 = pts[i]!.y;
          // Trim the stretch coincident with the pill's own path.
          const segs = trimAgainstOwn({ x1: sx1, y1: sy1, x2: sx2, y2: sy2 }, own);
          for (const s2 of segs) {
            const lo1 = Math.min(s2.x1, s2.x2);
            const hi1 = Math.max(s2.x1, s2.x2);
            const lo2 = Math.min(s2.y1, s2.y2);
            const hi2 = Math.max(s2.y1, s2.y2);
            if (lo1 < px + sp.pill.width && hi1 > px && lo2 < py + sp.pill.height && hi2 > py) {
              return decline(`pill ${sp.edge.id} sits on ${pe.edge.id}`);
            }
          }
        }
      }
    }
    for (let i = 0; i < seatedPills.length; i++) {
      for (let j = i + 1; j < seatedPills.length; j++) {
        const a = seatedPills[i]!;
        const b = seatedPills[j]!;
        if (
          a.cx - a.pill.width / 2 < b.cx + b.pill.width / 2 - 1 &&
          b.cx - b.pill.width / 2 < a.cx + a.pill.width / 2 - 1 &&
          a.cy - a.pill.height / 2 < b.cy + b.pill.height / 2 - 1 &&
          b.cy - b.pill.height / 2 < a.cy + a.pill.height / 2 - 1
        ) {
          return decline(`pills ${a.edge.id}/${b.edge.id} overlap`);
        }
      }
    }

    // Loop budget (6.7) and bend counts, from the drawn shape.
    for (const pe of planned) {
      const pts = realPts.get(pe.edge.id)!;
      let len = 0;
      for (let i = 1; i < pts.length; i++) {
        len += Math.abs(pts[i]!.x - pts[i - 1]!.x) + Math.abs(pts[i]!.y - pts[i - 1]!.y);
      }
      const bends = pts.length - 2;
      if (pe.edge.backward) {
        // DESIGN 6.14: a return bus is one route with branches, so its
        // budget is measured once, below — never per branch, which would be
        // measuring the private ring the rule exists to forbid.
        if (!pe.isReturn) {
          const manhattan =
            Math.abs(pts[pts.length - 1]!.x - pts[0]!.x) +
            Math.abs(pts[pts.length - 1]!.y - pts[0]!.y);
          if (len > manhattan + RULES['6.7']!.threshold!)
            return decline(
              `loop ${pe.edge.id} over budget (${Math.round(len)} > ${Math.round(manhattan)}+128)`,
            );
        }
        if (bends > RULES['6.1-bends-loop']!.threshold!) return decline(`loop ${pe.edge.id} bends`);
      } else if (pe.exempt === 'wrap') {
        if (bends > RULES['6.1-bends-loop']!.threshold!) return decline(`wrap ${pe.edge.id} bends`);
      } else if (pe.exempt !== 'bus') {
        if (bends > RULES['6.1-bends-forward']!.threshold!) return decline(`edge ${pe.edge.id} bends`);
        if (len < RULES['2.3']!.threshold!) return decline(`edge ${pe.edge.id} touching`);
      }
      // No segment in the short-jog range (6.1), start/exit stubs included.
      for (let i = 1; i < pts.length; i++) {
        const d = Math.abs(pts[i]!.x - pts[i - 1]!.x) + Math.abs(pts[i]!.y - pts[i - 1]!.y);
        if (d > 0.5 && d < 6)
          return decline(
            `edge ${pe.edge.id} short jog (${pe.pts.map((q) => `${q.u},${q.v}`).join(' ')})`,
          );
      }
    }

    // DESIGN 6.14 + 6.7: a return bus is measured once, on the branch that
    // starts the trunk (the shortest — it runs the whole corridor and none
    // of the band), and against what the bus has to go around: the half
    // perimeter of the box its own nodes span, plus 6.7's same 128 corridor
    // pad. Manhattan between one branch's ends is the yardstick for a loop
    // that hugs its own source, which is exactly the shape 6.14 replaces.
    const loopBoxes = new Map(nodeBoxes.map((b) => [b.id, b] as const));
    const groupBox = new Map<string, { x1: number; y1: number; x2: number; y2: number }>();
    for (const lp of loopPlans) {
      const routeLen = (e: GraphEdge): number => {
        const pts = realPts.get(e.id)!;
        let n = 0;
        for (let i = 1; i < pts.length; i++)
          n += Math.abs(pts[i]!.x - pts[i - 1]!.x) + Math.abs(pts[i]!.y - pts[i - 1]!.y);
        return n;
      };
      let x1 = Infinity;
      let y1 = Infinity;
      let x2 = -Infinity;
      let y2 = -Infinity;
      for (const e of lp.edges) for (const p of realPts.get(e.id)!) {
        x1 = Math.min(x1, p.x);
        y1 = Math.min(y1, p.y);
        x2 = Math.max(x2, p.x);
        y2 = Math.max(y2, p.y);
      }
      groupBox.set(lp.target, { x1, y1, x2, y2 });
      if (!lp.bus) continue;
      let bx1 = Infinity;
      let by1 = Infinity;
      let bx2 = -Infinity;
      let by2 = -Infinity;
      for (const id of [lp.target, ...lp.edges.map((e) => e.from)]) {
        const b = loopBoxes.get(id)!;
        bx1 = Math.min(bx1, b.x);
        by1 = Math.min(by1, b.y);
        bx2 = Math.max(bx2, b.x + b.w);
        by2 = Math.max(by2, b.y + b.h);
      }
      const budget = bx2 - bx1 + (by2 - by1) + RULES['6.7']!.threshold!;
      const trunk = Math.min(...lp.edges.map(routeLen));
      if (trunk > budget)
        return decline(
          `return bus into ${lp.target} over budget (${Math.round(trunk)} > ${Math.round(budget)})`,
        );
    }
    // DESIGN 6.14: two loop routes never nest — neither's bounding box
    // strictly contains the other's.
    {
      const boxes = [...groupBox.entries()];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = 0; j < boxes.length; j++) {
          if (i === j) continue;
          const a = boxes[i]![1];
          const b = boxes[j]![1];
          if (a.x1 <= b.x1 - 1 && a.y1 <= b.y1 - 1 && a.x2 >= b.x2 + 1 && a.y2 >= b.y2 + 1)
            return decline(`loop into ${boxes[j]![0]} nests inside the loop into ${boxes[i]![0]}`);
        }
      }
    }

    // 7.4's even whitespace: no same-row gap over 200 with nothing between.
    //
    // DESIGN 7.4 (2026-09-04): a gap a bus trunk or a derived channel runs
    // through is not empty — it is doing work — so it never counts here, and
    // 2.8's centring never yields to it. Centring a 160-wide parent over a
    // 344-wide pair opens a 208 gap to its neighbour, and the old path passed
    // this rule only by parking the parent 60 off centre. The corridor that
    // gap opens runs from the row above to the row below; whatever the router
    // put in it is what fills it. A gap with no line work anywhere in that
    // corridor is still genuinely empty and still declines.
    const gapCap = RULES['7.4-even-whitespace']!.threshold!;
    for (let r = 0; r < rowNodes.length; r++) {
      const sorted = [...rowNodes[r]!].sort((a, b) => anchorU.get(a.id)! - anchorU.get(b.id)!);
      const vLo = r > 0 ? rowBottomMax(r - 1) : -Infinity;
      const vHi = r < rowNodes.length - 1 ? rowTopMin(r + 1) : Infinity;
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1]!;
        const b = sorted[i]!;
        const uLo = anchorU.get(a.id)! + su(a) / 2;
        const uHi = anchorU.get(b.id)! - su(b) / 2;
        if (uHi - uLo <= gapCap) continue;
        const worked = planned.some((pe) => {
          for (let k = 1; k < pe.pts.length; k++) {
            const p = pe.pts[k - 1]!;
            const q = pe.pts[k]!;
            if (
              Math.min(p.u, q.u) < uHi - 1 &&
              Math.max(p.u, q.u) > uLo + 1 &&
              Math.min(p.v, q.v) < vHi - 1 &&
              Math.max(p.v, q.v) > vLo + 1
            )
              return true;
          }
          return false;
        });
        if (!worked)
          return decline(`row gap ${a.id}~${b.id} = ${Math.round(uHi - uLo)} with nothing in it`);
      }
    }

    // Extent (nodes, routes, pills) and the canvas budgets.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const grow = (x: number, y: number): void => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };
    for (const b of nodeBoxes) {
      grow(b.x, b.y);
      grow(b.x + b.w, b.y + b.h);
    }
    for (const pts of realPts.values()) for (const p of pts) grow(p.x, p.y);
    for (const sp of seatedPills) {
      grow(sp.cx - sp.pill.width / 2, sp.cy - sp.pill.height / 2);
      grow(sp.cx + sp.pill.width / 2, sp.cy + sp.pill.height / 2);
    }
    const totalW = maxX - minX;
    const totalH = maxY - minY;
    if (totalW > room)
      return decline(
        `too wide (${Math.round(totalW)} > ${room}; x ${Math.round(minX)}..${Math.round(maxX)}; nodes ${nodeBoxes
          .map((b) => `${b.id}@${Math.round(b.x)}`)
          .join(' ')})`,
      );
    if (Number.isFinite(scene.canvas.maxAspect)) {
      const m = scene.canvas.margin;
      const frameW = Math.max(scene.canvas.min, roundUp(totalW + 2 * m, GRID));
      if (totalH + 2 * m > scene.canvas.maxAspect * frameW)
        return decline(
          `too tall (${Math.round(totalH + 2 * m)} > 1.4×${frameW}; w=${Math.round(totalW)} band=${bandV} rows=${rowSv.map(Math.round).join('/')})`,
        );
    }

    const commit = (): void => {
      for (const n of graph.nodes) {
        const p = nodePos.get(n.id)!;
        n.x = p.x - minX;
        n.y = p.y - minY;
      }
      const labelOf = new Map(seatedPills.map((sp) => [sp.edge.id, sp] as const));
      for (const pe of planned) {
        const pts = realPts.get(pe.edge.id)!.map((p) => ({ x: p.x - minX, y: p.y - minY }));
        const sp = labelOf.get(pe.edge.id);
        pe.edge.channel = {
          points: pts,
          startSide: startSideOf(pe.pts[0]!, pe.pts[1]!),
          endSide: endSideOf(pe.pts[pe.pts.length - 2]!, pe.pts[pe.pts.length - 1]!),
          exempt: pe.exempt,
          isReturn: pe.isReturn,
          label: sp
            ? {
                x: sp.cx - sp.pill.width / 2 - minX,
                y: sp.cy - sp.pill.height / 2 - minY,
                width: sp.pill.width,
                height: sp.pill.height,
                lines: sp.pill.lines,
              }
            : undefined,
        };
      }
      graph.engine = 'channels';
    };

    return { layout: { width: totalW, height: totalH, warnings }, commit };
  };

  // DESIGN 2.9's second guard: the same-row seating is tried first, and a
  // chart whose flank does not fit (or that the verifier turns down for any
  // other reason) falls back to today's ranks, where the leaf drops a row.
  const done =
    (sideLeafCandidates.length ? (attempt(false, true) ?? attempt(true, true)) : null) ??
    attempt(false, false) ??
    attempt(true, false);
  if (!done) return null;
  done.commit();
  return done.layout;

  /** Trim the stretches of `seg` that coincide with the pill's own path —
   *  the merged trunk both edges deliberately share (DESIGN 6.4/6.8). */
  function trimAgainstOwn(
    seg: { x1: number; y1: number; x2: number; y2: number },
    own: { x: number; y: number }[],
  ): { x1: number; y1: number; x2: number; y2: number }[] {
    const tol = 1.5;
    const vertical = Math.abs(seg.x1 - seg.x2) < tol;
    const horizontal = Math.abs(seg.y1 - seg.y2) < tol;
    if (!vertical && !horizontal) return [seg];
    let intervals: [number, number][] = [
      vertical
        ? [Math.min(seg.y1, seg.y2), Math.max(seg.y1, seg.y2)]
        : [Math.min(seg.x1, seg.x2), Math.max(seg.x1, seg.x2)],
    ];
    for (let i = 1; i < own.length; i++) {
      const o = { x1: own[i - 1]!.x, y1: own[i - 1]!.y, x2: own[i]!.x, y2: own[i]!.y };
      const oV = Math.abs(o.x1 - o.x2) < tol;
      const oH = Math.abs(o.y1 - o.y2) < tol;
      let cut: [number, number] | null = null;
      if (vertical && oV && Math.abs(seg.x1 - o.x1) < tol) {
        cut = [Math.min(o.y1, o.y2), Math.max(o.y1, o.y2)];
      } else if (horizontal && oH && Math.abs(seg.y1 - o.y1) < tol) {
        cut = [Math.min(o.x1, o.x2), Math.max(o.x1, o.x2)];
      }
      if (!cut) continue;
      const next: [number, number][] = [];
      for (const [lo, hi] of intervals) {
        if (cut[1] <= lo || cut[0] >= hi) {
          next.push([lo, hi]);
          continue;
        }
        if (cut[0] > lo) next.push([lo, cut[0]]);
        if (cut[1] < hi) next.push([cut[1], hi]);
      }
      intervals = next;
    }
    return intervals
      .filter(([lo, hi]) => hi - lo > tol)
      .map(([lo, hi]) =>
        vertical
          ? { x1: seg.x1, y1: lo, x2: seg.x1, y2: hi }
          : { x1: lo, y1: seg.y1, x2: hi, y2: seg.y1 },
      );
  }
}
