import type { EdgeTip } from './graph.ts';
import { arrowHead } from './route.ts';
import type { Point } from './geometry.ts';

/**
 * How a line ends, drawn rather than markered.
 *
 * Same reasoning as the arrowhead: an SVG marker is scaled by `markerUnits`,
 * fitted with `preserveAspectRatio` and rotated about a reference point, so it
 * gets three separate chances to disagree with the line it terminates. These are
 * constructed from the line's own tangent instead, which makes disagreement
 * impossible.
 *
 * Crow's feet compose from two marks. The one *at* the entity is the maximum
 * cardinality and the one behind it is the minimum, which is exactly how the
 * source reads: in `||--o{`, the `{` touching the entity means "many" and the
 * `o` behind it means "or none".
 */

export interface TipDrawing {
  /** Solid shapes — arrowheads, filled diamonds. */
  fill: string;
  /** Stroked shapes — hollow triangles, bars, crow's feet, circles. */
  line: string;
}

const at = (p: Point) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;

export function tipPath(
  tip: Point,
  dir: Point,
  kind: EdgeTip,
  length: number,
  width: number,
): TipDrawing {
  const empty: TipDrawing = { fill: '', line: '' };
  if (kind === 'none') return empty;

  const perp: Point = { x: -dir.y, y: dir.x };
  /** A point `d` back from the contact point, along the line. */
  const back = (d: number): Point => ({ x: tip.x - dir.x * d, y: tip.y - dir.y * d });
  /** A point offset sideways from the line's axis. */
  const side = (d: number, off: number): Point => ({
    x: tip.x - dir.x * d + perp.x * off,
    y: tip.y - dir.y * d + perp.y * off,
  });
  /** A bar across the line at distance `d`. */
  const bar = (d: number, half: number) => `M${at(side(d, half))} L${at(side(d, -half))}`;
  /** A circle centred on the line at distance `d`. */
  const ring = (d: number, r: number) => {
    const c = back(d);
    return (
      `M${(c.x - r).toFixed(2)},${c.y.toFixed(2)} ` +
      `a${r.toFixed(2)},${r.toFixed(2)} 0 1,0 ${(r * 2).toFixed(2)},0 ` +
      `a${r.toFixed(2)},${r.toFixed(2)} 0 1,0 ${(-r * 2).toFixed(2)},0`
    );
  };
  /** Three prongs meeting behind the contact point and opening onto the shape. */
  const foot = (d: number, half: number) => {
    const apex = back(d);
    return (
      `M${at(apex)} L${at(side(0, half))} M${at(apex)} L${at(tip)} ` +
      `M${at(apex)} L${at(side(0, -half))}`
    );
  };

  switch (kind) {
    case 'arrow':
      return { fill: arrowHead(tip, dir, length, width), line: '' };

    // A lost or destroying message, drawn as a cross on the line's own axes so
    // it reads as a termination rather than a decoration.
    case 'cross': {
      const r = width * 0.42;
      const a = { x: dir.x * r, y: dir.y * r };
      const b = { x: perp.x * r, y: perp.y * r };
      const c = back(r);
      return {
        fill: '',
        line:
          `M${(c.x - a.x - b.x).toFixed(2)},${(c.y - a.y - b.y).toFixed(2)} ` +
          `L${(c.x + a.x + b.x).toFixed(2)},${(c.y + a.y + b.y).toFixed(2)} ` +
          `M${(c.x - a.x + b.x).toFixed(2)},${(c.y - a.y + b.y).toFixed(2)} ` +
          `L${(c.x + a.x - b.x).toFixed(2)},${(c.y + a.y - b.y).toFixed(2)}`,
      };
    }

    // A dependency is an open V, not a solid head — the difference from an
    // association is the whole point of the notation.
    case 'open': {
      const half = width * 0.62;
      return {
        fill: '',
        line: `M${at(side(length, half))} L${at(tip)} L${at(side(length, -half))}`,
      };
    }

    // Inheritance: a hollow triangle, deliberately larger than an arrowhead so
    // the empty interior is legible at feed size.
    case 'triangle': {
      const half = width * 0.62;
      return {
        fill: '',
        line: `M${at(tip)} L${at(side(length, half))} L${at(side(length, -half))} Z`,
      };
    }

    case 'diamond':
    case 'diamond-filled': {
      const half = width * 0.46;
      const d =
        `M${at(tip)} L${at(side(length * 0.5, half))} L${at(back(length))} ` +
        `L${at(side(length * 0.5, -half))} Z`;
      return kind === 'diamond-filled' ? { fill: d, line: '' } : { fill: '', line: d };
    }

    // The crow's-foot family. `length` is the reach of the foot; the minimum
    // mark sits just behind it.
    case 'many':
      return { fill: '', line: foot(length, width * 0.72) };
    case 'zero-many':
      return {
        fill: '',
        line: `${foot(length, width * 0.72)} ${ring(length * 1.55, length * 0.28)}`,
      };
    case 'one':
      return { fill: '', line: `${foot(length, width * 0.72)} ${bar(length * 1.5, width * 0.62)}` };
    case 'only-one':
      return {
        fill: '',
        line: `${bar(length * 0.35, width * 0.62)} ${bar(length * 0.95, width * 0.62)}`,
      };
    case 'zero-one':
      return {
        fill: '',
        line: `${bar(length * 0.35, width * 0.62)} ${ring(length * 1.15, length * 0.28)}`,
      };
    default:
      return empty;
  }
}

/** How far back from the shape a tip reaches, so the line can stop short of it. */
export function tipReach(kind: EdgeTip, length: number): number {
  switch (kind) {
    case 'none':
      return 0;
    case 'arrow':
      return 0;
    case 'cross':
      return length * 0.5;
    case 'open':
      return length * 0.5;
    case 'triangle':
    case 'diamond':
    case 'diamond-filled':
      return length;
    case 'many':
      return length;
    case 'zero-many':
    case 'one':
      return length * 1.8;
    case 'only-one':
    case 'zero-one':
      return length * 1.55;
    default:
      return 0;
  }
}
