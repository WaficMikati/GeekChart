import type { Graph, GraphCluster, GraphEdge, GraphNode } from '../graph.ts';
import { panelKicker } from '../graph.ts';
import type { Scene } from '../scene.ts';
import { GRID, GUTTER, PANEL } from '../tokens.ts';
import {
  PILL_CLEAR,
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

/**
 * DESIGN 1.10: the safe layout — the channel engine's last resort.
 *
 * Every node on its own rank, in one column: the widest box sets the column
 * and every box is centred on it. A forward edge between two rank-neighbours
 * is a straight drop. Everything else — a rank-skip, a reconvergence, a
 * loop-back — leaves its source's bottom face, crosses the band on a
 * reserved lane, runs a side corridor (DESIGN 6.7's 24 of clearance beyond
 * the boxes it passes), crosses the band above its target and drops into its
 * top face, which is the same six-point shape `grid.ts` gives a join that
 * skips a rank. Routes into one target share a corridor and a trunk (DESIGN
 * 6.14) so they arrive as one head (6.3); corridor groups alternate flanks
 * and are ordered widest-span outermost, so a group's own band legs never
 * cross a lane belonging to a group nested inside it.
 *
 * Unlike every other planner in the engine this one NEVER declines. It has no
 * search and no verify: the picture is decided by the node order alone, and
 * the geometry that order implies holds the rules by construction. A
 * flowchart the designed shapes all turn down is drawn here rather than
 * handed to the pre-rewrite router — 1.10's ruling, "a drawing nobody
 * verified is worse than a plain one that holds every rule".
 */

/** DESIGN 6.7: a corridor keeps this clear beyond the boxes it passes. */
const LOOP_CLEAR = 24;
/** Track pitch between parallel runs (DESIGN 6.4). */
const TRACK = 16;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A route that leaves the column: a rank-skip, a reconvergence or a loop. */
interface Corridor {
  /** All edges of this group — they share the corridor and the trunk. */
  edges: GraphEdge[];
  /** Sequence band the group leaves through, per edge. */
  fromBand: Map<string, number>;
  /** Sequence band the group arrives through (shared). */
  toBand: number;
  /** Which flank: -1 left, +1 right. */
  flank: -1 | 1;
  /** Distance from the column's own outer edge to the corridor's line. */
  offset: number;
  /** Span in sequence bands, for the nesting order. */
  span: number;
  /**
   * DESIGN 6.7: a return whose target's flank face is free comes in there,
   * level with the box, instead of climbing to the band above it and back in
   * through the top. Two bends instead of four, and — the reason it matters —
   * the run stops at the box's own edge rather than crossing the whole
   * half-width to the column line, which is what put the longer shape over
   * 6.7's budget on a chart of nine ranks.
   */
  sideArrive: boolean;
}

export function layoutSafe(
  graph: Graph,
  scene: Scene,
  measureLine: (s: string) => number,
): ChannelLayout {
  const warnings: string[] = [];

  // ---- ORDER -------------------------------------------------------------
  // One column, so the only real decision is the reading order. It is a
  // topological walk that keeps every panel's members contiguous, so a
  // subgraph is still one unbroken block of the column and its box can be
  // drawn around it (DESIGN 2.6).
  const clusterById = new Map(graph.clusters.map((c) => [c.id, c] as const));
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const parentOf = new Map<string, string>();
  for (const c of graph.clusters) for (const id of c.nodes) parentOf.set(id, c.id);

  const topLevel: string[] = [
    ...graph.clusters.filter((c) => !parentOf.has(c.id)).map((c) => c.id),
    ...graph.nodes.filter((n) => !parentOf.has(n.id)).map((n) => n.id),
  ];
  // Original declaration order, so the tie-break is the author's own.
  const declared = new Map<string, number>();
  {
    let i = 0;
    for (const c of graph.clusters) declared.set(c.id, i++);
    for (const n of graph.nodes) if (!declared.has(n.id)) declared.set(n.id, i++);
  }

  /** The ancestor of `id` that sits directly in `members`, else undefined. */
  const liftTo = (id: string, members: Set<string>): string | undefined => {
    let cur: string | undefined = id;
    while (cur) {
      if (members.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return undefined;
  };

  const orderLevel = (members: string[]): string[] => {
    const set = new Set(members);
    const indeg = new Map<string, number>(members.map((m) => [m, 0] as const));
    const out = new Map<string, string[]>(members.map((m) => [m, []]));
    for (const e of graph.edges) {
      if (e.backward) continue;
      const a = liftTo(e.from, set);
      const b = liftTo(e.to, set);
      if (!a || !b || a === b) continue;
      out.get(a)!.push(b);
      indeg.set(b, indeg.get(b)! + 1);
    }
    const ready = members
      .filter((m) => indeg.get(m) === 0)
      .sort((a, b) => declared.get(a)! - declared.get(b)!);
    const seq: string[] = [];
    const seen = new Set<string>();
    while (ready.length) {
      const m = ready.shift()!;
      if (seen.has(m)) continue;
      seen.add(m);
      seq.push(m);
      const freed: string[] = [];
      for (const k of out.get(m)!) {
        indeg.set(k, indeg.get(k)! - 1);
        if (indeg.get(k) === 0) freed.push(k);
      }
      freed.sort((a, b) => declared.get(a)! - declared.get(b)!);
      ready.unshift(...freed);
      ready.sort((a, b) => declared.get(a)! - declared.get(b)!);
    }
    // A cycle among the members (the parser's back-edge marking missed one):
    // the rest keep their declared order rather than disappearing.
    for (const m of members) if (!seen.has(m)) seq.push(m);
    return seq;
  };

  /** The flat column: leaf nodes, panels contiguous. */
  const column: GraphNode[] = [];
  /** Sequence range of every item, panels included. */
  const range = new Map<string, { lo: number; hi: number }>();
  const emit = (id: string): void => {
    const cluster = clusterById.get(id);
    if (!cluster) {
      const node = nodeById.get(id);
      if (!node) return;
      range.set(id, { lo: column.length, hi: column.length });
      column.push(node);
      return;
    }
    const lo = column.length;
    for (const child of orderLevel(cluster.nodes)) emit(child);
    range.set(id, { lo, hi: Math.max(lo, column.length - 1) });
  };
  for (const id of orderLevel(topLevel)) emit(id);
  // Anything the containment walk missed (a node listed in no cluster and in
  // no level, which should not happen) still gets a rank of its own.
  for (const n of graph.nodes) {
    if (range.has(n.id)) continue;
    range.set(n.id, { lo: column.length, hi: column.length });
    column.push(n);
  }

  const n = column.length;

  // ---- PANEL WIDTHS ------------------------------------------------------
  // Bottom-up: a panel hugs the widest thing inside it plus 24 either side,
  // and never narrower than its own header needs (DESIGN 2.6).
  const colW = roundUp(Math.max(...column.map((node) => node.width!), 0), GRID);
  const depthOf = new Map<string, number>();
  for (const c of graph.clusters) {
    let d = 0;
    let cur = parentOf.get(c.id);
    while (cur) {
      d++;
      cur = parentOf.get(cur);
    }
    depthOf.set(c.id, d);
  }
  const panelW = new Map<string, number>();
  for (const c of [...graph.clusters].sort((a, b) => depthOf.get(b.id)! - depthOf.get(a.id)!)) {
    const inner = Math.max(
      colW,
      ...c.nodes.map((id) => panelW.get(id) ?? 0),
    );
    const header = measureLine(panelKicker(c)) + 2 * PANEL.pad;
    panelW.set(c.id, roundUp(Math.max(inner + 2 * PANEL.pad, header), GRID));
  }
  const outerW = roundUp(Math.max(colW, ...[...panelW.values()]), GRID);

  // ---- ROUTE GROUPS ------------------------------------------------------
  const pills = new Map<string, Pill>();
  for (const e of graph.edges) {
    const p = wrapPill(e, scene, measureLine, warnings);
    if (p) pills.set(e.id, p);
  }

  const rangeOf = (id: string): { lo: number; hi: number } | undefined => range.get(id);
  interface Plan {
    edge: GraphEdge;
    kind: 'drop' | 'corridor';
    src: string;
    dst: string;
    /** Band the edge leaves through (corridor only). */
    fromBand: number;
    /** Band the edge arrives through (corridor only). */
    toBand: number;
  }
  const plans: Plan[] = [];
  for (const e of graph.edges) {
    const a = rangeOf(e.from);
    const b = rangeOf(e.to);
    if (!a || !b) continue;
    if (b.lo === a.hi + 1) {
      plans.push({ edge: e, kind: 'drop', src: e.from, dst: e.to, fromBand: a.hi, toBand: a.hi });
      continue;
    }
    plans.push({
      edge: e,
      kind: 'corridor',
      src: e.from,
      dst: e.to,
      fromBand: a.hi,
      toBand: b.lo - 1,
    });
  }

  // DESIGN 6.14: everything arriving at one endpoint from a corridor shares
  // that corridor and its trunk, so the group lands as a single head.
  const groups = new Map<string, Plan[]>();
  for (const p of plans) {
    if (p.kind !== 'corridor') continue;
    const list = groups.get(p.dst) ?? [];
    list.push(p);
    groups.set(p.dst, list);
  }
  const corridors: Corridor[] = [];
  for (const list of groups.values()) {
    const bands = list.flatMap((p) => [p.fromBand, p.toBand]);
    corridors.push({
      edges: list.map((p) => p.edge),
      fromBand: new Map(list.map((p) => [p.edge.id, p.fromBand] as const)),
      toBand: list[0]!.toBand,
      flank: 1,
      offset: 0,
      span: Math.max(...bands) - Math.min(...bands),
      sideArrive: false,
    });
  }
  // Widest span first, alternating flanks: a group nested inside another is
  // therefore always on the inner lane of its flank, and the outer group's
  // own band legs run above and below it rather than through it.
  corridors.sort((a, b) => b.span - a.span);
  const flanks = new Map<number, Corridor[]>([
    [1, []],
    [-1, []],
  ]);
  corridors.forEach((c, i) => {
    c.flank = i % 2 === 0 ? 1 : -1;
    flanks.get(c.flank)!.push(c);
  });
  // DESIGN 6.2: a return leaves its source's flank face, so that face emits.
  // A group may come in on its target's flank only when nothing leaves there.
  const emitsOn = new Set<string>();
  for (const c of corridors) {
    for (const e of c.edges) if (e.backward) emitsOn.add(`${e.from}|${c.flank}`);
  }
  for (const c of corridors) {
    c.sideArrive =
      c.edges.every((e) => e.backward) && !emitsOn.has(`${c.edges[0]!.to}|${c.flank}`);
  }

  // Offsets are stacked from the column outwards, innermost (narrowest span)
  // first, so a lane always has room for its own pill: DESIGN 6.5's plate
  // rides the corridor's vertical run, and a corridor whose pill would reach
  // back over the boxes — or over the lane beside it — stands further off.
  const halfPill = (c: Corridor): number =>
    Math.max(0, ...c.edges.map((e) => (pills.get(e.id)?.width ?? 0) / 2));
  for (const list of flanks.values()) {
    let prev = 0;
    let prevHalf = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i]!;
      const half = halfPill(c);
      // Snapped to the 8-grid (DESIGN 2.1) — and because a pill's own width
      // is measured text, snapping is also what keeps the two measurement
      // back ends agreeing on the chart's width: a glyph advance that
      // differs by a fraction between fontkit and the browser would
      // otherwise walk straight into the canvas total.
      const room = roundUp(
        prev
          ? prev + Math.max(TRACK, prevHalf + half + PILL_NODE_CLEAR)
          : Math.max(LOOP_CLEAR, half + PILL_NODE_CLEAR),
        GRID,
      );
      c.offset = room;
      prev = room;
      prevHalf = half;
    }
  }

  // ---- BANDS -------------------------------------------------------------
  // Bands run from −1 (above the first box) to n−1 (below the last). Only the
  // ones something crosses are reserved at the ends.
  const bandUsers = new Map<number, string[]>();
  const useBand = (b: number, groupId: string): void => {
    const list = bandUsers.get(b) ?? [];
    if (!list.includes(groupId)) list.push(groupId);
    bandUsers.set(b, list);
  };
  for (const c of corridors) {
    const groupId = c.edges[0]!.id;
    if (!c.sideArrive) useBand(c.toBand, groupId);
    // A loop-back turns out of its source's side face, on the source's own
    // row, so it spends no lane in the band below it; a forward run does.
    for (const e of c.edges) if (!e.backward) useBand(c.fromBand.get(e.id)!, groupId);
  }
  /** The labelled drop that crosses band `b`, if there is one. */
  const bandPill = new Map<number, number>();
  for (const p of plans) {
    if (p.kind !== 'drop') continue;
    const pill = pills.get(p.edge.id);
    if (pill) bandPill.set(p.fromBand, Math.max(bandPill.get(p.fromBand) ?? 0, pill.height));
  }
  // The band is one height for the whole chart (7.4: even whitespace), sized
  // for the worst band in it. A band carrying both lanes and a labelled drop
  // is the tall case: the lanes hang under the box above and the pill sits at
  // the band's own midpoint, so the band has to hold both without the pill
  // landing on a lane (DESIGN 6.5's "never on another edge").
  let need = Math.max(GUTTER.sibling, 2 * TURN + 2 * STANDOFF);
  const bands = new Set([...bandUsers.keys(), ...bandPill.keys()]);
  for (const b of bands) {
    const lanes = bandUsers.get(b)?.length ?? 0;
    const ph = bandPill.get(b) ?? 0;
    if (lanes && ph) {
      need = Math.max(need, 2 * (LOOP_CLEAR + (lanes - 1) * TRACK + PILL_CLEAR + ph / 2));
    } else if (lanes) {
      need = Math.max(need, 2 * LOOP_CLEAR + (lanes - 1) * TRACK);
    } else {
      need = Math.max(need, ph + 2 * PILL_NODE_CLEAR);
    }
  }
  const BAND = roundUp(need, GRID);

  // ---- VERTICAL PLACEMENT ------------------------------------------------
  const opensAt = new Map<number, GraphCluster[]>();
  const closesAt = new Map<number, GraphCluster[]>();
  for (const c of graph.clusters) {
    const r = range.get(c.id);
    if (!r) continue;
    (opensAt.get(r.lo) ?? opensAt.set(r.lo, []).get(r.lo)!).push(c);
    (closesAt.get(r.hi) ?? closesAt.set(r.hi, []).get(r.hi)!).push(c);
  }
  const needTopBand = [...bandUsers.keys()].some((b) => b < 0);
  // There is no band below the last box to reserve: a forward run's source is
  // always above its target, and a return leaves its source's flank face, so
  // nothing crosses under the bottom of the column.

  const y = new Map<string, number>();
  let cursor =
    (needTopBand ? BAND : 0) + (opensAt.get(0)?.length ?? 0) * PANEL.head;
  for (let i = 0; i < n; i++) {
    const node = column[i]!;
    y.set(node.id, cursor);
    cursor += node.height!;
    if (i === n - 1) break;
    cursor +=
      (closesAt.get(i)?.length ?? 0) * PANEL.pad +
      BAND +
      (opensAt.get(i + 1)?.length ?? 0) * PANEL.head;
  }
  cursor += (closesAt.get(n - 1)?.length ?? 0) * PANEL.pad;
  const contentBottom = cursor;

  // ---- BOXES -------------------------------------------------------------
  const axis = outerW / 2;
  const boxOf = new Map<string, Box>();
  for (const node of column) {
    boxOf.set(node.id, {
      x: axis - node.width! / 2,
      y: y.get(node.id)!,
      w: node.width!,
      h: node.height!,
    });
  }
  const panelBox = new Map<string, Box>();
  for (const c of graph.clusters) {
    const r = range.get(c.id);
    if (!r) continue;
    const first = column[r.lo];
    const last = column[r.hi];
    if (!first || !last) continue;
    const w = panelW.get(c.id)!;
    const top = y.get(first.id)! - PANEL.head;
    const bottom = y.get(last.id)! + last.height! + PANEL.pad;
    const box = { x: axis - w / 2, y: top, w, h: bottom - top };
    panelBox.set(c.id, box);
    boxOf.set(c.id, box);
  }

  /** The v of band `b`'s lane for the group whose first edge is `id`. */
  const bandTop = (b: number): number => {
    if (b < 0) return 0;
    if (b >= n - 1) return contentBottom;
    const above = column[b]!;
    return y.get(above.id)! + above.height! + (closesAt.get(b)?.length ?? 0) * PANEL.pad;
  };
  const laneV = (b: number, groupId: string): number => {
    const list = bandUsers.get(b) ?? [];
    const k = Math.max(0, list.indexOf(groupId));
    // Lanes hang under the box above at DESIGN 6.7's 24 — the same clearance
    // the side corridor keeps, since a band leg passes boxes it is not
    // attached to exactly the way the corridor does — and the rest of the
    // band below them is free for the drop's own pill.
    return bandTop(b) + LOOP_CLEAR + k * TRACK;
  };

  // ---- ROUTES ------------------------------------------------------------
  const outer = Math.max(outerW, ...[...panelBox.values()].map((b) => b.w));
  interface Routed {
    edge: GraphEdge;
    pts: { x: number; y: number }[];
    exempt?: 'bus' | 'wrap';
    isReturn?: boolean;
    pillRun?: [{ x: number; y: number }, { x: number; y: number }];
  }
  const routed: Routed[] = [];
  for (const p of plans) {
    if (p.kind !== 'drop') continue;
    const a = boxOf.get(p.src)!;
    const b = boxOf.get(p.dst)!;
    const x = axis;
    routed.push({
      edge: p.edge,
      pts: [
        { x, y: a.y + a.h },
        { x, y: b.y },
      ],
      // DESIGN 6.5: the pill sits at the midpoint of the run as *drawn*, and
      // `draw.ts` trims the drop by `edgeGapStart` at the source and by the
      // arrowhead's own `edgeGap` at the target. Handing the untrimmed run
      // in puts every pill on a column half that difference off centre.
      pillRun: [
        { x, y: a.y + a.h + scene.edgeGapStart },
        { x, y: b.y - scene.edgeGap },
      ],
    });
  }

  for (const c of corridors) {
    const dst = c.edges[0]!.to;
    const t = boxOf.get(dst)!;
    const cu = c.flank > 0 ? axis + outer / 2 + c.offset : axis - outer / 2 - c.offset;
    const groupId = c.edges[0]!.id;
    const lvT = c.sideArrive ? t.y + t.h / 2 : laneV(c.toBand, groupId);
    const arriveX = c.sideArrive ? (c.flank > 0 ? t.x + t.w : t.x) : axis;
    for (const e of c.edges) {
      const s = boxOf.get(e.from)!;
      // DESIGN 6.7: a loop-back leaves the flank the corridor is on, at the
      // source's own centre line, and turns straight into it. Dropping out
      // of the bottom face first and doubling back up would spend the whole
      // band twice over, which is what puts a return over 6.7's budget.
      // A forward run keeps `grid.ts`'s six-point join shape: out of the
      // bottom, across the band on its lane, down the corridor, across the
      // band above the target and into its top face.
      const vS = e.backward ? s.y + s.h / 2 : laneV(c.fromBand.get(e.id)!, groupId);
      const pts = simplify(
        [
          ...(e.backward
            ? [{ x: c.flank > 0 ? s.x + s.w : s.x, y: vS }]
            : [
                { x: axis, y: s.y + s.h },
                { x: axis, y: vS },
              ]),
          { x: cu, y: vS },
          { x: cu, y: lvT },
          ...(c.sideArrive ? [{ x: arriveX, y: lvT }] : [{ x: axis, y: lvT }, { x: axis, y: t.y }]),
        ],
      );
      routed.push({
        edge: e,
        pts,
        exempt: 'wrap',
        ...(e.backward ? { isReturn: true } : {}),
        pillRun: [
          { x: cu, y: Math.min(vS, lvT) + TURN },
          { x: cu, y: Math.max(vS, lvT) - TURN },
        ],
      });
    }
  }

  // ---- PILLS -------------------------------------------------------------
  const seated: SeatedPill[] = [];
  for (const r of routed) {
    const pill = pills.get(r.edge.id);
    if (!pill || !r.pillRun) continue;
    const [p1, p2] = r.pillRun;
    const cx = (p1.x + p2.x) / 2;
    const cy = (p1.y + p2.y) / 2;
    seated.push({
      edge: r.edge,
      pill,
      cx,
      cy,
      run: { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y },
    });
  }
  slidePills(seated);

  // ---- EXTENT AND COMMIT -------------------------------------------------
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (px: number, py: number): void => {
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  };
  for (const b of boxOf.values()) {
    grow(b.x, b.y);
    grow(b.x + b.w, b.y + b.h);
  }
  for (const r of routed) for (const p of r.pts) grow(p.x, p.y);
  for (const sp of seated) {
    grow(sp.cx - sp.pill.width / 2, sp.cy - sp.pill.height / 2);
    grow(sp.cx + sp.pill.width / 2, sp.cy + sp.pill.height / 2);
  }

  for (const node of graph.nodes) {
    const b = boxOf.get(node.id);
    if (!b) continue;
    node.x = b.x - minX;
    node.y = b.y - minY;
  }
  for (const c of graph.clusters) {
    const b = panelBox.get(c.id);
    if (!b) continue;
    c.x = b.x - minX;
    c.y = b.y - minY;
    c.width = b.w;
    c.height = b.h;
  }
  const pillOf = new Map(seated.map((sp) => [sp.edge.id, sp] as const));
  for (const r of routed) {
    const sp = pillOf.get(r.edge.id);
    const pts = r.pts.map((p) => ({ x: p.x - minX, y: p.y - minY }));
    r.edge.channel = {
      points: pts,
      startSide: sideOut(pts[0]!, pts[1]!),
      endSide: sideIn(pts[pts.length - 2]!, pts[pts.length - 1]!),
      ...(r.exempt ? { exempt: r.exempt } : {}),
      ...(r.isReturn ? { isReturn: true } : {}),
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
  graph.layoutKind = 'safe';
  // The picture is a column whatever the source declared. `data-flow` is what
  // the gate reads to know which axis is the flow axis (6.7's corridor
  // clearance, 6.2's arrival side, 7.3's row centres), so an LR source drawn
  // as a safe column has to say TB or every one of those is measured
  // sideways.
  graph.direction = 'TB';
  return { width: maxX - minX, height: maxY - minY, warnings };
}

type Side = 'top' | 'bottom' | 'left' | 'right';
const sideOut = (a: { x: number; y: number }, b: { x: number; y: number }): Side => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? 'bottom' : 'top') : dx > 0 ? 'right' : 'left';
};
const sideIn = (a: { x: number; y: number }, b: { x: number; y: number }): Side => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? 'top' : 'bottom') : dx > 0 ? 'left' : 'right';
};
