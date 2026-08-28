import type { Graph, GraphNode } from '../graph.ts';

/**
 * DESIGN 1.5: leaf stacking.
 *
 * When a display cap makes the natural layout wider than the canvas, a node
 * whose children are all leaves collapses into a vertical stack under it —
 * one column, joined by a bus — instead of spreading them side by side. This
 * module finds the candidate fans and works out the geometry; `layout/
 * index.ts` decides how many to actually use and expands them back once ELK
 * has placed the stand-in.
 */

/** A node with two or more children, none of which have children of their
 *  own — DESIGN 1.5's fan. */
export interface Fan {
  parent: GraphNode;
  leaves: GraphNode[];
}

/**
 * DESIGN 1.5: leaves sit directly under the parent, indented this far off
 * its own left edge — not centred, so the fan costs only this much beyond
 * the shared box width, whatever that width is. 32, not the 24 that would
 * put the leaf's own left edge exactly 12 past the trunk: the trunk for a
 * lower leaf runs straight down past every leaf above it, and DESIGN 6.1/
 * 6.8 want 16 clear of a node it does not connect to — 12 does not clear
 * that, 32 (a gutter already used elsewhere, GUTTER.panel) clears it with
 * margin to spare.
 */
export const LEAF_INDENT = 32;
/** DESIGN 1.5: the hanging port the bus trunk leaves the parent from — off
 *  centre on purpose, so the trunk sits in the indent strip rather than
 *  through the parent's own body or the leaf column either. Allowed only
 *  for this pattern (DESIGN 6.2's ordinary midpoint attachment still holds
 *  everywhere else). */
export const TRUNK_OFFSET = 12;
/** Room below the parent before the first leaf. */
const FIRST_GAP = 24;
/** DESIGN 1.5: leaves stack 16 apart. */
export const LEAF_GAP = 16;

/**
 * Find every fan in the graph, widest (most leaves, then most combined
 * width) first — that order is what "stacking is applied to the widest fans
 * first" means: the fan that is costing the most width is the one worth
 * collapsing before a narrower one.
 *
 * Narrow on purpose, the same way `identifySatellites` is: a child counts
 * only with exactly one inbound edge (from this parent, forward, not a
 * retry) and no outbound edge of its own. A node already spoken for by a
 * cluster or a satellite pass is never a candidate, on either end.
 */
export function findFans(graph: Graph, excluded: Set<string>): Fan[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const kidsOf = new Map<string, string[]>();
  const inCount = new Map<string, number>();
  const outCount = new Map<string, number>();
  // A node either end of a retry touches is mid-cycle, not a dead end — the
  // same care `identifySatellites` takes ("a true dead end never has a
  // backward edge touching it at all"). Left unchecked, a "no" branch that
  // answers back into the flow (4geeks-journey's Mentor pairing, looping to
  // Portfolio projects) reads as a plain leaf here (no *forward* edge of its
  // own) and gets stacked as if it went nowhere.
  const cyclic = new Set<string>();
  for (const e of graph.edges) {
    if (e.backward) {
      cyclic.add(e.from);
      cyclic.add(e.to);
      continue;
    }
    if (e.from === e.to) continue;
    if (!kidsOf.get(e.from)?.includes(e.to)) {
      kidsOf.set(e.from, [...(kidsOf.get(e.from) ?? []), e.to]);
    }
    inCount.set(e.to, (inCount.get(e.to) ?? 0) + 1);
    outCount.set(e.from, (outCount.get(e.from) ?? 0) + 1);
  }
  const fans: Fan[] = [];
  for (const parent of graph.nodes) {
    if (excluded.has(parent.id) || cyclic.has(parent.id)) continue;
    const kidIds = kidsOf.get(parent.id) ?? [];
    if (kidIds.length < 2) continue;
    const leaves = kidIds.map((id) => byId.get(id)).filter((n): n is GraphNode => Boolean(n));
    const allLeaves = leaves.every(
      (n) =>
        !excluded.has(n.id) &&
        !cyclic.has(n.id) &&
        (outCount.get(n.id) ?? 0) === 0 &&
        inCount.get(n.id) === 1 &&
        n.width !== undefined &&
        n.height !== undefined,
    );
    if (!allLeaves || leaves.length !== kidIds.length) continue;
    if (parent.width === undefined || parent.height === undefined) continue;
    fans.push({ parent, leaves });
  }
  return fans.sort((a, b) => {
    if (b.leaves.length !== a.leaves.length) return b.leaves.length - a.leaves.length;
    const widthOf = (f: Fan) => f.leaves.reduce((s, n) => s + n.width!, 0);
    return widthOf(b) - widthOf(a);
  });
}

/** The stand-in ELK gives one fan, and where everything in it ends up once
 *  the stand-in's own (x, y) comes back from layout. */
export interface FanPlan extends Fan {
  /** Id substituted for `parent` and every leaf in ELK's own graph. */
  unitId: string;
  unitWidth: number;
  unitHeight: number;
  /** Leaf column's left edge and first row's top, relative to the unit. */
  leafLocalX: number;
  leafLocalY: number;
}

/**
 * Reserve exactly what gets drawn: the parent's own footprint plus a fixed
 * 24-unit indent for the leaf column below it — DESIGN 1.5's "fan width is
 * box width + 24", not a reservation that scales with the box's own width
 * (a 200-wide chart was paying for the parent's *half* width twice over,
 * which is what made a fan cost 332 instead of 224). The parent sits at the
 * unit's own origin, unmoved from where an unstacked layout would have put
 * a plain box.
 */
export function planFan(fan: Fan): FanPlan {
  const { parent, leaves } = fan;
  const leafWidth = Math.max(...leaves.map((n) => n.width!));
  const leafLocalX = LEAF_INDENT;
  const leafLocalY = parent.height! + FIRST_GAP;
  let y = leafLocalY;
  for (const leaf of leaves) y += leaf.height! + LEAF_GAP;
  return {
    parent,
    leaves,
    unitId: `fan:${parent.id}`,
    unitWidth: Math.max(parent.width!, leafLocalX + leafWidth),
    unitHeight: y - LEAF_GAP,
    leafLocalX,
    leafLocalY,
  };
}

/** Expand a placed stand-in back into the parent (unmoved, at the unit's own
 *  origin) and its leaves (stacked in a column, ascending, each indented
 *  DESIGN 1.5's 24 off the parent's own left edge). */
export function expandFan(plan: FanPlan, unitX: number, unitY: number): void {
  plan.parent.x = unitX;
  plan.parent.y = unitY;
  let y = unitY + plan.leafLocalY;
  for (const leaf of plan.leaves) {
    leaf.x = unitX + plan.leafLocalX;
    leaf.y = y;
    y += leaf.height! + LEAF_GAP;
  }
}
