import type { EdgeStroke, EdgeTip, Graph, GraphEdge, GraphNode } from './graph.ts';
import { clusterHeadroom, type Scene } from './scene.ts';
import {
  ellipseShape,
  endOf,
  rectShape,
  rhombusShape,
  roundedPath,
  shortenEnd,
  shortenStart,
  startOf,
  type Point,
  type Shape,
} from './geometry.ts';
import { planRoutes, type Extent, type OrthoRoute } from './route.ts';
import { tipPath, tipReach } from './tips.ts';
import { TRUNK_OFFSET } from './layout/stack.ts';
import { GRID, GUTTER } from './tokens.ts';
import { RULES } from './rules.ts';

/**
 * Draw the diagram.
 *
 * Every coordinate here is ours. Nothing is inherited from a renderer we then
 * have to correct, which is why this file has no repair logic in it at all — the
 * previous pipeline was mostly repair.
 *
 * The output is plain SVG with classes on everything the animation needs to
 * address. Motion is layered on separately, so a static export and an animated
 * one are the same drawing.
 */

const SVG = 'http://www.w3.org/2000/svg';
const esc = (t: string) =>
  t.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const round = (n: number) => Number(n.toFixed(2));

/**
 * Which nodes carry a tint, and which are solid.
 *
 * Shape alone is a weak channel at the size a chart is judged at on a feed — a
 * cylinder and a rounded rectangle are the same grey blob at a glance. A wash of
 * the node's own colour is the second channel, and it survives scaling down.
 */
const FILLED = new Set(['terminal', 'datastore', 'note']);
const SOLID = new Set(['dot', 'bar']);

interface Placed extends GraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

const isPlaced = (n: GraphNode): n is Placed =>
  n.x !== undefined && n.y !== undefined && n.width !== undefined && n.height !== undefined;

/** The outline of a node, as an SVG path in absolute coordinates. */
function outline(node: Placed, scene: Scene): string {
  const { x, y, width: w, height: h } = node;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const r = scene.radius;

  switch (node.shape) {
    case 'diamond':
      return `M${round(cx)},${round(y)} L${round(x + w)},${round(cy)} L${round(cx)},${round(y + h)} L${round(x)},${round(cy)} Z`;
    case 'circle': {
      const rad = Math.min(w, h) / 2;
      return `M${round(cx - rad)},${round(cy)} a${round(rad)},${round(rad)} 0 1,0 ${round(rad * 2)},0 a${round(rad)},${round(rad)} 0 1,0 ${round(-rad * 2)},0 Z`;
    }
    case 'stadium':
    case 'round': {
      const rr = node.shape === 'stadium' ? h / 2 : r;
      return roundedRect(x, y, w, h, rr);
    }
    case 'cylinder': {
      const ry = Math.min(16, h * 0.18);
      return (
        `M${round(x)},${round(y + ry)} a${round(w / 2)},${round(ry)} 0 0,1 ${round(w)},0 ` +
        `v${round(h - ry * 2)} a${round(w / 2)},${round(ry)} 0 0,1 ${round(-w)},0 Z ` +
        `M${round(x)},${round(y + ry)} a${round(w / 2)},${round(ry)} 0 0,0 ${round(w)},0`
      );
    }
    case 'hexagon': {
      const k = Math.min(24, w * 0.16);
      return `M${round(x + k)},${round(y)} H${round(x + w - k)} L${round(x + w)},${round(cy)} L${round(x + w - k)},${round(y + h)} H${round(x + k)} L${round(x)},${round(cy)} Z`;
    }
    case 'parallelogram': {
      const k = Math.min(26, w * 0.14);
      return `M${round(x + k)},${round(y)} H${round(x + w)} L${round(x + w - k)},${round(y + h)} H${round(x)} Z`;
    }
    case 'trapezoid': {
      const k = Math.min(26, w * 0.14);
      return `M${round(x + k)},${round(y)} H${round(x + w - k)} L${round(x + w)},${round(y + h)} H${round(x)} Z`;
    }
    case 'subroutine':
      return `${roundedRect(x, y, w, h, r)} M${round(x + 10)},${round(y)} V${round(y + h)} M${round(x + w - 10)},${round(y)} V${round(y + h)}`;
    // A class box or an entity table: squarer than a process box, because it is
    // a record rather than a step.
    case 'panel':
      return roundedRect(x, y, w, h, Math.min(r * 0.6, 6));
    case 'dot':
    case 'ring': {
      const rad = Math.min(w, h) / 2;
      return `M${round(cx - rad)},${round(cy)} a${round(rad)},${round(rad)} 0 1,0 ${round(rad * 2)},0 a${round(rad)},${round(rad)} 0 1,0 ${round(-rad * 2)},0 Z`;
    }
    case 'bar':
      return roundedRect(x, y, w, h, Math.min(w, h) / 2);
    // The folded corner is what says "aside" without needing a label.
    case 'note': {
      const k = 14;
      return (
        `M${round(x)},${round(y)} H${round(x + w - k)} L${round(x + w)},${round(y + k)} ` +
        `V${round(y + h)} H${round(x)} Z M${round(x + w - k)},${round(y)} ` +
        `V${round(y + k)} H${round(x + w)}`
      );
    }
    default:
      return roundedRect(x, y, w, h, r);
  }
}

function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h / 2);
  return (
    `M${round(x + rr)},${round(y)} H${round(x + w - rr)} A${round(rr)},${round(rr)} 0 0,1 ${round(x + w)},${round(y + rr)} ` +
    `V${round(y + h - rr)} A${round(rr)},${round(rr)} 0 0,1 ${round(x + w - rr)},${round(y + h)} ` +
    `H${round(x + rr)} A${round(rr)},${round(rr)} 0 0,1 ${round(x)},${round(y + h - rr)} ` +
    `V${round(y + rr)} A${round(rr)},${round(rr)} 0 0,1 ${round(x + rr)},${round(y)} Z`
  );
}

/** The shape an edge attaches to, matching what was drawn. */
function shapeOf(node: Placed): Shape {
  const box = { x: node.x, y: node.y, width: node.width, height: node.height };
  const centre: Point = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  switch (node.shape) {
    case 'diamond':
      return rhombusShape(centre, node.width / 2, node.height / 2);
    case 'circle':
    case 'dot':
    case 'ring':
      return ellipseShape(
        centre,
        Math.min(node.width, node.height) / 2,
        Math.min(node.width, node.height) / 2,
      );
    default:
      return rectShape(box);
  }
}

export interface DrawnEdge {
  id: string;
  from: string;
  to: string;
  /** True when both ends and the direction lie on the primary path. */
  onPath: boolean;
  /** A retry or loop-back — excluded from the build's dependency order, so it
   *  never holds up the flow it answers (it draws once both ends already exist). */
  backward: boolean;
  hasLabel: boolean;
  /** The path data, so a pulse can be sent along it. */
  d: string;
  /** Which pattern the line renders in, so the motion layer can pick a reveal (DESIGN 6.6, 8.2). */
  stroke: EdgeStroke;
}

export interface Drawing {
  svg: string;
  width: number;
  height: number;
  /** Nodes in reading order — the order the build follows. */
  nodes: string[];
  edges: DrawnEdge[];
  clusters: string[];
  /**
   * Nodes drawn as a filled tile inside a panel (DESIGN 4.2), whose outline is
   * `stroke: none` in the static stylesheet. The motion layer has to know this
   * set too: forcing a stroke colour onto one of these via keyframes — even
   * briefly — paints a second depth cue that the static rule never intended.
   */
  inPanelNodes: string[];
  /**
   * The tight bounding box of everything actually drawn — nodes, panels,
   * every edge's routed line, and every label plate — in the same coordinate
   * space as `node.x`/`node.y`. This is what `fitToCanvas` in `flow.ts` frames
   * the chart to. It used to mount the finished SVG and call `getBBox()`,
   * which needs a browser; this is the geometric answer to the same question,
   * built from boxes and points this function already placed, so a Node
   * render can compute it too. Ink extent (glyph overshoot) is not included —
   * only advance-width boxes and routed points — which is the one way this
   * can read a hair tighter than the `getBBox()` it replaces.
   */
  extent: { x: number; y: number; width: number; height: number };
}

/**
 * A short, stable name for this diagram.
 *
 * Element ids inside an SVG are document-global — CSS scoping does not touch
 * them — so two charts on one page both defining `gc-head-path` produce a
 * duplicate id, and the second chart's `marker-end` silently resolves to the
 * first chart's marker. Deriving the suffix from the graph's own contents keeps
 * it unique per diagram while staying identical across runs, which the
 * frame-by-frame video capture depends on.
 */
function fingerprint(graph: Graph): string {
  const text =
    graph.nodes.map((n) => n.id).join('\u0000') +
    '\u0001' +
    graph.edges.map((e) => `${e.from}>${e.to}`).join('\u0000');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * DESIGN 6.10's own signal: a label's own capped search found nothing that
 * clears DESIGN 6.9, thrown from deep inside `attemptDraw` rather than
 * threaded back up through every call in between. `draw()` below is what
 * catches it, grows the one corridor at fault, and tries the whole drawing
 * again — every position computed so far belonged to a layout that is about
 * to change, so none of it is worth keeping.
 *
 * `axis` says which way to grow: `y` widens a row gap (a forward edge running
 * down the flow, the DESIGN 1.5 case this was built for); `x` widens a column
 * gap (a forward edge running across it — two side-by-side boxes, an ER
 * relationship being the fixture that needs it) — same idea, the other axis.
 */
class NeedsCorridorGrowth {
  axis: 'x' | 'y';
  after: number;
  growBy: number;
  edge: string;
  constructor(axis: 'x' | 'y', after: number, growBy: number, edge: string) {
    this.axis = axis;
    this.after = after;
    this.growBy = growBy;
    this.edge = edge;
  }
}

/**
 * DESIGN 2.7: growth is one grid step at a time, and an edge whose label
 * still cannot be seated after 12 steps (96 units) on one axis is not helped
 * by that axis — its runs are stubs, not corridors — so growth stops there
 * and the label takes the best spot it can, gate-reported or not.
 */
export type GrowthAllowed = (edge: string, axis: 'x' | 'y') => boolean;
const MAX_GROWTH_STEPS_PER_EDGE = 12;

/**
 * Lay the drawing out once. Everything below reads final node positions off
 * `graph` and computes routes, arrows and labels from them — `draw()`, below,
 * is what re-enters this after growing a corridor DESIGN 6.9 left a label no
 * room in.
 */
function attemptDraw(
  graph: Graph,
  scene: Scene,
  size: { width: number; height: number },
  allowGrowth: GrowthAllowed,
): Drawing {
  const uid = fingerprint(graph);
  const placed = graph.nodes.filter(isPlaced);
  const byId = new Map(placed.map((n) => [n.id, n]));
  const shapes = new Map(placed.map((n) => [n.id, shapeOf(n)]));
  // A panel is a shape an edge can land on, the same as any node. Without this
  // an edge pointing at a group has nothing to attach to.
  const panels = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const cluster of graph.clusters) {
    if (cluster.x === undefined || cluster.width === undefined) continue;
    const box = { x: cluster.x, y: cluster.y!, width: cluster.width, height: cluster.height! };
    panels.set(cluster.id, box);
    shapes.set(cluster.id, rectShape(box));
  }
  const inPanel = new Set(graph.clusters.flatMap((c) => c.nodes));
  const onPath = new Set(graph.primaryPath);
  const flow = graph.direction === 'LR' || graph.direction === 'RL' ? 'horizontal' : 'vertical';

  // A second, geometric pass: once the nodes are placed, any edge whose target
  // sits behind its source is routed around too, cycle or not. Layout can put a
  // node behind its predecessor for reasons the graph alone does not show.
  //
  // "Behind" is the target *ending* before the source *begins*, not two centres
  // in the wrong order. Once a run wraps into rows, two boxes side by side in
  // the same row have centres a few units apart on the flow axis — enough for a
  // centre comparison to call a perfectly ordinary link a retry, and a retry is
  // drawn as a loop with no arrowhead and no cardinality.
  const boxOf = (id: string): Extent | undefined => byId.get(id) ?? panels.get(id);
  const spanOf = (b: { x: number; y: number; width: number; height: number }) =>
    flow === 'horizontal'
      ? { along0: b.x, along1: b.x + b.width, cross0: b.y, cross1: b.y + b.height }
      : { along0: b.y, along1: b.y + b.height, cross0: b.x, cross1: b.x + b.width };
  const routed = graph.edges.map((edge) => {
    const from = boxOf(edge.from);
    const to = boxOf(edge.to);
    let behind = false;
    if (from && to) {
      const a = spanOf(from);
      const z = spanOf(to);
      // The target ends before the source begins along the flow…
      const stepBack = z.along1 < a.along0;
      // …but a wrapped run steps back on every row break, and the row after is
      // still forwards in reading order. Only a target that is neither further
      // along nor in a later band is actually a return.
      const laterBand = z.cross0 >= a.cross1;
      behind = stepBack && !laterBand;
    }
    return { ...edge, backward: edge.backward || behind };
  });
  // What a loop-back has to go around. DESIGN 6.7's 24 of clearance is measured
  // from this, not from the two boxes the loop joins — a route that clears only
  // its own ends still runs straight through whatever sits between them.
  const drawnBoxes: Extent[] = [
    ...placed.map((n) => ({ x: n.x, y: n.y, width: n.width, height: n.height })),
    ...panels.values(),
  ];
  const content: Extent = drawnBoxes.length
    ? (() => {
        const x0 = Math.min(...drawnBoxes.map((b) => b.x));
        const y0 = Math.min(...drawnBoxes.map((b) => b.y));
        const x1 = Math.max(...drawnBoxes.map((b) => b.x + b.width));
        const y1 = Math.max(...drawnBoxes.map((b) => b.y + b.height));
        return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      })()
    : { x: 0, y: 0, width: size.width, height: size.height };

  const obstacles = [
    ...placed.map((n) => ({ id: n.id, box: { x: n.x, y: n.y, width: n.width, height: n.height } })),
    ...graph.clusters
      .filter((c) => panels.has(c.id))
      .map((c) => ({ id: c.id, box: panels.get(c.id)!, holds: c.nodes })),
  ];
  const routes = planRoutes(
    routed.filter((edge) => !edge.bus),
    boxOf,
    (id) => shapes.get(id),
    flow,
    content,
    obstacles,
  );

  // DESIGN 1.5: a stacked fan's parent→leaf edges are a bus, not a routed
  // edge — each leaf's own edge is the *whole* path from the parent's own
  // hanging port straight down the indent strip `layout/stack.ts` left
  // clear of both the parent and the leaf column, then one turn into the
  // leaf's left side at its own row. Drawn as a full, ordinary edge (same
  // classes, same transform, same draw-on animation as every other edge)
  // rather than a separate untracked element, so every leaf's edge sharing
  // the identical vertical run down to its own row reads as one trunk —
  // exactly DESIGN 6.4/6.8's "no two edges share a segment, except a fan
  // bus from one point" (they all leave the parent at the same point) —
  // without inventing a second kind of drawn thing that needs its own
  // styling and animation wiring.
  //
  // DESIGN 1.6 reuses the trunk for a parent's edge into a sibling that
  // sibling wrapping pushed onto a later row — the row in between is
  // exactly the kind of thing an ordinary routed edge never expects to find
  // in its lane — but arrives the ordinary way a forward edge does in a
  // vertical flow (DESIGN 6.2: the side facing its source, top for a target
  // below it), not the fan bus's own left-side exception: down the corridor
  // (`edge.wrapTrunkX`, clear of every row the trunk passes), left along the
  // row gap above the sibling to its own centre x, then down into its top
  // face — two bends, landing on the ordinary midpoint 6.2 already asks for,
  // so this earns no exception the gate has to know about.
  for (const edge of routed) {
    if (!edge.bus) continue;
    const from = boxOf(edge.from);
    const to = boxOf(edge.to);
    if (!from || !to) continue;
    const wrapped = edge.wrapTrunkX !== undefined;
    // `to.x` (its left edge), not `to.width` past it: where `to` is a node
    // inside a stacked fan, `to.width` is its own plain width, not the wider
    // stand-in `layout/wrap.ts` measured the corridor against — `x` is the
    // one coordinate the two always agree on (DESIGN 1.5's own `expandFan`
    // sits the parent at the stand-in's origin, unmoved).
    const trunkX = wrapped ? to.x + edge.wrapTrunkX! : from.x + TRUNK_OFFSET;
    const route: OrthoRoute = wrapped
      ? (() => {
          const arriveX = to.x + to.width / 2;
          // DESIGN 6.1's own "a Z edge's middle run is centred in the free
          // channel between the nearest walls" applies here the same as any
          // other edge shaped like this one — found the same way the gate's
          // own channel-centre check finds it (packages/cli/src/measure/
          // edges.ts): the nearest already-placed node whose x-range crosses
          // this run and whose bottom sits above `to`'s own top. Read back
          // from final positions rather than trusted from whatever
          // `layout/wrap.ts` computed the gap to be, because `square()`'s own
          // grid snapping (DESIGN 2.1) can move either row by a couple of
          // units after that — the two would drift apart by exactly the kind
          // of gap this check exists to catch.
          const runX1 = Math.min(trunkX, arriveX);
          const runX2 = Math.max(trunkX, arriveX);
          const above = placed.filter(
            (n) =>
              n.id !== edge.to &&
              n.x! < runX2 &&
              n.x! + n.width! > runX1 &&
              n.y! + n.height! <= to.y + 0.5,
          );
          const aboveBottom = above.length
            ? Math.max(...above.map((n) => n.y! + n.height!))
            : to.y - GUTTER.panel;
          // The true middle of the channel — but `roundedPath`'s own corner
          // rounding (DESIGN 6.1's own check reads it back, see the note
          // above) caps each corner's radius at half its *shorter* adjacent
          // run, and the run into `to`'s own top face is shortened again for
          // the arrowhead (`scene.edgeGap` plus the head's own reach) before
          // that cap is measured. A run too short for that cap gives this
          // corner a smaller radius than the corridor's own corner, and the
          // gate's check — which reads the *rounded* path back, not the
          // straight one this file reasons in — sees that asymmetry as an
          // off-centre channel even though the straight run it approximates
          // is not. Below the point where both corners round the full 12
          // regardless, the true centre is pulled up just enough to clear
          // that floor instead.
          const arrowStub = scene.edgeGap + scene.edgeStroke * scene.arrowLength;
          const trueCentre = (aboveBottom + to.y) / 2;
          const clearsRoundingFloor = to.y - 24 - arrowStub;
          const gapY = Math.min(trueCentre, clearsRoundingFloor);
          return {
            points: [
              { x: trunkX, y: from.y + from.height },
              { x: trunkX, y: gapY },
              { x: arriveX, y: gapY },
              { x: arriveX, y: to.y },
            ],
            startSide: 'bottom',
            endSide: 'top',
          };
        })()
      : {
          points: [
            { x: trunkX, y: from.y + from.height },
            { x: trunkX, y: to.y + to.height / 2 },
            { x: to.x, y: to.y + to.height / 2 },
          ],
          startSide: 'bottom',
          endSide: 'left',
        };
    routes.set(edge.id, route);
  }

  // DESIGN 6.3: edges that route.ts converged onto the same point on the
  // same node's face — a fan-in merge — share one arrowhead. The first edge
  // in drawing order carries it; the rest end at the outline with no head,
  // reading as branches into the trunk that does have one.
  const arriveGroups = new Map<string, string[]>();
  for (const edge of routed) {
    const route = routes.get(edge.id);
    if (!route) continue;
    const last = route.points[route.points.length - 1];
    if (!last) continue;
    const k = `${edge.to}|${route.endSide}|${Math.round(last.x)}|${Math.round(last.y)}`;
    arriveGroups.set(k, [...(arriveGroups.get(k) ?? []), edge.id]);
  }
  const noHead = new Set<string>();
  for (const ids of arriveGroups.values()) {
    if (ids.length < 2) continue;
    for (const id of ids.slice(1)) noHead.add(id);
  }

  const pad = scene.canvas.margin;
  // Sized from the line's own weight so the head holds its proportion.
  const headLength = scene.edgeStroke * scene.arrowLength;
  const headWidth = scene.edgeStroke * scene.arrowWidth;
  const parts: string[] = [];
  const pendingLabels: LabelRequest[] = [];
  // Every routed edge's own segments, kept so a label can be checked against
  // edges other than the one it belongs to (DESIGN 6.5) — not just the ones
  // that carry a label of their own.
  const edgeSegments: EdgeSegments[] = [];
  const endLabels: string[] = [];
  const sparks: string[] = [];
  // Kept out of `parts` and emitted last (DESIGN 8.5): plates and sparks paint
  // in between, so an arrowhead must come after both in DOM order or a plate
  // or a spark's ripple can paint over the point of the head.
  const arrows: string[] = [];
  const drawnNodes: string[] = [];
  const drawnEdges: DrawnEdge[] = [];
  const drawnClusters: string[] = [];

  // Clusters sit behind everything, and are the first thing to arrive.
  //
  // A group is drawn as a panel rather than as a dashed outline: a solid border,
  // its name at title weight, an optional kicker under it, and a rule separating
  // the heading from the contents. A group is usually the most important thing
  // in a diagram that has one, and a faint dashed rectangle says the opposite.
  const headroom = clusterHeadroom(scene);
  for (const cluster of graph.clusters) {
    if (cluster.x === undefined || cluster.width === undefined) continue;
    drawnClusters.push(cluster.id);
    const cx = round(cluster.x + cluster.width / 2);
    // Cap height, not the em box: an Archivo cap is about 0.72em, so a 22 title
    // sitting 24 below the panel's top edge has its cap centred on the padding.
    // DESIGN 10.3.
    const titleY = cluster.y! + scene.clusterPad + scene.type.title * 0.72;
    const ruleY = cluster.y! + headroom - scene.clusterPad * 0.5;
    parts.push(
      `<g class="gc-cluster" data-id="${esc(cluster.id)}">` +
        `<path class="gc-cluster-box" pathLength="1" d="${roundedRect(cluster.x, cluster.y!, cluster.width, cluster.height!, scene.panelRadius)}"/>` +
        `<text class="gc-cluster-title" x="${cx}" y="${round(titleY)}">${esc(cluster.title)}</text>` +
        (cluster.kicker
          ? `<text class="gc-cluster-kicker" x="${cx}" y="${round(titleY + scene.type.kicker + 9)}">${esc(cluster.kicker)}</text>`
          : '') +
        `<path class="gc-cluster-rule" d="M${round(cluster.x + scene.clusterPad)},${round(ruleY)} H${round(cluster.x + cluster.width - scene.clusterPad)}"/>` +
        `</g>`,
    );
  }

  // Nodes in the order the eye reads them, so the build follows the flow.
  const reading = [...placed].sort((a, b) =>
    flow === 'horizontal' ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x,
  );

  for (const node of reading) {
    drawnNodes.push(node.id);
    const cx = round(node.x + node.width / 2);
    const cy = node.y + node.height / 2;
    // Off the primary path is 'quiet' by default (DESIGN 5.1/5.3), not 'alt' —
    // 'alt' is a hue a chart has to earn with a legend-explained category.
    const role = onPath.has(node.id) ? 'path' : 'quiet';
    const label = node.rows?.length ? panelLabel(node, scene) : centredLabel(node, cx, cy);

    // The end state is a ring with a filled core, which is the only way to tell
    // it from the start state at a glance. Drawn as a second element rather than
    // a fill on the outline so the outline can still draw itself on.
    const core =
      node.shape === 'ring'
        ? `<circle class="gc-core" cx="${cx}" cy="${round(cy)}" r="${round(Math.min(node.width, node.height) / 2 - 5)}"/>`
        : '';

    // The tint is its own element rather than a fill on the outline, so it can
    // wash in *after* the outline has drawn itself. Painted onto the outline it
    // would appear solid the instant the node's turn came, which reads as a
    // shape being switched on rather than constructed.
    const path = outline(node, scene);
    // A card inside a panel is filled rather than outlined, so it needs the wash
    // element even when its kind would not otherwise have one — without it the
    // inverted styling has nothing to paint and the card disappears.
    const wash =
      FILLED.has(node.kind) || SOLID.has(node.shape) || inPanel.has(node.id)
        ? `<path class="gc-fill" d="${path}"/>`
        : '';

    parts.push(
      `<g class="gc-node gc-role-${role} gc-kind-${node.kind} gc-shape-${node.shape}` +
        `${inPanel.has(node.id) ? ' gc-in-panel' : ''}" ` +
        `data-id="${esc(node.id)}" style="--gc-cx:${cx}px;--gc-cy:${round(cy)}px">` +
        wash +
        `<path class="gc-outline" pathLength="1" d="${path}"/>` +
        core +
        `<g class="gc-label">${label}</g>` +
        `</g>`,
    );
  }

  // Edges last so they sit above the cluster wash but below nothing.
  for (const edge of routed) {
    const route = routes.get(edge.id);
    if (!route) continue;

    const role = onPath.has(edge.from) && onPath.has(edge.to) && !edge.backward ? 'path' : 'quiet';
    // A merged-trunk member (DESIGN 6.3) still shortens its line as if it had
    // its own head — so it stops exactly where the trunk's line does, at the
    // shared junction — but draws no mark there; the trunk alone carries it.
    const suppressed = noHead.has(edge.id);
    const endKind = edge.tipEnd ?? 'arrow';
    const startKind = edge.tipStart ?? 'none';
    // An arrowhead keeps its own tuned proportions; every other mark is a shape
    // that has to be read rather than merely pointed with, so it gets more room.
    const tipLen = scene.edgeStroke * scene.tipLength;
    const tipWid = tipLen * 0.85;
    const sizeFor = (kind: EdgeTip) =>
      kind === 'arrow' ? { len: headLength, wid: headWidth } : { len: tipLen, wid: tipWid };
    // A hollow triangle or a crow's foot occupies space the line must not run
    // through, so the line stops at the back of the mark, not at its point.
    const backEnd = tipReach(endKind, tipLen);
    const backStart = tipReach(startKind, tipLen);

    // Every route is an axis-aligned polyline that touches both outlines.
    //
    // The head's point sits *on* the far outline and the line stops 6 short of
    // it (DESIGN 10.3), so the head reads as meeting the box rather than
    // piercing it. Because the last segment is on an axis, the head is on the
    // same axis: there is no angle for it to disagree with the line about.
    const marked = route.points;
    // Both marks sit *on* the outline they touch and are built from the segment
    // that meets it; `backStart`/`backEnd` are how far the mark reaches back
    // along the line, which is how much further the line has to stop short.
    const tail = startOf(marked, 0);
    const tip = endOf(marked, 0);
    const line = shortenStart(
      shortenEnd(marked, scene.edgeGap + backEnd),
      scene.edgeGapStart + backStart,
    );
    edgeSegments.push({ id: edge.id, points: line });

    // A corner is rounded to a third of the shorter run into it, capped, so a
    // tight elbow rounds less rather than bulging past where the line belongs.
    const d = roundedPath(line, 12);

    const e = sizeFor(endKind);
    const st = sizeFor(startKind);
    const marks =
      (suppressed ? '' : tipMarkup(tipPath(tip.at, tip.dir, endKind, e.len, e.wid), edge.id)) +
      tipMarkup(tipPath(tail.at, tail.dir, startKind, st.len, st.wid), edge.id);
    endLabels.push(...cardinality(edge, tail.at, tail.dir, tip.at, tip.dir, scene));

    parts.push(
      `<path class="gc-edge gc-role-${role} gc-stroke-${edge.stroke}${edge.backward ? ' gc-back' : ''}${edge.bus ? ' gc-bus' : ''}${edge.wrapTrunkX !== undefined ? ' gc-wrap' : ''}" data-id="${esc(edge.id)}" ` +
        `data-from="${esc(edge.from)}" data-to="${esc(edge.to)}" pathLength="1" d="${d}"/>`,
    );
    arrows.push(marks);
    drawnEdges.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      onPath: role === 'path',
      backward: Boolean(edge.backward),
      hasLabel: Boolean(edge.label),
      d,
      stroke: edge.stroke,
    });

    // A pulse travels the spine during the emphasis pass. Drawn last so it sits
    // above the line it runs along, and inert until the motion layer times it.
    if (role === 'path') {
      sparks.push(
        `<circle class="gc-spark" data-id="${esc(edge.id)}" r="5" ` +
          `style="offset-path:path('${d}')"/>`,
      );
    }

    if (edge.label) {
      const fromBox = boxOf(edge.from);
      const toBox = boxOf(edge.to);
      const wrapped = edge.wrapTrunkX !== undefined;
      // DESIGN 1.6: a wrap bus's own label — unlike a plain leaf bus (DESIGN
      // 1.5), which never carries one — is handed to the same placer every
      // other edge's label is, `placeLabels` below, not placed by hand. But
      // the *segment* it is scored against is narrowed to the sibling's own
      // side of the row gap's run, not the edge's full four-point route or
      // even the run's own full reach to the corridor:
      //  - the placer's own scoring picks the longest segment first
      //    (`better()`, below), and this route's vertical corridor is always
      //    longer than the horizontal gap run — long enough on its own to
      //    win regardless of fit, which for a wide label seated "beside" a
      //    vertical line means offset by half the label's own *width*, not
      //    its height, landing it far out past the corridor;
      //  - the run's own far end is the corridor, a routing detail this
      //    label was never about — centring on the run's *own* midpoint (its
      //    only alternative, once the vertical corridor is excluded) pulls
      //    the label a corridor's width off toward it, when the sibling side
      //    costs nothing (`to` is this edge's own target, exempt from
      //    DESIGN 6.1's clearance floor) and the corridor side costs a full
      //    16 units of it.
      // One `GUTTER.panel` step past the sibling's own arrival x, toward the
      // corridor, is as far as the label is scored — real points on the
      // genuine drawn path either way (DESIGN 6.11's "within 8 of some point
      // of its own path" holds exactly the same), just the width actually
      // worth centring a label this wide against.
      const ownPoints =
        wrapped && line.length >= 4
          ? (() => {
              const gapY = line[1]!.y;
              const corridorX = line[1]!.x;
              const arriveX = line[2]!.x;
              const arriveTop = line[3]!.y;
              const towardCorridor = Math.sign(corridorX - arriveX) || 1;
              // Reaches from the sibling's own arrival point toward the
              // corridor, at least as far as the short final descent into
              // `to`'s own top face is long — long enough that this run, not
              // that one, stays the *longer* of the two the placer sees
              // (scoring picks the longest segment first, `better()` below),
              // while the descent still has to be included at all: DESIGN
              // 6.5's own gate check reads the whole drawn path, and a
              // candidate this file accepts must not swallow a run just
              // because this window never learned it was there.
              const reach = Math.max(GUTTER.panel * 2, Math.abs(arriveTop - gapY) + 8);
              return [
                { x: arriveX + towardCorridor * reach, y: gapY },
                { x: arriveX, y: gapY },
                { x: arriveX, y: arriveTop },
              ];
            })()
          : line;
      pendingLabels.push({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        text: edge.label,
        points: ownPoints,
        // 6 of knockout either side of the words, per DESIGN 6.5.
        width: (edge.labelWidth ?? edge.label.length * scene.edgeLabelSize * 0.62) + 12,
        height: scene.edgeLabelSize * 2,
        corridorY:
          !wrapped && !edge.backward && fromBox && toBox && toBox.y > fromBox.y
            ? toBox.y
            : undefined,
        corridorX:
          !wrapped && !edge.backward && fromBox && toBox && toBox.x > fromBox.x
            ? toBox.x
            : undefined,
      });
    }
  }

  // Labels are placed only once every route exists, because where one can go
  // depends on where the others ended up. Node boxes carry their id here so
  // the placer can tell "the box this edge belongs to" (never-overlap only)
  // from "every other box" (DESIGN 6.9's 8-clear) — panels count too, since a
  // cluster is a box an edge can land on same as any node.
  const labelNodeBoxes: NodeBox[] = [
    ...placed.map((n) => ({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height })),
    ...graph.clusters
      .filter((c) => panels.has(c.id))
      .map((c) => ({ id: c.id, ...panels.get(c.id)! })),
  ];
  const labelResult = placeLabels(pendingLabels, labelNodeBoxes, scene, edgeSegments, size, allowGrowth);
  parts.push(...labelResult.markup);

  // Every mark is drawn from its own line's tangent rather than hung off an SVG
  // marker, so there is nothing left in `defs` for an edge to point at — and no
  // remaining way for a head to be a different size or angle from its line.
  const viewBox = `${-pad} ${-pad} ${round(size.width + pad * 2)} ${round(size.height + pad * 2)}`;
  // DESIGN 6.10: how many `.gc-edge-label` groups the gate should find —
  // stamped at draw time, when `graph.edges` is still in hand, rather than
  // asked of the mermaid source later. Every edge with a label owes this
  // chart exactly one drawn label; the placer (DESIGN 6.9's own veto) is
  // never allowed to just drop one instead.
  const labelCount = graph.edges.filter((e) => e.label).length;
  const svg =
    `<svg class="gc-chart" data-gc="${uid}" data-flow="${graph.direction}" data-label-count="${labelCount}" viewBox="${viewBox}" role="img" xmlns="${SVG}">` +
    `${parts.join('')}${endLabels.join('')}${sparks.join('')}${arrows.join('')}</svg>`;

  // The union of everything actually drawn, in the same coordinates the
  // pieces above were placed in — see `Drawing.extent`.
  const extentBoxes: Extent[] = [...drawnBoxes, ...labelResult.boxes];
  const extentPoints: Point[] = edgeSegments.flatMap((s) => s.points);
  const exs = [...extentBoxes.map((b) => b.x), ...extentPoints.map((p) => p.x)];
  const exs1 = [...extentBoxes.map((b) => b.x + b.width), ...extentPoints.map((p) => p.x)];
  const eys = [...extentBoxes.map((b) => b.y), ...extentPoints.map((p) => p.y)];
  const eys1 = [...extentBoxes.map((b) => b.y + b.height), ...extentPoints.map((p) => p.y)];
  const ex0 = Math.min(...exs);
  const ey0 = Math.min(...eys);
  const ex1 = Math.max(...exs1);
  const ey1 = Math.max(...eys1);
  const extent = { x: ex0, y: ey0, width: ex1 - ex0, height: ey1 - ey0 };

  return {
    svg,
    width: size.width + pad * 2,
    height: size.height + pad * 2,
    nodes: drawnNodes,
    edges: drawnEdges,
    clusters: drawnClusters,
    inPanelNodes: drawnNodes.filter((id) => inPanel.has(id)),
    extent,
  };
}

/**
 * Draw the diagram, growing a corridor and trying again whenever a label's
 * own edge left DESIGN 6.9 nowhere to put it.
 *
 * `attemptDraw` reads node and cluster positions straight off `graph` — it
 * never returns adjusted ones — so growing a corridor means mutating those
 * positions directly (shifting everything from the crossing point down)
 * and re-running the whole thing on the changed graph, rather than passing
 * an adjustment back through every function this file has. `size` grows by
 * the same amount, in the same pass, so the canvas the caller frames this
 * against (DESIGN 1.1) is never a row shorter than what actually got drawn.
 * Capped at a few attempts: one corridor growing once is the case DESIGN
 * 6.10 exists for; a chart that still cannot seat every label after several
 * is drawn as the last attempt left it rather than looped forever.
 */
export function draw(graph: Graph, scene: Scene, size: { width: number; height: number }): Drawing {
  let extraW = 0;
  let extraH = 0;
  // Corridor growths are one grid step each (DESIGN 2.7), so a chart gets up
  // to 24 of them — 192 units in all — before the last, growth-free pass.
  // Each attempt may throw and grow one corridor, then re-lay-out from
  // scratch. The final call below disallows growth — placeLabels must not
  // throw there, it has to seat every label somewhere, gate-reported
  // violation or not, rather than this function running forever.
  const steps = new Map<string, number>();
  const allowed: GrowthAllowed = (edge, axis) =>
    (steps.get(`${edge}|${axis}`) ?? 0) < MAX_GROWTH_STEPS_PER_EDGE;
  for (let attempt = 0; attempt < 24; attempt++) {
    try {
      return attemptDraw(
        graph,
        scene,
        { width: size.width + extraW, height: size.height + extraH },
        allowed,
      );
    } catch (grow) {
      if (!(grow instanceof NeedsCorridorGrowth)) throw grow;
      const key = `${grow.edge}|${grow.axis}`;
      steps.set(key, (steps.get(key) ?? 0) + 1);
      // A corridor is the gap between two row (or column) bands, so the
      // shift moves whole bands: a node belongs past the corridor when its
      // *centre* is past the threshold. Testing its top edge instead once
      // split a row — a diamond (taller, top edge higher) stayed while the
      // box beside it moved, and the straight run between them became a
      // Z whose stubs no label could sit on.
      const past = (lo: number | undefined, len: number | undefined): boolean =>
        lo !== undefined && lo + (len ?? 0) / 2 >= grow.after;
      if (grow.axis === 'y') {
        for (const n of graph.nodes) if (past(n.y, n.height)) n.y! += grow.growBy;
        for (const c of graph.clusters) if (past(c.y, c.height)) c.y! += grow.growBy;
        extraH += grow.growBy;
      } else {
        for (const n of graph.nodes) if (past(n.x, n.width)) n.x! += grow.growBy;
        for (const c of graph.clusters) if (past(c.x, c.width)) c.x! += grow.growBy;
        extraW += grow.growBy;
      }
    }
  }
  return attemptDraw(
    graph,
    scene,
    { width: size.width + extraW, height: size.height + extraH },
    () => false,
  );
}

/** Emit a tip's two halves, each on the class that paints it. */
function tipMarkup(drawing: { fill: string; line: string }, id: string): string {
  return (
    (drawing.fill ? `<path class="gc-arrow" data-id="${esc(id)}" d="${drawing.fill}"/>` : '') +
    (drawing.line
      ? `<path class="gc-arrow gc-tip-line" data-id="${esc(id)}" d="${drawing.line}"/>`
      : '')
  );
}

/**
 * Cardinalities sit beside the end they describe, not at the midpoint.
 *
 * In `Cohort "1" --> "*" Student` the `1` belongs to Cohort and the `*` to
 * Student; putting both on the line's middle loses which is which, which is the
 * only thing they say.
 */
function cardinality(
  edge: GraphEdge,
  startAt: Point,
  startDir: Point,
  endAt: Point,
  endDir: Point,
  scene: Scene,
): string[] {
  const out: string[] = [];
  const place = (text: string, at: Point, dir: Point) => {
    // Just far enough back along the line to clear the marker, then out to the
    // side to clear the line itself. Pushing it further would slide both ends'
    // labels toward the middle, where it stops being clear which end each
    // describes — the only thing a cardinality says.
    const off = scene.edgeStroke * scene.tipLength * 1.15;
    const perp = { x: -dir.y, y: dir.x };
    const x = at.x - dir.x * off + perp.x * 13;
    const y = at.y - dir.y * off + perp.y * 13;
    out.push(
      `<text class="gc-card" data-id="${esc(edge.id)}" x="${round(x)}" y="${round(y)}">${esc(text)}</text>`,
    );
  };
  if (edge.labelStart) place(edge.labelStart, startAt, startDir);
  if (edge.labelEnd) place(edge.labelEnd, endAt, endDir);
  return out;
}

/**
 * A plain node's label, set on cap height rather than on the em box.
 *
 * DESIGN 10.2 and 10.3, and it is arithmetic rather than taste: Archivo's cap
 * height is about 0.72em, so centring a 12 name by its em box drops it four
 * units low and the two-line pair looks like it has slipped. On the 56-high box
 * that lands the name on `y + 24` and the caption on `y + 40`, which is exactly
 * where the golden puts them; on the 48-high box the lone name is at `y + 28`.
 */
function centredLabel(node: Placed, cx: number, cy: number): string {
  if (!node.title) return '';
  // A wrapped title (DESIGN 2.2: wrap rather than widen) is one label broken
  // in two, not a name and a caption, so it does not share the name+caption
  // pair's own 16-unit baseline gap: both lines keep the title's own full
  // size, and two 13-unit lines that close together overlap (a caption is
  // smaller than a name, which is the only reason 16 works there). 20 is
  // measured: at 13/600 Archivo, one line's own drawn height is ~17.3.
  if (node.titleLines) {
    return (
      `<text class="gc-title" x="${cx}" y="${round(cy - 6)}">${esc(node.titleLines[0])}</text>` +
      `<text class="gc-title" x="${cx}" y="${round(cy + 14)}">${esc(node.titleLines[1])}</text>`
    );
  }
  const titleY = node.caption ? cy - 4 : cy + 4;
  return (
    `<text class="gc-title" x="${cx}" y="${round(titleY)}">${esc(node.title)}</text>` +
    (node.caption
      ? `<text class="gc-caption" x="${cx}" y="${round(cy + 12)}">${esc(node.caption)}</text>`
      : '')
  );
}

/**
 * A compartmented node: a name band, then a block per group, ruled apart.
 *
 * The vertical arithmetic has to match `fitShape`'s `panel` case exactly — it is
 * the same header height and the same per-group allowance — or the rows drift
 * out of the box they were sized for.
 */
function panelLabel(node: Placed, scene: Scene): string {
  const cx = round(node.x + node.width / 2);
  const headerH = scene.type.name * 1.16 + scene.padY * 2;
  const left = round(node.x + scene.padX);
  const out: string[] = [
    `<text class="gc-title" x="${cx}" y="${round(node.y + headerH / 2 + scene.type.name * 0.36)}">${esc(node.title)}</text>`,
  ];

  const rule = (y: number) =>
    `<path class="gc-divider" d="M${round(node.x)},${round(y)} H${round(node.x + node.width)}"/>`;

  let cursor = node.y + headerH;
  const groups = node.rows ?? [];
  for (const group of groups) {
    out.push(rule(cursor));
    cursor += scene.padY * 0.5;
    for (const row of group) {
      out.push(
        `<text class="gc-row${row.strong ? ' gc-row-strong' : ''}" x="${left}" ` +
          `y="${round(cursor + scene.rowStep * 0.68)}">${esc(row.text)}</text>`,
      );
      cursor += scene.rowStep;
    }
    cursor += scene.padY * 0.5;
  }
  return out.join('');
}

interface LabelRequest {
  id: string;
  // The two nodes this edge connects. DESIGN 6.9's own gate check (`labelClear`
  // in packages/cli/src/measure/edges.ts) keeps a label 8 clear of every node
  // uniformly, these two included, so `from`/`to` are not read as an
  // exemption here — kept for `draw()`'s DrawnEdge bookkeeping and in case a
  // future rule does need to tell "this edge's own node" from "any other".
  from: string;
  to: string;
  text: string;
  points: Point[];
  width: number;
  height: number;
  // DESIGN 6.10: the y everything from the label's own target node down
  // would shift by, if this edge's own corridor turns out too tight for
  // DESIGN 6.9 to leave anywhere to place it. Undefined for a backward edge
  // or one whose target sits above its source — growing "down" is not the
  // fix there, and DESIGN 6.10's own scope is the forward, ranks-stack-down
  // case DESIGN 1.5's own charts hit.
  corridorY?: number;
  // Same idea, the other axis: how far everything from the target rightward
  // would shift, for a forward edge whose target sits to the right of its
  // source in the same row (an ER relationship between two side-by-side
  // entities is the fixture that needs this one).
  corridorX?: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A node or panel box, identified — so the placer can tell "belongs to this
 *  edge" (DESIGN 6.9's own boxes: never overlap, no 8-clear buffer needed)
 *  from every other box (8-clear required). */
interface NodeBox extends Box {
  id: string;
}

/** One edge's own routed points, kept for the "not on another edge" check. */
interface EdgeSegments {
  id: string;
  points: Point[];
}

const overlap = (a: Box, b: Box): number => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

/** Shortest distance from an axis-aligned box to a point (0 when inside). */
const distBoxPoint = (b: Box, x: number, y: number): number => {
  const dx = Math.max(b.x - x, 0, x - (b.x + b.width));
  const dy = Math.max(b.y - y, 0, y - (b.y + b.height));
  return Math.hypot(dx, dy);
};

/** Shortest distance from a point to a segment. */
const distPointSeg = (
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

/**
 * True Euclidean distance between an axis-aligned box and a straight segment
 * — 0 when they overlap. Both are axis-aligned (DESIGN 6.1), so the true
 * minimum is always at a box corner or a segment end, same as the gate's own
 * `distBoxSeg` (packages/cli/src/measure/edges.ts) — kept in step with it so
 * what this file measures agrees with what DESIGN 6.11 is checked against.
 */
const distBoxSeg = (b: Box, x1: number, y1: number, x2: number, y2: number): number => {
  const sx1 = Math.min(x1, x2);
  const sx2 = Math.max(x1, x2);
  const sy1 = Math.min(y1, y2);
  const sy2 = Math.max(y1, y2);
  if (sx1 < b.x + b.width && sx2 > b.x && sy1 < b.y + b.height && sy2 > b.y) return 0;
  let d = Math.min(distBoxPoint(b, x1, y1), distBoxPoint(b, x2, y2));
  for (const [cx, cy] of [
    [b.x, b.y],
    [b.x + b.width, b.y],
    [b.x + b.width, b.y + b.height],
    [b.x, b.y + b.height],
  ] as const) {
    d = Math.min(d, distPointSeg(cx, cy, x1, y1, x2, y2));
  }
  return d;
};

/** Every consecutive pair of points in a routed polyline, as segment ends. */
const pairsOf = (points: Point[]): { x1: number; y1: number; x2: number; y2: number }[] => {
  const out: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    out.push({ x1: points[i - 1]!.x, y1: points[i - 1]!.y, x2: points[i]!.x, y2: points[i]!.y });
  }
  return out;
};

/**
 * Chebyshev "keeps clear" test: true when `a` and `b` are closer than `clear`
 * on *both* axes at once. This is DESIGN 6.9's own gate check (`labelClear`
 * in packages/cli/src/measure/edges.ts) — an inflate-and-overlap test, not a
 * radial one — so a candidate this rejects is exactly one the gate would too.
 */
const tooClose = (a: Box, b: Box, clear: number): boolean =>
  a.x < b.x + b.width + clear &&
  b.x < a.x + a.width + clear &&
  a.y < b.y + b.height + clear &&
  b.y < a.y + a.height + clear;

/**
 * DESIGN 6.5/6.8: a plate only sits *on* its line — knocking the line out —
 * when it covers at most 60% of a horizontal run, or at most 40% of a
 * vertical one that is itself at least 64 long. A shorter vertical run never
 * has room: the plate would swallow it regardless of how narrow the label
 * is. Anything that fails this sits *beside* the line instead. Thresholds
 * read from `rules.ts` so this file and the gate's own swallow check cannot
 * drift apart.
 */
const onLineFits = (dir: Point, len: number, width: number, height: number): boolean => {
  const horiz = Math.abs(dir.y) < 0.02;
  const vert = Math.abs(dir.x) < 0.02;
  if (horiz) return width <= RULES['6.5']!.threshold! * len;
  if (vert) {
    return height <= RULES['6.5-vertical']!.threshold! * len && len >= RULES['6.5-min-run']!.threshold!;
  }
  return true; // not axis-aligned (shouldn't happen per 6.1) — leave as-is
};

// Matches the `roundedPath(line, 12)` call above: a corner eats up to this
// much off each straight run that meets it, capped to half of whichever
// adjoining run is shorter. What the gate (and a viewer) sees as "the
// straight part of the line" is the routed segment minus that cut at each
// end it shares with a corner — not the full routed length — so that is
// what DESIGN 6.5's coverage checks, and the search below, measure against.
const CORNER_RADIUS = 12;

interface OwnSegment {
  a: Point;
  b: Point;
  /** The segment's own length minus its corner cuts — see `CORNER_RADIUS`. */
  visLen: number;
  dir: Point;
  horiz: boolean;
}

/** An edge's routed polyline, split into its straight runs. */
const ownSegments = (points: Point[]): OwnSegment[] => {
  const raw = points.slice(1).map((b, i) => {
    const a = points[i]!;
    return { a, b, len: Math.hypot(b.x - a.x, b.y - a.y) };
  });
  const out: OwnSegment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const seg = raw[i]!;
    if (seg.len < 1) continue;
    const prev = raw[i - 1];
    const next = raw[i + 1];
    const cutStart = prev ? Math.min(CORNER_RADIUS, seg.len / 2, prev.len / 2) : 0;
    const cutEnd = next ? Math.min(CORNER_RADIUS, seg.len / 2, next.len / 2) : 0;
    const visLen = Math.max(0, seg.len - cutStart - cutEnd);
    const dir = { x: (seg.b.x - seg.a.x) / seg.len, y: (seg.b.y - seg.a.y) / seg.len };
    out.push({ a: seg.a, b: seg.b, visLen, dir, horiz: Math.abs(dir.y) < 0.02 });
  }
  return out;
};

interface Candidate {
  box: Box;
  segLen: number;
  midDist: number;
  /** 0 when this candidate is the preferred kind (ON/BESIDE) for its own
   *  segment, 1 otherwise — see the scoring rule below. */
  kindRank: number;
  /** Distance to the nearest other edge — the final tie-break, and (for a
   *  fallback candidate) part of how "violating" it is. */
  sideDist: number;
}

/**
 * Put each edge label somewhere it can actually be read — DESIGN 6.5/6.9/6.11
 * as one constrained search, not a search plus patches on top of it.
 *
 * Per label: every 5% step along every straight run of its own edge offers
 * up to three candidates (on the line, and beside it on each side, exactly 8
 * clear); each is kept only if it clears every hard rule (6.9's node
 * clearance, 6.11's 16-from-every-other-edge, the canvas itself, and every
 * label already placed); survivors are scored by segment length, then
 * nearness to that segment's middle, then whether the candidate's kind
 * (on/beside) is the one this label and segment prefer, then, only to break
 * an exact tie between a run's two sides, which one sits farther from the
 * nearest other edge.
 *
 * No survivor at all means the edge's own corridor is too tight — `draw()`
 * grows it and redraws the whole chart, up to three times (DESIGN 6.9's own
 * veto never stands with nothing behind it). Once growth is no longer
 * allowed (the final attempt, or an edge with no corridor to grow — a
 * loop-back, or one running the wrong way), DESIGN 6.10 still requires the
 * label to be drawn: the least-bad candidate is used instead, and the gate
 * reports whatever it still violates.
 *
 * Longest label first: it has the fewest positions that fit, so it should
 * choose before the short ones take the room.
 */
function placeLabels(
  requests: LabelRequest[],
  nodes: NodeBox[],
  scene: Scene,
  edgeSegments: EdgeSegments[],
  size: { width: number; height: number },
  allowGrowth: GrowthAllowed,
): { markup: string[]; boxes: Box[] } {
  const taken: Box[] = [];
  const out: string[] = [];
  const order = [...requests].sort((a, b) => b.width - a.width);
  const NODE_CLEAR = RULES['6.9']!.threshold!; // 8
  const OTHER_EDGE_CLEAR = RULES['6.11-other']!.threshold!; // 16
  const OWN_EDGE_CLEAR = RULES['6.11']!.threshold!; // 8 — matches the beside offset below
  const LABEL_CLEAR = 8; // 6.5: plates never overlap each other

  for (const request of order) {
    const segs = ownSegments(request.points);
    // Every other edge's segments, not just the ones that carry a label of
    // their own — DESIGN 6.11 forbids a plate sitting near any edge but its
    // own, whether or not that edge is labelled.
    const otherPairs = edgeSegments
      .filter((e) => e.id !== request.id)
      .flatMap((e) => pairsOf(e.points));
    const ownPairs = pairsOf(request.points);

    // The gate's own swallow check (`labelSwallow` in
    // packages/cli/src/measure/edges.ts) reads the edge's *drawn* `d`
    // attribute, not the straight-segment model above — and it extracts every
    // number in that string as a point, `Q`'s own control point included. A
    // corner's rounding (`roundedPath(line, 12)`, the same call `draw()`
    // makes below) turns each real corner into three points spanning at most
    // 12 units, which the gate then treats as its own tiny "segment" — one a
    // wide plate can seem to sit "on" (its width alone puts its centre within
    // that segment's own x-reach) even while sitting nowhere near it, exactly
    // the way a wide label beside a long run can still read as swallowing a
    // short stub elsewhere on the same edge. Rather than special-case that,
    // this replicates the gate's own extraction and test, so a candidate
    // this file accepts is one the gate accepts too.
    // DESIGN 6.5, the same test the gate runs (`labelSwallow` in
    // packages/cli/src/measure/labels.ts): a label is "on" a run when the
    // line passes through its box; runs under 16 are corner stubs and do not
    // count. Straight segments only — a rounded corner is not a run.
    const swallowsOwnEdge = (box: Box): boolean => {
      for (const { x1, y1, x2, y2 } of ownPairs) {
        const horiz = Math.abs(y1 - y2) < 1;
        const vert = Math.abs(x1 - x2) < 1;
        const len = horiz ? Math.abs(x2 - x1) : vert ? Math.abs(y2 - y1) : 0;
        if (len < 16) continue;
        const onH =
          horiz &&
          y1 > box.y &&
          y1 < box.y + box.height &&
          box.x + box.width > Math.min(x1, x2) &&
          box.x < Math.max(x1, x2);
        const onV =
          vert &&
          x1 > box.x &&
          x1 < box.x + box.width &&
          box.y + box.height > Math.min(y1, y2) &&
          box.y < Math.max(y1, y2);
        if (onH && box.width > RULES['6.5']!.threshold! * len) return true;
        if (
          onV &&
          (box.height > RULES['6.5-vertical']!.threshold! * len ||
            len < RULES['6.5-min-run']!.threshold!)
        ) {
          return true;
        }
      }
      return false;
    };

    const distToOthers = (box: Box): number => {
      let d = Infinity;
      for (const p of otherPairs) d = Math.min(d, distBoxSeg(box, p.x1, p.y1, p.x2, p.y2));
      return d;
    };
    const distToOwnPath = (box: Box): number => {
      let d = Infinity;
      for (const p of ownPairs) d = Math.min(d, distBoxSeg(box, p.x1, p.y1, p.x2, p.y2));
      return d;
    };

    // Hard constraints (DESIGN 6.9, 6.11, and the canvas/label bookkeeping
    // every chart already relies on): reject outright rather than merely
    // discourage — the search keeps trying other positions instead of
    // settling for "close enough". The gate's own 6.9 check (`labelClear` in
    // packages/cli/src/measure/edges.ts) applies the 8-clear to every node
    // uniformly, with no exemption for the two the label's own edge
    // connects — so this does too, even though DESIGN 6.9's prose reads as
    // if "never overlap" were enough for those two.
    const violates = (box: Box): boolean => {
      // Not a hard "stay inside `size`": `size` is the layout's own
      // pre-label content box, and DESIGN 1.1's frame is fitted to
      // `drawing.extent` afterward — which already unions in every placed
      // label's own box — so a candidate landing a little past it just
      // grows the final frame to hug it, the same way it already hugs an
      // edge that routes past `size`'s own edge. Only the canvas's *near*
      // corner (negative x/y) stays a hard wall; there is no fitting step
      // that would ever pull the origin back to meet a candidate above or
      // left of it.
      if (box.x < 0 || box.y < 0) return true;
      for (const n of nodes) {
        if (tooClose(box, n, NODE_CLEAR)) return true;
      }
      for (const p of otherPairs) {
        if (distBoxSeg(box, p.x1, p.y1, p.x2, p.y2) < OTHER_EDGE_CLEAR) return true;
      }
      // Half a unit of slack, the other way: a BESIDE candidate sits exactly 8
      // from its line by construction, and float error must not turn 8 into
      // 8.0000001 and reject every one of them (it did — every beside spot
      // failed and labels grew corridors they never needed).
      if (distToOwnPath(box) > OWN_EDGE_CLEAR + 0.5) return true;
      if (swallowsOwnEdge(box)) return true;
      for (const t of taken) {
        if (tooClose(box, t, LABEL_CLEAR)) return true;
      }
      return false;
    };

    // DESIGN 6.10's own fallback: how deep a candidate sits inside each
    // forbidden buffer, so that when nothing clears every rule the least-bad
    // one still wins rather than an arbitrary one. Zero exactly when
    // `violates` above would also say the candidate is clean.
    const badness = (box: Box): number => {
      let bad = 0;
      const overshoot =
        Math.max(0, -box.x) +
        Math.max(0, -box.y) +
        Math.max(0, box.x + box.width - size.width) +
        Math.max(0, box.y + box.height - size.height);
      bad += overshoot * 1000; // off the canvas is always worse than any crowding
      for (const n of nodes) {
        const padded: Box = {
          x: n.x - NODE_CLEAR,
          y: n.y - NODE_CLEAR,
          width: n.width + NODE_CLEAR * 2,
          height: n.height + NODE_CLEAR * 2,
        };
        bad += overlap(box, padded);
      }
      for (const p of otherPairs) {
        const d = distBoxSeg(box, p.x1, p.y1, p.x2, p.y2);
        if (d < OTHER_EDGE_CLEAR) bad += (OTHER_EDGE_CLEAR - d) * 20;
      }
      const own = distToOwnPath(box);
      if (own > OWN_EDGE_CLEAR) bad += (own - OWN_EDGE_CLEAR) * 20;
      if (swallowsOwnEdge(box)) bad += 500;
      for (const t of taken) {
        const padded: Box = {
          x: t.x - LABEL_CLEAR,
          y: t.y - LABEL_CLEAR,
          width: t.width + LABEL_CLEAR * 2,
          height: t.height + LABEL_CLEAR * 2,
        };
        bad += overlap(box, padded);
      }
      return bad;
    };

    // Scoring for survivors (DESIGN's own order): longest segment, then
    // nearest that segment's middle, then the preferred kind for this
    // label/segment pair, then — only ever a real tie-break between a run's
    // two BESIDE sides — the one farther from the nearest other edge.
    const better = (a: Candidate, b: Candidate): boolean => {
      if (a.segLen !== b.segLen) return a.segLen > b.segLen;
      if (a.midDist !== b.midDist) return a.midDist < b.midDist;
      if (a.kindRank !== b.kindRank) return a.kindRank < b.kindRank;
      return a.sideDist > b.sideDist;
    };

    let bestValid: Candidate | null = null;
    let bestFallback: (Candidate & { bad: number }) | null = null;

    const consider = (box: Box, segLen: number, midDist: number, kindRank: number) => {
      const cand: Candidate = { box, segLen, midDist, kindRank, sideDist: distToOthers(box) };
      if (!violates(box)) {
        if (!bestValid || better(cand, bestValid)) bestValid = cand;
        return;
      }
      const bad = badness(box);
      if (!bestFallback || bad < bestFallback.bad || (bad === bestFallback.bad && better(cand, bestFallback))) {
        bestFallback = { ...cand, bad };
      }
    };

    for (const seg of segs) {
      const alongSize = seg.horiz ? request.width : request.height;
      const crossSize = seg.horiz ? request.height : request.width;
      // The beside offset is fixed, not searched: the label's near edge sits
      // exactly 8 clear of the line (DESIGN 6.11), half the plate's own
      // cross-line size further out to reach the plate's centre.
      const minOffset = crossSize / 2 + 8;
      const eligibleOn = onLineFits(seg.dir, seg.visLen, request.width, request.height);
      // DESIGN's own scoring rule: ON beats BESIDE when the label is shorter
      // than the segment it would sit on; BESIDE beats ON otherwise.
      const preferOn = alongSize < seg.visLen;
      const perp = { x: -seg.dir.y, y: seg.dir.x };
      for (let step = 1; step <= 19; step++) {
        const t = step * 0.05;
        const midDist = Math.abs(t - 0.5);
        const px = seg.a.x + (seg.b.x - seg.a.x) * t;
        const py = seg.a.y + (seg.b.y - seg.a.y) * t;
        if (eligibleOn) {
          consider(
            { x: px - request.width / 2, y: py - request.height / 2, width: request.width, height: request.height },
            seg.visLen,
            midDist,
            preferOn ? 0 : 1,
          );
        }
        for (const side of [1, -1]) {
          const cx = px + perp.x * minOffset * side;
          const cy = py + perp.y * minOffset * side;
          consider(
            { x: cx - request.width / 2, y: cy - request.height / 2, width: request.width, height: request.height },
            seg.visLen,
            midDist,
            preferOn ? 1 : 0,
          );
        }
      }
    }

    // Copied out of the mutable `let`s so TypeScript can narrow them below.
    // Both are only ever reassigned inside the `consider` closure above —
    // TypeScript's flow analysis does not see across that closure boundary,
    // so without the cast it treats each as permanently `null`, its only
    // directly-visible assignment in this function's own body.
    const foundValid = bestValid as Candidate | null;
    const foundFallback = bestFallback as (Candidate & { bad: number }) | null;

    // How long a corridor growth's own segment already is, per axis — a
    // horizontal growth lengthens the edge's longest *horizontal* run, a
    // vertical one its longest *vertical* run, which are not always the same
    // segment (`state.mmd`'s `Running`→`Graduated` has a 168-long horizontal
    // middle run and two ~12-long vertical stubs either side of it).
    // DESIGN 2.7: a corridor grows by one grid step at a time, re-routes and
    // tries again, so the room a label ends up with is the smallest that
    // works — never a formula's guess at it.
    const growBy = (): number => GRID;

    // DESIGN 1.1: a chart at a declared `display` has already been packed to
    // fit it (1.5's leaf stacking, 1.2's fold) — a label-driven corridor
    // growth is not allowed to spend that budget back out. Only the width
    // side of this is capped; height is "whatever the content needs" (1.1)
    // and grows freely either way.
    const maxContentWidth = scene.canvas.width - scene.canvas.margin * 2;
    // DESIGN 7.4 (the gate's own `7.4-even-whitespace`): two nodes in the
    // same row band never end up more than 200 apart edge-to-edge with
    // nothing between them. An X growth only shifts nodes at or past its own
    // threshold (`state.mmd`'s `Graduated`, not its row-mate `Paused`, which
    // sits to the left of it) — so it can turn a tight, even row into one
    // with a single node stranded far to the right. Checked here, before the
    // growth is ever thrown, rather than after the fact.
    const wouldStrandRowMate = (thresholdX: number, targetId: string, growAmount: number): boolean => {
      const target = nodes.find((n) => n.id === targetId);
      if (!target) return false;
      const rowMates = nodes.filter(
        (n) =>
          n.id !== targetId &&
          n.x < thresholdX &&
          n.y < target.y + target.height &&
          n.y + n.height > target.y,
      );
      if (!rowMates.length) return false;
      const nearestRight = Math.max(...rowMates.map((n) => n.x + n.width));
      // `target.x` is its *current* left edge; growth shifts it (and
      // everything at or past `thresholdX`) right by `growAmount`, so its
      // new left edge — what the row-mate would actually end up that far
      // from — is `target.x + growAmount`, not `target.x` itself.
      return target.x + growAmount - nearestRight > RULES['7.4-even-whitespace']!.threshold!;
    };
    // Can this axis actually grow right now? X additionally has to stay
    // inside the display cap and not actually strand a row-mate past 200
    // (7.4); Y never has to ask either question.
    // Growth only helps along an axis the edge actually runs on: widening a
    // column gap lengthens a horizontal run, a row gap a vertical one. A
    // straight horizontal edge asked for row growth twelve times before
    // (4geeks-journey's "yes"), moving rows apart for a label that only a
    // longer run could seat.
    const runsH = segs.some((g) => g.horiz);
    const runsV = segs.some((g) => !g.horiz);
    const canGrow = (axis: 'x' | 'y'): boolean =>
      axis === 'x'
        ? runsH &&
          request.corridorX !== undefined &&
          size.width + growBy() <= maxContentWidth &&
          !wouldStrandRowMate(request.corridorX, request.to, growBy())
        : runsV && request.corridorY !== undefined;
    // Whichever axis actually costs less canvas: an X growth of `g` adds
    // `g × current height` of area, a Y growth of `g` adds `g × current
    // width` — comparing those, not just the raw growth amounts, is what
    // "least canvas area" means once the two axes start from different
    // sizes.
    const addedArea = (axis: 'x' | 'y'): number =>
      axis === 'x' ? growBy() * size.height : growBy() * size.width;
    // DESIGN 6.10: a veto never stands with nothing behind it. Cheapest,
    // 7.4-safe axis first; if only one of the two can grow at all, that one;
    // if only X can and it would break 7.4, take it anyway rather than drop
    // the label — a 7.4 fail is still better than 6.9/6.11 not holding.
    const xOk = allowGrowth(request.id, 'x') && canGrow('x');
    const yOk = allowGrowth(request.id, 'y') && canGrow('y');
    const growAxis: 'x' | 'y' | undefined = xOk
      ? yOk
        ? addedArea('x') <= addedArea('y')
          ? 'x'
          : 'y'
        : 'x'
      : yOk
        ? 'y'
        : allowGrowth(request.id, 'x') && request.corridorX !== undefined && size.width + growBy() <= maxContentWidth
          ? 'x'
          : undefined;

    let winner: Box;
    if (foundValid) {
      winner = foundValid.box;
    } else if (growAxis === 'x') {
      throw new NeedsCorridorGrowth('x', request.corridorX!, growBy(), request.id);
    } else if (growAxis === 'y') {
      throw new NeedsCorridorGrowth('y', request.corridorY!, growBy(), request.id);
    } else if (foundFallback) {
      winner = foundFallback.box;
    } else {
      // No measurable segment at all (a degenerate, near-zero-length edge):
      // the last resort so DESIGN 6.10 still holds — the centre of the
      // path's own bounding box.
      const xs = request.points.map((p) => p.x);
      const ys = request.points.map((p) => p.y);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      winner = {
        x: cx - request.width / 2,
        y: cy - request.height / 2,
        width: request.width,
        height: request.height,
      };
    }

    taken.push(winner);
    const cx = winner.x + winner.width / 2;
    const cy = winner.y + winner.height / 2;
    out.push(
      `<g class="gc-edge-label" data-id="${esc(request.id)}">` +
        `<rect class="gc-plate" x="${round(winner.x)}" y="${round(winner.y)}" ` +
        `width="${round(winner.width)}" height="${round(winner.height)}" rx="3"/>` +
        `<text x="${round(cx)}" y="${round(cy + scene.edgeLabelSize * 0.36)}">${esc(request.text)}</text>` +
        `</g>`,
    );
  }
  return { markup: out, boxes: taken };
}
