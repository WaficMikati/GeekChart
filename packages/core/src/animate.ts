import type { AnimationOptions, Analysis, Element, PlayMode } from './types.ts';
import { paletteFor } from './theme.ts';
import type { ThemeName } from './types.ts';
import { hsl } from './tokens.ts';

export type { PlayMode };

export const defaultAnimation: AnimationOptions = {
  preset: 'cascade',
  delay: 0.15,
  stagger: 0.34,
  duration: 0.62,
  loop: false,
  respectReducedMotion: true,
  play: 'loop',
};

/**
 * The timing model, in one place.
 *
 * A wave is a row (or column) of the diagram. Nodes in a wave arrive together;
 * the edges leaving them start halfway through the next step, so a link always
 * grows out of a box that is already there; edge labels follow their edge.
 */
function beginFor(el: Element, o: AnimationOptions): number {
  const wave = Math.max(0, el.wave);
  const base = o.delay + wave * o.stagger;
  switch (el.kind) {
    case 'cluster':
      return o.delay * 0.5;
    case 'node':
      return base;
    case 'edge':
      return base + o.stagger * 0.5;
    case 'label':
      return base + o.stagger * 0.5 + o.duration * 0.45;
    default:
      return base;
  }
}

/** True when mermaid already dashed this edge (a `-.->` link). */
function isDashed(el: SVGElement): boolean {
  const attr = el.getAttribute('stroke-dasharray');
  if (attr && attr !== 'none' && attr !== '0') return true;
  const inline = el.style.strokeDasharray;
  if (inline && inline !== 'none') return true;
  const computed = getComputedStyle(el).strokeDasharray;
  return !!computed && computed !== 'none' && computed !== '0px';
}

/**
 * Give an element its own `<g>` to be transformed in.
 *
 * Mermaid puts a `transform` attribute on most groups. Animating CSS `transform`
 * would replace it and fling the node to the origin, so the animation goes on a
 * fresh wrapper instead, where `transform-box: fill-box` makes the element scale
 * about its own centre. A bare `<g>` renders identically to no wrapper at all.
 */
function wrap(el: SVGElement, className: string): SVGElement {
  const doc = el.ownerDocument!;
  const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', className);
  el.parentNode!.insertBefore(g, el);
  g.appendChild(el);
  return g;
}

/**
 * Move an edge's arrowheads onto a stroke-less copy that fades in once the line
 * has finished drawing.
 *
 * Markers are painted at the path's ends regardless of the dash pattern, so a
 * line being drawn on arrives with its arrowhead already waiting at the far end.
 * Splitting them lets the head land when the line reaches it. The copy paints no
 * stroke of its own, so it contributes nothing but the marker.
 */
function deferMarkers(el: SVGElement, begin: number, drawDuration: number): void {
  const start = el.getAttribute('marker-start');
  const end = el.getAttribute('marker-end');
  if (!start && !end) return;

  const clone = el.cloneNode(false) as SVGElement;
  clone.removeAttribute('id');
  clone.setAttribute('class', 'gc-marker');
  // Inline, and transparent rather than none: an attribute loses to mermaid's
  // own stylesheet, and `stroke: none` can suppress marker painting entirely.
  clone.style.stroke = 'transparent';
  clone.style.fill = 'none';
  clone.style.setProperty('--gc-t', `${(begin + drawDuration * 0.82).toFixed(3)}s`);
  el.removeAttribute('marker-start');
  el.removeAttribute('marker-end');
  if (start) clone.setAttribute('marker-start', start);
  if (end) clone.setAttribute('marker-end', end);
  el.parentNode!.insertBefore(clone, el.nextSibling);
}

/**
 * Clone an edge as a translucent overlay that a light streak runs along.
 *
 * Done as a copy so the real edge keeps its own dash pattern and arrowhead —
 * the flow effect can never damage the diagram it decorates.
 */
function addFlowOverlay(el: SVGElement, length: number, begin: number, index: number): void {
  const clone = el.cloneNode(false) as SVGElement;
  clone.removeAttribute('marker-end');
  clone.removeAttribute('marker-start');
  clone.removeAttribute('id');
  clone.setAttribute('class', 'gc-flow');
  clone.style.setProperty('--gc-len', `${Math.ceil(length)}px`);
  clone.style.setProperty('--gc-t', `${(begin + 0.4 + index * 0.11).toFixed(3)}s`);
  el.parentNode!.insertBefore(clone, el.nextSibling);
}

export interface BakeResult {
  css: string;
  runtime: number;
}

/**
 * Write the animation onto the SVG as data the CSS can read.
 *
 * Nothing here is time-dependent at runtime: delays and path lengths are
 * measured once, now, and stored as custom properties. The result is a diagram
 * that animates with no JavaScript, and that a headless browser can seek
 * frame-by-frame for video export.
 */
export function bake(
  svg: SVGSVGElement,
  analysis: Analysis,
  theme: ThemeName,
  options: Partial<AnimationOptions> = {},
): BakeResult {
  const o = { ...defaultAnimation, ...options };
  const id = svg.id;
  if (o.preset === 'none') return { css: '', runtime: 0 };

  let runtime = 0;
  let flowIndex = 0;

  for (const element of analysis.elements) {
    const begin = beginFor(element, o);
    runtime = Math.max(runtime, begin + o.duration);

    if (element.kind === 'edge') {
      const drawable =
        element.length !== undefined && !isDashed(element.el) && o.preset !== 'reveal';
      element.el.classList.add(drawable ? 'gc-edge' : 'gc-fade');
      element.el.style.setProperty('--gc-t', `${begin.toFixed(3)}s`);
      if (drawable) {
        element.el.style.setProperty('--gc-len', `${Math.ceil(element.length!)}px`);
        deferMarkers(element.el, begin, o.duration * 1.1);
        if (o.preset === 'flow' && element.length! > 24) {
          addFlowOverlay(element.el, element.length!, begin, flowIndex++);
        }
      }
      continue;
    }

    // `reveal` is the low-risk preset: no wrapper, no scaling, opacity and an
    // outer translate only — the two things that cannot disturb mermaid's own
    // transform attribute or its CSS selectors.
    const wave = Math.max(0, element.wave);
    const target = o.preset === 'reveal' ? element.el : wrap(element.el, 'gc-lift');
    const role =
      o.preset === 'reveal'
        ? 'gc-fade'
        : element.kind === 'node'
          ? 'gc-node'
          : element.kind === 'cluster'
            ? 'gc-cluster'
            : 'gc-fade';
    target.classList.add(role);
    target.style.setProperty('--gc-t', `${begin.toFixed(3)}s`);
    target.style.setProperty('--gc-wave', String(wave));
    if (element.kind === 'node') {
      element.el.setAttribute('data-gc-wave', String(wave));
    }
  }

  const waves = Math.max(1, ...analysis.elements.map((e) => e.wave + 1));
  const arrival = runtime;
  const css = animationCss(id, o, waves, arrival, theme);
  const total = o.preset === 'spotlight' ? arrival + waves * 0.45 + 1.2 : arrival;
  return { css, runtime: total };
}

function animationCss(
  id: string,
  o: AnimationOptions,
  waves: number,
  arrival: number,
  theme: ThemeName,
): string {
  const s = `#${id}`;
  const p = paletteFor(theme);
  const ease = 'cubic-bezier(.22,.86,.32,1)';
  const cycle = (waves * 0.45 + 2.2).toFixed(2);
  const spotlightWindow = (100 / Number(cycle)) * 0.5; // ~0.5s of pulse per cycle
  // DESIGN 8.4 (rev. 2026-08-28): every other rule in this file already runs
  // once (fill-mode `both`, no iteration-count — the default is already 1).
  // Only the two decorations below actually loop, and only they need to stop.
  const once = o.play !== 'loop';

  const motion = `
/* No \`will-change\` here. Promoting these groups to their own compositor layer
   makes Chrome raster them at bounds that clip the last glyph of a label. */
${s} .gc-lift { transform-box: fill-box; transform-origin: center; }
${s} .gc-node, ${s} .gc-cluster, ${s} .gc-fade { animation-fill-mode: both;
  animation-timing-function: ${ease}; animation-duration: ${o.duration}s;
  animation-delay: var(--gc-t, 0s); }

${s} .gc-node { animation-name: gc-rise; }
${s} .gc-cluster { animation-name: gc-settle; animation-duration: ${(o.duration * 1.15).toFixed(2)}s; }
${s} .gc-fade { animation-name: gc-fade; }

/* !important because mermaid ships \`.edge-pattern-solid { stroke-dasharray: 0 }\`
   at the same specificity, later in the document, which would otherwise flatten
   the dash pattern the draw-on effect depends on. */
${s} .gc-edge { stroke-dasharray: var(--gc-len) !important;
  animation: gc-draw ${(o.duration * 1.1).toFixed(2)}s ${ease} var(--gc-t, 0s) both; }

@keyframes gc-rise { from { opacity: 0; translate: 0 14px; scale: .965; } to { opacity: 1; translate: 0 0; scale: 1; } }
@keyframes gc-settle { from { opacity: 0; scale: .99; } to { opacity: .999; scale: 1; } }
@keyframes gc-fade { from { opacity: 0; translate: 0 5px; } to { opacity: 1; translate: 0 0; } }
@keyframes gc-draw { from { stroke-dashoffset: var(--gc-len); } to { stroke-dashoffset: 0; } }

${s} .gc-marker { animation: gc-fade ${(o.duration * 0.5).toFixed(2)}s ${ease} var(--gc-t, 0s) both; }
`;

  const flow =
    o.preset === 'flow' || o.loop
      ? `
${s} .gc-flow { fill: none; stroke: ${hsl(p.primary)}; stroke-width: 3px; stroke-linecap: round;
  opacity: .9; pointer-events: none;
  stroke-dasharray: 14px var(--gc-len) !important;
  animation: gc-travel 2.6s linear var(--gc-t, 0s) ${once ? '1 forwards' : 'infinite'};
  filter: drop-shadow(0 0 4px ${hsl(p.primary, 0.55)}); }
@keyframes gc-travel {
  from { stroke-dashoffset: var(--gc-len); opacity: 0; }
  12% { opacity: .9; }
  88% { opacity: .9; }
  to { stroke-dashoffset: calc(var(--gc-len) * -1); opacity: 0; }
}
`
      : '';

  const spotlight =
    o.preset === 'spotlight'
      ? `
${s} .gc-node { animation-name: gc-rise, gc-pulse;
  animation-duration: ${o.duration}s, ${cycle}s;
  animation-delay: var(--gc-t, 0s), calc(${arrival.toFixed(2)}s + var(--gc-wave, 0) * .45s);
  animation-iteration-count: 1, ${once ? '1' : 'infinite'};
  animation-fill-mode: both, ${once ? 'forwards' : 'none'};
  animation-timing-function: ${ease}, ease-in-out; }
@keyframes gc-pulse {
  0%, ${spotlightWindow.toFixed(2)}% { scale: 1; }
  ${(spotlightWindow / 2).toFixed(2)}% { scale: 1.035; }
  100% { scale: 1; }
}
`
      : '';

  const body = motion + flow + spotlight;
  return o.respectReducedMotion
    ? `@media (prefers-reduced-motion: no-preference) {\n${body}\n}\n`
    : body;
}

/**
 * DESIGN 8.4: stop a finished chart's motion from restarting, for a family
 * this file did not itself bake.
 *
 * `bake()` above only ever draws the generic/legacy chart types (`render.ts`'s
 * mermaid-restyle path) — every native family (the flowchart timeline in
 * `motion.ts`, and the sankey/treemap/kanban, quadrant/radar/xy,
 * timeline/gantt/journey, pie/mindmap and git-graph families that copy its
 * shape) schedules its whole build as one repeating keyframe per element:
 * `<selector>{animation:<name> <cycle>s <ease> infinite}`, with no fill-mode
 * to fall back on. Those files are called from `flow.ts`, which has no
 * option to ask for anything but the loop — plumbing one through would mean
 * editing `flow.ts` and the six family files it drives, which sit outside
 * this change (see `AGENTS.md`'s repo map: `flow.ts` is owned elsewhere).
 * Applying the same rewrite `bake()` does at the source, once, to the
 * *finished* stylesheet reaches every one of them for free, because they all
 * emit that identical shape: every such shorthand's trailing `infinite`
 * becomes `1 forwards`, holding each track's own final keyframe instead of
 * snapping back to frame zero the instant the single pass ends.
 *
 * `'in-view'` additionally marks the `<svg>` with `data-gc-play="in-view"`
 * and pauses everything under it until a host calls
 * `geekchart/observe`'s `playInView()`, which flips on the
 * `data-gc-playing` attribute the first time the chart is 40% on screen.
 * There is no way to hide that requirement from a host that never runs any
 * script: a `<noscript>` reader gets the finished frame only if their OS
 * also asks for reduced motion (the `@media` rule below, and the fact that
 * every animation this renderer emits already sits behind
 * `prefers-reduced-motion: no-preference` — see `motion.ts`'s file
 * comment); with motion turned on and no script, the chart stays paused at
 * frame zero. Callers that ship `renderToSvg`/`renderToHtml` output to a
 * page with no JavaScript at all must pass `play: 'once'` instead.
 */
/**
 * The extra rule an `'in-view'` chart's own stylesheet needs: paused until a
 * host flips on `data-gc-playing` (`geekchart/observe`'s `playInView()`), and
 * a `prefers-reduced-motion: reduce` insurance policy that holds even if some
 * future rule ever escapes the `no-preference` gate every animation in this
 * renderer already sits behind.
 */
export function playModeCss(play: PlayMode): string {
  if (play !== 'in-view') return '';
  return (
    `\n[data-gc-play="in-view"]:not([data-gc-playing]) * { animation-play-state: paused; }\n` +
    `@media (prefers-reduced-motion: reduce) {\n` +
    `  [data-gc-play] * { animation-duration: 0s !important; animation-delay: 0s !important; }\n}\n`
  );
}

export function applyPlayMode(
  result: { svg: string; css: string },
  play: PlayMode,
): { svg: string; css: string } {
  if (play === 'loop') return result;
  // Only this renderer's own animations — every one it emits names a
  // `gc-`-prefixed keyframe (`gc-travel`, `gc-tN`, `gc-cN`, ...; see
  // `scope.ts`'s note on that prefix). The legacy render path also embeds
  // mermaid's *own* CSS verbatim, which ships an unrelated, never-applied
  // `dash`/`edge-animation-*` pair that also loops forever — narrowing the
  // match to `gc-` names leaves that alone.
  const held = result.css.replace(/(animation:\s*gc-[\w-]*[^;{}]*?)\binfinite\b/g, '$1 1 forwards');
  const svg = result.svg.replace(/^(<svg\b[^>]*?)(\s*\/?>)/, (whole, head: string, close: string) =>
    /\sdata-gc-play=/.test(head) ? whole : `${head} data-gc-play="${play}"${close}`,
  );
  return { svg, css: held + playModeCss(play) };
}
