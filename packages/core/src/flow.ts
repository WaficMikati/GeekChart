import { toGraph, type Graph } from './graph.ts';
import { toUnifiedGraph, type UnifiedType } from './unified.ts';
import { layout, type Measurer } from './layout.ts';
import { draw, type Drawing } from './draw.ts';
import { animate } from './motion.ts';
import { applySpeed } from './animate.ts';
import {
  fitCanvas,
  frameTransform,
  inheritsFonts,
  scenes,
  withFonts,
  withPalette,
  type Canvas,
  type FontOptions,
  type Palette,
  type Scene,
  type SceneName,
} from './scene.ts';
import { ensureFonts } from './fonts.ts';
import { drawSequence, sequenceCss } from './sequence.ts';
import { chronicleCss, drawChronicle, toChronicle, type ChronicleKind } from './chronicle.ts';
import { drawPlot, plotCss, toPlot, type PlotKind } from './plot.ts';
import { boardCss, drawBoard, toBoard, type BoardKind } from './boards.ts';
import { drawRadial, radialCss, toRadial, type RadialKind } from './radial.ts';
import { commitsCss, drawCommits, toCommits, type CommitKind } from './commits.ts';

/**
 * Parse, place, draw.
 *
 * The whole flowchart path in one function, so it is obvious that mermaid is
 * only the first step and nothing downstream reads its rendering.
 */

export interface FlowResult {
  svg: string;
  css: string;
  html: string;
  graph: Graph;
  drawing: Drawing;
  /** Things worth telling the user that are not errors. */
  warnings: string[];
  /** Seconds for one loop of the animation; 0 when motion is off. */
  cycle: number;
}

export function sceneCss(scene: Scene): string {
  return `
/* Every colour that depends on the page around the chart is a custom property
   whose fallback is this scene's own value. Nothing changes unless a host sets
   one, and a host that does needs no rebuild — which is what makes a baked
   component survive a site's light/dark toggle, where the chart cannot know
   which way the toggle went.

     #gc-my-chart { --gc-ink: #17202A; --gc-bg: #FFFFFF; }
*/
/* Fit inside the frame rather than filling its width. A tall diagram forced to
   the full width scales its type up to billboard size. */
.gc-chart { display: block; max-width: 100%; max-height: 100%; width: auto; height: auto;
  overflow: visible; -webkit-font-smoothing: antialiased; }

/* One hue per node, chosen by its role, then read by everything the node owns —
   outline, tint, core, marks. Before this each of those needed its own pair of
   role rules, and they drifted apart.
   Off the primary path is the default, and it reads as quiet — DESIGN 5.1
   ("quiet is one grey") and 5.3 (a second hue is earned by a legend-explained
   category, never spent on "everything that isn't the one accent"). Only
   gc-role-path spends the chart's one accent (DESIGN 5.2). gc-role-alt is left
   as a hook for a chart that genuinely has an explained second category — nothing
   sets it today, so it currently renders identically to the default. */
.gc-node { --gc-hue: var(--gc-quiet, ${scene.quiet}); }
.gc-node.gc-role-path { --gc-hue: var(--gc-path, ${scene.path}); }
.gc-node.gc-role-alt  { --gc-hue: var(--gc-alt, ${scene.alt}); }

.gc-outline { fill: none; stroke: var(--gc-hue); stroke-width: ${scene.nodeStroke}px;
  stroke-linejoin: round; stroke-linecap: round; }
.gc-fill { fill: var(--gc-hue); stroke: none; fill-opacity: .12; }
.gc-core { fill: var(--gc-hue); stroke: none; }

/* The second channel. Silhouette says what a node is; this says it again in a
   way that still reads when the chart is a thumbnail in a feed. */
.gc-kind-terminal .gc-fill { fill-opacity: .18; }
.gc-kind-datastore .gc-fill { fill-opacity: .11; }
.gc-kind-marker .gc-fill { fill-opacity: 1; }
/* Something outside the system we are describing recedes: neutral, never a role
   colour, so a coloured node always means "ours". */
.gc-kind-external { --gc-hue: var(--gc-quiet, ${scene.quiet}); }
.gc-kind-note { --gc-hue: var(--gc-quiet, ${scene.quiet}); }
.gc-kind-note .gc-fill { fill-opacity: .07; }
.gc-kind-note .gc-title { fill: var(--gc-quiet, ${scene.quiet}); font-size: ${scene.type.caption}px;
  font-family: ${scene.rowFont}; }

.gc-title { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.titleFont}; font-weight: ${scene.type.nameWeight};
  font-size: ${scene.type.name}px; text-anchor: middle; }
/* Sentence case, not caps: a caption is a phrase ("forms · interviews"), and
   setting a phrase in caps makes it read as a category label. DESIGN §3. */
.gc-caption { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.captionFont};
  font-size: ${scene.type.caption}px; letter-spacing: ${scene.captionTracking};
  text-anchor: middle; }

/* Compartment rows. Left-aligned and monospaced because they are declarations —
   a centred column of member names is unreadable as a list. */
.gc-row { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.rowFont}; font-size: ${scene.type.caption}px;
  text-anchor: start; opacity: .82; }
.gc-row-strong { fill: var(--gc-quiet, ${scene.quiet}); letter-spacing: .08em; }
.gc-divider { fill: none; stroke: var(--gc-hue); stroke-width: ${scene.dividerStroke}px; opacity: .5; }

/* Edges stay neutral in both scenes. Colour is reserved for the nodes and for
   emphasis, so a coloured line always means something. */
.gc-edge { fill: none; stroke: var(--gc-edge, ${scene.edge}); stroke-width: ${scene.edgeStroke}px;
  stroke-linecap: round; }
.gc-stroke-dotted { stroke-dasharray: 1.5 6; }
.gc-stroke-thick  { stroke-width: ${scene.edgeStroke * 1.8}px; }

.gc-edge-label text { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.edgeLabelFont};
  font-size: ${scene.type.label}px; letter-spacing: ${scene.edgeLabelTracking};
  text-anchor: middle; ${scene.edgeLabelUpper ? 'text-transform: uppercase;' : ''} }
.gc-plate { fill: var(--gc-bg, ${scene.bg}); }
.gc-arrow { fill: var(--gc-edge, ${scene.edge}); stroke: none; }
/* Hollow tips — inheritance triangles, crow's feet, cardinality bars — are
   stroked shapes, so the same class has to be able to mean either. */
.gc-tip-line { fill: none; stroke: var(--gc-edge, ${scene.edge}); stroke-width: ${scene.edgeStroke}px;
  stroke-linecap: round; stroke-linejoin: round; }
.gc-arrow-marker { fill: none; stroke: transparent; }

/* A cardinality belongs to the end it sits beside, so it is set small and tight
   rather than plated like a mid-line label. */
.gc-card { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.rowFont};
  font-size: ${scene.type.label}px; letter-spacing: ${scene.type.labelTracking};
  text-anchor: middle; }

/* The travelling pulse is hidden at rest. This has to live outside the motion
   layer: with reduced motion the animation never runs, and a spark left at its
   default opacity parks on the start of its edge as a stray dot. */
.gc-spark { fill: var(--gc-accent, ${scene.accent}); opacity: 0; }

.gc-cluster-box { fill: none; stroke: var(--gc-quiet, ${scene.quiet}); stroke-width: ${scene.clusterStroke}px;
  opacity: .85; }
/* The panel's name is the chart's loudest text (DESIGN 10.1), so this is the
   one place the title size from §3 is used inside a drawing. */
.gc-cluster-title { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.titleFont};
  font-weight: ${scene.type.titleWeight}; font-size: ${scene.type.title}px;
  letter-spacing: ${scene.type.titleTracking}; text-anchor: middle; }
.gc-cluster-kicker { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.clusterFont};
  font-size: ${scene.type.kicker}px; letter-spacing: ${scene.type.kickerTracking};
  text-anchor: middle; text-transform: uppercase; }
.gc-cluster-rule { fill: none; stroke: var(--gc-quiet, ${scene.quiet}); stroke-width: ${scene.dividerStroke}px;
  opacity: .5; }

/* Figure and ground swap inside a panel. The cards there are filled rather than
   outlined, so the hierarchy is carried by weight instead of by another colour —
   which is what stops a grouped diagram reading as a wall of identical boxes. */
.gc-in-panel .gc-outline { stroke: none; }
.gc-in-panel .gc-fill { fill: var(--gc-surface, ${scene.surface}); fill-opacity: 1; }
.gc-in-panel .gc-title { fill: var(--gc-ink, ${scene.ink}); }
.gc-in-panel .gc-caption { fill: var(--gc-quiet, ${scene.quiet}); }
`;
}

/**
 * Put the drawing on the canvas. DESIGN 1.1, 1.3, 1.4.
 *
 * Two jobs that have to happen together. The frame is the canvas — 1000 wide,
 * always, so a name set at 12 units is 12px on screen in every chart in the
 * library — and the drawing is centred inside it with the outer margin clear.
 *
 * The bounds used to be measured rather than taken from the layout, with a
 * `getBBox()` on the assembled SVG: ELK reports where it put the *nodes*, and a
 * retry edge bows below the bottom row, an arrowhead reaches past the box it
 * points at. Framing to the layout's size alone silently crops both. That
 * `getBBox()` needed a browser — a hidden div, mounted and measured — for a
 * question `draw()` already has the answer to: it placed every node, panel,
 * edge and label plate, so `drawing.extent` is their union, computed the same
 * way whether this runs in a browser or in Node. See
 * `packages/cli/scripts/spike-node.mjs` for a side-by-side comparison against
 * the real `getBBox()`-measured browser render.
 */
function fitToCanvas(
  svg: string,
  canvas: Canvas,
  extent: Drawing['extent'],
  display: number,
): string {
  if (!extent.width) return svg;
  const m = canvas.margin;
  const frame = fitCanvas(
    { x: extent.x - m, y: extent.y - m, width: extent.width + m * 2, height: extent.height + m * 2 },
    canvas,
  );
  const open = svg.match(/^<svg[^>]*>/);
  const close = svg.endsWith('</svg>');
  if (!open || !close) return svg; // not the shape `draw()` produces — leave it alone
  const inner = svg.slice(open[0].length, -'</svg>'.length);
  // One group holding everything, so the offset is a single transform rather
  // than an offset baked into every coordinate — which would put the drawing
  // and the motion layer's `--gc-cx` hints in different spaces.
  const wrapped = `<g class="gc-frame" transform="${frameTransform(frame)}">${inner}</g>`;
  // Intrinsic width/height, so `max-height` on the frame can actually hold it.
  // Without them the SVG has no natural size and stretches to fill any width,
  // which turns a tall diagram into a billboard.
  // `data-display` is the declared width (DESIGN 1.1) this chart was laid
  // out for — 1000 (this canvas's own default) when no caller named one —
  // so the gate can read the same cap the layout itself packed to, at
  // DESIGN 3.1's min(760, display) rather than a flat 760.
  const openTag = open[0]
    .replace(/\s+viewBox="[^"]*"/, '')
    .replace(/\s+width="[^"]*"/, '')
    .replace(/\s+height="[^"]*"/, '')
    .replace(
      />$/,
      ` data-display="${display}" viewBox="0 0 ${frame.width} ${frame.height}" width="${frame.width}" height="${frame.height}">`,
    );
  return `${openTag}${wrapped}</svg>`;
}

/** Every diagram type the drawn pipeline handles. */
export type DrawnType =
  | 'flowchart'
  | UnifiedType
  | 'sequence'
  | ChronicleKind
  | PlotKind
  | BoardKind
  | RadialKind
  | CommitKind;

/**
 * Frames a social post is actually published in.
 *
 * A diagram rendered to its own bounds is the wrong shape for every feed it
 * lands in, and gets cropped by whoever posts it. Naming the frame up front
 * makes the diagram fit the destination instead.
 */
export type Aspect = 'auto' | '16:9' | '1:1' | '4:5' | '9:16';

export const ASPECTS: Record<Exclude<Aspect, 'auto'>, number> = {
  '16:9': 16 / 9,
  '1:1': 1,
  '4:5': 4 / 5,
  '9:16': 9 / 16,
};

export interface FlowOptions {
  scene?: SceneName;
  /** Which parser to read. Defaults to a flowchart. */
  kind?: DrawnType;
  /** Fit the diagram into a fixed frame rather than its own bounds. */
  aspect?: Aspect;
  /**
   * Which typefaces to draw in. `'inherit'` hands every role to the host page,
   * which is what an embedded chart usually wants.
   */
  fonts?: FontOptions | 'inherit';
  /**
   * Measure text with this instead of building the usual hidden-SVG browser
   * measurer. The one non-browser caller today is `makeNodeMeasurer` in
   * `./node/measure.ts`, which reads the embedded font files directly with
   * fontkit — see `docs/dev/` for what that does and does not match. Wins over
   * `fonts.measureWith`, since naming an actual measurer is more specific than
   * naming a stack for one to be built from.
   */
  measurer?: Measurer;
  /**
   * Override any of the scene's seven colours. Everything left out keeps the
   * scene's value, so a single accent swap is a one-line change.
   */
  palette?: Palette;
  /** Frame the diagram is fitted into, rather than stretched to. */
  width?: number;
  height?: number;
  /** Draw the finished frame with no animation. */
  motion?: boolean;
  /**
   * The width, in CSS px, this chart will actually be shown at — a narrow
   * blog column, say. DESIGN 1.1: the canvas is capped to this instead of
   * the default 1000 (1200 for boards), and the layout packs to fit it
   * (DESIGN 1.5's leaf stacking, then DESIGN 1.2's chain fold) before
   * anything is scaled down to match. Unset behaves exactly as before.
   */
  display?: number;
  /**
   * DESIGN 8.6: stretch or hurry the whole build by one multiplier — `0.5`
   * plays at half speed, `2` at double, `1` (the default) is the designed
   * timing. Clamped to 0.25–4. Order, easing and lag ratios never change;
   * see `animate.ts`'s `applySpeed`, applied once here, after each family's
   * own CSS and cycle are final and before the standalone page embeds them.
   * If `duration` is also given, `duration` wins and this is ignored.
   */
  speed?: number;
  /**
   * DESIGN 8.6: the writer-facing form of `speed` — "play the build in about
   * this many seconds" instead of a multiplier. `chart.ts`'s `render()` is
   * the one place this is resolved: it renders once to learn the chart's own
   * natural cycle, derives the 8.6 multiplier from it (`animate.ts`'s
   * `speedForDuration`, same 0.25–4 clamp), and renders again at that speed —
   * so `duration` is honoured exactly when the clamp allows, and as closely
   * as the clamp allows otherwise. Wins over `speed` when both are given.
   */
  duration?: number;
}

/**
 * The scene to start from.
 *
 * 4geeks is the default rather than Manim: Manim was the measuring stick for the
 * motion and the rigour, but this tool draws 4geeks' charts, and a default that
 * needs overriding on every call is the wrong default.
 */
function pickScene(options: FlowOptions): Scene {
  return scenes[options.scene ?? 'geeks'];
}

/**
 * What `inherit` resolves to for this render.
 *
 * Undefined means "whatever this document already uses", which is the right
 * answer whenever the chart is being laid out in the very page it will be shown
 * in — the live component and the preview app both are, so there an inherited
 * font is measured and displayed as the same font by construction.
 *
 * Only a caller baking a chart for somewhere else has to name a stack, because
 * only it is measuring in one document and displaying in another.
 */
function measurementStack(options: FlowOptions): string | undefined {
  if (!inheritsFonts(options.fonts)) return undefined;
  return options.fonts !== 'inherit' ? options.fonts?.measureWith : undefined;
}

/**
 * What every render function actually measures with: the caller's own
 * `Measurer` (the Node one, most often) if it gave one, otherwise the usual
 * stack name that `makeMeasurer` turns into a hidden-SVG measurer.
 */
function measurerFor(options: FlowOptions): string | Measurer | undefined {
  return options.measurer ?? measurementStack(options);
}

const GENERIC = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'ui-rounded',
  'inherit',
  'initial',
]);

/**
 * Is this family actually installed here?
 *
 * `document.fonts.check()` is no help: it answers "can this be rendered", and
 * since an unknown family always falls back to something, the answer is always
 * yes. The only reliable test is the one this whole renderer is built on —
 * measure and compare. A family that is present will draw a probe string at a
 * different width from at least one generic; one that is absent *is* the
 * generic, so all three comparisons match.
 */
function fontPresent(family: string): boolean {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return true; // no way to tell; do not cry wolf
  const probe = 'mmmmmmmmmmlliWWWW0123456789';
  const widthIn = (stack: string): number => {
    context.font = `24px ${stack}`;
    return context.measureText(probe).width;
  };
  return ['monospace', 'serif', 'sans-serif'].some(
    (generic) => widthIn(`"${family}", ${generic}`) !== widthIn(generic),
  );
}

/**
 * Check that the font we are about to measure against actually exists here.
 *
 * This is the quiet failure at the heart of `measureWith`: naming a stack the
 * render host has never heard of does not fail, it silently measures the
 * fallback. The chart is then sized for a font nobody will ever see it in, and
 * nothing anywhere says so.
 *
 * Archivo, Lato, Source Serif 4 and JetBrains Mono are embedded, so naming any
 * of those always measures the real face. Anything else has to be installed
 * where the render runs.
 */
function checkMeasurementFont(stack: string | Measurer | undefined): string[] {
  // An injected `Measurer` (the Node one, or a reused browser one) is not a
  // stack name — there is nothing here to check it against, and the check
  // this runs (`fontPresent`, below) means nothing off a live `document`
  // anyway.
  if (!stack || typeof stack === 'object' || typeof document === 'undefined') return [];
  const first = stack
    .split(',')[0]
    ?.trim()
    .replace(/^["']|["']$/g, '');
  if (!first || GENERIC.has(first.toLowerCase())) return [];
  if (fontPresent(first)) return [];
  return [
    `"${first}" is not installed where this rendered, so the diagram was sized ` +
      `with a fallback face instead. Its boxes may not fit their labels on a page ` +
      `that really has ${first}. Install it here, or measure against one of the ` +
      `fonts geekchart embeds: Archivo, Lato, Source Serif 4, JetBrains Mono.`,
  ];
}

/**
 * DESIGN 1.7: a chart laid out for a phone (display ≤ 480) that is taller
 * than twice its width is about two screens of scrolling; say so, in the
 * words an editor can show the writer. Read from the finished frame's
 * viewBox so it counts what the reader gets, label room included.
 */
export function phoneHeightWarning(svg: string, display: number | undefined): string[] {
  if (!display || display > 480) return [];
  const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!m) return [];
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (height <= width * 2) return [];
  const screens = (height / (width * 2)).toFixed(1);
  return [
    `1.7 on a ${display}px phone this chart is about ${screens} screens tall — keep phone charts to two screens (fewer boxes, or two short charts)`,
  ];
}

/** The standalone page both drawn renderers emit: same frame, same caps. */
function page(svg: string, css: string, scene: Scene, options: FlowOptions): string {
  // A chart that inherits its fonts has nothing to inherit from in a page of its
  // own, and would fall back to the browser's default serif — which is not what
  // it was measured in. Naming the measurement stack on the body makes the
  // standalone page show exactly what the embedded chart will show.
  const inherited = measurementStack(options);
  const aspect = options.aspect && options.aspect !== 'auto' ? options.aspect : null;
  const width = options.width ?? 1200;
  // A staged frame is an exact box the diagram is centred in, so the capture —
  // which clips to the figure — comes out at the posting aspect every time.
  // Without one the figure is only as wide as it needs to be.
  const stage = aspect
    ? `.gc-figure { width: ${width}px; height: ${Math.round(width / ASPECTS[aspect])}px;
  display: grid; place-items: center; padding: 4%; }
.gc-figure .gc-chart { max-width: 100%; max-height: 100%; width: auto; height: auto; }`
    : `.gc-figure { margin: 0; display: flex; align-items: center; justify-content: center;
  width: min(${width}px, 100%); }
/* Both caps in real units. A percentage max-height resolves against a height the
   figure is still deriving from this element, so it never constrains anything. */
.gc-figure .gc-chart { max-width: 100%; max-height: ${options.height ?? 720}px;
  width: auto; height: auto; }`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chart</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
  background: ${scene.bg}; padding: ${aspect ? '0' : '40px 24px'};
  ${inherited ? `font-family: ${inherited};` : ''} }
.gc-figure { margin: 0; background: ${scene.bg}; }
${stage}
${css}
</style></head>
<body><figure class="gc-figure">${svg}</figure></body></html>`;
}

/**
 * A sequence diagram, which owns its layout and its timeline but shares
 * everything else — the palette, the type, the page, the export path.
 */
export async function renderSequence(
  source: string,
  options: FlowOptions = {},
): Promise<SequenceRender> {
  await ensureFonts(options.fonts);
  const scene = withPalette(withFonts(pickScene(options), options.fonts), options.palette);
  const measureWith = measurerFor(options);
  const drawn = await drawSequence(source, scene, measureWith);
  const motion = options.motion === false ? '' : drawn.css;
  const rawCss = sceneCss(scene) + sequenceCss(scene) + motion;
  const sped = applySpeed(
    { svg: drawn.drawing.svg, css: rawCss, cycle: options.motion === false ? 0 : drawn.cycle },
    options.speed,
  );
  return {
    svg: sped.svg,
    css: sped.css,
    html: page(sped.svg, sped.css, scene, options),
    participants: drawn.drawing.participants.length,
    messages: drawn.drawing.messages,
    cycle: sped.cycle,
    summary:
      `Sequence diagram between ${drawn.drawing.labels.join(', ')}. ` +
      `${drawn.drawing.messages} message${drawn.drawing.messages === 1 ? '' : 's'}.`,
    warnings: checkMeasurementFont(measureWith),
  };
}

/**
 * Timeline, gantt and journey. Same page and export path as everything else;
 * only the drawing and the axis are their own.
 */
export async function renderChronicle(
  source: string,
  kind: ChronicleKind,
  options: FlowOptions = {},
): Promise<ChronicleRender> {
  await ensureFonts(options.fonts);
  const scene = withPalette(withFonts(pickScene(options), options.fonts), options.palette);
  const measureWith = measurerFor(options);
  const drawn = drawChronicle(await toChronicle(source, kind), scene, measureWith);
  const motion = options.motion === false ? '' : drawn.css;
  const rawCss = sceneCss(scene) + chronicleCss(scene) + motion;
  const sped = applySpeed(
    { svg: drawn.svg, css: rawCss, cycle: options.motion === false ? 0 : drawn.cycle },
    options.speed,
  );
  return {
    svg: sped.svg,
    css: sped.css,
    html: page(sped.svg, sped.css, scene, options),
    lanes: drawn.lanes,
    items: drawn.items,
    cycle: sped.cycle,
    summary: drawn.summary,
    warnings: checkMeasurementFont(measureWith),
  };
}

/** Sankey, treemap and kanban. */
export async function renderBoard(
  source: string,
  kind: BoardKind,
  options: FlowOptions = {},
): Promise<ChronicleRender> {
  await ensureFonts(options.fonts);
  const scene = withPalette(withFonts(pickScene(options), options.fonts), options.palette);
  const measureWith = measurerFor(options);
  const drawn = drawBoard(await toBoard(source, kind), scene, measureWith);
  const motion = options.motion === false ? '' : drawn.css;
  const rawCss = sceneCss(scene) + boardCss(scene) + motion;
  const sped = applySpeed(
    { svg: drawn.svg, css: rawCss, cycle: options.motion === false ? 0 : drawn.cycle },
    options.speed,
  );
  return {
    svg: sped.svg,
    css: sped.css,
    html: page(sped.svg, sped.css, scene, options),
    lanes: drawn.groups,
    items: drawn.items,
    cycle: sped.cycle,
    summary: drawn.summary,
    warnings: checkMeasurementFont(measureWith),
  };
}

/** Quadrant, radar and xy charts. */
export async function renderPlot(
  source: string,
  kind: PlotKind,
  options: FlowOptions = {},
): Promise<ChronicleRender> {
  await ensureFonts(options.fonts);
  const scene = withPalette(withFonts(pickScene(options), options.fonts), options.palette);
  const measureWith = measurerFor(options);
  const drawn = drawPlot(await toPlot(source, kind), scene, measureWith);
  const motion = options.motion === false ? '' : drawn.css;
  const rawCss = sceneCss(scene) + plotCss(scene) + motion;
  const sped = applySpeed(
    { svg: drawn.svg, css: rawCss, cycle: options.motion === false ? 0 : drawn.cycle },
    options.speed,
  );
  return {
    svg: sped.svg,
    css: sped.css,
    html: page(sped.svg, sped.css, scene, options),
    lanes: drawn.series,
    items: drawn.points,
    cycle: sped.cycle,
    summary: drawn.summary,
    warnings: checkMeasurementFont(measureWith),
  };
}

/** Pie and mindmap. */
export async function renderRadial(
  source: string,
  kind: RadialKind,
  options: FlowOptions = {},
): Promise<ChronicleRender> {
  await ensureFonts(options.fonts);
  const scene = withPalette(withFonts(pickScene(options), options.fonts), options.palette);
  const measureWith = measurerFor(options);
  const drawn = drawRadial(await toRadial(source, kind), scene, measureWith);
  const motion = options.motion === false ? '' : drawn.css;
  const rawCss = sceneCss(scene) + radialCss(scene) + motion;
  const sped = applySpeed(
    { svg: drawn.svg, css: rawCss, cycle: options.motion === false ? 0 : drawn.cycle },
    options.speed,
  );
  return {
    svg: sped.svg,
    css: sped.css,
    html: page(sped.svg, sped.css, scene, options),
    lanes: drawn.groups,
    items: drawn.items,
    cycle: sped.cycle,
    summary: drawn.summary,
    warnings: checkMeasurementFont(measureWith),
  };
}

/** Git graph. */
export async function renderCommits(
  source: string,
  options: FlowOptions = {},
): Promise<ChronicleRender> {
  await ensureFonts(options.fonts);
  const scene = withPalette(withFonts(pickScene(options), options.fonts), options.palette);
  const measureWith = measurerFor(options);
  const drawn = drawCommits(await toCommits(source), scene, measureWith);
  const motion = options.motion === false ? '' : drawn.css;
  const rawCss = sceneCss(scene) + commitsCss(scene) + motion;
  const sped = applySpeed(
    { svg: drawn.svg, css: rawCss, cycle: options.motion === false ? 0 : drawn.cycle },
    options.speed,
  );
  return {
    svg: sped.svg,
    css: sped.css,
    html: page(sped.svg, sped.css, scene, options),
    lanes: drawn.groups,
    items: drawn.items,
    cycle: sped.cycle,
    summary: drawn.summary,
    warnings: checkMeasurementFont(measureWith),
  };
}

export interface ChronicleRender {
  svg: string;
  css: string;
  html: string;
  lanes: number;
  items: number;
  cycle: number;
  summary: string;
  warnings: string[];
}

export interface SequenceRender {
  svg: string;
  css: string;
  html: string;
  participants: number;
  messages: number;
  cycle: number;
  /** A one-line description, for the chart's accessible name. */
  summary: string;
  /** Things worth telling the user that are not errors. */
  warnings: string[];
}

export async function renderFlow(source: string, options: FlowOptions = {}): Promise<FlowResult> {
  await ensureFonts(options.fonts);
  const baseScene = withPalette(withFonts(pickScene(options), options.fonts), options.palette);
  // DESIGN 1.1: capped to the declared display width instead of the scene's
  // own default (1000) when the caller names one. Threaded through as the
  // scene's own canvas width, not a separate parameter, because every pass
  // that has to pack to the cap — `fold`'s room, the panel refit, DESIGN
  // 1.5's leaf stacking, `fitCanvas` itself — already reads it from there.
  // The 480 floor (`canvas.min`) comes down with it: that floor exists so an
  // undeclared-display chart never renders embarrassingly narrow, but a
  // caller naming a 358px phone column has already said what narrow means —
  // a floor above the display they asked for would force `fitCanvas` right
  // back past the cap this option exists to respect, scaling the packed
  // layout down again, the exact defect DESIGN 1.6 packs instead of hiding.
  // DESIGN 1.4's own aspect ceiling comes off too: it exists so a chart with
  // *room to spare either way* goes wider rather than taller (1.4's own
  // words, "go side by side instead") — but a caller who named a narrow
  // display has already fixed that choice for them, and 1.6's own packing
  // moving a wide row into a column is exactly what makes a phone-width
  // chart taller. `fitCanvas` capping the height there would not make the
  // chart shorter, only clip it — the drawing still needs the room, it would
  // just stop being shown. (Revised 2026-08-28 alongside 1.6.)
  const scene = options.display
    ? {
        ...baseScene,
        canvas: {
          ...baseScene.canvas,
          width: options.display,
          min: Math.min(baseScene.canvas.min, options.display),
          maxAspect: options.display < baseScene.canvas.width ? Infinity : baseScene.canvas.maxAspect,
        },
      }
    : baseScene;
  const measureWith = measurerFor(options);

  const kind = options.kind ?? 'flowchart';
  // Narrowed one at a time rather than with `includes`, which does not narrow.
  if (kind !== 'flowchart' && kind !== 'state' && kind !== 'class' && kind !== 'er') {
    throw new Error(`A ${kind} is not a node-and-edge graph; it has its own renderer.`);
  }
  const graph = kind === 'flowchart' ? await toGraph(source) : await toUnifiedGraph(source, kind);
  if (graph.nodes.length === 0) throw new Error('Nothing to draw — the diagram has no nodes.');

  const size = await layout(graph, scene, measureWith, Boolean(options.display));
  const drawing = draw(graph, scene, size);
  // The static rules only — not the motion CSS, whose transforms would move
  // geometry out from under a viewer's eye without moving `drawing.extent`,
  // which is computed from the same pre-motion placement either way (DESIGN 7.3).
  const staticCss = sceneCss(scene);
  // DESIGN 1.5's own tail: leaf stacking (and DESIGN 1.2's fold, on top of it)
  // pack toward the declared display width, but a chart whose shared box size
  // alone already needs more than that can still come out wider than asked.
  // Handing `fitCanvas` the tight, display-capped `scene.canvas` in that case
  // would only reach for the last-resort *scale* the packing was meant to
  // avoid — the exact defect this feature exists to fix, just moved from CSS
  // into the SVG's own transform. So a chart that packing could not bring
  // under the cap is framed at the ordinary default ceiling instead: still as
  // narrow as fold and stacking got it, never shrunk further, and the gate's
  // own `data-display` check is what says so is a WARN, not a silent fix.
  const packedSpan = drawing.extent.width + scene.canvas.margin * 2;
  const displayMet = !options.display || packedSpan <= scene.canvas.width;
  const fitAgainst = displayMet ? scene.canvas : baseScene.canvas;
  const framed = {
    ...drawing,
    svg: fitToCanvas(drawing.svg, fitAgainst, drawing.extent, scene.canvas.width),
  };
  const timeline = options.motion === false ? null : animate(drawing, graph, scene);
  const rawCss = staticCss + (timeline?.css ?? '');
  const sped = applySpeed(
    { svg: framed.svg, css: rawCss, cycle: timeline?.cycle ?? 0 },
    options.speed,
  );

  const html = page(sped.svg, sped.css, scene, options);
  const warnings = [
    ...checkMeasurementFont(measureWith),
    ...phoneHeightWarning(framed.svg, options.display),
  ];

  return {
    svg: sped.svg,
    css: sped.css,
    html,
    graph,
    drawing: framed,
    cycle: sped.cycle,
    warnings,
  };
}
