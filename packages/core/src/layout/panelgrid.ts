import type { Graph, GraphCluster, GraphEdge, GraphNode } from '../graph.ts';
import { RULES } from '../rules.ts';
import type { Scene } from '../scene.ts';
import { CLEARANCE, GRID, GUTTER, PANEL } from '../tokens.ts';
import {
  PILL_PAD_X,
  pillHeight,
  roundUp,
  slidePills,
  STANDOFF,
  TURN,
  type ChannelLayout,
  type Pill,
  type SeatedPill,
} from './channels.ts';

/**
 * DESIGN 2.6 + 2.10, phase 3b: flowcharts with subgraphs, planned by the
 * channel engine instead of ELK.
 *
 * The approved panel language, in one sentence each:
 *   2.6 — a panel is 24 of padding on every side and no more, a reserved
 *     48-unit title strip across its top carrying an 11-unit mono caps kicker
 *     at the left padding edge on a baseline 30 below the panel top, its
 *     children centred inside it, and a nested panel is a child like any
 *     other, so padding accumulates 24 per level;
 *   2.10 — sibling panels keep one row: when that row will not fit the
 *     display, the panels' CONTENTS stack top-to-bottom inside them (1.5's
 *     leaf-stack move at panel scale) and the row stands. Cross-panel edges
 *     leave the child shape's own face (6.2) and cross the panel border
 *     perpendicular; the panel border is never a proxy for the shape.
 *
 * Structure is the engine's usual floor-plan/plan/derive/realize, run
 * recursively over the cluster forest: every container (the chart, then each
 * panel) ranks its own items along the flow axis, reserves the band between
 * ranks and the corridor between items, sizes each panel from what it holds,
 * and only then derives coordinates. Like `grid.ts` this planner may DECLINE
 * — it verifies its own result against the budgets the gate measures and
 * hands the chart back to the old path when it cannot hold them, so the old
 * path's panel charts stay byte-identical.
 */

/**
 * DESIGN 2.7: a band is sized by what has to live in it, and 7.4 makes that
 * one value chart-wide — the largest any band needs. Two sizes come up here.
 * A band every route crosses in a straight line needs only the arrowhead and
 * a visible run, which is the ordinary sibling gutter. A band that hosts a
 * turn needs both turn legs and the departure standoff as well. Which one
 * applies is not knowable before routing, so the planner derives with the
 * smaller, plans, and re-derives once if a turn showed up — 2.7's fixed
 * point, run at most twice, never a grow-and-retry loop.
 */
const bandStraight = (scene: Scene): number =>
  Math.max(GUTTER.panel, roundUp(RULES['2.3']!.threshold! + scene.edgeGap + scene.edgeGapStart, GRID));
const bandTurn = (scene: Scene): number =>
  Math.max(GUTTER.panel, roundUp(2 * TURN + STANDOFF + scene.edgeGap + 4, GRID));

/**
 * DESIGN 2.7's third size: a band that has to host a label pill.
 *
 * Derived the way 2.9 derives the flank gutter, because it is the same
 * arithmetic — the pill's own along-axis size, 2×16 of visible line either
 * side of it, the arrowhead at the far end and the standoff at the near one.
 * Nothing here is a minimum picked to look right: a band that came out
 * narrower would leave the pill with nubs instead of line, which is exactly
 * what 2.9 says never to ship.
 */
const PILL_RUN_CLEAR = 16;
const bandLabel = (scene: Scene, pillAlong: number): number =>
  Math.max(
    GUTTER.panel,
    roundUp(pillAlong + 2 * PILL_RUN_CLEAR + scene.edgeGap + scene.edgeGapStart, GRID),
  );

/** DESIGN 6.1/6.8: an edge keeps this clear of a node it does not connect. */
const EDGE_NODE_CLEAR = CLEARANCE.node;

const DEBUG = Boolean(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    'GC_GRID_DEBUG'
  ],
);
const decline = (why: string): null => {
  if (DEBUG) console.warn(`[panels] decline: ${why}`);
  return null;
};

type Pt = { x: number; y: number };
type Side = 'top' | 'bottom' | 'left' | 'right';
type Axis = 'x' | 'y';

interface NodeItem {
  kind: 'node';
  id: string;
  node: GraphNode;
  w: number;
  h: number;
  x: number;
  y: number;
  /** Which rank of its own container it sits on. */
  rank: number;
}
interface PanelItem {
  kind: 'panel';
  id: string;
  cluster: GraphCluster;
  items: Item[];
  /** Where the child block starts inside the panel, relative to its own box. */
  contentX: number;
  contentY: number;
  w: number;
  h: number;
  x: number;
  y: number;
  rank: number;
  /** Along-axis size of each of its own ranks, and DESIGN 2.6's shared-row
   *  override: the profile every panel on one row is seated to. */
  profile: number[];
  override?: number[];
}
type Item = NodeItem | PanelItem;

/** An edge as the container that owns it sees it: which of its own items it
 *  runs between, whatever depth the real endpoints sit at. */
interface Lifted {
  edge: GraphEdge;
  from: Item;
  to: Item;
}

export function layoutPanelChart(
  graph: Graph,
  scene: Scene,
  packToDisplay = false,
): ChannelLayout | null {
  const TB = graph.direction === 'TB';
  const flowAxis: Axis = TB ? 'y' : 'x';

  // DESIGN 6.5: a pill is 11 mono caps with 8 of side padding, wrapped at 28
  // characters. Both numbers are already measured — `layout()` sizes every
  // edge label while its measurer is live and leaves `labelWidth`/`labelLines`
  // on the edge — so this planner derives the plate rather than measuring one.
  const pills = new Map<string, Pill>();
  for (const e of graph.edges) {
    if (!e.label) continue;
    const lines = e.labelLines ?? [e.label];
    pills.set(e.id, {
      lines,
      width: (e.labelWidth ?? 0) + PILL_PAD_X * 2,
      height: pillHeight(scene, lines.length),
    });
  }
  // 2.7: the band is sized for what must live in it, before anything is
  // placed. A pill on a straight cross-panel run lies along the flow axis, so
  // that is the extent the band has to hold.
  const widestPill = Math.max(0, ...[...pills.values()].map((p) => p.width));
  let BAND = Math.max(bandStraight(scene), widestPill ? bandLabel(scene, widestPill) : 0);

  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const clusterById = new Map(graph.clusters.map((c) => [c.id, c] as const));

  // --- screen -------------------------------------------------------------
  // DESIGN 2.10: an edge naming the PANEL is a legal endpoint — the author
  // said "into the system", not "into each of these" — so it attaches to the
  // panel's own border rather than to a shape inside. An edge naming two
  // shapes still connects the shapes; the border is never a proxy for those.
  const known = (id: string): boolean => byId.has(id) || clusterById.has(id);
  for (const e of graph.edges) {
    if (!known(e.from) || !known(e.to)) return decline('edge endpoint missing');
    if (e.backward || e.from === e.to) return decline('loop-back');
  }
  if (!graph.clusters.length) return decline('no panels');

  // --- FLOOR PLAN 1: the cluster forest ------------------------------------
  // Mermaid lists a nested subgraph's id among its parent's nodes, and often
  // the grandchildren's ids too. The owner of a member is therefore its
  // DEEPEST claimant, and a claim that does not sit on one root-to-leaf path
  // is a shape this planner will not guess at.
  const parentOf = new Map<string, string>(); // cluster id -> parent cluster id
  for (const c of graph.clusters) {
    for (const m of c.nodes) if (clusterById.has(m) && m !== c.id) parentOf.set(m, c.id);
  }
  const depthOf = (id: string): number => {
    let d = 0;
    let cur = id;
    const seen = new Set<string>([cur]);
    while (parentOf.has(cur)) {
      cur = parentOf.get(cur)!;
      if (seen.has(cur)) return -1;
      seen.add(cur);
      d++;
    }
    return d;
  };
  for (const c of graph.clusters) if (depthOf(c.id) < 0) return decline('panel nesting cycle');

  const ownerOf = new Map<string, string>(); // node id -> its own panel
  for (const n of graph.nodes) {
    const claims = graph.clusters.filter((c) => c.nodes.includes(n.id));
    if (!claims.length) continue;
    let best = claims[0]!;
    for (const c of claims) if (depthOf(c.id) > depthOf(best.id)) best = c;
    // Every other claimant has to be an ancestor of the deepest one, or the
    // membership is genuinely ambiguous.
    const line = new Set<string>();
    for (let cur: string | undefined = best.id; cur; cur = parentOf.get(cur)) line.add(cur);
    if (claims.some((c) => !line.has(c.id))) return decline(`${n.id} is in two panels`);
    ownerOf.set(n.id, best.id);
  }
  for (const c of graph.clusters) {
    const members =
      c.nodes.filter((m) => byId.has(m) && ownerOf.get(m) === c.id).length +
      graph.clusters.filter((k) => parentOf.get(k.id) === c.id).length;
    if (!members) return decline(`panel ${c.id} is empty`);
  }

  // --- FLOOR PLAN 2: items, and which container owns each edge -------------
  const panelItems = new Map<string, PanelItem>();
  const nodeItems = new Map<string, NodeItem>();
  const build = (): Item[] => {
    for (const c of graph.clusters) {
      panelItems.set(c.id, {
        kind: 'panel',
        id: c.id,
        cluster: c,
        items: [],
        contentX: 0,
        contentY: 0,
        w: 0,
        h: 0,
        x: 0,
        y: 0,
        rank: 0,
        profile: [],
      });
    }
    for (const n of graph.nodes) {
      nodeItems.set(n.id, {
        kind: 'node',
        id: n.id,
        node: n,
        w: n.width!,
        h: n.height!,
        x: 0,
        y: 0,
        rank: 0,
      });
    }
    const roots: Item[] = [];
    const push = (parent: string | undefined, item: Item): void => {
      if (parent) panelItems.get(parent)!.items.push(item);
      else roots.push(item);
    };
    // Source order, so a container's ranks tie-break the way the paste reads.
    for (const c of graph.clusters) push(parentOf.get(c.id), panelItems.get(c.id)!);
    for (const n of graph.nodes) push(ownerOf.get(n.id), nodeItems.get(n.id)!);
    return roots;
  };
  const roots = build();

  /** The item an edge endpoint names: a shape, or (2.10) a panel itself. */
  const itemOf = (id: string): Item => (nodeItems.get(id) ?? panelItems.get(id))!;
  /** Ancestor chain of an endpoint, innermost panel first — a panel named as
   *  an endpoint is a member of its OWN parent, not of itself. */
  const chainOf = (id: string): string[] => {
    const out: string[] = [];
    const first = clusterById.has(id) ? parentOf.get(id) : ownerOf.get(id);
    for (let cur = first; cur; cur = parentOf.get(cur)) out.push(cur);
    return out;
  };
  /** The container that owns an edge, and the two of its items it runs between. */
  const liftedOf = (e: GraphEdge): { owner: string | null; from: Item; to: Item } | null => {
    const a = chainOf(e.from);
    const b = chainOf(e.to);
    let owner: string | null = null;
    for (const c of a) {
      if (b.includes(c)) {
        owner = c;
        break;
      }
    }
    const itemFor = (nodeId: string, chain: string[]): Item => {
      if (owner === null) return chain.length ? panelItems.get(chain[chain.length - 1]!)! : itemOf(nodeId);
      const i = chain.indexOf(owner);
      return i === 0 ? itemOf(nodeId) : panelItems.get(chain[i - 1]!)!;
    };
    const from = itemFor(e.from, a);
    const to = itemFor(e.to, b);
    if (from === to) return null;
    return { owner, from, to };
  };

  const liftedIn = new Map<string, Lifted[]>(); // container key -> its edges
  const key = (owner: string | null): string => owner ?? '';
  for (const e of graph.edges) {
    const l = liftedOf(e);
    if (!l) return decline(`edge ${e.id} runs inside one item`);
    const list = liftedIn.get(key(l.owner)) ?? [];
    list.push({ edge: e, from: l.from, to: l.to });
    liftedIn.set(key(l.owner), list);
  }

  // --- SEAT ---------------------------------------------------------------
  /**
   * One container. `along` is the axis its ranks advance on; the cross axis
   * holds the items of one rank side by side. Panels flush their tops (2.10's
   * one row, and 2.6's shared child rows that follow from it), everything else
   * centres (2.6's centred children, 2.8's centring at the chart level).
   */
  const seatContainer = (
    items: Item[],
    owner: string | null,
    along: Axis,
    override?: number[],
  ): { w: number; h: number } | null => {
    const cross: Axis = along === 'x' ? 'y' : 'x';
    const sizeAlong = (i: Item): number => (along === 'x' ? i.w : i.h);
    const sizeCross = (i: Item): number => (cross === 'x' ? i.w : i.h);

    const edges = (liftedIn.get(key(owner)) ?? []).filter(
      (l) => items.includes(l.from) && items.includes(l.to),
    );
    const rank = new Map<Item, number>(items.map((i) => [i, 0] as const));
    const indeg = new Map<Item, number>(items.map((i) => [i, 0] as const));
    for (const l of edges) indeg.set(l.to, indeg.get(l.to)! + 1);
    const queue = items.filter((i) => indeg.get(i) === 0);
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head]!;
      for (const l of edges) {
        if (l.from !== cur) continue;
        rank.set(l.to, Math.max(rank.get(l.to)!, rank.get(cur)! + 1));
        indeg.set(l.to, indeg.get(l.to)! - 1);
        if (indeg.get(l.to) === 0) queue.push(l.to);
      }
    }
    if (queue.length !== items.length) return decline('cycle between items');
    // Every edge spans exactly one band: a rank-skipping join needs its own
    // reserved corridor, which is not this phase's shape.
    for (const l of edges) {
      if (rank.get(l.to)! !== rank.get(l.from)! + 1) return decline(`${l.edge.id} skips a rank`);
    }

    const maxRank = Math.max(...items.map((i) => rank.get(i)!));
    const rows: Item[][] = Array.from({ length: maxRank + 1 }, () => []);
    for (const i of items) rows[rank.get(i)!]!.push(i);

    const rowCross = rows.map((row) => {
      let total = 0;
      for (let k = 0; k < row.length; k++) {
        if (k > 0) {
          total +=
            row[k]!.kind === 'panel' || row[k - 1]!.kind === 'panel'
              ? GUTTER.panel
              : GUTTER.sibling;
        }
        total += sizeCross(row[k]!);
      }
      return total;
    });
    for (let r = 0; r <= maxRank; r++) for (const i of rows[r]!) i.rank = r;
    const totalCross = Math.max(...rowCross);
    // DESIGN 2.6: children of sibling panels share exact rows, so a panel on
    // a row of panels is seated to the profile that row agreed on rather than
    // to its own contents alone.
    const rowAlong = rows.map((row, r) =>
      Math.max(override?.[r] ?? 0, ...row.map(sizeAlong)),
    );

    let cursor = 0;
    for (let r = 0; r <= maxRank; r++) {
      const row = rows[r]!;
      // 2.10: a rank holding a panel starts flush, so every panel in the
      // chart shares one top edge and their children share exact rows.
      const flush = cross === 'y' && row.some((i) => i.kind === 'panel');
      let at = flush ? 0 : (totalCross - rowCross[r]!) / 2;
      for (let k = 0; k < row.length; k++) {
        if (k > 0) {
          at += row[k]!.kind === 'panel' || row[k - 1]!.kind === 'panel'
            ? GUTTER.panel
            : GUTTER.sibling;
        }
        const item = row[k]!;
        // Flush to the rank's own start, never centred in it: 2.3 puts the
        // shapes of one row on an exact shared edge, and it is that edge —
        // not a centre line — that a row of sibling panels shares when the
        // shapes standing on it are different heights (2.6).
        const alongAt = cursor;
        if (along === 'x') {
          item.x = alongAt;
          item.y = at;
        } else {
          item.y = alongAt;
          item.x = at;
        }
        at += sizeCross(item);
      }
      cursor += rowAlong[r]! + (r < maxRank ? BAND : 0);
    }

    // A container hugs what it actually holds, not the ranks it reserved: a
    // panel on a row whose shared profile is taller than its own last shape
    // still keeps exactly 24 under that shape (2.6's "and no more").
    const crossLo = Math.min(...items.map((i) => (cross === 'x' ? i.x : i.y)));
    for (const i of items) {
      if (cross === 'x') i.x -= crossLo;
      else i.y -= crossLo;
    }
    return {
      w: Math.max(...items.map((i) => i.x + i.w)),
      h: Math.max(...items.map((i) => i.y + i.h)),
    };
  };

  /** Size a panel from what it holds (2.6): contents plus 24 all round, plus
   *  the reserved title strip on top, never less than its own kicker. */
  /** The chart itself, as a container key — `key(null)`. */
  const ROOT = '';
  const interiorOf = new Map<string, Axis>();
  const sizePanel = (p: PanelItem): boolean => {
    for (const child of p.items) {
      if (child.kind === 'panel' && !sizePanel(child)) return false;
    }
    const inner = seatContainer(p.items, p.id, interiorOf.get(p.id) ?? flowAxis, p.override);
    if (!inner) return false;
    p.profile = profileOf(p.items, interiorOf.get(p.id) ?? flowAxis);
    const header = (p.cluster.panelHeaderWidth ?? 0) + 2 * PANEL.pad;
    p.w = Math.max(inner.w + 2 * PANEL.pad, header);
    p.h = inner.h + PANEL.head + PANEL.pad;
    p.contentX = (p.w - inner.w) / 2;
    p.contentY = PANEL.head;
    return true;
  };

  /** Absolute coordinates, last (REALIZE). */
  const place = (item: Item, x: number, y: number): void => {
    item.x = x;
    item.y = y;
    if (item.kind !== 'panel') return;
    for (const child of item.items) {
      place(child, x + item.contentX + child.x, y + item.contentY + child.y);
    }
  };

  const room = scene.canvas.width - scene.canvas.margin * 2;

  /** The along-axis size of each rank of a seated container. */
  const profileOf = (items: Item[], along: Axis): number[] => {
    const out: number[] = [];
    for (const i of items) {
      const size = along === 'x' ? i.w : i.h;
      out[i.rank] = Math.max(out[i.rank] ?? 0, size);
    }
    return out.map((v) => v ?? 0);
  };

  /** DESIGN 2.6: every panel standing on one row is seated to one shared rank
   *  profile — the largest each rank needs across the row — so their children
   *  land on exact shared rows whatever shapes they hold. */
  const ownerKeyOf = (items: Item[]): string => {
    if (items === roots) return ROOT;
    for (const p of panelItems.values()) if (p.items === items) return p.id;
    return ROOT;
  };
  const shareRows = (): boolean => {
    let changed = false;
    const containers: Item[][] = [roots, ...[...panelItems.values()].map((p) => p.items)];
    for (const items of containers) {
      if (!items.length) continue;
      // Which panels stand on one row: when a container runs left to right,
      // every panel in it does (2.10's one panel row); when it runs top to
      // bottom, only the ones sharing a rank.
      const containerAlong = interiorOf.get(ownerKeyOf(items)) ?? flowAxis;
      const byRank = new Map<number, PanelItem[]>();
      for (const i of items) {
        if (i.kind !== 'panel') continue;
        const k = containerAlong === 'x' ? 0 : i.rank;
        byRank.set(k, [...(byRank.get(k) ?? []), i]);
      }
      for (const group of byRank.values()) {
        if (group.length < 2) continue;
        const merged: number[] = [];
        for (const p of group) {
          p.profile.forEach((v, r) => (merged[r] = Math.max(merged[r] ?? 0, v)));
        }
        for (const p of group) {
          const was = p.override;
          if (!was || was.length !== merged.length || was.some((v, r) => v !== merged[r])) {
            p.override = [...merged];
            changed = true;
          }
        }
      }
    }
    return changed;
  };

  const attempt = (): { w: number; h: number } | null => {
    for (const p of panelItems.values()) delete p.override;
    // Two passes at most: size and seat once to learn every panel's own rank
    // profile, then once more with the shared profile a row of panels agreed.
    for (let pass = 0; pass < 2; pass++) {
      for (const item of roots) {
        if (item.kind === 'panel' && !sizePanel(item)) return null;
      }
      const outer = seatContainer(roots, null, interiorOf.get(ROOT) ?? flowAxis);
      if (!outer) return null;
      if (pass === 1 || !shareRows()) {
        for (const item of roots) place(item, item.x, item.y);
        return outer;
      }
    }
    return null;
  };

  interface Route {
    edge: GraphEdge;
    pts: Pt[];
    startSide: Side;
    endSide: Side;
  }
  interface Solved {
    seated: { w: number; h: number };
    routes: Route[];
  }

  const boxOf = (id: string): { x: number; y: number; w: number; h: number } => {
    const it = itemOf(id);
    return { x: it.x, y: it.y, w: it.w, h: it.h };
  };

  /** Seat everything at the current band and interiors, then plan every route
   *  over the result. Nothing is searched for: a route is the corridor its own
   *  container already reserved (2.7). */
  const solve = (): Solved | null => {
    const seated = attempt();
    if (!seated) return null;
    // Pass 1: every edge's corridor and its two attachment coordinates. A
    // shape's own face midpoint (6.2); a panel named as an endpoint gets its
    // border's face centre, which 2.10's own pass below may then move onto a
    // column when the face carries more than one edge.
    interface Leg {
      edge: GraphEdge;
      horizontal: boolean;
      a: { x: number; y: number; w: number; h: number };
      b: { x: number; y: number; w: number; h: number };
      mid: number;
      ac: number;
      bc: number;
    }
    const legs: Leg[] = [];
    for (const e of graph.edges) {
      const l = liftedOf(e)!;
      const horizontal = (interiorOf.get(key(l.owner)) ?? flowAxis) === 'x';
      const a = boxOf(e.from);
      const b = boxOf(e.to);
      // The corridor an edge crosses is the band the OWNING container reserved
      // between the two of its own items the edge runs between — outside both
      // panels, whatever depth the real endpoints sit at (2.10).
      const gapLo = horizontal ? l.from.x + l.from.w : l.from.y + l.from.h;
      const gapHi = horizontal ? l.to.x : l.to.y;
      if (gapHi - gapLo < 8) return decline(`${e.id} has no corridor`);
      legs.push({
        edge: e,
        horizontal,
        a,
        b,
        mid: (gapLo + gapHi) / 2,
        ac: horizontal ? a.y + a.h / 2 : a.x + a.w / 2,
        bc: horizontal ? b.y + b.h / 2 : b.x + b.w / 2,
      });
    }

    // Pass 2, DESIGN 2.10: a sole edge on a panel face takes the face centre
    // (6.2's midpoint rule at panel scale); several on one face align
    // column-for-column with the shapes inside — the Lyzr pattern the rule
    // always described. A face carrying a number of edges the panel has no
    // matching number of columns for has no stated alignment, so it declines
    // rather than being spread by a rule nobody wrote.
    const columnsOf = (pid: string, horizontal: boolean): number[] => {
      const vals: number[] = [];
      for (const c of panelItems.get(pid)!.items) {
        const v = horizontal ? c.y + c.h / 2 : c.x + c.w / 2;
        if (!vals.some((u) => Math.abs(u - v) < 1)) vals.push(v);
      }
      return vals.sort((u, v) => u - v);
    };
    const faces = new Map<string, { leg: Leg; end: 'a' | 'b'; far: number }[]>();
    for (const leg of legs) {
      const add = (pid: string, side: Side, end: 'a' | 'b'): void => {
        const k = `${pid}|${side}`;
        faces.set(k, [
          ...(faces.get(k) ?? []),
          { leg, end, far: end === 'a' ? leg.bc : leg.ac },
        ]);
      };
      if (panelItems.has(leg.edge.from)) add(leg.edge.from, leg.horizontal ? 'right' : 'bottom', 'a');
      if (panelItems.has(leg.edge.to)) add(leg.edge.to, leg.horizontal ? 'left' : 'top', 'b');
    }
    for (const [k, group] of faces) {
      if (group.length < 2) continue;
      const pid = k.slice(0, k.lastIndexOf('|'));
      const cols = columnsOf(pid, group[0]!.leg.horizontal);
      if (cols.length !== group.length)
        return decline(
          `${group.length} edges on ${pid}'s ${k.slice(k.lastIndexOf('|') + 1)} face against ${cols.length} columns inside`,
        );
      const order = [...group].sort((p, q) => p.far - q.far);
      order.forEach((entry, i) => {
        if (entry.end === 'a') entry.leg.ac = cols[i]!;
        else entry.leg.bc = cols[i]!;
      });
    }

    // Pass 3: coordinates, derived last (2.7).
    const routes: Route[] = [];
    for (const { edge, horizontal, a, b, mid, ac, bc } of legs) {
      const start: Pt = horizontal ? { x: a.x + a.w, y: ac } : { x: ac, y: a.y + a.h };
      const end: Pt = horizontal ? { x: b.x, y: bc } : { x: bc, y: b.y };
      const pts: Pt[] =
        Math.abs(ac - bc) < 0.5
          ? [start, end]
          : horizontal
            ? [start, { x: mid, y: ac }, { x: mid, y: bc }, end]
            : [start, { x: ac, y: mid }, { x: bc, y: mid }, end];
      routes.push({
        edge,
        pts,
        startSide: horizontal ? 'right' : 'bottom',
        endSide: horizontal ? 'left' : 'top',
      });
    }
    // DESIGN 2.3: a sole child sits on its sole parent's own centre line.
    // Across a panel border the shapes still have to line up — a packing move
    // that slides one of them off the other is not a legal packing move.
    const kids = new Map<string, number>();
    const dads = new Map<string, number>();
    for (const e of graph.edges) {
      kids.set(e.from, (kids.get(e.from) ?? 0) + 1);
      dads.set(e.to, (dads.get(e.to) ?? 0) + 1);
    }
    for (const r of routes) {
      if (kids.get(r.edge.from) !== 1 || dads.get(r.edge.to) !== 1) continue;
      if (r.pts.length === 2) continue;
      // Not between panels (2.10): a panel's cross position is 2.6's shared
      // row, flush at the top so children of sibling panels land on exact
      // rows, and its attachment is 2.10's own face centre. Neither end has
      // the placement freedom this clause polices, so two panels of different
      // heights meeting in the corridor is the geometry the rules ask for —
      // platform-layers' CONTENT (two stacked shapes) into LP (one).
      if (panelItems.has(r.edge.from) || panelItems.has(r.edge.to)) continue;
      const a = boxOf(r.edge.from);
      const b = boxOf(r.edge.to);
      const horizontal = r.startSide === 'right';
      const off = horizontal
        ? Math.abs(a.y + a.h / 2 - (b.y + b.h / 2))
        : Math.abs(a.x + a.w / 2 - (b.x + b.w / 2));
      const span = horizontal ? (a.h + b.h) / 2 : (a.w + b.w) / 2;
      if (off > 1 && off < span)
        return decline(`${r.edge.to} is ${Math.round(off)} off ${r.edge.from}'s centre line`);
    }
    return { seated, routes };
  };

  /** The canvas budgets a seating has to hold: 1.1's display cap and 1.4's
   *  aspect, measured the way the gate measures them. */
  const overWide = (s: { w: number }): boolean => s.w > room;
  const frameOf = (s: { w: number }): number =>
    Math.max(scene.canvas.min, roundUp(s.w + 2 * scene.canvas.margin, GRID));
  const overTall = (s: { w: number; h: number }): boolean =>
    Number.isFinite(scene.canvas.maxAspect) &&
    s.h + 2 * scene.canvas.margin > scene.canvas.maxAspect * frameOf(s);

  // Panels deepest first, then the chart itself: packing starts with the
  // innermost stack, so a chart that misses a budget by one level does not
  // have every panel turned.
  const depthSorted = [...panelItems.values()].sort((a, b) => depthOf(b.id) - depthOf(a.id));
  const packOrder: string[] = [...depthSorted.map((p) => p.id), ROOT];

  /**
   * `interiorOf` names the axis a container's RANKS advance on, and a rank's
   * own items sit side by side across the other one. So which axis makes the
   * contents run top to bottom depends on whether the container has ranks at
   * all: a panel whose children are joined by edges stacks along `y`, while a
   * panel of unconnected children is one rank — prompt-anatomy's five prompt
   * parts, control-plane's six layers — and its shapes lie along the CROSS
   * axis, so the same stack is asked for as `x`. Read the wrong way round, a
   * one-rank panel answered 2.10's packing move by not moving at all.
   */
  const ranked = (id: string): boolean => {
    const items = id === ROOT ? roots : panelItems.get(id)!.items;
    return (liftedIn.get(id) ?? []).some((l) => items.includes(l.from) && items.includes(l.to));
  };
  const stackAxis = (id: string): Axis => (ranked(id) ? 'y' : 'x');
  const spreadAxis = (id: string): Axis => (ranked(id) ? 'x' : 'y');

  let solution = solve();
  if (solution && overWide(solution.seated)) {
    // DESIGN 2.10: a panel row too wide for the display does not wrap — the
    // panels' CONTENTS stack top-to-bottom instead, and the row stands.
    for (const p of depthSorted) interiorOf.set(p.id, stackAxis(p.id));
    const packed = solve();
    // A packing move that buys width with a 1.4 violation has not packed the
    // chart, it has broken it: 1.1's own remedy for a chart packing cannot
    // reach is to draw it wide (a WARN), never to make it two screens tall.
    if (packed && packed.seated.w < solution.seated.w && !overTall(packed.seated)) solution = packed;
    else {
      interiorOf.clear();
      solution = solve();
    }
  } else if (solution && overTall(solution.seated)) {
    // DESIGN 1.4's own remedy, at panel scale and the mirror of 2.10's: a
    // stack too tall for the canvas goes side by side instead, innermost
    // panel first, stopping as soon as the chart fits.
    for (const id of packOrder) {
      if (!solution || !overTall(solution.seated)) break;
      interiorOf.set(id, spreadAxis(id));
      const flatter = solve();
      if (flatter && !overWide(flatter.seated) && !overTall(flatter.seated)) solution = flatter;
      else interiorOf.delete(id);
    }
    solution = solve();
  }

  /**
   * DESIGN 1.6 at panel scale, under a declared display only.
   *
   * 2.10's own packing move is the contents stack above, and it is the move a
   * chart at the plain default gets: the panel row stands. A caller who named
   * a phone column has already spent the room that made "keep the row" the
   * better read — 1.4 says as much in its own words — and a row of stacked
   * panels that still overflows has nothing left to give. Then the panels
   * wrap like 1.6's siblings.
   *
   * What runs here is the shape 1.9 names for a display that fits only ONE
   * column: "the ribbon degenerates to a vertical list — no returns exist,
   * edges run straight down". A row of panels one panel wide IS that list, so
   * the whole wrap is the root container turning its ranks down the page, and
   * every cross-panel edge stays the ordinary two-face run it already was. A
   * display with room for two panels but not all of them would need 1.9's own
   * four-bend return between the rows, which this planner has no route shape
   * for yet — so it declines and the old path draws it, rather than inventing
   * a return the spec describes and the code does not draw.
   */
  const rootPanels = [...panelItems.values()].filter((p) => !parentOf.has(p.id));
  if (
    packToDisplay &&
    solution &&
    overWide(solution.seated) &&
    (interiorOf.get(ROOT) ?? flowAxis) === 'x' &&
    rootPanels.length > 1
  ) {
    const widths = rootPanels.map((p) => p.w).sort((a, b) => a - b);
    const perRow = widths[0]! + GUTTER.panel + widths[1]! <= room ? 2 : 1;
    if (perRow > 1) {
      decline(`a wrap of ${perRow} panels a row needs 1.9's return, which this planner has not`);
      return null;
    }
    interiorOf.set(ROOT, 'y');
    const listed = solve();
    if (listed && listed.seated.w < solution.seated.w) solution = listed;
    else {
      interiorOf.delete(ROOT);
      solution = solve();
    }
  }

  // 2.7's fixed point: derive with the straight-run band, and re-derive once
  // if a turn actually turned up in the plan. A band already widened for a
  // pill never narrows here — a turn asks for more room, never less.
  const bandFloor = widestPill ? bandLabel(scene, widestPill) : 0;
  if (solution?.routes.some((r) => r.pts.length > 2)) {
    BAND = Math.max(bandTurn(scene), bandFloor);
    const wider = solve();
    if (wider) solution = wider;
    else {
      BAND = Math.max(bandStraight(scene), bandFloor);
      solution = solve();
    }
  }
  if (!solution) return null;
  // 2.3 vs 2.7 was resolved in the spec on 2026-09-04: a gutter hosting a
  // derived channel is measured by 2.7's own derivation, so a 112 corridor
  // carrying a 66-wide pill is not the arbitrary gap 2.3's check used to call
  // it. This planner used to decline that case — a widened band lying across a
  // composition row — and hand labelled cross-panel LR charts back to the old
  // path. With the exemption in `2.3-row-gutters` they stay here.
  const { routes } = solution;

  // --- VERIFY -------------------------------------------------------------
  const allPanels = [...panelItems.values()];
  const nodeBoxes = graph.nodes.map((n) => ({ id: n.id, ...boxOf(n.id) }));

  // No two boxes overlap, and no node sits on a panel it does not belong to.
  for (let i = 0; i < nodeBoxes.length; i++) {
    for (let j = i + 1; j < nodeBoxes.length; j++) {
      const a = nodeBoxes[i]!;
      const b = nodeBoxes[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
        return decline(`${a.id} overlaps ${b.id}`);
    }
  }
  for (const p of allPanels) {
    for (const b of nodeBoxes) {
      const insideP = descendantsOf(p).has(b.id);
      const overlaps =
        b.x < p.x + p.w && p.x < b.x + b.w && b.y < p.y + p.h && p.y < b.y + b.h;
      if (overlaps && !insideP) return decline(`${b.id} overlaps panel ${p.id}`);
      if (insideP) {
        const pad = Math.min(
          b.x - p.x,
          p.x + p.w - (b.x + b.w),
          b.y + b.h <= p.y + p.h ? p.y + p.h - (b.y + b.h) : -1,
        );
        if (pad < PANEL.pad - 1) return decline(`${b.id} crowds panel ${p.id} (${Math.round(pad)})`);
        if (b.y - p.y < PANEL.head - 1) return decline(`${b.id} sits in ${p.id}'s title strip`);
      }
    }
  }
  // Two panels either nest or stand clear of each other.
  for (let i = 0; i < allPanels.length; i++) {
    for (let j = i + 1; j < allPanels.length; j++) {
      const a = allPanels[i]!;
      const b = allPanels[j]!;
      const nested = descendantsOf(a).has(b.id) || descendantsOf(b).has(a.id);
      const overlaps = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      if (overlaps && !nested) return decline(`panels ${a.id}/${b.id} overlap`);
    }
  }

  for (const r of routes) {
    // Bends (6.1) and the short-jog range.
    if (r.pts.length - 2 > RULES['6.1-bends-forward']!.threshold!)
      return decline(`edge ${r.edge.id} bends`);
    for (let i = 1; i < r.pts.length; i++) {
      const d =
        Math.abs(r.pts[i]!.x - r.pts[i - 1]!.x) + Math.abs(r.pts[i]!.y - r.pts[i - 1]!.y);
      if (d > 0.5 && d < 6) return decline(`edge ${r.edge.id} short jog`);
    }
    let len = 0;
    for (let i = 1; i < r.pts.length; i++)
      len += Math.abs(r.pts[i]!.x - r.pts[i - 1]!.x) + Math.abs(r.pts[i]!.y - r.pts[i - 1]!.y);
    if (len < RULES['2.3']!.threshold!) return decline(`edge ${r.edge.id} touching`);

    for (let i = 1; i < r.pts.length; i++) {
      const x1 = Math.min(r.pts[i - 1]!.x, r.pts[i]!.x);
      const x2 = Math.max(r.pts[i - 1]!.x, r.pts[i]!.x);
      const y1 = Math.min(r.pts[i - 1]!.y, r.pts[i]!.y);
      const y2 = Math.max(r.pts[i - 1]!.y, r.pts[i]!.y);
      if (x2 - x1 < 13 && y2 - y1 < 13) continue;
      // 6.8's clearance from every box the edge does not connect.
      for (const b of nodeBoxes) {
        if (b.id === r.edge.from || b.id === r.edge.to) continue;
        const c = EDGE_NODE_CLEAR - 1;
        if (x1 < b.x + b.w + c && x2 > b.x - c && y1 < b.y + b.h + c && y2 > b.y - c)
          return decline(`edge ${r.edge.id} hugs ${b.id}`);
      }
      // A panel is entered only by an edge that ends inside it, and only
      // across a border it crosses perpendicular (2.10). The title strip is
      // reserved: nothing runs ALONG it.
      for (const p of allPanels) {
        const inside = x1 < p.x + p.w && x2 > p.x && y1 < p.y + p.h && y2 > p.y;
        if (!inside) continue;
        const mine = descendantsOf(p);
        if (!mine.has(r.edge.from) && !mine.has(r.edge.to))
          return decline(`edge ${r.edge.id} runs through panel ${p.id}`);
        const inStrip = y1 < p.y + PANEL.head && y2 > p.y;
        const alongStrip = y2 - y1 < 0.5;
        if (inStrip && alongStrip)
          return decline(`edge ${r.edge.id} runs along ${p.id}'s title strip`);
      }
    }
  }

  // 6.2: a side that receives never emits.
  {
    const used = new Map<string, Set<Side>>();
    const claim = (id: string, side: Side, role: 'in' | 'out'): boolean => {
      const k = `${id}:${role}`;
      const other = used.get(`${id}:${role === 'in' ? 'out' : 'in'}`);
      if (other?.has(side)) return false;
      const set = used.get(k) ?? new Set<Side>();
      set.add(side);
      used.set(k, set);
      return true;
    };
    for (const r of routes) {
      if (!claim(r.edge.from, r.startSide, 'out')) return decline(`${r.edge.from} emits into an arrival face`);
      if (!claim(r.edge.to, r.endSide, 'in')) return decline(`${r.edge.to} receives on an exit face`);
    }
  }

  // Forward edges never cross (6.1); a shared start or end point is the
  // fan/merge exemption.
  const near = (a: Pt, b: Pt): boolean => Math.abs(a.x - b.x) < 1.5 && Math.abs(a.y - b.y) < 1.5;
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const A = routes[i]!.pts;
      const B = routes[j]!.pts;
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
            return decline(`${routes[i]!.edge.id} crosses ${routes[j]!.edge.id}`);
        }
      }
    }
  }

  // --- SEAT THE PILLS (DESIGN 6.5) ----------------------------------------
  // A panel route is its own path end to end — this planner has no buses and
  // no shared trunks — so an edge's longest exclusive run is simply the
  // longest segment of its own path. The centre goes on the midpoint of that
  // segment's DRAWN extent: the line as painted, which stands off its source
  // by `edgeGapStart` and stops short of the arrowhead by `edgeGap`, so the
  // head never counts toward the centring.
  const seatedPills: SeatedPill[] = [];
  for (const r of routes) {
    const pill = pills.get(r.edge.id);
    if (!pill) continue;
    const drawn = r.pts.map((p) => ({ ...p }));
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
    let best: [Pt, Pt] | null = null;
    let bestLen = -1;
    for (let i = 1; i < drawn.length; i++) {
      const p = drawn[i - 1]!;
      const q = drawn[i]!;
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (len > bestLen) {
        bestLen = len;
        best = [p, q];
      }
    }
    if (!best) return decline(`${r.edge.id} has no run for its pill`);
    const vertical = Math.abs(best[0].x - best[1].x) < 0.01;
    const along = vertical ? pill.height : pill.width;
    // 2.7 sized the band for exactly this, so a pill that still cannot keep
    // 2.9's 16 of visible line either side means the plan is wrong, not that
    // the pill should be nudged somewhere it does not belong.
    if (bestLen < along + 2 * PILL_RUN_CLEAR)
      return decline(
        `${r.edge.id}'s run is ${Math.round(bestLen)} for a ${Math.round(along)} pill`,
      );
    seatedPills.push({
      edge: r.edge,
      pill,
      cx: (best[0].x + best[1].x) / 2,
      cy: (best[0].y + best[1].y) / 2,
      run: { x1: best[0].x, y1: best[0].y, x2: best[1].x, y2: best[1].y },
    });
  }
  // 6.5's one allowed movement: a pill slides along its own run, never off it.
  slidePills(seatedPills);
  // 6.9: a pill never covers a node. A panel is checked on its BORDER, not
  // its area — a pill belonging to an edge between two children sits inside
  // the panel by construction and is not covering anything; what it may not
  // do is straddle the border, or sit in 2.6's reserved title strip.
  for (const sp of seatedPills) {
    const box = {
      x: sp.cx - sp.pill.width / 2,
      y: sp.cy - sp.pill.height / 2,
      w: sp.pill.width,
      h: sp.pill.height,
    };
    const hits = (b: { x: number; y: number; w: number; h: number }): boolean =>
      box.x < b.x + b.w && b.x < box.x + box.w && box.y < b.y + b.h && b.y < box.y + box.h;
    for (const n of nodeBoxes) {
      if (hits(n)) return decline(`${sp.edge.id}'s pill covers ${n.id}`);
    }
    for (const p of allPanels) {
      if (!hits(p)) continue;
      const inside =
        box.x >= p.x && box.y >= p.y && box.x + box.w <= p.x + p.w && box.y + box.h <= p.y + p.h;
      if (!inside) return decline(`${sp.edge.id}'s pill straddles ${p.id}'s border`);
      if (box.y < p.y + PANEL.head) return decline(`${sp.edge.id}'s pill sits in ${p.id}'s title strip`);
    }
  }

  // Extent and the canvas budgets (1.1, 1.4).
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
  for (const p of allPanels) {
    grow(p.x, p.y);
    grow(p.x + p.w, p.y + p.h);
  }
  for (const r of routes) for (const p of r.pts) grow(p.x, p.y);
  for (const sp of seatedPills) {
    grow(sp.cx - sp.pill.width / 2, sp.cy - sp.pill.height / 2);
    grow(sp.cx + sp.pill.width / 2, sp.cy + sp.pill.height / 2);
  }
  const totalW = maxX - minX;
  const totalH = maxY - minY;
  if (totalW > room) return decline(`too wide (${Math.round(totalW)} > ${room})`);
  if (Number.isFinite(scene.canvas.maxAspect)) {
    const m = scene.canvas.margin;
    const frameW = Math.max(scene.canvas.min, roundUp(totalW + 2 * m, GRID));
    if (totalH + 2 * m > scene.canvas.maxAspect * frameW)
      return decline(`too tall (${Math.round(totalH + 2 * m)} > 1.4×${frameW})`);
  }

  // --- COMMIT -------------------------------------------------------------
  for (const n of graph.nodes) {
    const it = nodeItems.get(n.id)!;
    n.x = it.x - minX;
    n.y = it.y - minY;
  }
  for (const c of graph.clusters) {
    const it = panelItems.get(c.id)!;
    c.x = it.x - minX;
    c.y = it.y - minY;
    c.width = it.w;
    c.height = it.h;
  }
  const pillOf = new Map(seatedPills.map((sp) => [sp.edge.id, sp] as const));
  for (const r of routes) {
    const sp = pillOf.get(r.edge.id);
    r.edge.channel = {
      points: r.pts.map((p) => ({ x: p.x - minX, y: p.y - minY })),
      startSide: r.startSide,
      endSide: r.endSide,
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
  return { width: totalW, height: totalH, warnings: [] };

  /** Every id inside an item, at any depth — itself included. */
  function descendantsOf(item: Item): Set<string> {
    const out = new Set<string>();
    const walk = (i: Item): void => {
      out.add(i.id);
      if (i.kind === 'panel') for (const c of i.items) walk(c);
    };
    walk(item);
    return out;
  }
}
