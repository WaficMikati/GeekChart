import { toGraph, type Graph } from './graph.ts';
import { toUnifiedGraph, type UnifiedType } from './unified.ts';
import { layout, type Measurer } from './layout.ts';
import { draw, type Drawing } from './draw.ts';
import { animate } from './motion.ts';
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
function fitToCanvas(svg: string, canvas: Canvas, extent: Drawing['extent']): string {
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
  const openTag = open[0]
    .replace(/\s+viewBox="[^"]*"/, '')
    .replace(/\s+width="[^"]*"/, '')
    .replace(/\s+height="[^"]*"/, '')
    .replace(
      />$/,
      ` viewBox="0 0 ${frame.width} ${frame.height}" width="${frame.width}" height="${frame.height}">`,
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
  const css = sceneCss(scene) + sequenceCss(scene) + motion;
  const svg = drawn.drawing.svg;
  return {
    svg,
    css,
    html: page(svg, css, scene, options),
    participants: drawn.drawing.participants.length,
    messages: drawn.drawing.messages,
    cycle: options.motion === false ? 0 : drawn.cycle,
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
  const css = sceneCss(scene) + chronicleCss(scene) + motion;
  return {
    svg: drawn.svg,
    css,
    html: page(drawn.svg, css, scene, options),
    lanes: drawn.lanes,
    items: drawn.items,
    cycle: options.motion === false ? 0 : drawn.cycle,
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
  const css = sceneCss(scene) + boardCss(scene) + motion;
  return {
    svg: drawn.svg,
    css,
    html: page(drawn.svg, css, scene, options),
    lanes: drawn.groups,
    items: drawn.items,
    cycle: options.motion === false ? 0 : drawn.cycle,
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
  const css = sceneCss(scene) + plotCss(scene) + motion;
  return {
    svg: drawn.svg,
    css,
    html: page(drawn.svg, css, scene, options),
    lanes: drawn.series,
    items: drawn.points,
    cycle: options.motion === false ? 0 : drawn.cycle,
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
  const css = sceneCss(scene) + radialCss(scene) + motion;
  return {
    svg: drawn.svg,
    css,
    html: page(drawn.svg, css, scene, options),
    lanes: drawn.groups,
    items: drawn.items,
    cycle: options.motion === false ? 0 : drawn.cycle,
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
  const css = sceneCss(scene) + commitsCss(scene) + motion;
  return {
    svg: drawn.svg,
    css,
    html: page(drawn.svg, css, scene, options),
    lanes: drawn.groups,
    items: drawn.items,
    cycle: options.motion === false ? 0 : drawn.cycle,
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
  const scene = withPalette(withFonts(pickScene(options), options.fonts), options.palette);
  const measureWith = measurerFor(options);

  const kind = options.kind ?? 'flowchart';
  // Narrowed one at a time rather than with `includes`, which does not narrow.
  if (kind !== 'flowchart' && kind !== 'state' && kind !== 'class' && kind !== 'er') {
    throw new Error(`A ${kind} is not a node-and-edge graph; it has its own renderer.`);
  }
  const graph = kind === 'flowchart' ? await toGraph(source) : await toUnifiedGraph(source, kind);
  if (graph.nodes.length === 0) throw new Error('Nothing to draw — the diagram has no nodes.');

  const size = await layout(graph, scene, measureWith);
  const drawing = draw(graph, scene, size);
  // The static rules only — not the motion CSS, whose transforms would move
  // geometry out from under a viewer's eye without moving `drawing.extent`,
  // which is computed from the same pre-motion placement either way (DESIGN 7.3).
  const staticCss = sceneCss(scene);
  const framed = { ...drawing, svg: fitToCanvas(drawing.svg, scene.canvas, drawing.extent) };
  const timeline = options.motion === false ? null : animate(drawing, graph, scene);
  const css = staticCss + (timeline?.css ?? '');

  const html = page(framed.svg, css, scene, options);
  const warnings = checkMeasurementFont(measureWith);

  return {
    svg: framed.svg,
    css,
    html,
    graph,
    drawing: framed,
    cycle: timeline?.cycle ?? 0,
    warnings,
  };
}
