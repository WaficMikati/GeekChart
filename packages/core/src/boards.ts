import { parseWith } from './graph.ts';
import { makeMeasurer } from './layout.ts';
import { Track } from './motion.ts';
import { fitCanvas, frameTransform, type Scene } from './scene.ts';

/**
 * Sankey, treemap and kanban.
 *
 * Unlike the axis types or the plots, these three share no model — a flow of
 * magnitudes, a partition of area, and a board of columns have nothing in common
 * geometrically. What they share is the chrome: a title, the categorical
 * palette, and a timeline that brings things on in a sensible order. Each layout
 * is written out in full below.
 *
 * They are grouped in one module because each is small, and because splitting
 * three hundred lines across three files would say they were related when the
 * only thing they have in common is that none of them is a graph.
 */

export type BoardKind = 'sankey' | 'treemap' | 'kanban';

interface SankeyLink {
  source: string;
  target: string;
  value: number;
}

interface TreeNode {
  name: string;
  value?: number;
  children?: TreeNode[];
}

interface Card {
  name: string;
  caption: string;
}

interface Column {
  name: string;
  cards: Card[];
}

export interface Board {
  kind: BoardKind;
  title?: string;
  /** DESIGN 7.1: a tracked, dotted list of facts under the title. Sankey only:
   *  sankey-beta has no title syntax of its own, so this and the title fallback
   *  below are the only way that chart ever gets one. */
  kicker?: string;
  links?: SankeyLink[];
  nodes?: string[];
  root?: TreeNode;
  columns?: Column[];
}

const clean = (t: unknown) => String(t ?? '').trim();

export async function toBoard(source: string, kind: BoardKind): Promise<Board> {
  const db = await parseWith(source);
  const title = clean(db.getDiagramTitle?.());

  if (kind === 'sankey') {
    const graph = (db.getGraph?.() ?? {}) as {
      nodes?: { id?: string }[];
      links?: { source?: string; target?: string; value?: number }[];
    };
    const links = (graph.links ?? [])
      .map((l) => ({ source: clean(l.source), target: clean(l.target), value: Number(l.value) || 0 }))
      .filter((l) => l.source && l.target && l.value > 0);
    if (!links.length) throw new Error('Nothing to draw — this sankey has no flows.');
    const ids = [...new Set([...links.map((l) => l.source), ...links.map((l) => l.target)])];
    const depth = layerOf(links, ids);
    const layers = Math.max(...ids.map((n) => depth.get(n) ?? 0)) + 1;
    return {
      kind,
      // DESIGN 7.1: every chart has a title. sankey-beta's own grammar has no
      // title line, so a mermaid title only ever reaches here through the YAML
      // frontmatter form; anything else falls back to a generic one.
      title: title || 'Sankey diagram',
      // DESIGN 7.1's kicker pattern: a tracked, dotted list of facts. Case and
      // tracking are set once in CSS (.gc-board-kicker), not baked in here.
      kicker: `${links.length} flows · ${ids.length} nodes · ${layers} stages`,
      links,
      nodes: (graph.nodes ?? []).map((n) => clean(n.id)),
    };
  }

  if (kind === 'treemap') {
    const root = (db.getRoot?.() ?? {}) as TreeNode;
    if (!root.children?.length) throw new Error('Nothing to draw — this treemap is empty.');
    return { kind, ...(title ? { title } : {}), root };
  }

  const sections = ((db.getSections?.() as { id?: string; label?: string }[]) ?? []).map((s) => ({
    id: clean(s.id),
    name: clean(s.label || s.id),
  }));
  const data = (db.getData?.() ?? {}) as {
    nodes?: {
      id?: string; parentId?: string; label?: string; isGroup?: boolean;
      ticket?: string; priority?: string; assigned?: string;
    }[];
  };
  const columns: Column[] = sections.map((s) => ({
    name: s.name,
    cards: (data.nodes ?? [])
      .filter((n) => !n.isGroup && clean(n.parentId) === s.id)
      .map((n) => {
        // DESIGN 3.2/3.3: a two-tier node's caption is a dotted list of facts.
        // A card's own ticket/priority/assignee are those facts; a card with
        // none of the three still needs a caption to earn the 56-high box, so
        // it falls back to its own id as a reference tag.
        const facts = [clean(n.ticket), clean(n.priority), clean(n.assigned)].filter(Boolean);
        return {
          name: clean(n.label || n.id),
          caption: facts.length ? facts.join(' · ') : `#${clean(n.id)}`,
        };
      }),
  }));
  if (!columns.length) throw new Error('Nothing to draw — this board has no columns.');
  return { kind, ...(title ? { title } : {}), columns };
}

/* ------------------------------------------------------------------ drawing */

const SVGNS = 'http://www.w3.org/2000/svg';
const esc = (t: string) =>
  t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const round = (n: number) => Number(n.toFixed(2));

export interface BoardDrawing {
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
  /** A ribbon reveals by growing rather than fading — DESIGN 8.2/10.4. */
  ribbon?: { width: number; layer: number };
}

/**
 * Assign each node to a column by longest path from a source.
 *
 * Longest rather than shortest: a node fed by both a one-hop and a three-hop
 * route belongs after both of them, or its ribbons run backwards.
 */
function layerOf(links: SankeyLink[], nodes: string[]): Map<string, number> {
  const out = new Map<string, string[]>();
  for (const id of nodes) out.set(id, []);
  for (const l of links) out.get(l.source)?.push(l.target);
  const depth = new Map<string, number>(nodes.map((n) => [n, 0]));
  // Relax |nodes| times: enough for the longest possible simple path, and a
  // cycle cannot run away because the depth only ever increases to a bound.
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const l of links) {
      const next = (depth.get(l.source) ?? 0) + 1;
      if (next > (depth.get(l.target) ?? 0) && next < nodes.length) {
        depth.set(l.target, next);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return depth;
}

/**
 * Squarified treemap.
 *
 * Laying a row out along the shorter side and stopping when the worst aspect
 * ratio starts getting worse is what keeps the tiles close to square. Slicing
 * naively instead produces slivers that cannot be labelled.
 */
function squarify(
  items: { name: string; value: number }[],
  box: { x: number; y: number; w: number; h: number },
): { name: string; value: number; x: number; y: number; w: number; h: number }[] {
  const out: { name: string; value: number; x: number; y: number; w: number; h: number }[] = [];
  const queue = [...items].sort((a, b) => b.value - a.value);
  let rect = { ...box };
  let total = queue.reduce((n, i) => n + i.value, 0);

  const worst = (row: number[], side: number, scale: number) => {
    const sum = row.reduce((n, v) => n + v, 0) * scale;
    const max = Math.max(...row) * scale;
    const min = Math.min(...row) * scale;
    if (sum === 0) return Infinity;
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };

  while (queue.length) {
    const side = Math.min(rect.w, rect.h);
    const scale = total > 0 ? (rect.w * rect.h) / total : 0;
    const row: typeof queue = [];
    while (queue.length) {
      const next = [...row.map((r) => r.value), queue[0]!.value];
      if (row.length && worst(next, side, scale) > worst(row.map((r) => r.value), side, scale)) break;
      row.push(queue.shift()!);
    }
    const rowValue = row.reduce((n, i) => n + i.value, 0);
    const thickness = rowValue * scale / side;
    let along = 0;
    for (const item of row) {
      const length = (item.value * scale) / Math.max(thickness, 1e-9);
      out.push(
        rect.w >= rect.h
          ? { ...item, x: rect.x, y: rect.y + along, w: thickness, h: length }
          : { ...item, x: rect.x + along, y: rect.y, w: length, h: thickness },
      );
      along += length;
    }
    if (rect.w >= rect.h) rect = { x: rect.x + thickness, y: rect.y, w: rect.w - thickness, h: rect.h };
    else rect = { x: rect.x, y: rect.y + thickness, w: rect.w, h: rect.h - thickness };
    total -= rowValue;
  }
  return out;
}

export function drawBoard(board: Board, scene: Scene, measureWith?: string): BoardDrawing {
  const measurer = makeMeasurer(measureWith);
  const width: Measure = (t, f, s, tr) => measurer.measure(t, f, s, tr);

  // The canvas owns the margin. DESIGN 1.3.
  const pad = scene.canvas.margin;
  const titleH = board.title ? scene.type.title * 1.9 : 0;
  const parts: string[] = [];
  const marks: Mark[] = [];

  const built =
    board.kind === 'sankey' ? sankey(board, scene, width, pad, titleH, parts, marks)
    : board.kind === 'treemap' ? treemap(board, scene, width, pad, titleH, parts, marks)
    : kanban(board, scene, width, pad, titleH, parts, marks);
  measurer.done();

  const title = board.title
    ? `<text class="gc-board-title" x="${round(built.width / 2)}" y="${round(pad + scene.type.title)}">${esc(board.title)}</text>`
    : '';
  // DESIGN 7.1: the kicker sits under the title, same gap as a cluster's
  // kicker under its own title (type.kicker + 9).
  const kicker = board.kicker
    ? `<text class="gc-board-kicker" x="${round(built.width / 2)}" ` +
      `y="${round(pad + scene.type.title + scene.type.kicker + 9)}">${esc(board.kicker)}</text>`
    : '';
  // A board is the one family DESIGN 1.1 lets past 1000, and only as far as
  // 1200 — a six-column kanban has nowhere else to put the sixth column.
  const frame = fitCanvas(
    { x: 0, y: 0, width: built.width, height: built.height }, scene.canvas, scene.canvas.max,
  );
  const svg =
    `<svg class="gc-chart" viewBox="0 0 ${frame.width} ${frame.height}" ` +
    `width="${frame.width}" height="${frame.height}" role="img" xmlns="${SVGNS}">` +
    `<g class="gc-frame" transform="${frameTransform(frame)}">` +
    parts.join('') + marks.map((m) => m.markup).join('') + title + kicker + `</g></svg>`;

  const motion = animate(marks, Boolean(board.title), Boolean(board.kicker), scene);
  const noun = { sankey: 'Sankey diagram', treemap: 'Treemap', kanban: 'Kanban board' }[board.kind];
  return {
    svg, css: motion.css, cycle: motion.cycle,
    summary: `${noun}${board.title ? `: ${board.title}` : ''}. ${built.groups} groups, ${built.items} items.`,
    groups: built.groups, items: built.items,
  };
}

interface Built { width: number; height: number; groups: number; items: number }

/**
 * How many distinct things may take a categorical colour before the whole
 * figure gives up on identity and falls back to one hue.
 *
 * The palette is assigned in fixed order and never cycled, so a seventh group
 * cannot simply reuse the first colour — two unrelated groups painted the same
 * is worse than none of them being coloured at all.
 */
const SLOTS = 6;

/** A flow of magnitudes: nodes in columns, ribbons in between. */
function sankey(
  board: Board, scene: Scene, width: Measure, pad: number, titleH: number,
  _parts: string[], marks: Mark[],
): Built {
  const links = board.links ?? [];
  const ids = [...new Set([...links.map((l) => l.source), ...links.map((l) => l.target)])];
  const depth = layerOf(links, ids);
  const layers = Math.max(...ids.map((n) => depth.get(n) ?? 0)) + 1;

  const inflow = (id: string) => links.filter((l) => l.target === id).reduce((n, l) => n + l.value, 0);
  const outflow = (id: string) => links.filter((l) => l.source === id).reduce((n, l) => n + l.value, 0);
  const weight = (id: string) => Math.max(inflow(id), outflow(id));

  const byLayer: string[][] = Array.from({ length: layers }, () => []);
  for (const id of ids) byLayer[depth.get(id) ?? 0]!.push(id);

  // Only the last column's labels sit in the right-hand gutter this reserves —
  // an earlier column's longer name lives in its own colGap instead. Sizing
  // the gutter to the overall widest label, as if it always fell last, reserves
  // more than the last column ever uses, and centres the whole block on that
  // overstated width (DESIGN 7.3).
  const lastLabelW = Math.max(0, ...(byLayer[layers - 1] ?? []).map((id) => width(id, scene.titleFont, scene.type.name)));
  const barW = 12;
  const gap = 16;
  const plotH = 420;
  const top = pad + titleH + 10;
  const tallest = Math.max(...byLayer.map((col) => col.reduce((n, id) => n + weight(id), 0)));
  const scale = (plotH - gap * (Math.max(...byLayer.map((c) => c.length)) - 1)) / Math.max(tallest, 1);
  // The columns are spread across the canvas rather than packed at the width
  // the labels happen to need. DESIGN 1.1 and 7.4.
  const left = pad + 4;
  const colGap = Math.max(
    150,
    layers > 1 ? (scene.canvas.width - left - pad - lastLabelW - 16 - barW * layers) / (layers - 1) : 0,
  );
  const xOf = (d: number) => left + d * (barW + colGap);

  // Sources are the only things that take a colour; a ribbon inherits its
  // source's, which is what lets the eye follow one intake through the chart.
  const sources = [...new Set(links.map((l) => l.source))];
  const hue = (id: string) => (sources.length <= SLOTS ? sources.indexOf(id) : -1);

  const place = new Map<string, { y: number; h: number }>();
  for (const col of byLayer) {
    col.sort((a, b) => weight(b) - weight(a));
    const used = col.reduce((n, id) => n + weight(id) * scale, 0) + gap * (col.length - 1);
    let y = top + (plotH - used) / 2;
    for (const id of col) {
      const h = Math.max(6, weight(id) * scale);
      place.set(id, { y, h });
      y += h + gap;
    }
  }

  // Geometry (stacking within a bar) still needs links sorted by where they
  // land, so ribbons leaving or arriving at one bar don't cross each other —
  // that part is unchanged. What used to also decide the *reveal* order: marks
  // are pushed here by that same y-sort, node bars only afterwards in
  // whatever order `ids` first saw them, so the build read as ribbons and bars
  // in no relation to the actual flow. The two are separated below: geometry
  // is computed here and stashed by link/node id, and pushed to `marks` in a
  // final pass ordered left-to-right by layer instead (DESIGN 8: the build
  // follows the content, and the content here is "one column feeds the next").
  const ribbonMark = new Map<string, Mark>();
  const outAt = new Map<string, number>();
  const inAt = new Map<string, number>();
  for (const link of [...links].sort((a, b) => (place.get(a.target)!.y - place.get(b.target)!.y))) {
    const from = place.get(link.source)!;
    const to = place.get(link.target)!;
    const so = outAt.get(link.source) ?? 0;
    const ti = inAt.get(link.target) ?? 0;
    const thickness = Math.max(1.5, link.value * scale);
    const x1 = xOf(depth.get(link.source) ?? 0) + barW;
    const x2 = xOf(depth.get(link.target) ?? 0);
    const y1 = from.y + so;
    const y2 = to.y + ti;
    const mid = (x1 + x2) / 2;
    const slot = hue(link.source);
    // Drawn as a filled band rather than a thick stroke: a stroke cannot taper
    // between two different thicknesses, and the two ends rarely match.
    const d =
      `M${round(x1)},${round(y1)} C${round(mid)},${round(y1)} ${round(mid)},${round(y2)} ${round(x2)},${round(y2)} ` +
      `V${round(y2 + thickness)} C${round(mid)},${round(y2 + thickness)} ${round(mid)},${round(y1 + thickness)} ${round(x1)},${round(y1 + thickness)} Z`;
    const id = `l-${link.source}-${link.target}`;
    ribbonMark.set(id, {
      id,
      markup: `<path class="gc-ribbon${slot >= 0 ? ` gc-series-${slot}` : ''}" data-id="${esc(id)}" d="${d}"/>`,
      // Grown left to right in `animate()` — its own bounding-box width is a
      // clip-path inset, and its layer is which lag group it staggers with.
      ribbon: { width: Math.max(0, x2 - x1), layer: depth.get(link.source) ?? 0 },
    });
    outAt.set(link.source, so + thickness);
    inAt.set(link.target, ti + thickness);
  }

  const nodeMark = new Map<string, Mark>();
  for (const id of ids) {
    const at = place.get(id)!;
    const d = depth.get(id) ?? 0;
    const slot = hue(id);
    // Every label sits to the right of its own bar. Putting the last column's on
    // the left, as the convention suggests, walks them straight into the labels
    // of the column before — "Enrolled" landed on top of "Graduated". Each label
    // now owns the gap after its own bar, and nothing shares a gap.
    const lx = xOf(d) + barW + 10;
    // The value caption sits on a knockout plate: a ribbon can pass close
    // behind a label near its own bar, and the plate is what keeps the digits
    // legible over it without a stroke or a second fill on the number itself.
    const value = String(weight(id));
    const valueY = at.y + at.h / 2 + scene.type.caption + 4;
    const plateW = width(value, scene.rowFont, scene.type.caption) + 12;
    const plateH = scene.type.caption * 2;
    nodeMark.set(id, {
      id: `n-${id}`,
      markup:
        `<g class="gc-board-node" data-id="n-${esc(id)}">` +
        `<rect class="gc-board-bar${slot >= 0 ? ` gc-series-${slot}` : ''}" x="${round(xOf(d))}" y="${round(at.y)}" width="${barW}" height="${round(at.h)}" rx="3"/>` +
        `<text class="gc-board-label" x="${round(lx)}" ` +
        `y="${round(at.y + at.h / 2 - 2)}">${esc(id)}</text>` +
        `<rect class="gc-plate" x="${round(lx - 6)}" y="${round(valueY - scene.type.caption * 0.36 - plateH / 2)}" ` +
        `width="${round(plateW)}" height="${round(plateH)}" rx="3"/>` +
        `<text class="gc-board-value" x="${round(lx)}" y="${round(valueY)}">${value}</text>` +
        `</g>`,
    });
  }

  // The actual reveal: each layer's bars land, then the ribbons that leave
  // that layer draw on to the next one — left to right, the way the flow
  // itself reads.
  for (let layer = 0; layer < layers; layer++) {
    for (const id of byLayer[layer]!) marks.push(nodeMark.get(id)!);
    for (const link of links) {
      if ((depth.get(link.source) ?? 0) !== layer) continue;
      marks.push(ribbonMark.get(`l-${link.source}-${link.target}`)!);
    }
  }

  return {
    width: xOf(layers - 1) + barW + lastLabelW + pad + 16,
    height: top + plotH + pad,
    groups: layers,
    items: links.length,
  };
}

/** A partition of area: one block per group, tiles inside it. */
function treemap(
  board: Board, scene: Scene, width: Measure, pad: number, titleH: number,
  parts: string[], marks: Mark[],
): Built {
  const groups = (board.root?.children ?? []).filter((g) => g.children?.length || g.value);
  const total = (n: TreeNode): number => n.value ?? (n.children ?? []).reduce((s, c) => s + total(c), 0);
  const W = scene.canvas.width - pad * 2;
  const H = 520;
  const top = pad + titleH + 6;

  const blocks = squarify(
    groups.map((g) => ({ name: g.name, value: total(g) })),
    { x: pad, y: top, w: W, h: H },
  );

  // Names hidden because their tile was too small to hold them (3.1), listed
  // in one caption row under the chart instead of being lost outright.
  const hidden: string[] = [];

  blocks.forEach((block, gi) => {
    const group = groups.find((g) => g.name === block.name)!;
    const slot = groups.length <= SLOTS ? gi : -1;
    const headH = scene.type.label + 16;
    parts.push(
      `<g class="gc-board-group" data-id="g-${gi}">` +
        `<rect class="gc-board-group-box" x="${round(block.x + 2)}" y="${round(block.y + 2)}" ` +
        `width="${round(block.w - 4)}" height="${round(block.h - 4)}" rx="8"/>` +
        `<text class="gc-board-group-label" x="${round(block.x + 12)}" y="${round(block.y + headH - 4)}">${esc(block.name)}</text>` +
        `</g>`,
    );
    const leaves = (group.children ?? []).map((c) => ({ name: c.name, value: total(c) }));
    const tiles = squarify(leaves, {
      x: block.x + 8, y: block.y + headH, w: Math.max(block.w - 16, 1), h: Math.max(block.h - headH - 10, 1),
    });
    for (const tile of tiles) {
      // A label only goes in a tile it actually fits inside; a clipped word is
      // worse than none, because it reads as a different word. But a tile with
      // nothing on it at all is worse still (an uninformative colour swatch,
      // DESIGN 7.4's "never leave it" — DESIGN 3.1's 8-unit floor still holds:
      // name+value at 12/8.5 is tried first, and only a tile too small for
      // even the name alone at 8.5 falls back to the "Also:" row).
      const fits =
        tile.w > width(tile.name, scene.titleFont, scene.type.name) + 28 && tile.h > scene.type.name * 3;
      const compact =
        !fits &&
        tile.w > width(tile.name, scene.rowFont, scene.type.caption) + 20 &&
        tile.h > scene.type.caption * 2.4;
      if (!fits && !compact) hidden.push(tile.name);
      marks.push({
        id: `t-${gi}-${tile.name}`,
        markup:
          `<g class="gc-board-tile" data-id="t-${gi}-${esc(tile.name)}">` +
          `<rect class="gc-board-tile-box${slot >= 0 ? ` gc-series-${slot}` : ''}" x="${round(tile.x + 2)}" y="${round(tile.y + 2)}" ` +
          `width="${round(Math.max(tile.w - 4, 1))}" height="${round(Math.max(tile.h - 4, 1))}" rx="5"/>` +
          (fits
            ? `<text class="gc-board-label" x="${round(tile.x + 12)}" y="${round(tile.y + 24)}">${esc(tile.name)}</text>` +
              `<text class="gc-board-value" x="${round(tile.x + 12)}" y="${round(tile.y + 40)}">${tile.value}</text>`
            : compact
              ? `<text class="gc-board-tile-compact" x="${round(tile.x + 10)}" y="${round(tile.y + tile.h / 2 + scene.type.caption * 0.36)}">${esc(tile.name)}</text>`
              : ''
          ) +
          `</g>`,
      });
    }
  });

  // The footnote row (DESIGN 7.2's caption-row pattern) only exists when a
  // tile was actually hidden, so a treemap with no small tiles keeps the
  // whitespace even instead of reserving a blank line. DESIGN 7.4.
  let footH = 0;
  if (hidden.length) {
    footH = scene.type.rowStep * 2;
    const footY = top + H + footH / 2 + scene.type.label * 0.36;
    const prefix = 'Also: ';
    let items = hidden;
    let text = prefix + items.join(' · ');
    // Measured against the uppercase form the CSS renders, not the mixed-case
    // source, and dropped from the end rather than clipped mid-word. DESIGN 7.5.
    while (
      items.length > 1 &&
      width(text.toUpperCase(), scene.rowFont, scene.type.label, scene.type.labelTracking) > W
    ) {
      items = items.slice(0, -1);
      text = `${prefix}${items.join(' · ')} …`;
    }
    parts.push(`<text class="gc-board-footnote" x="${round(pad)}" y="${round(footY)}">${esc(text)}</text>`);
  }

  return { width: W + pad * 2, height: top + H + footH + pad, groups: groups.length,
           items: groups.reduce((n, g) => n + (g.children?.length ?? 0), 0) };
}

/** A board of columns, each holding cards. */
function kanban(
  board: Board, scene: Scene, _width: Measure, pad: number, titleH: number,
  parts: string[], marks: Mark[],
): Built {
  const columns = board.columns ?? [];
  // A card is inset 10 from the column and its text a further 12, on both
  // sides — 44 in total. Sizing for 34 left every long card's text running out
  // through its own right edge.
  const gap = scene.gapNode;
  // Columns divide the canvas rather than being sized to their longest card:
  // a board whose width is the sum of its cards is 1134 units on a 1000 stage,
  // which is DESIGN 1.1 and the "thin strip" of 9 in one go.
  const colW = Math.max(
    160,
    (scene.canvas.width - pad * 2 - gap * Math.max(columns.length - 1, 0)) /
      Math.max(columns.length, 1),
  );
  const top = pad + titleH + 6;
  const headH = scene.type.rowStep * 2;
  // A card is a two-tier, 56-high box: name and caption. DESIGN 3.2, 3.5.
  const cardH = 56;
  const cardStep = cardH + scene.type.rowStep;
  const deepest = Math.max(...columns.map((c) => c.cards.length), 1);
  // Content sets the height, not a fixed strip: as many rows as the deepest
  // column actually holds. DESIGN 7.4.
  const height = top + headH + deepest * cardStep + pad;

  // The column name already is the legend (DESIGN 5.3): Backlog/In progress/
  // Blocked/Done is a category the reader has without a swatch row spelling it
  // out. A left-edge stripe carries that colour onto the column and its cards
  // without touching either box's own fill or stroke — a second signal next
  // to the existing depth cue, not stacked on it (DESIGN 4.2).
  const coloured = columns.length <= SLOTS;
  columns.forEach((col, ci) => {
    const x = pad + ci * (colW + gap);
    const series = coloured ? ` gc-series-${ci}` : '';
    parts.push(
      `<g class="gc-board-column${series}" data-id="c-${ci}">` +
        `<rect class="gc-board-column-box" x="${round(x)}" y="${round(top)}" width="${round(colW)}" ` +
        `height="${round(height - top - pad)}" rx="${scene.panelRadius}"/>` +
        (coloured
          ? `<rect class="gc-board-column-stripe" x="${round(x + 12)}" y="${round(top + 8)}" width="${round(colW - 24)}" height="3" rx="1.5"/>`
          : '') +
        `<text class="gc-board-column-label" x="${round(x + 16)}" y="${round(top + 24)}">${esc(col.name)}</text>` +
        `<text class="gc-board-count" x="${round(x + colW - 16)}" y="${round(top + 24)}" text-anchor="end">${col.cards.length}</text>` +
        `</g>`,
    );
    col.cards.forEach((card, i) => {
      const y = top + headH + i * cardStep;
      marks.push({
        id: `k-${ci}-${i}`,
        markup:
          `<g class="gc-board-card${series}" data-id="k-${ci}-${i}">` +
          `<rect class="gc-board-card-box" x="${round(x + 12)}" y="${round(y)}" width="${round(colW - 24)}" height="${round(cardH)}" rx="${scene.radius}"/>` +
          (coloured
            ? `<rect class="gc-board-card-stripe" x="${round(x + 12)}" y="${round(y)}" width="3" height="${round(cardH)}" rx="1.5"/>`
            : '') +
          // Two-tier, 56-high box: name at y + 24, caption at y + 40. DESIGN 3.5.
          `<text class="gc-board-card-label" x="${round(x + 28)}" y="${round(y + 24)}">${esc(card.name)}</text>` +
          `<text class="gc-board-card-caption" x="${round(x + 28)}" y="${round(y + 40)}">${esc(card.caption)}</text>` +
          `</g>`,
      });
    });
  });

  return {
    width: pad * 2 + columns.length * colW + Math.max(columns.length - 1, 0) * gap,
    height, groups: columns.length,
    items: columns.reduce((n, c) => n + c.cards.length, 0),
  };
}

function animate(marks: Mark[], hasTitle: boolean, hasKicker: boolean, scene: Scene): { css: string; cycle: number } {
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
  // Wide enough apart, and short enough a fade, that one mark is mostly
  // finished before the next begins — a real sequence, not several marks
  // fading in at once because their windows overlap (DESIGN 5.4, "no real
  // unveiling sequence" was this: 0.14s between marks against a 0.56s fade
  // meant up to four were mid-fade together, regardless of the order they
  // were drawn in).
  const step = Math.min(0.22, 3.6 / Math.max(marks.length, 1));
  // Ribbons don't share the generic per-mark cadence — DESIGN 10.4's 0.15s
  // lag, reset at the start of each layer, so a layer's ribbons read as one
  // small wave rather than falling in line with everything else's spacing.
  // A ribbon grows over a full build beat (not a 0.3s snap): the flow should be
  // seen travelling. Ribbons in one layer start 0.12s apart, and the next layer
  // begins once the first ribbon of this one is about 60% across — the reveal
  // reads as one continuous pour, left to right, never as layers popping.
  const ribbonGrow = m.build * 1.6;
  const ribbonStart = new Map<string, number>();
  {
    let layer = -1;
    let base = scaffold + 0.15;
    let idx = 0;
    marks.forEach((mark) => {
      if (!mark.ribbon) return;
      if (mark.ribbon.layer !== layer) {
        if (layer !== -1) base = base + ribbonGrow * 0.6 + idx * 0.12;
        layer = mark.ribbon.layer; idx = 0;
      }
      ribbonStart.set(mark.id, base + idx * 0.12);
      idx++;
    });
  }
  const ribbonLast = Math.max(0, ...[...ribbonStart.values()].map((s) => s + ribbonGrow));
  const last = Math.max(
    scaffold + 0.15 + Math.max(marks.length - 1, 0) * step + m.build,
    ribbonLast,
  );
  const cycle = last + m.hold;

  const fade = (sel: string, from: number, over = Math.min(m.build * 0.8, step * 1.4)) => {
    const t = track(sel);
    t.at(0, { opacity: '0' });
    t.at(from, { opacity: '0' });
    t.at(from + over, { opacity: '1' });
    t.at(cycle, { opacity: '1' });
  };

  // A ribbon draws on rather than fading: a clip-path inset shrinks from its
  // own full width down to nothing, revealing it left to right, source to
  // target — DESIGN 8.2's "stroke draws on, then fill fades in" translated to
  // a filled band, which has no stroke to draw. `inset()` on an SVG shape is
  // relative to its own bounding box, so the width is the ribbon's own span
  // and nothing further out needs to be known here.
  const grow = (sel: string, from: number, widthPx: number, over: number) => {
    const t = track(sel);
    const hidden = `inset(0 ${widthPx.toFixed(2)}px 0 0)`;
    const shown = 'inset(0 0 0 0)';
    t.at(0, { 'clip-path': hidden, opacity: '0' });
    t.at(from, { 'clip-path': hidden, opacity: '0' });
    // opacity settles early so the growing edge is never a hard-edged pop
    t.at(from + over * 0.4, { opacity: '1' });
    t.at(from + over, { 'clip-path': shown, opacity: '1' });
    t.at(cycle, { 'clip-path': shown, opacity: '1' });
  };

  if (hasTitle) fade('.gc-board-title', lead, m.build * 0.7);
  if (hasKicker) fade('.gc-board-kicker', lead + 0.05, m.build * 0.7);
  fade('.gc-board-footnote', lead + 0.1, m.build * 0.7);
  fade('.gc-board-group', lead + 0.08);
  fade('.gc-board-column', lead + 0.08);
  marks.forEach((mark, i) => {
    const start = scaffold + 0.15 + i * step;
    if (mark.ribbon) {
      grow(`.gc-ribbon[data-id="${mark.id}"]`, ribbonStart.get(mark.id)!, mark.ribbon.width, ribbonGrow);
    } else {
      fade(`.gc-ribbon[data-id="${mark.id}"]`, start);
    }
    fade(`.gc-board-node[data-id="${mark.id}"]`, start);
    fade(`.gc-board-tile[data-id="${mark.id}"]`, start);
    fade(`.gc-board-card[data-id="${mark.id}"]`, start);
  });

  const rules: string[] = [];
  const frames: string[] = [];
  let i = 0;
  for (const [sel, value] of tracks) {
    if (value.empty) continue;
    const name = `gc-b${i++}`;
    rules.push(`${sel}{animation:${name} ${cycle.toFixed(2)}s ${m.ease} infinite}`);
    frames.push(`@keyframes ${name}{${value.frames(cycle)}}`);
  }
  return {
    cycle,
    css: `\n@media (prefers-reduced-motion: no-preference) {\n${rules.join('\n')}\n${frames.join('\n')}\n}\n`,
  };
}

export function boardCss(scene: Scene): string {
  const series = scene.series
    .map((c, i) => `.gc-series-${i} { --gc-mark: var(--gc-series-${i + 1}, ${c}); }`)
    .join('\n');
  return `
.gc-board-title { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.titleFont};
  font-weight: ${scene.type.titleWeight}; font-size: ${scene.type.title}px;
  letter-spacing: ${scene.type.titleTracking}; text-anchor: middle; }
/* DESIGN 7.1: the kicker under the title. Same role and styling as a cluster
   kicker (flow.ts .gc-cluster-kicker) — quiet, tracked mono caps. */
.gc-board-kicker { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.rowFont};
  font-size: ${scene.type.kicker}px; letter-spacing: ${scene.type.kickerTracking};
  text-anchor: middle; text-transform: uppercase; }
/* The ground colour behind a label, so it reads over whatever sits behind it. */
.gc-plate { fill: var(--gc-bg, ${scene.bg}); }
${series}
.gc-board-bar { fill: var(--gc-mark, var(--gc-path, ${scene.path})); }
/* Ribbons are translucent so a crossing reads as two flows rather than a third
   shape, and so the bars they meet stay the solid thing at each end. Flat: one
   fill, one opacity, no gradient and no second tint stacked on top. DESIGN 4.3. */
.gc-ribbon { fill: var(--gc-mark, var(--gc-path, ${scene.path})); fill-opacity: .35; }
.gc-board-label { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.titleFont};
  font-weight: ${scene.type.nameWeight}; font-size: ${scene.type.name}px; }
.gc-board-value { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.rowFont};
  font-size: ${scene.type.caption}px; font-variant-numeric: tabular-nums; }
/* A tile too small for the name+value pair still gets the name alone, centred,
   at the caption size — DESIGN 3.1's floor, not the name size's. */
.gc-board-tile-compact { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.rowFont};
  font-size: ${scene.type.caption}px; }

.gc-board-group-box { fill: var(--gc-surface, ${scene.surface}); }
.gc-board-group-label { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.rowFont};
  font-size: ${scene.type.label}px; letter-spacing: ${scene.type.labelTracking};
  text-transform: uppercase; }
.gc-board-tile-box { fill: var(--gc-mark, var(--gc-path, ${scene.path})); fill-opacity: .72; }
/* The "ALSO:" line under the chart, listing tiles whose label was hidden
   because it didn't fit. Same size and case as any other DESIGN 7.2 caption
   row: 8 mono caps, quiet, left-aligned. */
.gc-board-footnote { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.rowFont};
  font-size: ${scene.type.label}px; letter-spacing: ${scene.type.labelTracking};
  text-transform: uppercase; }

.gc-board-column-box { fill: var(--gc-surface, ${scene.surface}); }
/* Column header: 8 mono caps, the same role as a treemap group label — a fact
   about the group, not the group's own name at name weight. */
.gc-board-column-label { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.rowFont};
  font-size: ${scene.type.label}px; letter-spacing: ${scene.type.labelTracking};
  text-transform: uppercase; }
.gc-board-count { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.rowFont};
  font-size: ${scene.type.label}px; font-variant-numeric: tabular-nums; }
.gc-board-card-box { fill: var(--gc-bg, ${scene.bg}); stroke: var(--gc-edge, ${scene.edge});
  stroke-width: 1.25px; stroke-opacity: .45; }
/* The column's own colour, carried onto its cards — one flat fill, no second
   cue on the card box itself (DESIGN 4.2, 4.3). */
.gc-board-column-stripe { fill: var(--gc-mark, var(--gc-path, ${scene.path})); }
.gc-board-card-stripe { fill: var(--gc-mark, var(--gc-path, ${scene.path})); }
.gc-board-card-label { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.titleFont};
  font-weight: ${scene.type.nameWeight}; font-size: ${scene.type.name}px; }
.gc-board-card-caption { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.rowFont};
  font-size: ${scene.type.caption}px; }
`;
}
