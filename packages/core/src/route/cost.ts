import type { Point } from '../geometry.ts';
import type { Extent } from './shared.ts';

/**
 * Scoring for the orthogonal route search in `plan.ts`. DESIGN 6.1: forward
 * edges never cross and stay 16 clear of a node they don't connect to.
 * DESIGN 6.2: a route never doubles back through the box it leaves or
 * arrives at. DESIGN 6.4: two edges never converge on one run through the
 * same stretch of canvas. Every function here is a cost or a boolean test
 * `plan.ts`'s candidate search adds up and minimises — none of them build a
 * route themselves.
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

export function crossingCost(points: Point[], placed: readonly PlacedSeg[]): number {
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
export function sharedRunCost(points: Point[], placed: readonly PlacedSeg[]): number {
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

/** Clearance a route keeps from any node it does not connect to. DESIGN 6.1. */
const HUG_CLEAR = 16;

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
export function intrusion(points: Point[], obstacles: Extent[]): number {
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
export function selfPierce(points: readonly Point[], ownBoxes: readonly Extent[]): number {
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
export function tightCornerCost(points: readonly Point[]): number {
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
export function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.abs(points[i]!.x - points[i - 1]!.x) + Math.abs(points[i]!.y - points[i - 1]!.y);
  }
  return total;
}
