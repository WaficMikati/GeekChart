import type { Graph, GraphEdge, GraphNode } from '../graph.ts';
import { clusterHeadroom, type Scene } from '../scene.ts';
import { tipReach } from '../tips.ts';
import { BOX_SIZES, CLEARANCE, GRID } from '../tokens.ts';
import { square } from './align.ts';
import type { ElkNode } from './elk.ts';
import { getElk } from './elk.ts';
import { fold } from './fold.ts';
import {
  diamondLabelBudget,
  extentOf,
  fitShape,
  makeMeasurer,
  resolveMeasurer,
  wrapTitle,
  type Measurer,
  type Metrics,
} from './measure.ts';
import { detectRing, layoutRing, layoutRingColumn, ringWidth, wrapLabelLines } from './ring.ts';
import { identifySatellites, placeSatellites } from './satellites.ts';
import { expandFan, findFans, planFan, type FanPlan } from './stack.ts';
import { wrapSiblings, type WrappedRow } from './wrap.ts';

// Re-exported because `makeMeasurer` is a public entry point in its own
// right: every non-ELK chart family (boards, plot, radial, chronicle,
// sequence, commits) imports it directly for text measurement, without ever
// calling `layout()` itself.
export { makeMeasurer, resolveMeasurer, type Measurer };

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
  measureWith?: string | Measurer,
  // DESIGN 1.5 only ever runs for a caller that named a display width: every
  // chart in the catalog already fits the plain 1000/1200 default (`fold`'s
  // own wrap and serpentine handle the few that need help), so leaving this
  // off for them is not a missed optimisation — it is what keeps 37/37 of
  // them laying out exactly as they did before this file existed. Turning it
  // on for every chart whose bare-ELK pass merely exceeds *some* cap would
  // hand `fold()` a graph it never asked for and was not tuned against.
  packToDisplay = false,
): Promise<LayoutResult> {
  const measurer = resolveMeasurer(measureWith);
  const flow = graph.direction === 'LR' || graph.direction === 'RL' ? 'horizontal' : 'vertical';

  // DESIGN 1.8: detected once, up front, purely from graph structure (sizes
  // aren't set yet) — used below both to pick a box width that actually
  // fits the ring at a declared display and, once sizing is done, to place
  // the nodes directly instead of handing the graph to ELK.
  const ringOrder = detectRing(graph);

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
  const boxWidths = [BOX_SIZES.compact.width, BOX_SIZES.standard.width, BOX_SIZES.wide.width];
  const baseWidth = boxWidths.find((w) => w >= wanted) ?? BOX_SIZES.wide.width;

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

  // DESIGN 2.2: the same "wrap rather than widen" for a caption that will
  // not fit the chart's shared box even at its widest — "Pandas · Django ·
  // #1 on TIOBE" is the case: a caption in its own mono face can easily run
  // longer than any title on the same box. Wrapped in the caption's own
  // style, on the same `baseWidth` every sibling already has, never the box
  // grown past what DESIGN 2.2's list allows.
  for (const item of pool) {
    const { node } = item;
    if (!node.caption || ownShape.includes(node.shape)) continue;
    const captionWidth = measurer.measure(
      node.caption,
      scene.captionFont,
      scene.captionSize,
      scene.captionTracking,
    );
    if (captionWidth + scene.padX * 2 <= baseWidth) continue;
    const wrapped = wrapTitle(
      node.caption,
      (s) => measurer.measure(s, scene.captionFont, scene.captionSize, scene.captionTracking),
      baseWidth - scene.padX * 2,
    );
    if (!wrapped) continue;
    node.captionLines = wrapped;
    item.label.width = Math.max(
      item.label.width,
      ...wrapped.map((l) =>
        measurer.measure(l, scene.captionFont, scene.captionSize, scene.captionTracking),
      ),
    );
  }

  // DESIGN 1.1/1.6: a diamond solves its own geometry from its label (it is
  // in `ownShape`, above, exactly so a long diamond label never drags the
  // *shared* box wider) — but under a declared display that leaves it as the
  // one shape none of 1.5's leaf stacking, 1.2's fold, or 1.6's sibling wrap
  // can reach into, since all three pack whole nodes, not what is drawn
  // inside one. A diamond whose own single-line label is still what keeps
  // the canvas over the cap gets 2.2's ordinary "wrap rather than widen"
  // instead — the same packing-before-scaling DESIGN 1.1 asks everywhere
  // else. Never runs undeclared: every diamond in the default catalog
  // already fits, so this only ever fires for a caller that named a display.
  if (packToDisplay) {
    const room = scene.canvas.width - scene.canvas.margin * 2;
    for (const item of intrinsic) {
      const { node } = item;
      if (node.shape !== 'diamond') continue;
      // `base` (the shared rect box) isn't settled until below, but a
      // diamond's own `fitShape` case never reads it — it solves purely off
      // its own label, which is the whole reason it is in `ownShape`.
      const natural = fitShape(item, { width: 0, height: 0 }, scene, flow);
      if (natural.width <= room) continue;
      // Two lines, the same inter-line gap DESIGN 3.5's own row rhythm uses
      // elsewhere — solved for first, since the label width a diamond can
      // afford depends on how tall its label block already is.
      const twoLineHeight = scene.titleSize * 1.16 * 2 + 4;
      const budget = diamondLabelBudget(room, twoLineHeight, scene.padShape);
      if (budget <= 0) continue;
      const wrapped = wrapTitle(
        node.title,
        (s) => measurer.measure(s, scene.titleFont, scene.titleSize),
        budget,
      );
      if (!wrapped) continue;
      node.titleLines = wrapped;
      item.label.width = Math.max(
        ...wrapped.map((l) => measurer.measure(l, scene.titleFont, scene.titleSize)),
      );
      item.label.height = twoLineHeight;
    }
  }
  measurer.done();

  const grid = GRID;
  const roundUp = (v: number) => Math.ceil(v / grid) * grid;

  // Three box heights only, and which one a chart uses is decided by the
  // chart, not by the node: 72 when anything in it carries a caption that
  // itself had to wrap (DESIGN 2.2), 56 when anything carries a plain
  // one-line caption, 48 when nothing does. A captionless name centred in a
  // 56- or 72-high box is the thing 3.2 forbids, and one row of 48s beside a
  // row of 56s/72s breaks 2.3. A wrapped title's second line gets the same
  // 56-high box a caption would.
  const wrappedCaption = graph.nodes.some((n) => Boolean(n.captionLines));
  const twoTier = graph.nodes.some((n) => Boolean(n.caption) || Boolean(n.titleLines));
  const base = {
    width: baseWidth,
    height: wrappedCaption
      ? BOX_SIZES.captionWrap.height
      : twoTier
        ? BOX_SIZES.captioned.height
        : BOX_SIZES.standard.height,
  };

  for (const item of intrinsic) {
    const fitted = fitShape(item, base, scene, flow);
    item.node.width = roundUp(fitted.width);
    item.node.height = roundUp(fitted.height);
  }

  // DESIGN 1.8: placed directly, on real sizes, instead of handed to ELK —
  // a ring has nothing for a layered engine to decide (every node has
  // exactly one forward edge in and one out) and its own cycle-breaking is
  // exactly what folded a short LR ring into reading-order rows in the
  // first place. The two-row grid (DESIGN 1.8's main case) runs whenever it
  // fits; the column fallback below is what runs when it does not, rather
  // than falling through to the ordinary ELK/fold pipeline — that pipeline's
  // own generic loop-back heuristics pick a retry's arrival face from
  // whichever *other* forward edge already uses it (DESIGN 6.2), which for
  // a ring's own closing edge is nothing, and its "which side" tie-break
  // (`route/loops.ts`) has no reason to prefer the right corridor DESIGN
  // 1.8 specifically asks for.
  if (ringOrder) {
    // DESIGN 1.8: every edge here is an ordinary member of the ring, closing
    // edge included — the parser's own cycle detector (`markBackEdges`)
    // flags whichever edge happens to close the cycle as a "backward" retry,
    // which is right for an arbitrary graph but wrong for a ring's own
    // deterministic return: it draws, routes and animates exactly like
    // every other edge here, one bend at most, never the go-around DESIGN
    // 6.7's loop-back describes (the one exception, the column fallback
    // below, still gets `ring` for the same reason — only its own edge into
    // the corridor, `ringLoop`, is drawn differently).
    for (const edge of graph.edges) {
      edge.ring = true;
      edge.backward = false;
    }
    const room = scene.canvas.width - scene.canvas.margin * 2;
    // Set only for the column fallback — `extentOf` (below) reads node and
    // cluster boxes alone, which never learns about a corridor no node sits
    // in, so this is threaded past it explicitly.
    let corridorWidth = 0;
    if (!packToDisplay || ringWidth(ringOrder.length, baseWidth) <= room) {
      // DESIGN 6.9: the plain sibling gutter (`scene.gapNode`) is sized for
      // an unlabelled column gap; a ring edge almost always carries one
      // ("you ask for a dashboard" between two of buzz-context-loop-6.mmd's
      // three columns), and the gate's own 2.7-style growth only widens the
      // *declared display* axis — never run for an undeclared-display ring,
      // which is exactly where this showed up. Sized to the widest ring
      // edge label up front instead, so every column gap already has room.
      // A 2-column ring (4 nodes) already reaches a wide-enough gap through
      // that growth alone in every fixture measured so far; a 3-column ring
      // (6) has two column gaps competing for the same growth budget and
      // needs the head start.
      const widestLabel =
        ringOrder.length > 4
          ? Math.max(
              0,
              ...graph.edges.filter((e) => ringOrder.includes(e.from)).map((e) => e.labelWidth ?? 0),
            )
          : 0;
      const ringGutter = widestLabel
        ? Math.max(scene.gapNode, Math.ceil((widestLabel + 48) / GRID) * GRID)
        : scene.gapNode;
      layoutRing(graph, ringOrder, ringGutter);
    } else {
      // DESIGN 1.8: "on a display too narrow for two columns the ring
      // becomes a column with the return edge up a right corridor" — the
      // box-width drop above already tried every size 2.2 allows for the
      // two-row grid, so this only runs once none of them fit.
      const last = graph.edges.find((e) => e.from === ringOrder[ringOrder.length - 1]);
      if (last) last.ringLoop = true;
      // DESIGN 6.9: every consecutive pair in the column usually carries its
      // own label — the plain sibling gutter (`scene.gapNode`) is sized for
      // an unlabelled row and leaves only a couple of units past a labelled
      // one, so this reserves an edge label's own height plus 8 clear on
      // each side up front rather than leaning on 2.7's own growth (which
      // grows the *display-declared* width axis, not a plain column's own
      // row gaps, and left one gap here at its unlabelled floor).
      const columnGutter = Math.max(
        scene.gapNode,
        Math.ceil((scene.edgeLabelSize * 2 + CLEARANCE.node * 2) / GRID) * GRID,
      );
      const columnLayout = layoutRingColumn(graph, ringOrder, columnGutter);
      corridorWidth = columnLayout.width;
      // DESIGN 1.8/2.2: the return label straddles the corridor (`draw.ts`
      // centres it there) — wrapped, not widened, when even that shared
      // centre cannot keep both halves under the declared display's own
      // room (buzz-context-loop.mmd's "posts into the channel", 183 wide,
      // over twice what half of a 358 column leaves past the corridor).
      if (last?.label) {
        const halfRoom = room - columnLayout.corridorX;
        const maxLineWidth = 2 * halfRoom - 12;
        const upper = scene.edgeLabelUpper;
        const wrapMeasurer = resolveMeasurer(measureWith);
        const measureLine = (s: string) =>
          wrapMeasurer.measure(
            upper ? s.toUpperCase() : s,
            scene.edgeLabelFont,
            scene.edgeLabelSize,
            scene.edgeLabelTracking,
          );
        if (maxLineWidth > 0 && (last.labelWidth ?? 0) + 12 > 2 * halfRoom) {
          const lines = wrapLabelLines(last.label, measureLine, maxLineWidth);
          if (lines.length > 1) {
            last.labelLines = lines;
            last.labelWidth = Math.max(...lines.map(measureLine));
          }
        }
        wrapMeasurer.done();
      }
    }
    square(graph, scene);
    const bounds = extentOf(graph);
    return { width: Math.max(bounds.width, corridorWidth), height: bounds.height };
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

  // Built as a factory rather than one fixed closure so DESIGN 1.5's leaf
  // stacking (below) can re-run the exact same ELK call against a graph with
  // one or more fans folded into a stand-in node, without duplicating any of
  // the layout options.
  const makeRunLayout =
    (childrenX: ElkNode[], endpointX: (id: string) => string) =>
    async (extra: Record<string, string>) =>
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
        children: childrenX,
        // Retry edges are handed to ELK reversed. Left as-is they make the layering
        // pass treat the loop's target as a prerequisite, which drags the node it
        // returns to into the first layer — the entry node ends up second.
        edges: graph.edges
          .filter((edge) => !satelliteIds.has(edge.from) && !satelliteIds.has(edge.to))
          .map((edge) => ({
            id: edge.id,
            sources: [endpointX(edge.backward ? edge.to : edge.from)],
            targets: [endpointX(edge.backward ? edge.from : edge.to)],
          }))
          // A fan's own parent→leaf edges are drawn as the bus (DESIGN 1.5),
          // never routed by ELK — once both ends remap to the same stand-in
          // id they would be a self-loop with nothing for ELK to lay out.
          .filter((e) => e.sources[0] !== e.targets[0]),
      } as ElkNode) as Promise<ElkNode>;

  const runLayout = makeRunLayout(children, endpoint);

  // DESIGN 1.5: when the plain layout above is wider than the canvas, a fan
  // of leaf children collapses into one column under its parent before
  // anything is scaled or folded into rows. Cheap to check: this first call
  // is the exact one `fold()` itself makes as its own first attempt, so
  // nothing extra is spent when a chart already fits (every chart in the
  // gallery today does, so this never runs there).
  const room = scene.canvas.width - scene.canvas.margin * 2;
  const first = await runLayout({});
  let fanPlansById = new Map<string, FanPlan>();
  // Set only when a stacked prefix already fit the cap on its own — the
  // fold-skipping fast path below. Left null for every chart that never
  // stacks at all, and for the "stacking still isn't enough" tail, both of
  // which fall through to the ordinary `fold()` call same as always.
  let winner: { result: ElkNode; plans: FanPlan[] } | null = null;

  // DESIGN 1.6: fold's own wrap-into-rows, then a sibling-wrap pass on top
  // when the result is still wider than the display. Factored out so the
  // "stacking still isn't enough" tail below can run it against more than
  // one candidate layout and compare, rather than committing to one before
  // knowing whether it actually reaches the cap.
  const wrapOnTop = (
    folded: ElkNode,
    plansById: Map<string, FanPlan>,
  ): { corridors: Map<string, number>; rows: WrappedRow[] } => {
    if (!(packToDisplay && (folded.width ?? 0) > room && folded.children)) {
      return { corridors: new Map(), rows: [] };
    }
    // A top-level ELK item's id is a fan stand-in, a cluster, or a plain
    // node — this resolves any of the three back to the graph id its edges
    // actually name.
    const resolveId = (itemId: string): string =>
      itemId.startsWith('fan:')
        ? (plansById.get(itemId)?.parent.id ?? itemId)
        : itemId.startsWith('cluster:')
          ? itemId.slice('cluster:'.length)
          : itemId;
    // DESIGN 6.9: a wrap edge's own label needs 8 clear of every node on
    // both sides — taller than the ordinary 32 between rows holds, so a row
    // an edge like that arrives at gets a grown gap above it instead of a
    // label with nowhere to fit.
    const needsLabelGap = new Set(
      folded.children
        .map((item) => item.id)
        .filter((id) => {
          const realId = resolveId(id);
          return graph.edges.some((e) => !e.backward && e.to === realId && e.label);
        }),
    );
    const labelGap = scene.edgeLabelSize * 2 + CLEARANCE.node * 2 + GRID * 3;
    return wrapSiblings(folded.children, room, needsLabelGap, labelGap);
  };
  // How wide the packed row/column of top-level items actually is, read
  // back from where `wrapOnTop` (above) leaves them — ELK's own `.width` is
  // the pre-wrap row's, exactly the number a "did this candidate actually
  // reach the cap" comparison needs to see past.
  const packedWidth = (folded: ElkNode): number =>
    folded.children?.length
      ? Math.max(...folded.children.map((c) => (c.x ?? 0) + (c.width ?? 0))) -
        Math.min(...folded.children.map((c) => c.x ?? 0))
      : (folded.width ?? 0);

  let result: ElkNode;
  let wrapCorridors = new Map<string, number>();
  let wrappedRows: WrappedRow[] = [];

  if (packToDisplay && (first.width ?? 0) > room) {
    const fans = findFans(graph, new Set([...claimed, ...satelliteIds])).map(planFan);
    const stackedGraph = (plans: FanPlan[]) => {
      const unitOf = new Map<string, string>();
      for (const plan of plans) {
        unitOf.set(plan.parent.id, plan.unitId);
        for (const leaf of plan.leaves) unitOf.set(leaf.id, plan.unitId);
      }
      const fannedIds = new Set(unitOf.keys());
      const stackedChildren = [
        ...children.filter((c) => !fannedIds.has(c.id)),
        ...plans.map((p) => ({ id: p.unitId, width: p.unitWidth, height: p.unitHeight })),
      ];
      const stackedEndpoint = (id: string) => unitOf.get(id) ?? endpoint(id);
      return makeRunLayout(stackedChildren, stackedEndpoint);
    };
    // Widest fan first; stop stacking as soon as a prefix fits (DESIGN 1.5).
    // Fans the same size (Python's and Java's are both two 200-wide leaves)
    // are added a whole tier at a time, not one at a time: stacking only
    // one of two identically-shaped branches leaves the other exactly the
    // single row it always was, next to a column now several rows tall —
    // a row-sharing mismatch DESIGN 2.3 measures (a node's own band no
    // longer lines up with anything), not just an asymmetry with no reason
    // behind it.
    //
    // A prefix that already fits is taken as-is, not handed to `fold()` for
    // a further pass: `fold` reshapes a *wasteful* layout (its own height
    // more than 1.2× its width, DESIGN 1.4) even after it fits the canvas,
    // and doing that to an already-narrow stacked fan is what pulled a
    // decision's own edge into a needless extra bend, stranding its label.
    // Fold gets its turn only in the tail below, once stacking genuinely
    // could not reach the cap on its own.
    const tiers: FanPlan[][] = [];
    for (const fan of fans) {
      const last = tiers[tiers.length - 1];
      const sameTier =
        last &&
        last[0]!.leaves.length === fan.leaves.length &&
        last[0]!.leaves.reduce((s, n) => s + n.width!, 0) ===
          fan.leaves.reduce((s, n) => s + n.width!, 0);
      if (sameTier) last!.push(fan);
      else tiers.push([fan]);
    }
    for (let n = 1; n <= tiers.length && !winner; n++) {
      const plans = tiers.slice(0, n).flat();
      const candidateRunLayout = stackedGraph(plans);
      const trial = await candidateRunLayout({});
      if ((trial.width ?? 0) <= room) winner = { result: trial, plans };
    }

    if (winner) {
      fanPlansById = new Map(winner.plans.map((p) => [p.unitId, p]));
      result = winner.result;
      ({ corridors: wrapCorridors, rows: wrappedRows } = wrapOnTop(result, fanPlansById));
    } else if (fans.length) {
      // DESIGN 1.5/1.6: no stacked prefix reaches the cap on its own — a
      // stacked fan is one atomic ELK node, so neither `fold()` nor 1.6's
      // own sibling-wrap can reshape anything *inside* it once it is handed
      // one. Packing picks whatever fits: the fully-stacked graph and the
      // plain, unstacked one — whose ordinary siblings 1.6 already knows
      // how to wrap into a column of their own — are both folded and
      // wrapped, and whichever actually reaches the cap wins (the narrower
      // of the two if both do, or if neither does). A diamond fanning to
      // two boxes it cannot stack and fit at once (python-or-java-short at
      // 358) is exactly this case: stacked, the whole diamond-plus-column
      // is one ~328-wide unit nothing can narrow further; unstacked, Python
      // and Java are two ordinary 200-wide siblings DESIGN 1.6 wraps into a
      // column of their own, each centred under the diamond — ~296 wide
      // with margins, comfortably under the cap, at scale 1.
      const stackedPlans = new Map(fans.map((p) => [p.unitId, p]));
      const stackedFolded = await fold(stackedGraph(fans), graph, scene, flow, {
        claimed,
        satelliteIds,
        soleParent,
      });
      const stackedWrap = wrapOnTop(stackedFolded, stackedPlans);
      const stackedWidth = packedWidth(stackedFolded);

      const plainFolded = await fold(runLayout, graph, scene, flow, {
        claimed,
        satelliteIds,
        soleParent,
      });
      const plainWrap = wrapOnTop(plainFolded, new Map());
      const plainWidth = packedWidth(plainFolded);

      const stackedFits = stackedWidth <= room;
      const plainFits = plainWidth <= room;
      const useStacked = stackedFits === plainFits ? stackedWidth <= plainWidth : stackedFits;

      if (useStacked) {
        fanPlansById = stackedPlans;
        result = stackedFolded;
        wrapCorridors = stackedWrap.corridors;
        wrappedRows = stackedWrap.rows;
      } else {
        fanPlansById = new Map();
        result = plainFolded;
        wrapCorridors = plainWrap.corridors;
        wrappedRows = plainWrap.rows;
      }
    } else {
      result = await fold(runLayout, graph, scene, flow, { claimed, satelliteIds, soleParent });
      ({ corridors: wrapCorridors, rows: wrappedRows } = wrapOnTop(result, fanPlansById));
    }
  } else {
    result = await fold(runLayout, graph, scene, flow, { claimed, satelliteIds, soleParent });
  }

  // A top-level ELK item's id is a fan stand-in, a cluster, or a plain node —
  // this is the one place that knows how to read any of the three back to
  // the graph id its edges actually name. Shared by everything below that
  // has to go the other way from `wrapSiblings`'s own ELK-only view.
  const resolveRealId = (itemId: string): string =>
    itemId.startsWith('fan:')
      ? (fanPlansById.get(itemId)?.parent.id ?? itemId)
      : itemId.startsWith('cluster:')
        ? itemId.slice('cluster:'.length)
        : itemId;

  // ELK reports child coordinates relative to their parent; flatten to the root.
  const place = (list: ElkNode[] | undefined, dx: number, dy: number): void => {
    for (const item of list ?? []) {
      const x = (item.x ?? 0) + dx;
      const y = (item.y ?? 0) + dy;
      const fanPlan = fanPlansById.get(item.id);
      if (fanPlan) {
        expandFan(fanPlan, x, y);
        continue;
      }
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

  // Every parent→leaf edge inside a stacked fan is drawn as the bus
  // (DESIGN 1.5), never routed by `route/plan.ts` — draw.ts reads this flag
  // to build the shared-trunk path directly from the final positions above.
  for (const plan of fanPlansById.values()) {
    const leafIds = new Set(plan.leaves.map((l) => l.id));
    for (const edge of graph.edges) {
      if (edge.from === plan.parent.id && leafIds.has(edge.to)) edge.bus = true;
    }
  }

  // DESIGN 1.6: every parent→sibling edge into a row `wrapSiblings` pushed
  // down is drawn the same bus shape 1.5's own leaf trunk uses, corridor
  // supplied instead of assumed (`edge.wrapTrunkX`, read by `draw.ts`) — the
  // wrapped item's id is a fan stand-in, a cluster, or a plain node, so it is
  // resolved back to the graph id its edges actually name before matching.
  for (const [itemId, corridorX] of wrapCorridors) {
    const realId = resolveRealId(itemId);
    for (const edge of graph.edges) {
      if (edge.to !== realId || edge.bus || edge.backward) continue;
      edge.bus = true;
      edge.wrapTrunkX = corridorX;
    }
  }

  // DESIGN 6.13 (extends 1.6): a forward source whose straight-ish path to
  // its target would run through a box display-width wrapping placed
  // between them — a sibling wrapped into an earlier row, not anything the
  // edge itself connects to — gets the same bus DESIGN 1.6's own
  // sibling-wrap edge draws, mirrored: `to` is the one shared target here
  // instead of `from`, so every qualifying source shares the identical
  // corridor and the whole group reads as one trunk merging into the
  // target's top centre (DESIGN 6.3's fan-in single arrowhead) rather than
  // each source finding its own lane. Detected purely geometrically — any
  // other placed node's box crossing the straight span between a source's
  // own bottom face and the target's own top face — so it also catches the
  // fault wherever else display wrapping might produce it, not only the
  // wrapped fan-in this was written for (buzz-one-log.mmd's four sources
  // into LOG, wrapped 2×2 at a 612px display). Scoped to a genuine fan-in —
  // a target with two or more forward sources — so an ordinary single-
  // source edge that merely bends past a neighbour (subgraphs.mmd's
  // C→E, 4geeks-journey.mmd's B→D) is left to `route/plan.ts`'s own
  // per-edge search, which already routes those cleanly; this module only
  // owns the shape a lone edge's search cannot, several sources converging
  // on one trunk.
  const forwardInCount = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.backward || edge.from === edge.to) continue;
    forwardInCount.set(edge.to, (forwardInCount.get(edge.to) ?? 0) + 1);
  }
  const fanInEdges = graph.edges.filter((edge) => {
    if (edge.backward || edge.bus || edge.from === edge.to) return false;
    if ((forwardInCount.get(edge.to) ?? 0) < 2) return false;
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return false;
    if (
      from.x === undefined ||
      from.y === undefined ||
      from.width === undefined ||
      from.height === undefined ||
      to.x === undefined ||
      to.y === undefined ||
      to.width === undefined
    )
      return false;
    const fromCx = from.x + from.width / 2;
    const toCx = to.x + to.width / 2;
    const yLo = Math.min(from.y + from.height, to.y);
    const yHi = Math.max(from.y + from.height, to.y);
    const xLo = Math.min(fromCx, toCx);
    const xHi = Math.max(fromCx, toCx);
    return graph.nodes.some((n) => {
      if (n.id === edge.from || n.id === edge.to) return false;
      if (n.x === undefined || n.y === undefined || n.width === undefined || n.height === undefined)
        return false;
      return n.x < xHi && n.x + n.width > xLo && n.y < yHi && n.y + n.height > yLo;
    });
  });
  // A lone remaining source into a bus target joins it too, for the same
  // reason DESIGN 6.3's single-arrowhead trunk only reads as one trunk when
  // every branch actually merges into it: left on the ordinary per-edge
  // search *by itself*, it never learns the other sources are converging on
  // the target's exact centre and picks its own straight-line midpoint
  // instead — crossing the very trunk it should have joined
  // (buzz-one-log.mmd's FIZZ→LOG at 358, the one source not blocked by
  // another row, aimed at the overlap of its own and LOG's face instead of
  // LOG's true centre). Two or more remaining sources are left alone —
  // `route/plan.ts`'s own arrivals-merge already centres a *group* of
  // ordinary edges on each other correctly (buzz-one-log.mmd's TEAM and
  // FIZZ at 612, both still ordinary edges) — pulling every one of them
  // through the corridor regardless is what recreated a centering conflict
  // this bus exists to avoid.
  const busTargets = new Set(fanInEdges.map((e) => e.to));
  const fanInByTarget = new Map<string, GraphEdge[]>();
  for (const edge of fanInEdges) {
    fanInByTarget.set(edge.to, [...(fanInByTarget.get(edge.to) ?? []), edge]);
  }
  for (const targetId of busTargets) {
    const remaining = graph.edges.filter(
      (edge) =>
        !edge.backward &&
        !edge.bus &&
        edge.from !== edge.to &&
        edge.to === targetId &&
        !fanInByTarget.get(targetId)!.includes(edge),
    );
    if (remaining.length === 1) {
      fanInByTarget.set(targetId, [...fanInByTarget.get(targetId)!, remaining[0]!]);
    }
  }
  for (const [targetId, edgesIn] of fanInByTarget) {
    const target = byId.get(targetId);
    if (!target || target.x === undefined || target.y === undefined || target.width === undefined)
      continue;
    // One corridor, clear of every node whose own row falls between the
    // topmost source involved and the target — not just the sources
    // themselves, so a chart with something else in that span still clears
    // it — rounded up to the grid (DESIGN 2.1).
    const spanTop = Math.min(...edgesIn.map((e) => byId.get(e.from)!.y!));
    let corridorX = target.x + target.width + 24;
    for (const n of graph.nodes) {
      if (n.x === undefined || n.y === undefined || n.width === undefined || n.height === undefined)
        continue;
      if (n.y >= target.y || n.y + n.height <= spanTop) continue;
      corridorX = Math.max(corridorX, n.x + n.width + 24);
    }
    corridorX = Math.ceil(corridorX / GRID) * GRID;
    for (const edge of edgesIn) {
      edge.bus = true;
      edge.wrapTrunkX = corridorX - target.x;
    }
  }

  // DESIGN 6.12: a plain node fanning into 3+ forward children that all land
  // on one shared row directly below it — already a fine layout, nothing for
  // 1.5's stacking to fix — still sends each child's edge through
  // `route/plan.ts`'s ordinary per-edge search, which centres every one of
  // them on the very same wall-bounded channel and then has to force them 16
  // apart to keep DESIGN 6.4's clearance, landing every single one off its
  // own true centre (DESIGN 6.1). Read back only now that `square()` (above)
  // has settled every position for good, so this sees exactly what the
  // gate will measure, not a candidate layout that could still move.
  const rowFanChildren = new Map<string, GraphNode[]>();
  for (const edge of graph.edges) {
    if (edge.backward || edge.bus || edge.from === edge.to) continue;
    const child = byId.get(edge.to);
    if (!child) continue;
    rowFanChildren.set(edge.from, [...(rowFanChildren.get(edge.from) ?? []), child]);
  }
  for (const [parentId, children] of rowFanChildren) {
    if (children.length < 3) continue;
    const parent = byId.get(parentId);
    if (!parent || parent.x === undefined || parent.y === undefined) continue;
    if (children.some((c) => c.x === undefined || c.y === undefined)) continue;
    const y0 = children[0]!.y!;
    if (!children.every((c) => Math.abs(c.y! - y0) < 1)) continue;
    const childIds = new Set(children.map((c) => c.id));
    for (const edge of graph.edges) {
      if (edge.from === parentId && childIds.has(edge.to) && !edge.backward) {
        edge.bus = true;
        edge.rowBus = true;
      }
    }
  }

  // DESIGN 7.3: ELK centred every parent over its children back when they
  // still sat side by side — ordinary layered placement, nothing to do with
  // wrapping. Once `wrapSiblings` reads as one column instead, a parent left
  // at its old x sits off to the side of the very thing it points into. Only
  // when a single parent owns every id the row wrapped (the common shape —
  // one decision, wrapped branches) is it safe to move: a row mixing several
  // parents has no one centre line that is right for all of them.
  for (const row of wrappedRows) {
    const realIds = new Set(row.ids.map(resolveRealId));
    const parents = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.backward || !realIds.has(edge.to)) continue;
      parents.add(edge.from);
    }
    if (parents.size !== 1) continue;
    const parent = byId.get([...parents][0]!);
    if (!parent || parent.x === undefined || parent.width === undefined) continue;
    // A parent already claimed by a cluster or satellite pass sits wherever
    // that pass put it for its own reasons — not this row's to move.
    if (claimed.has(parent.id) || satelliteIds.has(parent.id)) continue;
    parent.x = row.centreX - parent.width / 2;
  }

  // Pin each excluded satellite on a row's centre line of its own, appended
  // after the last row and past the grid's own outer column. See
  // `placeSatellites` for the exact rule (DESIGN 2.3, 6.1, 6.4).
  placeSatellites(graph, satelliteIds, soleParent);

  square(graph, scene);
  const bounds = extentOf(graph);
  return { width: bounds.width, height: bounds.height };
}
