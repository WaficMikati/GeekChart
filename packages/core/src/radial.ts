import { parseWith } from './graph.ts';
import { resolveMeasurer, type Measurer } from './layout.ts';
import { Track } from './motion.ts';
import { fitCanvas, frameTransform, type Scene } from './scene.ts';
import { BOX_SIZES, GUTTER, PRESS_EASE, WAVE_LAG } from './tokens.ts';

/**
 * Pie and mindmap.
 *
 * Neither is a graph in the flowchart sense — a pie is a partition of one
 * number, a mindmap is a tree that grows both ways from a centre — but both are
 * *radial*: everything is placed relative to one anchor point rather than in
 * rows and columns. That is the only thing they share, which is why they are
 * one small module rather than two.
 */

export type RadialKind = 'pie' | 'mindmap';

interface Slice {
  label: string;
  value: number;
}

interface MindNode {
  name: string;
  children: MindNode[];
}

export interface Radial {
  kind: RadialKind;
  title?: string;
  slices?: Slice[];
  root?: MindNode;
}

const clean = (t: unknown) => String(t ?? '').trim();

export async function toRadial(source: string, kind: RadialKind): Promise<Radial> {
  const db = await parseWith(source);
  const title = clean(db.getDiagramTitle?.());

  if (kind === 'pie') {
    const sections = (db.getSections?.() ?? new Map()) as Map<string, number>;
    const slices = [...sections.entries()]
      .map(([label, value]) => ({ label: clean(label), value: Number(value) || 0 }))
      .filter((s) => s.value > 0);
    if (!slices.length) throw new Error('Nothing to draw — this pie has no slices.');
    return { kind, ...(title ? { title } : {}), slices };
  }

  const raw = db.getMindmap?.() as
    { descr?: string; nodeId?: string; children?: unknown[] } | null | undefined;
  if (!raw) throw new Error('Nothing to draw — this mindmap is empty.');
  const toNode = (n: { descr?: string; nodeId?: string; children?: unknown[] }): MindNode => ({
    name: clean(n.descr || n.nodeId),
    children: ((n.children ?? []) as (typeof n)[]).map(toNode),
  });
  const root = toNode(raw);
  return { kind, ...(title ? { title } : {}), root };
}

/* ------------------------------------------------------------------ drawing */

const SVGNS = 'http://www.w3.org/2000/svg';
const esc = (t: string) =>
  t.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const round = (n: number) => Number(n.toFixed(2));

export interface RadialDrawing {
  svg: string;
  css: string;
  cycle: number;
  summary: string;
  groups: number;
  items: number;
}

type Measure = (t: string, font: string, size: number, tracking?: string) => number;
interface Mark {
  id: string;
  markup: string;
  /** A pie wedge draws by sweeping through these `d` values in order, rather
   *  than fading in already at full size (DESIGN 5.4). */
  sweep?: string[];
  /** Mindmap: the link this node hangs from (a link's parent is the link into its parent node). */
  parent?: string;
  depth?: number;
}
interface Built {
  width: number;
  height: number;
  groups: number;
  items: number;
}

/** Shorten a label to fit a box, rather than widening the box. DESIGN 2.2. */
function fitLabel(text: string, maxW: number, font: string, size: number, width: Measure): string {
  if (width(text, font, size) <= maxW) return text;
  let cut = text;
  while (cut.length > 1 && width(`${cut}…`, font, size) > maxW) cut = cut.slice(0, -1);
  return `${cut}…`;
}

export function drawRadial(radial: Radial, scene: Scene, measureWith?: string | Measurer): RadialDrawing {
  const measurer = resolveMeasurer(measureWith);
  const width: Measure = (t, f, s, tr) => measurer.measure(t, f, s, tr);
  const pad = scene.canvas.margin;
  const parts: string[] = [];
  const marks: Mark[] = [];

  const built =
    radial.kind === 'pie'
      ? pie(radial, scene, width, pad, parts, marks)
      : mindmap(radial, scene, width, pad, parts, marks);
  measurer.done();

  const frame = fitCanvas({ x: 0, y: 0, width: built.width, height: built.height }, scene.canvas);
  const svg =
    `<svg class="gc-chart" viewBox="0 0 ${frame.width} ${frame.height}" ` +
    `width="${frame.width}" height="${frame.height}" role="img" xmlns="${SVGNS}">` +
    `<g class="gc-frame" transform="${frameTransform(frame)}">` +
    parts.join('') +
    marks.map((m) => m.markup).join('') +
    `</g></svg>`;

  const motion = animate(marks, Boolean(radial.title), scene);
  const noun = radial.kind === 'pie' ? 'Pie chart' : 'Mindmap';
  return {
    svg,
    css: motion.css,
    cycle: motion.cycle,
    summary: `${noun}${radial.title ? `: ${radial.title}` : ''}. ${built.groups} groups, ${built.items} items.`,
    groups: built.groups,
    items: built.items,
  };
}

/** The colour a slice takes: the four role hues first, then the series set. */
function sliceClass(i: number, seriesLen: number): string {
  if (i < 4) return `gc-pie-slice gc-pie-slice-${i}`;
  return `gc-pie-slice gc-series-${(i - 4) % Math.max(seriesLen, 1)}`;
}

/**
 * A donut, centred left, with every slice named on a short leader line outside
 * the ring rather than crammed inside it — a wedge under 20° has nowhere to set
 * a two-line label without escaping its own slice.
 */
function pie(
  radial: Radial,
  scene: Scene,
  width: Measure,
  pad: number,
  parts: string[],
  marks: Mark[],
): Built {
  const slices = radial.slices ?? [];
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const outerR = 168,
    innerR = 104;
  const titleH = radial.title ? scene.type.title * 1.9 : 0;
  const top = pad + titleH + 10;
  const cy = top + outerR + 8;

  if (radial.title) {
    parts.push(
      `<text class="gc-radial-title" x="${round(pad)}" y="${round(pad + scene.type.title)}">${esc(radial.title)}</text>`,
    );
  }

  // Each label sits near its own slice, on a leader that travels straight
  // outward from the ring for a fixed 32, then steps sideways a fixed 24 to
  // the text — every leader the same total length, never across the donut's
  // own hole. A single shared label column read cleanly but its leader lines
  // from the far side of the ring had to cross the whole drawing to reach it,
  // which DESIGN 9 rules out as a diagonal running under the diagram.
  const leaderOut = 32;
  const sideGap = 24;
  const minGap = 24;

  // Pass one: every slice's angle and label metrics, in a coordinate space
  // centred on the ring, so cx can be chosen from what the labels actually
  // need on each flank before anything is drawn relative to it.
  let angle = -Math.PI / 2;
  const laid = slices.map((slice, i) => {
    const a0 = angle;
    const a1 = angle + (slice.value / total) * Math.PI * 2;
    const mid = (a0 + a1) / 2;
    angle = a1;
    const rightSide = Math.cos(mid) >= 0;
    const pct = Math.round((slice.value / total) * 100);
    const label = fitLabel(slice.label, 180, scene.titleFont, scene.type.name, width);
    const textW = Math.max(
      width(label, scene.titleFont, scene.type.name),
      width(`${pct}%`, scene.rowFont, scene.type.caption),
    );
    const rx =
      Math.cos(mid) * (outerR + leaderOut) + (rightSide ? sideGap + textW : -sideGap - textW);
    const oyRel = Math.sin(mid) * (outerR + leaderOut);
    return { i, a0, a1, mid, rightSide, pct, label, oyRel, finalOyRel: oyRel, rx };
  });

  // Two labels this close together, on the same flank, read as one smear of
  // text rather than two rows — DESIGN 6.5. Stack them at least `minGap`
  // apart instead, splitting the correction between the pair so each nudges
  // outward from where it naturally landed rather than the whole flank
  // cascading toward one edge. A few passes because separating one pair can
  // pull it back into range of its other neighbour.
  for (const side of [true, false]) {
    const flank = laid
      .filter((l) => l.rightSide === side)
      .sort((a, b) => a.finalOyRel - b.finalOyRel);
    for (let pass = 0; pass < 4; pass++) {
      for (let k = 1; k < flank.length; k++) {
        const gap = flank[k]!.finalOyRel - flank[k - 1]!.finalOyRel;
        if (gap >= minGap) continue;
        const short = (minGap - gap) / 2;
        flank[k - 1]!.finalOyRel -= short;
        flank[k]!.finalOyRel += short;
      }
    }
  }

  const leftReach = Math.min(-outerR, ...laid.filter((l) => !l.rightSide).map((l) => l.rx));
  const rightReach = Math.max(outerR, ...laid.filter((l) => l.rightSide).map((l) => l.rx));
  const cx = pad - leftReach;

  // A wedge is drawn as one thick stroked arc along the ring's centre line and
  // draws on with stroke-dashoffset (DESIGN 8.2) — one smooth keyframe pair,
  // GPU-composited. (Animating the path's `d` through discrete arc steps stuttered:
  // the ease applied per step and the arc flags flipped mid-sweep.) The arc is
  // split at its midpoint so a slice of any size, a full circle included, is valid.
  const ringR = (outerR + innerR) / 2;
  const ringW = outerR - innerR;

  laid.forEach(({ i, a0, a1, mid, rightSide, pct, label, oyRel, finalOyRel }) => {
    const cls = sliceClass(i, scene.series.length);
    const at = (a: number) =>
      `${round(cx + Math.cos(a) * ringR)},${round(cy + Math.sin(a) * ringR)}`;
    const half = (a0 + a1) / 2;
    const flag = (from: number, to: number) => (to - from > Math.PI ? 1 : 0);
    const arc = `M${at(a0)} A${ringR},${ringR} 0 ${flag(a0, half)} 1 ${at(half)} A${ringR},${ringR} 0 ${flag(half, a1)} 1 ${at(a1)}`;
    marks.push({
      id: `w-${i}`,
      markup: `<path class="${cls} gc-pie-arc" data-id="w-${i}" d="${arc}" pathLength="1" style="stroke-width:${round(ringW)}px"/>`,
      sweep: [arc],
    });

    const ex = cx + Math.cos(mid) * outerR;
    const ey = cy + Math.sin(mid) * outerR;
    const ox = cx + Math.cos(mid) * (outerR + leaderOut);
    const oy = cy + oyRel;
    const ny = cy + finalOyRel;
    const tx = ox + (rightSide ? sideGap : -sideGap);
    const anchor = rightSide ? 'start' : 'end';
    // The radial run and the underline both keep their fixed length; a nudge
    // only inserts a vertical connector between them, so every leader that
    // needed no nudge is exactly 32 + 24 long, and one that did still ends on
    // the same fixed-length underline.
    const jog = Math.abs(ny - oy) > 0.5 ? `L${round(ox)},${round(ny)}` : '';

    marks.push({
      id: `l-${i}`,
      markup:
        `<g class="gc-radial-label" data-id="l-${i}">` +
        // hairline separator at this slice's start, in the ground colour, on top of the ring
        `<line class="gc-pie-sep" x1="${round(cx + Math.cos(a0) * (innerR - 1))}" y1="${round(cy + Math.sin(a0) * (innerR - 1))}" x2="${round(cx + Math.cos(a0) * (outerR + 1))}" y2="${round(cy + Math.sin(a0) * (outerR + 1))}"/>` +
        `<path class="gc-edge gc-radial-leader" d="M${round(ex)},${round(ey)} L${round(ox)},${round(oy)}${jog} H${round(tx)}"/>` +
        `<text class="gc-radial-name" text-anchor="${anchor}" x="${round(tx)}" y="${round(ny)}">${esc(label)}</text>` +
        `<text class="gc-radial-pct" text-anchor="${anchor}" x="${round(tx)}" y="${round(ny + 13)}">${pct}%</text>` +
        `</g>`,
    });
  });

  const maxOy = Math.max(
    cy + outerR,
    ...laid.map((l) => cy + l.finalOyRel + scene.type.caption + 5),
  );
  const legendY = maxOy + scene.type.label * 2 + 14;
  parts.push(legendRow(slices, scene, width, pad, round(legendY)));

  return {
    width: cx + rightReach + pad,
    height: legendY + scene.type.label + pad,
    groups: 1,
    items: slices.length,
  };
}

/** Swatch plus name, one row, left-aligned. DESIGN 7.2. */
function legendRow(slices: Slice[], scene: Scene, width: Measure, x0: number, y: number): string {
  const gap = 20;
  let x = x0;
  return (
    `<g class="gc-radial-legend">` +
    slices
      .map((s, i) => {
        const label = s.label.toUpperCase();
        const w = width(label, scene.rowFont, scene.type.label, scene.type.labelTracking) + 16;
        const at = x;
        x += w + gap;
        return (
          `<rect class="gc-radial-swatch ${sliceClass(i, scene.series.length)}" x="${round(at)}" y="${round(y - scene.type.label * 0.9)}" width="8" height="8" rx="2"/>` +
          `<text class="gc-radial-legend-label" x="${round(at + 14)}" y="${round(y)}">${esc(label)}</text>`
        );
      })
      .join('') +
    `</g>`
  );
}

/** Rounded orthogonal H-V-H, direction-agnostic in both axes. */
function hvh(x1: number, y1: number, x2: number, y2: number, r = 8): string {
  if (Math.abs(y1 - y2) < 0.01) return `M${round(x1)},${round(y1)} H${round(x2)}`;
  const midX = (x1 + x2) / 2;
  const dirX = midX > x1 ? 1 : -1;
  const dirY = y2 > y1 ? 1 : -1;
  const rr = Math.min(r, Math.abs(midX - x1), Math.abs(y2 - y1) / 2);
  return (
    `M${round(x1)},${round(y1)} H${round(midX - dirX * rr)} ` +
    `Q${round(midX)},${round(y1)} ${round(midX)},${round(y1 + dirY * rr)} ` +
    `V${round(y2 - dirY * rr)} Q${round(midX)},${round(y2)} ${round(midX + dirX * rr)},${round(y2)} ` +
    `H${round(x2)}`
  );
}

interface Placed {
  name: string;
  depth: number;
  side: 'l' | 'r';
  x: number;
  y: number;
  w: number;
  children: Placed[];
  /** Which top-level branch this node descends from — its colour, when the
   *  chart has few enough branches to spare one each (DESIGN 5.3: a second hue
   *  earned by a category the reader already has, which a branch's own root
   *  label is). */
  branch: number;
}

/**
 * A tree that grows both ways from a centred root, columns by depth, 32
 * gutters on the 8-grid. DESIGN 2.1, 2.3.
 *
 * Children of the root alternate left and right rather than piling onto one
 * side, which is what keeps a three-branch mindmap from reading as a lopsided
 * list. Row position within a side is assigned leaf-first, bottom-up, so a
 * parent always centres on the vertical span of its own children.
 */
function mindmap(
  radial: Radial,
  scene: Scene,
  width: Measure,
  pad: number,
  parts: string[],
  marks: Mark[],
): Built {
  const root = radial.root ?? { name: '', children: [] };
  const boxH = BOX_SIZES.standard.height;
  const childW = BOX_SIZES.standard.width;
  const rootW = BOX_SIZES.wide.width;
  const rowStep = boxH + GUTTER.sibling; // 48-high box + 24 gutter, on the 8-grid.
  const colStep = childW + GUTTER.panel; // 160 box + 32 gutter, on the 8-grid.

  const rows: Record<'l' | 'r', { n: number }> = { l: { n: 0 }, r: { n: 0 } };
  function place(node: MindNode, depth: number, side: 'l' | 'r', branch: number): Placed {
    if (!node.children.length) {
      const y = rows[side].n * rowStep;
      rows[side].n++;
      return { name: node.name, depth, side, x: 0, y, w: childW, children: [], branch };
    }
    const kids = node.children.map((c) => place(c, depth + 1, side, branch));
    const y = kids.reduce((s, k) => s + k.y, 0) / kids.length;
    return { name: node.name, depth, side, x: 0, y, w: childW, children: kids, branch };
  }

  const kidsSource = root.children ?? [];
  const rightKids = kidsSource
    .filter((_, i) => i % 2 === 0)
    .map((c, ri) => place(c, 1, 'r', ri * 2));
  const leftKids = kidsSource
    .filter((_, i) => i % 2 === 1)
    .map((c, li) => place(c, 1, 'l', li * 2 + 1));

  const topYs = [...rightKids, ...leftKids].map((k) => k.y);
  const rootYLocal = topYs.length ? topYs.reduce((a, b) => a + b, 0) / topYs.length : 0;

  const flat: Placed[] = [];
  const shift = (n: Placed) => {
    n.y -= rootYLocal;
    n.x =
      n.side === 'r'
        ? rootW / 2 + GUTTER.panel + (n.depth - 1) * colStep + childW / 2
        : -(rootW / 2) - GUTTER.panel - (n.depth - 1) * colStep - childW / 2;
    flat.push(n);
    n.children.forEach(shift);
  };
  rightKids.forEach(shift);
  leftKids.forEach(shift);

  const minEdge = Math.min(-rootW / 2, ...flat.map((n) => n.x - n.w / 2));
  const maxEdge = Math.max(rootW / 2, ...flat.map((n) => n.x + n.w / 2));
  const minEdgeY = Math.min(-boxH / 2, ...flat.map((n) => n.y - boxH / 2));
  const maxEdgeY = Math.max(boxH / 2, ...flat.map((n) => n.y + boxH / 2));

  const titleH = radial.title ? scene.type.title * 1.9 : 0;
  const top = pad + titleH;
  const offX = pad - minEdge;
  const offY = top - minEdgeY;

  if (radial.title) {
    parts.push(
      `<text class="gc-radial-title" x="${round(pad)}" y="${round(pad + scene.type.title)}">${esc(radial.title)}</text>`,
    );
  }

  const rootX = offX,
    rootY = offY;
  const anchorOut = (x: number, y: number, w: number, side: 'l' | 'r') => ({
    x: side === 'r' ? x + w / 2 : x - w / 2,
    y,
  });
  const anchorIn = (n: Placed) => ({
    x: n.side === 'r' ? n.x + offX - n.w / 2 : n.x + offX + n.w / 2,
    y: n.y + offY,
  });

  const linkClass = (depth: number) =>
    depth <= 1 ? 'gc-mind-link-d1' : depth === 2 ? 'gc-mind-link-d2' : 'gc-mind-link-d3';
  // Each top-level branch gets its own hue, cycling through the categorical
  // palette — the branch's own label is the legend (DESIGN 5.3).
  const branchClass = (n: number) => ` gc-series-${n % scene.series.length}`;

  // The root is a mark like everything else, so it is part of the build (it
  // used to sit in the static parts and was simply there from frame zero).
  const rootLabel = fitLabel(root.name, rootW - 32, scene.titleFont, scene.type.name, width);
  marks.push({
    id: 'root',
    depth: 0,
    markup:
      `<g class="gc-mind-node" data-id="root">` +
      `<rect class="gc-mind-root" x="${round(rootX - rootW / 2)}" y="${round(rootY - boxH / 2)}" width="${rootW}" height="${boxH}" rx="${scene.radius}"/>` +
      `<text class="gc-title" x="${round(rootX)}" y="${round(rootY + 4)}">${esc(rootLabel)}</text>` +
      `</g>`,
  });

  let i = 0;
  const draw = (n: Placed, fromX: number, fromY: number, fromW: number, parent: string) => {
    const to = anchorIn(n);
    const from = anchorOut(fromX, fromY, fromW, n.side);
    const id = `m-${i++}`;
    const series = branchClass(n.branch);
    const d = hvh(from.x, from.y, to.x, to.y);
    marks.push({
      id,
      parent,
      depth: n.depth,
      markup:
        `<path class="gc-mind-link${series} ${linkClass(n.depth)}" data-id="${id}" d="${d}" pathLength="1"/>` +
        // the spark that walks this link in the live phase (hidden at rest)
        `<circle class="gc-spark gc-mind-spark" data-id="s-${id}" r="3" style="offset-path:path('${d}')"/>`,
    });
    const nx = n.x + offX,
      ny = n.y + offY;
    const label = fitLabel(n.name, childW - 32, scene.titleFont, scene.type.name, width);
    marks.push({
      id: `n-${id}`,
      parent: id,
      depth: n.depth,
      markup:
        `<g class="gc-mind-node" data-id="n-${id}">` +
        `<rect class="gc-mind-child${series}" x="${round(nx - childW / 2)}" y="${round(ny - boxH / 2)}" width="${childW}" height="${boxH}" rx="${scene.radius}" pathLength="1"/>` +
        `<text class="gc-title" x="${round(nx)}" y="${round(ny + 4)}">${esc(label)}</text>` +
        `</g>`,
    });
    n.children.forEach((c) => draw(c, nx, ny, childW, `n-${id}`));
  };
  rightKids.forEach((k) => draw(k, rootX, rootY, rootW, 'root'));
  leftKids.forEach((k) => draw(k, rootX, rootY, rootW, 'root'));

  return {
    width: maxEdge - minEdge + pad * 2,
    height: maxEdgeY - minEdgeY + top + pad,
    groups: kidsSource.length,
    items: flat.length,
  };
}

function animate(marks: Mark[], hasTitle: boolean, scene: Scene): { css: string; cycle: number } {
  const m = scene.motion;
  const tracks = new Map<string, Track>();
  const track = (sel: string) => {
    const found = tracks.get(sel);
    if (found) return found;
    const made = new Track();
    tracks.set(sel, made);
    return made;
  };
  const lead = 0.25;
  const scaffold = lead + m.build;
  const step = Math.min(0.14, 2.6 / Math.max(marks.length, 1));
  const last = scaffold + WAVE_LAG + Math.max(marks.length - 1, 0) * step + m.build;
  // A mindmap's build is topological, and its live phase walks every link, so
  // its loop is longer than the index cadence would give; computed below.
  const mindLinks = marks.filter((mk) => mk.id.startsWith('m-')).length;
  const mindDepth = Math.max(0, ...marks.map((mk) => mk.depth ?? 0));
  const cycle = marks.some((mk) => mk.id === 'root')
    ? scaffold +
      m.build * 0.5 +
      mindDepth * (m.build * 0.9 + m.build * 0.6 * 0.6 + 0.36) +
      0.4 +
      mindLinks * 0.45 * 0.8 +
      0.45 +
      0.6 +
      m.hold
    : last + m.hold;

  const fade = (sel: string, from: number, over = m.build * 0.8) => {
    const t = track(sel);
    t.at(0, { opacity: '0' });
    t.at(from, { opacity: '0' });
    t.at(from + over, { opacity: '1' });
    t.at(cycle, { opacity: '1' });
  };

  if (hasTitle) fade('.gc-radial-title', lead, m.build * 0.7);
  fade('.gc-radial-legend', scaffold);
  const wedgeDone = new Map<string, number>(); // "w-0" -> when its sweep finished
  // Mindmap: the tree grows from the root outward, each link drawing from its
  // parent and each box drawing on as its link arrives (topological, not an
  // index cadence — DESIGN 8.2, 10.4); then one spark walks every branch.
  const isMind = marks.some((mk) => mk.id === 'root');
  if (isMind) {
    const done = new Map<string, number>();
    const siblings = new Map<string, number>();
    const linkDur = m.build * 0.9,
      boxDur = m.build * 0.6,
      lag = 0.12;
    const root = track('[data-id="root"]');
    root.at(0, { opacity: '0', transform: 'scale(0.9)' });
    root.at(scaffold, { opacity: '0', transform: 'scale(0.9)' });
    root.at(scaffold + m.build * 0.7, {
      opacity: '1',
      transform: 'scale(1)',
      'animation-timing-function': PRESS_EASE,
    });
    root.at(cycle, { opacity: '1', transform: 'scale(1)' });
    done.set('root', scaffold + m.build * 0.5);
    for (const mark of marks) {
      if (mark.id === 'root' || !mark.parent) continue;
      if (mark.id.startsWith('m-')) {
        const k = siblings.get(mark.parent) ?? 0;
        siblings.set(mark.parent, k + 1);
        const start = (done.get(mark.parent) ?? scaffold) + k * lag;
        const t = track(`[data-id="${mark.id}"]`);
        t.at(0, { opacity: '0', 'stroke-dashoffset': '1' });
        t.at(start, { opacity: '0', 'stroke-dashoffset': '1' });
        t.at(start + 0.04, { opacity: '1' });
        t.at(start + linkDur, { 'stroke-dashoffset': '0' });
        t.at(cycle, { opacity: '1', 'stroke-dashoffset': '0' });
        done.set(mark.id, start + linkDur);
      } else if (mark.id.startsWith('n-')) {
        const start = done.get(mark.parent) ?? scaffold;
        const box = track(`[data-id="${mark.id}"] rect`);
        box.at(0, { opacity: '0', 'stroke-dashoffset': '1' });
        box.at(start - 0.02, { opacity: '0', 'stroke-dashoffset': '1' });
        box.at(start + 0.03, { opacity: '1' });
        box.at(start + boxDur, { 'stroke-dashoffset': '0' });
        box.at(cycle, { opacity: '1', 'stroke-dashoffset': '0' });
        const text = track(`[data-id="${mark.id}"] text`);
        text.at(0, { opacity: '0' });
        text.at(start + boxDur * 0.4, { opacity: '0' });
        text.at(start + boxDur * 0.4 + m.build * 0.5, { opacity: '1' });
        text.at(cycle, { opacity: '1' });
        done.set(mark.id, start + boxDur * 0.6);
      }
    }
    // Live phase: a spark walks the tree depth-first, one link at a time; the
    // box it reaches presses (10.4). Then the still beat.
    const built = Math.max(...done.values());
    let at = built + 0.4;
    const walk = 0.45;
    for (const mark of marks) {
      if (!mark.id.startsWith('m-')) continue;
      const spark = track(`[data-id="s-${mark.id}"]`);
      spark.at(0, { opacity: '0', 'offset-distance': '0%', r: '1.5' });
      spark.at(at, { opacity: '0', 'offset-distance': '0%', r: '1.5' });
      spark.at(at + 0.05, { opacity: '1', r: '3' });
      spark.at(at + walk - 0.05, { opacity: '1', r: '3' });
      spark.at(at + walk, { opacity: '0', 'offset-distance': '100%', r: '1' });
      spark.at(cycle, { opacity: '0', 'offset-distance': '100%', r: '1' });
      const node = track(`[data-id="n-${mark.id}"]`);
      node.at(at + walk - 0.02, { transform: 'scale(1)' });
      node.at(at + walk + 0.18, {
        transform: 'scale(1.03)',
        'animation-timing-function': PRESS_EASE,
      });
      node.at(at + walk + 0.5, { transform: 'scale(1)' });
      node.at(cycle, { transform: 'scale(1)' });
      const outline = track(`[data-id="n-${mark.id}"] rect`);
      outline.at(at + walk - 0.02, { stroke: 'var(--gc-mark)' });
      outline.at(at + walk + WAVE_LAG, { stroke: 'var(--gc-accent)' });
      outline.at(at + walk + 0.5, { stroke: 'var(--gc-mark)' });
      outline.at(cycle, { stroke: 'var(--gc-mark)' });
      at += walk * 0.8;
    }
  }
  marks.forEach((mark, i) => {
    if (isMind) return;
    const start = scaffold + WAVE_LAG + i * step;
    if (mark.sweep) {
      // The wedge itself sweeps through its own `d` steps — a plain opacity
      // fade would show the *finished* shape appearing, not the arc drawing.
      const t = track(`[data-id="${mark.id}"]`);
      const dur = m.build * 1.3;
      t.at(0, { opacity: '0', 'stroke-dashoffset': '1' });
      t.at(start, { opacity: '0', 'stroke-dashoffset': '1' });
      t.at(start + 0.04, { opacity: '1' });
      t.at(start + dur, { 'stroke-dashoffset': '0' });
      t.at(cycle, { opacity: '1', 'stroke-dashoffset': '0' });
      wedgeDone.set(mark.id, start + dur);
    } else {
      // A slice's label follows its own wedge finishing its sweep — not the
      // flat per-mark stagger — so the name never reads before its slice has
      // finished drawing itself.
      const ownWedge = mark.id.startsWith('l-')
        ? wedgeDone.get(`w-${mark.id.slice(2)}`)
        : undefined;
      fade(`[data-id="${mark.id}"]`, Math.max(start, ownWedge ?? 0));
    }
  });

  const rules: string[] = [];
  const frames: string[] = [];
  let i = 0;
  for (const [sel, value] of tracks) {
    if (value.empty) continue;
    const name = `gc-r${i++}`;
    rules.push(`${sel}{animation:${name} ${cycle.toFixed(2)}s ${m.ease} infinite}`);
    frames.push(`@keyframes ${name}{${value.frames(cycle)}}`);
  }
  return {
    cycle,
    css: `\n@media (prefers-reduced-motion: no-preference) {\n${rules.join('\n')}\n${frames.join('\n')}\n}\n`,
  };
}

export function radialCss(scene: Scene): string {
  const series = scene.series
    .map(
      (c, i) =>
        `.gc-series-${i} { --gc-mark: var(--gc-series-${i + 1}, ${c}); fill: var(--gc-mark); }`,
    )
    .concat(['.gc-pie-arc { fill: none; stroke: var(--gc-mark); stroke-dasharray: 1; }'])
    .join('\n');
  return `
.gc-radial-title { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.titleFont};
  font-weight: ${scene.type.titleWeight}; font-size: ${scene.type.title}px;
  letter-spacing: ${scene.type.titleTracking}; text-anchor: start; }

.gc-pie-slice { stroke: var(--gc-bg, ${scene.bg}); stroke-width: 2px; stroke-linejoin: round; }
.gc-pie-sep { stroke: var(--gc-bg, ${scene.bg}); stroke-width: 2px; }
.gc-pie-slice-0 { --gc-mark: var(--gc-path, ${scene.path}); fill: var(--gc-mark); }
.gc-pie-slice-1 { --gc-mark: var(--gc-alt, ${scene.alt}); fill: var(--gc-mark); }
.gc-pie-slice-2 { --gc-mark: var(--gc-accent, ${scene.accent}); fill: var(--gc-mark); }
.gc-pie-slice-3 { --gc-mark: var(--gc-quiet, ${scene.quiet}); fill: var(--gc-mark); }
${series}
.gc-radial-swatch { stroke: none; }
.gc-radial-leader { stroke-width: ${scene.edgeStroke}px; opacity: .6; }
.gc-radial-name { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.titleFont};
  font-weight: ${scene.type.nameWeight}; font-size: ${scene.type.name}px; text-anchor: start; }
.gc-radial-pct { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.rowFont};
  font-size: ${scene.type.caption}px; text-anchor: start; font-variant-numeric: tabular-nums; }
.gc-radial-legend-label { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.rowFont};
  font-size: ${scene.type.label}px; letter-spacing: ${scene.type.labelTracking};
  text-transform: uppercase; }

/* Root is the one filled tile; every branch is outlined (DESIGN 4.2 — one
   depth cue, never a fill and an outline on the same box). Colour is spent on
   *which* branch, not on depth: each branch keeps its own hue from its own
   root down to its leaves, on both the box outline and the link that grows
   it, so the eye can follow one branch through the tree (DESIGN 5.3 — the
   branch's own label is the legend this second hue is earning). */
.gc-mind-root { fill: var(--gc-surface, ${scene.surface}); stroke: none; }
.gc-mind-node { transform-box: fill-box; transform-origin: center; }
.gc-mind-spark { fill: var(--gc-accent, ${scene.accent}); opacity: 0; }
.gc-mind-link, .gc-mind-child { stroke-dasharray: 1; }
.gc-mind-child { fill: none; stroke: var(--gc-mark, var(--gc-edge, ${scene.edge})); stroke-width: ${scene.nodeStroke}px;
  stroke-linejoin: round; }
.gc-mind-link { fill: none; stroke: var(--gc-mark, var(--gc-edge, ${scene.edge})); stroke-width: ${scene.edgeStroke}px;
  stroke-linecap: round; }
.gc-mind-link-d1 { opacity: 1; }
.gc-mind-link-d2 { opacity: .7; }
.gc-mind-link-d3 { opacity: .5; }
`;
}
