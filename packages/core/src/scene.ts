/**
 * The drawing specification, derived from Manim rather than invented.
 *
 * The actual numbers — measured from Manim Community's source, DESIGN.md's
 * sizing rules, and 4geeks.com's own tokens — live in `tokens.ts`, one value
 * per rule it cites. This file composes them into the two named scenes and
 * keeps the shapes (`Scene`, `Frame`, `fitCanvas`) that draw from them; it
 * writes no size, weight or colour of its own. Both scenes share every
 * timing and weight — only colour and type differ — so a chart looks like
 * the same object wearing a different coat.
 */
import {
  BOX_SIZES,
  CANVAS,
  CLEARANCE,
  EASE,
  GRID,
  GUTTER,
  MOTION,
  PALETTE_DARK,
  PRESS_EASE,
  SERIES_DARK,
  STROKE,
  TYPE,
  WAVE_LAG,
  type CanvasSpec,
  type Motion,
  type TypeScale,
} from './tokens.ts';

export type SceneName = 'manim' | 'geeks';

/** Alias kept for every existing `Canvas` reference in this file and its callers. */
export type Canvas = CanvasSpec;

// Re-exported so anything that used to import these from scene.ts (render.ts's
// `CANVAS`, chiefly) still finds them here — the values now live in tokens.ts.
export type { Motion, TypeScale };
export {
  BOX_SIZES,
  CANVAS,
  CLEARANCE,
  EASE,
  GRID,
  GUTTER,
  PRESS_EASE,
  STROKE,
  TYPE,
  WAVE_LAG,
  PALETTE_DARK,
  SERIES_DARK,
};

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a drawing sits once it has been centred on the canvas. */
export interface Frame {
  /** Canvas width, always `canvas.width` unless a board asked for more. */
  width: number;
  /** Canvas height: what the content needs, capped at `maxAspect` × width. */
  height: number;
  /** Translate the drawing by this to centre it. */
  dx: number;
  dy: number;
  /**
   * Last-resort shrink. 1 in every chart that lays out correctly; below 1 only
   * when a renderer handed over content wider than the canvas, where clipping
   * it would be the worse failure.
   */
  scale: number;
}

/**
 * Centre a finished drawing on the canvas. DESIGN 1.1, 1.3, 1.4.
 *
 * `extent` is the drawing's own bounds *including* whatever margin it left, so
 * a renderer that already works to `canvas.margin` passes its own size straight
 * in. Nothing here invents a width: the canvas is the width, and the drawing is
 * moved to sit in the middle of it.
 */
export function fitCanvas(extent: Box, canvas: Canvas = CANVAS, max = canvas.width): Frame {
  const grid = (v: number) => Math.ceil(v / GRID) * GRID;
  const ceiling = Math.min(max, canvas.max);
  // Hug the content (DESIGN 1.1 rev. 2026-08-21): a narrow chart padded to 1000 and
  // then scaled into a viewer panel loses its type size to the padding.
  // Callers pass a box that already includes their 48 margins on every side.
  const width = Math.max(canvas.min, Math.min(ceiling, grid(extent.width)));
  const scale = extent.width > width ? width / extent.width : 1;
  const height = Math.max(8, Math.min(width * canvas.maxAspect, grid(extent.height * scale)));
  return {
    width,
    height,
    dx: (width - extent.width * scale) / 2 - extent.x * scale,
    dy: (height - extent.height * scale) / 2 - extent.y * scale,
    scale,
  };
}

/** The transform that puts a drawing where `fitCanvas` decided it goes. */
export function frameTransform(frame: Frame): string {
  const move = `translate(${frame.dx.toFixed(2)} ${frame.dy.toFixed(2)})`;
  return frame.scale === 1 ? move : `${move} scale(${frame.scale.toFixed(4)})`;
}

export interface Scene {
  name: SceneName;
  label: string;
  description: string;

  bg: string;
  ink: string;
  quiet: string;
  /** Nodes and edges on the primary path. */
  path: string;
  /** Everything off it — the alternate branch, the retry. */
  alt: string;
  /**
   * The fill of a card inside a panel.
   *
   * A step in *value* from the background rather than another hue: cards grouped
   * in a panel are a set, and colouring them by role would say they are a path
   * through something, which is the opposite of what a group means.
   */
  surface: string;
  /** Reserved for emphasis. Never used at rest. */
  accent: string;
  edge: string;
  /**
   * Categorical series colours, assigned in fixed order and never cycled.
   *
   * A separate job from the role colours above: `path` and `alt` say *what a node
   * is*, while these say *which series a mark belongs to*. Reusing the role pair
   * for series would mean a two-line chart claimed one line was the primary path
   * through the other.
   *
   * These are the validated categorical steps for a dark surface, with 4geeks
   * blue substituted into the first slot. Checked with the palette validator
   * rather than by eye: lightness band, chroma floor, adjacent-pair separation
   * under protanopia and deuteranopia, and contrast against the surface all pass
   * against #17202A. The brand amber cannot take a slot — at OKLCH L 0.83 it sits
   * far outside the band for either mode, which is why it stays a role colour.
   */
  series: readonly string[];

  /** The stage. Every renderer lays out on this and nothing else. DESIGN 1.1. */
  canvas: Canvas;
  /** The only place a font size comes from. DESIGN §3. */
  type: TypeScale;

  titleFont: string;
  /**
   * A *node name*, not a chart title — this is what a box is labelled with.
   * The chart's own title is `type.title`, which is nearly twice the size.
   */
  titleSize: number;
  titleWeight: number;
  captionFont: string;
  captionSize: number;
  captionTracking: string;
  edgeLabelFont: string;
  edgeLabelSize: number;
  edgeLabelTracking: string;
  edgeLabelUpper: boolean;
  clusterFont: string;
  clusterSize: number;
  /** Rows inside a compartmented node — class members, entity columns. */
  rowFont: string;
  rowSize: number;
  /** Baseline-to-baseline distance for those rows. */
  rowStep: number;

  nodeStroke: number;
  edgeStroke: number;
  /** Cluster/panel box hairline. DESIGN 4.1. */
  clusterStroke: number;
  /** Divider inside a node — class/ER row separators. DESIGN 4.1, 4.4. */
  dividerStroke: number;
  /** Corner radius for a node. One value per chart. DESIGN 2.5. */
  radius: number;
  /** Corner radius for a panel or cluster. DESIGN 2.5. */
  panelRadius: number;
  /** Space inside a node, around its label. */
  padX: number;
  padY: number;
  /**
   * Clearance between a label and a sloped edge, measured perpendicular to it.
   *
   * A rectangle's padding is trivially the gap to an axis-aligned side. A diamond,
   * hexagon or circle has no such side, and fitting the label's bounding box to
   * the outline leaves its corners touching the edge — which is what makes a
   * decision node look cramped next to the boxes around it.
   */
  padShape: number;
  /** Space between siblings, and between layers. */
  gapNode: number;
  gapLayer: number;
  /** Space between a cluster's border and its contents. */
  clusterPad: number;
  /**
   * Gap between a node's outline and the arrowhead pointing at it.
   *
   * Too small and the head reads as part of the box rather than as the end of
   * the line — it needs clear air around it to terminate anything.
   */
  edgeGap: number;
  /** Gap between a node's outline and the line leaving it. */
  edgeGapStart: number;
  /**
   * Arrowhead length and width, as multiples of the line's own weight. Their
   * ratio must match the marker's viewBox or the head is letterboxed.
   */
  arrowLength: number;
  arrowWidth: number;
  /**
   * Length of the class and ER end markers, as a multiple of the line's weight.
   * Larger than an arrowhead because a hollow triangle or a crow's foot has to
   * be read as a *shape*, not just as a direction.
   */
  tipLength: number;

  /** Sequence diagrams: the column each participant owns, and the row per message. */
  laneWidth: number;
  laneStep: number;

  /** Gantt: the height of one task row, and of the bar sitting in it. */
  rowHeight: number;
  barHeight: number;
  /** Timeline, gantt and journey: the shortest the plotting area may be. */
  plotWidth: number;

  motion: Motion;
}

const SERIF = "'Source Serif 4', 'Iowan Old Style', Georgia, serif";
const SANS = "'Archivo', 'Lato', ui-sans-serif, system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, Menlo, monospace";

const shared = {
  canvas: CANVAS,
  type: TYPE,

  // Every size below is read out of the type table rather than written here.
  // The roles differ from the table's names in one place only: `titleSize` is a
  // node's *name*, because that is what the graph family calls the text in a
  // box. A chart title is `type.title`.
  titleSize: TYPE.name,
  titleWeight: TYPE.nameWeight,
  captionFont: MONO,
  captionSize: TYPE.caption,
  captionTracking: 'normal',
  edgeLabelFont: MONO,
  edgeLabelSize: TYPE.label,
  edgeLabelTracking: TYPE.labelTracking,
  edgeLabelUpper: true,
  clusterFont: MONO,
  clusterSize: TYPE.kicker,
  rowFont: MONO,
  rowSize: TYPE.caption,
  rowStep: TYPE.rowStep,

  // Hairlines, per DESIGN 4.1. These were 2.5 and 2 when the canvas was two to
  // three times too wide; at 1000 units they were tree trunks.
  nodeStroke: STROKE.node,
  edgeStroke: STROKE.edge,
  clusterStroke: STROKE.cluster,
  dividerStroke: STROKE.divider,
  radius: 6,
  panelRadius: 12,
  // 16 of clear air either side of a label, which is DESIGN 10.2's floor —
  // the same number as CLEARANCE.node (6.1/6.8) but a different rule, so it
  // stays its own literal rather than borrowing that token.
  padX: 16,
  padY: 8,
  padShape: 12,
  gapNode: GUTTER.sibling,
  // Vertical rank spacing — not one of DESIGN 2.3's 24/32 gutters (GUTTER),
  // and not named by any other rule number, so it stays a literal.
  gapLayer: 48,
  clusterPad: 24,
  // The line stops 6 short of the outline so the head reads as meeting the box
  // rather than piercing it. DESIGN 10.3.
  edgeGap: CLEARANCE.stub,
  edgeGapStart: 4,
  // Multiples of the line's own weight, solved so the head comes out 8 across
  // and 6 long at a 1.2 hairline — the golden's proportions, and the only pair
  // that makes DESIGN 6.3 and 10.3 agree: the head's point sits on the outline,
  // its base is 6 back, and the line stops 6 short, so the two meet exactly.
  arrowLength: 5,
  arrowWidth: 6.67,
  tipLength: 7,
  laneWidth: 160,
  laneStep: 44,
  rowHeight: 32,
  barHeight: 16,
  plotWidth: 400,
  motion: MOTION,
} as const;

export const scenes: Record<SceneName, Scene> = {
  manim: {
    ...shared,
    ...PALETTE_DARK.manim,
    name: 'manim',
    label: 'Manim',
    description: "Manim's own palette on black. Reads as 3Blue1Brown at a glance.",
    series: SERIES_DARK,
    titleFont: SERIF,
  },
  // Values taken from 4geeks.com's own Chakra theme rather than sampled by eye:
  // blue.default, yellow.default, darkTheme and featuredDark are the tokens the
  // site actually ships, so a chart sits on its pages as part of the design
  // rather than next to it.
  geeks: {
    ...shared,
    ...PALETTE_DARK.geeks,
    name: 'geeks',
    label: 'Geeks',
    description: "4geeks.com's own tokens — blue #0084FF on the site's dark surface.",
    series: SERIES_DARK,
    titleFont: SANS,
  },
};

export const fontStacks = { serif: SERIF, sans: SANS, mono: MONO };

/**
 * Which typefaces a chart is drawn in.
 *
 * Three roles rather than five fields, because five is the renderer's business
 * and three is what anyone choosing fonts actually thinks about.
 *
 * Any of them may be the string `inherit`, which hands the decision to whatever
 * page the chart ends up in. That is the right default for a chart embedded in
 * someone else's site: it costs no font bytes and matches the surrounding text.
 * It comes with one obligation, which `measureWith` exists to meet.
 */
export interface FontOptions {
  /** Node titles, participant names, class and entity names. */
  display?: string;
  /** Captions, edge labels, cardinalities, cluster and frame titles. */
  label?: string;
  /** Class members and entity columns, where alignment carries meaning. */
  mono?: string;
  /**
   * What `inherit` resolves to while the diagram is being measured.
   *
   * A box is sized from the width its label actually came out at, so a chart
   * measured in one font and displayed in another has boxes that do not fit
   * their text — and unlike a flash of unstyled text, the wrong size is baked
   * into the SVG permanently. Set this to the font stack of the page the chart
   * will live in and the geometry is correct there.
   */
  measureWith?: string;
}

/**
 * The seven colours a chart is drawn from.
 *
 * Separate from `Scene` so a palette can be swapped without inheriting a scene's
 * type, spacing and motion — those are the parts measured from Manim and worth
 * keeping identical across looks. Colour is the part that should belong to
 * whoever is publishing the chart.
 */
export interface Palette {
  /** The ground the chart sits on. Also what a label plate knocks out. */
  bg?: string;
  /** Titles and card text. */
  ink?: string;
  /** Captions, edge labels, cluster kickers — everything secondary. */
  quiet?: string;
  /** Nodes and edges on the primary path. */
  path?: string;
  /** Everything off it: the alternate branch, the retry. */
  alt?: string;
  /** Reserved for emphasis. Never used at rest. */
  accent?: string;
  /** Connector lines. */
  edge?: string;
  /** Cards inside a panel. */
  surface?: string;
  /** Categorical series colours, in fixed order. */
  series?: readonly string[];
}

/**
 * Vertical room a panel reserves above its contents, for the title and kicker.
 *
 * Shared because layout and drawing must agree exactly: layout uses it to place
 * the first row of cards, drawing uses it to place the rule above them, and any
 * disagreement puts the rule through the text.
 */
export const clusterHeadroom = (scene: Scene): number =>
  scene.clusterPad + scene.type.title + scene.type.kicker + scene.clusterPad;

/** Apply a palette to a scene. Anything left out keeps the scene's own value. */
export function withPalette(scene: Scene, palette?: Palette): Scene {
  if (!palette) return scene;
  const set = Object.fromEntries(
    Object.entries(palette).filter(([, v]) => typeof v === 'string' && v.length > 0),
  );
  return { ...scene, ...set };
}

/** Everything inherits. Shorthand for the common embedding case. */
export const INHERIT: FontOptions = { display: 'inherit', label: 'inherit', mono: 'inherit' };

/**
 * A neutral stack to measure against when nothing better is known.
 *
 * Deliberately the same list a browser's own UI font resolves to, so a chart
 * dropped into an unstyled page is close to right rather than arbitrarily wrong.
 */
export const SYSTEM_STACK =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/** Apply font overrides to a scene, leaving everything else alone. */
export function withFonts(scene: Scene, fonts?: FontOptions | 'inherit'): Scene {
  if (!fonts) return scene;
  const chosen = fonts === 'inherit' ? INHERIT : fonts;
  return {
    ...scene,
    ...(chosen.display ? { titleFont: chosen.display } : {}),
    ...(chosen.label
      ? { captionFont: chosen.label, edgeLabelFont: chosen.label, clusterFont: chosen.label }
      : {}),
    ...(chosen.mono ? { rowFont: chosen.mono } : {}),
  };
}

/** Does any role defer to the host page? */
export function inheritsFonts(fonts?: FontOptions | 'inherit'): boolean {
  if (!fonts) return false;
  const chosen = fonts === 'inherit' ? INHERIT : fonts;
  return [chosen.display, chosen.label, chosen.mono].includes('inherit');
}
