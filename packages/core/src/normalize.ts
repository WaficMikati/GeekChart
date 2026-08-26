import type { Analysis } from './types.ts';
import {
  centreOf,
  ellipseShape,
  overlaps,
  parsePolyline,
  quantise,
  rectShape,
  rhombusShape,
  type Box,
  type Point,
  type Shape,
} from './geometry.ts';
import { routeEdges, type EdgeEnds } from './route.ts';

const SVG = 'http://www.w3.org/2000/svg';

/**
 * Reshape mermaid's output before it is styled.
 *
 * Mermaid decides where things go, which it does well. It also decides how big
 * they are, and that is where a generated diagram gives itself away: every box
 * is sized to its own text, so six boxes have six widths and nothing lines up.
 * No amount of colour fixes that.
 *
 * This pass keeps mermaid's routing and rewrites its dimensions — one box size
 * per rank, flatter decision diamonds, one arrowhead, one corner radius — then
 * re-attaches every edge to the shapes it has just resized.
 */
export interface NormalizeSpec {
  uniformNodes: boolean;
  /** Box sizes are rounded up to a multiple of this. */
  grid: number;
  /** Ceiling on a box, so one long label cannot inflate the whole diagram. */
  maxNodeWidth: number;
  /** Clear space kept between two boxes when widening them. */
  gutter: number;
  /**
   * `ports` throws the engine's route away and draws one curve between two node
   * faces. `preserve` keeps the engine's polyline, which is only worth it when a
   * diagram's routing carries meaning the ports cannot express.
   */
  edgeRouting: 'ports' | 'preserve';
  /** Space between a box's edge and the arrowhead that points at it. */
  edgeGap: number;
  arrowLength: number;
  arrowWidth: number;
}

const RESIZABLE = 'rect.basic.label-container, rect.label-container';

interface Local {
  /** Node origin in root user space. */
  originX: number;
  originY: number;
  /** Root units per local unit. */
  scale: number;
}

function localFrame(node: SVGElement): Local | null {
  const ctm = (node as SVGGraphicsElement).getCTM();
  if (!ctm) return null;
  return { originX: ctm.e, originY: ctm.f, scale: ctm.a || 1 };
}

/** The label's size and offset from the node origin, in the node's own units. */
function labelMetrics(node: SVGElement, frame: Local) {
  const label = node.querySelector<SVGGElement>('g.label') ?? node;
  const screen = (node as SVGGraphicsElement).getScreenCTM();
  const rect = label.getBoundingClientRect();
  if (!screen || !rect.width) return null;
  const pixels = screen.a || 1;
  return {
    cx: (rect.left + rect.width / 2 - screen.e) / pixels,
    cy: (rect.top + rect.height / 2 - screen.f) / pixels,
    width: rect.width / pixels,
    height: rect.height / pixels,
    frame,
  };
}

interface NodeEntry {
  group: SVGElement;
  shape: SVGRectElement;
  box: Box;
  wave: number;
}

function rectBoxInRoot(shape: SVGRectElement): Box | null {
  const ctm = shape.getCTM();
  if (!ctm) return null;
  const x = Number(shape.getAttribute('x') ?? 0);
  const y = Number(shape.getAttribute('y') ?? 0);
  const width = Number(shape.getAttribute('width') ?? 0);
  const height = Number(shape.getAttribute('height') ?? 0);
  if (!width || !height) return null;
  return {
    x: ctm.e + x * ctm.a,
    y: ctm.f + y * ctm.d,
    width: width * ctm.a,
    height: height * ctm.d,
  };
}

/**
 * How far a box may grow before it crowds a neighbour. Both boxes in a pair grow
 * toward each other, so each may claim half of the gap between them.
 */
function growthLimits(entries: NodeEntry[], gutter: number) {
  return entries.map((entry, i) => {
    let width = Infinity;
    let height = Infinity;
    const a = entry.box;
    entries.forEach((other, j) => {
      if (i === j) return;
      const b = other.box;
      if (overlaps(a.y, a.y + a.height, b.y, b.y + b.height)) {
        const gap = b.x > a.x ? b.x - (a.x + a.width) : a.x - (b.x + b.width);
        if (gap >= 0) width = Math.min(width, a.width + (gap - gutter));
      }
      if (overlaps(a.x, a.x + a.width, b.x, b.x + b.width)) {
        const gap = b.y > a.y ? b.y - (a.y + a.height) : a.y - (b.y + b.height);
        if (gap >= 0) height = Math.min(height, a.height + (gap - gutter));
      }
    });
    return { width, height };
  });
}

/** Give every node in a rank the same box, as large as that rank can carry. */
function unifyRectNodes(analysis: Analysis, spec: NormalizeSpec): number | null {
  if (!spec.uniformNodes) return null;

  const entries: NodeEntry[] = [];
  for (const element of analysis.elements) {
    if (element.kind !== 'node') continue;
    const shape = element.el.querySelector<SVGRectElement>(RESIZABLE);
    if (!shape) continue;
    const box = rectBoxInRoot(shape);
    if (box) entries.push({ group: element.el, shape, box, wave: Math.max(0, element.wave) });
  }
  if (entries.length === 0) return null;

  const limits = growthLimits(entries, spec.gutter);

  // One height across the whole diagram: rows of differing heights give the game
  // away as plainly as columns of differing widths.
  const naturalHeight = Math.max(...entries.map((e) => e.box.height));
  const height = Math.max(
    naturalHeight,
    Math.min(quantise(naturalHeight, spec.grid), Math.min(...limits.map((l) => l.height))),
  );

  const byWave = new Map<number, number[]>();
  entries.forEach((entry, i) => byWave.set(entry.wave, [...(byWave.get(entry.wave) ?? []), i]));

  // One width for the whole diagram, not one per rank. Ranks holding a single
  // node are common, and per-rank widths leave those diagrams as ragged as
  // doing nothing at all. A rank that cannot carry the global width falls back
  // to the widest it can fit, which is still uniform within itself.
  const globalTarget = Math.min(
    quantise(Math.max(...entries.map((e) => e.box.width)), spec.grid),
    spec.maxNodeWidth,
  );

  for (const indices of byWave.values()) {
    const natural = Math.max(...indices.map((i) => entries[i]!.box.width));
    const limit = Math.min(...indices.map((i) => limits[i]!.width));
    const width = Math.max(natural, Math.min(globalTarget, limit));

    for (const i of indices) {
      const entry = entries[i]!;
      const scale = entry.shape.getCTM()?.a || 1;
      const w = width / scale;
      const h = height / scale;
      entry.shape.setAttribute('x', (-w / 2).toFixed(2));
      entry.shape.setAttribute('width', w.toFixed(2));
      entry.shape.setAttribute('y', (-h / 2).toFixed(2));
      entry.shape.setAttribute('height', h.toFixed(2));
    }
  }

  return height;
}

/**
 * Bring path-drawn shapes to the common node height.
 *
 * Mermaid draws stadiums, cylinders and the newer shapes as paths, which cannot
 * be resized by attribute the way a rect can. Scaling one vertically about its
 * own centre keeps it recognisably the shape the author asked for while letting
 * it sit on the same baseline as everything else — a terminal that is half the
 * height of the boxes beside it reads as a mistake, not as a distinction.
 */
function matchPathHeights(analysis: Analysis, height: number): void {
  for (const element of analysis.elements) {
    if (element.kind !== 'node') continue;
    if (element.el.querySelector(RESIZABLE) || element.el.querySelector('polygon.label-container'))
      continue;
    // Scale the whole shape container, not the first path inside it. Mermaid's
    // newer shapes are drawn with several stacked paths, and moving only one of
    // them leaves the others behind as a ghost outline.
    const container =
      element.el.querySelector<SVGGraphicsElement>('g.label-container, g.outer-path') ??
      element.el.querySelector<SVGPathElement>('path');
    if (!container || container.closest('g.label')) continue;

    const frame = localFrame(element.el);
    const bbox = container.getBBox?.();
    if (!frame || !bbox || bbox.height < 1) continue;

    // Only shapes whose label sits at their centre. A cylinder carries its text
    // below the top ellipse, so stretching the body slides the shape out from
    // under the words.
    const label = labelMetrics(element.el, frame);
    const shapeCentreY = bbox.y + bbox.height / 2;
    if (!label || Math.abs(label.cy - shapeCentreY) > bbox.height * 0.15) continue;

    const current = bbox.height * frame.scale;
    const factor = height / current;
    // Leave anything already close alone; scaling by a hair is only distortion.
    if (!Number.isFinite(factor) || Math.abs(factor - 1) < 0.12 || factor > 3 || factor < 0.4)
      continue;

    const cy = bbox.y + bbox.height / 2;
    const existing = container.getAttribute('transform') ?? '';
    container.setAttribute(
      'transform',
      `${existing} translate(0 ${cy.toFixed(2)}) scale(1 ${factor.toFixed(4)}) translate(0 ${(-cy).toFixed(2)})`.trim(),
    );
    // A scale of (1, k) thickens horizontal runs of the outline by k and leaves
    // vertical ones alone. Pre-dividing by the geometric mean splits the error
    // between them, which reads as even where a raw scale reads as a bug.
    container.setAttribute('data-gc-stroke-scale', Math.sqrt(factor).toFixed(3));
    for (const stroked of container.querySelectorAll<SVGElement>(
      'path, rect, ellipse, circle, polygon',
    )) {
      stroked.style.strokeWidth = `calc(var(--gc-node-stroke, 1px) / ${Math.sqrt(factor).toFixed(3)})`;
    }
  }
}

/**
 * Flatten decision diamonds onto their labels.
 *
 * Mermaid sizes a diamond as a rotated square big enough to hold the text, which
 * for a short wide label like "Fits the cohort?" is enormous and drags the rest
 * of the layout apart. The smallest rhombus containing a w by h label satisfies
 * `(w/2)/a + (h/2)/b = 1`, so fixing a sensible height and solving for the width
 * gives a diamond that fits the words rather than a square that contains them.
 */
function flattenDiamonds(analysis: Analysis, maxAspect = 2.8): void {
  for (const element of analysis.elements) {
    if (element.kind !== 'node') continue;
    const polygon = element.el.querySelector<SVGPolygonElement>('polygon.label-container');
    if (!polygon) continue;
    const frame = localFrame(element.el);
    if (!frame) continue;
    const label = labelMetrics(element.el, frame);
    if (!label) continue;

    const halfWidth = label.width / 2 + 10;
    const halfHeight = label.height / 2;
    let b = halfHeight + 18;
    let a = halfWidth / (1 - halfHeight / b);
    // Very wide labels would produce a splinter; trade height for width instead.
    for (let i = 0; i < 40 && a > b * maxAspect; i++) {
      b += 4;
      a = halfWidth / (1 - halfHeight / b);
    }

    const cx = label.cx;
    const cy = label.cy;
    polygon.setAttribute(
      'points',
      `${cx.toFixed(2)},${(cy - b).toFixed(2)} ${(cx + a).toFixed(2)},${cy.toFixed(2)} ` +
        `${cx.toFixed(2)},${(cy + b).toFixed(2)} ${(cx - a).toFixed(2)},${cy.toFixed(2)}`,
    );
    polygon.removeAttribute('transform');
  }
}

/**
 * Re-fit subgraph boxes around the nodes they now contain.
 *
 * Mermaid sized these to the original node widths, so widening a node leaves it
 * hanging out of its own group — the most obviously broken thing a diagram can
 * do. Membership is worked out geometrically because mermaid keeps clusters and
 * nodes as siblings rather than nesting them, and the innermost cluster is
 * fitted first so an outer one can grow around the result.
 */
function refitClusters(svg: SVGSVGElement, analysis: Analysis, padding: number): void {
  interface Cluster {
    group: SVGElement;
    rect: SVGRectElement;
    box: Box;
    label: SVGGraphicsElement | null;
  }

  const clusters: Cluster[] = [];
  for (const group of svg.querySelectorAll<SVGGElement>('g.cluster')) {
    const rect = group.querySelector<SVGRectElement>('rect');
    if (!rect) continue;
    const box =
      rectBoxInRoot(rect) ??
      (() => {
        const ctm = rect.getCTM();
        const bbox = rect.getBBox?.();
        if (!ctm || !bbox) return null;
        return {
          x: ctm.e + bbox.x * ctm.a,
          y: ctm.f + bbox.y * ctm.d,
          width: bbox.width * ctm.a,
          height: bbox.height * ctm.d,
        };
      })();
    if (!box) continue;
    clusters.push({
      group,
      rect,
      box,
      label: group.querySelector<SVGGraphicsElement>('g.cluster-label, .cluster-label'),
    });
  }
  if (clusters.length === 0) return;

  const nodeBoxes: Box[] = [];
  for (const element of analysis.elements) {
    if (element.kind !== 'node') continue;
    const rect = element.el.querySelector<SVGRectElement>(RESIZABLE);
    const box = rect ? rectBoxInRoot(rect) : null;
    if (box) nodeBoxes.push(box);
    else {
      const ctm = (element.el as SVGGraphicsElement).getCTM();
      const bbox = (element.el as SVGGraphicsElement).getBBox?.();
      if (ctm && bbox) {
        nodeBoxes.push({
          x: ctm.e + bbox.x * ctm.a,
          y: ctm.f + bbox.y * ctm.d,
          width: bbox.width * ctm.a,
          height: bbox.height * ctm.d,
        });
      }
    }
  }

  const contains = (outer: Box, p: Point) =>
    p.x >= outer.x &&
    p.x <= outer.x + outer.width &&
    p.y >= outer.y &&
    p.y <= outer.y + outer.height;
  const area = (b: Box) => b.width * b.height;

  // Innermost first, so an enclosing cluster grows around already-fitted ones.
  const order = [...clusters].sort((a, b) => area(a.box) - area(b.box));
  const fitted = new Map<SVGElement, Box>();

  for (const cluster of order) {
    const members: Box[] = nodeBoxes.filter((box) => contains(cluster.box, centreOf(box)));
    for (const other of clusters) {
      if (other === cluster) continue;
      const inner = fitted.get(other.group) ?? other.box;
      if (contains(cluster.box, centreOf(inner)) && area(inner) < area(cluster.box))
        members.push(inner);
    }
    if (members.length === 0) continue;

    const left = Math.min(...members.map((b) => b.x)) - padding;
    const right = Math.max(...members.map((b) => b.x + b.width)) + padding;
    const bottom = Math.max(...members.map((b) => b.y + b.height)) + padding;
    // Extra room along the top for the subgraph's title.
    const labelHeight = cluster.label?.getBoundingClientRect().height ?? 0;
    const screenScale = (svg.getScreenCTM()?.a ?? 1) || 1;
    const top = Math.min(...members.map((b) => b.y)) - padding - labelHeight / screenScale - 6;

    const next: Box = { x: left, y: top, width: right - left, height: bottom - top };
    fitted.set(cluster.group, next);

    const ctm = cluster.rect.getCTM();
    if (!ctm) continue;
    const scale = ctm.a || 1;
    cluster.rect.setAttribute('x', ((next.x - ctm.e) / scale).toFixed(2));
    cluster.rect.setAttribute('y', ((next.y - ctm.f) / (ctm.d || 1)).toFixed(2));
    cluster.rect.setAttribute('width', (next.width / scale).toFixed(2));
    cluster.rect.setAttribute('height', (next.height / (ctm.d || 1)).toFixed(2));

    if (cluster.label) {
      // Set the transform outright rather than nudging by a delta: the delta is
      // measured in root space while the transform applies in the parent's, and
      // composing the two sends the title off into the margin.
      const parent = cluster.label.parentNode as SVGGraphicsElement | null;
      const parentCtm = parent?.getCTM?.();
      const own = cluster.label.getBBox?.();
      if (parentCtm && own && own.width) {
        const scaleX = parentCtm.a || 1;
        const scaleY = parentCtm.d || 1;
        const anchorX = own.x + own.width / 2;
        const anchorY = own.y + own.height / 2;
        const targetX = next.x + next.width / 2;
        const targetY = next.y + padding * 0.5 + (own.height * scaleY) / 2;
        cluster.label.setAttribute(
          'transform',
          `translate(${((targetX - parentCtm.e) / scaleX - anchorX).toFixed(2)} ` +
            `${((targetY - parentCtm.f) / scaleY - anchorY).toFixed(2)})`,
        );
      }
    }
  }
}

/** Outline of every node, in root user space, for edges to attach to. */
function collectShapes(analysis: Analysis): Map<SVGElement, Shape> {
  const shapes = new Map<SVGElement, Shape>();

  for (const element of analysis.elements) {
    if (element.kind !== 'node') continue;
    const frame = localFrame(element.el);
    if (!frame) continue;
    const toRoot = (x: number, y: number): Point => ({
      x: frame.originX + x * frame.scale,
      y: frame.originY + y * frame.scale,
    });

    const rect = element.el.querySelector<SVGRectElement>(RESIZABLE);
    if (rect) {
      const box = rectBoxInRoot(rect);
      if (box) {
        shapes.set(element.el, rectShape(box));
        continue;
      }
    }

    const polygon = element.el.querySelector<SVGPolygonElement>('polygon.label-container');
    if (polygon) {
      const numbers =
        (polygon.getAttribute('points') ?? '').match(/[-+]?\d*\.?\d+/g)?.map(Number) ?? [];
      if (numbers.length >= 8) {
        const xs = numbers.filter((_, i) => i % 2 === 0);
        const ys = numbers.filter((_, i) => i % 2 === 1);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const a = ((Math.max(...xs) - Math.min(...xs)) / 2) * frame.scale;
        const b = ((Math.max(...ys) - Math.min(...ys)) / 2) * frame.scale;
        shapes.set(element.el, rhombusShape(toRoot(cx, cy), a, b));
        continue;
      }
    }

    const round = element.el.querySelector<SVGCircleElement | SVGEllipseElement>('circle, ellipse');
    if (round) {
      const cx = Number(round.getAttribute('cx') ?? 0);
      const cy = Number(round.getAttribute('cy') ?? 0);
      const rx = Number(round.getAttribute('rx') ?? round.getAttribute('r') ?? 0);
      const ry = Number(round.getAttribute('ry') ?? round.getAttribute('r') ?? 0);
      if (rx && ry) {
        shapes.set(element.el, ellipseShape(toRoot(cx, cy), rx * frame.scale, ry * frame.scale));
        continue;
      }
    }

    // Anything else falls back to its bounding box, which is plainer than the
    // real outline but never wrong enough to break an edge.
    const bbox = (element.el as SVGGraphicsElement).getBBox?.();
    if (bbox && bbox.width && bbox.height) {
      shapes.set(
        element.el,
        rectShape({
          x: frame.originX + bbox.x * frame.scale,
          y: frame.originY + bbox.y * frame.scale,
          width: bbox.width * frame.scale,
          height: bbox.height * frame.scale,
        }),
      );
    }
  }

  return shapes;
}

/** One arrowhead for the whole diagram, sized in user units. */
function installMarker(svg: SVGSVGElement, id: string, spec: NormalizeSpec): string {
  const markerId = `${id}-arrow`;
  const existing = svg.querySelector(`marker[id="${markerId}"]`);
  if (existing) return markerId;

  const defs =
    svg.querySelector('defs') ??
    svg.insertBefore(document.createElementNS(SVG, 'defs'), svg.firstChild);
  const marker = document.createElementNS(SVG, 'marker');
  marker.setAttribute('id', markerId);
  marker.setAttribute('viewBox', '0 0 10 8');
  marker.setAttribute('refX', '9.4');
  marker.setAttribute('refY', '4');
  marker.setAttribute('markerUnits', 'userSpaceOnUse');
  marker.setAttribute('markerWidth', String(spec.arrowLength));
  marker.setAttribute('markerHeight', String(spec.arrowWidth));
  marker.setAttribute('orient', 'auto');

  const head = document.createElementNS(SVG, 'path');
  // Slimmer than mermaid's equilateral head, with the base notched so the join
  // with the line reads as one mark rather than a blob.
  head.setAttribute('d', 'M0.2 0.3 L9.6 4 L0.2 7.7 L2.3 4 Z');
  head.setAttribute('class', 'gc-arrowhead');
  marker.appendChild(head);
  defs.appendChild(marker);
  return markerId;
}

const EDGE_PATHS = 'g.edgePaths path, path.flowchart-link, g.edgePath path.path';

/** Which node an endpoint belongs to: nearest centre, since the old route ended at the old border. */
function nearestNode(shapes: Map<SVGElement, Shape>, p: Point): SVGElement | null {
  let best: SVGElement | null = null;
  let bestDistance = Infinity;
  for (const [element, shape] of shapes) {
    const d = Math.hypot(shape.centre.x - p.x, shape.centre.y - p.y);
    if (d < bestDistance) {
      bestDistance = d;
      best = element;
    }
  }
  return best;
}

export function normalize(
  svg: SVGSVGElement,
  analysis: Analysis,
  spec: NormalizeSpec,
  id: string,
): void {
  const height = unifyRectNodes(analysis, spec);
  flattenDiamonds(analysis);
  if (height) matchPathHeights(analysis, height);

  refitClusters(svg, analysis, 18);

  const shapes = collectShapes(analysis);
  const markerId = installMarker(svg, id, spec);

  const edges: EdgeEnds[] = [];
  for (const path of svg.querySelectorAll<SVGPathElement>(EDGE_PATHS)) {
    try {
      const d = path.getAttribute('d');
      const ctm = path.getCTM();
      if (!d || !ctm) continue;
      const points = parsePolyline(d).map((p) => ({
        x: ctm.e + p.x * ctm.a,
        y: ctm.f + p.y * ctm.d,
      }));
      if (points.length < 2) continue;

      const from = nearestNode(shapes, points[0]!);
      const to = nearestNode(shapes, points[points.length - 1]!);
      if (!from || !to) continue;

      path.setAttribute('marker-end', `url(#${markerId})`);
      path.removeAttribute('marker-start');
      edges.push({ path, from, to, fromShape: shapes.get(from)!, toShape: shapes.get(to)! });
    } catch {
      // One unreadable edge keeps mermaid's own geometry rather than costing the
      // whole diagram.
    }
  }

  if (spec.edgeRouting === 'ports' && edges.length > 0) {
    const flow =
      analysis.direction === 'LR' || analysis.direction === 'RL' ? 'horizontal' : 'vertical';
    routeEdges(edges, flow, spec.edgeGap, (path, point) => {
      const ctm = path.getCTM();
      if (!ctm) return point;
      return { x: (point.x - ctm.e) / (ctm.a || 1), y: (point.y - ctm.f) / (ctm.d || 1) };
    });
  }
}

export { centreOf };
