import type { Graph, GraphEdge, GraphNode } from '../graph.ts';
import { RULES } from '../rules.ts';
import type { Scene } from '../scene.ts';
import { CLEARANCE, GRID, GUTTER } from '../tokens.ts';

/**
 * DESIGN 2.7: the channel engine, for the two families it owns in this phase
 * — fans (a hub with 3+ leaves, DESIGN 2.8/6.12/6.13) and chains (a linear
 * run of 4+, DESIGN 1.9). Ported from the proven spike in
 * docs/rewrite/channel-engine-seed/engine.mts (13/13 fan charts, zero
 * overlaps), restructured to feed the existing pipeline the way
 * `layout/ring.ts` does: this module decides `node.x`/`y` and writes each
 * edge's finished route and pill onto `edge.channel`; `draw.ts` and
 * `motion.ts` then treat the chart like any other.
 *
 * The structure is the seed's, in order:
 *   FLOOR PLAN — rows of nodes and the corridors/bands between them are
 *     first-class grid members, reserved before anything is placed;
 *   PLAN — every route is symbolic (which band, which corridor, which face);
 *   DERIVE — a channel's size is computed from what must live in it: track
 *     pitch, each pill plus clearance, turn legs, an arrowhead (DESIGN 2.7),
 *     re-derived to a fixed point, never repaired after the fact;
 *   REALIZE — coordinates come last, pills centred on their own edge's
 *     longest exclusive run (DESIGN 6.5), the centre on the path itself.
 */

// ---------------------------------------------------------------------------
// Detection — conservative on purpose. Anything this function is not sure
// about falls through to the old path unchanged; a chain feeding a fan, a
// panel, a compartmented node, a non-arrow tip are all someone else's phase.
// ---------------------------------------------------------------------------

export type ChannelPlan =
  | { kind: 'fan-out' | 'fan-in'; hub: GraphNode; leaves: GraphNode[] }
  | { kind: 'chain'; order: GraphNode[] };

/** Shapes the engine knows how to seat. Markers (state dots/bars), notes and
 *  record panels keep the old path — their geometry rules live there. */
const PLAIN_SHAPES = new Set([
  'rect',
  'round',
  'stadium',
  'diamond',
  'hexagon',
  'cylinder',
  'subroutine',
  'parallelogram',
  'trapezoid',
  'doc',
  'circle',
]);

export function detectChannelChart(graph: Graph): ChannelPlan | null {
  if (graph.clusters.length > 0) return null;
  const n = graph.nodes.length;
  if (n < 4 || graph.edges.length !== n - 1) return null;
  if (graph.nodes.some((node) => (node.rows?.length ?? 0) > 0 || !PLAIN_SHAPES.has(node.shape))) {
    return null;
  }
  for (const edge of graph.edges) {
    if (edge.from === edge.to || edge.backward) return null;
    if (edge.labelStart || edge.labelEnd) return null;
    // Only a plain directed arrow: crow's feet, inheritance triangles and
    // headless lines carry meaning the fan/chain templates don't draw.
    if ((edge.tipEnd ?? 'arrow') !== 'arrow' || (edge.tipStart ?? 'none') !== 'none') return null;
  }

  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const outs = new Map<string, GraphEdge[]>();
  const ins = new Map<string, GraphEdge[]>();
  for (const node of graph.nodes) {
    outs.set(node.id, []);
    ins.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (!outs.has(edge.from) || !ins.has(edge.to)) return null;
    outs.get(edge.from)!.push(edge);
    ins.get(edge.to)!.push(edge);
  }

  // Fans are a vertical picture (hub above or below its leaves), so only a
  // top-to-bottom chart is claimed; an LR fan keeps its old horizontal layout.
  if (graph.direction === 'TB') {
    const hubOut = graph.nodes.find((node) => outs.get(node.id)!.length === n - 1);
    if (hubOut && ins.get(hubOut.id)!.length === 0) {
      const leaves = outs.get(hubOut.id)!.map((edge) => byId.get(edge.to)!);
      const clean =
        new Set(leaves.map((l) => l.id)).size === n - 1 &&
        leaves.every((l) => outs.get(l.id)!.length === 0 && ins.get(l.id)!.length === 1);
      if (clean) return { kind: 'fan-out', hub: hubOut, leaves };
    }
    const hubIn = graph.nodes.find((node) => ins.get(node.id)!.length === n - 1);
    if (hubIn && outs.get(hubIn.id)!.length === 0) {
      const leaves = ins.get(hubIn.id)!.map((edge) => byId.get(edge.from)!);
      const clean =
        new Set(leaves.map((l) => l.id)).size === n - 1 &&
        leaves.every((l) => ins.get(l.id)!.length === 0 && outs.get(l.id)!.length === 1);
      if (clean) return { kind: 'fan-in', hub: hubIn, leaves };
    }
    return null;
  }

  // Chains: DESIGN 1.9's ribbon is a reading-order picture, the shape of a
  // left-to-right run that wraps — so only an LR chart is claimed. A TB chain
  // is already the vertical list and keeps its old path byte-identical.
  if (graph.direction === 'LR') {
    const start = graph.nodes.find(
      (node) => ins.get(node.id)!.length === 0 && outs.get(node.id)!.length === 1,
    );
    if (!start) return null;
    const order: GraphNode[] = [start];
    const seen = new Set([start.id]);
    let cur = start;
    while (outs.get(cur.id)!.length === 1) {
      const next = byId.get(outs.get(cur.id)![0]!.to);
      if (!next || seen.has(next.id)) return null;
      if (ins.get(next.id)!.length !== 1) return null;
      order.push(next);
      seen.add(next.id);
      cur = next;
    }
    if (order.length !== n || outs.get(cur.id)!.length !== 0) return null;
    return { kind: 'chain', order };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Shared arithmetic
// ---------------------------------------------------------------------------

/** DESIGN 2.7: corner radius of an edge turn — one leg of every turn. */
const TURN = 12;
/** DESIGN 2.7: an edge's departure standoff before its first turn. */
const STANDOFF = 4;
/** DESIGN 6.5: pill side padding. */
const PILL_PAD_X = 8;
/** DESIGN 6.5: two pills on one channel keep this much clear. */
const PILL_CLEAR = 2;
/** DESIGN 6.9: a pill keeps this clear of every box. */
const PILL_NODE_CLEAR = RULES['6.9']!.threshold!; // 8
/** DESIGN 6.9: a pill keeps this far from every other edge's segments. */
const PILL_EDGE_CLEAR = RULES['6.11-other']!.threshold!; // 16
/** Shortest straight run before an arrowhead. */
const MIN_RUN = 8;

const roundUp = (v: number, to: number): number => Math.ceil(v / to) * to;

/** DESIGN 6.5: pill height for `k` lines — 22 for one, matching the stacked
 *  text rows `draw.ts` renders (`edgeLabelSize * 1.3` between baselines). */
const pillHeight = (scene: Scene, lines: number): number =>
  lines > 1
    ? scene.edgeLabelSize * 2 + (lines - 1) * scene.edgeLabelSize * 1.3
    : scene.edgeLabelSize * 2;

export interface Pill {
  lines: string[];
  width: number;
  height: number;
}

/**
 * DESIGN 6.5: a label longer than 28 characters wraps to a second pill line;
 * past two lines the render keeps the first two and warns
 * (`6.5-label-length`) — a label that long is a sentence, and sentences
 * belong in captions. Greedy word wrap; a single word longer than the cap
 * stays whole (never a hard mid-word break).
 */
export function wrapPill(
  edge: GraphEdge,
  scene: Scene,
  measureLine: (s: string) => number,
  warnings: string[],
): Pill | undefined {
  if (!edge.label) return undefined;
  const cap = RULES['6.5-label-length']!.threshold!; // 28 characters
  const words = edge.label.split(/\s+/).filter(Boolean);
  let lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && next.length > cap) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  if (lines.length === 0) lines = [edge.label];
  if (lines.length > 2) {
    warnings.push(
      `6.5-label-length "${edge.label}" (${edge.from}→${edge.to}) is longer than two ${cap}-character pill lines — kept the first two; a label that long is a sentence and belongs in a caption`,
    );
    lines = lines.slice(0, 2);
  }
  const width = Math.max(...lines.map(measureLine)) + PILL_PAD_X * 2;
  return { lines, width, height: pillHeight(scene, lines.length) };
}

/**
 * DESIGN 6.5: slide-along-run collision resolution — the only movement a
 * pill is allowed. Each seated pill knows the straight run it may slide on;
 * when two pills come closer than 2, the later one slides along its own run,
 * never off it, keeping its centre on the path.
 */
interface SeatedPill {
  edge: GraphEdge;
  pill: Pill;
  /** Pill centre. */
  cx: number;
  cy: number;
  /** The run the centre may slide along (axis-aligned). */
  run: { x1: number; y1: number; x2: number; y2: number };
}

function slidePills(seated: SeatedPill[]): void {
  const boxOf = (p: SeatedPill) => ({
    x: p.cx - p.pill.width / 2,
    y: p.cy - p.pill.height / 2,
    w: p.pill.width,
    h: p.pill.height,
  });
  const tooClose = (a: SeatedPill, b: SeatedPill): boolean => {
    const ba = boxOf(a);
    const bb = boxOf(b);
    return (
      ba.x < bb.x + bb.w + PILL_CLEAR &&
      bb.x < ba.x + ba.w + PILL_CLEAR &&
      ba.y < bb.y + bb.h + PILL_CLEAR &&
      bb.y < ba.y + ba.h + PILL_CLEAR
    );
  };
  for (let i = 1; i < seated.length; i++) {
    const p = seated[i]!;
    for (let j = 0; j < i; j++) {
      const q = seated[j]!;
      if (!tooClose(p, q)) continue;
      const vertical = Math.abs(p.run.x1 - p.run.x2) < 0.01;
      if (vertical) {
        const qBox = boxOf(q);
        const down = qBox.y + qBox.h + PILL_CLEAR + p.pill.height / 2;
        const up = qBox.y - PILL_CLEAR - p.pill.height / 2;
        const lo = Math.min(p.run.y1, p.run.y2) + p.pill.height / 2;
        const hi = Math.max(p.run.y1, p.run.y2) - p.pill.height / 2;
        p.cy = down <= hi ? Math.max(lo, down) : Math.max(lo, Math.min(hi, up));
      } else {
        const qBox = boxOf(q);
        const right = qBox.x + qBox.w + PILL_CLEAR + p.pill.width / 2;
        const left = qBox.x - PILL_CLEAR - p.pill.width / 2;
        const lo = Math.min(p.run.x1, p.run.x2) + p.pill.width / 2;
        const hi = Math.max(p.run.x1, p.run.x2) - p.pill.width / 2;
        p.cx = right <= hi ? Math.max(lo, right) : Math.max(lo, Math.min(hi, left));
      }
    }
  }
}

const simplify = (points: { x: number; y: number }[]): { x: number; y: number }[] => {
  const kept: { x: number; y: number }[] = [];
  for (const p of points) {
    const last = kept[kept.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    const prev = kept[kept.length - 2];
    if (
      last &&
      prev &&
      ((Math.abs(prev.x - last.x) < 0.01 && Math.abs(last.x - p.x) < 0.01) ||
        (Math.abs(prev.y - last.y) < 0.01 && Math.abs(last.y - p.y) < 0.01))
    ) {
      kept.pop();
    }
    kept.push(p);
  }
  return kept;
};

export interface ChannelLayout {
  width: number;
  height: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Fans — DESIGN 2.8, 6.3, 6.12/6.13's shared bus, sibling wrap with spine.
// ---------------------------------------------------------------------------

/**
 * DESIGN 2.8's wrap: rows of leaves, every row centred on the hub's own
 * axis; when a spine must feed a far row through the near row's centre
 * corridor, the near row keeps an even count so that corridor stays free.
 */
function planLeafRows(leaves: GraphNode[], maxPerRow: number): GraphNode[][] {
  const n = leaves.length;
  if (n <= maxPerRow) return [leaves.slice()];
  // Every row the spine crosses — every row but the farthest — must hold an
  // even count, or the spine runs straight through its middle leaf. When
  // balancing cannot fix a row's parity inside `maxPerRow`, one more row is
  // the honest answer, never a spine through a box.
  const evenCap = maxPerRow - (maxPerRow % 2);
  for (let rowCount = Math.ceil(n / maxPerRow); rowCount <= n; rowCount++) {
    if ((rowCount - 1) * evenCap + maxPerRow < n) continue;
    const base = Math.floor(n / rowCount);
    const counts = Array.from({ length: rowCount }, (_, i) => base + (i < n % rowCount ? 1 : 0));
    for (let i = 0; i < rowCount - 1; i++) {
      if (counts[i]! % 2 === 0) continue;
      if (counts[i]! + 1 <= evenCap) {
        counts[i]! += 1;
        counts[rowCount - 1]! -= 1;
      } else {
        counts[i]! -= 1;
        counts[rowCount - 1]! += 1;
      }
    }
    const last = counts[rowCount - 1]!;
    if (last < 1 || last > maxPerRow) continue;
    if (counts.slice(0, -1).some((c) => c < 2 || c > evenCap)) continue;
    const rows: GraphNode[][] = [];
    let taken = 0;
    for (const count of counts) {
      rows.push(leaves.slice(taken, taken + count));
      taken += count;
    }
    return rows;
  }
  return [leaves.slice()];
}

function layoutFan(
  graph: Graph,
  plan: Extract<ChannelPlan, { kind: 'fan-out' | 'fan-in' }>,
  scene: Scene,
  measureLine: (s: string) => number,
): ChannelLayout {
  const warnings: string[] = [];
  const out = plan.kind === 'fan-out';
  const hub = plan.hub;
  const leaves = plan.leaves;
  const hubW = hub.width!;
  const hubH = hub.height!;
  const leafW = Math.max(...leaves.map((l) => l.width!));
  const leafH = Math.max(...leaves.map((l) => l.height!));

  const edgeOf = new Map<string, GraphEdge>();
  for (const edge of graph.edges) edgeOf.set(out ? edge.to : edge.from, edge);
  const pills = new Map<string, Pill>();
  for (const leaf of leaves) {
    const pill = wrapPill(edgeOf.get(leaf.id)!, scene, measureLine, warnings);
    if (pill) pills.set(leaf.id, pill);
  }
  const maxPillW = Math.max(0, ...[...pills.values()].map((p) => p.width));
  const maxPillH = Math.max(0, ...[...pills.values()].map((p) => p.height));
  const anyPill = pills.size > 0;

  // DERIVE, to a fixed point: pitch depends on the gutter, the gutter on
  // whether the layout wraps, and the wrap on how many leaves a row holds at
  // that pitch. Two passes converge (wrapping only ever widens the gutter).
  const content = scene.canvas.width - scene.canvas.margin * 2;
  let rows: GraphNode[][] = [leaves];
  let pitch = 0;
  for (let round = 0; round < 3; round++) {
    // DESIGN 2.3's gutters are 24 or 32; when a spine has to drop through
    // the near row's centre corridor, 32 is what leaves DESIGN 6.8's 16 of
    // clearance on each side of it — the channel sized for its contents
    // (DESIGN 2.7), chosen from the two values 2.3 allows.
    const gutter = rows.length > 1 ? GUTTER.panel : GUTTER.sibling;
    // Pitch stays on DESIGN 2.1's 8-grid (box sizes and both gutters are
    // multiples of 8 already); pills push siblings apart when wider than
    // the boxes (DESIGN 2.7: the pill is part of what the channel holds).
    pitch = Math.max(roundUp(leafW + gutter, GRID), roundUp(maxPillW + PILL_CLEAR * 2, GRID));
    const maxPerRow = Math.max(1, Math.floor((content + (pitch - leafW)) / pitch));
    const next = planLeafRows(leaves, maxPerRow);
    if (next.length === rows.length) {
      rows = next;
      break;
    }
    rows = next;
  }

  // Band height, DESIGN 2.7: derived from what must live in each half —
  // turn legs (standoff 4 + turn radius 12), the pill plus its clearances
  // (16 from the bus line it crosses under, 8 from the node face it ends
  // at, DESIGN 6.9), and the arrowhead's stub. The bus sits at the band's
  // centre (DESIGN 6.8: a Z edge's middle run is centred in its channel),
  // so the band is twice the larger half, uniform across the chart (2.7).
  const arrowRoom = scene.edgeGap + 4;
  const hubSideNeed = out
    ? STANDOFF + TURN * 2 // trunk drop into the bus
    : TURN + MIN_RUN + arrowRoom; // merged run down to the single arrowhead
  const leafSideNeed = anyPill
    ? out
      ? PILL_EDGE_CLEAR + maxPillH + PILL_NODE_CLEAR + arrowRoom // below the bus
      : STANDOFF + PILL_NODE_CLEAR + maxPillH + PILL_EDGE_CLEAR // above the bus
    : TURN + MIN_RUN + arrowRoom;
  const bandH = roundUp(2 * Math.max(hubSideNeed, leafSideNeed, STANDOFF + TURN * 2), GRID);

  // REALIZE — x on a centre axis (0 = hub centre), rows top to bottom.
  const leafTop = new Map<number, number>();
  const busY = new Map<number, number>();
  let hubTop: number;
  if (out) {
    hubTop = 0;
    let y = hubH;
    rows.forEach((_, r) => {
      busY.set(r, y + bandH / 2);
      y += bandH;
      leafTop.set(r, y);
      y += leafH;
    });
  } else {
    let y = 0;
    for (let r = rows.length - 1; r >= 0; r--) {
      leafTop.set(r, y);
      y += leafH;
      busY.set(r, y + bandH / 2);
      y += bandH;
    }
    hubTop = y;
  }
  const totalH = out ? leafTop.get(rows.length - 1)! + leafH : hubTop + hubH;

  const centreOf = new Map<string, number>();
  const rankOf = new Map<string, number>();
  rows.forEach((row, r) => {
    row.forEach((leaf, i) => {
      const cx = (i - (row.length - 1) / 2) * pitch;
      centreOf.set(leaf.id, cx);
      rankOf.set(leaf.id, r);
      leaf.x = cx - leaf.width! / 2;
      leaf.y = leafTop.get(r)!;
    });
  });
  // The hub sits on the same axis every row is centred on — DESIGN 2.8's
  // symmetry holds by construction, not by adjustment.
  hub.x = -hubW / 2;
  hub.y = hubTop;

  // Routes. Every fan edge shares the hub's own face-centre point (DESIGN
  // 6.4's fan-bus exemption; for a fan-in that shared arrival is what makes
  // DESIGN 6.3's single arrowhead impossible to violate — draw.ts merges
  // heads that land on one point by construction).
  const hubBottom = hubTop + hubH;
  const seated: SeatedPill[] = [];
  for (const leaf of leaves) {
    const edge = edgeOf.get(leaf.id)!;
    const lx = centreOf.get(leaf.id)!;
    const r = rankOf.get(leaf.id)!;
    const top = leafTop.get(r)!;
    let points: { x: number; y: number }[];
    if (out) {
      points = simplify([
        { x: 0, y: hubBottom },
        { x: 0, y: busY.get(r)! },
        { x: lx, y: busY.get(r)! },
        { x: lx, y: top },
      ]);
    } else {
      points = simplify([
        { x: lx, y: top + leafH },
        { x: lx, y: busY.get(r)! },
        { x: 0, y: busY.get(r)! },
        { x: 0, y: hubTop },
      ]);
    }
    edge.channel = { points, startSide: 'bottom', endSide: 'top' };
    const pill = pills.get(leaf.id);
    if (pill) {
      // DESIGN 6.5: the pill sits on this edge's longest *exclusive* run —
      // the branch's own vertical leg (arrival for a fan-out, departure for
      // a fan-in); the bus footage is shared trunk where every branch's
      // pill would collide by construction. Centred on the drawn run (the
      // line as shortened for its stub and arrowhead), centre on the path.
      const run = out
        ? { x1: lx, y1: busY.get(r)! + TURN, x2: lx, y2: top - scene.edgeGap }
        : { x1: lx, y1: top + leafH + STANDOFF, x2: lx, y2: busY.get(r)! - TURN };
      seated.push({ edge, pill, cx: lx, cy: (run.y1 + run.y2) / 2, run });
    }
  }
  slidePills(seated);
  for (const s of seated) {
    s.edge.channel!.label = {
      x: s.cx - s.pill.width / 2,
      y: s.cy - s.pill.height / 2,
      width: s.pill.width,
      height: s.pill.height,
      lines: s.pill.lines,
    };
  }

  // Shift everything into positive coordinates (pills included — a pill
  // wider than its leaf can reach past the leftmost box).
  const lefts = [
    ...graph.nodes.map((n) => n.x!),
    ...seated.map((s) => s.cx - s.pill.width / 2),
  ];
  const rights = [
    ...graph.nodes.map((n) => n.x! + n.width!),
    ...seated.map((s) => s.cx + s.pill.width / 2),
  ];
  const shift = -Math.min(...lefts);
  for (const node of graph.nodes) node.x! += shift;
  for (const edge of graph.edges) {
    for (const p of edge.channel!.points) p.x += shift;
    if (edge.channel!.label) edge.channel!.label.x += shift;
  }
  graph.engine = 'channels';
  return { width: Math.max(...rights) - Math.min(...lefts), height: totalH, warnings };
}

// ---------------------------------------------------------------------------
// Chains — DESIGN 1.9's reading-order ribbon.
// ---------------------------------------------------------------------------

function layoutChain(
  graph: Graph,
  plan: Extract<ChannelPlan, { kind: 'chain' }>,
  scene: Scene,
  measureLine: (s: string) => number,
): ChannelLayout {
  const warnings: string[] = [];
  const order = plan.order;
  const n = order.length;
  const boxW = Math.max(...order.map((node) => node.width!));
  const boxH = Math.max(...order.map((node) => node.height!));
  // Every box takes the chart's shared size (DESIGN 2.2/2.3) so rows and
  // columns line up exactly.
  for (const node of order) {
    node.width = boxW;
    node.height = boxH;
  }

  const edgeAfter = new Map<string, GraphEdge>(); // keyed by source node id
  for (const edge of graph.edges) edgeAfter.set(edge.from, edge);
  const pills = new Map<string, Pill>();
  for (const edge of graph.edges) {
    const pill = wrapPill(edge, scene, measureLine, warnings);
    if (pill) pills.set(edge.id, pill);
  }
  const maxPillW = Math.max(0, ...[...pills.values()].map((p) => p.width));
  const maxPillH = Math.max(0, ...[...pills.values()].map((p) => p.height));

  // DERIVE (DESIGN 2.7): the corridor between columns holds the forward
  // edge's drawn run and the pill riding it (8 clear of each box, DESIGN
  // 6.9); 48 is the floor a gap crossed by an edge needs anyway (the drawn
  // line, shortened for its stub and arrowhead, must stay a run and not a
  // stub — the same rank spacing the old path uses).
  const gapX = roundUp(Math.max(48, maxPillW + PILL_NODE_CLEAR * 2), GRID);
  const pitch = boxW + gapX;
  // The band between rows hosts the return's horizontal run, centred, with
  // DESIGN 6.8's 16 of clearance from each row — more when a return pill
  // rides it (8 more per side, DESIGN 6.9), or when the turn legs need it.
  const bandH = roundUp(
    Math.max(2 * (STANDOFF + TURN * 2), maxPillH + 2 * (PILL_NODE_CLEAR + PILL_NODE_CLEAR)),
    GRID,
  );
  /** DESIGN 6.7's clearance for the gutters the return rides. */
  const gutterW = CLEARANCE.loop; // 24

  // Columns = what the declared display fits at full pitch — a chain never
  // wraps earlier than the width forces (DESIGN 1.9). The gutters only
  // exist once the ribbon wraps, so the fit re-derives with them reserved.
  const content = scene.canvas.width - scene.canvas.margin * 2;
  let cols = Math.max(1, Math.floor((content + gapX) / pitch));
  let rowsCount = Math.ceil(n / cols);
  for (let round = 0; round < 3 && rowsCount > 1; round++) {
    const nextCols = Math.max(1, Math.floor((content - 2 * gutterW + gapX) / pitch));
    const nextRows = Math.ceil(n / nextCols);
    if (nextCols === cols && nextRows === rowsCount) break;
    cols = nextCols;
    rowsCount = nextRows;
  }

  const seated: SeatedPill[] = [];
  const seatForwardPill = (
    edge: GraphEdge,
    run: { x1: number; y1: number; x2: number; y2: number },
  ) => {
    const pill = pills.get(edge.id);
    if (!pill) return;
    seated.push({
      edge,
      pill,
      cx: (run.x1 + run.x2) / 2,
      cy: (run.y1 + run.y2) / 2,
      run,
    });
  };

  let width: number;
  let height: number;

  if (cols === 1) {
    // DESIGN 1.9: on a display that fits only one column the ribbon
    // degenerates to a vertical list — no returns exist, edges run straight
    // down. The row gap is the corridor: the drawn run plus a pill and its
    // clearances when one rides it.
    const gapY = roundUp(
      Math.max(48, STANDOFF + PILL_NODE_CLEAR + maxPillH + PILL_NODE_CLEAR + scene.edgeGap + 4),
      GRID,
    );
    order.forEach((node, i) => {
      node.x = 0;
      node.y = i * (boxH + gapY);
    });
    for (let i = 0; i + 1 < n; i++) {
      const edge = edgeAfter.get(order[i]!.id)!;
      const yTop = order[i]!.y! + boxH;
      const yBot = order[i + 1]!.y!;
      edge.channel = {
        points: [
          { x: boxW / 2, y: yTop },
          { x: boxW / 2, y: yBot },
        ],
        startSide: 'bottom',
        endSide: 'top',
      };
      seatForwardPill(edge, {
        x1: boxW / 2,
        y1: yTop + STANDOFF,
        x2: boxW / 2,
        y2: yBot - scene.edgeGap,
      });
    }
    width = boxW;
    height = order[n - 1]!.y! + boxH;
  } else {
    // FLOOR PLAN: even row fill (base + remainder to the earlier rows) so a
    // remainder never strands a lone inner node in its own column (DESIGN
    // 1.2's balance); rows read left-to-right, always, all left-aligned so
    // the return's left gutter serves every row the same way.
    const base = Math.floor(n / rowsCount);
    const counts = Array.from({ length: rowsCount }, (_, r) => base + (r < n % rowsCount ? 1 : 0));
    const rowOf = new Map<string, number>();
    const colOf = new Map<string, number>();
    {
      let taken = 0;
      counts.forEach((count, r) => {
        for (let c = 0; c < count; c++) {
          const node = order[taken + c]!;
          rowOf.set(node.id, r);
          colOf.set(node.id, c);
        }
        taken += count;
      });
    }
    const rowLeft = rowsCount > 1 ? gutterW : 0; // room for the left gutter
    const rowTop = (r: number) => r * (boxH + bandH);
    for (const node of order) {
      node.x = rowLeft + colOf.get(node.id)! * pitch;
      node.y = rowTop(rowOf.get(node.id)!);
    }
    const maxRowRight = rowLeft + Math.max(...counts.map((c) => c * pitch - gapX));
    const rightGutterX = maxRowRight + gutterW;
    const leftGutterX = rowLeft - gutterW; // = 0

    for (let i = 0; i + 1 < n; i++) {
      const a = order[i]!;
      const b = order[i + 1]!;
      const edge = edgeAfter.get(a.id)!;
      const ra = rowOf.get(a.id)!;
      const rb = rowOf.get(b.id)!;
      const cyA = a.y! + boxH / 2;
      const cyB = b.y! + boxH / 2;
      if (ra === rb) {
        // Forward, in-row: one straight run, left to right.
        const x1 = a.x! + boxW;
        const x2 = b.x!;
        edge.channel = {
          points: [
            { x: x1, y: cyA },
            { x: x2, y: cyB },
          ],
          startSide: 'right',
          endSide: 'left',
        };
        seatForwardPill(edge, {
          x1: x1 + STANDOFF,
          y1: cyA,
          x2: x2 - scene.edgeGap,
          y2: cyB,
        });
      } else {
        // DESIGN 1.9's return: out the right gutter, along the reserved
        // band between the rows, down the left gutter, into the next row's
        // first node's left face — four rounded turns, crossing nothing,
        // drawn the same on every chart.
        const bandY = rowTop(ra) + boxH + bandH / 2;
        edge.channel = {
          points: [
            { x: a.x! + boxW, y: cyA },
            { x: rightGutterX, y: cyA },
            { x: rightGutterX, y: bandY },
            { x: leftGutterX, y: bandY },
            { x: leftGutterX, y: cyB },
            { x: b.x!, y: cyB },
          ],
          startSide: 'right',
          endSide: 'left',
          isReturn: true,
        };
        // Its longest exclusive run is the band run itself — the pill
        // belongs there (DESIGN 6.5), centred between the gutters.
        seatForwardPill(edge, {
          x1: leftGutterX + TURN,
          y1: bandY,
          x2: rightGutterX - TURN,
          y2: bandY,
        });
      }
    }
    width = rowsCount > 1 ? rightGutterX + 0 : maxRowRight;
    height = rowTop(rowsCount - 1) + boxH;
  }

  slidePills(seated);
  for (const s of seated) {
    s.edge.channel!.label = {
      x: s.cx - s.pill.width / 2,
      y: s.cy - s.pill.height / 2,
      width: s.pill.width,
      height: s.pill.height,
      lines: s.pill.lines,
    };
  }
  graph.engine = 'channels';
  return { width, height, warnings };
}

/** Lay out a detected channel chart. Node sizes must already be set by the
 *  ordinary sizing pass — this only decides positions and routes, exactly
 *  like `layoutRing`. */
export function layoutChannels(
  graph: Graph,
  plan: ChannelPlan,
  scene: Scene,
  measureLine: (s: string) => number,
): ChannelLayout {
  return plan.kind === 'chain'
    ? layoutChain(graph, plan, scene, measureLine)
    : layoutFan(graph, plan, scene, measureLine);
}
