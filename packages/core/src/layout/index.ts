import type { Graph, GraphNode } from '../graph.ts';
import { clusterHeadroom, type Scene } from '../scene.ts';
import { tipReach } from '../tips.ts';
import { square } from './align.ts';
import type { ElkNode } from './elk.ts';
import { getElk } from './elk.ts';
import { fold } from './fold.ts';
import { extentOf, fitShape, makeMeasurer, wrapTitle, type Metrics } from './measure.ts';
import { identifySatellites, placeSatellites } from './satellites.ts';

// Re-exported because `makeMeasurer` is a public entry point in its own
// right: every non-ELK chart family (boards, plot, radial, chronicle,
// sequence, commits) imports it directly for text measurement, without ever
// calling `layout()` itself.
export { makeMeasurer };

/**
 * Size the nodes, then let ELK place them.
 *
 * The order matters and is the whole point of owning this step. Sizes are
 * decided *before* layout, so ELK spaces boxes that are already their final
 * dimensions — nothing collides afterwards and nothing needs re-fitting. The
 * previous pipeline sized boxes after the fact and spent most of its complexity
 * repairing the damage.
 *
 * This module is the orchestrator: sizing (`measure.ts`, DESIGN 2.2, 2.6),
 * ELK's own pass (`elk.ts`), folding an overlong run (`fold.ts`, DESIGN 1.2,
 * 1.4), dead-end satellites (`satellites.ts`, DESIGN 1.2, 6.1, 6.4, 6.6), and
 * putting everything on the grid (`align.ts`/`panels.ts`, DESIGN 2.1, 2.3, 2.6,
 * 7.3) each live in their own file; this is what calls them in order.
 */

export interface LayoutResult {
  width: number;
  height: number;
}

/**
 * Give every node its size, then run the layout.
 *
 * One width and one height across the diagram wherever a label allows it —
 * ragged boxes are the single loudest sign that a picture was generated. Shapes
 * that genuinely need more room (a diamond has to hold its label inside a
 * rhombus) get a proportional allowance rather than breaking the rhythm.
 */
export async function layout(
  graph: Graph,
  scene: Scene,
  measureWith?: string,
): Promise<LayoutResult> {
  const measurer = makeMeasurer(measureWith);
  const flow = graph.direction === 'LR' || graph.direction === 'RL' ? 'horizontal' : 'vertical';

  // Shapes that solve their own geometry from the label (a diamond, a note)
  // are never wrapped here — DESIGN 2.2's fixed-box list is about the shared
  // rect/process box, not the shapes that already size themselves to fit.
  const ownShape: string[] = ['diamond', 'circle', 'panel', 'dot', 'ring', 'bar', 'note'];

  const intrinsic: Metrics[] = graph.nodes.map((node) => {
    const title = measurer.measure(node.title, scene.titleFont, scene.titleSize);
    const caption = node.caption
      ? measurer.measure(node.caption, scene.captionFont, scene.captionSize, scene.captionTracking)
      : 0;
    // The caption is a smaller face, not a second title line. Counting it as one
    // made every box half again too tall.
    const text = scene.titleSize * 1.16 + (node.caption ? scene.captionSize * 1.3 + 4 : 0);
    const flat = (node.rows ?? []).flat();
    const rowWidth = flat.length
      ? Math.max(...flat.map((r) => measurer.measure(r.text, scene.rowFont, scene.rowSize)))
      : 0;
    return {
      node,
      label: { width: Math.max(title, caption), height: text },
      rows: { width: rowWidth, count: flat.length, groups: (node.rows ?? []).length },
    };
  });
  // Edge labels are measured here too, because this is the only place with a
  // live measurer. Drawing previously estimated the plate from the character
  // count, which is wrong by enough to clip a label or to overhang its line.
  for (const edge of graph.edges) {
    if (!edge.label) continue;
    edge.labelWidth = measurer.measure(
      scene.edgeLabelUpper ? edge.label.toUpperCase() : edge.label,
      scene.edgeLabelFont,
      scene.edgeLabelSize,
      scene.edgeLabelTracking,
    );
  }
  // A panel's title and kicker are content it has to hug too (DESIGN 2.6) —
  // measured here, alongside everything else, while the measurer is live.
  for (const cluster of graph.clusters) {
    const t = measurer.measure(
      cluster.title,
      scene.titleFont,
      scene.type.title,
      scene.type.titleTracking,
    );
    const k = cluster.kicker
      ? measurer.measure(
          cluster.kicker.toUpperCase(),
          scene.clusterFont,
          scene.type.kicker,
          scene.type.kickerTracking,
        )
      : 0;
    cluster.headerWidth = Math.max(t, k);
  }

  // The common box is sized by the widest ordinary label, so plain nodes share
  // one size. Shapes that need their own geometry are solved separately, and the
  // marks and panels are kept out of the pool entirely — a class box's width
  // would otherwise set the size of every state in the diagram.
  const plain = intrinsic.filter((i) => !ownShape.includes(i.node.shape));
  const pool = plain.length ? plain : intrinsic;
  // 160 is the narrowest box on DESIGN 2.2's list, so it is the floor as well
  // as the common case: a box fitted to a 12-unit name is 90 units wide, and a
  // row of those is the "thin strip on an empty stage" of rule 9.
  // DESIGN 2.2's list, not a fitted width. A box is 120, 160 or 200 and the
  // label lives with it: the smallest that holds the widest plain label wins.
  // Wrapping (below) never feeds back into this — one long caption-less title
  // is not allowed to drag every other node's shared width up with it.
  const wanted = Math.max(...pool.map((i) => i.label.width + scene.padX * 2));
  const baseWidth = [120, 160, 200].find((w) => w >= wanted) ?? 200;

  // DESIGN 2.2: "a label that will not fit is the label's problem, not the
  // box's." Once the chart's shared width is settled, any caption-less title
  // that still would not fit *that* box — the box every one of its siblings
  // already has — is wrapped to a second line, in the title's own style,
  // rather than left to overhang or drag the box wider than the list allows.
  for (const item of pool) {
    const { node } = item;
    if (node.caption || ownShape.includes(node.shape)) continue;
    if (item.label.width + scene.padX * 2 <= baseWidth) continue;
    const wrapped = wrapTitle(
      node.title,
      (s) => measurer.measure(s, scene.titleFont, scene.titleSize),
      baseWidth - scene.padX * 2,
    );
    if (!wrapped) continue;
    node.titleLines = wrapped;
    item.label.width = Math.max(
      ...wrapped.map((l) => measurer.measure(l, scene.titleFont, scene.titleSize)),
    );
  }
  measurer.done();

  const grid = 8;
  const roundUp = (v: number) => Math.ceil(v / grid) * grid;

  // Two box heights only, and which one a chart uses is decided by the chart,
  // not by the node: 56 when anything in it carries a caption, 48 when nothing
  // does. DESIGN 2.2 and 3.2 — a captionless name centred in a 56-high box is
  // the thing 3.2 forbids, and one row of 48s beside a row of 56s breaks 2.3.
  // A wrapped title's second line gets the same 56-high box a caption would.
  const twoTier = graph.nodes.some((n) => Boolean(n.caption) || Boolean(n.titleLines));
  const base = { width: baseWidth, height: twoTier ? 56 : 48 };

  for (const item of intrinsic) {
    const fitted = fitShape(item, base, scene, flow);
    item.node.width = roundUp(fitted.width);
    item.node.height = roundUp(fitted.height);
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const claimed = new Set(graph.clusters.flatMap((c) => c.nodes));
  const clusterIds = new Set(graph.clusters.map((c) => c.id));

  const asElkNode = (node: GraphNode) => ({
    id: node.id,
    width: node.width!,
    height: node.height!,
  });

  // A dead-end branch off the primary path — a single failure state hanging
  // off a happy-path chain, the shape DESIGN 1.2 calls out — is pulled out
  // before layout and pinned under its parent afterward instead, so ELK's own
  // layer assignment never reads it as sitting *in* the chain. See
  // `identifySatellites` for the exact rule.
  const { satelliteIds, soleParent } = identifySatellites(graph, flow, claimed);

  // clusterHeadroom is where the *rule* sits (shared with draw.ts, which
  // places it half a clusterPad above this) — but the rule sits mid-way
  // through that trailing pad, so content starting right at the rule's own
  // headroom value only gets half the gap below the rule that the bottom of
  // the panel gets above the last row. The extra half-pad here is what makes
  // the two match (DESIGN 2.6: padding on *all* sides).
  const headroom = clusterHeadroom(scene) + scene.clusterPad * 0.5;

  /**
   * Members of a group that are not connected to each other are *packed*, not
   * routed.
   *
   * A layered graph engine given six unconnected nodes has nothing to layer by,
   * so it strings them out in a single row the width of the page. But being in a
   * group with no edges between them is itself the statement — these things
   * belong together and no order is implied — and a grid says that where a row
   * does not. The grid is computed here rather than delegated, so the columns
   * are even and the result is the same every run.
   */
  const packed = new Map<string, { width: number; height: number }>();
  for (const cluster of graph.clusters) {
    const members = cluster.nodes.map((id) => byId.get(id)).filter(Boolean) as GraphNode[];
    const inner = graph.edges.filter(
      (e) => cluster.nodes.includes(e.from) && cluster.nodes.includes(e.to),
    );
    if (members.length < 3 || inner.length > 0) continue;

    // Choose the column count that leaves the fewest empty cells, and among
    // those the widest. A ragged last row is the thing that makes a packed group
    // look accidental — three cards in a 2×2 grid leaves an obvious hole where
    // three across leaves none. Capped at four, past which the cards get narrow
    // and the panel outgrows whatever it sits beside.
    // Score = empty cells + rows. Minimising empties alone is a trap: with five
    // members the only arrangement with no hole is a single column, and a
    // five-high stack is far worse than three across with one gap. Counting rows
    // too keeps the block compact, and the two together land on the arrangement
    // a person would have chosen.
    const columns = [1, 2, 3, 4]
      .filter((c) => c <= members.length)
      .map((c) => {
        const rows = Math.ceil(members.length / c);
        return { c, score: c * rows - members.length + rows };
      })
      .sort((a, b) => a.score - b.score || b.c - a.c)[0]!.c;
    const cellW = Math.max(...members.map((m) => m.width!));
    const cellH = Math.max(...members.map((m) => m.height!));
    const gap = scene.gapNode * 0.42;
    members.forEach((node, i) => {
      node.width = cellW;
      node.height = cellH;
      node.gridX = (i % columns) * (cellW + gap);
      node.gridY = Math.floor(i / columns) * (cellH + gap);
    });
    const rows = Math.ceil(members.length / columns);
    // DESIGN 2.6: the panel's own title/kicker count as content too, so a
    // packed grid narrower than its header still hugs the header, not just
    // the cards.
    const gridWidth = columns * cellW + (columns - 1) * gap;
    packed.set(cluster.id, {
      width: Math.max(gridWidth, cluster.headerWidth ?? 0) + scene.clusterPad * 2,
      height: rows * cellH + (rows - 1) * gap + headroom + scene.clusterPad,
    });
  }

  const children = [
    ...graph.clusters.map((cluster) => {
      const grid = packed.get(cluster.id);
      // A packed group is handed to ELK as a plain box of the size we worked
      // out; its children are placed by us afterwards.
      if (grid) return { id: `cluster:${cluster.id}`, width: grid.width, height: grid.height };
      return {
        id: `cluster:${cluster.id}`,
        layoutOptions: {
          'elk.padding': `[top=${headroom},left=${scene.clusterPad},bottom=${scene.clusterPad},right=${scene.clusterPad}]`,
          // The root's node spacing does not cascade to a nested graph, so a
          // panel with an edge inside it (DESIGN 2.6's "children obey 2.3")
          // falls back to ELK's own default — under the 16-unit floor once an
          // arrowhead's reach is subtracted from it. Set explicitly, on the
          // 24/32 gutter DESIGN 2.3 allows.
          'elk.spacing.nodeNode': '32',
          'elk.layered.spacing.nodeNodeBetweenLayers': '32',
        },
        children: cluster.nodes
          .map((id) => byId.get(id))
          .filter(Boolean)
          .map((n) => asElkNode(n!)),
      };
    }),
    ...graph.nodes.filter((n) => !claimed.has(n.id) && !satelliteIds.has(n.id)).map(asElkNode),
  ];
  // An edge may point at a group rather than at a node in it. ELK knows the
  // group by its prefixed id, so the endpoint has to be rewritten or the edge
  // refers to nothing.
  const endpoint = (id: string) => (clusterIds.has(id) ? `cluster:${id}` : id);

  const elkDirection = { TB: 'DOWN', BT: 'UP', LR: 'RIGHT', RL: 'LEFT' }[graph.direction];

  // A crow's foot with a minimum-cardinality mark behind it reaches nearly 30px
  // back from the entity, at both ends. Left out of the spacing, two of them plus
  // a relationship label have to share a gap sized for a bare arrowhead, and the
  // marks end up sitting on the text.
  const tipLen = scene.edgeStroke * scene.tipLength;
  const reach = graph.edges.reduce(
    (most, e) =>
      Math.max(
        most,
        tipReach(e.tipEnd ?? 'arrow', tipLen) + tipReach(e.tipStart ?? 'none', tipLen),
      ),
    0,
  );

  // A label lies across the gap between layers, so which of its dimensions eats
  // into that gap depends on which way the diagram runs. Left to right it is the
  // label's width, and an ER relationship name is wide enough to cover the whole
  // line — the entities ended up joined by nothing but a pair of floating marks.
  // Top to bottom it is the label's height, which the base gap already clears.
  const labelRoom =
    flow === 'horizontal'
      ? graph.edges.reduce((most, e) => Math.max(most, e.label ? (e.labelWidth ?? 0) + 30 : 0), 0)
      : 0;

  const runLayout = async (extra: Record<string, string>) =>
    (await getElk()).layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': elkDirection,
        // Straightest possible spines; this is what keeps a linear run truly linear.
        'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
        'elk.spacing.nodeNode': String(scene.gapNode),
        'elk.layered.spacing.nodeNodeBetweenLayers': String(
          Math.round(scene.gapLayer + reach + labelRoom),
        ),
        'elk.spacing.edgeNode': String(scene.gapNode * 0.5),
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        // We draw our own curves between ports, so ELK's routes are never read.
        'elk.edgeRouting': 'POLYLINE',
        ...extra,
      },
      children,
      // Retry edges are handed to ELK reversed. Left as-is they make the layering
      // pass treat the loop's target as a prerequisite, which drags the node it
      // returns to into the first layer — the entry node ends up second.
      edges: graph.edges
        .filter((edge) => !satelliteIds.has(edge.from) && !satelliteIds.has(edge.to))
        .map((edge) => ({
          id: edge.id,
          sources: [endpoint(edge.backward ? edge.to : edge.from)],
          targets: [endpoint(edge.backward ? edge.from : edge.to)],
        })),
    } as ElkNode) as Promise<ElkNode>;

  const result = await fold(runLayout, graph, scene, flow, { claimed, satelliteIds, soleParent });

  // ELK reports child coordinates relative to their parent; flatten to the root.
  const place = (list: ElkNode[] | undefined, dx: number, dy: number): void => {
    for (const item of list ?? []) {
      const x = (item.x ?? 0) + dx;
      const y = (item.y ?? 0) + dy;
      if (item.id.startsWith('cluster:')) {
        const cluster = graph.clusters.find((c) => `cluster:${c.id}` === item.id);
        if (cluster) {
          cluster.x = x;
          cluster.y = y;
          cluster.width = item.width ?? 0;
          cluster.height = item.height ?? 0;
          // A packed group has no ELK children to walk; its members carry the
          // offsets worked out above and are placed relative to the panel.
          if (packed.has(cluster.id)) {
            for (const id of cluster.nodes) {
              const node = byId.get(id);
              if (!node || node.gridX === undefined) continue;
              node.x = x + scene.clusterPad + node.gridX;
              node.y = y + headroom + node.gridY!;
            }
          }
        }
        place(item.children, x, y);
        continue;
      }
      const node = byId.get(item.id);
      if (node) {
        node.x = x;
        node.y = y;
        node.width = item.width ?? node.width;
        node.height = item.height ?? node.height;
      }
    }
  };
  place(result.children, 0, 0);

  // Pin each excluded satellite on a row's centre line of its own, appended
  // after the last row and past the grid's own outer column. See
  // `placeSatellites` for the exact rule (DESIGN 2.3, 6.1, 6.4).
  placeSatellites(graph, satelliteIds, soleParent);

  square(graph, scene);
  const bounds = extentOf(graph);
  return { width: bounds.width, height: bounds.height };
}
