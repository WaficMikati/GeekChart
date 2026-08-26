import type { Graph, GraphCluster, GraphNode } from '../graph.ts';
import type { Scene } from '../scene.ts';
import {
  alignPanels,
  enforceClusterGutters,
  refitClusters,
  shareClusterGrid,
  shiftCluster,
  spreadClusters,
} from './panels.ts';
import { onGrid } from './shared.ts';

/**
 * Putting the placed layout onto the shared grid: row/column banding, a
 * composition's rows sharing one axis, and a sole child sitting on its sole
 * parent's centre line. DESIGN 2.1, 2.3, 2.6, 7.3.
 */

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
export function square(graph: Graph, scene: Scene): void {
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
      r.some((o) => node.y! < o.y! + o.height! && o.y! < node.y! + node.height!),
    );
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
    band(
      placed,
      (n) => n.y! + n.height! / 2,
      (n, to) => {
        n.y = to - n.height! / 2;
      },
    );
    band(
      placed,
      (n) => n.x! + n.width! / 2,
      (n, to) => {
        n.x = to - n.width! / 2;
      },
    );
  };
  gridUp();

  alignPanels(graph, scene);

  // A cluster is whatever its members now occupy, plus its padding and the room
  // its heading needs. Refitting is what keeps a member from hanging out of its
  // own group after the grid moved it.
  refitClusters(graph, scene);

  // The grid pass above bands every node's centre by proximity across the
  // *whole* diagram, which can pull a cluster's own rows a few units off
  // whatever gap ELK gave them inside the panel — enough, once an arrowhead's
  // reach is subtracted from it, to land under the 16-unit rendered floor.
  // DESIGN 2.6 says a panel's children obey 2.3's 24/32 gutter regardless, so
  // it is enforced directly here rather than left to survive the rounding.
  enforceClusterGutters(graph);
  refitClusters(graph, scene);

  spreadClusters(graph, scene);
  // Moving whole groups puts their contents into new rows and columns with each
  // other, so the grid is read again now that they are neighbours.
  gridUp();
  refitClusters(graph, scene);
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
    for (const n of placed) {
      n.x! -= dx;
      n.y! -= dy;
    }
    for (const c of graph.clusters) {
      if (c.x === undefined) continue;
      c.x -= dx;
      c.y! -= dy;
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

  interface Item {
    cluster?: GraphCluster;
    node?: GraphNode;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
  }
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

  interface Row {
    items: Item[];
    top: number;
    bottom: number;
  }
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
      if (aligned(it)) {
        cursor = it.x1;
        continue;
      }
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
  const widest = rows.reduce(
    (best, row) => (span(row).width > span(best).width ? row : best),
    rows[0]!,
  );
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
