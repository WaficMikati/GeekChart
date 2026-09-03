/**
 * Machine checks over the channel engine's OWN emitted SVG — parsed back from
 * the files, never trusted from the layout's variables.
 *
 * Per chart:
 *   - label-pill overlaps (pill/pill and pill/node): must be 0
 *   - pill centred on its own edge's path: max centre-to-path distance
 *   - edge-through-box crossings, excluding each edge's own endpoints: must be 0
 *   - arrowheads per arrival face (fan-in hub face must carry exactly 1)
 *   - parent-centre offset vs the children group's geometric centre: 0 to ±1
 *   - row gaps measured between consecutive row extents
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

type Point = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };

// --- a tiny absolute-command path parser (M L H V Q A Z), sampling curves ---
const parsePath = (d: string): Point[] => {
  const points: Point[] = [];
  const tokens = d.match(/[MLHVQAZ]|-?[\d.]+/gi) ?? [];
  let i = 0;
  let cur: Point = { x: 0, y: 0 };
  const num = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    switch (cmd) {
      case 'M':
      case 'L':
        cur = { x: num(), y: num() };
        points.push(cur);
        break;
      case 'H':
        cur = { x: num(), y: cur.y };
        points.push(cur);
        break;
      case 'V':
        cur = { x: cur.x, y: num() };
        points.push(cur);
        break;
      case 'Q': {
        const c = { x: num(), y: num() };
        const to = { x: num(), y: num() };
        for (const t of [0.25, 0.5, 0.75, 1]) {
          const a = 1 - t;
          points.push({
            x: a * a * cur.x + 2 * a * t * c.x + t * t * to.x,
            y: a * a * cur.y + 2 * a * t * c.y + t * t * to.y,
          });
        }
        cur = to;
        break;
      }
      case 'A': {
        i += 5; // rx ry rot large sweep
        cur = { x: num(), y: num() };
        points.push(cur);
        break;
      }
      case 'Z':
        break;
      default:
        throw new Error(`unhandled path token ${cmd} in ${d.slice(0, 40)}`);
    }
  }
  return points;
};

const bboxOf = (points: Point[]): Box => {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Densify a polyline so interior tests cannot step over a thin box. */
const densify = (points: Point[], step: number): Point[] => {
  const out: Point[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k += 1) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  out.push(points[points.length - 1]!);
  return out;
};

const inside = (p: Point, b: Box, eps: number): boolean =>
  p.x > b.x + eps && p.x < b.x + b.w - eps && p.y > b.y + eps && p.y < b.y + b.h - eps;

const distToPolyline = (p: Point, line: Point[]): number => {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i += 1) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
};

// --- extract elements from the emitted SVG ---------------------------------
type Chart = {
  nodes: Map<string, Box>;
  edges: { from: string; to: string; line: Point[] }[];
  pills: { from: string; to: string; box: Box }[];
  arrows: { to: string; tip: Point }[];
};

const parseChart = (svg: string): Chart => {
  const nodes = new Map<string, Box>();
  for (const m of svg.matchAll(/<g class="gc-node" data-id="([^"]+)"><path class="gc-outline" d="([^"]+)"/g))
    nodes.set(m[1]!, bboxOf(parsePath(m[2]!)));

  const edges = [...svg.matchAll(/<path class="gc-edge" data-from="([^"]+)" data-to="([^"]+)" d="([^"]+)"/g)].map(
    (m) => ({ from: m[1]!, to: m[2]!, line: parsePath(m[3]!) }),
  );

  const pills = [...svg.matchAll(
    /<g class="gc-edge-label" data-from="([^"]+)" data-to="([^"]+)"><rect class="gc-plate" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g,
  )].map((m) => ({
    from: m[1]!,
    to: m[2]!,
    box: { x: Number(m[3]), y: Number(m[4]), w: Number(m[5]), h: Number(m[6]) },
  }));

  const arrows = [...svg.matchAll(/<path class="gc-arrow" data-to="([^"]+)" d="([^"]+)"/g)].map((m) => {
    const pts = parsePath(m[2]!);
    // the tip is the deepest point of a down-pointing head
    const tip = pts.reduce((a, b) => (b.y > a.y ? b : a));
    return { to: m[1]!, tip };
  });

  return { nodes, edges, pills, arrows };
};

// --- the checks ------------------------------------------------------------
const CHARTS = [
  ...[3, 4, 5, 6, 8, 10, 12].map((n) => ({ name: `fanout-${n}`, hub: 'D', kind: 'fanout' as const })),
  ...[3, 4, 6, 8, 10].map((n) => ({ name: `fanin-${n}`, hub: 'A', kind: 'fanin' as const })),
  { name: 'diamond-fan', hub: 'R', kind: 'fanout' as const },
];

const lines: string[] = [];
let failures = 0;
const report = (label: string, ok: boolean, detail: string): void => {
  if (!ok) failures += 1;
  lines.push(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${detail}`);
};

for (const { name, hub, kind } of CHARTS) {
  const svg = await readFile(join(here, `${name}-new.svg`), 'utf8');
  const chart = parseChart(svg);
  lines.push(`${name}`);

  // 1. pill overlaps: none against other pills, none against node boxes
  let pillPill = 0;
  for (let a = 0; a < chart.pills.length; a += 1)
    for (let b = a + 1; b < chart.pills.length; b += 1)
      if (overlaps(chart.pills[a]!.box, chart.pills[b]!.box)) pillPill += 1;
  let pillNode = 0;
  for (const pill of chart.pills)
    for (const box of chart.nodes.values()) if (overlaps(pill.box, box)) pillNode += 1;
  report('pill overlaps', pillPill === 0 && pillNode === 0, `pill/pill ${pillPill}, pill/node ${pillNode}`);

  // 2. every pill centred on its own edge's path
  let maxOff = 0;
  for (const pill of chart.pills) {
    const edge = chart.edges.find((e) => e.from === pill.from && e.to === pill.to)!;
    const centre = { x: pill.box.x + pill.box.w / 2, y: pill.box.y + pill.box.h / 2 };
    maxOff = Math.max(maxOff, distToPolyline(centre, edge.line));
  }
  report('pill on own edge', maxOff <= 0.5, `max centre-to-path ${maxOff.toFixed(2)}px`);

  // 3. edge-through-box crossings, excluding each edge's own endpoints
  let crossings = 0;
  for (const edge of chart.edges) {
    const dense = densify(edge.line, 1);
    for (const [id, box] of chart.nodes) {
      if (id === edge.from || id === edge.to) continue;
      if (dense.some((p) => inside(p, box, 0.25))) crossings += 1;
    }
  }
  report('edge-through-box', crossings === 0, `${crossings} crossings`);

  // 4. arrowheads per arrival face
  const arrivalsAt = (id: string): number => {
    const box = chart.nodes.get(id)!;
    return chart.arrows.filter(
      (a) => Math.abs(a.tip.y - box.y) <= 0.75 && a.tip.x >= box.x && a.tip.x <= box.x + box.w,
    ).length;
  };
  if (kind === 'fanin') {
    report('arrowheads on hub face', arrivalsAt(hub) === 1, `${arrivalsAt(hub)} on ${hub}'s top face`);
  } else {
    const leaves = [...chart.nodes.keys()].filter((id) => id !== hub);
    const counts = leaves.map(arrivalsAt);
    report('arrowheads per leaf face', counts.every((c) => c === 1), counts.join(','));
  }

  // 5. parent centred over the children group's extent
  const hubBox = chart.nodes.get(hub)!;
  const children = [...chart.nodes.entries()].filter(([id]) => id !== hub).map(([, b]) => b);
  const left = Math.min(...children.map((b) => b.x));
  const right = Math.max(...children.map((b) => b.x + b.w));
  const offset = hubBox.x + hubBox.w / 2 - (left + right) / 2;
  report('parent-centre offset', Math.abs(offset) <= 1, `${offset.toFixed(2)}px`);

  // 6. row gaps, measured between consecutive row extents
  const tops = [...new Set([...chart.nodes.values()].map((b) => b.y))].sort((a, b) => a - b);
  const rows = tops.map((top) => {
    const members = [...chart.nodes.values()].filter((b) => b.y === top);
    return { top, bottom: Math.max(...members.map((b) => b.y + b.h)) };
  });
  const gaps = rows.slice(1).map((row, i) => row.top - rows[i]!.bottom);
  lines.push(`        row gaps measured: ${gaps.map((g) => g.toFixed(1)).join(', ')}px`);
}

lines.push('');
lines.push(failures === 0 ? 'ALL CHECKS PASS' : `${failures} CHECK(S) FAILED`);
const text = lines.join('\n') + '\n';
await writeFile(join(here, 'measure.txt'), text);
console.log(text);
if (failures > 0) process.exit(1);
