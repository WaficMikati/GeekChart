import mermaid from 'mermaid';
import elkLayouts from '@mermaid-js/layout-elk';
import type { AnimationOptions, ParseError, RenderOptions, RenderResult } from './types.ts';
import { repair } from './repair.ts';
import { metricsCss, themeCss, themeVariables, toAttributeSelectors } from './theme.ts';
import { analyze } from './analyze.ts';
import { decorate } from './decorate.ts';
import { normalize } from './normalize.ts';
import { styles } from './styles.ts';
import { bake, defaultAnimation } from './animate.ts';
import { ensureFonts } from './fonts.ts';
import { standaloneHtml } from './export.ts';
import { CANVAS, fitCanvas, frameTransform } from './scene.ts';
import { ChartError } from './chart-error.ts';

export { ChartError };

export const defaultOptions: RenderOptions = {
  theme: 'light',
  style: 'blueprint',
  animation: defaultAnimation,
  width: 900,
  padding: 24,
  panel: true,
};

let elkRegistered = false;
/** ELK is a layout engine, not a renderer; registering is idempotent and cheap. */
function registerElk(): void {
  if (elkRegistered) return;
  try {
    mermaid.registerLayoutLoaders(elkLayouts);
    elkRegistered = true;
  } catch {
    // Without it we fall back to dagre, which lays out but routes poorly.
  }
}

let counter = 0;
/** Deterministic ids keep golden-image tests stable across runs. */
function nextId(): string {
  return `gc-chart-${++counter}`;
}

/** Reset between test cases so ids stay predictable. */
export function resetIds(): void {
  counter = 0;
}

/**
 * Pull a line number out of whatever mermaid threw.
 *
 * Mermaid's errors are not a stable API — sometimes a jison parse error with a
 * `hash`, sometimes a plain Error. Both shapes are handled, and if neither
 * matches we still return the raw message rather than swallowing it.
 */
function toParseError(err: unknown, source: string): ParseError {
  const raw = err instanceof Error ? err.message : String(err);
  const hash = (err as { hash?: { line?: number; loc?: { first_column?: number } } } | null)?.hash;
  let line = typeof hash?.line === 'number' ? hash.line + 1 : undefined;
  if (line === undefined) {
    const m = /(?:on |at )line[: ]+(\d+)/i.exec(raw);
    if (m) line = Number(m[1]);
  }
  const excerpt = line ? source.split('\n')[line - 1]?.trim() : undefined;
  // Mermaid's own messages carry the whole expectation grammar; the first
  // paragraph is the part a human can act on.
  const message = raw.split('\n').slice(0, 3).join('\n').trim() || 'Mermaid could not parse this diagram.';
  return {
    message,
    ...(line !== undefined ? { line } : {}),
    ...(hash?.loc?.first_column !== undefined ? { column: hash.loc.first_column + 1 } : {}),
    ...(excerpt ? { excerpt } : {}),
  };
}

/**
 * Give the SVG a real pixel size taken from its viewBox.
 *
 * Mermaid leaves the element at `width: 100%`, which has no intrinsic size, so
 * any `fit-content` container around it collapses or overshoots. Scaling up to
 * the requested width is capped, because a three-box diagram blown up to 900px
 * ends up with strokes like tree trunks.
 */
function sizeToWidth(svg: SVGSVGElement, width: number): void {
  const box = svg.viewBox.baseVal;
  const natural = box.width || svg.getBoundingClientRect().width || width;
  const height = box.height || svg.getBoundingClientRect().height;
  // Upscaling is capped hard. Mermaid's natural sizing is already legible, and
  // stretching a small state diagram to fill a 900px panel makes the type and
  // the arrowheads look enormous.
  const target = Math.min(width, natural * 1.35);
  const scale = target / natural;
  svg.setAttribute('width', target.toFixed(1));
  if (height) svg.setAttribute('height', (height * scale).toFixed(1));
  svg.style.maxWidth = '100%';
  svg.style.height = 'auto';
}

/**
 * Put a restyled mermaid diagram on the same canvas as every drawn one.
 *
 * DESIGN 1.1 is a property of the library, not of one renderer: type reads the
 * same size across the set only if every chart is shown at the same width. A
 * diagram left at its own 411-unit bounds is displayed at 411px next to a
 * 1000px one, and its 14px labels are twice the size of everyone else's.
 *
 * This does not make these three diagrams *drawn* — they still fail 7.6 until
 * their own renderers exist — but it stops them breaking the scale for the rest.
 */
function frameToCanvas(svg: SVGSVGElement): void {
  const box = svg.getBBox?.();
  if (!box || !box.width) return;
  const m = CANVAS.margin;
  const frame = fitCanvas(
    { x: box.x - m, y: box.y - m, width: box.width + m * 2, height: box.height + m * 2 },
    CANVAS,
  );
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  group.setAttribute('class', 'gc-frame');
  group.setAttribute('transform', frameTransform(frame));
  for (const child of [...svg.childNodes]) {
    const tag = (child as Element).tagName;
    // `defs` and `style` carry no geometry; moving them would only make the
    // markup harder to read.
    if (tag === 'defs' || tag === 'style') continue;
    group.appendChild(child);
  }
  svg.appendChild(group);
  svg.setAttribute('viewBox', `0 0 ${frame.width} ${frame.height}`);
  svg.setAttribute('width', String(frame.width));
  svg.setAttribute('height', String(frame.height));
  svg.style.maxWidth = '100%';
  svg.style.height = 'auto';
}

/** Off-screen but still laid out — `getBBox` and friends need real geometry. */
function offscreenHost(): HTMLElement {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'position:fixed;left:-100000px;top:0;width:2400px;opacity:0;pointer-events:none;';
  document.body.appendChild(host);
  return host;
}

export interface RenderInput extends Partial<RenderOptions> {
  /** Render into this element instead of an off-screen host. */
  host?: HTMLElement;
  /** Use foreignObject labels. Prettier wrapping, less portable `.svg`. */
  htmlLabels?: boolean;
  /** Add the replay button to the exported page. Off while capturing video. */
  interactive?: boolean;
  /** Link Google Fonts from the exported page. */
  webFonts?: boolean;
  /** Override the layout engine for this render. */
  layout?: 'dagre' | 'elk';
  /** Override how edges are drawn. Mostly an escape hatch for comparisons. */
  edgeRouting?: 'ports' | 'preserve';
}

/**
 * Paste in, animated chart out.
 *
 * Runs in a browser — including the headless one the CLI drives — so the web
 * preview and the exported video come from exactly the same code path. There is
 * no second renderer to drift out of sync.
 */
export async function renderChart(input: string, opts: RenderInput = {}): Promise<RenderResult> {
  const options: RenderOptions = {
    ...defaultOptions,
    ...opts,
    animation: { ...defaultAnimation, ...(opts.animation ?? {}) } as AnimationOptions,
  };

  const { source, notes } = repair(input);
  if (!source.trim()) {
    throw new ChartError({ message: 'Nothing to draw — the diagram is empty.' });
  }

  // Before anything is measured — see fonts.ts for why this ordering matters.
  await ensureFonts();
  registerElk();

  const id = nextId();
  const spec = styles[options.style];
  const variables = themeVariables(options.theme, options.style);
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: variables,
    fontFamily: variables.fontFamily,
    // Mermaid reads this per diagram type, and in v11 the flowchart block alone
    // is not enough — foreignObject labels come back unless it is set here too.
    htmlLabels: opts.htmlLabels ?? false,
    // Mermaid measures label widths against its own stylesheet. Anything of ours
    // that changes text metrics has to be visible to it at that moment, or every
    // box is sized for a font we are not going to draw with.
    themeCSS: metricsCss(options.style),
    layout: opts.layout ?? spec.layout.engine,
    elk: {
      mergeEdges: false,
      nodePlacementStrategy: 'BRANDES_KOEPF',
    },
    flowchart: {
      htmlLabels: opts.htmlLabels ?? false,
      // Straight segments through dagre's own route points. The geometry pass
      // rounds the corners afterwards, which gives a cleaner line than any of
      // mermaid's curve fits and keeps the route it computed.
      curve: 'linear',
      padding: spec.layout.padding,
      nodeSpacing: spec.layout.nodeSpacing,
      rankSpacing: spec.layout.rankSpacing,
      wrappingWidth: spec.layout.wrappingWidth,
      useMaxWidth: true,
    },
    sequence: { useMaxWidth: true, actorMargin: 64, boxMargin: 12, mirrorActors: false },
    er: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
    class: { useMaxWidth: true },
    state: { useMaxWidth: true },
    journey: { useMaxWidth: true },
  });

  // Validate before rendering: a parse error here is a clean, located message,
  // where a render error is a stack trace and a broken DOM node.
  try {
    await mermaid.parse(source);
  } catch (err) {
    throw new ChartError(toParseError(err, source));
  }

  let markup: string;
  try {
    ({ svg: markup } = await mermaid.render(id, source));
  } catch (err) {
    throw new ChartError(toParseError(err, source));
  }

  const host = opts.host ?? offscreenHost();
  const owned = !opts.host;
  host.innerHTML = markup;
  const svg = host.querySelector('svg');
  if (!svg) {
    if (owned) host.remove();
    throw new ChartError({ message: 'Mermaid returned no SVG. This is a bug — please report it.' });
  }

  try {
    svg.id = id;
    svg.classList.add('gc-chart');
    svg.setAttribute('role', 'img');
    sizeToWidth(svg, options.width);

    // Layout first, then geometry, then measure again: normalising the boxes
    // moves everything the animation timing is derived from.
    const draft = analyze(svg, source);
    normalize(
      svg,
      draft,
      opts.edgeRouting ? { ...spec.geometry, edgeRouting: opts.edgeRouting } : spec.geometry,
      id,
    );

    const analysis = analyze(svg, source);
    const animation = bake(svg, analysis, options.theme, options.animation);
    decorate(svg, analysis, spec, id);
    frameToCanvas(svg);
    const css = themeCss(id, options.theme, options.style) + animation.css;

    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = toAttributeSelectors(css);
    svg.insertBefore(style, svg.firstChild);

    const serialized = new XMLSerializer().serializeToString(svg);
    return {
      svg: serialized,
      css,
      html: standaloneHtml(serialized, {
        ...options,
        ...(opts.interactive !== undefined ? { interactive: opts.interactive } : {}),
        ...(opts.webFonts !== undefined ? { webFonts: opts.webFonts } : {}),
      }),
      analysis,
      repairs: notes,
      runtime: animation.runtime,
    };
  } finally {
    if (owned) host.remove();
  }
}
