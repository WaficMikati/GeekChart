import type { Graph, GraphNode } from '../graph.ts';
import { GUTTER } from '../tokens.ts';

/**
 * DESIGN 1.8: rings.
 *
 * A chain whose last node's only forward edge returns to its first is a
 * single simple cycle, and reads better as a rectangle than as whatever a
 * layered engine's own cycle-breaking happens to produce — ELK's
 * `DEPTH_FIRST` cycle-breaking picks one edge to reverse and lays the rest
 * out as an ordinary DAG, which for a short LR cycle folded every node into
 * reading-order rows (A B / C D) instead of the clockwise loop a person
 * would draw by hand, sending one edge the wrong way and another doubling
 * back through the middle. This module owns detection and placement;
 * `draw.ts` draws the edges directly from the final grid rather than
 * handing them to `route/plan.ts`'s general search, whose backward-edge
 * heuristics assume an arbitrary retry, not a ring's own deterministic
 * return edge.
 */

/**
 * Detect a graph that is nothing but one cycle covering every node — no
 * clusters, no extra edges, no node with more than one forward edge out.
 * Returns the cycle in traversal order starting from the graph's own first
 * node (so the ring reads in the order a writer typed the nodes), or null.
 */
export function detectRing(graph: Graph): string[] | null {
  if (graph.clusters.length > 0) return null;
  const n = graph.nodes.length;
  // A ring of 3 is just a triangle with nothing to fold; DESIGN 1.8 only
  // names 4 and 6, and a 2-row grid needs at least 2 nodes on each row.
  if (n < 4 || graph.edges.length !== n) return null;

  const next = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.from === edge.to) return null;
    if (next.has(edge.from)) return null; // more than one forward edge out
    next.set(edge.from, edge.to);
  }

  const start = graph.nodes[0]!.id;
  const order = [start];
  const seen = new Set([start]);
  let cur = start;
  for (let i = 1; i < n; i++) {
    const nxt = next.get(cur);
    if (!nxt || seen.has(nxt)) return null;
    order.push(nxt);
    seen.add(nxt);
    cur = nxt;
  }
  return next.get(cur) === start ? order : null;
}

/**
 * The width a ring of `n` nodes needs at box width `boxWidth`, for checking
 * whether it fits a declared display before committing to it (DESIGN 1.1).
 */
export function ringWidth(n: number, boxWidth: number, gutter: number = GUTTER.sibling): number {
  const cols = Math.ceil(n / 2);
  return cols * boxWidth + (cols - 1) * gutter;
}

export interface RingLayout {
  width: number;
  height: number;
}

/**
 * Place a detected ring's nodes on DESIGN 1.8's grid: the first half left→
 * right on the top row, the rest right→left on the bottom, columns aligned
 * to the top row's — a ring of 4 is a 2×2, of 6 a 3×3. Node widths/heights
 * must already be set (the ordinary sizing pass runs before this, same as
 * every other layout path); this only decides `x`/`y`.
 *
 * Every column shares the widest node assigned to it, and both rows share
 * one gutter — DESIGN 2.1/2.3. When the two rows are uneven (an odd-sized
 * ring), the bottom row is short at its own left end: the column count
 * always matches the wider (top) row, so a return edge from a short bottom
 * row's own last node bends once to reach column 0, which DESIGN 1.8 allows
 * ("one straight run or one bend").
 */
export function layoutRing(graph: Graph, order: string[], gutter: number = GUTTER.sibling): RingLayout {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const nodes = order.map((id) => byId.get(id)!);
  const n = nodes.length;
  const top = Math.ceil(n / 2);
  const bottom = n - top;
  const cols = top;

  const colOf: number[] = new Array(n);
  for (let i = 0; i < top; i++) colOf[i] = i;
  // The bottom row fills right→left, aligned to the top row's own rightmost
  // column first (DESIGN 1.8's "top-right corner down") — so a full (even)
  // ring's last bottom node always lands back at column 0, under the first
  // top node, for the "bottom-left corner up" return.
  for (let i = 0; i < bottom; i++) colOf[top + i] = cols - 1 - i;

  const colWidth: number[] = new Array(cols).fill(0);
  nodes.forEach((node: GraphNode, i) => {
    const c = colOf[i]!;
    colWidth[c] = Math.max(colWidth[c]!, node.width!);
  });
  const colX: number[] = [0];
  for (let c = 1; c < cols; c++) colX.push(colX[c - 1]! + colWidth[c - 1]! + gutter);

  const topHeight = Math.max(...nodes.slice(0, top).map((node) => node.height!));
  const bottomHeight = bottom ? Math.max(...nodes.slice(top).map((node) => node.height!)) : 0;
  const topY = 0;
  const bottomY = topHeight + gutter;

  nodes.forEach((node, i) => {
    const c = colOf[i]!;
    const row = i < top ? 0 : 1;
    node.x = colX[c]! + (colWidth[c]! - node.width!) / 2;
    node.y = row === 0 ? topY : bottomY;
  });

  return {
    width: colX[cols - 1]! + colWidth[cols - 1]!,
    height: bottom ? bottomY + bottomHeight : topHeight,
  };
}

export interface RingColumnLayout {
  width: number;
  height: number;
  /** Left edge of the return edge's own corridor, for `draw.ts`. */
  corridorX: number;
}

/**
 * DESIGN 1.8's own fallback: "on a display too narrow for two columns the
 * ring becomes a column with the return edge up a right corridor (the
 * loop-back rules, 6.7)." Used when `layoutRing`'s own grid cannot fit a
 * declared display even at the narrowest box size (DESIGN 2.2).
 *
 * The chain itself is nothing but straight vertical edges — `layoutRing`'s
 * own same-column case already draws those — so only the return edge
 * (`order[n-1]` back to `order[0]`) gets special handling: it is marked
 * separately (`edge.ringLoop`, read by `draw.ts`) rather than folded into
 * `layoutRing`'s own straight/one-bend cases, because it is the one ring
 * edge that is neither.
 */
export function layoutRingColumn(graph: Graph, order: string[], gutter: number = GUTTER.sibling): RingColumnLayout {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const nodes = order.map((id) => byId.get(id)!);
  const width = Math.max(...nodes.map((n) => n.width!));
  let y = 0;
  for (const node of nodes) {
    node.x = 0;
    node.y = y;
    y += node.height! + gutter;
  }
  // DESIGN 6.7: 24 clearance from the content the loop goes around.
  const corridorX = width + 24;
  return { width: corridorX + 24, height: y - gutter, corridorX };
}

/**
 * Greedy word-wrap into as many lines as it takes to fit `maxWidth`, each
 * line measured the same way DESIGN 6.5's own edge-label width already is
 * (`measure` takes the case the label actually renders in — upper, since
 * DESIGN 6.5's "8 mono caps" — and returns that line's width). Unlike
 * `wrapTitle` (measure.ts), which only ever splits a title into two lines,
 * this keeps splitting until every line fits, or gives up and returns the
 * whole text as one line if even a single word does not fit `maxWidth` on
 * its own — never a hard word-break mid-word.
 */
export function wrapLabelLines(
  text: string,
  measure: (line: string) => number,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.some((w) => measure(w) > maxWidth)) return [text];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && measure(next) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}
