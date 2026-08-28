import mermaid from 'mermaid';

/**
 * Mermaid as a parser, not a renderer.
 *
 * `getDiagramFromText` hands back the populated database the flowchart parser
 * built, which carries everything the drawing needs: node ids and labels, the
 * shape the author asked for, edge endpoints and their labels, subgraph
 * membership by name, and the declared direction.
 *
 * Reading it here rather than scraping the rendered SVG is what lets the rest of
 * the pipeline draw a diagram instead of restyling one. Membership in particular
 * is exact — previously it was inferred from which box a node's centre fell in.
 */

export type NodeShape =
  | 'rect'
  | 'round'
  | 'stadium'
  | 'diamond'
  | 'circle'
  | 'cylinder'
  | 'hexagon'
  | 'subroutine'
  | 'parallelogram'
  | 'trapezoid'
  | 'doc'
  // State, class and ER contribute their own shapes. They are drawn by the same
  // code as the flowchart shapes, so nothing downstream needs to know which
  // diagram type produced them.
  | 'panel'
  | 'dot'
  | 'ring'
  | 'bar'
  | 'note';

export type EdgeStroke = 'normal' | 'dotted' | 'thick';

/**
 * What a node *is*, separate from the outline it wears.
 *
 * Shape alone runs out fast: a datastore and a terminal are both "not a
 * rectangle" and end up differing only by silhouette, which is nearly invisible
 * at feed size. The kind carries the meaning so the stylesheet can also give it
 * a fill, a weight or a dash — a second channel that survives being small.
 */
export type NodeKind =
  'process' | 'decision' | 'terminal' | 'datastore' | 'external' | 'note' | 'marker';

/**
 * How a line ends.
 *
 * Flowcharts only ever need `arrow`. Class and ER diagrams carry most of their
 * meaning in these: an open triangle is inheritance, a filled diamond is
 * composition, and the crow's feet are cardinality. Drawing them ourselves keeps
 * them on the same footing as the arrowhead — sized from the line's weight and
 * aligned to its true direction.
 */
export type EdgeTip =
  | 'none'
  | 'arrow'
  | 'open'
  | 'cross'
  | 'triangle'
  | 'diamond'
  | 'diamond-filled'
  | 'one'
  | 'many'
  | 'zero-one'
  | 'zero-many'
  | 'only-one';

/** One line inside a compartmented node. */
export interface NodeRow {
  text: string;
  /** Set for a row that is a heading rather than a member. */
  strong?: boolean;
}

export interface GraphNode {
  id: string;
  /** First line of the label. */
  title: string;
  /** Remaining lines, shown smaller and quieter. */
  caption?: string;
  /**
   * `title`, wrapped to two lines in the title's own style rather than
   * given a wider box. Set only for a caption-less node whose title alone
   * would not fit the narrowest box (DESIGN 2.2). Mutually exclusive with
   * `caption`.
   */
  titleLines?: [string, string];
  shape: NodeShape;
  kind: NodeKind;
  classes: string[];
  /**
   * Compartments, for the diagram types whose nodes are tables rather than
   * labels — a class box's attributes and methods, an entity's columns. Each
   * group is drawn as a block, separated from the next by a rule.
   */
  rows?: NodeRow[][];
  /** Position inside a packed group, relative to the panel's content box. */
  gridX?: number;
  gridY?: number;
  /** Set once layout has run. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  stroke: EdgeStroke;
  /** How each end is drawn. Defaults to a plain arrow at the target. */
  tipStart?: EdgeTip;
  tipEnd?: EdgeTip;
  /** Cardinalities, shown next to their own end rather than at the midpoint. */
  labelStart?: string;
  labelEnd?: string;
  /** Measured label width, filled in by layout so drawing need not guess. */
  labelWidth?: number;
  /** True when the edge points backwards against the flow — a loop or retry. */
  backward?: boolean;
  /**
   * True for a parent→leaf edge inside a DESIGN 1.5 leaf stack: drawn as a
   * shared trunk with a short branch into the leaf's left side, rather than
   * routed by `route/plan.ts`. Every edge in one stack shares its start point
   * with every other, which is what DESIGN 6.8's "fan bus from one point"
   * shared-segment exemption is for.
   */
  bus?: boolean;
  /**
   * DESIGN 1.6: overrides the plain bus's `from.x + TRUNK_OFFSET` trunk
   * column, for a parent's edge into a sibling that sibling wrapping pushed
   * onto a later row — the plain formula assumes `from` is the fan's own
   * parent, indented to leave that column clear (DESIGN 1.5); a wrap's
   * `from` can be any shape, so the corridor is computed instead, from
   * whatever the wrapped row actually needs cleared (`layout/wrap.ts`). Set
   * only for a wrap bus, and is read that way by `draw.ts` — a plain leaf
   * bus keeps its own `TRUNK_OFFSET` formula and its own left-side arrival.
   * Stored as an offset from `to.x` (the sibling's own left edge — not its
   * right, which for a node inside a stacked fan is not the same width
   * `layout/wrap.ts` measured the corridor against), not an absolute
   * coordinate — see `wrapSiblings`'s own doc comment for why.
   */
  wrapTrunkX?: number;
}

export interface GraphCluster {
  id: string;
  title: string;
  /** A quieter second line under the title. */
  kicker?: string;
  nodes: string[];
  /**
   * Measured width of the panel's own title/kicker text, at their drawn
   * size and font. The panel's own header counts as content it must hug
   * (DESIGN 2.6) same as its children.
   */
  headerWidth?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface Graph {
  direction: 'TB' | 'BT' | 'LR' | 'RL';
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
  /** Ids along the longest route through the graph — what emphasis follows. */
  primaryPath: string[];
}

/** Mermaid's shape vocabulary, mapped onto the shapes we actually draw. */
const SHAPES: Record<string, NodeShape> = {
  square: 'rect',
  rect: 'rect',
  round: 'round',
  stadium: 'stadium',
  diamond: 'diamond',
  circle: 'circle',
  doublecircle: 'circle',
  cylinder: 'cylinder',
  hexagon: 'hexagon',
  subroutine: 'subroutine',
  lean_right: 'parallelogram',
  lean_left: 'parallelogram',
  trapezoid: 'trapezoid',
  inv_trapezoid: 'trapezoid',
  odd: 'doc',
};

/**
 * Infer what a node is from the shape the author chose.
 *
 * Mermaid has no vocabulary for this, so the shape is the only signal — with one
 * escape hatch: an explicit `:::class` wins, which is how an author says
 * "this box is external" without being forced into a silhouette they dislike.
 */
export function kindOf(shape: NodeShape, classes: string[] = []): NodeKind {
  const named = classes.find((c) =>
    ['process', 'decision', 'terminal', 'datastore', 'external', 'note'].includes(c),
  );
  if (named) return named as NodeKind;
  switch (shape) {
    case 'diamond':
      return 'decision';
    case 'stadium':
    case 'circle':
      return 'terminal';
    case 'cylinder':
      return 'datastore';
    case 'subroutine':
    case 'doc':
      return 'external';
    case 'note':
      return 'note';
    case 'dot':
    case 'ring':
    case 'bar':
      return 'marker';
    default:
      return 'process';
  }
}

export function splitLabel(text: string): { title: string; caption?: string } {
  // The state parser hands back either a literal `<br/>` or the HTML-escaped
  // `&lt;br/&gt;` depending on how the source quoted the description, so both
  // forms have to split the same way.
  const lines = String(text ?? '')
    .split(/<br\s*\/?>|&lt;br\s*\/?&gt;|\n/i)
    .map((line) => line.trim())
    .filter(Boolean);
  const title = lines.shift() ?? '';
  return lines.length ? { title, caption: lines.join(' ') } : { title };
}

/**
 * The longest simple route through the graph.
 *
 * Emphasis has to follow *something*, and in a flowchart the spine is almost
 * always the longest path from a node nothing points at to a node that points
 * nowhere. Cycles are ignored rather than followed, so a retry loop cannot make
 * the search run away.
 */
export function longestPath(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const out = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const node of nodes) {
    out.set(node.id, []);
    indegree.set(node.id, 0);
  }
  for (const edge of edges) {
    out.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const memo = new Map<string, string[]>();
  const walk = (id: string, seen: Set<string>): string[] => {
    if (memo.has(id) && seen.size === 0) return memo.get(id)!;
    let best: string[] = [];
    for (const next of out.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      const tail = walk(next, seen);
      seen.delete(next);
      if (tail.length > best.length) best = tail;
    }
    const path = [id, ...best];
    if (seen.size === 0) memo.set(id, path);
    return path;
  };

  const roots = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0);
  const starts = roots.length ? roots : nodes.slice(0, 1);
  let best: string[] = [];
  for (const start of starts) {
    const path = walk(start.id, new Set([start.id]));
    if (path.length > best.length) best = path;
  }
  return best;
}

let initialised = false;

/**
 * Flag the edges that close a cycle.
 *
 * Depth-first from the roots: an edge pointing at a node still on the stack is a
 * back edge — a retry, a loop, a returning path. Comparing positions along the
 * primary path is not enough, because either end of a retry is commonly off that
 * path entirely, which is how `Prep course` back to the decision went unnoticed.
 */
export function markBackEdges(nodes: GraphNode[], edges: GraphEdge[]): void {
  const out = new Map<string, GraphEdge[]>();
  const indegree = new Map<string, number>();
  for (const node of nodes) {
    out.set(node.id, []);
    indegree.set(node.id, 0);
  }
  for (const edge of edges) {
    out.get(edge.from)?.push(edge);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string): void => {
    state.set(id, 'open');
    for (const edge of out.get(id) ?? []) {
      const seen = state.get(edge.to);
      if (seen === 'open') edge.backward = true;
      else if (seen === undefined) visit(edge.to);
    }
    state.set(id, 'done');
  };

  const roots = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  for (const id of roots.length ? roots : nodes.map((n) => n.id)) {
    if (!state.has(id)) visit(id);
  }
  // Anything unreachable from a root still needs visiting.
  for (const node of nodes) if (!state.has(node.id)) visit(node.id);
}

export type MermaidDb = Record<string, (...args: unknown[]) => unknown>;

/**
 * Hand back the database mermaid's parser filled in.
 *
 * Every drawn diagram type starts here. Mermaid populates its parser registry on
 * initialize; without it even a valid flowchart comes back as "no diagram type
 * detected".
 */
export async function parseWith(source: string): Promise<MermaidDb> {
  if (!initialised) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    initialised = true;
  }

  const api = (
    mermaid as unknown as { mermaidAPI: { getDiagramFromText(t: string): Promise<unknown> } }
  ).mermaidAPI;
  const diagram = (await api.getDiagramFromText(source)) as {
    db?: MermaidDb;
    getDB?: () => MermaidDb;
  };
  const db = diagram.db ?? diagram.getDB?.();
  if (!db) throw new Error('Mermaid parsed the text but produced no data.');
  return db;
}

/** Parse mermaid source into a graph. Throws if the text is not a flowchart. */
export async function toGraph(source: string): Promise<Graph> {
  const db = await parseWith(source);
  if (typeof db.getVertices !== 'function') {
    throw new Error('This diagram type is not a flowchart.');
  }

  const rawVertices = db.getVertices() as
    Map<string, Record<string, unknown>> | Record<string, unknown>;
  const vertexList =
    rawVertices instanceof Map ? [...rawVertices.values()] : Object.values(rawVertices);

  const nodes: GraphNode[] = (vertexList as Record<string, unknown>[]).map((v) => {
    const shape = SHAPES[String(v.type ?? 'square')] ?? 'rect';
    const classes = ((v.classes as string[]) ?? []).map(String);
    return {
      id: String(v.id),
      ...splitLabel(String(v.text ?? v.id)),
      shape,
      kind: kindOf(shape, classes),
      classes,
    };
  });

  const rawEdges = (db.getEdges?.() as Record<string, unknown>[]) ?? [];
  const edges: GraphEdge[] = rawEdges.map((e, i) => ({
    id: String(e.id ?? `edge-${i}`),
    from: String(e.start),
    to: String(e.end),
    ...(e.text ? { label: String(e.text) } : {}),
    stroke: (String(e.stroke ?? 'normal') as EdgeStroke) ?? 'normal',
    // `arrow_open` is mermaid's line with no head at all (`---`).
    tipEnd: String(e.type ?? '').includes('open') ? 'none' : 'arrow',
  }));

  const rawClusters = (db.getSubGraphs?.() as Record<string, unknown>[]) ?? [];
  const clusters: GraphCluster[] = rawClusters.map((c) => {
    // `subgraph OS["Title | kicker"]` — the part after the bar is a second,
    // quieter line, the same way a node's caption is. Mermaid has no syntax for
    // it, and a group that can only carry a name cannot be the centrepiece of a
    // diagram the way a labelled panel can.
    const raw = String(c.title ?? c.id);
    const [title, kicker] = raw.split('|').map((t) => t.trim());
    return {
      id: String(c.id),
      title: title || String(c.id),
      ...(kicker ? { kicker } : {}),
      nodes: ((c.nodes as string[]) ?? []).map(String),
    };
  });

  // A subgraph that an edge points at is also reported as a vertex. Left in, it
  // is drawn as a small box beside the group it is supposed to *be* — the panel
  // ends up floating unconnected while a phantom takes its edges.
  const clusterIds = new Set(clusters.map((c) => c.id));
  const drawn = nodes.filter((n) => !clusterIds.has(n.id));

  // Mermaid reports TD, which is the same thing as TB.
  const declared = String(db.getDirection?.() ?? 'TB').toUpperCase();
  const direction = (declared === 'TD' ? 'TB' : declared) as Graph['direction'];
  const primaryPath = longestPath(drawn, edges);

  markBackEdges(drawn, edges);

  return { direction, nodes: drawn, edges, clusters, primaryPath };
}
