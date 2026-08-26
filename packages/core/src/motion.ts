import type { Graph } from './graph.ts';
import type { Drawing, DrawnEdge } from './draw.ts';
import type { Scene } from './scene.ts';

/**
 * The motion layer.
 *
 * Manim's grammar rather than a generic fade: an outline *draws itself* and its
 * label follows; edges grow out of the box that made them; elements overlap
 * instead of queueing; the build stops dead for a beat; then a single wave of
 * accent dots leaves along every edge of the spine within one short staggered
 * window (siblings, not a relay), each dot absorbed into a ripple on the node
 * it reaches while that node presses and its caption brightens for the beat.
 *
 * Three structural decisions worth knowing.
 *
 * The whole sequence is one looping timeline. Every element shares the same
 * duration and iterates forever, with its own moment expressed as a percentage
 * inside that cycle. `animation-delay` cannot express this — a delay applies
 * only to the first iteration, so a delayed loop drifts out of formation on the
 * second pass.
 *
 * Each element gets exactly one track. Two `animation` declarations on the same
 * selector do not combine; the later one replaces the earlier. Accumulating
 * keyframes per element and emitting one animation makes that mistake
 * impossible rather than merely avoided.
 *
 * And all of it sits inside `prefers-reduced-motion: no-preference`. The
 * un-animated drawing is the finished chart, so a viewer who wants less motion —
 * or a renderer that never runs the CSS — gets the final frame, never a blank.
 */

export interface Timeline {
  css: string;
  /** Seconds for one full pass, including the hold. */
  cycle: number;
  /** Seconds at which the diagram is fully drawn. */
  built: number;
}

/**
 * One element's keyframes, gathered by time.
 *
 * CSS interpolates each property between the keyframes that mention it, so a
 * track can describe the outline drawing early and its colour flashing later
 * without either interfering with the other. A property that goes unmentioned
 * for a long stretch still interpolates smoothly across that stretch from
 * wherever it was last set — which is why every track below re-states a
 * property's current value at each new keyframe rather than only where it
 * changes: two keyframes carrying the same value hold it flat; only a genuine
 * change between adjacent keyframes moves it.
 */
export class Track {
  private readonly keys = new Map<number, Record<string, string>>();

  at(time: number, props: Record<string, string>): void {
    const rounded = Math.round(time * 1000) / 1000;
    this.keys.set(rounded, { ...(this.keys.get(rounded) ?? {}), ...props });
  }

  frames(cycle: number): string {
    return [...this.keys.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([time, props]) => {
        const stop = ((100 * time) / cycle).toFixed(3);
        const body = Object.entries(props)
          .map(([k, v]) => `${k}:${v}`)
          .join(';');
        return `${stop}%{${body}}`;
      })
      .join('');
  }

  get empty(): boolean {
    return this.keys.size === 0;
  }
}

/** Read the start and end point out of a path's `d`, to pick a grow axis. */
function edgeSpan(d: string): { dx: number; dy: number } {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (nums.length < 4) return { dx: 0, dy: 1 };
  const sx = nums[0]!;
  const sy = nums[1]!;
  const ex = nums[nums.length - 2]!;
  const ey = nums[nums.length - 1]!;
  return { dx: ex - sx, dy: ey - sy };
}

/**
 * Which transform grows this edge on, and from which end.
 *
 * `scaleY`/`scaleX` on the edge's own bounding box, rather than
 * `stroke-dashoffset`, so a dotted or dashed edge keeps its pattern instead of
 * being forced solid for the length of the build — DESIGN 10.4's channel grow.
 * Only used on a single straight segment; an elbowed path scaled this way reads
 * as unfolding, not drawing.
 */
function edgeAxis(d: string): { axis: 'scaleY' | 'scaleX'; origin: string } {
  const { dx, dy } = edgeSpan(d);
  if (Math.abs(dy) >= Math.abs(dx)) {
    return { axis: 'scaleY', origin: dy >= 0 ? '50% 0%' : '50% 100%' };
  }
  return { axis: 'scaleX', origin: dx >= 0 ? '0% 50%' : '100% 50%' };
}

/**
 * True when `d` (built by `roundedPath`) is one straight run with no corner —
 * exactly one `L` and no `Q`. An elbowed path has a `Q` per rounded corner (or
 * an extra `L` for a corner too tight to round), so this only ever admits the
 * two-point case.
 */
function isSingleSegment(d: string): boolean {
  return (d.match(/[LQ]/g) ?? []).length === 1;
}

/** Dashed/dotted strokes carry a pattern worth protecting; solid ones don't. */
function isPatterned(stroke: DrawnEdge['stroke']): boolean {
  return stroke !== 'normal' && stroke !== 'thick';
}

export function animate(drawing: Drawing, graph: Graph, scene: Scene): Timeline {
  void graph; // scheduling now reads drawing.edges' own onPath/backward flags
  const m = scene.motion;
  const lead = 0.25;

  // DESIGN 10.4 / 8.3: 0.15s between siblings, everywhere something builds or
  // leaves in a group, so a row of elements reads as one event, not a queue.
  const SIBLING_LAG = 0.15;
  const FILL_DELAY = 0.3; // fills fade in 0.3s after their outline starts
  const FILL_DURATION = 0.5;
  const LABEL_GAP = 0.15; // labels follow fills by another beat
  const LABEL_DURATION = 0.5;
  const EDGE_GROW = m.build;
  const TRAVEL = 0.7; // spark travel time
  const RIPPLE = 0.5; // ripple bloom time
  const PRESS = 0.6; // arrival press + outline + caption beat
  const FLASH_OUT = 0.45; // departure outline flash
  // The one exception to 8.1's ease everywhere: the arrival settle wants an
  // overshoot, not the drawing's own draw-on curve.
  const PRESS_EASE = 'cubic-bezier(.22,1.2,.36,1)';

  // A card inside a panel is filled rather than outlined (DESIGN 4.2) — its
  // `.gc-outline` is `stroke: none` in the static stylesheet. Forcing a stroke
  // colour onto that element via keyframes — even for the arrival beat — paints
  // an outline the static rule deliberately withheld, which is a second depth
  // cue on top of the fill. These nodes get their emphasis on the fill instead.
  const inPanel = new Set(drawing.inPanelNodes);

  // ---- Schedule: the graph's own order, not reading order. ----
  //
  // A node cannot arrive before whatever feeds it does, and an edge cannot
  // leave a node that has not arrived yet — a chain relays hop to hop instead
  // of firing as one staggered wave, which is the only way a viewer can read
  // "this caused that" off the build. Two things stay genuinely parallel,
  // which is not the same failure: independent roots (nothing depends on their
  // order) and a real fan-out (two edges actually do leave the same node at
  // once) — both get only DESIGN 10.4's usual sibling lag between them, never
  // a relay wait, because nothing in the graph says one has to follow the
  // other. A retry or loop-back sits outside this order entirely: it draws
  // once both its ends already exist, so it can never hold up the flow it
  // answers (DESIGN 6.7).
  const nodeIndex = new Map(drawing.nodes.map((id, i) => [id, i]));
  const outEdges = new Map<string, DrawnEdge[]>();
  const waitingOn = new Map<string, number>(); // forward indegree
  for (const id of drawing.nodes) {
    outEdges.set(id, []);
    waitingOn.set(id, 0);
  }
  const loopEdges: DrawnEdge[] = [];
  for (const edge of drawing.edges) {
    if (!outEdges.has(edge.from) || !waitingOn.has(edge.to)) continue;
    if (edge.backward) {
      loopEdges.push(edge);
      continue;
    }
    outEdges.get(edge.from)!.push(edge);
    waitingOn.set(edge.to, (waitingOn.get(edge.to) ?? 0) + 1);
  }

  const nodeStart = new Map<string, number>();
  const edgeStart = new Map<string, number>();
  const edgeArrive = new Map<string, number>();
  const incoming = new Map<string, number[]>(); // node -> arrival times seen so far

  const roots = drawing.nodes.filter((id) => (waitingOn.get(id) ?? 0) === 0);
  const queue: string[] = [];
  roots.forEach((id, i) => {
    nodeStart.set(id, lead + i * SIBLING_LAG);
    queue.push(id);
  });

  // Kahn's algorithm, but the queue is always taken in the order nodes
  // actually became ready — a node reached quickly schedules its own outgoing
  // edges before one that took longer, so a fast branch never waits on a slow
  // one it has no dependency on.
  while (queue.length) {
    queue.sort(
      (p, q) => nodeStart.get(p)! - nodeStart.get(q)! || nodeIndex.get(p)! - nodeIndex.get(q)!,
    );
    const id = queue.shift()!;
    const ready = nodeStart.get(id)!;
    outEdges.get(id)!.forEach((edge, k) => {
      const start = ready + m.build * 0.8 + k * SIBLING_LAG;
      edgeStart.set(edge.id, start);
      // A path edge is the one thread with a travelling dot, so its own hop
      // takes the dot's travel time; every other edge just draws on.
      const arrive = start + (edge.onPath ? TRAVEL : EDGE_GROW);
      edgeArrive.set(edge.id, arrive);
      const seen = incoming.get(edge.to) ?? [];
      seen.push(arrive);
      incoming.set(edge.to, seen);
      const left = (waitingOn.get(edge.to) ?? 1) - 1;
      waitingOn.set(edge.to, left);
      if (left === 0) {
        // Every edge into this node has now landed — it can only exist once
        // all of them have, so it waits for the last, not the first.
        nodeStart.set(edge.to, Math.max(...seen));
        queue.push(edge.to);
      }
    });
  }

  // A node a cycle keeps alive with no forward path in from a root (only
  // reachable via the back edges just set aside) never enters the queue above.
  // It still has to appear somewhere rather than sit at the very end of the
  // timeline undrawn until the loop that answers it fires.
  const fallback = Math.max(lead, ...drawing.nodes.map((id) => nodeStart.get(id) ?? 0));
  let strandedI = 0;
  for (const id of drawing.nodes) {
    if (!nodeStart.has(id)) nodeStart.set(id, fallback + strandedI++ * SIBLING_LAG);
  }

  // Loop-backs draw once both ends are individually settled, staggered among
  // themselves the same sibling-row way (DESIGN 10.4) — never gating, and
  // never racing the flow they answer.
  loopEdges.forEach((edge, i) => {
    const bothSettled =
      Math.max(nodeStart.get(edge.from) ?? lead, nodeStart.get(edge.to) ?? lead) + m.build;
    edgeStart.set(edge.id, bothSettled + i * SIBLING_LAG);
  });

  const pathEdges = drawing.edges.filter((e) => e.onPath && edgeStart.has(e.id));

  const settleOf = (edge: DrawnEdge): number => {
    const start = edgeStart.get(edge.id) ?? lead;
    if (edge.backward) return start + EDGE_GROW;
    if (edge.onPath) return (edgeArrive.get(edge.id) ?? start + TRAVEL) + Math.max(PRESS, RIPPLE);
    return start + EDGE_GROW;
  };
  const built = Math.max(
    lead + m.build,
    ...[...nodeStart.values()].map((t) => t + m.build),
    ...drawing.edges.map((e) => (edgeStart.has(e.id) ? edgeStart.get(e.id)! + EDGE_GROW : lead)),
  );
  // DESIGN 10.4: a still beat of at least 2s, because the still frame is what
  // most people see. `m.hold` (2.4s) clears that floor.
  const cycle = Math.max(built, ...drawing.edges.map(settleOf)) + m.hold;

  const tracks = new Map<string, Track>();
  const track = (selector: string): Track => {
    const existing = tracks.get(selector);
    if (existing) return existing;
    const made = new Track();
    tracks.set(selector, made);
    return made;
  };

  for (const id of drawing.clusters) {
    const t = track(`.gc-cluster[data-id="${id}"]`);
    t.at(0, { opacity: '0' });
    t.at(m.build * 0.9, { opacity: '1' });
    t.at(cycle, { opacity: '1' });
  }

  // Read through the same custom properties the stylesheet uses, so an
  // override set on the page (a host repainting the scene) still reaches the
  // animated colours instead of only the static ones.
  const path = `var(--gc-path, ${scene.path})`;
  const accent = `var(--gc-accent, ${scene.accent})`;
  const quiet = `var(--gc-quiet, ${scene.quiet})`;
  const ink = `var(--gc-ink, ${scene.ink})`;
  const surface = `var(--gc-surface, ${scene.surface})`;

  for (const id of drawing.nodes) {
    const start = nodeStart.get(id)!;

    // Build: the outline draws on, then the fill washes in behind it, then the
    // label — each a beat later than the one before (DESIGN 8.2, 10.4).
    const outline = track(`.gc-node[data-id="${id}"] .gc-outline`);
    outline.at(0, { 'stroke-dashoffset': '1', opacity: '0' });
    outline.at(start, { 'stroke-dashoffset': '1', opacity: '0' });
    outline.at(start + 0.02, { opacity: '1' });
    outline.at(start + m.build, { 'stroke-dashoffset': '0' });
    outline.at(cycle, { 'stroke-dashoffset': '0', opacity: '1' });

    const wash = track(`.gc-node[data-id="${id}"] .gc-fill, .gc-node[data-id="${id}"] .gc-core`);
    wash.at(0, { opacity: '0' });
    wash.at(start + FILL_DELAY, { opacity: '0' });
    wash.at(start + FILL_DELAY + FILL_DURATION, { opacity: '1' });
    wash.at(cycle, { opacity: '1' });

    const label = track(`.gc-node[data-id="${id}"] .gc-label`);
    label.at(0, { opacity: '0' });
    label.at(start + FILL_DELAY + LABEL_GAP, { opacity: '0' });
    label.at(start + FILL_DELAY + LABEL_GAP + LABEL_DURATION, { opacity: '1' });
    label.at(cycle, { opacity: '1' });
  }

  const originRules: string[] = [];

  for (const edge of drawing.edges) {
    const start = edgeStart.get(edge.id)!;
    const line = track(`.gc-edge[data-id="${edge.id}"]`);

    if (isPatterned(edge.stroke) && isSingleSegment(edge.d)) {
      // Grow: a transform on the edge's own bounding box rather than a dash
      // reveal, so `.gc-stroke-dotted`'s pattern survives the build instead of
      // being forced solid for its length (DESIGN 10.4). Safe only on a single
      // straight run — this is the case an elbowed path would unfold on.
      const { axis, origin } = edgeAxis(edge.d);
      originRules.push(
        `.gc-edge[data-id="${edge.id}"]{transform-box:fill-box;transform-origin:${origin}}`,
      );
      // The scale carries the actual reveal (so the dash pattern survives); the
      // opacity pairs with it only so the edge reads as fully absent before its
      // turn rather than as a collapsed sliver sitting at the origin.
      line.at(0, { transform: `${axis}(0)`, opacity: '0' });
      line.at(start, { transform: `${axis}(0)`, opacity: '0' });
      line.at(start + 0.02, { opacity: '1' });
      line.at(start + EDGE_GROW, { transform: `${axis}(1)` });
      line.at(cycle, { transform: `${axis}(1)`, opacity: '1' });
    } else {
      // Draw on, not unfold: a `stroke-dashoffset` reveal against the
      // `pathLength="1"` draw.ts already gives every edge, the same trick
      // `.gc-outline` uses (DESIGN 8.2). `stroke-dasharray:1` is pinned per
      // edge — solid edges have no dasharray to offset against otherwise, and
      // an elbowed dashed/dotted path takes this branch too, so the same rule
      // also overrides `.gc-stroke-dotted`'s pattern (higher specificity: a
      // brief loss of the dot pattern while it draws beats reading as
      // unfolded).
      originRules.push(`.gc-edge[data-id="${edge.id}"]{stroke-dasharray:1}`);
      line.at(0, { 'stroke-dashoffset': '1', opacity: '0' });
      line.at(start, { 'stroke-dashoffset': '1', opacity: '0' });
      line.at(start + EDGE_GROW * 0.1, { opacity: '1' });
      line.at(start + EDGE_GROW, { 'stroke-dashoffset': '0' });
      line.at(cycle, { 'stroke-dashoffset': '0', opacity: '1' });
    }

    // A marker is painted at the path's end whatever the dash pattern does, so a
    // line being drawn on arrives with its arrowhead already waiting. Splitting
    // it onto its own element lets the head land when the line reaches it.
    const head = track(`.gc-arrow[data-id="${edge.id}"]`);
    head.at(0, { opacity: '0' });
    head.at(start + EDGE_GROW * 0.8, { opacity: '0' });
    head.at(start + EDGE_GROW * 1.05, { opacity: '1' });
    head.at(cycle, { opacity: '1' });

    // Cardinalities belong to the line, so they arrive with its marks.
    const card = track(`.gc-card[data-id="${edge.id}"]`);
    card.at(0, { opacity: '0' });
    card.at(start + EDGE_GROW * 0.8, { opacity: '0' });
    card.at(start + EDGE_GROW * 1.05, { opacity: '1' });
    card.at(cycle, { opacity: '1' });

    if (edge.hasLabel) {
      const text = track(`.gc-edge-label[data-id="${edge.id}"]`);
      text.at(0, { opacity: '0' });
      text.at(start + EDGE_GROW * 0.6, { opacity: '0' });
      text.at(start + EDGE_GROW * 1.2, { opacity: '1' });
      text.at(cycle, { opacity: '1' });
    }
  }

  for (const edge of pathEdges) {
    const depart = edgeStart.get(edge.id)!;
    const arrive = edgeArrive.get(edge.id)!;

    // The leaving node's depth cue flashes to the accent and settles back. A
    // panel card has no outline to flash (DESIGN 4.2 — it's a filled tile), so
    // it flashes its fill instead; everything else flashes its outline stroke.
    if (inPanel.has(edge.from)) {
      // Same selector the build-in wash track above uses, so this merges into
      // that one track/one animation instead of a second rule fighting it for
      // the `animation` property on the same element.
      const fromFill = track(
        `.gc-node[data-id="${edge.from}"] .gc-fill, .gc-node[data-id="${edge.from}"] .gc-core`,
      );
      fromFill.at(0, { fill: surface });
      fromFill.at(depart, { fill: surface });
      fromFill.at(depart + FLASH_OUT * 0.35, { fill: accent });
      fromFill.at(depart + FLASH_OUT, { fill: surface });
      fromFill.at(cycle, { fill: surface });
    } else {
      const fromOutline = track(`.gc-node[data-id="${edge.from}"] .gc-outline`);
      fromOutline.at(0, { stroke: path });
      fromOutline.at(depart, { stroke: path });
      fromOutline.at(depart + FLASH_OUT * 0.35, { stroke: accent });
      fromOutline.at(depart + FLASH_OUT, { stroke: path });
      fromOutline.at(cycle, { stroke: path });
    }

    // The arriving node's depth cue takes the accent for the press's beat —
    // same fill-vs-outline split as the departure flash above.
    if (inPanel.has(edge.to)) {
      // Same selector the build-in wash track above uses, so this merges into
      // that one track/one animation instead of a second rule fighting it for
      // the `animation` property on the same element.
      const toFill = track(
        `.gc-node[data-id="${edge.to}"] .gc-fill, .gc-node[data-id="${edge.to}"] .gc-core`,
      );
      toFill.at(0, { fill: surface });
      toFill.at(arrive, { fill: surface, 'animation-timing-function': PRESS_EASE });
      toFill.at(arrive + PRESS * 0.35, { fill: accent, 'animation-timing-function': PRESS_EASE });
      toFill.at(arrive + PRESS, { fill: surface, 'animation-timing-function': m.ease });
      toFill.at(cycle, { fill: surface });
    } else {
      const toOutline = track(`.gc-node[data-id="${edge.to}"] .gc-outline`);
      toOutline.at(0, { stroke: path });
      toOutline.at(arrive, { stroke: path, 'animation-timing-function': PRESS_EASE });
      toOutline.at(arrive + PRESS * 0.35, {
        stroke: accent,
        'animation-timing-function': PRESS_EASE,
      });
      toOutline.at(arrive + PRESS, { stroke: path, 'animation-timing-function': m.ease });
      toOutline.at(cycle, { stroke: path });
    }

    // The node itself presses — the one place the settling ease replaces 8.1's
    // draw-on curve, so the arrival reads as an impact rather than a build.
    const group = track(`.gc-node[data-id="${edge.to}"]`);
    group.at(0, { transform: 'scale(1)' });
    group.at(arrive, { transform: 'scale(1)', 'animation-timing-function': PRESS_EASE });
    group.at(arrive + PRESS * 0.3, {
      transform: 'scale(1.03)',
      'animation-timing-function': PRESS_EASE,
    });
    group.at(arrive + PRESS, { transform: 'scale(1)', 'animation-timing-function': m.ease });
    group.at(cycle, { transform: 'scale(1)' });

    // The caption brightens to ink for the same beat, then quiets again.
    const caption = track(`.gc-node[data-id="${edge.to}"] .gc-caption`);
    caption.at(0, { fill: quiet });
    caption.at(arrive, { fill: quiet, 'animation-timing-function': PRESS_EASE });
    caption.at(arrive + PRESS * 0.3, { fill: ink, 'animation-timing-function': PRESS_EASE });
    caption.at(arrive + PRESS, { fill: quiet, 'animation-timing-function': m.ease });
    caption.at(cycle, { fill: quiet });

    // The dot: travels the edge (r 1.5 -> 3), is absorbed at arrival (r -> 1),
    // then blooms once more as a stroke-only ripple on the target's outline
    // before fading for good. One element carries both halves — nothing in
    // this renderer's DOM has a separate ripple circle to hand off to — so the
    // colours are pinned at every keyframe up to the handoff; left unmentioned,
    // `fill`/`stroke` would interpolate from their very first value all the way
    // to the ripple's, and flip (colour cannot cross-fade with `none`) far too
    // early, part way through the travel.
    const spark = track(`.gc-spark[data-id="${edge.id}"]`);
    const dot = { fill: accent, stroke: 'none' };
    spark.at(0, { 'offset-distance': '0%', opacity: '0', r: '1.5', ...dot });
    spark.at(depart, { 'offset-distance': '0%', opacity: '0', r: '1.5', ...dot });
    spark.at(depart + TRAVEL * 0.15, { opacity: '1', r: '3', ...dot });
    spark.at(depart + TRAVEL * 0.88, { opacity: '1', r: '3', ...dot });
    spark.at(arrive, { 'offset-distance': '100%', opacity: '0', r: '1', ...dot });
    const bloom = { fill: 'none', stroke: accent, 'stroke-width': '1.2' };
    spark.at(arrive + 0.01, { r: '3', opacity: '0', ...bloom });
    spark.at(arrive + 0.01 + RIPPLE * 0.12, { opacity: '.9', ...bloom });
    spark.at(arrive + 0.01 + RIPPLE, { r: '14', opacity: '0', ...bloom });
    spark.at(cycle, { 'offset-distance': '0%', opacity: '0', r: '1.5', ...dot });
  }

  const rules: string[] = [];
  const frames: string[] = [];
  let index = 0;
  for (const [selector, value] of tracks) {
    if (value.empty) continue;
    const name = `gc-t${index++}`;
    rules.push(`${selector}{animation:${name} ${cycle.toFixed(2)}s ${m.ease} infinite}`);
    frames.push(`@keyframes ${name}{${value.frames(cycle)}}`);
  }

  const css = `
@media (prefers-reduced-motion: no-preference) {
/* Scaling happens about each node's own centre: fill-box makes the origin the
   node's bounding box rather than the whole canvas, which keeps a pulse in
   place instead of throwing the node across the frame. */
.gc-node { transform-box: fill-box; transform-origin: center; }
.gc-outline { stroke-dasharray: 1; }
${originRules.join('\n')}
${rules.join('\n')}
${frames.join('\n')}
}
`;

  return { css, cycle, built };
}
