import { CLEARANCE } from '../tokens.ts';

/**
 * DESIGN 6.1/6.2/6.3, checked on the *final* geometry of every render, not
 * just at layout time.
 *
 * The channel engine and the safe layout both verify their own routes before
 * they ever commit (grid.ts's `verify`, safe.ts's own construction) — this
 * module exists for the machinery that does not: state/class/ER diagrams
 * still route through the old ELK + `route/plan.ts` pipeline, which has no
 * equivalent final check. Rather than duplicate the checking logic per
 * engine, this runs once, uniformly, after every layout has placed its final
 * boxes and routed its final polylines — a model-level pass over plain
 * numbers, the same shape `layout/grid.ts`'s own verify already takes, kept
 * separate so it can also be unit-tested against synthetic geometry without
 * a whole graph and scene to build one.
 *
 * Three checks, each a line in the render's `warnings`:
 *   - an edge's drawn run passes within DESIGN 6.1's 16-unit clearance floor
 *     of a node it does not connect;
 *   - an edge's first point is not on its own source's outline (DESIGN 6.2);
 *   - two or more distinct arrival points land on one node's one side
 *     (DESIGN 6.3: a fan-in earns its single head by sharing one point —
 *     more than one point on a side is more than one arrowhead there).
 *
 * A channel-engine or safe-layout chart producing any of these is an engine
 * bug (its own verify should have caught it before committing) — the old
 * machinery is where a real violation is expected to still turn up.
 */

export interface RuntimeBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** DESIGN 2.6: a panel's own children. An edge with either endpoint among
   *  them is expected to sit inside the panel or cross its border — that is
   *  the composition, not a clearance violation — so a panel box exempts
   *  itself from the check for such an edge, the way a node already exempts
   *  itself for the edges that touch it. */
  members?: string[];
}

export interface RuntimeEdge {
  id: string;
  from: string;
  to: string;
  /** The raw, un-shortened route — flow coordinates, one segment per pair of
   *  consecutive points, all axis-aligned. */
  points: { x: number; y: number }[];
  /** The side of `to` the route's last point lands on, when known. Edges
   *  without one (nothing routes yet, or a self-loop) are skipped for the
   *  one-arrowhead-per-side check only. */
  endSide?: string;
}

const EPS = 0.5;
/** DESIGN 6.1: an edge keeps this clear of a node it does not touch. */
const CLEAR = CLEARANCE.node;
/** How close a point has to sit to a box's own perimeter to read as "on" it
 *  — a few units, to absorb the standoff every route already carries and the
 *  rounding grid coordinates land on, never so loose it would wave through a
 *  genuine gap. */
const ON_OUTLINE = 6;

/** Shortest distance from an axis-aligned segment to a box, 0 when the
 *  segment crosses or touches it. Segments here are always axis-aligned
 *  (every route is orthogonal); a stray diagonal falls back to the nearer
 *  endpoint's distance rather than a full segment-rect computation nothing
 *  in this codebase produces. */
function segToBoxDistance(
  a: { x: number; y: number },
  b: { x: number; y: number },
  box: RuntimeBox,
): number {
  const horiz = Math.abs(a.y - b.y) < EPS;
  const vert = Math.abs(a.x - b.x) < EPS;
  if (horiz) {
    const y = a.y;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const dy = Math.max(box.y - y, 0, y - (box.y + box.height));
    const dx = x1 < box.x ? box.x - x1 : x0 > box.x + box.width ? x0 - (box.x + box.width) : 0;
    return Math.hypot(dx, dy);
  }
  if (vert) {
    const x = a.x;
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    const dx = Math.max(box.x - x, 0, x - (box.x + box.width));
    const dy = y1 < box.y ? box.y - y1 : y0 > box.y + box.height ? y0 - (box.y + box.height) : 0;
    return Math.hypot(dx, dy);
  }
  const distToPoint = (p: { x: number; y: number }): number => {
    const dx = Math.max(box.x - p.x, 0, p.x - (box.x + box.width));
    const dy = Math.max(box.y - p.y, 0, p.y - (box.y + box.height));
    return Math.hypot(dx, dy);
  };
  return Math.min(distToPoint(a), distToPoint(b));
}

/** Whether a point sits on (or within `ON_OUTLINE` of) a box's own
 *  perimeter — true for a rect/round/stadium/hexagon side, and for a
 *  diamond's vertex too, since every one of those touches its own bounding
 *  box at exactly the points a route departs from or arrives at. */
function onPerimeter(p: { x: number; y: number }, box: RuntimeBox, tol = ON_OUTLINE): boolean {
  const withinX = p.x >= box.x - tol && p.x <= box.x + box.width + tol;
  const withinY = p.y >= box.y - tol && p.y <= box.y + box.height + tol;
  const nearLeft = Math.abs(p.x - box.x) <= tol;
  const nearRight = Math.abs(p.x - (box.x + box.width)) <= tol;
  const nearTop = Math.abs(p.y - box.y) <= tol;
  const nearBottom = Math.abs(p.y - (box.y + box.height)) <= tol;
  return (withinY && (nearLeft || nearRight)) || (withinX && (nearTop || nearBottom));
}

export function checkRuntimeGeometry(boxes: RuntimeBox[], edges: RuntimeEdge[]): string[] {
  const warnings: string[] = [];
  const byId = new Map(boxes.map((b) => [b.id, b] as const));

  // 1. 16-unit clearance floor from a node an edge does not connect.
  for (const e of edges) {
    if (e.points.length < 2) continue;
    outer: for (let i = 0; i + 1 < e.points.length; i++) {
      const a = e.points[i]!;
      const b = e.points[i + 1]!;
      for (const box of boxes) {
        if (box.id === e.from || box.id === e.to) continue;
        if (box.members?.includes(e.from) || box.members?.includes(e.to)) continue;
        const d = segToBoxDistance(a, b, box);
        if (d < CLEAR - EPS) {
          warnings.push(
            `6.1-runtime edge ${e.id} (${e.from}→${e.to}) passes ${d.toFixed(1)} from ${box.id}, under the ${CLEAR} clearance floor`,
          );
          break outer;
        }
      }
    }
  }

  // 2. Departs its own source's outline.
  for (const e of edges) {
    const p0 = e.points[0];
    const src = byId.get(e.from);
    if (!p0 || !src) continue;
    if (!onPerimeter(p0, src)) {
      warnings.push(
        `6.2-runtime edge ${e.id} (${e.from}→${e.to}) starts at (${Math.round(p0.x)},${Math.round(p0.y)}), off ${e.from}'s outline`,
      );
    }
  }

  // 3. More than one arrowhead landing on one node's one side: two or more
  // distinct arrival points sharing a (node, side) key. A fan-in that merges
  // by construction (DESIGN 6.3) shares the exact same point, one key.
  const bySide = new Map<string, Map<string, string[]>>();
  for (const e of edges) {
    if (!e.endSide) continue;
    const last = e.points[e.points.length - 1];
    if (!last) continue;
    const sideKey = `${e.to}|${e.endSide}`;
    const pointKey = `${Math.round(last.x)},${Math.round(last.y)}`;
    let m = bySide.get(sideKey);
    if (!m) {
      m = new Map();
      bySide.set(sideKey, m);
    }
    m.set(pointKey, [...(m.get(pointKey) ?? []), e.id]);
  }
  for (const [sideKey, points] of bySide) {
    if (points.size < 2) continue;
    const [nodeId, side] = sideKey.split('|');
    const ids = [...points.values()].flat();
    warnings.push(
      `6.3-runtime ${points.size} distinct arrival points land on ${nodeId}'s ${side} side (${ids.join(', ')}) — more than one arrowhead on one side`,
    );
  }

  return warnings;
}
