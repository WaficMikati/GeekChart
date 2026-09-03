/**
 * Channel-engine prototype for the fan family (fan-out, fan-in, diamond fan).
 *
 * The structure this prototype exists to demonstrate, in render order:
 *
 *   1. FLOOR PLAN     rows of nodes AND the bands between them are first-class
 *                     grid members. Nothing is placed until the bands exist.
 *   2. ROUTE PLANS    every edge is a symbolic plan over grid indices — which
 *                     band it rides, which corridor it drops through, which
 *                     face it leaves and arrives at. No coordinates yet.
 *   3. DERIVE         band heights and column pitch are derived from the
 *                     traffic the plans put in them and from the measured
 *                     labels that must live in them, re-derived to a fixed
 *                     point. Never post-hoc repair.
 *   4. REALIZE        coordinates come last: indices -> px, plans -> paths,
 *                     each label pill centred on its own edge's straight run.
 *   5. EMIT           static SVG in the library's exact visual language.
 *
 * Visual constants are measured off the current pipeline's own output
 * (fanout-3-old.html and friends), so the comparison is fair.
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeNodeMeasurer } from '/home/siku/code/4geeks/animated-chart-creator/packages/core/src/node/measure.ts';

// ---------------------------------------------------------------------------
// Design constants — every one measured from the current pipeline's SVG.
// ---------------------------------------------------------------------------

const D = {
  bg: '#17202A',
  ink: '#FFFFFF',
  quiet: '#8794A3',
  path: '#0084FF',
  edge: '#6B7889',

  margin: 48,
  boxW: 120,
  boxH: 48,
  boxRadius: 6,
  diamondW: 128,
  diamondH: 72,
  colGap: 24, // gap between sibling boxes; also the corridor width

  strokeW: 1.5,
  turnR: 12, // corner radius of an edge turn (Q control at the corner)
  standoff: 4, // an edge starts this far past its departure face
  arrowLen: 7.5, // the line stops here; the arrowhead covers the rest
  arrowHalfW: 5,
  arrowNotch: 1.35,

  titleFont: "'Archivo', 'Lato', ui-sans-serif, system-ui, sans-serif",
  titleSize: 13,
  titleBaseline: 4, // baseline offset below box centre

  pillFont: "'JetBrains Mono', ui-monospace, Menlo, monospace",
  pillSize: 11,
  pillTracking: '0.12em',
  pillH: 22,
  pillPadX: 6,
  pillRx: 3,
  pillBaseline: 14.96, // text baseline below pill top
  pillClear: 4, // air between a pill and anything else

  portPitch: 16, // multiple attachments on one face spread at this pitch
  minRun: 8, // shortest straight run allowed before an arrowhead
  displayWidth: 1000, // the canvas never exceeds this
} as const;

// ---------------------------------------------------------------------------
// Text measurement — the repo's own fontkit measurer, same fonts, honest px.
// ---------------------------------------------------------------------------

const measurer = makeNodeMeasurer();

/** Pill width for an edge label: uppercase mono + tracking, plus padding. */
const pillWidth = (label: string): number =>
  measurer.measure(label.toUpperCase(), D.pillFont, D.pillSize, D.pillTracking) + D.pillPadX * 2;

// ---------------------------------------------------------------------------
// Chart specs
// ---------------------------------------------------------------------------

type Shape = 'rect' | 'diamond';
type NodeSpec = { id: string; label: string; shape: Shape };
type EdgeSpec = { from: string; to: string; label: string };

/**
 * Every chart in the fan family is one hub and one set of leaves; `direction`
 * says whether the hub feeds the leaves (fan-out) or the leaves feed the hub
 * (fan-in). The diamond fan is a fan-out whose hub is a diamond.
 */
type ChartSpec = {
  name: string;
  hub: NodeSpec;
  leaves: NodeSpec[];
  edges: EdgeSpec[];
  direction: 'out' | 'in';
};

const fanoutSpec = (n: number): ChartSpec => ({
  name: `fanout-${n}`,
  hub: { id: 'D', label: 'Dispatcher', shape: 'rect' },
  leaves: Array.from({ length: n }, (_, i) => ({
    id: `H${i + 1}`,
    label: `Handler ${i + 1}`,
    shape: 'rect' as const,
  })),
  edges: Array.from({ length: n }, (_, i) => ({
    from: 'D',
    to: `H${i + 1}`,
    label: `route ${i + 1}`,
  })),
  direction: 'out',
});

const faninSpec = (n: number): ChartSpec => ({
  name: `fanin-${n}`,
  hub: { id: 'A', label: 'Aggregator', shape: 'rect' },
  leaves: Array.from({ length: n }, (_, i) => ({
    id: `P${i + 1}`,
    label: `Producer ${i + 1}`,
    shape: 'rect' as const,
  })),
  edges: Array.from({ length: n }, (_, i) => ({
    from: `P${i + 1}`,
    to: 'A',
    label: 'emits',
  })),
  direction: 'in',
});

const diamondSpec = (): ChartSpec => ({
  name: 'diamond-fan',
  hub: { id: 'R', label: 'Ready?', shape: 'diamond' },
  leaves: [
    { id: 'A', label: 'Deploy', shape: 'rect' },
    { id: 'B', label: 'Wait', shape: 'rect' },
    { id: 'C', label: 'Abort', shape: 'rect' },
  ],
  edges: [
    { from: 'R', to: 'A', label: 'yes' },
    { from: 'R', to: 'B', label: 'no' },
    { from: 'R', to: 'C', label: 'never' },
  ],
  direction: 'out',
});

// ---------------------------------------------------------------------------
// 1. FLOOR PLAN — rows and the bands between them, as grid members.
//
// Leaf rows wrap when a single row would push the canvas past the display
// width. Every row is centred as a group on the canvas's centre axis, and the
// hub sits on that same axis — so "parent centred over the children's extent"
// holds by construction, not by adjustment. The row nearest the hub keeps an
// even count so the centre corridor (the gap between its two middle boxes)
// stays free for the spine that feeds the far row.
// ---------------------------------------------------------------------------

type LeafRow = {
  /** distance from the hub: 0 is adjacent, 1 is the wrapped row beyond it */
  rank: number;
  leaves: NodeSpec[];
};

const planLeafRows = (leaves: NodeSpec[], maxPerRow: number): LeafRow[] => {
  const rowCount = Math.ceil(leaves.length / maxPerRow);
  const base = Math.floor(leaves.length / rowCount);
  const counts = Array.from({ length: rowCount }, (_, i) => base + (i < leaves.length % rowCount ? 1 : 0));

  // The near row must be even when a spine has to pass through its centre
  // corridor; shift one leaf from the far row if needed (5+5 becomes 6+4).
  if (rowCount > 1 && counts[0]! % 2 === 1 && counts[0]! < maxPerRow) {
    counts[0]! += 1;
    counts[counts.length - 1]! -= 1;
  }

  const rows: LeafRow[] = [];
  let taken = 0;
  counts.forEach((count, rank) => {
    rows.push({ rank, leaves: leaves.slice(taken, taken + count) });
    taken += count;
  });
  return rows;
};

// ---------------------------------------------------------------------------
// 2. ROUTE PLANS — symbolic, over grid indices and faces only.
//
// A fan shares a bus per band (the library's decided look, DESIGN 6.12/6.13):
// the hub's single trunk drops into band 0's bus; leaves in the near row
// branch off it; a wrapped far row is fed by a spine that continues from the
// bus straight down the near row's centre corridor into the next band's bus.
// A fan-in is the same picture upside down, and its arrivals at the hub face
// MERGE to one shared arrival point — one arrowhead, by construction.
// ---------------------------------------------------------------------------

type RoutePlan = {
  edge: EdgeSpec;
  /** which leaf row the leaf sits in */
  leafRank: number;
  /** buses this route rides, as band ranks (band k separates rank k-1 from rank k) */
  busBands: number[];
  /** corridors the spine drops through: the centre gap of each nearer row */
  corridors: number[];
  /** fan-in routes at the hub share one arrival — the key groups them */
  mergeKey: string | undefined;
};

const planRoutes = (spec: ChartSpec, rows: LeafRow[]): RoutePlan[] => {
  const rankOf = new Map<string, number>();
  for (const row of rows) for (const leaf of row.leaves) rankOf.set(leaf.id, row.rank);

  return spec.edges.map((edge) => {
    const leafId = spec.direction === 'out' ? edge.to : edge.from;
    const rank = rankOf.get(leafId) ?? 0;
    return {
      edge,
      leafRank: rank,
      // A leaf at rank r rides every bus from band 0 up to its own band.
      busBands: Array.from({ length: rank + 1 }, (_, i) => i),
      // ...crossing the centre corridor of every row nearer than it.
      corridors: Array.from({ length: rank }, (_, i) => i),
      mergeKey: spec.direction === 'in' ? `arrive:${spec.hub.id}:top` : undefined,
    };
  });
};

// ---------------------------------------------------------------------------
// 3. DERIVE — channel sizes from traffic and measured labels, to a fixed point.
//
// A band's height is what must live in it, summed:
//   above its bus: the departure standoff, a label pill if departures carry
//     labels there (fan-in), and the turn onto the bus;
//   below its bus: the turn off the bus, a label pill if arrivals carry
//     labels there (fan-out), the arrowhead — or, for a merged arrival, just
//     the minimum straight run the single arrowhead needs.
// Column pitch is derived too: wide pills push siblings apart.
// Row gaps are uniform per chart: every band takes the tallest band's need.
// ---------------------------------------------------------------------------

type BandNeed = { aboveBus: number; belowBus: number };

type Derived = {
  pitch: number;
  maxPerRow: number;
  bands: BandNeed[]; // one per band, index = band rank
  bandH: number; // uniform row gap = max over bands
};

const deriveChannels = (spec: ChartSpec): { derived: Derived; rows: LeafRow[]; plans: RoutePlan[]; surprises: string[] } => {
  const surprises: string[] = [];
  const pillHeights = spec.edges.map(() => D.pillH);
  const pillWidths = spec.edges.map((e) => pillWidth(e.label));
  const labelSpace = D.pillClear + Math.max(...pillHeights) + D.pillClear;

  // Column pitch: siblings sit a box plus a gap apart, unless the pills that
  // stand between them at one shared height need more air than that.
  let pitch = D.boxW + D.colGap;
  const pillPitch = Math.max(...pillWidths) + D.pillClear * 2;
  if (pillPitch > pitch) {
    surprises.push(`column pitch widened ${pitch} -> ${pillPitch} by pill width`);
    pitch = pillPitch;
  }

  // The display width bounds how many siblings a row can hold; wrap past it.
  const content = D.displayWidth - D.margin * 2;
  const maxPerRow = Math.max(1, Math.floor((content + (pitch - D.boxW)) / pitch));

  // The even-near-row rule can unbalance the wrap (5+5 becomes 6+4): the
  // spine needs the centre corridor free, and a centred odd row owns it.
  {
    const rowCount = Math.ceil(spec.leaves.length / maxPerRow);
    const near = Math.floor(spec.leaves.length / rowCount) + (spec.leaves.length % rowCount > 0 ? 1 : 0);
    if (rowCount > 1 && near % 2 === 1 && near < maxPerRow)
      surprises.push('wrap unbalanced to keep the near row even — the spine needs the centre corridor free');
  }

  // Re-derive to a fixed point: rows depend on maxPerRow, plans on rows,
  // band needs on plans. Nothing here feeds back into pitch or maxPerRow, so
  // one pass converges — the loop proves it rather than assuming it.
  let rows = planLeafRows(spec.leaves, maxPerRow);
  let plans = planRoutes(spec, rows);
  let bands: BandNeed[] = [];
  for (let round = 0; round < 4; round += 1) {
    const bandCount = rows.length;
    const next: BandNeed[] = Array.from({ length: bandCount }, () => ({ aboveBus: 0, belowBus: 0 }));

    for (const plan of plans) {
      for (const band of plan.busBands) {
        const need = next[band]!;
        if (spec.direction === 'out') {
          // Above the bus: the hub standoff plus a drop long enough for the
          // turn to keep its full radius (a turn's arc takes turnR of each
          // leg, and the drop is one leg of two corners' worth).
          need.aboveBus = Math.max(need.aboveBus, D.standoff + D.turnR * 2, D.turnR + D.pillClear);
          // Below: only the leaf's own band hosts its arrival + pill.
          if (band === plan.leafRank)
            need.belowBus = Math.max(need.belowBus, D.turnR + labelSpace + D.arrowLen);
          else need.belowBus = Math.max(need.belowBus, D.turnR + D.pillClear);
        } else {
          // Fan-in: departures drop through their pill into the bus...
          if (band === plan.leafRank)
            need.aboveBus = Math.max(need.aboveBus, D.standoff + labelSpace + D.turnR);
          else need.aboveBus = Math.max(need.aboveBus, D.turnR + D.pillClear);
          // ...and only band 0 carries the merged run down to the hub.
          if (band === 0) need.belowBus = Math.max(need.belowBus, D.turnR + D.minRun + D.arrowLen);
          else need.belowBus = Math.max(need.belowBus, D.turnR + D.pillClear);
        }
      }
    }

    const stable =
      bands.length === next.length &&
      bands.every((b, i) => b.aboveBus === next[i]!.aboveBus && b.belowBus === next[i]!.belowBus);
    bands = next;
    if (stable) break;
    rows = planLeafRows(spec.leaves, maxPerRow);
    plans = planRoutes(spec, rows);
  }

  const bandH = Math.max(...bands.map((b) => b.aboveBus + b.belowBus));
  const slack = bands.map((b) => bandH - (b.aboveBus + b.belowBus)).filter((s) => s > 0);
  if (slack.length > 0)
    surprises.push(
      `uniform row gap leaves ${slack.join('/')}px slack in ${slack.length} band(s) — the price of DESIGN's uniform gaps`,
    );

  return { derived: { pitch, maxPerRow, bands, bandH }, rows, plans, surprises };
};

// ---------------------------------------------------------------------------
// 4. REALIZE — coordinates at the very end.
//
// x runs on a centre axis (0 = canvas centre); rows stack top to bottom.
// Fan-out: hub row, then band 0, leaf row 0, band 1, leaf row 1 ...
// Fan-in: farthest leaf row first, bands between, hub row last.
// ---------------------------------------------------------------------------

type Point = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };

type PlacedNode = { spec: NodeSpec; box: Box; cx: number; cy: number };
type Pill = { edge: EdgeSpec; box: Box; text: string };
type RealizedEdge = { edge: EdgeSpec; points: Point[]; arrow: Point | undefined };

type Realized = {
  width: number;
  height: number;
  nodes: PlacedNode[];
  edges: RealizedEdge[];
  pills: Pill[];
  rowGap: number;
};

/** Ports on one face spread at a fixed pitch around the face centre. In the
 *  fan family every face ends up with exactly one attachment (the bus and the
 *  merge see to that), so the spread never fans out here — but the rule lives
 *  where the real engine will need it. */
const spreadPorts = (centre: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => centre + (i - (count - 1) / 2) * D.portPitch);

const nodeSize = (spec: NodeSpec): { w: number; h: number } =>
  spec.shape === 'diamond' ? { w: D.diamondW, h: D.diamondH } : { w: D.boxW, h: D.boxH };

/** Drop collinear and duplicate points so straight-through junctions read as
 *  one line. */
const simplify = (points: Point[]): Point[] => {
  const kept: Point[] = [];
  for (const p of points) {
    const last = kept[kept.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    const prev = kept[kept.length - 2];
    if (
      last &&
      prev &&
      ((Math.abs(prev.x - last.x) < 0.01 && Math.abs(last.x - p.x) < 0.01) ||
        (Math.abs(prev.y - last.y) < 0.01 && Math.abs(last.y - p.y) < 0.01))
    )
      kept.pop();
    kept.push(p);
  }
  return kept;
};

const realize = (spec: ChartSpec, rows: LeafRow[], plans: RoutePlan[], derived: Derived): Realized => {
  const { pitch, bandH, bands } = derived;
  const hubSize = nodeSize(spec.hub);

  // --- vertical stacking: y of each leaf row's top and each band's bus -----
  const leafTop = new Map<number, number>(); // rank -> row top y
  const busY = new Map<number, number>(); // band rank -> bus line y
  let hubTop: number;

  if (spec.direction === 'out') {
    hubTop = 0;
    let y = hubSize.h;
    for (const row of rows) {
      busY.set(row.rank, y + bands[row.rank]!.aboveBus + (bandH - (bands[row.rank]!.aboveBus + bands[row.rank]!.belowBus)));
      // slack (if any) goes above the bus so arrivals keep their exact room
      y += bandH;
      leafTop.set(row.rank, y);
      y += D.boxH;
    }
  } else {
    // top to bottom: far rows first, hub last
    let y = 0;
    for (const row of [...rows].reverse()) {
      leafTop.set(row.rank, y);
      y += D.boxH;
      // band below this row is band `rank`
      busY.set(row.rank, y + bands[row.rank]!.aboveBus);
      y += bandH;
    }
    hubTop = y;
  }

  const totalH = spec.direction === 'out' ? (leafTop.get(rows[rows.length - 1]!.rank) ?? 0) + D.boxH : hubTop + hubSize.h;

  // --- horizontal seating: every row centred as a group on x = 0 -----------
  const nodes: PlacedNode[] = [];
  const centreOf = new Map<string, number>();
  for (const row of rows) {
    row.leaves.forEach((leaf, i) => {
      const cx = (i - (row.leaves.length - 1) / 2) * pitch;
      centreOf.set(leaf.id, cx);
      const top = leafTop.get(row.rank)!;
      nodes.push({ spec: leaf, cx, cy: top + D.boxH / 2, box: { x: cx - D.boxW / 2, y: top, w: D.boxW, h: D.boxH } });
    });
  }
  // The hub is centred on the same axis — centred over the whole leaf extent
  // by construction, since every row is centred as a group.
  nodes.push({
    spec: spec.hub,
    cx: 0,
    cy: hubTop + hubSize.h / 2,
    box: { x: -hubSize.w / 2, y: hubTop, w: hubSize.w, h: hubSize.h },
  });

  // --- faces and ports -----------------------------------------------------
  // Hub departure/arrival: one attachment (trunk out, or merged arrival in),
  // so the spread collapses to the face centre. The diamond departs from its
  // bottom vertex, which is that centre.
  const [hubPortX] = spreadPorts(0, 1);
  const hubBottom = hubTop + hubSize.h;

  // --- edges: plans -> polylines ------------------------------------------
  const edges: RealizedEdge[] = [];
  const pills: Pill[] = [];
  const arrowsPlaced = new Set<string>();

  for (const plan of plans) {
    const leafId = spec.direction === 'out' ? plan.edge.to : plan.edge.from;
    const lx = centreOf.get(leafId)!;
    const leafRowTop = leafTop.get(plan.leafRank)!;

    const points: Point[] = [];
    if (spec.direction === 'out') {
      // hub bottom -> down through each bus -> branch on the leaf's bus ->
      // down to the leaf's top face. Corridor crossings are the straight
      // vertical between one bus and the next (x = 0, the centre corridor).
      points.push({ x: hubPortX!, y: hubBottom + D.standoff });
      for (const band of plan.busBands) {
        const by = busY.get(band)!;
        if (band < plan.leafRank) points.push({ x: 0, y: by }); // ride through the junction
        else {
          points.push({ x: 0, y: by });
          points.push({ x: lx, y: by });
        }
      }
      const arriveY = leafRowTop; // arrow tip on the face
      points.push({ x: lx, y: arriveY - D.arrowLen });
      const line = simplify(points);
      edges.push({ edge: plan.edge, points: line, arrow: { x: lx, y: arriveY } });

      // Label pill: centred on this edge's own arrival run — the straight
      // vertical between its bus turn and its arrowhead. The line is masked
      // by the pill's canvas-coloured plate.
      const runTop = busY.get(plan.leafRank)! + D.turnR;
      const runBottom = arriveY - D.arrowLen;
      pills.push({
        edge: plan.edge,
        text: plan.edge.label,
        box: {
          x: lx - pillWidth(plan.edge.label) / 2,
          y: (runTop + runBottom) / 2 - D.pillH / 2,
          w: pillWidth(plan.edge.label),
          h: D.pillH,
        },
      });
    } else {
      // leaf bottom -> down through its pill into its bus -> along the bus
      // to the spine/merge axis -> straight down to the hub's top face.
      // Every route ends on the same shared arrival: one arrowhead total.
      points.push({ x: lx, y: leafRowTop + D.boxH + D.standoff });
      let curX = lx;
      for (const band of [...plan.busBands].reverse()) {
        const by = busY.get(band)!;
        if (band === plan.leafRank) {
          // the leaf's own bus: drop onto it, then ride to the spine axis
          points.push({ x: curX, y: by });
          points.push({ x: 0, y: by });
          curX = 0;
        } else {
          // already on the spine: straight through this bus's junction
          points.push({ x: curX, y: by });
        }
      }
      const arriveY = hubTop;
      points.push({ x: 0, y: arriveY - D.arrowLen });
      const line = simplify(points);
      const first = !arrowsPlaced.has(plan.mergeKey!);
      arrowsPlaced.add(plan.mergeKey!);
      edges.push({ edge: plan.edge, points: line, arrow: first ? { x: 0, y: arriveY } : undefined });

      // Label pill: centred on this edge's own departure run — the straight
      // vertical between its leaf's bottom face and its bus turn.
      const runTop = leafRowTop + D.boxH + D.standoff;
      const runBottom = busY.get(plan.leafRank)! - D.turnR;
      pills.push({
        edge: plan.edge,
        text: plan.edge.label,
        box: {
          x: lx - pillWidth(plan.edge.label) / 2,
          y: (runTop + runBottom) / 2 - D.pillH / 2,
          w: pillWidth(plan.edge.label),
          h: D.pillH,
        },
      });
    }
  }

  // --- canvas --------------------------------------------------------------
  const minX = Math.min(...nodes.map((n) => n.box.x));
  const maxX = Math.max(...nodes.map((n) => n.box.x + n.box.w));
  const width = Math.ceil(maxX - minX + D.margin * 2);
  const height = Math.ceil(totalH + D.margin * 2);
  const shiftX = D.margin - minX;
  const shiftY = D.margin;

  const shiftBox = (b: Box): Box => ({ x: b.x + shiftX, y: b.y + shiftY, w: b.w, h: b.h });
  const shiftPoint = (p: Point): Point => ({ x: p.x + shiftX, y: p.y + shiftY });

  return {
    width,
    height,
    rowGap: bandH,
    nodes: nodes.map((n) => ({ ...n, cx: n.cx + shiftX, cy: n.cy + shiftY, box: shiftBox(n.box) })),
    edges: edges.map((e) => ({
      edge: e.edge,
      points: e.points.map(shiftPoint),
      arrow: e.arrow ? shiftPoint(e.arrow) : undefined,
    })),
    pills: pills.map((p) => ({ ...p, box: shiftBox(p.box) })),
  };
};

// ---------------------------------------------------------------------------
// 5. EMIT — static SVG, the library's exact visual language.
// ---------------------------------------------------------------------------

const fmt = (n: number): string => {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
};

/** Polyline -> path with the library's rounded turns: each interior corner
 *  becomes a quadratic whose control point is the corner itself, radius 12
 *  clamped by the shorter leg. */
const pathOf = (points: Point[]): string => {
  if (points.length < 2) return '';
  let d = `M${fmt(points[0]!.x)},${fmt(points[0]!.y)}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1]!;
    const v = points[i]!;
    const next = points[i + 1]!;
    const inLen = Math.hypot(v.x - prev.x, v.y - prev.y);
    const outLen = Math.hypot(next.x - v.x, next.y - v.y);
    const r = Math.min(D.turnR, inLen / 2, outLen / 2);
    const inDir = { x: (v.x - prev.x) / inLen, y: (v.y - prev.y) / inLen };
    const outDir = { x: (next.x - v.x) / outLen, y: (next.y - v.y) / outLen };
    const arrive = { x: v.x - inDir.x * r, y: v.y - inDir.y * r };
    const leave = { x: v.x + outDir.x * r, y: v.y + outDir.y * r };
    d += `L${fmt(arrive.x)},${fmt(arrive.y)}Q${fmt(v.x)},${fmt(v.y)} ${fmt(leave.x)},${fmt(leave.y)}`;
  }
  const last = points[points.length - 1]!;
  d += `L${fmt(last.x)},${fmt(last.y)}`;
  return d;
};

const nodePath = (n: PlacedNode): string => {
  const { x, y, w, h } = n.box;
  if (n.spec.shape === 'diamond')
    return `M${fmt(x + w / 2)},${fmt(y)} L${fmt(x + w)},${fmt(y + h / 2)} L${fmt(x + w / 2)},${fmt(y + h)} L${fmt(x)},${fmt(y + h / 2)} Z`;
  const r = D.boxRadius;
  return (
    `M${fmt(x + r)},${fmt(y)} H${fmt(x + w - r)} A${r},${r} 0 0,1 ${fmt(x + w)},${fmt(y + r)} ` +
    `V${fmt(y + h - r)} A${r},${r} 0 0,1 ${fmt(x + w - r)},${fmt(y + h)} H${fmt(x + r)} ` +
    `A${r},${r} 0 0,1 ${fmt(x)},${fmt(y + h - r)} V${fmt(y + r)} A${r},${r} 0 0,1 ${fmt(x + r)},${fmt(y)} Z`
  );
};

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const emit = (spec: ChartSpec, real: Realized): string => {
  // The primary path (blue) is the hub plus the first edge's partner — the
  // same role assignment the current pipeline makes.
  const first = spec.edges[0]!;
  const pathIds = new Set([spec.hub.id, spec.direction === 'out' ? first.to : first.from]);

  const parts: string[] = [];
  parts.push(
    `<svg class="gc-chart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${real.width} ${real.height}" ` +
      `width="${real.width}" height="${real.height}" font-family="${D.titleFont.replace(/"/g, '&quot;')}">`,
  );
  parts.push(`<rect class="gc-canvas" x="0" y="0" width="${real.width}" height="${real.height}" fill="${D.bg}"/>`);

  // edges under nodes and pills
  for (const e of real.edges) {
    parts.push(
      `<path class="gc-edge" data-from="${e.edge.from}" data-to="${e.edge.to}" d="${pathOf(e.points)}" ` +
        `fill="none" stroke="${D.edge}" stroke-width="${D.strokeW}" stroke-linecap="round"/>`,
    );
  }

  // label pills: a canvas-coloured plate masks the line, text centred on it
  for (const p of real.pills) {
    const { x, y, w, h } = p.box;
    parts.push(
      `<g class="gc-edge-label" data-from="${p.edge.from}" data-to="${p.edge.to}">` +
        `<rect class="gc-plate" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="${D.pillRx}" fill="${D.bg}"/>` +
        `<text x="${fmt(x + w / 2)}" y="${fmt(y + D.pillBaseline)}" fill="${D.quiet}" ` +
        `font-family="${D.pillFont.replace(/"/g, '&quot;')}" font-size="${D.pillSize}" letter-spacing="${D.pillTracking}" ` +
        `text-anchor="middle">${escape(p.text.toUpperCase())}</text></g>`,
    );
  }

  // arrowheads (down-pointing throughout the fan family)
  for (const e of real.edges) {
    if (!e.arrow) continue;
    const { x, y } = e.arrow;
    parts.push(
      `<path class="gc-arrow" data-to="${e.edge.to}" d="M${fmt(x - D.arrowHalfW)},${fmt(y - D.arrowLen)} ` +
        `L${fmt(x)},${fmt(y)} L${fmt(x + D.arrowHalfW)},${fmt(y - D.arrowLen)} L${fmt(x)},${fmt(y - D.arrowNotch - 4.8)} Z" ` +
        `fill="${D.edge}"/>`,
    );
  }

  // nodes on top
  for (const n of real.nodes) {
    const hue = pathIds.has(n.spec.id) ? D.path : D.quiet;
    parts.push(
      `<g class="gc-node" data-id="${n.spec.id}">` +
        `<path class="gc-outline" d="${nodePath(n)}" fill="none" stroke="${hue}" stroke-width="${D.strokeW}" ` +
        `stroke-linejoin="round" stroke-linecap="round"/>` +
        `<text class="gc-title" x="${fmt(n.cx)}" y="${fmt(n.cy + D.titleBaseline)}" fill="${D.ink}" ` +
        `font-size="${D.titleSize}" font-weight="600" text-anchor="middle">${escape(n.spec.label)}</text></g>`,
    );
  }

  parts.push('</svg>');
  return parts.join('\n');
};

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

export type ChartResult = {
  name: string;
  svg: string;
  canvas: { width: number; height: number };
  rowGap: number;
  wrap: number[];
  surprises: string[];
};

export const buildChart = (spec: ChartSpec): ChartResult => {
  const { derived, rows, plans, surprises } = deriveChannels(spec);
  const real = realize(spec, rows, plans, derived);
  return {
    name: spec.name,
    svg: emit(spec, real),
    canvas: { width: real.width, height: real.height },
    rowGap: real.rowGap,
    wrap: rows.map((r) => r.leaves.length),
    surprises,
  };
};

export const allSpecs = (): ChartSpec[] => [
  ...[3, 4, 5, 6, 8, 10, 12].map(fanoutSpec),
  ...[3, 4, 6, 8, 10].map(faninSpec),
  diamondSpec(),
];

const main = async (): Promise<void> => {
  const here = dirname(fileURLToPath(import.meta.url));
  const summary: Record<string, unknown> = {};
  for (const spec of allSpecs()) {
    const result = buildChart(spec);
    await writeFile(join(here, `${result.name}-new.svg`), result.svg);
    summary[result.name] = {
      canvas: result.canvas,
      rowGapDerived: result.rowGap,
      leafRows: result.wrap,
      surprises: result.surprises,
    };
    console.log(result.name, `${result.canvas.width}x${result.canvas.height}`, 'gap', result.rowGap, 'rows', result.wrap.join('+'));
  }
  await writeFile(join(here, 'summary.json'), JSON.stringify(summary, null, 2));
};

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
