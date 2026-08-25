import {
  kindOf, longestPath, markBackEdges, parseWith, splitLabel,
  type EdgeTip, type Graph, type GraphCluster, type GraphEdge, type GraphNode,
  type NodeRow, type NodeShape,
} from './graph.ts';

/**
 * State, class and ER diagrams, on the drawn pipeline.
 *
 * Mermaid 11 routes these three through one internal layout format: every one of
 * their databases answers `getData()` with `{ nodes, edges }` carrying ids,
 * labels, shapes, members and end markers. That is very nearly this codebase's
 * own `Graph`, so all three are a single adapter rather than three renderers —
 * and once converted they get the same layout, drawing and motion as a
 * flowchart, for free.
 *
 * What each type actually contributes on top of a flowchart:
 *   state  — start and end markers, composite states as clusters
 *   class  — compartmented boxes, and relationship ends that carry the meaning
 *   er     — attribute tables, and crow's-foot cardinality at both ends
 */

/** The three types this adapter covers. */
export type UnifiedType = 'state' | 'class' | 'er';

interface RawNode {
  id: string;
  label?: string;
  shape?: string;
  isGroup?: boolean;
  parentId?: string;
  cssClasses?: string;
  /** Class diagrams: attributes and operations, already visibility-prefixed. */
  members?: { text?: string; id?: string }[];
  methods?: { text?: string; id?: string }[];
  annotations?: string[];
  /** ER diagrams: one row per column. */
  attributes?: { type?: string; name?: string; keys?: string[]; comment?: string }[];
}

interface RawEdge {
  id: string;
  start: string;
  end: string;
  label?: string;
  arrowTypeStart?: string;
  arrowTypeEnd?: string;
  pattern?: string;
  startLabelRight?: string;
  endLabelLeft?: string;
}

/** Mermaid's shape names across the three types, mapped onto what we draw. */
const SHAPES: Record<string, NodeShape> = {
  stateStart: 'dot',
  stateEnd: 'ring',
  classBox: 'panel',
  erBox: 'panel',
  choice: 'diamond',
  forkJoin: 'bar',
  note: 'note',
  rect: 'round',
  roundedRect: 'round',
  squareRect: 'rect',
  divider: 'bar',
};

/**
 * Mermaid's end-marker names, mapped onto the tips we draw.
 *
 * The class names read oddly because they describe the *relationship*, not the
 * mark: `extension` is the hollow inheritance triangle, `dependency` is a plain
 * open arrow. The ER names are the crow's-foot vocabulary directly.
 */
const TIPS: Record<string, EdgeTip> = {
  none: 'none',
  arrow_barb: 'arrow',
  arrow_point: 'arrow',
  arrow_open: 'none',
  arrow_cross: 'arrow',
  extension: 'triangle',
  composition: 'diamond-filled',
  aggregation: 'diamond',
  dependency: 'open',
  lollipop: 'zero-one',
  only_one: 'only-one',
  zero_or_one: 'zero-one',
  one_or_more: 'one',
  zero_or_more: 'zero-many',
  many: 'many',
};

/** Mermaid escapes the visibility sigils it would otherwise treat as markup. */
const unescape = (text: string): string =>
  String(text ?? '').replace(/\\([+\-#~*$])/g, '$1').trim();

/**
 * Blank the labels mermaid invents for the state machine's own endpoints.
 *
 * `[*]` becomes a node called `root_start`; drawing that name inside the dot
 * would be reporting an implementation detail as content.
 */
const isPseudo = (id: string): boolean => /^(?:root_)?(?:start|end)$/.test(id) || /_(?:start|end)$/.test(id);

function classRows(node: RawNode): NodeRow[][] {
  const groups: NodeRow[][] = [];
  const annotations = (node.annotations ?? []).filter(Boolean);
  if (annotations.length) groups.push(annotations.map((a) => ({ text: `«${a}»`, strong: true })));
  const members = (node.members ?? []).map((m) => ({ text: unescape(m.text ?? m.id ?? '') })).filter((r) => r.text);
  if (members.length) groups.push(members);
  const methods = (node.methods ?? []).map((m) => ({ text: unescape(m.text ?? m.id ?? '') })).filter((r) => r.text);
  if (methods.length) groups.push(methods);
  return groups;
}

function erRows(node: RawNode): NodeRow[][] {
  const rows = (node.attributes ?? [])
    .map((a) => {
      const keys = (a.keys ?? []).filter(Boolean).join(',');
      // Type then name is the order the source declares them in, and the order a
      // reader of a schema expects.
      const body = [a.type, a.name].filter(Boolean).join(' ');
      return { text: keys ? `${body}  ${keys.toUpperCase()}` : body };
    })
    .filter((r) => r.text);
  return rows.length ? [rows] : [];
}

export async function toUnifiedGraph(source: string, type: UnifiedType): Promise<Graph> {
  const db = await parseWith(source);
  if (typeof db.getData !== 'function') {
    throw new Error(`This ${type} diagram exposes no layout data.`);
  }
  const data = db.getData() as { nodes: RawNode[]; edges: RawEdge[] };
  const raw = data.nodes ?? [];

  // A composite state arrives as a node flagged `isGroup` whose members name it
  // as their parent — the same relationship a flowchart expresses as a subgraph.
  const groups = raw.filter((n) => n.isGroup);
  const groupIds = new Set(groups.map((n) => n.id));

  const nodes: GraphNode[] = raw
    .filter((n) => !n.isGroup)
    .map((n) => {
      const shape = SHAPES[String(n.shape ?? 'rect')] ?? 'round';
      const classes = String(n.cssClasses ?? '').split(/\s+/).filter(Boolean);
      const rows = type === 'class' ? classRows(n) : type === 'er' ? erRows(n) : [];
      // A state description arrives as one string; a name and a caption
      // (Lyzr's two-tier box, DESIGN 3.2) split from it the same way a
      // flowchart node's `<br/>` label does.
      const { title, caption } = isPseudo(n.id)
        ? { title: '', caption: undefined as string | undefined }
        : splitLabel(String(n.label ?? n.id));
      return {
        id: n.id,
        title,
        ...(caption ? { caption } : {}),
        shape,
        kind: kindOf(shape, classes),
        classes,
        ...(rows.length ? { rows } : {}),
      };
    });

  const known = new Set(nodes.map((n) => n.id));

  const edges: GraphEdge[] = (data.edges ?? [])
    .filter((e) => known.has(e.start) && known.has(e.end))
    .map((e, i) => ({
      id: String(e.id ?? `edge-${i}`),
      from: e.start,
      to: e.end,
      ...(e.label ? { label: String(e.label) } : {}),
      stroke: e.pattern === 'dotted' || e.pattern === 'dashed' ? ('dotted' as const) : ('normal' as const),
      tipStart: TIPS[String(e.arrowTypeStart ?? 'none')] ?? 'none',
      tipEnd: TIPS[String(e.arrowTypeEnd ?? 'arrow_barb')] ?? 'arrow',
      ...(e.startLabelRight ? { labelStart: String(e.startLabelRight) } : {}),
      ...(e.endLabelLeft ? { labelEnd: String(e.endLabelLeft) } : {}),
    }));

  const clusters: GraphCluster[] = groups.map((g) => ({
    id: g.id,
    title: String(g.label ?? g.id),
    nodes: raw.filter((n) => n.parentId === g.id && !groupIds.has(n.id)).map((n) => n.id),
  }));

  // ER schemas are read across, the way a table diagram is drawn on a whiteboard;
  // state machines and class hierarchies read down.
  //
  // The database is no help in deciding whether the author asked: `getDirection`
  // answers with the config default whether or not a `direction` line exists, so
  // reading it would make every ER diagram top-to-bottom. The source is the only
  // place the author's intent actually appears.
  const asked = /(?:^|\n)\s*direction\s+(TB|TD|BT|LR|RL)\b/i.exec(source)?.[1]?.toUpperCase();
  const declared = asked ?? (type === 'er' ? 'LR' : 'TB');
  const direction = (declared === 'TD' ? 'TB' : declared) as Graph['direction'];

  const primaryPath = longestPath(nodes, edges);
  markBackEdges(nodes, edges);

  return { direction, nodes, edges, clusters: clusters.filter((c) => c.nodes.length), primaryPath };
}
