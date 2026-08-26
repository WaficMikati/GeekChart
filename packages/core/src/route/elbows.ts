import { boundaryPoint, type Point, type Shape } from '../geometry.ts';
import { NORMALS, isVertical, type Extent, type Side } from './shared.ts';
import { faceLine } from './ports.ts';

/**
 * The curve and elbow geometry a route is actually built from. DESIGN 6.1:
 * orthogonal H/V with a single elbow, never a diagonal across another node.
 * DESIGN 6.2: a line meets a face perpendicular, at its outline, never a
 * corner. DESIGN 6.3: exactly one arrowhead, aligned to the last segment
 * within 1°.
 *
 * The chord router (`curve`, `connect`, `directCurve`) is kept for the
 * mermaid fallback path, where the geometry is somebody else's and a curve is
 * the only honest thing to draw. `elbows` and `contact` are what a
 * self-laid-out chart uses instead: it knows where every box is, so every
 * edge is a run of horizontal and vertical segments with the corners
 * rounded, and every arrowhead sits exactly on an axis.
 */

/**
 * One cubic from port to port.
 *
 * Each handle is half the distance measured *along its own normal*, so for two
 * facing ports both handles land on the midpoint between them and can never
 * cross. Crossing handles are what make a curve pinch and double back — the
 * single most common way a hand-tuned bezier goes wrong, and the reason the
 * earlier routes still looked kinked after the polyline was gone.
 *
 * Ports facing the same way (a retry leaving and re-entering from below) have
 * almost no separation along the normal, so those are sized from the distance
 * across it instead and given a floor to bow around the nodes.
 */
export function curve(
  start: Point,
  startSide: Side,
  end: Point,
  endSide: Side,
  gap: number,
  gapStart = 0,
): string {
  const a = NORMALS[startSide];
  const b = NORMALS[endSide];
  const tail = { x: start.x + a.x * gapStart, y: start.y + a.y * gapStart };
  const tip = { x: end.x + b.x * gap, y: end.y + b.y * gap };
  const delta = { x: tip.x - tail.x, y: tip.y - tail.y };

  const along = (n: Point) => Math.abs(delta.x * n.x + delta.y * n.y);
  const across = (n: Point) => Math.abs(delta.x * n.y - delta.y * n.x);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

  const sameWay = a.x * b.x + a.y * b.y > 0.5;
  const reach = (n: Point) =>
    sameWay ? clamp(across(n) * 0.3 + 48, 48, 260) : clamp(along(n) * 0.5, 24, 220);

  const hA = reach(a);
  const hB = reach(b);
  const c1 = { x: tail.x + a.x * hA, y: tail.y + a.y * hA };
  const c2 = { x: tip.x + b.x * hB, y: tip.y + b.y * hB };

  return (
    `M${tail.x.toFixed(2)},${tail.y.toFixed(2)} ` +
    `C${c1.x.toFixed(2)},${c1.y.toFixed(2)} ${c2.x.toFixed(2)},${c2.y.toFixed(2)} ` +
    `${tip.x.toFixed(2)},${tip.y.toFixed(2)}`
  );
}

export interface Connection {
  /** Path data for the line. */
  d: string;
  /** Where the head's point sits. */
  tip: Point;
  /** Unit vector the line is travelling at the tip. */
  dir: Point;
  /** Where the line leaves its source, and the direction back into it. */
  tail: Point;
  tailDir: Point;
}

/**
 * Connect two ports along the chord between them.
 *
 * This is the reconciliation of two things that pull in opposite directions. The
 * *contact point* stays on the middle of a face, because a line that lands on a
 * rounded corner reads as pointing at nothing. The *direction* is the chord
 * between those two contact points, not the face normal, so the line arrives at
 * whatever angle the geometry gives it and the head follows.
 *
 * Forcing the tangent to the normal is what made every arrow axis-aligned;
 * forcing the contact to the chord is what made them land on corners.
 */
export function connect(
  start: Point,
  end: Point,
  gapStart: number,
  gapEnd: number,
  bow = 0,
): Connection {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const span = Math.hypot(dx, dy) || 1;
  const u = { x: dx / span, y: dy / span };
  const perp = { x: -u.y, y: u.x };

  const tail = { x: start.x + u.x * gapStart, y: start.y + u.y * gapStart };
  const tip = { x: end.x - u.x * gapEnd, y: end.y - u.y * gapEnd };

  const reach = Math.hypot(tip.x - tail.x, tip.y - tail.y) / 3;
  const c1 = { x: tail.x + u.x * reach + perp.x * bow, y: tail.y + u.y * reach + perp.y * bow };
  const c2 = { x: tip.x - u.x * reach + perp.x * bow, y: tip.y - u.y * reach + perp.y * bow };

  return {
    d:
      `M${tail.x.toFixed(2)},${tail.y.toFixed(2)} ` +
      `C${c1.x.toFixed(2)},${c1.y.toFixed(2)} ${c2.x.toFixed(2)},${c2.y.toFixed(2)} ` +
      `${tip.x.toFixed(2)},${tip.y.toFixed(2)}`,
    tip,
    dir: bow === 0 ? u : normalise({ x: tip.x - c2.x, y: tip.y - c2.y }),
    tail,
    // Pointing back at the source, so a marker at this end is built exactly the
    // same way as one at the tip.
    tailDir: bow === 0 ? { x: -u.x, y: -u.y } : normalise({ x: tail.x - c1.x, y: tail.y - c1.y }),
  };
}

function normalise(v: Point): Point {
  const n = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / n, y: v.y / n };
}

/**
 * The arrowhead, as a path drawn at the line's own tangent.
 *
 * Not an SVG marker. A marker is scaled by `markerUnits`, fitted with
 * `preserveAspectRatio` and rotated about a reference point — three separate
 * chances for the head to end up a different size or angle from the line it
 * terminates, all of which happened. Constructing the triangle from the tangent
 * directly means it cannot disagree with the line.
 */
export function arrowHead(tip: Point, dir: Point, length: number, width: number): string {
  const perp = { x: -dir.y, y: dir.x };
  const base = { x: tip.x - dir.x * length, y: tip.y - dir.y * length };
  const half = width / 2;
  const left = { x: base.x + perp.x * half, y: base.y + perp.y * half };
  const right = { x: base.x - perp.x * half, y: base.y - perp.y * half };
  // A shallow notch so the line tucks in and the two read as one mark.
  const notch = { x: tip.x - dir.x * length * 0.82, y: tip.y - dir.y * length * 0.82 };
  const at = (p: Point) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  return `M${at(left)} L${at(tip)} L${at(right)} L${at(notch)} Z`;
}

/**
 * A line that meets each shape where it actually crosses it.
 *
 * Port routing anchors both ends to a face normal, so every edge arrives square
 * on and every arrowhead points along an axis whatever direction the line came
 * from. That reads as stiff, and it makes a head look bolted to the shape rather
 * than ending the line.
 *
 * Here the chord between the two centres sets the direction. Each end sits where
 * that chord crosses the outline — the true meeting point for a rectangle, a
 * rhombus or an ellipse alike — and the tangent runs along it, so the head is
 * already at the right angle with no correction.
 *
 * Edges leaving one node toward different targets separate on their own, since
 * each has its own chord. `bow` is only needed for two edges sharing a pair.
 */
export function directCurve(
  from: Shape,
  to: Shape,
  gapStart: number,
  gapEnd: number,
  bow = 0,
): string {
  const dx = to.centre.x - from.centre.x;
  const dy = to.centre.y - from.centre.y;
  const span = Math.hypot(dx, dy) || 1;
  const u = { x: dx / span, y: dy / span };
  const perp = { x: -u.y, y: u.x };

  const exit = boundaryPoint(from, { x: from.centre.x + u.x * 1e5, y: from.centre.y + u.y * 1e5 });
  const enter = boundaryPoint(to, { x: to.centre.x - u.x * 1e5, y: to.centre.y - u.y * 1e5 });

  const start = { x: exit.x + u.x * gapStart, y: exit.y + u.y * gapStart };
  const end = { x: enter.x - u.x * gapEnd, y: enter.y - u.y * gapEnd };

  const reach = Math.hypot(end.x - start.x, end.y - start.y) / 3;
  const c1 = { x: start.x + u.x * reach + perp.x * bow, y: start.y + u.y * reach + perp.y * bow };
  const c2 = { x: end.x - u.x * reach + perp.x * bow, y: end.y - u.y * reach + perp.y * bow };

  return (
    `M${start.x.toFixed(2)},${start.y.toFixed(2)} ` +
    `C${c1.x.toFixed(2)},${c1.y.toFixed(2)} ${c2.x.toFixed(2)},${c2.y.toFixed(2)} ` +
    `${end.x.toFixed(2)},${end.y.toFixed(2)}`
  );
}

/** Does this outline actually reach its bounding box's corners? */
export function isBoxy(shape: Shape, box: Extent): boolean {
  return shape.at({ x: box.x + 0.5, y: box.y + 0.5 }) <= 1.02;
}

/** Turn a face and a coordinate along it into a point on the real outline. */
export function contact(shape: Shape, box: Extent, side: Side, along: number): Point {
  const normal = NORMALS[side];
  const outside = isVertical(side)
    ? { x: along, y: faceLine(box, side) + normal.y * 1e4 }
    : { x: faceLine(box, side) + normal.x * 1e4, y: along };
  const inner = isVertical(side)
    ? { x: along, y: shape.centre.y }
    : { x: shape.centre.x, y: along };
  return boundaryPoint(shape, outside, inner);
}

/**
 * The turns that could join two stubs, best first.
 *
 * Both ends have already run straight out of their own face, so this only has to
 * join two free points with axis-aligned segments. Facing ends get a Z, and
 * *where* the Z crosses is the one degree of freedom an orthogonal route has —
 * so every usable crossing is offered rather than just the middle one, and the
 * caller takes the first that does not run through a box. Square ends have a
 * single corner and no choice. Anything that would have to double back returns
 * nothing, which is the caller's signal to route it around instead.
 */
export function elbows(
  p: Point,
  a: Point,
  q: Point,
  b: Point,
  obstacles: readonly Extent[] = [],
): Point[][] {
  const vertA = a.x === 0;
  const vertB = b.x === 0;
  const near = (u: number, v: number) => Math.abs(u - v) < 1;
  // The middle of the gap first, then progressively further either side of it.
  const lanes = (from: number, to: number): number[] => {
    const mid = (from + to) / 2;
    const room = Math.abs(to - from) / 2;
    const out = [mid];
    for (let step = 8; step <= room - 8; step += 8) out.push(mid + step, mid - step);
    return out;
  };
  // DESIGN 6.1: a Z (or V-H-V) route's middle segment sits at the midpoint of
  // the *free channel* either side of it, not at the raw midpoint of the two
  // stubs — a panel usually reaches further out than the node it holds, so
  // its outer edge, not the node's face, is the wall that actually bounds
  // the gap. `wallAxis` is the axis the returned coordinate lies on (the
  // channel runs across it); `extentLo/Hi` is the middle segment's own span,
  // on the other axis, that a wall must overlap to count. Mirrors the gate's
  // `offChannel` check in gate.mjs so a route that passes it here passes there.
  const channelMid = (
    wallAxis: 'x' | 'y',
    from: number,
    to: number,
    extentLo: number,
    extentHi: number,
  ): number | null => {
    const lo = Math.min(from, to),
      hi = Math.max(from, to);
    let leftWall = -Infinity,
      rightWall = Infinity;
    for (const box of obstacles) {
      const spanLo = wallAxis === 'x' ? box.y : box.x;
      const spanHi = spanLo + (wallAxis === 'x' ? box.height : box.width);
      if (spanHi <= extentLo || spanLo >= extentHi) continue;
      const wLo = wallAxis === 'x' ? box.x : box.y;
      const wHi = wLo + (wallAxis === 'x' ? box.width : box.height);
      if (wHi <= hi + 1) leftWall = Math.max(leftWall, wHi);
      if (wLo >= lo - 1) rightWall = Math.min(rightWall, wLo);
    }
    if (leftWall === -Infinity || rightWall === Infinity || leftWall > rightWall) return null;
    const want = (leftWall + rightWall) / 2;
    const snapped = Math.round(want / 8) * 8;
    return Math.abs(snapped - want) <= 4 ? snapped : want;
  };
  // Puts the channel-centred value first (if there is a real channel to
  // centre in) so the caller's first-zero-cost-wins search takes it over
  // the raw-midpoint fallbacks; those stay after it for anything the
  // channel candidate itself cannot clear.
  const centred = (values: number[], want: number | null): number[] =>
    want === null ? values : [want, ...values.filter((v) => Math.abs(v - want) > 0.5)];

  if (vertA && vertB) {
    if (!((q.y - p.y) * a.y > 0 && (q.y - p.y) * -b.y > 0)) return [];
    if (near(p.x, q.x)) return [[]];
    const want = channelMid('y', p.y, q.y, Math.min(p.x, q.x), Math.max(p.x, q.x));
    return centred(lanes(p.y, q.y), want).map((y) => [
      { x: p.x, y },
      { x: q.x, y },
    ]);
  }
  if (!vertA && !vertB) {
    if (!((q.x - p.x) * a.x > 0 && (q.x - p.x) * -b.x > 0)) return [];
    if (near(p.y, q.y)) return [[]];
    const want = channelMid('x', p.x, q.x, Math.min(p.y, q.y), Math.max(p.y, q.y));
    return centred(lanes(p.x, q.x), want).map((x) => [
      { x, y: p.y },
      { x, y: q.y },
    ]);
  }
  // One of each: a single corner, placed so the last segment runs into the face
  // it is aiming at rather than across it.
  if (vertA) {
    if ((q.y - p.y) * a.y < 0 || (q.x - p.x) * -b.x < 0) return [];
    return [[{ x: p.x, y: q.y }]];
  }
  if ((q.x - p.x) * a.x < 0 || (q.y - p.y) * -b.y < 0) return [];
  return [[{ x: q.x, y: p.y }]];
}
