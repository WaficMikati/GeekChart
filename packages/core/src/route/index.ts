/**
 * Draw every edge as one curve between two ports, or as an orthogonal path
 * this renderer plans itself.
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
 *
 * This is the barrel for the split-up implementation:
 * - `shared.ts`  — the `Side`/`Extent`/`Obstacle` types and geometry every
 *                  other module reaches for.
 * - `ports.ts`   — which face an edge attaches to, and where along it
 *                  (DESIGN 6.2, 2.4, 2.6, 6.4).
 * - `elbows.ts`  — the chord curve and the orthogonal elbow/contact geometry
 *                  (DESIGN 6.1, 6.3).
 * - `loops.ts`   — a self-loop and a loop-back's own corridor (DESIGN 6.7).
 * - `cost.ts`    — the crossing/intrusion/self-pierce scoring the orthogonal
 *                  search in `plan.ts` minimises.
 * - `plan.ts`    — `routeEdges` (the chord router) and `planRoutes` (the
 *                  orthogonal orchestration), the two public entry points.
 */

export type { Side, Extent, Obstacle } from './shared.ts';
export { sideToward, portOn, facesFor, planPorts, type PortPlan } from './ports.ts';
export { curve, connect, arrowHead, directCurve, type Connection } from './elbows.ts';
export { selfLoop } from './loops.ts';
export { type PlacedSeg } from './cost.ts';
export { routeEdges, planRoutes, type EdgeEnds, type OrthoRoute } from './plan.ts';
