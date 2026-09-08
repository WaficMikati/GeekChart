import type { Graph, GraphNode } from '../graph.ts';
import type { Scene } from '../scene.ts';

/** Datastore lid depth (DESIGN 2.2) — draw.ts shapes the lid with it. */
export const CYLINDER_LID = 5;

/**
 * Text measurement and per-shape fitting. DESIGN 2.2 (the fixed box-size
 * list and each shape's own geometry), 2.6 (a panel's title/kicker count as
 * content it has to hug too).
 */

/**
 * What every family's draw function actually needs from a measurer: width a
 * string, then release whatever host element it built. `makeMeasurer` (a
 * hidden SVG `<text>` + `getBBox()`) and `makeNodeMeasurer` in
 * `../node/measure.ts` (fontkit glyph advances, no browser at all) both
 * implement this, so a draw function that takes one doesn't care which.
 */
export interface Measurer {
  measure: (text: string, font: string, size: number, tracking?: string) => number;
  done: () => void;
}

/**
 * Measure a string without laying anything out permanently.
 *
 * `measureWith` is what the font role `inherit` resolves to here. The measuring
 * element inherits from this host, so naming the page's stack once makes every
 * inherited measurement match what the chart will meet when it gets there.
 */
export function makeMeasurer(measureWith?: string): Measurer {
  const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'position:fixed;left:-99999px;top:0;width:10px;height:10px;overflow:visible;';
  if (measureWith) host.style.fontFamily = measureWith;
  const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  host.appendChild(text);
  document.body.appendChild(host);

  return {
    measure(value, font, size, tracking = 'normal') {
      text.style.fontFamily = font;
      text.style.fontSize = `${size}px`;
      text.style.letterSpacing = tracking;
      text.textContent = value || ' ';
      return text.getBBox().width;
    },
    done() {
      host.remove();
    },
  };
}

/**
 * Every family draw function used to call `makeMeasurer(measureWith)` itself,
 * which hard-wires it to the browser. `measureWith` here is either that same
 * string (build the usual browser measurer) or an already-built `Measurer` —
 * the Node one, or a browser one a caller wants to reuse across renders —
 * passed straight through. This is the one place that distinction is made, so
 * `layout()`, `drawSequence`, `drawChronicle` and the rest stay one line each.
 */
export function resolveMeasurer(measureWith?: string | Measurer): Measurer {
  if (measureWith && typeof measureWith === 'object') return measureWith;
  return makeMeasurer(measureWith);
}

/**
 * Split a title into two lines at the word boundary that keeps both lines
 * under `maxWidth`, favouring the split whose wider line is narrowest.
 * A single unsplittable word, or a title with no space to break at, returns
 * `null` — the caller keeps the one-line label rather than force a break
 * that would leave a word overhanging.
 *
 * A lone `·` — the separator "Pandas · Django · #1 on TIOBE" uses between
 * facts — is welded onto the word before it before any split is considered,
 * so a break never lands between a word and the dot that follows it: the
 * dot stays at the end of the line it was already reading with, never
 * leading the next one ("· Django" reads as if a word went missing).
 */
export function wrapTitle(
  title: string,
  measure: (s: string) => number,
  maxWidth: number,
): [string, string] | null {
  const rawWords = title.split(/\s+/).filter(Boolean);
  const words: string[] = [];
  for (const w of rawWords) {
    if (w === '·' && words.length) words[words.length - 1] += ' ·';
    else words.push(w);
  }
  if (words.length < 2) return null;
  let best: { lines: [string, string]; worst: number } | null = null;
  for (let i = 1; i < words.length; i++) {
    const l1 = words.slice(0, i).join(' ');
    const l2 = words.slice(i).join(' ');
    const w1 = measure(l1);
    const w2 = measure(l2);
    const worst = Math.max(w1, w2);
    if (w1 <= maxWidth && w2 <= maxWidth && (!best || worst < best.worst)) {
      best = { lines: [l1, l2], worst };
    }
  }
  return best?.lines ?? null;
}

/**
 * The longest head of `text` that fits `maxWidth` once an ellipsis is added.
 *
 * Binary search on the character count rather than a per-glyph walk: the
 * measurer is the expensive part (a canvas call in the browser, a fontkit
 * lookup in Node), and a 60-character label settles in six measurements
 * instead of sixty. Trailing spaces and a trailing separator dot are trimmed
 * off the head so the ellipsis never follows a gap.
 */
export function shortenToWidth(
  text: string,
  measure: (s: string) => number,
  maxWidth: number,
): string {
  if (measure(text) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${text.slice(0, mid).trimEnd()}…`) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).replace(/[\s·]+$/, '')}…`;
}

/**
 * DESIGN 2.2's second half: a label that cannot be split into two lines that
 * both fit is **shortened**, never left to overhang the box.
 *
 * `wrapTitle` above finds the balanced split and is still the first choice —
 * it is the better-looking result and loses nothing. This is what happens when
 * no split fits at all: the first line takes as many whole words as the box
 * holds, the rest goes on the second, and the second is cut with an ellipsis if
 * it is still too long. Greedy rather than balanced on purpose — clipping the
 * tail of a title reads as a title that continues, while balancing first and
 * then clipping both lines drops the middle of the sentence and reads as
 * garbled.
 */
export function clampTitle(
  title: string,
  measure: (s: string) => number,
  maxWidth: number,
): [string] | [string, string] {
  const words = title.split(/\s+/).filter(Boolean);
  let first = '';
  let i = 0;
  while (i < words.length) {
    const next = first ? `${first} ${words[i]}` : words[i]!;
    if (first && measure(next) > maxWidth) break;
    first = next;
    i++;
  }
  // One word wider than the whole box: cut that word and stop. A second line
  // holding the tail of a broken word is worse than the ellipsis.
  if (i === 0) return [shortenToWidth(words[0] ?? title, measure, maxWidth)];
  const rest = words.slice(i).join(' ');
  const head = measure(first) > maxWidth ? shortenToWidth(first, measure, maxWidth) : first;
  return rest ? [head, shortenToWidth(rest, measure, maxWidth)] : [head];
}

/** What a node's own content demands, before any shared sizing is applied. */
export interface Metrics {
  node: GraphNode;
  /** The label block, excluding padding. */
  label: { width: number; height: number };
  /** Compartment rows: the widest line, how many there are, and how many groups. */
  rows: { width: number; count: number; groups: number };
}

// The rhombus edge is `bx + ay = ab`, so the label's corner (w/2, h/2) sits at
// perpendicular distance (ab - bw/2 - ah/2) / hypot(a, b). Setting that to the
// pad and fixing the aspect a = r*b leaves one equation in b. `r` matches the
// reference proportion. Kept as its own function, not inlined in `fitShape`'s
// diamond case, because DESIGN 1.1/1.6's packing needs the same formula run
// backwards (`diamondLabelBudget`, below) to ask "how wide can the label be
// and still fit" rather than "how wide is the shape for this label".
const DIAMOND_R = 1.85;
function diamondSize(
  labelWidth: number,
  labelHeight: number,
  pad: number,
): { width: number; height: number } {
  const b = (pad * Math.hypot(DIAMOND_R, 1) + labelWidth / 2 + (DIAMOND_R * labelHeight) / 2) / DIAMOND_R;
  return { width: 2 * DIAMOND_R * b, height: 2 * b };
}

/**
 * DESIGN 1.1/1.6: the label width a diamond could carry and still land at
 * `targetWidth` outer, at a given label height — the inverse of
 * `diamondSize`. Used only under a declared display, when a diamond's own
 * one-line label is what keeps the canvas over the cap after every other
 * packing move (leaf stacking, fold, sibling wrap) has had its turn: the row-
 * and chain-level packing those do cannot reach into one shape's own
 * geometry, so a diamond gets DESIGN 2.2's ordinary "wrap rather than widen"
 * instead of being left to force a scale-down of the whole chart.
 */
export function diamondLabelBudget(targetWidth: number, labelHeight: number, pad: number): number {
  const b = targetWidth / (2 * DIAMOND_R);
  return 2 * (DIAMOND_R * b - pad * Math.hypot(DIAMOND_R, 1) - (DIAMOND_R * labelHeight) / 2);
}

/**
 * Fit a shape around its own label.
 *
 * A blanket multiplier off the widest label in the diagram makes a diamond
 * enormous — it inherits the size of a box it has nothing to do with. Each
 * shape is solved against the text it actually contains instead.
 */
export function fitShape(
  m: Metrics,
  base: { width: number; height: number },
  scene: Scene,
  flow: 'horizontal' | 'vertical',
): { width: number; height: number } {
  const { label, rows } = m;
  const pad = scene.padShape;
  switch (m.node.shape) {
    case 'diamond':
      // A diamond solved from its own label, which is why one chart can hold
      // two diamonds of different sizes. DESIGN 2.4 asks for one size per
      // chart; the channel engine levels them to the largest after this runs
      // (`layout/index.ts`). The old path still ships them as they come out
      // here — five of its charts, python-or-java at 968 of a 1000 canvas
      // among them, are laid out around exactly these sizes.
      return diamondSize(label.width, label.height, pad);
    case 'circle': {
      // The corner of the label box is the furthest point from the centre.
      const d = 2 * (Math.hypot(label.width, label.height) / 2 + pad);
      return { width: d, height: d };
    }
    case 'cylinder': {
      // DESIGN 2.2, datastore: the 5px lid draws INSIDE the list size — a
      // datastore is a list-sized box now, so it ranks, aligns and shares a
      // row middle like every other box (was self-sizing: ellipse caps both
      // ends at up to 18 each).
      return { width: base.width, height: base.height };
    }
    case 'hexagon':
    case 'parallelogram':
    case 'trapezoid':
      // The slanted end steals horizontal room at the text's own height; the
      // clearance needed grows with how far the label sits from the centre line.
      return { width: base.width + pad * 2.2, height: base.height };

    // A compartmented box is sized by its own contents, never by the shared box.
    // Class boxes vary wildly in height and forcing them to a common size would
    // either clip the longest or leave the shortest mostly empty.
    case 'panel': {
      const header = scene.titleSize * 1.16 + scene.padY * 2;
      const body = rows.count ? rows.count * scene.rowStep + rows.groups * scene.padY : 0;
      // 200 is DESIGN 2.2's "wide" box, and a record is what it is for: a class
      // or entity table holds a column of declarations, so it is the one node
      // that is always the wide size rather than the 160 default.
      return {
        width: Math.max(200, Math.max(label.width, rows.width) + scene.padX * 2),
        height: header + body,
      };
    }
    // The state machine's endpoints and its fork bars are marks, not boxes: they
    // carry no label, so they get a fixed size rather than one derived from text.
    case 'dot':
      return { width: 22, height: 22 };
    case 'ring':
      return { width: 30, height: 30 };
    case 'bar':
      return flow === 'horizontal' ? { width: 8, height: 120 } : { width: 120, height: 8 };
    case 'note':
      // A note is an aside; sizing it to the shared box would give it the same
      // visual weight as the states it is annotating.
      return {
        width: label.width + scene.padX * 1.4,
        height: label.height + scene.padY * 1.8,
      };
    default:
      return base;
  }
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Everything that has been placed, as one box. */
export function extentOf(graph: Graph): Rect {
  const boxes: Rect[] = [
    ...graph.nodes
      .filter((n) => n.x !== undefined)
      .map((n) => ({
        x: n.x!,
        y: n.y!,
        width: n.width!,
        height: n.height!,
      })),
    ...graph.clusters
      .filter((c) => c.x !== undefined)
      .map((c) => ({
        x: c.x!,
        y: c.y!,
        width: c.width!,
        height: c.height!,
      })),
  ];
  if (!boxes.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: 0, y: 0, width: x1, height: y1 };
}
