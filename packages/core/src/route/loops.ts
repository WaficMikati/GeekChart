import type { Point, Shape } from '../geometry.ts';
import { NORMALS, isVertical, type Extent, type Side } from './shared.ts';
import { portOn } from './ports.ts';

/**
 * Loop-backs and the corridors they travel. DESIGN 6.7: a loop back goes
 * *around* the content with 24 clearance, as one rounded orthogonal path —
 * never a free-form arc under the diagram, and never through the box it
 * leaves or arrives at (DESIGN 6.2).
 */

/** A node looping back to itself: a lobe off one face, drawn as two cubics. */
export function selfLoop(shape: Shape, side: Side, gap: number): string {
  const normal = NORMALS[side];
  const along = side === 'left' || side === 'right' ? { x: 0, y: 1 } : { x: 1, y: 0 };
  const start = portOn(shape, side, -0.35);
  const end = portOn(shape, side, 0.35);
  const reach = 46;
  const c1 = {
    x: start.x + normal.x * reach - along.x * 12,
    y: start.y + normal.y * reach - along.y * 12,
  };
  const c2 = {
    x: end.x + normal.x * (reach + gap) + along.x * 12,
    y: end.y + normal.y * (reach + gap) + along.y * 12,
  };
  const tip = { x: end.x + normal.x * gap, y: end.y + normal.y * gap };
  return (
    `M${start.x.toFixed(2)},${start.y.toFixed(2)} ` +
    `C${c1.x.toFixed(2)},${c1.y.toFixed(2)} ${c2.x.toFixed(2)},${c2.y.toFixed(2)} ` +
    `${tip.x.toFixed(2)},${tip.y.toFixed(2)}`
  );
}

/**
 * Which way a retry should swing out.
 *
 * It has to leave the corridor its forward edge already occupies, and there are
 * only two ways out. Always taking the same one drives the loop straight through
 * whatever happens to sit on that side — in a state machine with a branch, the
 * retry crossed the branch and passed through its sibling. Counting what is
 * actually in the way on each side costs nothing and picks the empty one.
 */
export function loopSide(
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
  const lo = Math.min(
    vertical ? from.centre.y : from.centre.x,
    vertical ? to.centre.y : to.centre.x,
  );
  const hi = Math.max(
    vertical ? from.centre.y : from.centre.x,
    vertical ? to.centre.y : to.centre.x,
  );
  const near = Math.min(
    vertical ? from.centre.x : from.centre.y,
    vertical ? to.centre.x : to.centre.y,
  );
  const far = Math.max(
    vertical ? from.centre.x : from.centre.y,
    vertical ? to.centre.x : to.centre.y,
  );

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
export function marginShortfall(points: readonly Point[], content: Extent, clear: number): number {
  const top = content.y,
    bottom = content.y + content.height;
  const left = content.x,
    right = content.x + content.width;
  let worst = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    const dx = b.x - a.x,
      dy = b.y - a.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) > 40) {
      const x = (a.x + b.x) / 2;
      if (x < left) worst = Math.max(worst, Math.max(0, x - (left - clear)));
      if (x > right) worst = Math.max(worst, Math.max(0, right + clear - x));
    } else if (Math.abs(dy) < 0.5 && Math.abs(dx) > 40) {
      const y = (a.y + b.y) / 2;
      if (y < top) worst = Math.max(worst, Math.max(0, y - (top - clear)));
      if (y > bottom) worst = Math.max(worst, Math.max(0, bottom + clear - y));
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
export function corridorGaps(
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
export function detours(
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
