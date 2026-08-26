import type { Graph, GraphCluster, GraphNode } from './graph.ts';
import { clusterHeadroom, type Scene } from './scene.ts';
import { tipReach } from './tips.ts';
import { getElk, type ElkNode } from './layout/elk.ts';
import { makeMeasurer, wrapTitle, fitShape, extentOf, type Metrics } from './layout/measure.ts';
import { fold } from './layout/fold.ts';
import { identifySatellites, placeSatellites } from './layout/satellites.ts';

export { makeMeasurer };

/**
 * Size the nodes, then let ELK place them.
 *
 * The order matters and is the whole point of owning this step. Sizes are
 * decided *before* layout, so ELK spaces boxes that are already their final
 * dimensions — nothing collides afterwards and nothing needs re-fitting. The
 * previous pipeline sized boxes after the fact and spent most of its complexity
 * repairing the damage.
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
export async function layout(graph: Graph, scene: Scene, measureWith?: string): Promise<LayoutResult> {
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
    const t = measurer.measure(cluster.title, scene.titleFont, scene.type.title, scene.type.titleTracking);
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
    item.label.width = Math.max(...wrapped.map((l) => measurer.measure(l, scene.titleFont, scene.titleSize)));
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
        children: cluster.nodes.map((id) => byId.get(id)).filter(Boolean).map((n) => asElkNode(n!)),
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
    (most, e) => Math.max(most, tipReach(e.tipEnd ?? 'arrow', tipLen) + tipReach(e.tipStart ?? 'none', tipLen)),
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
        'elk.layered.spacing.nodeNodeBetweenLayers': String(Math.round(scene.gapLayer + reach + labelRoom)),
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

const onGrid = (v: number, step = 8) => Math.round(v / step) * step;

/**
 * Put the layout back on the grid. DESIGN 2.1, 2.3, 2.6.
 *
 * A layout engine optimises for edge length and crossings; it has no reason to
 * care that two boxes in the same row are a fifth of a unit apart vertically, or
 * that a column sits at x 292.1. Nobody sees the fifth of a unit — but with
 * every edge now axis-aligned, a row that is not exactly a row turns each of its
 * edges into a jog, and eight jogs is what "generated" looks like.
 *
 * So the placement is read as rows and columns, each is given one exact
 * coordinate on the 8-grid, and the panels are refitted around whatever moved.
 */
function square(graph: Graph, scene: Scene): void {
  const placed = graph.nodes.filter((n) => n.x !== undefined && n.width !== undefined);
  if (!placed.length) return;

  // Rows and columns are found by *centre*, because a diamond in a row of boxes
  // shares the row's middle and nothing else about it.
  const band = (
    items: GraphNode[],
    centreOf: (n: GraphNode) => number,
    move: (n: GraphNode, to: number) => void,
  ) => {
    const order = [...items].sort((a, b) => centreOf(a) - centreOf(b));
    let group: GraphNode[] = [];
    const flush = () => {
      if (!group.length) return;
      const mean = group.reduce((sum, n) => sum + centreOf(n), 0) / group.length;
      const target = onGrid(mean);
      for (const n of group) move(n, target);
      group = [];
    };
    for (const n of order) {
      if (group.length && centreOf(n) - centreOf(group[group.length - 1]!) > 9) flush();
      group.push(n);
    }
    flush();
  };

  // A record — a class box, an entity table — is as tall as its own contents, so
  // a row of them is a row of three different heights with nothing lining up.
  // DESIGN 2.3 says a row shares a height; the extra room goes under the last
  // member row, which is where a table's spare space belongs anyway.
  const records = placed.filter((n) => n.shape === 'panel');
  const rows: GraphNode[][] = [];
  for (const node of [...records].sort((a, b) => a.y! - b.y!)) {
    const found = rows.find((r) =>
      r.some((o) => node.y! < o.y! + o.height! && o.y! < node.y! + node.height!));
    if (found) found.push(node);
    else rows.push([node]);
  }
  for (const row of rows) {
    if (row.length < 2) continue;
    const top = Math.min(...row.map((n) => n.y!));
    const height = Math.max(...row.map((n) => n.height!));
    for (const node of row) {
      node.y = top;
      node.height = height;
    }
  }

  const gridUp = () => {
    band(placed, (n) => n.y! + n.height! / 2, (n, to) => { n.y = to - n.height! / 2; });
    band(placed, (n) => n.x! + n.width! / 2, (n, to) => { n.x = to - n.width! / 2; });
  };
  gridUp();

  alignPanels(graph, scene);

  // A cluster is whatever its members now occupy, plus its padding and the room
  // its heading needs. Refitting is what keeps a member from hanging out of its
  // own group after the grid moved it.
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // Same adjustment as the forward placement above — this recovers a cluster's
  // top edge from where its members actually ended up, so it has to use the
  // same content-start offset that put them there in the first place.
  const headroom = clusterHeadroom(scene) + scene.clusterPad * 0.5;
  const refit = () => {
    for (const cluster of graph.clusters) {
      const members = cluster.nodes
        .map((id) => byId.get(id))
        .filter((n): n is GraphNode => n !== undefined && n.x !== undefined);
      if (!members.length) continue;
      const contentX0 = Math.min(...members.map((n) => n.x!));
      const contentX1 = Math.max(...members.map((n) => n.x! + n.width!));
      // DESIGN 2.6: the panel's own title/kicker text count as content it has
      // to hug too. When they are wider than the children, the box grows
      // around the content's own centre rather than the children's edges —
      // padding stays 24 on both sides instead of piling onto one.
      const contentWidth = Math.max(contentX1 - contentX0, cluster.headerWidth ?? 0);
      const contentCx = (contentX0 + contentX1) / 2;
      const x0 = onGrid(contentCx - contentWidth / 2 - scene.clusterPad);
      const x1 = onGrid(contentCx + contentWidth / 2 + scene.clusterPad);
      const y0 = Math.min(...members.map((n) => n.y!)) - headroom;
      const y1 = Math.max(...members.map((n) => n.y! + n.height!)) + scene.clusterPad;
      cluster.x = x0;
      cluster.y = y0;
      cluster.width = x1 - x0;
      cluster.height = y1 - y0;
    }
  };
  refit();

  // The grid pass above bands every node's centre by proximity across the
  // *whole* diagram, which can pull a cluster's own rows a few units off
  // whatever gap ELK gave them inside the panel — enough, once an arrowhead's
  // reach is subtracted from it, to land under the 16-unit rendered floor.
  // DESIGN 2.6 says a panel's children obey 2.3's 24/32 gutter regardless, so
  // it is enforced directly here rather than left to survive the rounding.
  enforceClusterGutters(graph);
  refit();

  spreadClusters(graph, scene);
  // Moving whole groups puts their contents into new rows and columns with each
  // other, so the grid is read again now that they are neighbours.
  gridUp();
  refit();
  shareClusterGrid(graph);
  centreRows(graph);
  alignSoleChildren(graph);

  // Pull the whole drawing back to the origin: bands and panels both move things
  // left and up, and a drawing that starts at -40 loses its margin.
  const boxes = [
    ...placed.map((n) => ({ x: n.x!, y: n.y! })),
    ...graph.clusters.filter((c) => c.x !== undefined).map((c) => ({ x: c.x!, y: c.y! })),
  ];
  const dx = Math.min(...boxes.map((b) => b.x));
  const dy = Math.min(...boxes.map((b) => b.y));
  if (dx || dy) {
    for (const n of placed) { n.x! -= dx; n.y! -= dy; }
    for (const c of graph.clusters) {
      if (c.x === undefined) continue;
      c.x -= dx;
      c.y! -= dy;
    }
  }
}

/**
 * Force a 32-unit gutter between vertically stacked siblings inside a panel.
 * DESIGN 2.3, 2.6.
 *
 * ELK is handed this spacing already (the cluster's own `elk.spacing.nodeNode`
 * / `nodeNodeBetweenLayers`), but the row-banding pass above snaps every
 * node's centre by its proximity to every *other* node in the diagram, not
 * just its cluster-mates — close enough to a neighbour outside the panel and
 * a row can be pulled a handful of units off the gap ELK actually gave it.
 * Once an arrowhead's reach is subtracted from what is left, that is enough
 * to put the drawn edge under the 16-unit floor. So the gutter is checked
 * directly, per column of siblings that actually overlap in x, and anything
 * still short is pushed down — carrying whatever sits below it in the same
 * column along, so closing one gap can never reopen the next.
 *
 * Only a column pair with an actual edge between them is touched. A packed
 * group (DESIGN 2.6's unconnected cards, laid out by `packed` above) has no
 * inner edges at all, so nothing measures the gap between its rows — its
 * tighter grid is the point, not a bug, and forcing 32 between its rows would
 * only push its own boundary into whatever sits below the panel.
 */
function enforceClusterGutters(graph: Graph): void {
  const gutter = 32;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const connected = new Set(graph.edges.map((e) => [e.from, e.to].sort().join('|')));
  const linked = (a: GraphNode, b: GraphNode) => connected.has([a.id, b.id].sort().join('|'));
  for (const cluster of graph.clusters) {
    const members = cluster.nodes
      .map((id) => byId.get(id))
      .filter((n): n is GraphNode => n !== undefined && n.x !== undefined);
    if (members.length < 2) continue;
    const columns: GraphNode[][] = [];
    for (const node of [...members].sort((a, b) => a.x! - b.x!)) {
      const column = columns.find((c) =>
        c.some((o) => node.x! < o.x! + o.width! && o.x! + o.width! > node.x!));
      if (column) column.push(node);
      else columns.push([node]);
    }
    for (const column of columns) {
      column.sort((a, b) => a.y! - b.y!);
      for (let i = 1; i < column.length; i++) {
        if (!linked(column[i - 1]!, column[i]!)) continue;
        const need = column[i - 1]!.y! + column[i - 1]!.height! + gutter;
        if (column[i]!.y! < need) {
          const dy = need - column[i]!.y!;
          for (let j = i; j < column.length; j++) column[j]!.y! += dy;
        }
      }
    }
  }
}

/**
 * Line a panel's inputs and outputs up column for column. DESIGN 2.6.
 *
 * This is the one composition the reference the spec was measured from is built
 * on, and the one thing a layout engine will never do: it has no notion that the
 * four things feeding a panel and the four things it produces are the *same four
 * columns*, so it spaces each row for itself and every edge arrives at an angle.
 *
 * Given the columns, each edge is one straight vertical from an input's bottom
 * into the panel's top, and out of its bottom into an output's top — which is
 * the whole of the golden's edge geometry.
 */
function alignPanels(graph: Graph, scene: Scene): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const inside = new Set(graph.clusters.flatMap((c) => c.nodes));

  for (const cluster of graph.clusters) {
    if (cluster.x === undefined) continue;
    const outside = (id: string) => !inside.has(id) && byId.has(id);
    const feeds = graph.edges.filter((e) => e.to === cluster.id && outside(e.from)).map((e) => e.from);
    const yields = graph.edges.filter((e) => e.from === cluster.id && outside(e.to)).map((e) => e.to);
    const inputs = [...new Set(feeds)].map((id) => byId.get(id)!);
    const outputs = [...new Set(yields)].map((id) => byId.get(id)!);
    if (!inputs.length && !outputs.length) continue;

    const columns = Math.max(inputs.length, outputs.length);
    if (columns < 2) continue;
    const width = Math.max(...[...inputs, ...outputs].map((n) => n.width!));
    const room = scene.canvas.width - scene.canvas.margin * 2;
    // Equal gutters on the 8-grid, as wide as the canvas can carry. DESIGN 2.3.
    const gutter = [32, 24, 16, 8].find((g) => columns * width + (columns - 1) * g <= room) ?? 8;
    const span = columns * width + (columns - 1) * gutter;
    const left = onGrid((room - span) / 2);

    const lay = (row: GraphNode[]) => {
      if (!row.length) return;
      // A short row keeps the same columns, centred among them.
      const skip = Math.floor((columns - row.length) / 2);
      const y = onGrid(Math.min(...row.map((n) => n.y!)));
      row.forEach((node, i) => {
        node.width = width;
        node.x = left + (skip + i) * (width + gutter);
        node.y = y;
      });
    };
    lay(inputs);
    lay(outputs);

    // The panel spans every column it talks to, so each channel drops straight
    // in rather than converging on the panel's middle.
    const centres = [...inputs, ...outputs].map((n) => n.x! + n.width! / 2);
    const members = cluster.nodes
      .map((id) => byId.get(id))
      .filter((n): n is GraphNode => n !== undefined && n.x !== undefined);
    const pad = scene.clusterPad;
    const x0 = onGrid(Math.min(...centres) - pad * 2);
    const x1 = onGrid(Math.max(...centres) + pad * 2);
    if (!members.length) continue;

    // Re-space the children across the widened panel, on its own grid.
    const rows = new Map<number, GraphNode[]>();
    for (const node of members) {
      const key = onGrid(node.y! + node.height! / 2);
      rows.set(key, [...(rows.get(key) ?? []), node]);
    }
    // The panel's own grid (2.6): one gutter of 24, and the cards take the rest.
    // Spreading fixed-width cards across the panel instead leaves gutters three
    // times the size of the ones outside it, which is 2.3's "gutters are equal"
    // broken at the level nobody thinks to check.
    const inner = x1 - x0 - pad * 2;
    const gap = 24;
    for (const row of rows.values()) {
      row.sort((a, b) => a.x! - b.x!);
      const cellWidth = Math.max(
        Math.max(...row.map((n) => n.width!)),
        onGrid((inner - (row.length - 1) * gap) / row.length),
      );
      const total = row.length * cellWidth + (row.length - 1) * gap;
      const start = x0 + pad + Math.max(0, onGrid((inner - total) / 2));
      row.forEach((node, i) => {
        node.width = cellWidth;
        node.x = start + i * (cellWidth + gap);
      });
    }
  }
}

/** Move a cluster and everything in it. */
function shiftCluster(cluster: GraphCluster, byId: Map<string, GraphNode>, dx: number, dy: number): void {
  cluster.x! += dx;
  cluster.y! += dy;
  for (const id of cluster.nodes) {
    const node = byId.get(id);
    if (!node || node.x === undefined) continue;
    node.x += dx;
    node.y! += dy;
  }
}

/**
 * A stack of narrow groups goes side by side instead. DESIGN 1.2, 1.4, 2.3.
 *
 * Three groups of two boxes each, laid top to bottom, is a 200-wide strip down
 * the middle of a 1000-wide stage and three times taller than it needs to be —
 * the fault 1.4 names and 7.4 measures. The content itself says which way it
 * wants to go: groups that are narrow relative to the canvas read as columns of
 * a pipeline, and a pipeline runs across. Wide groups (a layer with three
 * services in it) are left stacked, because that is what a layer diagram is.
 */
function spreadClusters(graph: Graph, scene: Scene): void {
  const clusters = graph.clusters.filter((c) => c.x !== undefined && c.nodes.length);
  if (clusters.length < 2) return;
  const held = new Set(clusters.flatMap((c) => c.nodes));
  if (!graph.nodes.every((n) => held.has(n.id))) return;

  const room = scene.canvas.width - scene.canvas.margin * 2;
  const widest = Math.max(...clusters.map((c) => c.width!));
  if (widest >= room * 0.55) return;

  const gutter = 32;
  const total = clusters.reduce((sum, c) => sum + c.width!, 0) + gutter * (clusters.length - 1);
  if (total > room) return;

  // Reading order comes from the edges between the groups, not from where the
  // layout happened to put them — a chain laid out as an L still reads A, B, C.
  const owner = new Map<string, string>();
  for (const c of clusters) for (const id of c.nodes) owner.set(id, c.id);
  const after = new Map<string, Set<string>>(clusters.map((c) => [c.id, new Set<string>()]));
  const before = new Map<string, number>(clusters.map((c) => [c.id, 0]));
  for (const edge of graph.edges) {
    const a = owner.get(edge.from) ?? edge.from;
    const b = owner.get(edge.to) ?? edge.to;
    if (a === b || !after.has(a) || !after.has(b) || after.get(a)!.has(b)) continue;
    after.get(a)!.add(b);
    before.set(b, before.get(b)! + 1);
  }
  const queue = clusters.filter((c) => before.get(c.id) === 0).map((c) => c.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of after.get(id) ?? []) {
      before.set(next, before.get(next)! - 1);
      if (before.get(next) === 0) queue.push(next);
    }
  }
  for (const c of clusters) if (!order.includes(c.id)) order.push(c.id);

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let x = 0;
  for (const id of order) {
    const cluster = clusters.find((c) => c.id === id)!;
    shiftCluster(cluster, byId, x - cluster.x!, -cluster.y!);
    x += cluster.width! + gutter;
  }
}

/**
 * Groups line up with each other, the same way their contents do. DESIGN 2.3.
 *
 * Two panels side by side with tops a few units apart, or a stack of panels
 * three different widths, is the row-and-column fault one level up. Sharing the
 * edge means the group boxes read as a grid rather than as three rectangles that
 * happen to be near each other.
 */
function shareClusterGrid(graph: Graph): void {
  const clusters = graph.clusters.filter((c) => c.x !== undefined && c.nodes.length);
  if (clusters.length < 2) return;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const groupBy = (
    lo: (c: GraphCluster) => number,
    hi: (c: GraphCluster) => number,
  ): GraphCluster[][] => {
    const out: GraphCluster[][] = [];
    for (const cluster of [...clusters].sort((a, b) => lo(a) - lo(b))) {
      const found = out.find((g) => g.some((o) => lo(cluster) < hi(o) && lo(o) < hi(cluster)));
      if (found) found.push(cluster);
      else out.push([cluster]);
    }
    return out;
  };

  // A row of groups: one top edge, so title bands line up. Each panel keeps
  // its own hugged height — DESIGN 2.6's bottom padding is the panel's own
  // children plus 24, never stretched to match a taller sibling.
  for (const row of groupBy((c) => c.y!, (c) => c.y! + c.height!)) {
    if (row.length < 2) continue;
    const top = onGrid(Math.min(...row.map((c) => c.y!)));
    for (const cluster of row) {
      shiftCluster(cluster, byId, 0, top - cluster.y!);
    }
  }
  // A column of groups: centred on the column's widest member, DESIGN 7.3 —
  // each panel keeps its own hugged width rather than being stretched to a
  // sibling's.
  for (const column of groupBy((c) => c.x!, (c) => c.x! + c.width!)) {
    if (column.length < 2) continue;
    const left = onGrid(Math.min(...column.map((c) => c.x!)));
    const width = Math.max(...column.map((c) => c.x! + c.width!)) - left;
    for (const cluster of column) {
      const inset = onGrid((width - cluster.width!) / 2);
      shiftCluster(cluster, byId, left + inset - cluster.x!, 0);
      cluster.x = left + inset;
    }
  }
}

/**
 * Every row of a composition shares one vertical axis. DESIGN 7.3.
 *
 * `shareClusterGrid` above lines panels up with their own cluster neighbours,
 * but a composition also has top-level nodes that are not panels at all — an
 * output node under a chain of panels, say — and those never enter that pass.
 * ELK sizes each row for its own contents and leaves it wherever that placement
 * landed; nothing so far has made a narrow row share a centre with a wide one,
 * so it reads as pushed aside rather than as the next step of the same story.
 *
 * A row is read as a rigid unit for the centring step below — every panel and
 * every free node whose vertical band overlaps it — but the gap *inside* a
 * row is fixed first (DESIGN 2.3): ELK placed a folded row's members by the
 * cluster sizes it was handed before `refit` (above) hugged each panel down
 * to its actual contents, so the interior gap is wherever the pre-shrink
 * boxes happened to leave it, not a real 32. Each row is repacked at that
 * gutter, in ELK's own left-to-right order, before the row is slid onto the
 * widest row's centre.
 *
 * An item stays where it is instead when it lines up (centre within 8) with
 * something in the row above or below — a tree's fan-out, a panel's aligned
 * inputs/outputs (2.6) — and the rest of the row is packed around it rather
 * than through it.
 *
 * Only charts built from panels are compositions in this sense (DESIGN 7.3
 * applies to those; a plain flowchart wrapped into rows of boxes is a chain
 * folded to fit the canvas, not a composition, and rule 1.2/1.4 already govern
 * it). So this is skipped whenever the chart has no clusters at all.
 */
function centreRows(graph: Graph): void {
  if (!graph.clusters.length) return;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const inside = new Set(graph.clusters.flatMap((c) => c.nodes));

  interface Item { cluster?: GraphCluster; node?: GraphNode; x0: number; x1: number; y0: number; y1: number }
  const items: Item[] = [];
  for (const c of graph.clusters) {
    if (c.x === undefined) continue;
    items.push({ cluster: c, x0: c.x, x1: c.x + c.width!, y0: c.y!, y1: c.y! + c.height! });
  }
  for (const n of graph.nodes) {
    if (n.x === undefined || inside.has(n.id)) continue;
    items.push({ node: n, x0: n.x, x1: n.x + n.width!, y0: n.y!, y1: n.y! + n.height! });
  }
  if (items.length < 2) return;

  interface Row { items: Item[]; top: number; bottom: number }
  const rows: Row[] = [];
  for (const it of [...items].sort((a, b) => a.y0 - b.y0)) {
    const row = rows.find((r) => it.y0 < r.bottom - 1 && it.y1 > r.top + 1);
    if (row) {
      row.items.push(it);
      row.top = Math.min(row.top, it.y0);
      row.bottom = Math.max(row.bottom, it.y1);
    } else {
      rows.push({ items: [it], top: it.y0, bottom: it.y1 });
    }
  }
  // "Above" and "below" (the packing exception just below) mean top to bottom,
  // not the order rows happened to be discovered in.
  rows.sort((a, b) => a.top - b.top);
  for (const row of rows) row.items.sort((a, b) => a.x0 - b.x0);

  const shift = (it: Item, dx: number) => {
    if (!dx) return;
    if (it.cluster) shiftCluster(it.cluster, byId, dx, 0);
    else if (it.node) it.node.x! += dx;
    it.x0 += dx;
    it.x1 += dx;
  };

  // DESIGN 2.3 allows 24 or 32; 32 is the gutter every panel-level pass already
  // uses (enforceClusterGutters, alignPanels), so a repacked row matches its
  // neighbours rather than introducing a third value.
  const gutter = 32;
  const centreOf = (it: Item) => (it.x0 + it.x1) / 2;
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri]!;
    if (row.items.length < 2) continue;
    const neighbours = [rows[ri - 1], rows[ri + 1]]
      .filter((r): r is Row => Boolean(r))
      .flatMap((r) => r.items);
    const aligned = (it: Item) => neighbours.some((o) => Math.abs(centreOf(o) - centreOf(it)) < 8);

    // The first aligned item anchors the row; anything left of it packs
    // backward from its fixed edge so order and gutter both hold.
    const anchor = row.items.findIndex((it) => aligned(it));
    if (anchor > 0) {
      let right = row.items[anchor]!.x0 - gutter;
      for (let k = anchor - 1; k >= 0; k--) {
        const w = row.items[k]!.x1 - row.items[k]!.x0;
        shift(row.items[k]!, right - w - row.items[k]!.x0);
        right -= w + gutter;
      }
    }
    // Everything from the anchor (or the row's own first item, if nothing in
    // it aligns with a neighbour) rightward packs forward at the gutter,
    // skipping — but not moving — any further aligned item it meets.
    let cursor = row.items[Math.max(anchor, 0)]!.x1;
    for (let i = Math.max(anchor, 0) + 1; i < row.items.length; i++) {
      const it = row.items[i]!;
      if (aligned(it)) { cursor = it.x1; continue; }
      const w = it.x1 - it.x0;
      const newX0 = cursor + gutter;
      shift(it, newX0 - it.x0);
      cursor = newX0 + w;
    }
  }

  if (rows.length < 2) return;

  const span = (row: Row) => {
    const left = Math.min(...row.items.map((i) => i.x0));
    const right = Math.max(...row.items.map((i) => i.x1));
    return { centre: (left + right) / 2, width: right - left };
  };
  const widest = rows.reduce((best, row) => (span(row).width > span(best).width ? row : best), rows[0]!);
  const target = span(widest).centre;

  for (const row of rows) {
    const dx = onGrid(target - span(row).centre);
    for (const it of row.items) shift(it, dx);
  }
}

/**
 * A sole child sits on its sole parent's centre line. DESIGN 2.3.
 *
 * `square`'s own grid pass (`band`, above) merges any two centres within 9
 * units of each other, which is how most rows and columns end up sharing an
 * exact line for free. It only misses a node with nothing on either side
 * close enough to band with — a fold that hands a row exactly one member
 * (`4geeks-journey.mmd`'s "Applies online", alone in row one, left at
 * whatever x the pre-fold LR layout gave it) or two nodes that are each
 * alone in their own row and so never get a neighbour to band against at all
 * (`messy.mmd`'s Start and its diamond). Run last, once every other pass has
 * settled, so nothing later pulls the pair apart again.
 *
 * Only a genuine chain link counts: the parent's one forward edge out, the
 * child's one forward edge in — a branch or a merge has real reasons to sit
 * off the line and is left alone (2.3 does not ask a diamond's two children
 * to share its centre). Between the two, the one with fewer edges elsewhere
 * in the graph moves — it has the least else riding on where it sits — onto
 * the centre line of the one with more; a tie moves the child, since it
 * reads as downstream of the parent the eye already followed to reach it.
 */
function alignSoleChildren(graph: Graph): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const forwardOut = new Map<string, number>();
  const forwardIn = new Map<string, number>();
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    if (e.backward || e.from === e.to) continue;
    forwardOut.set(e.from, (forwardOut.get(e.from) ?? 0) + 1);
    forwardIn.set(e.to, (forwardIn.get(e.to) ?? 0) + 1);
  }
  for (const edge of graph.edges) {
    if (edge.backward || edge.from === edge.to) continue;
    if (forwardOut.get(edge.from) !== 1 || forwardIn.get(edge.to) !== 1) continue;
    const parent = byId.get(edge.from);
    const child = byId.get(edge.to);
    if (!parent || !child) continue;
    if (parent.x === undefined || child.x === undefined) continue;

    const stackedTB = child.y! >= parent.y! + parent.height! - 1;
    const sideBySideLR = child.x! >= parent.x! + parent.width! - 1;
    if (!stackedTB && !sideBySideLR) continue;

    const parentCentre = stackedTB ? parent.x! + parent.width! / 2 : parent.y! + parent.height! / 2;
    const childCentre = stackedTB ? child.x! + child.width! / 2 : child.y! + child.height! / 2;
    const gap = Math.abs(parentCentre - childCentre);
    // Already aligned, or so far apart it reads as its own column rather
    // than a line that slipped — DESIGN 2.3's own tolerance either way.
    const limit = (stackedTB ? parent.width! + child.width! : parent.height! + child.height!) / 2;
    if (gap < 1.5 || gap >= limit) continue;

    // Landing on the other one's *exact* centre is the point — a diamond's
    // clearance (2.4) can leave its own centre off the 8-grid to begin with,
    // and rounding the mover back onto the grid here is exactly what
    // reopened the 1.5-unit gap this pass exists to close.
    const moveParent = (degree.get(edge.from) ?? 0) < (degree.get(edge.to) ?? 0);
    if (moveParent) {
      if (stackedTB) parent.x = childCentre - parent.width! / 2;
      else parent.y = childCentre - parent.height! / 2;
    } else {
      if (stackedTB) child.x = parentCentre - child.width! / 2;
      else child.y = parentCentre - child.height! / 2;
    }
  }
}
