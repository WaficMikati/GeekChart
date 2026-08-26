/**
 * Small geometry helpers shared by the normalisation pass.
 *
 * Everything works in the SVG's root user space. Mermaid nests groups with their
 * own transforms, so node boxes and edge points are converted into that one
 * space before any comparison, and converted back before being written out.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const centreOf = (b: Box): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** Round to a multiple of `step`, away from zero. */
export const quantise = (value: number, step: number): number =>
  step <= 1 ? value : Math.ceil(value / step) * step;

export const overlaps = (aMin: number, aMax: number, bMin: number, bMax: number): boolean =>
  aMin < bMax && bMin < aMax;

/** Parse the `M x,y L x,y …` polyline mermaid emits with `curve: 'linear'`. */
export function parsePolyline(d: string): Point[] {
  const points: Point[] = [];
  const numbers = /[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi;
  for (const command of d.matchAll(/([MLml])([^MLmlCcSsQqTtAaZz]*)/g)) {
    const values = (command[2] ?? '').match(numbers)?.map(Number) ?? [];
    for (let i = 0; i + 1 < values.length; i += 2) {
      points.push({ x: values[i]!, y: values[i + 1]! });
    }
  }
  return points;
}

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

/** Drop points that sit on the line between their neighbours, within `epsilon`. */
export function simplify(points: Point[], epsilon = 0.6): Point[] {
  if (points.length < 3) return points;
  const out: Point[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1]!;
    const b = points[i]!;
    const c = points[i + 1]!;
    // Twice the triangle's area, over the base: the perpendicular offset of b.
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
    const base = distance(a, c);
    if (base === 0 || area / base > epsilon) out.push(b);
  }
  out.push(points[points.length - 1]!);
  return out;
}

/**
 * A path through the points with the corners rounded off.
 *
 * The radius at each corner is capped to half of the shorter adjacent segment,
 * so a tight elbow rounds less rather than overshooting into the next one — the
 * usual cause of a route that bulges away from where it should be.
 */
export function roundedPath(points: Point[], radius: number): string {
  if (points.length < 2) return '';
  if (points.length === 2 || radius <= 0) {
    return `M${points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('L')}`;
  }

  let d = `M${points[0]!.x.toFixed(2)},${points[0]!.y.toFixed(2)}`;
  // Where the path actually is right now — usually the previous corner's
  // `leave` point, which is not `points[i - 1]` once that corner rounded.
  let cursor = points[0]!;
  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1]!;
    const corner = points[i]!;
    const next = points[i + 1]!;
    const inLength = distance(previous, corner);
    const outLength = distance(corner, next);
    const r = Math.min(radius, inLength / 2, outLength / 2);
    if (r < 0.5) {
      d += `L${corner.x.toFixed(2)},${corner.y.toFixed(2)}`;
      cursor = corner;
      continue;
    }
    const enter = {
      x: corner.x + ((previous.x - corner.x) / inLength) * r,
      y: corner.y + ((previous.y - corner.y) / inLength) * r,
    };
    const leave = {
      x: corner.x + ((next.x - corner.x) / outLength) * r,
      y: corner.y + ((next.y - corner.y) / outLength) * r,
    };
    // Two corners close enough together each cap their radius at half of the
    // segment between them, so both `enter` and the previous corner's `leave`
    // can land on the same point — a run so short it is not a run, just a
    // duplicate coordinate the renderer draws as a zero-length segment
    // between two curves (state.mmd's Paused→Running). Go straight from one
    // curve into the next instead of bridging them with nothing.
    if (distance(cursor, enter) >= 0.5) d += `L${enter.x.toFixed(2)},${enter.y.toFixed(2)}`;
    d += `Q${corner.x.toFixed(2)},${corner.y.toFixed(2)} ${leave.x.toFixed(2)},${leave.y.toFixed(2)}`;
    cursor = leave;
  }
  const last = points[points.length - 1]!;
  d += `L${last.x.toFixed(2)},${last.y.toFixed(2)}`;
  return d;
}

/**
 * A node's outline, as a function that is 0 at the centre, 1 on the border and
 * greater than 1 outside.
 *
 * Expressing shapes this way means one boundary solver covers rectangles,
 * diamonds and ellipses alike — and a shape we have not thought of degrades to
 * its bounding box rather than to a broken edge.
 */
export interface Shape {
  centre: Point;
  /** Normalised distance: < 1 inside, 1 on the border, > 1 outside. */
  at(point: Point): number;
}

export function rectShape(box: Box): Shape {
  const centre = centreOf(box);
  const halfWidth = Math.max(box.width / 2, 0.001);
  const halfHeight = Math.max(box.height / 2, 0.001);
  return {
    centre,
    at: (p) =>
      Math.max(Math.abs(p.x - centre.x) / halfWidth, Math.abs(p.y - centre.y) / halfHeight),
  };
}

export function rhombusShape(centre: Point, a: number, b: number): Shape {
  return {
    centre,
    at: (p) =>
      Math.abs(p.x - centre.x) / Math.max(a, 0.001) + Math.abs(p.y - centre.y) / Math.max(b, 0.001),
  };
}

export function ellipseShape(centre: Point, a: number, b: number): Shape {
  return {
    centre,
    at: (p) =>
      Math.hypot((p.x - centre.x) / Math.max(a, 0.001), (p.y - centre.y) / Math.max(b, 0.001)),
  };
}

export const isInside = (shape: Shape, p: Point): boolean => shape.at(p) < 1;

/**
 * Where the segment from `outside` to a point inside crosses the border.
 *
 * Solved by bisection rather than algebraically, so the same routine serves
 * every shape. Thirty steps put the answer well below a pixel.
 *
 * `inner` defaults to the centre, which is what a chord-routed edge wants. An
 * orthogonal edge wants the ray to stay axis-aligned instead, so it passes the
 * point directly opposite its contact — otherwise the "vertical" ray leans
 * toward the centre and the contact slides off the column it belongs to.
 */
export function boundaryPoint(shape: Shape, outside: Point, inner: Point = shape.centre): Point {
  if (shape.at(outside) <= 1) return outside;
  if (shape.at(inner) > 1) return boundaryPoint(shape, outside, shape.centre);

  let low = 0;
  let high = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (low + high) / 2;
    const p = {
      x: outside.x + (inner.x - outside.x) * mid,
      y: outside.y + (inner.y - outside.y) * mid,
    };
    if (shape.at(p) > 1) low = mid;
    else high = mid;
  }
  const t = (low + high) / 2;
  return { x: outside.x + (inner.x - outside.x) * t, y: outside.y + (inner.y - outside.y) * t };
}

/**
 * Land a route exactly on the borders of the shapes it connects.
 *
 * Resizing a node leaves its edges buried under it or floating short of it, and
 * which of the two depends on whether the node grew or shrank. Recomputing both
 * endpoints against the shape handles either case, and is what makes an arrow
 * meet a box cleanly instead of nearly.
 */
export function attachToShapes(points: Point[], from: Shape | null, to: Shape | null): Point[] {
  const route = [...points];

  if (from) {
    while (route.length > 1 && isInside(from, route[0]!)) route.shift();
    const first = route[0];
    if (first) route.unshift(boundaryPoint(from, first));
    // A point exactly on the border produces a zero-length opening segment.
    if (
      route.length > 2 &&
      Math.hypot(route[1]!.x - route[0]!.x, route[1]!.y - route[0]!.y) < 0.5
    ) {
      route.splice(1, 1);
    }
  }

  if (to) {
    while (route.length > 1 && isInside(to, route[route.length - 1]!)) route.pop();
    const last = route[route.length - 1];
    if (last) route.push(boundaryPoint(to, last));
    const n = route.length;
    if (
      n > 2 &&
      Math.hypot(route[n - 1]!.x - route[n - 2]!.x, route[n - 1]!.y - route[n - 2]!.y) < 0.5
    ) {
      route.splice(n - 2, 1);
    }
  }

  if (route.length < 2 && from && to) {
    return [boundaryPoint(from, to.centre), boundaryPoint(to, from.centre)];
  }
  return route;
}

/** Pull the last point back along the route, leaving room for an arrowhead. */
export function shortenEnd(points: Point[], gap: number): Point[] {
  if (gap <= 0 || points.length < 2) return points;
  const route = [...points];
  let remaining = gap;
  while (route.length >= 2 && remaining > 0) {
    const last = route[route.length - 1]!;
    const previous = route[route.length - 2]!;
    const length = distance(previous, last);
    if (length > remaining) {
      const t = (length - remaining) / length;
      route[route.length - 1] = {
        x: previous.x + (last.x - previous.x) * t,
        y: previous.y + (last.y - previous.y) * t,
      };
      return route;
    }
    remaining -= length;
    route.pop();
  }
  return route.length >= 2 ? route : points;
}

/** Round to the nearest multiple of `step`. DESIGN 2.1's 8-grid. */
export const onGrid = (value: number, step = 8): number => Math.round(value / step) * step;

export const clamp = (value: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, value));

/**
 * Drop the points that carry no turn from an axis-aligned polyline.
 *
 * An orthogonal route is built by stitching stubs and elbows together, and the
 * joins routinely land on top of each other or in the middle of a straight run.
 * Left in, each one is a corner the rounding pass will try to round, which is
 * how a straight channel ends up with a wobble in it.
 */
export function tidyOrtho(points: Point[], epsilon = 0.5): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < epsilon && Math.abs(last.y - p.y) < epsilon) continue;
    out.push(p);
  }
  for (let i = 1; i < out.length - 1;) {
    const a = out[i - 1]!;
    const b = out[i]!;
    const c = out[i + 1]!;
    const straight =
      (Math.abs(a.x - b.x) < epsilon && Math.abs(b.x - c.x) < epsilon) ||
      (Math.abs(a.y - b.y) < epsilon && Math.abs(b.y - c.y) < epsilon);
    if (straight) out.splice(i, 1);
    else i++;
  }
  return out;
}

/**
 * Snap every segment of a polyline onto an axis.
 *
 * The router only ever emits axis-aligned points, but the shapes it attaches to
 * do not: a diamond's outline meets a vertical ray a fraction off the column it
 * was cast down, and a cylinder's cap is a curve. A tenth of a unit of slope is
 * invisible and still counts as a diagonal to anything measuring the drawing,
 * so the contact point is pulled onto its neighbour's axis rather than left to
 * round off later.
 */
export function squareOff(points: Point[], tolerance = 6): Point[] {
  const out = points.map((p) => ({ ...p }));
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1]!;
    const b = out[i]!;
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    if (dx === 0 || dy === 0) continue;
    // Whichever offset is the smaller is the error; collapse it.
    if (dx <= dy && dx <= tolerance) b.x = a.x;
    else if (dy < dx && dy <= tolerance) b.y = a.y;
    else if (dx <= dy) a.y = b.y;
    else a.x = b.x;
  }
  return out;
}

/** Total length of an axis-aligned polyline. */
export const polylineLength = (points: Point[]): number =>
  points.slice(1).reduce((sum, p, i) => sum + distance(points[i]!, p), 0);

/** The point `back` units from the end of a polyline, and the direction there. */
export function endOf(points: Point[], back = 0): { at: Point; dir: Point } {
  const last = points[points.length - 1]!;
  const previous = points[points.length - 2] ?? last;
  const len = distance(previous, last) || 1;
  const dir = { x: (last.x - previous.x) / len, y: (last.y - previous.y) / len };
  return { at: { x: last.x - dir.x * back, y: last.y - dir.y * back }, dir };
}

/** The same, measured from the start and pointing back the way the line came. */
export function startOf(points: Point[], back = 0): { at: Point; dir: Point } {
  const first = points[0]!;
  const next = points[1] ?? first;
  const len = distance(first, next) || 1;
  const dir = { x: (first.x - next.x) / len, y: (first.y - next.y) / len };
  return { at: { x: first.x - dir.x * back, y: first.y - dir.y * back }, dir };
}

/** Pull the first point forward along the route, leaving the box clear. */
export function shortenStart(points: Point[], gap: number): Point[] {
  if (gap <= 0 || points.length < 2) return points;
  const route = [...points].reverse();
  return shortenEnd(route, gap).reverse();
}
