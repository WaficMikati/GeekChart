import type { Analysis, Element } from './types.ts';

/**
 * Turn a rendered mermaid SVG into a list of animatable parts.
 *
 * The rule that keeps this from breaking: we never look at the user's diagram,
 * only at the SVG mermaid produced. Known class names are tried first, and if a
 * diagram type we have never seen turns up, the generic pass still finds its
 * shapes and strokes. Ordering comes from where things ended up on screen, so
 * it works without understanding the graph at all.
 */

/** Class names mermaid uses, per family. Extras are harmless — misses are not. */
const NODE_SELECTORS = [
  'g.node:not(.cluster)',
  'g.stateGroup',
  'g.classGroup',
  'g.entityBox',
  'g.node-item',
  'g.actor-man',
  'rect.actor',
  'text.actor',
  'g.mindmap-node',
  'g.task',
  'g.commit',
  'g.pieCircle',
  'g.section',
  'g.timeline-node',
  'g.block',
].join(',');

const EDGE_SELECTORS = [
  'g.edgePaths path',
  'path.flowchart-link',
  'g.edgePath path.path',
  'path.transition',
  'path.relation',
  'path.er.relationshipLine',
  'path.messageLine0',
  'path.messageLine1',
  'line.messageLine0',
  'line.messageLine1',
  'path.mindmap-edge',
  'path.edge',
  'g.edges path',
].join(',');

const LABEL_SELECTORS = [
  'g.edgeLabels .edgeLabel',
  'g.edgeLabel',
  'text.messageText',
  'g.note',
  'g.noteText',
  'text.loopText',
].join(',');

const CLUSTER_SELECTORS = ['g.cluster', 'g.nodes > g.cluster', 'rect.rect'].join(',');

type Direction = Analysis['direction'];

/** Mermaid stamps the family on the root svg; fall back to sniffing classes. */
export function diagramType(svg: SVGSVGElement): string {
  const role = svg.getAttribute('aria-roledescription');
  if (role) return role;
  for (const cls of Array.from(svg.classList)) {
    if (cls !== 'gc-chart') return cls;
  }
  return 'unknown';
}

/** Layout direction, read from the source because the SVG does not record it. */
export function directionOf(source: string, diagram: string): Direction {
  if (/mindmap|pie|radar|journey/i.test(diagram)) return 'radial';
  const m = /^\s*(?:flowchart|graph|block-beta)\s+(TB|TD|BT|LR|RL)\b/im.exec(source);
  if (m) return (m[1] === 'TD' ? 'TB' : m[1]) as Direction;
  const dirDirective = /"?direction"?\s*:\s*"?(TB|TD|BT|LR|RL)/i.exec(source);
  if (dirDirective) {
    const d = dirDirective[1]!.toUpperCase();
    return (d === 'TD' ? 'TB' : d) as Direction;
  }
  return 'TB';
}

interface Placed {
  el: SVGElement;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

function place(el: SVGElement, origin: DOMRect): Placed | null {
  const r = el.getBoundingClientRect();
  // Zero-area elements are markers, defs leftovers or hidden helpers.
  if (r.width < 0.5 && r.height < 0.5) return null;
  return {
    el,
    cx: r.left + r.width / 2 - origin.left,
    cy: r.top + r.height / 2 - origin.top,
    w: r.width,
    h: r.height,
  };
}

function query(root: SVGSVGElement, selectors: string): SVGElement[] {
  try {
    return Array.from(root.querySelectorAll<SVGElement>(selectors));
  } catch {
    return [];
  }
}

/**
 * Last resort for diagram types whose class names we do not know: anything with
 * a stroke and no fill is an edge, anything else with area is a node.
 */
function genericPass(root: SVGSVGElement): { nodes: SVGElement[]; edges: SVGElement[] } {
  const nodes: SVGElement[] = [];
  const edges: SVGElement[] = [];
  const shapes = Array.from(
    root.querySelectorAll<SVGElement>('path, rect, circle, ellipse, polygon, polyline, line, text'),
  );
  for (const el of shapes) {
    if (el.closest('defs, marker, .gc-ignore')) continue;
    const style = getComputedStyle(el);
    const filled = style.fill !== 'none' && style.fill !== 'rgba(0, 0, 0, 0)';
    const stroked = style.stroke !== 'none' && style.stroke !== 'rgba(0, 0, 0, 0)';
    const linear = el.tagName === 'line' || el.tagName === 'polyline';
    if ((!filled && stroked) || linear) edges.push(el);
    else nodes.push(el);
  }
  return { nodes, edges };
}

/** Path length, or the straight distance for `line` elements. */
function lengthOf(el: SVGElement): number | undefined {
  const geo = el as SVGGeometryElement;
  if (typeof geo.getTotalLength === 'function') {
    try {
      const len = geo.getTotalLength();
      if (Number.isFinite(len) && len > 0) return len;
    } catch {
      /* getTotalLength throws on degenerate paths — treat as unmeasurable */
    }
  }
  const r = el.getBoundingClientRect();
  const diagonal = Math.hypot(r.width, r.height);
  return diagonal > 0 ? diagonal : undefined;
}

/** Endpoint of an edge in the same screen space as the node centres. */
function endpoint(el: SVGElement, at: 'start' | 'end', origin: DOMRect): { x: number; y: number } {
  const geo = el as SVGGeometryElement;
  const ctm = (el as SVGGraphicsElement).getScreenCTM?.();
  if (typeof geo.getPointAtLength === 'function' && ctm) {
    try {
      const len = geo.getTotalLength();
      const p = geo.getPointAtLength(at === 'start' ? 0 : len);
      const abs = new DOMPoint(p.x, p.y).matrixTransform(ctm);
      return { x: abs.x - origin.left, y: abs.y - origin.top };
    } catch {
      /* fall through to the bounding box approximation */
    }
  }
  const r = el.getBoundingClientRect();
  return at === 'start'
    ? { x: r.left - origin.left, y: r.top - origin.top }
    : { x: r.right - origin.left, y: r.bottom - origin.top };
}

/** Primary axis coordinate — the one the diagram flows along. */
function axis(p: { cx: number; cy: number }, dir: Direction, centre: { x: number; y: number }) {
  switch (dir) {
    case 'LR':
      return p.cx;
    case 'RL':
      return -p.cx;
    case 'BT':
      return -p.cy;
    case 'radial':
      return Math.hypot(p.cx - centre.x, p.cy - centre.y);
    default:
      return p.cy;
  }
}

/** Group sorted positions into waves — a gap wider than `tolerance` starts one. */
function bucket(values: number[], tolerance: number): number[] {
  const waves: number[] = [];
  let wave = 0;
  let previous = values[0] ?? 0;
  for (const v of values) {
    if (v - previous > tolerance) wave++;
    waves.push(wave);
    previous = v;
  }
  return waves;
}

export function analyze(svg: SVGSVGElement, source: string): Analysis {
  const diagram = diagramType(svg);
  const direction = directionOf(source, diagram);
  const origin = svg.getBoundingClientRect();
  const centre = { x: origin.width / 2, y: origin.height / 2 };

  const seen = new Set<SVGElement>();
  const take = (selectors: string) =>
    query(svg, selectors).filter((el) => !seen.has(el) && (seen.add(el), true));

  let nodeEls = take(NODE_SELECTORS);
  let edgeEls = take(EDGE_SELECTORS);
  const clusterEls = take(CLUSTER_SELECTORS);
  const labelEls = take(LABEL_SELECTORS);

  if (nodeEls.length === 0 && edgeEls.length === 0) {
    const generic = genericPass(svg);
    nodeEls = generic.nodes;
    edgeEls = generic.edges;
  }

  const nodes = nodeEls.map((el) => place(el, origin)).filter((p): p is Placed => p !== null);
  const clusters = clusterEls.map((el) => place(el, origin)).filter((p): p is Placed => p !== null);

  // Wave assignment for nodes: sort along the flow axis, then split on gaps.
  const sortedNodes = [...nodes].sort(
    (a, b) => axis(a, direction, centre) - axis(b, direction, centre),
  );
  const medianSize =
    sortedNodes.length > 0
      ? ([...sortedNodes]
          .map((n) => (direction === 'LR' || direction === 'RL' ? n.w : n.h))
          .sort((a, b) => a - b)[Math.floor(sortedNodes.length / 2)] ?? 40)
      : 40;
  const tolerance = Math.max(12, medianSize * 0.55);
  const nodeWaves = bucket(
    sortedNodes.map((n) => axis(n, direction, centre)),
    tolerance,
  );
  const waveOf = new Map<SVGElement, number>();
  sortedNodes.forEach((n, i) => waveOf.set(n.el, nodeWaves[i] ?? 0));

  // Sequence diagrams (and anything else that lines its nodes up in a single
  // row) leave every edge nearest to the same wave, so the whole diagram would
  // arrive at once. When the nodes carry no depth information, the edges'
  // own positions do.
  const nodesAreFlat = nodeWaves.every((w) => w === 0) && edgeEls.length >= 3;
  const edgeWaves = new Map<SVGElement, number>();
  if (nodesAreFlat) {
    const placedEdges = edgeEls
      .map((el) => ({ el, placed: place(el, origin) }))
      .filter((e): e is { el: SVGElement; placed: Placed } => e.placed !== null)
      .sort((a, b) => axis(a.placed, direction, centre) - axis(b.placed, direction, centre));
    const buckets = bucket(
      placedEdges.map((e) => axis(e.placed, direction, centre)),
      12,
    );
    placedEdges.forEach((e, i) => edgeWaves.set(e.el, (buckets[i] ?? 0) + 1));
  }

  const elements: Element[] = [];

  // Clusters land before anything they contain.
  for (const c of clusters) {
    elements.push({ el: c.el, kind: 'cluster', cx: c.cx, cy: c.cy, wave: -1 });
  }

  for (const n of sortedNodes) {
    elements.push({
      el: n.el,
      kind: 'node',
      cx: n.cx,
      cy: n.cy,
      wave: waveOf.get(n.el) ?? 0,
    });
  }

  // An edge belongs to the wave of the earlier of the two nodes it touches, so
  // it draws out of a node that has already arrived.
  const nearestWave = (pt: { x: number; y: number }): number => {
    let best = 0;
    let bestDistance = Infinity;
    for (const n of sortedNodes) {
      const d = Math.hypot(n.cx - pt.x, n.cy - pt.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = waveOf.get(n.el) ?? 0;
      }
    }
    return best;
  };

  for (const el of edgeEls) {
    const placed = place(el, origin);
    if (!placed) continue;
    const own = edgeWaves.get(el);
    const wave =
      own ??
      Math.min(
        nearestWave(endpoint(el, 'start', origin)),
        nearestWave(endpoint(el, 'end', origin)),
      );
    elements.push({
      el,
      kind: 'edge',
      cx: placed.cx,
      cy: placed.cy,
      length: lengthOf(el),
      wave,
    });
  }

  for (const el of labelEls) {
    const placed = place(el, origin);
    if (!placed) continue;
    // A label rides with the edge it annotates, so it uses the same rule.
    const nearestEdge = nodesAreFlat
      ? [...edgeWaves.entries()].reduce<{ wave: number; distance: number } | null>(
          (best, [edge, wave]) => {
            const r = edge.getBoundingClientRect();
            const distance = Math.hypot(
              r.left + r.width / 2 - origin.left - placed.cx,
              r.top + r.height / 2 - origin.top - placed.cy,
            );
            return !best || distance < best.distance ? { wave, distance } : best;
          },
          null,
        )
      : null;
    elements.push({
      el,
      kind: 'label',
      cx: placed.cx,
      cy: placed.cy,
      wave: nearestEdge?.wave ?? nearestWave({ x: placed.cx, y: placed.cy }),
    });
  }

  return { diagram, direction, elements };
}
