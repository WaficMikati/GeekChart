import type { Graph, GraphNode } from '../graph.ts';
import type { Scene } from '../scene.ts';

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
 */
export function wrapTitle(
  title: string,
  measure: (s: string) => number,
  maxWidth: number,
): [string, string] | null {
  const words = title.split(/\s+/).filter(Boolean);
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
      return diamondSize(label.width, label.height, pad);
    case 'circle': {
      // The corner of the label box is the furthest point from the centre.
      const d = 2 * (Math.hypot(label.width, label.height) / 2 + pad);
      return { width: d, height: d };
    }
    case 'cylinder': {
      // The label has to clear the ellipse capping each end, not just the sides.
      const ry = Math.min(18, base.height * 0.2);
      return { width: base.width, height: base.height + ry * 2 };
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
