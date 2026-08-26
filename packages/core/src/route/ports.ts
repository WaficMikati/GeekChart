import { boundaryPoint, type Point, type Shape } from '../geometry.ts';
import { NORMALS, faceMiddle, isVertical, type Extent, type Side } from './shared.ts';
import { loopSide } from './loops.ts';

/**
 * Which face an edge attaches to, and where along it. DESIGN 6.2: edges
 * attach at the midpoint of a side, on the outline, perpendicular — never a
 * corner. DESIGN 2.4/2.6 give the sharp-shape and panel-column exceptions to
 * "midpoint"; DESIGN 6.4 spaces several edges on one face 8-grid apart.
 */

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

/** Air kept between a contact point and the corner of the face it sits on. */
const FACE_INSET = 16;

/** Where a face sits on the axis it is perpendicular to. */
export function faceLine(box: Extent, side: Side): number {
  switch (side) {
    case 'left': return box.x;
    case 'right': return box.x + box.width;
    case 'top': return box.y;
    default: return box.y + box.height;
  }
}

/** The stretch of a face an edge may land on, with 10.2's air at each end. */
export function faceRange(box: Extent, side: Side, sharp = false): [number, number] {
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
export function alignEnds(
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
