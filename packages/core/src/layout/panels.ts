import type { Graph, GraphCluster, GraphNode } from '../graph.ts';
import { clusterHeadroom, type Scene } from '../scene.ts';
import { onGrid } from './shared.ts';

/**
 * Panel-level layout: gutters between stacked siblings, aligning a panel's
 * inputs/outputs, refitting a panel around what it holds, and spreading or
 * gridding whole groups of panels. DESIGN 1.2, 1.4, 2.3, 2.6, 7.3.
 */

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
export function enforceClusterGutters(graph: Graph): void {
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
export function alignPanels(graph: Graph, scene: Scene): void {
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

/**
 * A cluster is whatever its members now occupy, plus its padding and the room
 * its heading needs. Refitting is what keeps a member from hanging out of its
 * own group after the grid moved it. DESIGN 2.6.
 */
export function refitClusters(graph: Graph, scene: Scene): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // Same adjustment as the forward placement above — this recovers a cluster's
  // top edge from where its members actually ended up, so it has to use the
  // same content-start offset that put them there in the first place.
  const headroom = clusterHeadroom(scene) + scene.clusterPad * 0.5;
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
}

/** Move a cluster and everything in it. */
export function shiftCluster(cluster: GraphCluster, byId: Map<string, GraphNode>, dx: number, dy: number): void {
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
export function spreadClusters(graph: Graph, scene: Scene): void {
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
export function shareClusterGrid(graph: Graph): void {
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
