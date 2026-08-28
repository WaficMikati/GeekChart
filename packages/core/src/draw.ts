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
import { GRID } from './tokens.ts';

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
 */
class NeedsCorridorGrowth {
  afterY: number;
  growBy: number;
  constructor(afterY: number, growBy: number) {
    this.afterY = afterY;
    this.growBy = growBy;
  }
}

/**
 * Lay the drawing out once. Everything below reads final node positions off
 * `graph` and computes routes, arrows and labels from them — `draw()`, below,
 * is what re-enters this after growing a corridor DESIGN 6.9 left a label no
 * room in.
 */
function attemptDraw(graph: Graph, scene: Scene, size: { width: number; height: number }): Drawing {
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
  for (const edge of routed) {
    if (!edge.bus) continue;
    const from = boxOf(edge.from);
    const to = boxOf(edge.to);
    if (!from || !to) continue;
    const trunkX = from.x + TRUNK_OFFSET;
    const rowY = to.y + to.height / 2;
    const route: OrthoRoute = {
      points: [
        { x: trunkX, y: from.y + from.height },
        { x: trunkX, y: rowY },
        { x: to.x, y: rowY },
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
      `<path class="gc-edge gc-role-${role} gc-stroke-${edge.stroke}${edge.backward ? ' gc-back' : ''}${edge.bus ? ' gc-bus' : ''}" data-id="${esc(edge.id)}" ` +
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
      pendingLabels.push({
        id: edge.id,
        text: edge.label,
        points: line,
        // 6 of knockout either side of the words, per DESIGN 6.5.
        width: (edge.labelWidth ?? edge.label.length * scene.edgeLabelSize * 0.62) + 12,
        height: scene.edgeLabelSize * 2,
        corridorY:
          !edge.backward && fromBox && toBox && toBox.y > fromBox.y ? toBox.y : undefined,
      });
    }
  }

  // Labels are placed only once every route exists, because where one can go
  // depends on where the others ended up.
  const labelResult = placeLabels(
    pendingLabels,
    placed.map((n) => ({ x: n.x, y: n.y, width: n.width, height: n.height })),
    scene,
    edgeSegments,
    // DESIGN 1.5 only: a stacked fan turned into an opaque unit for layout
    // can leave the *other* branch of a decision reaching it through an
    // extra bend that never existed before, whose only short segments then
    // have nowhere sensible to swing a wide label out to. Scoped to charts
    // that actually stacked a fan, so it changes nothing for the other 36
    // fixtures, none of which ever set this.
    graph.edges.some((e) => e.bus),
  );
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
  let extra = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return attemptDraw(graph, scene, { width: size.width, height: size.height + extra });
    } catch (grow) {
      if (!(grow instanceof NeedsCorridorGrowth)) throw grow;
      for (const n of graph.nodes) if (n.y !== undefined && n.y >= grow.afterY) n.y += grow.growBy;
      for (const c of graph.clusters) if (c.y !== undefined && c.y >= grow.afterY) c.y += grow.growBy;
      extra += grow.growBy;
    }
  }
  return attemptDraw(graph, scene, { width: size.width, height: size.height + extra });
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
  // A wrapped title (DESIGN 2.2: wrap rather than widen) sits on the same two
  // baselines a title+caption pair would, but both lines keep the title's
  // own face — it is one label broken in two, not a name and a caption.
  if (node.titleLines) {
    return (
      `<text class="gc-title" x="${cx}" y="${round(cy - 4)}">${esc(node.titleLines[0])}</text>` +
      `<text class="gc-title" x="${cx}" y="${round(cy + 12)}">${esc(node.titleLines[1])}</text>`
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
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
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

/**
 * An edge's segments as thin boxes, so a segment-vs-plate check can reuse
 * `overlap` above. Routes are axis-aligned polylines (DESIGN 6.1), so a
 * one-unit-wide box on either side of the line is exact, not an
 * approximation.
 */
const segmentBoxes = (points: Point[]): Box[] => {
  const boxes: Box[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    const half = 1;
    boxes.push({
      x: Math.min(a.x, b.x) - half,
      y: Math.min(a.y, b.y) - half,
      width: Math.abs(b.x - a.x) + half * 2,
      height: Math.abs(b.y - a.y) + half * 2,
    });
  }
  return boxes;
};

/**
 * Put each edge label somewhere it can actually be read.
 *
 * A label pinned to its edge's midpoint is fine until two edges have midpoints
 * near each other — then the second label's opaque plate covers the first, and
 * the diagram silently loses a word. Sliding the label along its own edge keeps
 * it unambiguously attached to that edge while letting it step out of the way,
 * which moving it sideways would not.
 *
 * Longest label first: it has the fewest positions that fit, so it should choose
 * before the short ones take the room.
 */
function placeLabels(
  requests: LabelRequest[],
  nodes: Box[],
  scene: Scene,
  edgeSegments: EdgeSegments[],
  capOffLineReach = false,
): { markup: string[]; boxes: Box[] } {
  const taken: Box[] = [];
  const out: string[] = [];
  const order = [...requests].sort((a, b) => b.width - a.width);
  const segmentsByEdge = new Map(edgeSegments.map((e) => [e.id, segmentBoxes(e.points)]));

  // Sliding alone is not always enough: two edges leaving the same box run close
  // together for their whole length, so every position along one collides with
  // the other. Stepping off the line perpendicular gives the search somewhere
  // else to go, and the penalty below keeps it on the line when it can be.
  // DESIGN §3's raised label size (11, up from 8) widened plates by about a
  // third — "final project shipped" plates at 187 wide, wider than the old
  // ceiling here could ever clear. The steps go past what a two-label clash
  // needs (half of one wide plate plus the other's own half-width) so the
  // search can actually find the clear spot instead of settling for the least
  // bad of a set that never reached it.
  // DESIGN 6.9: extended past the old 78 ceiling — a label whose own
  // segment barely qualifies as "fits on-line" (width just under the
  // 60%/40% ceiling) still only has that segment's own length to hide
  // in sideways; clearing a neighbour that crosses it near one end can
  // need more room than a comfortably-fitting label ever would.
  const nudges = [0, 14, -14, 26, -26, 40, -40, 58, -58, 78, -78, 98, -98, 118, -118, 138, -138];

  /**
   * Where a label could sit on an orthogonal route.
   *
   * By *segment*, not by fraction of the whole length. A route that goes down,
   * across and down has three quite different places to put a word, and the
   * arc-length midpoint of the three is usually a corner — the one place a plate
   * cannot go. Longest segment first, because that is the one with room.
   */
  // Matches the `roundedPath(line, 12)` call above: a corner eats up to this
  // much off each straight run that meets it, capped to half of whichever
  // adjoining run is shorter. What the gate (and a viewer) sees as "the
  // straight part of the line" is the routed segment minus that cut at each
  // end it shares with a corner — not the full routed length — so that is
  // what the 64-long / 40% checks below have to measure against.
  const CORNER_RADIUS = 12;

  const anchors = (points: Point[]): { at: Point; dir: Point; drift: number; len: number }[] => {
    const segments = points.slice(1).map((b, i) => {
      const a = points[i]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      return { a, b, len };
    });
    const total = segments.reduce((sum, s) => sum + s.len, 0) || 1;
    const out: { at: Point; dir: Point; drift: number; len: number }[] = [];
    for (const seg of [...segments].sort((p, q) => q.len - p.len)) {
      if (seg.len < 1) continue;
      const i = segments.indexOf(seg);
      const prev = segments[i - 1];
      const next = segments[i + 1];
      const cutStart = prev ? Math.min(CORNER_RADIUS, seg.len / 2, prev.len / 2) : 0;
      const cutEnd = next ? Math.min(CORNER_RADIUS, seg.len / 2, next.len / 2) : 0;
      const visLen = Math.max(0, seg.len - cutStart - cutEnd);
      const dir = { x: (seg.b.x - seg.a.x) / seg.len, y: (seg.b.y - seg.a.y) / seg.len };
      // DESIGN 6.9: every node box plus 8 is forbidden ground, so the search
      // has to be able to slide all the way toward either end of a segment
      // to find clear space past a neighbour that crowds the middle — five
      // points clustered near the centre never reach far enough. Centre-out
      // order, so a nearer spot still wins over a farther one whenever both
      // turn out clear (the caller keeps searching past the first clear hit
      // only to compare against ones already found — `drift`, below, is what
      // actually decides that, but trying the near ones first keeps the
      // common case cheap).
      for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9, 0.05, 0.95]) {
        out.push({
          at: { x: seg.a.x + (seg.b.x - seg.a.x) * t, y: seg.a.y + (seg.b.y - seg.a.y) * t },
          dir,
          // Short segments and off-centre stops are both a compromise; charge
          // for them so the obvious place wins whenever it is free.
          drift: (1 - seg.len / total) * 30 + Math.abs(t - 0.5) * 40,
          len: visLen,
        });
      }
    }
    return out;
  };

  // DESIGN 6.5: a plate only sits *on* its line — knocking the line out —
  // when it covers at most 60% of a horizontal segment, or at most 40% of a
  // vertical one that is itself at least 64 long. A shorter vertical segment
  // never has room: the plate would swallow it regardless of how narrow the
  // label is. Anything that fails this sits *beside* the line instead: pushed
  // perpendicular just clear of it (half the plate's cross-line size, plus an
  // 8 gap), so the plate no longer overlaps the line at all and needs no
  // knockout. This mirrors the gate's own swallow check (gate.mjs) so what
  // passes here passes there.
  const onLineFits = (dir: Point, len: number, width: number, height: number): boolean => {
    const horiz = Math.abs(dir.y) < 0.02;
    const vert = Math.abs(dir.x) < 0.02;
    if (horiz) return width <= 0.6 * len;
    if (vert) return height <= 0.4 * len && len >= 64;
    return true; // not axis-aligned (shouldn't happen per 6.1) — leave as-is
  };

  for (const request of order) {
    // Two costs, compared in order rather than added together. They were a
    // single number, and because an overlap area and a displacement were in the
    // same units a 0.2px overlap (cost 7.8) beat a clean 16px nudge (cost 9.6) —
    // the label sat on its neighbour to stay nearer the middle of its line.
    // Clearing other labels is not a preference to be traded off; it is the
    // point.
    // Every other edge's segments, not just the ones that carry a label —
    // DESIGN 6.5 forbids a plate sitting on any edge but its own.
    const otherSegments = edgeSegments
      .filter((e) => e.id !== request.id)
      .flatMap((e) => segmentsByEdge.get(e.id) ?? []);

    // DESIGN 1.5 only (`capOffLineReach`): how far off-line a candidate may
    // go, bounded by the edge's own reach rather than the label's size. A
    // wide label beside a short segment on an edge that is otherwise short
    // too has nowhere sensible to sit that far out — the plate-width
    // clearance below (`minOffset`) does not know that, and can push the
    // label well past everything the edge itself ever comes near: clash-free
    // on a technicality, but nowhere a reader would connect back to it. Left
    // unbounded for every ordinary chart (`capOffLineReach` false), since
    // that is the search this file already relies on elsewhere.
    const edgeBox = request.points.reduce(
      (b, p) => ({
        x0: Math.min(b.x0, p.x),
        y0: Math.min(b.y0, p.y),
        x1: Math.max(b.x1, p.x),
        y1: Math.max(b.y1, p.y),
      }),
      { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
    );
    const cappedNudge = capOffLineReach
      ? Math.max(edgeBox.x1 - edgeBox.x0, edgeBox.y1 - edgeBox.y0) + 20
      : Infinity;

    // One search, run once per allowed reach. DESIGN 6.10: a veto never
    // stands with nothing behind it — the first pass keeps `capOffLineReach`
    // charts (DESIGN 1.5) from reading a bus's own edge as its label's
    // corridor; if that pass finds nothing (every candidate on the edge is
    // within 8 of a box, DESIGN 6.9), a second, uncapped pass grows the
    // search past it rather than dropping the label. Growing "by the
    // label's own height + 8" is exactly what the off-line `minOffset`
    // below already steps by — this just stops refusing to take enough of
    // those steps.
    // DESIGN 6.10's fallback pass reaches further off-line than a normal
    // placement ever needs to — extra steps a chart that already finds a
    // spot on the base list has no reason to be offered, and offering them
    // anyway once moved `state.mmd`'s own label practically for free (a
    // farther, still clash-free spot beat a nearer one on drift alone), which
    // is a dimension change DESIGN 1.1 promises never to make outside this
    // feature. `extraSteps` stays empty for the base attempt and is only
    // ever filled in for the fallback, below.
    const search = (
      limit: number,
      extraSteps: number[],
    ): { box: Box; clash: number; drift: number } | null => {
      let best: { box: Box; clash: number; drift: number } | null = null;
      const spots = anchors(request.points);
      // A short elbow — the corner stub between two longer runs, not a real
      // place anyone would look for a label — is not a candidate for the
      // off-line push at all once a longer run on the same edge exists: an
      // 8-from-the-line offset that reads as "beside this run" on a long
      // segment reads as "beside some other run entirely" on one this
      // short, since the box ends up wider than the stub itself (DESIGN
      // 6.11 asks for the label's own edge, not just any point on it).
      const hasLongRun = spots.some((s) => s.len >= 40);
      outer: for (const spot of spots) {
        const { at, dir, len } = spot;
        const perp = { x: -dir.y, y: dir.x };
        // If sitting on this segment would swallow it, skip the on-line (nudge
        // 0) spots entirely and start from just clear of the line instead:
        // its centre offset by half the plate's own cross-line size (height
        // for a horizontal segment, width for a vertical one) plus 8, which
        // is what puts the plate's own *near* edge — not its centre — 8 from
        // the line (DESIGN 6.11). Extra steps beyond that are only for
        // dodging other labels/edges, same as the on-line case.
        const horiz = Math.abs(dir.y) < 0.02;
        const crossSize = horiz ? request.height : request.width;
        const minOffset = crossSize / 2 + 8;
        const fitsOnLine = onLineFits(dir, len, request.width, request.height);
        if (!fitsOnLine && len < 40 && hasLongRun) continue;
        const offLineSteps = fitsOnLine
          ? nudges
          : [0, 14, 26, 40, 58, 78, ...extraSteps].flatMap((step) => [
              minOffset + step,
              -(minOffset + step),
            ]);
        const spotNudges = offLineSteps.filter((n) => Math.abs(n) <= limit);
        for (const nudge of spotNudges) {
          const cx = at.x + perp.x * nudge;
          const cy = at.y + perp.y * nudge;
          const box: Box = {
            x: cx - request.width / 2,
            y: cy - request.height / 2,
            width: request.width,
            height: request.height,
          };
          // Tested with a little air around it, so two labels end up clearly
          // apart rather than exactly touching.
          const padded: Box = {
            x: box.x - 3,
            y: box.y - 3,
            width: box.width + 6,
            height: box.height + 6,
          };
          // DESIGN 6.9: a node box plus 8 is forbidden outright, not merely
          // discouraged — a candidate that close is skipped before it is ever
          // scored, so the search keeps sliding (more `t` values, above) or
          // keeps stepping (more nudges) until it finds one that is not,
          // rather than settling for "close enough" the way a discounted cost
          // used to let it.
          const nodeGuard: Box = { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 };
          if (nodes.some((b) => overlap(nodeGuard, b) > 0)) continue;
          // A label brushing another label — or another edge's own line — is
          // not survivable; both are full weight, same as always.
          const clash =
            taken.reduce((sum, b) => sum + overlap(padded, b), 0) +
            otherSegments.reduce((sum, b) => sum + overlap(padded, b), 0);
          const drift = Math.abs(nudge) * 0.6 + spot.drift;
          if (!best || clash < best.clash || (clash === best.clash && drift < best.drift)) {
            best = { box, clash, drift };
          }
          if (clash === 0) break outer;
        }
      }
      return best;
    };

    // DESIGN 6.10: a veto never stands with nothing behind it. This is
    // exactly the search every chart already relied on (original step
    // list, `capOffLineReach`'s own cap for DESIGN 1.5 charts) — nothing
    // about it changes for the other 36 fixtures, which always find a spot
    // here. A label whose own edge has nowhere clear is not, any more,
    // walked further and further off that edge until something happens to
    // be empty (DESIGN 6.11: wherever it lands has to still be *its*
    // edge) — it throws, and `draw()` grows the corridor this edge crosses
    // and draws the whole chart again.
    const best = search(cappedNudge, []);
    if (!best) {
      if (request.corridorY === undefined) continue;
      throw new NeedsCorridorGrowth(
        request.corridorY,
        Math.ceil((request.height + 8) / GRID) * GRID,
      );
    }
    taken.push(best.box);
    const cx = best.box.x + best.box.width / 2;
    const cy = best.box.y + best.box.height / 2;
    out.push(
      `<g class="gc-edge-label" data-id="${esc(request.id)}">` +
        `<rect class="gc-plate" x="${round(best.box.x)}" y="${round(best.box.y)}" ` +
        `width="${round(best.box.width)}" height="${round(best.box.height)}" rx="3"/>` +
        `<text x="${round(cx)}" y="${round(cy + scene.edgeLabelSize * 0.36)}">${esc(request.text)}</text>` +
        `</g>`,
    );
  }
  return { markup: out, boxes: taken };
}
