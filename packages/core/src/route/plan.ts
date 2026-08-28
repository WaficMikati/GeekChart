import { squareOff, tidyOrtho, type Point, type Shape } from '../geometry.ts';
import { CLEARANCE } from '../tokens.ts';
import {
  NORMALS,
  faceMiddle,
  isVertical,
  type Extent,
  type Obstacle,
  type Side,
} from './shared.ts';
import { alignEnds, facesFor, faceRange, portOn, sideToward } from './ports.ts';
import { contact, curve, isBoxy, elbows } from './elbows.ts';
import { corridorGaps, detours, loopSide, marginShortfall, selfLoop } from './loops.ts';
import {
  crossingCost,
  intrusion,
  pathLength,
  selfPierce,
  sharedRunCost,
  tightCornerCost,
  type PlacedSeg,
} from './cost.ts';

/**
 * The two edge routers, and the orchestration that runs each edge's search
 * and reconciles the results across a whole chart. `routeEdges` is the older
 * chord router (curve port-to-port), kept for the mermaid fallback path.
 * `planRoutes` is DESIGN 6.1's orthogonal router for a chart this renderer
 * lays out itself: it knows where every box is, so every edge is a run of
 * horizontal and vertical segments with the corners rounded, never a
 * diagonal across another node. DESIGN 6.2 fixes each end at a face's
 * midpoint; DESIGN 6.4 keeps edges 16 apart or merged into one bus; DESIGN
 * 6.7 sends a loop-back around the content on its own nearest corridor.
 */

export interface EdgeEnds {
  path: SVGPathElement;
  from: SVGElement;
  to: SVGElement;
  fromShape: Shape;
  toShape: Shape;
}

export function routeEdges(
  edges: EdgeEnds[],
  flow: 'horizontal' | 'vertical',
  gap: number,
  toLocal: (path: SVGPathElement, p: Point) => Point,
): void {
  interface Assignment {
    edge: EdgeEnds;
    startSide: Side;
    endSide: Side;
    startOffset: number;
    endOffset: number;
  }

  const assignments: Assignment[] = edges.map((edge) => ({
    edge,
    startSide: sideToward(edge.fromShape, edge.toShape, flow),
    endSide: sideToward(edge.toShape, edge.fromShape, flow),
    startOffset: 0,
    endOffset: 0,
  }));

  // Group by the face each end lands on, then spread the ports across it.
  const buckets = new Map<
    string,
    { assignment: Assignment; end: 'start' | 'end'; sort: number }[]
  >();
  for (const assignment of assignments) {
    if (assignment.edge.from === assignment.edge.to) continue;
    const key = (node: SVGElement, side: Side) => `${node.getAttribute('id') ?? 'n'}:${side}`;

    const startKey = key(assignment.edge.from, assignment.startSide);
    const startCross =
      assignment.startSide === 'left' || assignment.startSide === 'right'
        ? assignment.edge.toShape.centre.y
        : assignment.edge.toShape.centre.x;
    buckets.set(startKey, [
      ...(buckets.get(startKey) ?? []),
      { assignment, end: 'start', sort: startCross },
    ]);

    const endKey = key(assignment.edge.to, assignment.endSide);
    const endCross =
      assignment.endSide === 'left' || assignment.endSide === 'right'
        ? assignment.edge.fromShape.centre.y
        : assignment.edge.fromShape.centre.x;
    buckets.set(endKey, [
      ...(buckets.get(endKey) ?? []),
      { assignment, end: 'end', sort: endCross },
    ]);
  }

  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => a.sort - b.sort);
    const step = Math.min(0.34, 0.68 / (members.length - 1));
    const first = -(step * (members.length - 1)) / 2;
    members.forEach((member, i) => {
      const offset = first + step * i;
      if (member.end === 'start') member.assignment.startOffset = offset;
      else member.assignment.endOffset = offset;
    });
  }

  for (const assignment of assignments) {
    const { edge, startSide, endSide, startOffset, endOffset } = assignment;
    const d =
      edge.from === edge.to
        ? selfLoop(edge.fromShape, startSide, gap)
        : curve(
            portOn(edge.fromShape, startSide, startOffset),
            startSide,
            portOn(edge.toShape, endSide, endOffset),
            endSide,
            gap,
          );

    // The path lives in its own group's coordinates; the ports were computed in
    // the root's.
    const local = d.replace(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g, (_, x: string, y: string) => {
      const p = toLocal(edge.path, { x: Number(x), y: Number(y) });
      return `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
    });
    edge.path.setAttribute('d', local);
  }
}

/* ------------------------------------------------------------------------- *
 * Orthogonal routing. DESIGN 6.1, 6.2, 6.4, 6.7.
 *
 * The chord router above is kept for the mermaid fallback path, where the
 * geometry is somebody else's and a curve is the only honest thing to draw. A
 * chart this renderer lays out itself has no excuse for a diagonal: it knows
 * where every box is, so every edge is a run of horizontal and vertical
 * segments with the corners rounded, and every arrowhead is exactly on an axis.
 * ------------------------------------------------------------------------- */

/** A finished route: where it runs, and which face it leaves and enters. */
export interface OrthoRoute {
  points: Point[];
  startSide: Side;
  endSide: Side;
}

/** How far a route runs straight out of a face before it is allowed to turn. */
const STUB = 24;
/** Clearance a loop keeps from the content it goes around. DESIGN 6.7. */
const LOOP_CLEAR = CLEARANCE.loop;

interface Pending<T> {
  edge: T;
  startSide: Side;
  endSide: Side;
  startAlong: number;
  endAlong: number;
  /** Set when the two contacts share a coordinate and the run is one straight line. */
  channel: boolean;
  loop: boolean;
}

/**
 * Plan every edge at once.
 *
 * Done together rather than one at a time because separating two edges that
 * share a face is only possible when both are known. DESIGN 6.4: they fan from
 * separate points, 8 apart, and never stack on one.
 */
export function planRoutes<T extends { id: string; from: string; to: string; backward?: boolean }>(
  edges: T[],
  boxOf: (id: string) => Extent | undefined,
  shapeOf: (id: string) => Shape | undefined,
  flow: 'horizontal' | 'vertical',
  content: Extent,
  obstacles: Obstacle[] = [],
): Map<string, OrthoRoute> {
  const pending: Pending<T>[] = [];
  // Every node's own box, keyed once — the backward branch below needs "every
  // other node" (not just every edge's *from*, which drops a leaf that is
  // only ever a *to*, and double-counts a node with several outgoing edges).
  const nodeIds = new Set<string>();
  for (const edge of edges) {
    nodeIds.add(edge.from);
    nodeIds.add(edge.to);
  }
  const nodeCentres = new Map<string, Point>();
  for (const id of nodeIds) {
    const box = boxOf(id);
    if (box) nodeCentres.set(id, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }
  // Which sides each node already spends on a straight edge — same reasoning
  // as planPorts's usedSides: a tied loop shouldn't land on the side a
  // straight edge already leaves, which is what sent a retry out on top of
  // the edge it answers instead of the empty side beside it.
  const usedSides = new Map<string, Set<Side>>();
  const markUsed = (id: string, side: Side) => {
    const set = usedSides.get(id) ?? new Set<Side>();
    set.add(side);
    usedSides.set(id, set);
  };

  // The face each node's first forward in-edge arrives on. DESIGN 6.2: a
  // loop-back reads as "you are back at this step", so it has to land on the
  // same face the normal way in already uses — never wherever the corridor
  // search finds the clearest lane, which is what put a retry into a
  // target's side while every forward arrow into it lands on top. Read from
  // `facesFor`, the same geometry a forward edge's own faces come from, so a
  // node a fold wrapped onto a face other than the chart's default (an
  // "along" arrival lands on top even in an LR chart, once a wrap stacks two
  // rows) is picked up here too.
  const flowInSide = new Map<string, Side>();
  for (const edge of edges) {
    if (edge.backward || edge.from === edge.to || flowInSide.has(edge.to)) continue;
    const a = boxOf(edge.from);
    const b = boxOf(edge.to);
    if (!a || !b) continue;
    flowInSide.set(edge.to, facesFor(a, b, flow).end);
  }
  const defaultFlowIn: Side = flow === 'vertical' ? 'top' : 'left';

  for (const edge of edges) {
    const a = boxOf(edge.from);
    const b = boxOf(edge.to);
    if (!a || !b) continue;
    if (edge.from === edge.to) {
      pending.push({
        edge,
        startSide: 'top',
        endSide: 'top',
        startAlong: a.x + a.width * 0.34,
        endAlong: a.x + a.width * 0.66,
        channel: false,
        loop: true,
      });
      continue;
    }
    if (edge.backward) {
      const others = [...nodeCentres.entries()]
        .filter(([id]) => id !== edge.from && id !== edge.to)
        .map(([, c]) => c);
      const fromShape = { centre: nodeCentres.get(edge.from)!, at: () => 0 };
      const toShape = { centre: nodeCentres.get(edge.to)!, at: () => 0 };
      // The arriving side is fixed first — DESIGN 6.2 pins it to the
      // target's own flow-in face, so the retry reads as returning to the
      // same step rather than sneaking in a different door.
      const endSideChoice = flowInSide.get(edge.to) ?? defaultFlowIn;
      // The exit side comes from the corridor: which side is clearer of
      // everything between the two ends (DESIGN 6.7's "around"). It has to
      // pick from the axis *perpendicular* to the arriving face, not the
      // chart's own flow axis — a lane that shares the arriving face's axis
      // can only be reached by doubling the stub back on itself (a fold can
      // land a target's flow-in face across the flow, on the same axis the
      // corridor search would otherwise use, which is exactly what sent
      // `4geeks-journey.mmd`'s Prep-course retry the long way round with a
      // hook at the far end instead of one clean turn).
      //
      // This is only a starting guess, not the final word: when the
      // perpendicular swing has to cross a whole extra row to get back to a
      // horizontal-facing arrival — `4geeks-journey.mmd`'s Mentor pairing →
      // Portfolio projects, arriving on Portfolio's left with a full row of
      // other boxes between them — the corridor it finds cuts back through
      // its own box (DESIGN 6.2) rather than actually going around. The
      // self-pierce check on every candidate route, below, catches that and
      // sends this same edge through the full every-side search a few lines
      // down, which is what actually lands it on the matching left face and
      // a real, straight corridor.
      const startSideChoice = loopSide(
        fromShape,
        toShape,
        others,
        isVertical(endSideChoice) ? 'vertical' : 'horizontal',
        usedSides.get(edge.from),
        usedSides.get(edge.to),
      );
      pending.push({
        edge,
        startSide: startSideChoice,
        endSide: endSideChoice,
        startAlong: faceMiddle(a, startSideChoice),
        endAlong: faceMiddle(b, endSideChoice),
        channel: false,
        loop: true,
      });
      markUsed(edge.from, startSideChoice);
      markUsed(edge.to, endSideChoice);
      continue;
    }
    const { start, end } = facesFor(a, b, flow);
    const sharpA = !isBoxy(shapeOf(edge.from)!, a);
    const sharpB = !isBoxy(shapeOf(edge.to)!, b);
    const placed = alignEnds(a, start, sharpA, b, end, sharpB);
    pending.push({ edge, startSide: start, endSide: end, ...placed, loop: false });
    markUsed(edge.from, start);
    markUsed(edge.to, end);
  }

  // Fan the ends that would otherwise land on the same point. A straight channel
  // keeps its coordinate — moving it aside would bend a straight run for nothing,
  // and two channels on one face already differ because their columns do.
  //
  // An arriving edge and a departing edge that both use the same face — one
  // edge ending at a node's top, a different edge leaving from that same top —
  // share the bucket too, not just two edges that both start or both end
  // there. Keeping them in separate buckets (start vs end) let two unrelated
  // edges plant a contact point at the exact same face-middle coordinate and
  // then run collinear for a stretch right at the node, which is DESIGN 6.4's
  // "never converging on one pixel" whether the edges are going the same way
  // or not (`state.mmd`'s Running→Graduated arrival and Graduated→root_end
  // departure, both dead centre on Graduated's top face).
  interface Member {
    item: Pending<T>;
    end: boolean;
  }
  const buckets = new Map<string, Member[]>();
  const key = (node: string, side: Side) => `${node}:${side}`;
  for (const item of pending) {
    if (item.loop) continue;
    if (!item.channel) {
      const k = key(item.edge.from, item.startSide);
      buckets.set(k, [...(buckets.get(k) ?? []), { item, end: false }]);
    }
    if (!item.channel) {
      const k = key(item.edge.to, item.endSide);
      buckets.set(k, [...(buckets.get(k) ?? []), { item, end: true }]);
    }
  }
  for (const [k, members] of buckets) {
    if (members.length < 2) continue;
    const nodeId = k.slice(0, k.lastIndexOf(':'));
    const box = boxOf(nodeId);
    if (!box) continue;
    const side = members[0]!.end ? members[0]!.item.endSide : members[0]!.item.startSide;
    const shape = shapeOf(nodeId);
    const [lo, hi] = faceRange(box, side, shape ? !isBoxy(shape, box) : false);
    // DESIGN 6.3: several edges arriving on the same side merge into one
    // trunk with a single arrowhead at the side's centre — the fan-in
    // mirror of the departing bus below. A bucket that is nothing *but*
    // arrivals (no edge also leaves this face) converges instead of
    // spreading; draw.ts gives every arriving edge but one no head.
    if (members.every((m) => m.end)) {
      const middle = faceMiddle(box, side);
      for (const m of members) m.item.endAlong = middle;
      continue;
    }
    // Sorted by where the far end sits, so the lines fan out without crossing.
    const far = (m: Member) => {
      const other = boxOf(m.end ? m.item.edge.from : m.item.edge.to);
      return other ? faceMiddle(other, side) : 0;
    };
    const order = [...members].sort((p, q) => far(p) - far(q));
    // One edge to a whole row of siblings reads as a bus, and a bus wants a
    // single trunk. It only becomes a fan when the ends would otherwise be
    // indistinguishable, which is when the far ends are on the same side.
    const step = 8;
    const width = step * (order.length - 1);
    const middle = faceMiddle(box, side);
    let first = middle - width / 2;
    if (first < lo) first = lo;
    if (first + width > hi) first = Math.max(lo, hi - width);
    order.forEach((m, i) => {
      const at = first + step * i;
      if (m.end) m.item.endAlong = at;
      else m.item.startAlong = at;
    });
  }

  // What each edge actually settled on, kept apart from `routes` until every
  // edge has one: a face fought over by two edges (see below) can only be
  // told apart once both sides of the fight are known.
  interface Resolved {
    edgeId: string;
    item: Pending<T>;
    ss: Side;
    es: Side;
    sAlong: number;
    eAlong: number;
    mustGoRound: boolean;
    points: Point[];
    rebuild: (sAlong: number, eAlong: number) => Point[];
  }
  const resolved: Resolved[] = [];
  let lane = 0;
  // How many edges already landed on a given node's face, filled in as edges
  // resolve. An edge arriving at a node and a later, unrelated edge leaving
  // from the same face read as one line for a stretch right at the node —
  // `state.mmd`'s Graduated→root_end retry, pushed onto Graduated's top face
  // by the alternate-pair search below because that face was clear of boxes,
  // lands squarely on top of Running→Graduated's own arrival there and of
  // its label. A face already spending itself on a straight edge is charged
  // for here so a search only lands a second edge on it when every quieter
  // face is genuinely worse, the same reasoning `loopSide`'s tie-break uses.
  const faceLoad = new Map<string, number>();
  const loadKey = (node: string, side: Side) => `${node}:${side}`;
  // Every forward edge's final segments, committed in the order below — see
  // `crossingCost` and `sharedRunCost`.
  const placedForwardSegs: PlacedSeg[] = [];
  // Shortest chord first. A short hop between neighbouring nodes has almost
  // no room to go anywhere else, so it gets first claim on its lane; a long
  // edge that reaches far across the diagram (a branch to an outlying node,
  // `regex-engine.mmd`'s AT→NO) has many more ways to get there and is the
  // one that should bend around everything already placed, not the other
  // way round. Placing it first — source order did this, since NO's branch
  // happened to come before the next chain link in the mermaid text — is
  // what left the short DM→DT hop with nowhere clear to cross it.
  const chordLen = (item: Pending<T>): number => {
    const ac = nodeCentres.get(item.edge.from);
    const bc = nodeCentres.get(item.edge.to);
    if (!ac || !bc) return 0;
    return Math.hypot(bc.x - ac.x, bc.y - ac.y);
  };
  const order = [...pending].sort((p, q) => chordLen(p) - chordLen(q));
  for (const item of order) {
    const a = boxOf(item.edge.from)!;
    const b = boxOf(item.edge.to)!;
    const fromShape = shapeOf(item.edge.from);
    const toShape = shapeOf(item.edge.to);
    if (!fromShape || !toShape) continue;
    // Frozen now, not read live: `build` (and the `rebuild` closure the fan
    // pass calls after every edge — loop or not — has resolved) must see the
    // lane this edge was actually given, not however far the shared counter
    // has moved on by the time something calls back into it. A second loop
    // elsewhere in the chart advancing `lane` between this edge's own
    // resolution and its later rebuild used to hand it a wider clearance on
    // rebuild than the search ever scored, silently swapping in whichever
    // corridor happened to be zero-cost at that different width.
    const myLane = lane;
    // `rebuild` below calls back into this edge's own search after every
    // edge has resolved, for the fan pass to nudge its along-position. By
    // then `placedForwardSegs` holds edges this one was never compared
    // against the first time (chord order, not source order) — without this
    // boundary, that replay could cross an edge processed *after* it and
    // silently pick a different, worse route than the one just chosen
    // (`regex-engine.mmd`'s TLD→OK: resolved clean, then re-picked a 4-bend
    // detour on rebuild once AT→NO's later segments joined the list).
    const placedBeforeThisEdge = placedForwardSegs.length;

    const sharpA = !isBoxy(fromShape, a);
    const sharpB = !isBoxy(toShape, b);
    const [al, ah] = faceRange(a, item.startSide, sharpA);
    const [bl, bh] = faceRange(b, item.endSide, sharpB);
    const startAlong = Math.max(al, Math.min(ah, item.startAlong));
    const endAlong = Math.max(bl, Math.min(bh, item.endAlong));

    const start = contact(fromShape, a, item.startSide, startAlong);
    const end = contact(toShape, b, item.endSide, endAlong);
    // The straight run out of a face is capped by how much room there actually
    // is. Two boxes 20 apart cannot both push 24 clear of themselves — the
    // stubs cross, the route reads as doubling back, and it used to be sent all
    // the way around the diagram to join two neighbours.
    //
    // Only faces that point at each other can collide, though. Two ends leaving
    // the *same* way — the top of one box and the top of another, which is what
    // a loop back is — have no shared gap to run out of, and capping them there
    // left a retry leaving its box by five units and turning immediately.
    const reach = (n: Point, other: Point, from: Point, to: Point) => {
      if (n.x * other.x + n.y * other.y >= 0) return STUB;
      const room = (to.x - from.x) * n.x + (to.y - from.y) * n.y;
      return Math.max(4, Math.min(STUB, room > 0 ? room * 0.45 : STUB));
    };

    // Every drawn box, own endpoints included — what DESIGN 6.1's channel
    // centring measures against (see `elbows`'s `channelMid`). Unlike
    // `blockers` below, the edge's own ends and their panels stay in: a
    // panel usually reaches out past the node it holds, so it is often the
    // nearer wall, and an endpoint's own box never wins the nearest-wall
    // search over a wall that is actually closer to the gap.
    const wallBoxes = obstacles.map((o) => o.box);

    // Nothing an edge does not connect to may sit on its route. A cluster
    // holding either end is not an obstacle — the edge is meant to be inside it.
    const blockers = obstacles
      .filter(
        (o) =>
          o.id !== item.edge.from &&
          o.id !== item.edge.to &&
          !o.holds?.includes(item.edge.from) &&
          !o.holds?.includes(item.edge.to),
      )
      .map((o) => o.box);

    // Where a detour actually needs to swing out to. A retry has to clear the
    // whole diagram — that is the loop DESIGN 6.7 describes. An ordinary edge
    // that only lost to one box in its way does not: going all the way to the
    // canvas edge to dodge a single neighbour is the "nonsensical" loop this
    // used to draw for any blocked edge, loop or not, because both shared the
    // same full-content lanes. The bounds here are the smallest box that still
    // contains both ends and whatever is actually between them, so a local
    // dodge stays local.
    const detourBounds: Extent = item.loop
      ? content
      : (() => {
          const pad = 40;
          const x0 = Math.min(a.x, b.x) - pad;
          const y0 = Math.min(a.y, b.y) - pad;
          const x1 = Math.max(a.x + a.width, b.x + b.width) + pad;
          const y1 = Math.max(a.y + a.height, b.y + b.height) + pad;
          const nearby = blockers.filter(
            (box) => box.x < x1 && box.x + box.width > x0 && box.y < y1 && box.y + box.height > y0,
          );
          const boxes = [a, b, ...nearby];
          return {
            x: Math.min(...boxes.map((box) => box.x)),
            y: Math.min(...boxes.map((box) => box.y)),
            width:
              Math.max(...boxes.map((box) => box.x + box.width)) -
              Math.min(...boxes.map((box) => box.x)),
            height:
              Math.max(...boxes.map((box) => box.y + box.height)) -
              Math.min(...boxes.map((box) => box.y)),
          };
        })();

    // Build the route the chosen faces give, then — only if something is in the
    // way — see whether another pair of faces gets there cleanly. Changing a
    // face is charged for, so a route only leaves the side it should leave from
    // when the alternative genuinely clears a box the first one ran through.
    const build = (
      ss: Side,
      es: Side,
      sAlong: number,
      eAlong: number,
      mustGoRound: boolean,
    ): { points: Point[]; cost: number } | null => {
      const s0 = contact(fromShape, a, ss, sAlong);
      const e0 = contact(toShape, b, es, eAlong);
      const nA = NORMALS[ss];
      const nB = NORMALS[es];
      const rA = reach(nA, nB, s0, e0);
      const rB = reach(nB, nA, e0, s0);
      const pp = { x: s0.x + nA.x * rA, y: s0.y + nA.y * rA };
      const qq = { x: e0.x + nB.x * rB, y: e0.y + nB.y * rB };
      // DESIGN 6.7: a loop-back takes the nearest corridor, not just any
      // clean one — gate.mjs's own `longLoops` caps it at the Manhattan
      // distance between the two contacts plus 128. Charged here too, not
      // just measured after the fact, so a side pair that is only clean by
      // going the long way round never beats a shorter pair that has to
      // pay a little intrusion or a mismatch charge instead.
      const loopBudget = item.loop ? Math.abs(e0.x - s0.x) + Math.abs(e0.y - s0.y) + 128 : Infinity;
      let best: { points: Point[]; cost: number; len?: number } | null = null;
      // A loop-back used to skip this entirely — going round was rare enough
      // that it never ran into an earlier forward edge's own stub. A nearer
      // corridor (`corridorGaps`, DESIGN 6.7) sits much closer to the nodes
      // it passes, so it now has to clear the same forward-edge segments any
      // other route does (`flow.mmd`'s D→B retry, which used to cut back
      // through B→C and B→D's own departing stubs at y=48).
      const crossPenalty = (pts: Point[]) => {
        const earlier = placedForwardSegs.slice(0, placedBeforeThisEdge);
        return crossingCost(pts, earlier) + sharedRunCost(pts, earlier);
      };
      if (!mustGoRound) {
        for (const mid of elbows(pp, nA, qq, nB, wallBoxes)) {
          const candidate = [s0, pp, ...mid, qq, e0];
          const cost =
            intrusion(candidate, blockers) +
            crossPenalty(candidate) +
            selfPierce(candidate, [a, b]) * 2000;
          if (!best || cost < best.cost) best = { points: candidate, cost };
          if (cost === 0) break;
        }
        if (best?.cost === 0) return best;
      }
      // Going the long way is a real cost even when it is clean, so it is
      // charged for and only wins when the direct route is genuinely blocked.
      const clear = item.loop ? LOOP_CLEAR + myLane * 16 : LOOP_CLEAR;
      // A loop-back doesn't have to run all the way to the canvas margin —
      // the gap between the row it leaves and the row above it is usually a
      // clean corridor on its own, and far shorter. Offered alongside the
      // margin lanes below; the cost search picks by resulting path length,
      // not by which lane comes first (DESIGN 6.7's "nearest corridor").
      const yRange: [number, number] = [
        Math.min(s0.y, e0.y, pp.y, qq.y),
        Math.max(s0.y, e0.y, pp.y, qq.y),
      ];
      const xRange: [number, number] = [
        Math.min(s0.x, e0.x, pp.x, qq.x),
        Math.max(s0.x, e0.x, pp.x, qq.x),
      ];
      const extraLanes = item.loop
        ? {
            y: corridorGaps('y', content, blockers, clear, xRange),
            x: corridorGaps('x', content, blockers, clear, yRange),
          }
        : undefined;
      // The local bounds keep an ordinary edge's detour local — going all the
      // way to the canvas edge to dodge one neighbour reads as nonsensical.
      // But local bounds can themselves be blocked (regex-engine's AT→NO: the
      // local corridor is also where DM→DT crosses), and the only route left
      // that never runs through a box or another forward edge is the one
      // that goes all the way round, same as a loop-back would. Offered
      // alongside the local lanes, not instead of them, so it only wins when
      // it is genuinely the sole clean option — same 400 flat cost either way.
      const rounds =
        detourBounds === content
          ? detours(s0, ss, e0, es, pp, qq, detourBounds, clear, extraLanes)
          : [
              ...detours(s0, ss, e0, es, pp, qq, detourBounds, clear),
              ...detours(s0, ss, e0, es, pp, qq, content, clear, extraLanes),
            ];
      for (const round of rounds) {
        // Detours offers every lane a face can reach at all, including ones
        // at right angles to a same-side loop — a lane in the *same* axis as
        // ss/es is the only shape that can't put a jog where the stub meets
        // it (the lane's own two cross points already share one coordinate;
        // a cross-axis lane's don't, and when the two stubs are already
        // close — an adjacent retry, not one spanning the diagram — that gap
        // is a few units, which reads as a pointless dogleg, not a route).
        // Crossing axes is still on the table for when it's the only way
        // around something, just priced instead of free.
        const sameAxis = isVertical(round.side) === isVertical(ss);
        const crossAxisCharge = ss === es && !sameAxis ? 5 : 0;
        // A forward edge going round costs 3 or 4 bends, which DESIGN 6.1
        // only allows a loop-back. So this is charged far above anything the
        // alternate-side search below spends (mismatch 24 + congestion) —
        // a clean 0–2 bend route at a different side pair always wins over
        // going round, and going round is only ever the final answer when no
        // side pair gives one (regex-engine's AT→NO, state's Graduated→
        // root_end both used to win this comparison at 12 flat cost, taking
        // a 3-bend route past two boxes instead of a 2-bend one from a
        // clearer face). Loops keep the old, unpenalised cost — going round
        // is the route DESIGN 6.7 asks for, not a fallback.
        const cost =
          intrusion(round.points, blockers) +
          (mustGoRound ? 0 : 400) +
          crossAxisCharge +
          crossPenalty(round.points) +
          marginShortfall(round.points, content, clear) * 50 +
          selfPierce(round.points, [a, b]) * 2000 +
          (item.loop ? tightCornerCost(round.points) : 0) +
          Math.max(0, pathLength(round.points) - loopBudget) * 10;
        if ((globalThis as Record<string, unknown>).__DEBUG_EDGE === item.edge.id) {
          console.error(
            'ROUND',
            round.side,
            JSON.stringify(round.points),
            'cost',
            cost,
            'selfPierce',
            selfPierce(round.points, [a, b]),
            'intrusion',
            intrusion(round.points, blockers),
            'len',
            pathLength(round.points),
            'budget',
            loopBudget,
          );
        }
        // Among routes that cost the same (almost always two or more clean
        // lanes), the nearest corridor wins — the shortest resulting path,
        // not whichever lane was offered first.
        const len = pathLength(round.points);
        if (
          !best ||
          cost < best.cost - 0.5 ||
          (Math.abs(cost - best.cost) < 0.5 && len < (best.len ?? Infinity))
        ) {
          best = { points: round.points, cost, len };
        }
      }
      return best;
    };

    // Wraps `build` with the side/along combination that produced it, so the
    // fan pass below (after every edge has picked its route) can tell what a
    // route actually settled on — which, once the alternate-pair search below
    // kicks in, can differ from `item.startSide`/`endSide`.
    interface Attempt {
      points: Point[];
      cost: number;
      ss: Side;
      es: Side;
      sAlong: number;
      eAlong: number;
      mustGoRound: boolean;
    }
    const attempt = (
      ss: Side,
      es: Side,
      sAlong: number,
      eAlong: number,
      mustGoRound: boolean,
    ): Attempt | null => {
      const r = build(ss, es, sAlong, eAlong, mustGoRound);
      return r ? { ...r, ss, es, sAlong, eAlong, mustGoRound } : null;
    };

    let best = attempt(item.startSide, item.endSide, startAlong, endAlong, item.loop);
    // Before ever mixing lanes, see whether a *different* single lane clears
    // both ends outright. loopSide's choice is a corridor-wide tie-break — it
    // can pick a side that grazes something right next to one end (the
    // end-state marker sitting beside Running, state.mmd) even though another
    // side is completely open for both ends. A lane with zero intrusion beats
    // every mixed-lane route below, which always pays a cost for the jog
    // where the two lanes meet, so it is worth the four extra tries.
    if (item.loop && (best?.cost ?? Infinity) > 0) {
      // Only the axis the exit side itself was chosen from — whichever family
      // `item.startSide` belongs to, not the chart's own flow axis, since a
      // horizontal-arrival loop now picks its exit from the same family the
      // arrival is in (see the comment above `startSideChoice`), not
      // necessarily the family the chart's flow direction would suggest. The
      // arriving side stays put — it is fixed to the target's flow-in face
      // (DESIGN 6.2), not something this search is free to trade away for a
      // cleaner lane.
      const sides: Side[] = isVertical(item.startSide) ? ['top', 'bottom'] : ['left', 'right'];
      for (const ss of sides) {
        if (ss === item.startSide) continue;
        const [sl, sh] = faceRange(a, ss, sharpA);
        const alt = attempt(
          ss,
          item.endSide,
          Math.max(sl, Math.min(sh, faceMiddle(a, ss))),
          endAlong,
          true,
        );
        if (alt && alt.cost === 0) {
          best = alt;
          break;
        }
      }
    }
    // A loop already spends its own side-mismatch budget in loopSide
    // (route.ts:~315) and its arriving side is fixed outright (DESIGN 6.2,
    // above) — re-opening either choice here on *any* nonzero cost is a
    // different failure: a single-lane detour can't produce a jog (both its
    // cross points share one lane coordinate), so the only way this search
    // can beat it is by mixing two different lanes — which reads as the
    // tiny, pointless dogleg this was ("nonsensical line paths",
    // incident-response.mmd's Confirmed-intrusion retry). A same-side detour
    // grazing one box by a couple of units is still the better picture than
    // that. Loops only reopen the search for a real intrusion, not noise.
    const worthRetrying = item.loop ? (best?.cost ?? Infinity) > 8 : !best || best.cost > 0;
    if (worthRetrying) {
      const sides: Side[] = ['left', 'right', 'top', 'bottom'];
      // A loop's arriving face is never up for renegotiation here — DESIGN
      // 6.2 already fixed it. Only the exit side gets to roam the full set.
      const esSides: Side[] = item.loop ? [item.endSide] : sides;
      for (const ss of sides) {
        for (const es of esSides) {
          if (ss === item.startSide && es === item.endSide) continue;
          const [sl, sh] = faceRange(a, ss, sharpA);
          const [el, eh] = faceRange(b, es, sharpB);
          // Not just the middle of each face — an obstacle a side pair can't
          // get past from centre (regex-engine's AT→NO: NO's own middle sits
          // close enough to TLD's clearance to graze it no matter which lane
          // the crossbar takes) can still be clear from one end of the face,
          // same as DESIGN 6.4's fan already lands other edges off-centre.
          // Centred stays free; the two edges cost a little so a route only
          // leaves the midpoint when doing so avoids something real.
          const sMid = faceMiddle(a, ss);
          const eMid = faceMiddle(b, es);
          const sCandidates = [...new Set([sMid, sl, sh])];
          const eCandidates = [...new Set([eMid, el, eh])];
          for (const sAlongTry of sCandidates) {
            for (const eAlongTry of eCandidates) {
              const alt = attempt(
                ss,
                es,
                Math.max(sl, Math.min(sh, sAlongTry)),
                Math.max(el, Math.min(eh, eAlongTry)),
                item.loop,
              );
              if (!alt) continue;
              // A loop pays much more to mix lanes — the dogleg it buys is
              // worse than the small intrusion it avoids, whatever the raw
              // numbers say.
              const mismatchCost = item.loop ? 56 : 24;
              // Only charged when the alternate reaches for a face that is
              // not the one this edge was already going to use — a face
              // nothing else has touched costs nothing extra, same as today.
              const congestion =
                (ss === item.startSide ? 0 : (faceLoad.get(loadKey(item.edge.from, ss)) ?? 0)) +
                (es === item.endSide ? 0 : (faceLoad.get(loadKey(item.edge.to, es)) ?? 0));
              const offCentre = (sAlongTry === sMid ? 0 : 6) + (eAlongTry === eMid ? 0 : 6);
              const charge =
                (ss === item.startSide ? 0 : mismatchCost) +
                (es === item.endSide ? 0 : mismatchCost) +
                congestion * 20 +
                offCentre;
              if (!best || alt.cost + charge < best.cost)
                best = { ...alt, cost: alt.cost + charge };
            }
          }
        }
      }
    }
    if ((globalThis as Record<string, unknown>).__DEBUG_EDGE === item.edge.id) {
      console.error('WINNER', JSON.stringify(best));
    }
    if (item.loop) lane++;
    const points = best?.points ?? [start, end];
    const finalSS = best?.ss ?? item.startSide;
    const finalES = best?.es ?? item.endSide;
    const finalMustGoRound = best?.mustGoRound ?? item.loop;
    faceLoad.set(
      loadKey(item.edge.from, finalSS),
      (faceLoad.get(loadKey(item.edge.from, finalSS)) ?? 0) + 1,
    );
    faceLoad.set(
      loadKey(item.edge.to, finalES),
      (faceLoad.get(loadKey(item.edge.to, finalES)) ?? 0) + 1,
    );
    // Committed, in source order, for the next forward edge's crossingCost
    // and sharedRunCost.
    if (!item.loop) {
      const edgeStart = points[0]!,
        edgeEnd = points[points.length - 1]!;
      for (let i = 1; i < points.length; i++) {
        placedForwardSegs.push({ a: points[i - 1]!, b: points[i]!, edgeStart, edgeEnd });
      }
    }

    resolved.push({
      edgeId: item.edge.id,
      item,
      ss: finalSS,
      es: finalES,
      sAlong: best?.sAlong ?? startAlong,
      eAlong: best?.eAlong ?? endAlong,
      mustGoRound: finalMustGoRound,
      points,
      // Only the along-coordinate ever needs to move after this: the fan pass
      // below never changes which face won, only where on it the edge lands.
      rebuild: (sAlong, eAlong) =>
        attempt(finalSS, finalES, sAlong, eAlong, finalMustGoRound)?.points ?? points,
    });
  }

  // Fan a second time, now that every edge knows which face it actually
  // landed on. The pass above (route.ts:~953) fans by the face `facesFor`
  // proposed; when the obstacle search here moved an edge to a different
  // face — the only way two edges converge on one pixel without either of
  // them ever sharing that pixel as their *proposed* attachment — this is
  // the only place that still sees it. `state.mmd`'s Graduated→root_end
  // retry is forced off its proposed right face by the Paused box in the
  // way, lands on Graduated's top face at the exact same coordinate the
  // Running→Graduated arrival already uses, and the two ran collinear for a
  // stretch right at the node (DESIGN 6.4).
  //
  // A retry counts too, on the one end that is not its own loop's other leg:
  // `4geeks-journey.mmd`'s Mentor-pairing retry comes back into Portfolio's
  // south face from below, which is also the face Portfolio's own forward
  // edge to the review gate leaves from — both dead centre, since a
  // wrap layout puts both neighbours below it. `loop`'s exclusion here was
  // about *pass one*, where a loop's own lane pick (`loopSide`/`lane`)
  // hasn't happened yet; by now it has, and the face it landed on is exactly
  // as real as any other edge's.
  // A channel edge (DESIGN 2.6's input-above/output-below column) never
  // moves — that is the point of it being a channel — but it still has to be
  // *seen* here, or the edge fighting it for the face has nothing to move
  // away from and both stay dead centre.
  interface Member2 {
    r: Resolved;
    end: boolean;
    fixed: boolean;
  }
  const buckets2 = new Map<string, Member2[]>();
  const key2 = (node: string, side: Side) => `${node}:${side}`;
  for (const r of resolved) {
    const fixed = r.item.channel;
    const startKey = key2(r.item.edge.from, r.ss);
    buckets2.set(startKey, [...(buckets2.get(startKey) ?? []), { r, end: false, fixed }]);
    const endKey = key2(r.item.edge.to, r.es);
    buckets2.set(endKey, [...(buckets2.get(endKey) ?? []), { r, end: true, fixed }]);
  }
  for (const [k, members] of buckets2) {
    if (members.length < 2) continue;
    // DESIGN 6.3: a bucket that is nothing but arrivals — the loop-back and
    // the forward edge that both land on the same face, `TRI`/`Running`/`F`'s
    // case — converges onto the face's centre instead of being pushed apart,
    // whatever the routing search above happened to settle each one on. This
    // pass is the only place that sees a loop-back and a forward edge on the
    // same face at once (the first pass above never sees loops at all), so
    // it is the only place that can merge them.
    if (members.every((m) => m.end)) {
      const nodeId = k.slice(0, k.lastIndexOf(':'));
      const box = boxOf(nodeId);
      if (!box) continue;
      const side = members[0]!.r.es;
      const middle = faceMiddle(box, side);
      for (const m of members) if (!m.fixed) m.r.eAlong = middle;
      continue;
    }
    // Already spread by the first pass, or simply not colliding — leave it;
    // only a genuine coincidence on the same pixel needs fixing here.
    const alongOf = (m: Member2) => (m.end ? m.r.eAlong : m.r.sAlong);
    const spread = Math.max(...members.map(alongOf)) - Math.min(...members.map(alongOf));
    if (spread >= 8) continue;
    // All fixed (or only one member, which spread's Infinity-free math above
    // would already have skipped) — nothing here is free to move.
    const movable = members.filter((m) => !m.fixed);
    if (movable.length === 0) continue;

    const nodeId = k.slice(0, k.lastIndexOf(':'));
    const box = boxOf(nodeId);
    if (!box) continue;
    const side = members[0]!.end ? members[0]!.r.es : members[0]!.r.ss;
    const shape = shapeOf(nodeId);
    const [lo, hi] = faceRange(box, side, shape ? !isBoxy(shape, box) : false);
    const far = (m: Member2) => {
      const other = boxOf(m.end ? m.r.item.edge.from : m.r.item.edge.to);
      return other ? faceMiddle(other, side) : 0;
    };
    const step = 8;
    const middle = faceMiddle(box, side);

    // Every member on this face — fixed or not — sorted once by where its far
    // end sits, so a movable member never lands on the wrong side of a
    // channel it shares the face with (DESIGN 6.1: ports in target order).
    // The old version only checked whether a slot was *free*, always probing
    // upward first regardless of which side the target actually called
    // for — which is what sent a lone fanned edge to a channel's near side
    // instead of its far side (org-chart's ACA→B1, python-or-java's
    // JAVA→JAVAENT: both routed to the wrong side of the sibling channel and
    // crossed it).
    const order = [...members].sort((p, q) => far(p) - far(q));
    const at = new Map<Member2, number>();
    for (const m of order) at.set(m, m.fixed ? alongOf(m) : middle);

    // Two sweeps — left to right, then right to left — each pushing a
    // movable member `step` clear of its neighbour. A fixed member never
    // moves, so the pair of passes is what lets a movable member end up on
    // *either* side of one, not just whichever side a single forward sweep
    // happens to push it toward.
    for (let i = 1; i < order.length; i++) {
      const prev = order[i - 1]!,
        cur = order[i]!;
      if (cur.fixed) continue;
      const need = at.get(prev)! + step;
      if (at.get(cur)! < need) at.set(cur, need);
    }
    for (let i = order.length - 2; i >= 0; i--) {
      const next = order[i + 1]!,
        cur = order[i]!;
      if (cur.fixed) continue;
      const need = at.get(next)! - step;
      if (at.get(cur)! > need) at.set(cur, need);
    }

    for (const m of order) {
      if (m.fixed) continue;
      const v = Math.max(lo, Math.min(hi, at.get(m)!));
      if (m.end) m.r.eAlong = v;
      else m.r.sAlong = v;
    }
  }

  const routes = new Map<string, OrthoRoute>();
  for (const r of resolved) {
    routes.set(r.edgeId, {
      points: tidyOrtho(squareOff(r.rebuild(r.sAlong, r.eAlong))),
      startSide: r.ss,
      endSide: r.es,
    });
  }

  // DESIGN 6.1 / 6.4, both fixed here over the finished geometry rather than
  // in the per-edge search above: a lone Z's middle segment sits at the true
  // centre of the one gap it crosses, and two *different* edges' runs
  // through the same corridor keep 16 clear of each other or share a bus's
  // single line — never merely close. Everything above judges one edge at a
  // time (its own intrusion, its own crossing cost against what is already
  // committed), which has no way to see either of these: that a channel
  // search spanning several rows can read two nodes on opposite sides of
  // its own span as conflicting walls and give up on a centre entirely
  // (regex-engine's `AT`→`NO`, a satellite's edge back out to a node several
  // rows above it), or that its own perfectly clean line sits a few units
  // from a different edge's equally clean line through the same gap
  // (`AT`→`NO` and `DM`→`DT`, 8 apart through the row-2/row-3 gap; `TLD`→
  // `OK` and `NO`→`[*]`, 4 apart through row-3/row-4). Nudging the search
  // itself to dodge either reopens the far more expensive side-pair search
  // for every edge sharing any corridor, which is what sent edges to a
  // worse side entirely instead of a few units sideways.
  //
  // Recentring runs first, spacing second: recentring a lone edge onto its
  // own true centre can walk it into range of a neighbour that was already
  // a clean 16 apart (incident-response's `ESC`→`CON`, recentred by 4 units
  // into a corridor `ESC`→`TRI`'s own loop already used, only 12 apart from
  // it once moved) — so the grouping that decides who needs spacing has to
  // be read again afterwards, off wherever recentring actually left things,
  // not off the positions the per-edge search first handed over.
  const obstacleBoxes = obstacles.map((o) => o.box);
  const backwardIds = new Set(resolved.filter((r) => r.item.edge.backward).map((r) => r.edgeId));

  interface Run {
    edgeId: string;
    idx: number;
    vert: boolean;
    c: number;
    lo: number;
    hi: number;
  }
  const findRuns = (): Run[] => {
    const runs: Run[] = [];
    for (const [edgeId, route] of routes) {
      const pts = route.points;
      for (let i = 2; i < pts.length - 1; i++) {
        const a = pts[i - 1]!,
          b = pts[i]!;
        if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) > 8) {
          runs.push({
            edgeId,
            idx: i,
            vert: true,
            c: a.x,
            lo: Math.min(a.y, b.y),
            hi: Math.max(a.y, b.y),
          });
        } else if (Math.abs(a.y - b.y) < 0.5 && Math.abs(a.x - b.x) > 8) {
          runs.push({
            edgeId,
            idx: i,
            vert: false,
            c: a.y,
            lo: Math.min(a.x, b.x),
            hi: Math.max(a.x, b.x),
          });
        }
      }
    }
    return runs;
  };
  const groupRuns = (runs: Run[]): Run[][] => {
    const parent = runs.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const ra = runs[i]!,
          rb = runs[j]!;
        if (ra.vert !== rb.vert || ra.edgeId === rb.edgeId) continue;
        const gap = Math.abs(ra.c - rb.c);
        if (gap < 0.5 || gap >= 16) continue; // a bus, or already clear
        const overlap = Math.min(ra.hi, rb.hi) - Math.max(ra.lo, rb.lo);
        if (overlap <= 16) continue;
        const [rootA, rootB] = [find(i), find(j)];
        if (rootA !== rootB) parent[rootA] = rootB;
      }
    }
    const groups = new Map<number, Run[]>();
    for (let i = 0; i < runs.length; i++) {
      const root = find(i);
      groups.set(root, [...(groups.get(root) ?? []), runs[i]!]);
    }
    return [...groups.values()];
  };

  // Only a run nothing else shares a corridor with, and only a genuine
  // three-run Z — a longer, already-bent path is judged by different rules
  // — gets nudged; a backward edge is never measured by this rule at all.
  for (const group of groupRuns(findRuns())) {
    if (group.length !== 1) continue;
    const run = group[0]!;
    if (backwardIds.has(run.edgeId)) continue;
    const pts = routes.get(run.edgeId)!.points;
    if (pts.length !== 4 || run.idx !== 2) continue;
    const p0 = pts[1]!,
      p1 = pts[2]!;
    const near = run.vert
      ? obstacleBoxes.filter((o) => o.y + o.height > run.lo && o.y < run.hi)
      : obstacleBoxes.filter((o) => o.x + o.width > run.lo && o.x < run.hi);
    const before = run.vert
      ? near.filter((o) => o.x + o.width <= run.c + 1).map((o) => o.x + o.width)
      : near.filter((o) => o.y + o.height <= run.c + 1).map((o) => o.y + o.height);
    const after = run.vert
      ? near.filter((o) => o.x >= run.c - 1).map((o) => o.x)
      : near.filter((o) => o.y >= run.c - 1).map((o) => o.y);
    if (!before.length || !after.length) continue;
    const want = (Math.max(...before) + Math.min(...after)) / 2;
    const delta = want - run.c;
    if (Math.abs(delta) < 3.5) continue;
    if (run.vert) {
      p0.x += delta;
      p1.x += delta;
    } else {
      p0.y += delta;
      p1.y += delta;
    }
  }

  // Every interior run (never the stub at a node's own face — that stays
  // put, and never a backward edge's — a loop already has its own lane rule,
  // `loopSide`'s `myLane`, and judging it against an ordinary edge's channel
  // here as well double-counts the same spacing and can push a forward edge
  // off its own true centre for a conflict that was never really there —
  // 4geeks-journey's `E`→`F` used to be pulled 16 apart from the `I`→`F`
  // retry's own return run this way) is grouped with whichever other edges'
  // runs are parallel, overlap by more than 16, and sit under 16 from it —
  // read fresh, since recentring above can have created a new conflict as
  // easily as it removed one — and the whole group is respaced 16 apart
  // around its own average.
  for (const group of groupRuns(findRuns().filter((r) => !backwardIds.has(r.edgeId)))) {
    // One slot per edge: two runs belonging to the same edge (a path that
    // passes back through its own corridor) are never pulled apart from
    // each other, only from every *other* edge's run in the group.
    const byEdge = new Map<string, Run>();
    for (const r of group) if (!byEdge.has(r.edgeId)) byEdge.set(r.edgeId, r);
    const members = [...byEdge.values()].sort((a, b) => a.c - b.c);
    if (members.length < 2) continue;
    const mean = members.reduce((sum, r) => sum + r.c, 0) / members.length;
    const start = mean - ((members.length - 1) * 16) / 2;
    members.forEach((r, i) => {
      const delta = start + i * 16 - r.c;
      if (Math.abs(delta) < 0.5) return;
      const pts = routes.get(r.edgeId)!.points;
      const p0 = pts[r.idx - 1]!,
        p1 = pts[r.idx]!;
      if (r.vert) {
        p0.x += delta;
        p1.x += delta;
      } else {
        p0.y += delta;
        p1.y += delta;
      }
    });
  }

  // Two forward edges leaving the *same* node can still end up with
  // parallel, too-close stubs — DESIGN 6.4's own 8-apart port spacing
  // promises they never converge on one pixel, not that they stay 16 clear
  // along a run that only grows this long after a later pass moves one of
  // their targets away (DESIGN 6.10's own corridor growth is exactly such a
  // pass: `state.mmd`'s `Running`→`Paused` and `Running`→`Graduated` start 8
  // apart and stay clear until growth stretches `Paused`'s own edge long
  // enough to overlap `Graduated`'s stub by more than 16). The general
  // interior-run pass above deliberately never touches a stub for a good
  // reason on record (pulling 4geeks-journey's `E`→`F` onto the `I`→`F`
  // retry's own return run) — so this is scoped tightly to a case that
  // reason does not cover: both conflicting runs are the leaving stub of a
  // forward edge, and both leave the exact same node. Widening the two
  // ports symmetrically keeps each still on the node's own face (a few units
  // either side of where it already was) rather than detaching either from
  // it the way moving an already-distant elbow would.
  const fromOf = new Map(resolved.map((r) => [r.edgeId, r.item.edge.from]));
  const stubRun = (edgeId: string, route: OrthoRoute): Run | null => {
    const pts = route.points;
    if (pts.length < 2) return null;
    const a = pts[0]!,
      b = pts[1]!;
    if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) > 8) {
      return { edgeId, idx: 1, vert: true, c: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) };
    }
    if (Math.abs(a.y - b.y) < 0.5 && Math.abs(a.x - b.x) > 8) {
      return { edgeId, idx: 1, vert: false, c: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) };
    }
    return null;
  };
  const stubsBySource = new Map<string, Run[]>();
  for (const [edgeId, route] of routes) {
    if (backwardIds.has(edgeId)) continue;
    const from = fromOf.get(edgeId);
    const run = from ? stubRun(edgeId, route) : null;
    if (run) stubsBySource.set(from!, [...(stubsBySource.get(from!) ?? []), run]);
  }
  for (const runs of stubsBySource.values()) {
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const a = runs[i]!,
          b = runs[j]!;
        if (a.vert !== b.vert) continue;
        const gap = Math.abs(a.c - b.c);
        if (gap < 0.5 || gap >= 16) continue; // already clear, or a bus sharing one point
        if (Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) <= 16) continue;
        const [lower, higher] = a.c <= b.c ? [a, b] : [b, a];
        const mid = (lower.c + higher.c) / 2;
        for (const [run, target] of [
          [lower, mid - 8],
          [higher, mid + 8],
        ] as const) {
          const delta = target - run.c;
          if (Math.abs(delta) < 0.5) continue;
          const pts = routes.get(run.edgeId)!.points;
          const p0 = pts[0]!,
            p1 = pts[1]!;
          if (run.vert) {
            p0.x += delta;
            p1.x += delta;
          } else {
            p0.y += delta;
            p1.y += delta;
          }
        }
      }
    }
  }

  return routes;
}
