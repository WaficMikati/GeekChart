import type { Graph } from '../graph.ts';
import type { ElkNode } from './elk.ts';
import { bandByCentre, chainWraps, longestPath } from './fold.ts';

/**
 * Dead-end branches off the primary path — DESIGN 1.2's "off the row" shape —
 * pulled out of the layered/wrapped computation and pinned under their
 * parent afterward instead, plus the orphan-column repair a folded chain can
 * need. DESIGN 1.2, 2.3, 6.1, 6.4, 6.6, 7.4.
 */

/**
 * Find the dead-end branches that should never enter the layered/wrapped
 * computation in the first place. DESIGN 1.2.
 *
 * A dead-end branch off the primary path — a single failure state hanging
 * off a happy-path chain, the shape DESIGN 1.2 calls out — reads as "off the
 * row" only if it never enters the layered/wrapped computation that lines
 * the row up in the first place. Left in, ELK's own layer assignment can
 * land it between two primary-path rows once a long LR chain has to wrap,
 * which is what regex-engine's `NO` state did: sharing its parent's column
 * but a layer of its own, it read as sitting *in* the chain rather than
 * beside it. So it is pulled out before layout and pinned under its parent
 * afterward instead — the same node, drawn in a place ELK never chose.
 *
 * Kept narrow on purpose: only a node with exactly one inbound edge from a
 * primary-path node, and at most one outbound edge, qualifies — and neither
 * edge may be a retry loop (DESIGN 6.6's dashed return). A "no" branch that
 * comes back to a decision (Prep course → Meets the prerequisites?) is a
 * cycle, not a stub, and pulling it out would strand the loop; a true
 * dead end never has a backward edge touching it at all.
 */
export function identifySatellites(
  graph: Graph,
  flow: 'horizontal' | 'vertical',
  claimed: Set<string>,
): { satelliteIds: Set<string>; soleParent: Map<string, string> } {
  const primaryIds = new Set(graph.primaryPath);
  const inCount = new Map<string, number>();
  const outCount = new Map<string, number>();
  const cyclic = new Set<string>();
  for (const e of graph.edges) {
    if (e.from === e.to) continue;
    inCount.set(e.to, (inCount.get(e.to) ?? 0) + 1);
    outCount.set(e.from, (outCount.get(e.from) ?? 0) + 1);
    if (e.backward) { cyclic.add(e.from); cyclic.add(e.to); }
  }
  const soleParent = new Map<string, string>();
  for (const e of graph.edges) {
    if (e.from === e.to) continue;
    if (inCount.get(e.to) === 1) soleParent.set(e.to, e.from);
  }
  const foldLikely = flow === 'horizontal' && longestPath(graph) > 6;
  const satelliteIds = new Set(
    foldLikely
      ? graph.nodes
          .filter((n) => {
            if (primaryIds.has(n.id) || claimed.has(n.id) || cyclic.has(n.id)) return false;
            const parent = soleParent.get(n.id);
            if (!parent || !primaryIds.has(parent)) return false;
            return (outCount.get(n.id) ?? 0) <= 1;
          })
          .map((n) => n.id)
      : [],
  );
  return { satelliteIds, soleParent };
}

/**
 * Pin each excluded satellite on a row's centre line of its own — never in
 * the gap between two (DESIGN 2.3: a node's band overlapping a row without
 * sharing its exact centre is the same fault as two rows failing to
 * align), and never sharing an existing row's column either. Slotting it
 * into the very next row (DT/TLD's, in regex-engine) reads fine for 2.3 on
 * its own, but that row sits one gap above the row its *own* outgoing edge
 * has to reach — the same gap a real chain edge (`TLD`→`OK`) already
 * crosses — so the two end up sharing a corridor no amount of relabelling
 * one edge's lane can clear without either drifting off its own channel's
 * true centre (DESIGN 6.1) or the two landing under 16 apart (6.4): a
 * dead end's own row and column are both free of the rest of the chart
 * instead, appended after the last row on the grid and past its far edge,
 * so every edge it touches crosses a gap nothing else uses.
 */
export function placeSatellites(
  graph: Graph,
  satelliteIds: Set<string>,
  soleParent: Map<string, string>,
): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const gutter = 32;
  const others0 = graph.nodes.filter((n) => n.x !== undefined && !satelliteIds.has(n.id));
  const rowCentres: number[] = [];
  for (const c of others0.map((n) => n.y! + n.height! / 2).sort((a, b) => a - b)) {
    if (rowCentres.length && c - rowCentres[rowCentres.length - 1]! <= 9) continue;
    rowCentres.push(c);
  }
  const pitch = rowCentres.length > 1 ? rowCentres[1]! - rowCentres[0]! : 0;

  for (const id of satelliteIds) {
    const node = byId.get(id);
    const parent = byId.get(soleParent.get(id)!);
    if (!node || !parent || parent.x === undefined) continue;
    const others = graph.nodes.filter((n) => n.id !== id && n.x !== undefined);
    const overlapsAt = (x: number, y: number) =>
      others.some((n) =>
        x < n.x! + n.width! && x + node.width! > n.x! &&
        y < n.y! + n.height! && y + node.height! > n.y!,
      );

    const parentCentre = parent.y! + parent.height! / 2;
    const lastRow = rowCentres[rowCentres.length - 1] ?? parentCentre;
    const y = lastRow + (pitch || (parent.height ?? 0) + gutter) - node.height! / 2;

    const rightEdge = others.length ? Math.max(...others.map((n) => n.x! + n.width!)) : parent.x!;
    const leftEdge = others.length ? Math.min(...others.map((n) => n.x!)) : parent.x!;
    // Past whichever edge of the grid the parent's own column already sits
    // on, not just the right one: nothing else has ever occupied the space
    // beyond the grid's own outer column, on either side, so extending past
    // the side the parent is already the extreme of keeps every row between
    // it and the satellite clear the whole way down. Extending the *other*
    // way instead — past the far edge when the parent sits at the near one —
    // is what used to put another column's whole run of nodes directly
    // between parent and satellite (regex-engine's `AT`, in the grid's own
    // first column, reaching right past the second column instead of left
    // past nothing at all).
    const pastLeft = leftEdge - gutter - node.width!;
    const pastRight = rightEdge + gutter;
    const preferLeft = Math.abs(parent.x! - leftEdge) < 0.5;
    const order = preferLeft ? [pastLeft, pastRight] : [pastRight, pastLeft];
    node.x = order.find((cx) => !overlapsAt(cx, y)) ?? order[0]!;
    node.y = y;
  }
}

/**
 * Pull a chain node that ends up alone in its column onto a nearby column —
 * an existing shared one, or another orphan close enough to pair with — never
 * moving one when the move would cost more than it's worth. DESIGN 7.4.
 *
 * A decision diamond's two outgoing edges shift its own rank position by a
 * dozen-odd units off where a plain box in the equivalent spot would land —
 * just past `gridUp`'s 9-unit banding tolerance, so nothing downstream ever
 * merges them even though the mismatch is a routing artefact, not a real
 * design difference. This applies the same "close enough to read as a line
 * that slipped, not its own column" reasoning `alignSoleChildren` already
 * uses for a single edge, but across the wrap.
 *
 * "Cost" is measured directly on the node's own edges rather than guessed at
 * from which ones happen to be loop-backs: every move is scored by how much
 * it stretches the Manhattan span of that node's edges, and among every
 * (orphan, target) pairing — not just each orphan's own nearest target — the
 * search always takes the cheapest one first. That is what finds "move
 * Portfolio 11 units onto the decision diamond's column" over "move the
 * diamond itself 300 units to reach Portfolio's neighbours", the same 11-unit
 * gap looked at from the other node. A move never taken at all when nothing
 * safe stays under budget is a smaller fault than a stretched loop-back or a
 * detour dragged across the whole diagram — `foldQuality` still marks that
 * candidate as failing, so a cleaner one wins the search instead.
 */
export function snapOrphanColumns(children: ElkNode[], chain: string[], edges: { from: string; to: string }[]): void {
  const inner = chain.slice(1, -1);
  if (inner.length < 2) return;
  const byId = new Map(children.map((n) => [n.id, n] as const));
  if (!chain.every((id) => byId.has(id))) return;
  if (!chainWraps(byId, chain)) return;

  const withXY = children.filter(
    (n) => n.x !== undefined && n.y !== undefined && n.width !== undefined && n.height !== undefined,
  );
  const cx = (n: ElkNode) => n.x! + n.width! / 2;
  const cy = (n: ElkNode) => n.y! + n.height! / 2;
  const innerSet = new Set(inner);
  const overlaps = (a: ElkNode, b: ElkNode) =>
    a.x! < b.x! + b.width! && a.x! + a.width! > b.x! && a.y! < b.y! + b.height! && a.y! + a.height! > b.y!;
  // A move this cheap reads as the line having merely slipped a rounding
  // error; past it, it is spending someone else's edge budget to buy this
  // node a column, which `foldQuality` failing on the result is honest about
  // and leaves for a cleaner candidate to win instead.
  const budget = 48;

  interface Move { node: ElkNode; x: number; cost: number }
  const cheapestMove = (): Move | null => {
    const groups = bandByCentre(withXY, cx);
    const orphans = groups.filter((g) => g.length === 1 && innerSet.has(g[0]!.id)).map((g) => g[0]!);
    let best: Move | null = null;
    for (const node of orphans) {
      const own = groups.find((g) => g[0] === node)!;
      const targets = groups.filter((g) => g !== own).map((g) => g.reduce((sum, n) => sum + cx(n), 0) / g.length);
      for (const groupCx of targets) {
        // Landing exactly on the target's mean is more than the merge needs —
        // gridUp only requires being within its own 9-unit gap tolerance, so
        // the node moves only as far as the near edge of that window, the
        // smallest move that still bands with it.
        const targetCx = Math.max(groupCx - 8, Math.min(groupCx + 8, cx(node)));
        const x = targetCx - node.width! / 2;
        const trial: ElkNode = { ...node, x };
        if (withXY.some((other) => other !== node && overlaps(trial, other))) continue;
        const cost = edges.reduce((sum, e) => {
          if (e.from !== node.id && e.to !== node.id) return sum;
          const other = byId.get(e.from === node.id ? e.to : e.from);
          if (!other || other.x === undefined) return sum;
          const before = Math.abs(cx(node) - cx(other)) + Math.abs(cy(node) - cy(other));
          const after = Math.abs(targetCx - cx(other)) + Math.abs(cy(node) - cy(other));
          return sum + Math.max(0, after - before);
        }, 0);
        if (!best || cost < best.cost) best = { node, x, cost };
      }
    }
    return best;
  };

  // Cheapest move first, across every remaining orphan, not just each one's
  // own nearest target — a later, now-cheaper move can beat an earlier one
  // once an earlier merge has changed the columns on offer.
  for (let guard = 0; guard < inner.length; guard++) {
    const move = cheapestMove();
    if (!move || move.cost > budget) break;
    move.node.x = move.x;
  }
}
