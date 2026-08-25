import { boundaryPoint, squareOff, tidyOrtho, type Point, type Shape } from './geometry.ts';

/**
 * Draw every edge as one curve between two ports.
 *
 * No layout engine produces a route worth keeping. Dagre threads a polyline
 * through one dummy point per rank it crosses; ELK is tidier but still gives a
 * polyline. Rounding the corners of either does not make it smooth — it makes
 * the noise lumpy, which is exactly what a hand-drawn diagram never looks like.
 *
 * So the route is thrown away and replaced. Each end is anchored to a *port*: a
 * point on the centre of one face of the node, with a control point pushed
 * straight out along that face's normal. A single cubic between two such ports
 * cannot kink — it leaves the box square-on, arrives square-on, and bends once
 * in between. That squareness at the ends is most of what makes a diagram read
 * as drawn rather than computed.
 */

export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface EdgeEnds {
  path: SVGPathElement;
  from: SVGElement;
  to: SVGElement;
  fromShape: Shape;
  toShape: Shape;
}

const NORMALS: Record<Side, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

/** Which face an edge should leave from, given where the other node sits. */
export function sideToward(from: Shape, to: Shape, flow: 'horizontal' | 'vertical'): Side {
  const dx = to.centre.x - from.centre.x;
  const dy = to.centre.y - from.centre.y;
  // Follow the diagram's own direction unless the other node is clearly off-axis;
  // an edge that leaves sideways in a top-down chart reads as a mistake.
  const bias = flow === 'horizontal' ? 1.6 : 1 / 1.6;

  // Comparing centres alone misreads a wide target. A panel spanning most of the
  // page has its centre far to one side of an input sitting above its left end,
  // so the chord points sideways and the edge lands on the panel's *end* rather
  // than dropping onto its top. Asking whether the other shape spans us on an
  // axis answers "which face actually faces me", which is the real question.
  // My own extent decides first: if the other shape sits above me and I am wide
  // enough to be under it, my top faces it whatever the chord says.
  const iSpanX = from.at({ x: to.centre.x, y: from.centre.y }) <= 1;
  const iSpanY = from.at({ x: from.centre.x, y: to.centre.y }) <= 1;
  if (iSpanX && !iSpanY) return dy >= 0 ? 'bottom' : 'top';
  if (iSpanY && !iSpanX) return dx >= 0 ? 'right' : 'left';

  // Then theirs: leaving a small box for a wide panel below should go downward,
  // not off toward the panel's distant centre.
  const theySpanX = to.at({ x: from.centre.x, y: to.centre.y }) <= 1;
  const theySpanY = to.at({ x: to.centre.x, y: from.centre.y }) <= 1;
  if (theySpanX && !theySpanY) return dy >= 0 ? 'bottom' : 'top';
  if (theySpanY && !theySpanX) return dx >= 0 ? 'right' : 'left';

  if (Math.abs(dx) * bias >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

/** A point on the named face, `offset` along it from the centre (-0.5 … 0.5). */
export function portOn(shape: Shape, side: Side, offset: number): Point {
  const normal = NORMALS[side];
  const far = {
    x: shape.centre.x + normal.x * 10000,
    y: shape.centre.y + normal.y * 10000,
  };
  const centreOfFace = boundaryPoint(shape, far);
  // Slide along the face, then re-project so the port sits exactly on the outline
  // whatever the shape is — the middle of a diamond's edge, not of its bounding box.
  const along = side === 'left' || side === 'right' ? { x: 0, y: 1 } : { x: 1, y: 0 };
  const span =
    side === 'left' || side === 'right'
      ? Math.abs(boundaryPoint(shape, { x: shape.centre.x, y: shape.centre.y + 10000 }).y - shape.centre.y)
      : Math.abs(boundaryPoint(shape, { x: shape.centre.x + 10000, y: shape.centre.y }).x - shape.centre.x);
  const slid = {
    x: centreOfFace.x + along.x * offset * span * 1.1,
    y: centreOfFace.y + along.y * offset * span * 1.1,
  };
  if (offset === 0) return centreOfFace;
  const outward = { x: slid.x + normal.x * 10000, y: slid.y + normal.y * 10000 };
  return boundaryPoint(shape, outward);
}

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

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
export function connect(start: Point, end: Point, gapStart: number, gapEnd: number, bow = 0): Connection {
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
    tailDir: bow === 0
      ? { x: -u.x, y: -u.y }
      : normalise({ x: tail.x - c1.x, y: tail.y - c1.y }),
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

/** A node looping back to itself: a lobe off one face, drawn as two cubics. */
export function selfLoop(shape: Shape, side: Side, gap: number): string {
  const normal = NORMALS[side];
  const along = side === 'left' || side === 'right' ? { x: 0, y: 1 } : { x: 1, y: 0 };
  const start = portOn(shape, side, -0.35);
  const end = portOn(shape, side, 0.35);
  const reach = 46;
  const c1 = { x: start.x + normal.x * reach - along.x * 12, y: start.y + normal.y * reach - along.y * 12 };
  const c2 = { x: end.x + normal.x * (reach + gap) + along.x * 12, y: end.y + normal.y * (reach + gap) + along.y * 12 };
  const tip = { x: end.x + normal.x * gap, y: end.y + normal.y * gap };
  return (
    `M${start.x.toFixed(2)},${start.y.toFixed(2)} ` +
    `C${c1.x.toFixed(2)},${c1.y.toFixed(2)} ${c2.x.toFixed(2)},${c2.y.toFixed(2)} ` +
    `${tip.x.toFixed(2)},${tip.y.toFixed(2)}`
  );
}

/**
 * Assign ports and rewrite every edge.
 *
 * Ports are shared out across a face rather than stacked at its midpoint: two
 * edges leaving the same side of a box on the same point is the other classic
 * generated-diagram tell. They are ordered by where the far end sits, so the
 * lines fan out without crossing each other on the way.
 */
export interface PortPlan {
  startSide: Side;
  endSide: Side;
  startOffset: number;
  endOffset: number;
}

/**
 * Decide which face each edge leaves and arrives on, and where along it.
 *
 * Ports are shared out across a face rather than stacked at its midpoint: two
 * edges leaving the same side of a box on the same point is a classic
 * generated-diagram tell. They are ordered by where the far end sits, so lines
 * fan out without crossing each other on the way.
 */
/**
 * Which way a retry should swing out.
 *
 * It has to leave the corridor its forward edge already occupies, and there are
 * only two ways out. Always taking the same one drives the loop straight through
 * whatever happens to sit on that side — in a state machine with a branch, the
 * retry crossed the branch and passed through its sibling. Counting what is
 * actually in the way on each side costs nothing and picks the empty one.
 */
function loopSide(
  from: Shape,
  to: Shape,
  others: Point[],
  flow: 'horizontal' | 'vertical',
  // Sides `from` and `to` already spend on some other edge, so a genuine tie
  // can avoid landing the loop right where a straight edge already leaves —
  // which is what sent a retry out the same side its forward edge used,
  // instead of the empty side next to it (`messy.mmd`, DESIGN 6.7: "around
  // the content", not crossing back over the edge it answers).
  fromUsed?: ReadonlySet<Side>,
  toUsed?: ReadonlySet<Side>,
): Side {
  const vertical = flow === 'vertical';
  // The band the loop travels through, and how far out each node already sits.
  const lo = Math.min(vertical ? from.centre.y : from.centre.x, vertical ? to.centre.y : to.centre.x);
  const hi = Math.max(vertical ? from.centre.y : from.centre.x, vertical ? to.centre.y : to.centre.x);
  const near = Math.min(vertical ? from.centre.x : from.centre.y, vertical ? to.centre.x : to.centre.y);
  const far = Math.max(vertical ? from.centre.x : from.centre.y, vertical ? to.centre.x : to.centre.y);

  let ahead = 0;
  let behind = 0;
  for (const p of others) {
    const along = vertical ? p.y : p.x;
    const across = vertical ? p.x : p.y;
    if (along < lo - 1 || along > hi + 1) continue;
    if (across > far + 1) ahead++;
    else if (across < near - 1) behind++;
  }
  const positive: Side = vertical ? 'right' : 'bottom';
  const negative: Side = vertical ? 'left' : 'top';
  if (behind !== ahead) return behind < ahead ? negative : positive;

  // Tied: nothing along the corridor prefers a side. Prefer whichever side
  // isn't already where `from` or `to` sends a straight edge, so the loop
  // reads as its own path rather than doubling one that's already there.
  const busy = (side: Side) => (fromUsed?.has(side) ? 1 : 0) + (toUsed?.has(side) ? 1 : 0);
  const negBusy = busy(negative);
  const posBusy = busy(positive);
  if (negBusy !== posBusy) return negBusy < posBusy ? negative : positive;
  // Still tied: keep the old behaviour, the conventional side to loop on.
  return positive;
}

export function planPorts<T extends { id: string; from: string; to: string; backward?: boolean }>(
  edges: T[],
  shapeOf: (id: string) => Shape | undefined,
  flow: 'horizontal' | 'vertical',
  all: Shape[] = [],
): Map<string, PortPlan> {
  const plans = new Map<string, PortPlan>();
  // Which sides each node already spends on a straight edge, filled in as
  // edges are planned — so a later loop-back's tie-break (see `loopSide`) can
  // see what its own endpoints already committed to.
  const usedSides = new Map<string, Set<Side>>();
  const markUsed = (id: string, side: Side) => {
    const set = usedSides.get(id) ?? new Set<Side>();
    set.add(side);
    usedSides.set(id, set);
  };

  for (const edge of edges) {
    const from = shapeOf(edge.from);
    const to = shapeOf(edge.to);
    if (!from || !to) continue;

    if (edge.backward) {
      // A retry travels the same corridor as the edge it answers, in the other
      // direction, so routing it the obvious way hides it underneath. Send it
      // around instead: out of the cross face at both ends, which reads as a
      // loop rather than a duplicate line.
      const others = all
        .filter((shape) => shape !== from && shape !== to)
        .map((shape) => shape.centre);
      const side = loopSide(from, to, others, flow, usedSides.get(edge.from), usedSides.get(edge.to));
      plans.set(edge.id, { startSide: side, endSide: side, startOffset: 0, endOffset: 0 });
      markUsed(edge.from, side);
      markUsed(edge.to, side);
      continue;
    }

    const startSide = sideToward(from, to, flow);
    const endSide = sideToward(to, from, flow);
    markUsed(edge.from, startSide);
    markUsed(edge.to, endSide);
    plans.set(edge.id, {
      startSide,
      endSide,
      startOffset: 0,
      endOffset: 0,
    });
  }

  const buckets = new Map<string, { id: string; end: 'start' | 'end'; sort: number }[]>();
  for (const edge of edges) {
    const plan = plans.get(edge.id);
    const from = shapeOf(edge.from);
    const to = shapeOf(edge.to);
    if (!plan || !from || !to || edge.from === edge.to || edge.backward) continue;

    const push = (key: string, end: 'start' | 'end', sort: number) =>
      buckets.set(key, [...(buckets.get(key) ?? []), { id: edge.id, end, sort }]);

    const across = (side: Side, shape: Shape) =>
      side === 'left' || side === 'right' ? shape.centre.y : shape.centre.x;

    push(`${edge.from}:${plan.startSide}@${across(plan.startSide, from)}`, 'start', across(plan.startSide, to));
    push(`${edge.to}:${plan.endSide}@${across(plan.endSide, to)}`, 'end', across(plan.endSide, from));
  }

  for (const [key, members] of buckets) {
    if (members.length < 2) continue;
    const centre = Number(key.split('@').pop());

    // An edge whose far end is square-on keeps the middle of the face. Nudging
    // it aside to make room for a neighbour bends a straight hop into an S for
    // no reason — the fan exists to separate edges that genuinely diverge.
    const aligned = members.filter((m) => Math.abs(m.sort - centre) < 14);
    const fanned = members.filter((m) => !aligned.includes(m));
    for (const member of aligned) {
      const plan = plans.get(member.id)!;
      if (member.end === 'start') plan.startOffset = 0;
      else plan.endOffset = 0;
    }
    if (fanned.length < 1) continue;

    fanned.sort((a, b) => a.sort - b.sort);
    const slots = fanned.length + (aligned.length ? 1 : 0);
    const step = Math.min(0.3, 0.62 / Math.max(1, slots - 1));
    let index = 0;
    for (const member of fanned) {
      // Skip the middle slot when something is already sitting in it.
      const raw = index - (slots - 1) / 2;
      const offset = aligned.length && Math.abs(raw) < 0.4 ? raw + 1 : raw;
      const plan = plans.get(member.id)!;
      if (member.end === 'start') plan.startOffset = offset * step;
      else plan.endOffset = offset * step;
      index++;
    }
  }

  return plans;
}

export function routeEdges(
  edges: EdgeEnds[],
  flow: 'horizontal' | 'vertical',
  gap: number,
  toLocal: (path: SVGPathElement, p: Point) => Point,
): void {
  interface Assignment {
    edge: EdgeEnds;
    startSide: Side;
    endSide: Side;
    startOffset: number;
    endOffset: number;
  }

  const assignments: Assignment[] = edges.map((edge) => ({
    edge,
    startSide: sideToward(edge.fromShape, edge.toShape, flow),
    endSide: sideToward(edge.toShape, edge.fromShape, flow),
    startOffset: 0,
    endOffset: 0,
  }));

  // Group by the face each end lands on, then spread the ports across it.
  const buckets = new Map<string, { assignment: Assignment; end: 'start' | 'end'; sort: number }[]>();
  for (const assignment of assignments) {
    if (assignment.edge.from === assignment.edge.to) continue;
    const key = (node: SVGElement, side: Side) => `${node.getAttribute("id") ?? "n"}:${side}`;

    const startKey = key(assignment.edge.from, assignment.startSide);
    const startCross =
      assignment.startSide === 'left' || assignment.startSide === 'right'
        ? assignment.edge.toShape.centre.y
        : assignment.edge.toShape.centre.x;
    buckets.set(startKey, [...(buckets.get(startKey) ?? []), { assignment, end: 'start', sort: startCross }]);

    const endKey = key(assignment.edge.to, assignment.endSide);
    const endCross =
      assignment.endSide === 'left' || assignment.endSide === 'right'
        ? assignment.edge.fromShape.centre.y
        : assignment.edge.fromShape.centre.x;
    buckets.set(endKey, [...(buckets.get(endKey) ?? []), { assignment, end: 'end', sort: endCross }]);
  }

  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => a.sort - b.sort);
    const step = Math.min(0.34, 0.68 / (members.length - 1));
    const first = -(step * (members.length - 1)) / 2;
    members.forEach((member, i) => {
      const offset = first + step * i;
      if (member.end === 'start') member.assignment.startOffset = offset;
      else member.assignment.endOffset = offset;
    });
  }

  for (const assignment of assignments) {
    const { edge, startSide, endSide, startOffset, endOffset } = assignment;
    const d =
      edge.from === edge.to
        ? selfLoop(edge.fromShape, startSide, gap)
        : curve(
            portOn(edge.fromShape, startSide, startOffset),
            startSide,
            portOn(edge.toShape, endSide, endOffset),
            endSide,
            gap,
          );

    // The path lives in its own group's coordinates; the ports were computed in
    // the root's.
    const local = d.replace(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g, (_, x: string, y: string) => {
      const p = toLocal(edge.path, { x: Number(x), y: Number(y) });
      return `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
    });
    edge.path.setAttribute('d', local);
  }
}

/* ------------------------------------------------------------------------- *
 * Orthogonal routing. DESIGN 6.1, 6.2, 6.4, 6.7.
 *
 * The chord router above is kept for the mermaid fallback path, where the
 * geometry is somebody else's and a curve is the only honest thing to draw. A
 * chart this renderer lays out itself has no excuse for a diagonal: it knows
 * where every box is, so every edge is a run of horizontal and vertical
 * segments with the corners rounded, and every arrowhead is exactly on an axis.
 * ------------------------------------------------------------------------- */

/** The axis-aligned box an edge attaches to, or has to clear. */
export interface Extent { x: number; y: number; width: number; height: number }

/** Something a route must not run through. `holds` names a panel's children. */
export interface Obstacle { id: string; box: Extent; holds?: readonly string[] }

/** A finished route: where it runs, and which face it leaves and enters. */
export interface OrthoRoute {
  points: Point[];
  startSide: Side;
  endSide: Side;
}

/** Air kept between a contact point and the corner of the face it sits on. */
const FACE_INSET = 16;
/** How far a route runs straight out of a face before it is allowed to turn. */
const STUB = 24;
/** Clearance a loop keeps from the content it goes around. DESIGN 6.7. */
const LOOP_CLEAR = 24;
/** Clearance a route keeps from any node it does not connect to. DESIGN 6.1. */
const HUG_CLEAR = 16;

const isVertical = (side: Side): boolean => side === 'top' || side === 'bottom';

/** Where a face sits on the axis it is perpendicular to. */
function faceLine(box: Extent, side: Side): number {
  switch (side) {
    case 'left': return box.x;
    case 'right': return box.x + box.width;
    case 'top': return box.y;
    default: return box.y + box.height;
  }
}

const faceMiddle = (box: Extent, side: Side): number =>
  isVertical(side) ? box.x + box.width / 2 : box.y + box.height / 2;

/** The stretch of a face an edge may land on, with 10.2's air at each end. */
function faceRange(box: Extent, side: Side, sharp = false): [number, number] {
  const middle = faceMiddle(box, side);
  // A diamond or a circle has no flat side: its "top" is one point, and sliding
  // along the bounding box's top edge puts the contact on a slope, where the
  // head reads as glancing off rather than meeting it. DESIGN 2.4, 6.2.
  if (sharp) return [middle, middle];
  const [lo, hi] = isVertical(side)
    ? [box.x, box.x + box.width]
    : [box.y, box.y + box.height];
  const inset = Math.min(FACE_INSET, (hi - lo) / 2 - 1);
  return [lo + inset, hi - inset];
}

/** Does this outline actually reach its bounding box's corners? */
function isBoxy(shape: Shape, box: Extent): boolean {
  return shape.at({ x: box.x + 0.5, y: box.y + 0.5 }) <= 1.02;
}


/** Turn a face and a coordinate along it into a point on the real outline. */
function contact(shape: Shape, box: Extent, side: Side, along: number): Point {
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
function elbows(p: Point, a: Point, q: Point, b: Point, obstacles: readonly Extent[] = []): Point[][] {
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
    wallAxis: 'x' | 'y', from: number, to: number, extentLo: number, extentHi: number,
  ): number | null => {
    const lo = Math.min(from, to), hi = Math.max(from, to);
    let leftWall = -Infinity, rightWall = Infinity;
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
    return centred(lanes(p.y, q.y), want).map((y) => [{ x: p.x, y }, { x: q.x, y }]);
  }
  if (!vertA && !vertB) {
    if (!((q.x - p.x) * a.x > 0 && (q.x - p.x) * -b.x > 0)) return [];
    if (near(p.y, q.y)) return [[]];
    const want = channelMid('x', p.x, q.x, Math.min(p.y, q.y), Math.max(p.y, q.y));
    return centred(lanes(p.x, q.x), want).map((x) => [{ x, y: p.y }, { x, y: q.y }]);
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

/**
 * How much of a polyline runs through boxes it has no business being in, or
 * within DESIGN 6.1's 16-unit clearance of one.
 *
 * A run has no thickness, so its overlap along its own axis has to be asked as
 * "is the line between the box's two edges", not measured as an area — an area
 * test comes out zero for every axis-aligned segment there is, which is a check
 * that always passes and never says so.
 *
 * Every obstacle is measured expanded by `HUG_CLEAR`, not shrunk: a route that
 * merely grazes a foreign box — running along its edge with no gap — reads as
 * a mistake exactly like one that crosses it, and the final render is
 * remeasured against that same 16-unit margin (`gate.mjs`'s "hugging" check).
 * A skinny sliver of true clearance around the box's own perimeter is kept so
 * a stub leaving *this* box's own face is never mistaken for hugging it —
 * obstacles never include the edge's own endpoints, so this only ever
 * matters for a route sliding directly along a foreign box's outline.
 */
/** Do two open segments cross in their interior? A shared or touching
 * endpoint — two edges fanned from one port, or a stub meeting the next
 * segment of its own route — is not a crossing, hence the exclusive bounds. */
function segmentsCross(a0: Point, a1: Point, b0: Point, b1: Point): boolean {
  const d = (a1.x - a0.x) * (b1.y - b0.y) - (a1.y - a0.y) * (b1.x - b0.x);
  if (Math.abs(d) < 1e-6) return false;
  const t = ((b0.x - a0.x) * (b1.y - b0.y) - (b0.y - a0.y) * (b1.x - b0.x)) / d;
  const u = ((b0.x - a0.x) * (a1.y - a0.y) - (b0.y - a0.y) * (a1.x - a0.x)) / d;
  return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
}

/**
 * How many times a candidate route crosses a path an earlier forward edge has
 * already committed to. DESIGN 6.1: forward edges never cross.
 *
 * Edges are resolved in source order, so by the time edge N is routed, every
 * earlier forward edge's final path is known — routing edge N with this cost
 * in the mix is what "swapping lanes to avoid a crossing" actually is: the
 * side-pair and lane search below already picks whichever candidate is
 * cheapest, so a crossing only survives when nothing else was available at
 * any price. Weighted far above a node's clearance violation or a side
 * mismatch, so an available clear route always wins over one that crosses.
 */
/** One earlier forward edge's committed segment, kept with its own overall
 * ends so a shared start or end — a fan leaving one port, or two edges into
 * one arrival — can be told apart from a real coincidental overlap. */
export interface PlacedSeg { a: Point; b: Point; edgeStart: Point; edgeEnd: Point }

function crossingCost(points: Point[], placed: readonly PlacedSeg[]): number {
  let hits = 0;
  for (let i = 1; i < points.length; i++) {
    const a0 = points[i - 1]!, a1 = points[i]!;
    for (const { a: b0, b: b1 } of placed) {
      if (segmentsCross(a0, a1, b0, b1)) hits++;
    }
  }
  return hits * 2000;
}

const near = (p: Point, q: Point) => Math.abs(p.x - q.x) < 1.5 && Math.abs(p.y - q.y) < 1.5;

/**
 * How much of a candidate route runs collinear with an earlier forward
 * edge's segment. DESIGN 6.4: edges fan from separate points and never
 * converge on one run — two lines tracing the same stretch of the canvas
 * read as one, whether or not they end up crossing anywhere.
 *
 * A shared start or a shared end is the ordinary case of a fan or an
 * arrival continuing on in the same direction, and is not this. A run that
 * doubles back the *opposite* way from that same shared point — a loop-back
 * leaving right where the forward edge between the same two nodes arrives,
 * retracing its final stub instead of turning away from it — still reads as
 * two lines on one stretch of canvas, so it is charged like any other
 * overlap (`incident-response.mmd`'s Confirmed-intrusion retry, which used
 * to retrace Triage→Confirmed's own approach for the full width of its
 * stub because both share that exact contact point).
 */
function sharedRunCost(points: Point[], placed: readonly PlacedSeg[]): number {
  if (!points.length) return 0;
  const start = points[0]!, end = points[points.length - 1]!;
  const sharesEndpoint = (seg: PlacedSeg) =>
    near(start, seg.edgeStart) || near(start, seg.edgeEnd) ||
    near(end, seg.edgeStart) || near(end, seg.edgeEnd);
  let worst = 0;
  for (let i = 1; i < points.length; i++) {
    const a0 = points[i - 1]!, a1 = points[i]!;
    const vertA = Math.abs(a0.x - a1.x) < 0.5 && Math.abs(a0.y - a1.y) > 8;
    const horizA = Math.abs(a0.y - a1.y) < 0.5 && Math.abs(a0.x - a1.x) > 8;
    if (!vertA && !horizA) continue;
    for (const seg of placed) {
      const b0 = seg.a, b1 = seg.b;
      if (vertA) {
        if (Math.abs(b0.x - b1.x) >= 0.5 || Math.abs(a0.x - b0.x) > 1.5) continue;
        const sameDir = (a1.y - a0.y) * (b1.y - b0.y) >= 0;
        if (sameDir && sharesEndpoint(seg)) continue;
        const overlap = Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y)) -
          Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y));
        if (overlap > 8) worst = Math.max(worst, overlap);
      } else {
        if (Math.abs(b0.y - b1.y) >= 0.5 || Math.abs(a0.y - b0.y) > 1.5) continue;
        const sameDir = (a1.x - a0.x) * (b1.x - b0.x) >= 0;
        if (sameDir && sharesEndpoint(seg)) continue;
        const overlap = Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x)) -
          Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x));
        if (overlap > 8) worst = Math.max(worst, overlap);
      }
    }
  }
  return worst > 0 ? 2000 + worst : 0;
}

function intrusion(points: Point[], obstacles: Extent[]): number {
  const span = (lo: number, hi: number, from: number, to: number) =>
    lo === hi ? (lo > from && lo < to ? Infinity : -1) : Math.min(hi, to) - Math.max(lo, from);

  let worst = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    for (const box of obstacles) {
      const w = span(
        Math.min(a.x, b.x), Math.max(a.x, b.x), box.x - HUG_CLEAR, box.x + box.width + HUG_CLEAR);
      const h = span(
        Math.min(a.y, b.y), Math.max(a.y, b.y), box.y - HUG_CLEAR, box.y + box.height + HUG_CLEAR);
      if (w > 0 && h > 0) worst += Math.min(w, h) + 1;
    }
  }
  return worst;
}

/**
 * Does a candidate route double back through the very box it leaves or the
 * one it arrives at? DESIGN 6.2: only the first and last segment — the stubs
 * that necessarily start or end on the outline — may touch an edge's own
 * boxes; anything in between running back through one is a routing failure,
 * not a loop "going around" (gate.mjs's `selfPierce`, which this mirrors
 * segment-for-segment so a route that passes here passes there too).
 */
function selfPierce(points: readonly Point[], ownBoxes: readonly Extent[]): number {
  // Deliberately the same test as gate.mjs's own `selfPierce`, run against
  // the raw (pre-round) points instead of the flattened curve: a segment has
  // no thickness, so an ordinary min/max overlap comes out zero for every
  // axis-aligned run there is (`intrusion`'s own comment says as much) —
  // that reads as "never intrudes" for the exact horizontal or vertical
  // segment this is checking. The four-inequality box test doesn't have
  // that hole, since it never subtracts the degenerate axis from itself.
  let hits = 0;
  for (let i = 2; i < points.length - 1; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
    const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
    for (const box of ownBoxes) {
      if (x1 < box.x + box.width - 2 && x2 > box.x + 2 && y1 < box.y + box.height - 2 && y2 > box.y + 2) hits++;
    }
  }
  return hits;
}

/**
 * A structural guard against a "double corner": two bends only a hair apart.
 * `roundedPath` (geometry.ts) caps each corner's radius at half its shorter
 * adjacent run, at up to 12 (`draw.ts`'s `roundedPath(line, 12)`) — so an
 * interior run of 24 units or less gets a 12-unit arc eating into it from
 * both ends and is left with only a sliver of straight line, or none, where
 * one clean turn belongs. Charged on a loop's own candidates (not a forward
 * edge's, which DESIGN 6.1 already caps at 2 bends) so the nearest-corridor
 * search never wins a route by a handful of units at the cost of a notch a
 * viewer can see (4geeks-journey.mmd's Mentor pairing -> Portfolio projects
 * retry, once its own exit side no longer had to detour around its own box).
 */
function tightCornerCost(points: readonly Point[]): number {
  let cost = 0;
  for (let i = 2; i <= points.length - 2; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (len > 0.5 && len < 32) cost += 300;
  }
  return cost;
}

/** Total length of an axis-aligned polyline. Used to score loop corridors by
 * how far the resulting route actually runs — DESIGN 6.7's "nearest
 * corridor", not just whichever lane happens to be clean. */
function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.abs(points[i]!.x - points[i - 1]!.x) + Math.abs(points[i]!.y - points[i - 1]!.y);
  }
  return total;
}

/**
 * How far a "going around" route falls short of DESIGN 6.7's clearance on any
 * run that actually leaves `content` — never partly outside, either inside or
 * a full `clear` beyond the edge. Only a run's *own* perpendicular coordinate
 * counts, the same reading the gate and the Playwright suite both use: a
 * vertical stub is judged on how far its x sits from the left/right edge, not
 * on how high it happens to climb, so the ordinary reach a stub takes on its
 * way up to a properly-clear crossbar (passing through, never resting, short
 * of the edge) is never mistaken for a lane that clips the diagram. A lane
 * whose own axis lands short — a left/right lane for a loop whose stub runs
 * vertically first, and whose crossbar sits at whatever height the stub
 * naturally reached — is what this actually catches (`flow.mmd`'s D, 8 above
 * the diagram's own top, means the stub's usual 24-unit reach only clears it
 * by 16).
 */
function marginShortfall(points: readonly Point[], content: Extent, clear: number): number {
  const top = content.y, bottom = content.y + content.height;
  const left = content.x, right = content.x + content.width;
  let worst = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) > 40) {
      const x = (a.x + b.x) / 2;
      if (x < left) worst = Math.max(worst, Math.max(0, x - (left - clear)));
      if (x > right) worst = Math.max(worst, Math.max(0, (right + clear) - x));
    } else if (Math.abs(dy) < 0.5 && Math.abs(dx) > 40) {
      const y = (a.y + b.y) / 2;
      if (y < top) worst = Math.max(worst, Math.max(0, y - (top - clear)));
      if (y > bottom) worst = Math.max(worst, Math.max(0, (bottom + clear) - y));
    }
  }
  return worst;
}

/**
 * The open bands between rows or columns of boxes already on the canvas —
 * the corridors nearer than the canvas margin that a loop-back can travel
 * through. DESIGN 6.7: a loop takes the nearest corridor, not the outermost
 * one, so `detours` offers these alongside the four margin lanes and the
 * caller's own cost search picks whichever produces the shortest clean route.
 *
 * A box's near and far edge on the given axis (expanded by `clear`) is a
 * candidate wall; the point exactly between two such walls is only offered
 * when nothing else — expanded the same way — actually straddles it, which
 * is what makes it a real gap rather than a sliver next to some other box.
 */
function corridorGaps(
  axis: 'x' | 'y',
  content: Extent,
  obstacles: readonly Extent[],
  clear: number,
  // The stretch, on the *other* axis, the lane actually has to travel —
  // between the two stubs it joins. A box only matters to this search if it
  // sits somewhere along that stretch; one that is entirely above or below
  // it (a different row's box that just happens to share this lane's column)
  // is not something the lane ever runs alongside, and treating it as a wall
  // anyway is what forced a corridor two rows further out than the one
  // actually clear (`4geeks-journey.mmd`'s Mentor pairing → Portfolio
  // projects, blocked from its own row's gap by Prep course sitting in a row
  // it never passes through). Optional so the margin-only caller — there
  // isn't one today, but a bare axis search is still a sensible default —
  // keeps the old, whole-canvas behaviour.
  crossRange?: [number, number],
): number[] {
  const lo = axis === 'y' ? content.y : content.x;
  const hi = axis === 'y' ? content.y + content.height : content.x + content.width;
  const span = (box: Extent): [number, number] =>
    axis === 'y' ? [box.y, box.y + box.height] : [box.x, box.x + box.width];
  const crossSpan = (box: Extent): [number, number] =>
    axis === 'y' ? [box.x, box.x + box.width] : [box.y, box.y + box.height];
  const relevant = crossRange
    ? obstacles.filter((box) => {
        const [c0, c1] = crossSpan(box);
        return c1 > crossRange[0] && c0 < crossRange[1];
      })
    : obstacles;
  const marks = new Set<number>();
  for (const box of relevant) {
    const [a, b] = span(box);
    marks.add(Math.max(lo, a - clear));
    marks.add(Math.min(hi, b + clear));
  }
  const gaps: number[] = [];
  for (const at of marks) {
    if (at <= lo + 1 || at >= hi - 1) continue;
    const blocked = relevant.some((box) => {
      const [a, b] = span(box);
      return at > a - clear + 0.5 && at < b + clear - 0.5;
    });
    if (!blocked) gaps.push(at);
  }
  return gaps;
}

/**
 * Routes that go *around* rather than through. DESIGN 6.7.
 *
 * Used for a retry, and for anything the direct elbow could not get past. The
 * line leaves its face, runs out to a lane clear of everything drawn, travels
 * along that lane, and comes back in on the far side — one rounded orthogonal
 * path, which is what the rule asks for and what a free-form arc under the
 * diagram is not.
 *
 * All four margin lanes are offered, plus — when `extra` is given — a lane at
 * every interior corridor `corridorGaps` found; the caller picks by scoring
 * the resulting route, not by which lane happens to come first. A lane is
 * only offered when both ends can reach it without turning back through their
 * own box.
 */
function detours(
  start: Point,
  startSide: Side,
  end: Point,
  endSide: Side,
  p: Point,
  q: Point,
  content: Extent,
  clear: number,
  extra?: { y: number[]; x: number[] },
): { points: Point[]; side: Side }[] {
  const lanes: { side: Side; at: number }[] = [
    { side: 'top', at: content.y - clear },
    { side: 'bottom', at: content.y + content.height + clear },
    { side: 'left', at: content.x - clear },
    { side: 'right', at: content.x + content.width + clear },
  ];
  if (extra) {
    for (const y of extra.y) lanes.push({ side: 'top', at: y }, { side: 'bottom', at: y });
    for (const x of extra.x) lanes.push({ side: 'left', at: x }, { side: 'right', at: x });
  }
  const out: { points: Point[]; side: Side }[] = [];
  for (const lane of lanes) {
    const across = isVertical(lane.side);
    // A face may reach a lane it points at, or one at right angles to it.
    // Reaching a lane behind you means going back through your own box.
    const reaches = (side: Side) => isVertical(side) !== across || side === lane.side;
    if (!reaches(startSide) || !reaches(endSide)) continue;
    out.push({
      side: lane.side,
      points: across
        ? [start, p, { x: p.x, y: lane.at }, { x: q.x, y: lane.at }, q, end]
        : [start, p, { x: lane.at, y: p.y }, { x: lane.at, y: q.y }, q, end],
    });
  }
  return out;
}

/**
 * Which faces an edge should use, read from the boxes rather than the centres.
 *
 * Centres alone cannot tell a tree from a wrap. A director and the lead two
 * columns over have centres far apart sideways, so a centre comparison sends the
 * edge out of the director's *side* and it arrives at an angle; the boxes say
 * plainly that the lead is a whole band further down, which is the fact that
 * makes it a tree edge. A wrapped run is the same reading in reverse: the target
 * is behind along the flow but a band further across, so the edge goes down,
 * across and down instead of cutting back diagonally.
 */
export function facesFor(
  a: Extent,
  b: Extent,
  flow: 'horizontal' | 'vertical',
): { start: Side; end: Side } {
  const vertical = flow === 'vertical';
  const ahead: Side = vertical ? 'bottom' : 'right';
  const behind: Side = vertical ? 'top' : 'left';
  const crossPos: Side = vertical ? 'right' : 'bottom';
  const crossNeg: Side = vertical ? 'left' : 'top';

  const alongOf = (x: Extent): [number, number] =>
    vertical ? [x.y, x.y + x.height] : [x.x, x.x + x.width];
  const crossOf = (x: Extent): [number, number] =>
    vertical ? [x.x, x.x + x.width] : [x.y, x.y + x.height];

  const [a0, a1] = alongOf(a);
  const [b0, b1] = alongOf(b);
  const [ac0, ac1] = crossOf(a);
  const [bc0, bc1] = crossOf(b);

  // A whole band further along the flow: the flow's own faces.
  if (b0 >= a1 - 1) return { start: ahead, end: behind };
  // Behind along the flow but a band further across: the wrap. Down, across,
  // down — never a diagonal back to the start of the next row.
  if (bc0 >= ac1 - 1) return { start: crossPos, end: crossNeg };
  if (bc1 <= ac0 + 1) return { start: crossNeg, end: crossPos };
  if (b1 <= a0 + 1) return { start: behind, end: ahead };
  // Overlapping on both axes — rare, and whichever centre is further apart wins.
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? { start: 'right', end: 'left' } : { start: 'left', end: 'right' };
  return dy >= 0 ? { start: 'bottom', end: 'top' } : { start: 'top', end: 'bottom' };
}

interface Pending<T> {
  edge: T;
  startSide: Side;
  endSide: Side;
  startAlong: number;
  endAlong: number;
  /** Set when the two contacts share a coordinate and the run is one straight line. */
  channel: boolean;
  loop: boolean;
}

/**
 * Where along each face the two ends should sit.
 *
 * The rule that matters is DESIGN 2.6's: an input above a panel and the output
 * below it line up column for column, so the channel between them is one
 * straight vertical. That falls out of asking whether the narrower face's middle
 * lands inside the wider one — if it does, both ends take that coordinate and
 * there is nothing left to bend. If it does not, each end keeps its own middle
 * and the elbow does the work.
 */
function alignEnds(
  a: Extent, startSide: Side, sharpA: boolean,
  b: Extent, endSide: Side, sharpB: boolean,
) {
  const parallel = isVertical(startSide) === isVertical(endSide);
  const startMid = faceMiddle(a, startSide);
  const endMid = faceMiddle(b, endSide);
  if (!parallel || startSide === endSide) {
    return { startAlong: startMid, endAlong: endMid, channel: false };
  }
  const [al, ah] = faceRange(a, startSide, sharpA);
  const [bl, bh] = faceRange(b, endSide, sharpB);
  const lo = Math.max(al, bl);
  const hi = Math.min(ah, bh);
  if (lo > hi) return { startAlong: startMid, endAlong: endMid, channel: false };
  const shared =
    startMid >= lo && startMid <= hi ? startMid
      : endMid >= lo && endMid <= hi ? endMid
        : (lo + hi) / 2;
  return { startAlong: shared, endAlong: shared, channel: true };
}

/**
 * Plan every edge at once.
 *
 * Done together rather than one at a time because separating two edges that
 * share a face is only possible when both are known. DESIGN 6.4: they fan from
 * separate points, 8 apart, and never stack on one.
 */
export function planRoutes<T extends { id: string; from: string; to: string; backward?: boolean }>(
  edges: T[],
  boxOf: (id: string) => Extent | undefined,
  shapeOf: (id: string) => Shape | undefined,
  flow: 'horizontal' | 'vertical',
  content: Extent,
  obstacles: Obstacle[] = [],
): Map<string, OrthoRoute> {
  const pending: Pending<T>[] = [];
  // Every node's own box, keyed once — the backward branch below needs "every
  // other node" (not just every edge's *from*, which drops a leaf that is
  // only ever a *to*, and double-counts a node with several outgoing edges).
  const nodeIds = new Set<string>();
  for (const edge of edges) { nodeIds.add(edge.from); nodeIds.add(edge.to); }
  const nodeCentres = new Map<string, Point>();
  for (const id of nodeIds) {
    const box = boxOf(id);
    if (box) nodeCentres.set(id, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }
  // Which sides each node already spends on a straight edge — same reasoning
  // as planPorts's usedSides: a tied loop shouldn't land on the side a
  // straight edge already leaves, which is what sent a retry out on top of
  // the edge it answers instead of the empty side beside it.
  const usedSides = new Map<string, Set<Side>>();
  const markUsed = (id: string, side: Side) => {
    const set = usedSides.get(id) ?? new Set<Side>();
    set.add(side);
    usedSides.set(id, set);
  };

  // The face each node's first forward in-edge arrives on. DESIGN 6.2: a
  // loop-back reads as "you are back at this step", so it has to land on the
  // same face the normal way in already uses — never wherever the corridor
  // search finds the clearest lane, which is what put a retry into a
  // target's side while every forward arrow into it lands on top. Read from
  // `facesFor`, the same geometry a forward edge's own faces come from, so a
  // node a fold wrapped onto a face other than the chart's default (an
  // "along" arrival lands on top even in an LR chart, once a wrap stacks two
  // rows) is picked up here too.
  const flowInSide = new Map<string, Side>();
  for (const edge of edges) {
    if (edge.backward || edge.from === edge.to || flowInSide.has(edge.to)) continue;
    const a = boxOf(edge.from);
    const b = boxOf(edge.to);
    if (!a || !b) continue;
    flowInSide.set(edge.to, facesFor(a, b, flow).end);
  }
  const defaultFlowIn: Side = flow === 'vertical' ? 'top' : 'left';

  for (const edge of edges) {
    const a = boxOf(edge.from);
    const b = boxOf(edge.to);
    if (!a || !b) continue;
    if (edge.from === edge.to) {
      pending.push({
        edge, startSide: 'top', endSide: 'top',
        startAlong: a.x + a.width * 0.34, endAlong: a.x + a.width * 0.66,
        channel: false, loop: true,
      });
      continue;
    }
    if (edge.backward) {
      const others = [...nodeCentres.entries()]
        .filter(([id]) => id !== edge.from && id !== edge.to)
        .map(([, c]) => c);
      const fromShape = { centre: nodeCentres.get(edge.from)!, at: () => 0 };
      const toShape = { centre: nodeCentres.get(edge.to)!, at: () => 0 };
      // The arriving side is fixed first — DESIGN 6.2 pins it to the
      // target's own flow-in face, so the retry reads as returning to the
      // same step rather than sneaking in a different door.
      const endSideChoice = flowInSide.get(edge.to) ?? defaultFlowIn;
      // The exit side comes from the corridor: which side is clearer of
      // everything between the two ends (DESIGN 6.7's "around"). It has to
      // pick from the axis *perpendicular* to the arriving face, not the
      // chart's own flow axis — a lane that shares the arriving face's axis
      // can only be reached by doubling the stub back on itself (a fold can
      // land a target's flow-in face across the flow, on the same axis the
      // corridor search would otherwise use, which is exactly what sent
      // `4geeks-journey.mmd`'s Prep-course retry the long way round with a
      // hook at the far end instead of one clean turn).
      //
      // This is only a starting guess, not the final word: when the
      // perpendicular swing has to cross a whole extra row to get back to a
      // horizontal-facing arrival — `4geeks-journey.mmd`'s Mentor pairing →
      // Portfolio projects, arriving on Portfolio's left with a full row of
      // other boxes between them — the corridor it finds cuts back through
      // its own box (DESIGN 6.2) rather than actually going around. The
      // self-pierce check on every candidate route, below, catches that and
      // sends this same edge through the full every-side search a few lines
      // down, which is what actually lands it on the matching left face and
      // a real, straight corridor.
      const startSideChoice = loopSide(
        fromShape, toShape, others,
        isVertical(endSideChoice) ? 'vertical' : 'horizontal',
        usedSides.get(edge.from), usedSides.get(edge.to),
      );
      pending.push({
        edge, startSide: startSideChoice, endSide: endSideChoice,
        startAlong: faceMiddle(a, startSideChoice), endAlong: faceMiddle(b, endSideChoice),
        channel: false, loop: true,
      });
      markUsed(edge.from, startSideChoice);
      markUsed(edge.to, endSideChoice);
      continue;
    }
    const { start, end } = facesFor(a, b, flow);
    const sharpA = !isBoxy(shapeOf(edge.from)!, a);
    const sharpB = !isBoxy(shapeOf(edge.to)!, b);
    const placed = alignEnds(a, start, sharpA, b, end, sharpB);
    pending.push({ edge, startSide: start, endSide: end, ...placed, loop: false });
    markUsed(edge.from, start);
    markUsed(edge.to, end);
  }

  // Fan the ends that would otherwise land on the same point. A straight channel
  // keeps its coordinate — moving it aside would bend a straight run for nothing,
  // and two channels on one face already differ because their columns do.
  //
  // An arriving edge and a departing edge that both use the same face — one
  // edge ending at a node's top, a different edge leaving from that same top —
  // share the bucket too, not just two edges that both start or both end
  // there. Keeping them in separate buckets (start vs end) let two unrelated
  // edges plant a contact point at the exact same face-middle coordinate and
  // then run collinear for a stretch right at the node, which is DESIGN 6.4's
  // "never converging on one pixel" whether the edges are going the same way
  // or not (`state.mmd`'s Running→Graduated arrival and Graduated→root_end
  // departure, both dead centre on Graduated's top face).
  interface Member { item: Pending<T>; end: boolean }
  const buckets = new Map<string, Member[]>();
  const key = (node: string, side: Side) => `${node}:${side}`;
  for (const item of pending) {
    if (item.loop) continue;
    if (!item.channel) {
      const k = key(item.edge.from, item.startSide);
      buckets.set(k, [...(buckets.get(k) ?? []), { item, end: false }]);
    }
    if (!item.channel) {
      const k = key(item.edge.to, item.endSide);
      buckets.set(k, [...(buckets.get(k) ?? []), { item, end: true }]);
    }
  }
  for (const [k, members] of buckets) {
    if (members.length < 2) continue;
    const nodeId = k.slice(0, k.lastIndexOf(':'));
    const box = boxOf(nodeId);
    if (!box) continue;
    const side = members[0]!.end ? members[0]!.item.endSide : members[0]!.item.startSide;
    const shape = shapeOf(nodeId);
    const [lo, hi] = faceRange(box, side, shape ? !isBoxy(shape, box) : false);
    // DESIGN 6.3: several edges arriving on the same side merge into one
    // trunk with a single arrowhead at the side's centre — the fan-in
    // mirror of the departing bus below. A bucket that is nothing *but*
    // arrivals (no edge also leaves this face) converges instead of
    // spreading; draw.ts gives every arriving edge but one no head.
    if (members.every((m) => m.end)) {
      const middle = faceMiddle(box, side);
      for (const m of members) m.item.endAlong = middle;
      continue;
    }
    // Sorted by where the far end sits, so the lines fan out without crossing.
    const far = (m: Member) => {
      const other = boxOf(m.end ? m.item.edge.from : m.item.edge.to);
      return other ? faceMiddle(other, side) : 0;
    };
    const order = [...members].sort((p, q) => far(p) - far(q));
    // One edge to a whole row of siblings reads as a bus, and a bus wants a
    // single trunk. It only becomes a fan when the ends would otherwise be
    // indistinguishable, which is when the far ends are on the same side.
    const step = 8;
    const width = step * (order.length - 1);
    const middle = faceMiddle(box, side);
    let first = middle - width / 2;
    if (first < lo) first = lo;
    if (first + width > hi) first = Math.max(lo, hi - width);
    order.forEach((m, i) => {
      const at = first + step * i;
      if (m.end) m.item.endAlong = at;
      else m.item.startAlong = at;
    });
  }

  // What each edge actually settled on, kept apart from `routes` until every
  // edge has one: a face fought over by two edges (see below) can only be
  // told apart once both sides of the fight are known.
  interface Resolved {
    edgeId: string;
    item: Pending<T>;
    ss: Side;
    es: Side;
    sAlong: number;
    eAlong: number;
    mustGoRound: boolean;
    points: Point[];
    rebuild: (sAlong: number, eAlong: number) => Point[];
  }
  const resolved: Resolved[] = [];
  let lane = 0;
  // How many edges already landed on a given node's face, filled in as edges
  // resolve. An edge arriving at a node and a later, unrelated edge leaving
  // from the same face read as one line for a stretch right at the node —
  // `state.mmd`'s Graduated→root_end retry, pushed onto Graduated's top face
  // by the alternate-pair search below because that face was clear of boxes,
  // lands squarely on top of Running→Graduated's own arrival there and of
  // its label. A face already spending itself on a straight edge is charged
  // for here so a search only lands a second edge on it when every quieter
  // face is genuinely worse, the same reasoning `loopSide`'s tie-break uses.
  const faceLoad = new Map<string, number>();
  const loadKey = (node: string, side: Side) => `${node}:${side}`;
  // Every forward edge's final segments, committed in the order below — see
  // `crossingCost` and `sharedRunCost`.
  const placedForwardSegs: PlacedSeg[] = [];
  // Shortest chord first. A short hop between neighbouring nodes has almost
  // no room to go anywhere else, so it gets first claim on its lane; a long
  // edge that reaches far across the diagram (a branch to an outlying node,
  // `regex-engine.mmd`'s AT→NO) has many more ways to get there and is the
  // one that should bend around everything already placed, not the other
  // way round. Placing it first — source order did this, since NO's branch
  // happened to come before the next chain link in the mermaid text — is
  // what left the short DM→DT hop with nowhere clear to cross it.
  const chordLen = (item: Pending<T>): number => {
    const ac = nodeCentres.get(item.edge.from);
    const bc = nodeCentres.get(item.edge.to);
    if (!ac || !bc) return 0;
    return Math.hypot(bc.x - ac.x, bc.y - ac.y);
  };
  const order = [...pending].sort((p, q) => chordLen(p) - chordLen(q));
  for (const item of order) {
    const a = boxOf(item.edge.from)!;
    const b = boxOf(item.edge.to)!;
    const fromShape = shapeOf(item.edge.from);
    const toShape = shapeOf(item.edge.to);
    if (!fromShape || !toShape) continue;
    // Frozen now, not read live: `build` (and the `rebuild` closure the fan
    // pass calls after every edge — loop or not — has resolved) must see the
    // lane this edge was actually given, not however far the shared counter
    // has moved on by the time something calls back into it. A second loop
    // elsewhere in the chart advancing `lane` between this edge's own
    // resolution and its later rebuild used to hand it a wider clearance on
    // rebuild than the search ever scored, silently swapping in whichever
    // corridor happened to be zero-cost at that different width.
    const myLane = lane;
    // `rebuild` below calls back into this edge's own search after every
    // edge has resolved, for the fan pass to nudge its along-position. By
    // then `placedForwardSegs` holds edges this one was never compared
    // against the first time (chord order, not source order) — without this
    // boundary, that replay could cross an edge processed *after* it and
    // silently pick a different, worse route than the one just chosen
    // (`regex-engine.mmd`'s TLD→OK: resolved clean, then re-picked a 4-bend
    // detour on rebuild once AT→NO's later segments joined the list).
    const placedBeforeThisEdge = placedForwardSegs.length;

    const sharpA = !isBoxy(fromShape, a);
    const sharpB = !isBoxy(toShape, b);
    const [al, ah] = faceRange(a, item.startSide, sharpA);
    const [bl, bh] = faceRange(b, item.endSide, sharpB);
    const startAlong = Math.max(al, Math.min(ah, item.startAlong));
    const endAlong = Math.max(bl, Math.min(bh, item.endAlong));

    const start = contact(fromShape, a, item.startSide, startAlong);
    const end = contact(toShape, b, item.endSide, endAlong);
    // The straight run out of a face is capped by how much room there actually
    // is. Two boxes 20 apart cannot both push 24 clear of themselves — the
    // stubs cross, the route reads as doubling back, and it used to be sent all
    // the way around the diagram to join two neighbours.
    //
    // Only faces that point at each other can collide, though. Two ends leaving
    // the *same* way — the top of one box and the top of another, which is what
    // a loop back is — have no shared gap to run out of, and capping them there
    // left a retry leaving its box by five units and turning immediately.
    const reach = (n: Point, other: Point, from: Point, to: Point) => {
      if (n.x * other.x + n.y * other.y >= 0) return STUB;
      const room = (to.x - from.x) * n.x + (to.y - from.y) * n.y;
      return Math.max(4, Math.min(STUB, room > 0 ? room * 0.45 : STUB));
    };

    // Every drawn box, own endpoints included — what DESIGN 6.1's channel
    // centring measures against (see `elbows`'s `channelMid`). Unlike
    // `blockers` below, the edge's own ends and their panels stay in: a
    // panel usually reaches out past the node it holds, so it is often the
    // nearer wall, and an endpoint's own box never wins the nearest-wall
    // search over a wall that is actually closer to the gap.
    const wallBoxes = obstacles.map((o) => o.box);

    // Nothing an edge does not connect to may sit on its route. A cluster
    // holding either end is not an obstacle — the edge is meant to be inside it.
    const blockers = obstacles
      .filter((o) =>
        o.id !== item.edge.from && o.id !== item.edge.to &&
        !o.holds?.includes(item.edge.from) && !o.holds?.includes(item.edge.to))
      .map((o) => o.box);

    // Where a detour actually needs to swing out to. A retry has to clear the
    // whole diagram — that is the loop DESIGN 6.7 describes. An ordinary edge
    // that only lost to one box in its way does not: going all the way to the
    // canvas edge to dodge a single neighbour is the "nonsensical" loop this
    // used to draw for any blocked edge, loop or not, because both shared the
    // same full-content lanes. The bounds here are the smallest box that still
    // contains both ends and whatever is actually between them, so a local
    // dodge stays local.
    const detourBounds: Extent = item.loop
      ? content
      : (() => {
          const pad = 40;
          const x0 = Math.min(a.x, b.x) - pad;
          const y0 = Math.min(a.y, b.y) - pad;
          const x1 = Math.max(a.x + a.width, b.x + b.width) + pad;
          const y1 = Math.max(a.y + a.height, b.y + b.height) + pad;
          const nearby = blockers.filter(
            (box) => box.x < x1 && box.x + box.width > x0 && box.y < y1 && box.y + box.height > y0,
          );
          const boxes = [a, b, ...nearby];
          return {
            x: Math.min(...boxes.map((box) => box.x)),
            y: Math.min(...boxes.map((box) => box.y)),
            width: Math.max(...boxes.map((box) => box.x + box.width)) - Math.min(...boxes.map((box) => box.x)),
            height: Math.max(...boxes.map((box) => box.y + box.height)) - Math.min(...boxes.map((box) => box.y)),
          };
        })();

    // Build the route the chosen faces give, then — only if something is in the
    // way — see whether another pair of faces gets there cleanly. Changing a
    // face is charged for, so a route only leaves the side it should leave from
    // when the alternative genuinely clears a box the first one ran through.
    const build = (
      ss: Side, es: Side, sAlong: number, eAlong: number, mustGoRound: boolean,
    ): { points: Point[]; cost: number } | null => {
      const s0 = contact(fromShape, a, ss, sAlong);
      const e0 = contact(toShape, b, es, eAlong);
      const nA = NORMALS[ss];
      const nB = NORMALS[es];
      const rA = reach(nA, nB, s0, e0);
      const rB = reach(nB, nA, e0, s0);
      const pp = { x: s0.x + nA.x * rA, y: s0.y + nA.y * rA };
      const qq = { x: e0.x + nB.x * rB, y: e0.y + nB.y * rB };
      // DESIGN 6.7: a loop-back takes the nearest corridor, not just any
      // clean one — gate.mjs's own `longLoops` caps it at the Manhattan
      // distance between the two contacts plus 128. Charged here too, not
      // just measured after the fact, so a side pair that is only clean by
      // going the long way round never beats a shorter pair that has to
      // pay a little intrusion or a mismatch charge instead.
      const loopBudget = item.loop ? Math.abs(e0.x - s0.x) + Math.abs(e0.y - s0.y) + 128 : Infinity;
      let best: { points: Point[]; cost: number; len?: number } | null = null;
      // A loop-back used to skip this entirely — going round was rare enough
      // that it never ran into an earlier forward edge's own stub. A nearer
      // corridor (`corridorGaps`, DESIGN 6.7) sits much closer to the nodes
      // it passes, so it now has to clear the same forward-edge segments any
      // other route does (`flow.mmd`'s D→B retry, which used to cut back
      // through B→C and B→D's own departing stubs at y=48).
      const crossPenalty = (pts: Point[]) => {
        const earlier = placedForwardSegs.slice(0, placedBeforeThisEdge);
        return crossingCost(pts, earlier) + sharedRunCost(pts, earlier);
      };
      if (!mustGoRound) {
        for (const mid of elbows(pp, nA, qq, nB, wallBoxes)) {
          const candidate = [s0, pp, ...mid, qq, e0];
          const cost = intrusion(candidate, blockers) + crossPenalty(candidate) +
            selfPierce(candidate, [a, b]) * 2000;
          if (!best || cost < best.cost) best = { points: candidate, cost };
          if (cost === 0) break;
        }
        if (best?.cost === 0) return best;
      }
      // Going the long way is a real cost even when it is clean, so it is
      // charged for and only wins when the direct route is genuinely blocked.
      const clear = item.loop ? LOOP_CLEAR + myLane * 16 : LOOP_CLEAR;
      // A loop-back doesn't have to run all the way to the canvas margin —
      // the gap between the row it leaves and the row above it is usually a
      // clean corridor on its own, and far shorter. Offered alongside the
      // margin lanes below; the cost search picks by resulting path length,
      // not by which lane comes first (DESIGN 6.7's "nearest corridor").
      const yRange: [number, number] = [Math.min(s0.y, e0.y, pp.y, qq.y), Math.max(s0.y, e0.y, pp.y, qq.y)];
      const xRange: [number, number] = [Math.min(s0.x, e0.x, pp.x, qq.x), Math.max(s0.x, e0.x, pp.x, qq.x)];
      const extraLanes = item.loop
        ? {
            y: corridorGaps('y', content, blockers, clear, xRange),
            x: corridorGaps('x', content, blockers, clear, yRange),
          }
        : undefined;
      // The local bounds keep an ordinary edge's detour local — going all the
      // way to the canvas edge to dodge one neighbour reads as nonsensical.
      // But local bounds can themselves be blocked (regex-engine's AT→NO: the
      // local corridor is also where DM→DT crosses), and the only route left
      // that never runs through a box or another forward edge is the one
      // that goes all the way round, same as a loop-back would. Offered
      // alongside the local lanes, not instead of them, so it only wins when
      // it is genuinely the sole clean option — same 400 flat cost either way.
      const rounds = detourBounds === content
        ? detours(s0, ss, e0, es, pp, qq, detourBounds, clear, extraLanes)
        : [...detours(s0, ss, e0, es, pp, qq, detourBounds, clear), ...detours(s0, ss, e0, es, pp, qq, content, clear, extraLanes)];
      for (const round of rounds) {
        // Detours offers every lane a face can reach at all, including ones
        // at right angles to a same-side loop — a lane in the *same* axis as
        // ss/es is the only shape that can't put a jog where the stub meets
        // it (the lane's own two cross points already share one coordinate;
        // a cross-axis lane's don't, and when the two stubs are already
        // close — an adjacent retry, not one spanning the diagram — that gap
        // is a few units, which reads as a pointless dogleg, not a route).
        // Crossing axes is still on the table for when it's the only way
        // around something, just priced instead of free.
        const sameAxis = isVertical(round.side) === isVertical(ss);
        const crossAxisCharge = ss === es && !sameAxis ? 5 : 0;
        // A forward edge going round costs 3 or 4 bends, which DESIGN 6.1
        // only allows a loop-back. So this is charged far above anything the
        // alternate-side search below spends (mismatch 24 + congestion) —
        // a clean 0–2 bend route at a different side pair always wins over
        // going round, and going round is only ever the final answer when no
        // side pair gives one (regex-engine's AT→NO, state's Graduated→
        // root_end both used to win this comparison at 12 flat cost, taking
        // a 3-bend route past two boxes instead of a 2-bend one from a
        // clearer face). Loops keep the old, unpenalised cost — going round
        // is the route DESIGN 6.7 asks for, not a fallback.
        const cost =
          intrusion(round.points, blockers) + (mustGoRound ? 0 : 400) + crossAxisCharge +
          crossPenalty(round.points) + marginShortfall(round.points, content, clear) * 50 +
          selfPierce(round.points, [a, b]) * 2000 +
          (item.loop ? tightCornerCost(round.points) : 0) +
          Math.max(0, pathLength(round.points) - loopBudget) * 10;
        if ((globalThis as any).__DEBUG_EDGE === item.edge.id) {
          console.error('ROUND', round.side, JSON.stringify(round.points), 'cost', cost,
            'selfPierce', selfPierce(round.points, [a, b]), 'intrusion', intrusion(round.points, blockers),
            'len', pathLength(round.points), 'budget', loopBudget);
        }
        // Among routes that cost the same (almost always two or more clean
        // lanes), the nearest corridor wins — the shortest resulting path,
        // not whichever lane was offered first.
        const len = pathLength(round.points);
        if (!best || cost < best.cost - 0.5 || (Math.abs(cost - best.cost) < 0.5 && len < (best.len ?? Infinity))) {
          best = { points: round.points, cost, len };
        }
      }
      return best;
    };

    // Wraps `build` with the side/along combination that produced it, so the
    // fan pass below (after every edge has picked its route) can tell what a
    // route actually settled on — which, once the alternate-pair search below
    // kicks in, can differ from `item.startSide`/`endSide`.
    interface Attempt { points: Point[]; cost: number; ss: Side; es: Side; sAlong: number; eAlong: number; mustGoRound: boolean }
    const attempt = (ss: Side, es: Side, sAlong: number, eAlong: number, mustGoRound: boolean): Attempt | null => {
      const r = build(ss, es, sAlong, eAlong, mustGoRound);
      return r ? { ...r, ss, es, sAlong, eAlong, mustGoRound } : null;
    };

    let best = attempt(item.startSide, item.endSide, startAlong, endAlong, item.loop);
    // Before ever mixing lanes, see whether a *different* single lane clears
    // both ends outright. loopSide's choice is a corridor-wide tie-break — it
    // can pick a side that grazes something right next to one end (the
    // end-state marker sitting beside Running, state.mmd) even though another
    // side is completely open for both ends. A lane with zero intrusion beats
    // every mixed-lane route below, which always pays a cost for the jog
    // where the two lanes meet, so it is worth the four extra tries.
    if (item.loop && (best?.cost ?? Infinity) > 0) {
      // Only the axis the exit side itself was chosen from — whichever family
      // `item.startSide` belongs to, not the chart's own flow axis, since a
      // horizontal-arrival loop now picks its exit from the same family the
      // arrival is in (see the comment above `startSideChoice`), not
      // necessarily the family the chart's flow direction would suggest. The
      // arriving side stays put — it is fixed to the target's flow-in face
      // (DESIGN 6.2), not something this search is free to trade away for a
      // cleaner lane.
      const sides: Side[] = isVertical(item.startSide) ? ['top', 'bottom'] : ['left', 'right'];
      for (const ss of sides) {
        if (ss === item.startSide) continue;
        const [sl, sh] = faceRange(a, ss, sharpA);
        const alt = attempt(
          ss, item.endSide,
          Math.max(sl, Math.min(sh, faceMiddle(a, ss))),
          endAlong,
          true,
        );
        if (alt && alt.cost === 0) { best = alt; break; }
      }
    }
    // A loop already spends its own side-mismatch budget in loopSide
    // (route.ts:~315) and its arriving side is fixed outright (DESIGN 6.2,
    // above) — re-opening either choice here on *any* nonzero cost is a
    // different failure: a single-lane detour can't produce a jog (both its
    // cross points share one lane coordinate), so the only way this search
    // can beat it is by mixing two different lanes — which reads as the
    // tiny, pointless dogleg this was ("nonsensical line paths",
    // incident-response.mmd's Confirmed-intrusion retry). A same-side detour
    // grazing one box by a couple of units is still the better picture than
    // that. Loops only reopen the search for a real intrusion, not noise.
    const worthRetrying = item.loop ? (best?.cost ?? Infinity) > 8 : !best || best.cost > 0;
    if (worthRetrying) {
      const sides: Side[] = ['left', 'right', 'top', 'bottom'];
      // A loop's arriving face is never up for renegotiation here — DESIGN
      // 6.2 already fixed it. Only the exit side gets to roam the full set.
      const esSides: Side[] = item.loop ? [item.endSide] : sides;
      for (const ss of sides) {
        for (const es of esSides) {
          if (ss === item.startSide && es === item.endSide) continue;
          const [sl, sh] = faceRange(a, ss, sharpA);
          const [el, eh] = faceRange(b, es, sharpB);
          // Not just the middle of each face — an obstacle a side pair can't
          // get past from centre (regex-engine's AT→NO: NO's own middle sits
          // close enough to TLD's clearance to graze it no matter which lane
          // the crossbar takes) can still be clear from one end of the face,
          // same as DESIGN 6.4's fan already lands other edges off-centre.
          // Centred stays free; the two edges cost a little so a route only
          // leaves the midpoint when doing so avoids something real.
          const sMid = faceMiddle(a, ss);
          const eMid = faceMiddle(b, es);
          const sCandidates = [...new Set([sMid, sl, sh])];
          const eCandidates = [...new Set([eMid, el, eh])];
          for (const sAlongTry of sCandidates) {
            for (const eAlongTry of eCandidates) {
              const alt = attempt(
                ss, es,
                Math.max(sl, Math.min(sh, sAlongTry)),
                Math.max(el, Math.min(eh, eAlongTry)),
                item.loop,
              );
              if (!alt) continue;
              // A loop pays much more to mix lanes — the dogleg it buys is
              // worse than the small intrusion it avoids, whatever the raw
              // numbers say.
              const mismatchCost = item.loop ? 56 : 24;
              // Only charged when the alternate reaches for a face that is
              // not the one this edge was already going to use — a face
              // nothing else has touched costs nothing extra, same as today.
              const congestion =
                (ss === item.startSide ? 0 : (faceLoad.get(loadKey(item.edge.from, ss)) ?? 0)) +
                (es === item.endSide ? 0 : (faceLoad.get(loadKey(item.edge.to, es)) ?? 0));
              const offCentre = (sAlongTry === sMid ? 0 : 6) + (eAlongTry === eMid ? 0 : 6);
              const charge =
                (ss === item.startSide ? 0 : mismatchCost) + (es === item.endSide ? 0 : mismatchCost) +
                congestion * 20 + offCentre;
              if (!best || alt.cost + charge < best.cost) best = { ...alt, cost: alt.cost + charge };
            }
          }
        }
      }
    }
    if ((globalThis as any).__DEBUG_EDGE === item.edge.id) {
      console.error('WINNER', JSON.stringify(best));
    }
    if (item.loop) lane++;
    const points = best?.points ?? [start, end];
    const finalSS = best?.ss ?? item.startSide;
    const finalES = best?.es ?? item.endSide;
    const finalMustGoRound = best?.mustGoRound ?? item.loop;
    faceLoad.set(loadKey(item.edge.from, finalSS), (faceLoad.get(loadKey(item.edge.from, finalSS)) ?? 0) + 1);
    faceLoad.set(loadKey(item.edge.to, finalES), (faceLoad.get(loadKey(item.edge.to, finalES)) ?? 0) + 1);
    // Committed, in source order, for the next forward edge's crossingCost
    // and sharedRunCost.
    if (!item.loop) {
      const edgeStart = points[0]!, edgeEnd = points[points.length - 1]!;
      for (let i = 1; i < points.length; i++) {
        placedForwardSegs.push({ a: points[i - 1]!, b: points[i]!, edgeStart, edgeEnd });
      }
    }

    resolved.push({
      edgeId: item.edge.id,
      item,
      ss: finalSS,
      es: finalES,
      sAlong: best?.sAlong ?? startAlong,
      eAlong: best?.eAlong ?? endAlong,
      mustGoRound: finalMustGoRound,
      points,
      // Only the along-coordinate ever needs to move after this: the fan pass
      // below never changes which face won, only where on it the edge lands.
      rebuild: (sAlong, eAlong) => attempt(finalSS, finalES, sAlong, eAlong, finalMustGoRound)?.points ?? points,
    });
  }

  // Fan a second time, now that every edge knows which face it actually
  // landed on. The pass above (route.ts:~953) fans by the face `facesFor`
  // proposed; when the obstacle search here moved an edge to a different
  // face — the only way two edges converge on one pixel without either of
  // them ever sharing that pixel as their *proposed* attachment — this is
  // the only place that still sees it. `state.mmd`'s Graduated→root_end
  // retry is forced off its proposed right face by the Paused box in the
  // way, lands on Graduated's top face at the exact same coordinate the
  // Running→Graduated arrival already uses, and the two ran collinear for a
  // stretch right at the node (DESIGN 6.4).
  //
  // A retry counts too, on the one end that is not its own loop's other leg:
  // `4geeks-journey.mmd`'s Mentor-pairing retry comes back into Portfolio's
  // south face from below, which is also the face Portfolio's own forward
  // edge to the review gate leaves from — both dead centre, since a
  // wrap layout puts both neighbours below it. `loop`'s exclusion here was
  // about *pass one*, where a loop's own lane pick (`loopSide`/`lane`)
  // hasn't happened yet; by now it has, and the face it landed on is exactly
  // as real as any other edge's.
  // A channel edge (DESIGN 2.6's input-above/output-below column) never
  // moves — that is the point of it being a channel — but it still has to be
  // *seen* here, or the edge fighting it for the face has nothing to move
  // away from and both stay dead centre.
  interface Member2 { r: Resolved; end: boolean; fixed: boolean }
  const buckets2 = new Map<string, Member2[]>();
  const key2 = (node: string, side: Side) => `${node}:${side}`;
  for (const r of resolved) {
    const fixed = r.item.channel;
    const startKey = key2(r.item.edge.from, r.ss);
    buckets2.set(startKey, [...(buckets2.get(startKey) ?? []), { r, end: false, fixed }]);
    const endKey = key2(r.item.edge.to, r.es);
    buckets2.set(endKey, [...(buckets2.get(endKey) ?? []), { r, end: true, fixed }]);
  }
  for (const [k, members] of buckets2) {
    if (members.length < 2) continue;
    // DESIGN 6.3: a bucket that is nothing but arrivals — the loop-back and
    // the forward edge that both land on the same face, `TRI`/`Running`/`F`'s
    // case — converges onto the face's centre instead of being pushed apart,
    // whatever the routing search above happened to settle each one on. This
    // pass is the only place that sees a loop-back and a forward edge on the
    // same face at once (the first pass above never sees loops at all), so
    // it is the only place that can merge them.
    if (members.every((m) => m.end)) {
      const nodeId = k.slice(0, k.lastIndexOf(':'));
      const box = boxOf(nodeId);
      if (!box) continue;
      const side = members[0]!.r.es;
      const middle = faceMiddle(box, side);
      for (const m of members) if (!m.fixed) m.r.eAlong = middle;
      continue;
    }
    // Already spread by the first pass, or simply not colliding — leave it;
    // only a genuine coincidence on the same pixel needs fixing here.
    const alongOf = (m: Member2) => (m.end ? m.r.eAlong : m.r.sAlong);
    const spread = Math.max(...members.map(alongOf)) - Math.min(...members.map(alongOf));
    if (spread >= 8) continue;
    // All fixed (or only one member, which spread's Infinity-free math above
    // would already have skipped) — nothing here is free to move.
    const movable = members.filter((m) => !m.fixed);
    if (movable.length === 0) continue;

    const nodeId = k.slice(0, k.lastIndexOf(':'));
    const box = boxOf(nodeId);
    if (!box) continue;
    const side = members[0]!.end ? members[0]!.r.es : members[0]!.r.ss;
    const shape = shapeOf(nodeId);
    const [lo, hi] = faceRange(box, side, shape ? !isBoxy(shape, box) : false);
    const far = (m: Member2) => {
      const other = boxOf(m.end ? m.r.item.edge.from : m.r.item.edge.to);
      return other ? faceMiddle(other, side) : 0;
    };
    const step = 8;
    const middle = faceMiddle(box, side);

    // Every member on this face — fixed or not — sorted once by where its far
    // end sits, so a movable member never lands on the wrong side of a
    // channel it shares the face with (DESIGN 6.1: ports in target order).
    // The old version only checked whether a slot was *free*, always probing
    // upward first regardless of which side the target actually called
    // for — which is what sent a lone fanned edge to a channel's near side
    // instead of its far side (org-chart's ACA→B1, python-or-java's
    // JAVA→JAVAENT: both routed to the wrong side of the sibling channel and
    // crossed it).
    const order = [...members].sort((p, q) => far(p) - far(q));
    const at = new Map<Member2, number>();
    for (const m of order) at.set(m, m.fixed ? alongOf(m) : middle);

    // Two sweeps — left to right, then right to left — each pushing a
    // movable member `step` clear of its neighbour. A fixed member never
    // moves, so the pair of passes is what lets a movable member end up on
    // *either* side of one, not just whichever side a single forward sweep
    // happens to push it toward.
    for (let i = 1; i < order.length; i++) {
      const prev = order[i - 1]!, cur = order[i]!;
      if (cur.fixed) continue;
      const need = at.get(prev)! + step;
      if (at.get(cur)! < need) at.set(cur, need);
    }
    for (let i = order.length - 2; i >= 0; i--) {
      const next = order[i + 1]!, cur = order[i]!;
      if (cur.fixed) continue;
      const need = at.get(next)! - step;
      if (at.get(cur)! > need) at.set(cur, need);
    }

    for (const m of order) {
      if (m.fixed) continue;
      const v = Math.max(lo, Math.min(hi, at.get(m)!));
      if (m.end) m.r.eAlong = v;
      else m.r.sAlong = v;
    }
  }

  const routes = new Map<string, OrthoRoute>();
  for (const r of resolved) {
    routes.set(r.edgeId, {
      points: tidyOrtho(squareOff(r.rebuild(r.sAlong, r.eAlong))),
      startSide: r.ss,
      endSide: r.es,
    });
  }

  // DESIGN 6.1 / 6.4, both fixed here over the finished geometry rather than
  // in the per-edge search above: a lone Z's middle segment sits at the true
  // centre of the one gap it crosses, and two *different* edges' runs
  // through the same corridor keep 16 clear of each other or share a bus's
  // single line — never merely close. Everything above judges one edge at a
  // time (its own intrusion, its own crossing cost against what is already
  // committed), which has no way to see either of these: that a channel
  // search spanning several rows can read two nodes on opposite sides of
  // its own span as conflicting walls and give up on a centre entirely
  // (regex-engine's `AT`→`NO`, a satellite's edge back out to a node several
  // rows above it), or that its own perfectly clean line sits a few units
  // from a different edge's equally clean line through the same gap
  // (`AT`→`NO` and `DM`→`DT`, 8 apart through the row-2/row-3 gap; `TLD`→
  // `OK` and `NO`→`[*]`, 4 apart through row-3/row-4). Nudging the search
  // itself to dodge either reopens the far more expensive side-pair search
  // for every edge sharing any corridor, which is what sent edges to a
  // worse side entirely instead of a few units sideways.
  //
  // Recentring runs first, spacing second: recentring a lone edge onto its
  // own true centre can walk it into range of a neighbour that was already
  // a clean 16 apart (incident-response's `ESC`→`CON`, recentred by 4 units
  // into a corridor `ESC`→`TRI`'s own loop already used, only 12 apart from
  // it once moved) — so the grouping that decides who needs spacing has to
  // be read again afterwards, off wherever recentring actually left things,
  // not off the positions the per-edge search first handed over.
  const obstacleBoxes = obstacles.map((o) => o.box);
  const backwardIds = new Set(resolved.filter((r) => r.item.edge.backward).map((r) => r.edgeId));

  interface Run { edgeId: string; idx: number; vert: boolean; c: number; lo: number; hi: number }
  const findRuns = (): Run[] => {
    const runs: Run[] = [];
    for (const [edgeId, route] of routes) {
      const pts = route.points;
      for (let i = 2; i < pts.length - 1; i++) {
        const a = pts[i - 1]!, b = pts[i]!;
        if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) > 8) {
          runs.push({ edgeId, idx: i, vert: true, c: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
        } else if (Math.abs(a.y - b.y) < 0.5 && Math.abs(a.x - b.x) > 8) {
          runs.push({ edgeId, idx: i, vert: false, c: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
        }
      }
    }
    return runs;
  };
  const groupRuns = (runs: Run[]): Run[][] => {
    const parent = runs.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const ra = runs[i]!, rb = runs[j]!;
        if (ra.vert !== rb.vert || ra.edgeId === rb.edgeId) continue;
        const gap = Math.abs(ra.c - rb.c);
        if (gap < 0.5 || gap >= 16) continue; // a bus, or already clear
        const overlap = Math.min(ra.hi, rb.hi) - Math.max(ra.lo, rb.lo);
        if (overlap <= 16) continue;
        const [rootA, rootB] = [find(i), find(j)];
        if (rootA !== rootB) parent[rootA] = rootB;
      }
    }
    const groups = new Map<number, Run[]>();
    for (let i = 0; i < runs.length; i++) {
      const root = find(i);
      groups.set(root, [...(groups.get(root) ?? []), runs[i]!]);
    }
    return [...groups.values()];
  };

  // Only a run nothing else shares a corridor with, and only a genuine
  // three-run Z — a longer, already-bent path is judged by different rules
  // — gets nudged; a backward edge is never measured by this rule at all.
  for (const group of groupRuns(findRuns())) {
    if (group.length !== 1) continue;
    const run = group[0]!;
    if (backwardIds.has(run.edgeId)) continue;
    const pts = routes.get(run.edgeId)!.points;
    if (pts.length !== 4 || run.idx !== 2) continue;
    const p0 = pts[1]!, p1 = pts[2]!;
    const near = run.vert
      ? obstacleBoxes.filter((o) => o.y + o.height > run.lo && o.y < run.hi)
      : obstacleBoxes.filter((o) => o.x + o.width > run.lo && o.x < run.hi);
    const before = run.vert
      ? near.filter((o) => o.x + o.width <= run.c + 1).map((o) => o.x + o.width)
      : near.filter((o) => o.y + o.height <= run.c + 1).map((o) => o.y + o.height);
    const after = run.vert
      ? near.filter((o) => o.x >= run.c - 1).map((o) => o.x)
      : near.filter((o) => o.y >= run.c - 1).map((o) => o.y);
    if (!before.length || !after.length) continue;
    const want = (Math.max(...before) + Math.min(...after)) / 2;
    const delta = want - run.c;
    if (Math.abs(delta) < 3.5) continue;
    if (run.vert) { p0.x += delta; p1.x += delta; } else { p0.y += delta; p1.y += delta; }
  }

  // Every interior run (never the stub at a node's own face — that stays
  // put, and never a backward edge's — a loop already has its own lane rule,
  // `loopSide`'s `myLane`, and judging it against an ordinary edge's channel
  // here as well double-counts the same spacing and can push a forward edge
  // off its own true centre for a conflict that was never really there —
  // 4geeks-journey's `E`→`F` used to be pulled 16 apart from the `I`→`F`
  // retry's own return run this way) is grouped with whichever other edges'
  // runs are parallel, overlap by more than 16, and sit under 16 from it —
  // read fresh, since recentring above can have created a new conflict as
  // easily as it removed one — and the whole group is respaced 16 apart
  // around its own average.
  for (const group of groupRuns(findRuns().filter((r) => !backwardIds.has(r.edgeId)))) {
    // One slot per edge: two runs belonging to the same edge (a path that
    // passes back through its own corridor) are never pulled apart from
    // each other, only from every *other* edge's run in the group.
    const byEdge = new Map<string, Run>();
    for (const r of group) if (!byEdge.has(r.edgeId)) byEdge.set(r.edgeId, r);
    const members = [...byEdge.values()].sort((a, b) => a.c - b.c);
    if (members.length < 2) continue;
    const mean = members.reduce((sum, r) => sum + r.c, 0) / members.length;
    const start = mean - ((members.length - 1) * 16) / 2;
    members.forEach((r, i) => {
      const delta = start + i * 16 - r.c;
      if (Math.abs(delta) < 0.5) return;
      const pts = routes.get(r.edgeId)!.points;
      const p0 = pts[r.idx - 1]!, p1 = pts[r.idx]!;
      if (r.vert) { p0.x += delta; p1.x += delta; } else { p0.y += delta; p1.y += delta; }
    });
  }

  return routes;
}
