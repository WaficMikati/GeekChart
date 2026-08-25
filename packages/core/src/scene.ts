/**
 * The drawing specification, derived from Manim rather than invented.
 *
 * Numbers here were measured from Manim Community's source, not eyeballed:
 * the easing is a curve fit of its default `smooth()`, the palette is its own
 * constants, and the staggering follows its `lag_ratio` convention. Both scenes
 * share every timing and weight — only colour and type differ — so a chart
 * looks like the same object wearing a different coat.
 */

export type SceneName = 'manim' | 'geeks';

export interface Motion {
  /**
   * Manim's `smooth()` is a sigmoid smoothstep, not a CSS ease. Fitted to within
   * 0.01 by this curve. It nearly stops at both ends, which is what makes the
   * motion read as deliberate rather than mechanical.
   */
  ease: string;
  /** Seconds for one node's outline to draw itself. */
  build: number;
  /** Seconds between consecutive elements. Manim's lag_ratio, in absolute time. */
  lag: number;
  /** Seconds of stillness after the build, before emphasis. The pause is the point. */
  beat: number;
  /** Seconds for one node's Indicate — a lift and a colour flash. */
  pulse: number;
  /** Seconds between pulses as emphasis walks the primary path. */
  pulseStep: number;
  /** Seconds held on the finished frame before the loop repeats. */
  hold: number;
}

/**
 * The stage every chart is drawn on. DESIGN 1.1 and 1.3.
 *
 * One width for the whole library is the reason type reads the same size on
 * every chart: a 12-unit name is 12px on screen because the canvas is shown at
 * its own width. A renderer that picks its own width undoes that for every
 * chart in the set, not just its own.
 */
export interface Canvas {
  /** Canvas width ceiling in units. A chart hugs its content down to `min`. */
  width: number;
  /** The narrowest canvas. Below this a chart is padded out, not shrunk. */
  min: number;
  /** The widest a chart may ever be. DESIGN 1.1 allows 1200 for boards. */
  max: number;
  /** Outer margin. Content touches neither the edge nor this line. DESIGN 1.3. */
  margin: number;
  /** Height ceiling, as a multiple of the width. DESIGN 1.4. */
  maxAspect: number;
}

/**
 * The five sizes a chart is allowed to set, from DESIGN §3.
 *
 * Family files read this table; none of them writes a number. That is the whole
 * mechanism behind "type does not change size between charts" — there is only
 * one place a size can come from, and it is not scaled by anything.
 */
export interface TypeScale {
  /** Chart title: 22 / 600 / −0.02em, sentence case. */
  title: number;
  titleWeight: number;
  titleTracking: string;
  /** Kicker and subtitle: 11 mono, 0.18em, caps. */
  kicker: number;
  kickerTracking: string;
  /** Node name: 13 / 600, sentence case. */
  name: number;
  nameWeight: number;
  /** Node caption and any technical row: 11 mono. */
  caption: number;
  /** Edge label, legend, axis tick: 11 mono caps, 0.08–0.14em. */
  label: number;
  labelTracking: string;
  /** Baseline-to-baseline for a run of caption-sized rows, on the 8-grid. */
  rowStep: number;
  /** The big index numeral (`01`): 72 mono / 600. */
  numeral: number;
}

/**
 * The one type table. DESIGN §3, measured, not chosen here.
 *
 * 11 is the floor (3.1, raised 2026-08-21): the canvas is routinely shown at
 * ~760px, where 11 units is 8.4px, the legibility floor at that scale.
 * Nothing in this table may go under it.
 */
export const TYPE: TypeScale = {
  title: 22,
  titleWeight: 600,
  titleTracking: '-0.02em',
  kicker: 11,
  kickerTracking: '.18em',
  name: 13,
  nameWeight: 600,
  caption: 11,
  label: 11,
  labelTracking: '.12em',
  rowStep: 16,
  numeral: 72,
};

/** The canvas every renderer lays out on. */
export const CANVAS: Canvas = { width: 1000, min: 480, max: 1200, margin: 48, maxAspect: 1.4 };

export interface Box { x: number; y: number; width: number; height: number }

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
  const grid = (v: number) => Math.ceil(v / 8) * 8;
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

/** Shared across both scenes: only colour and type are allowed to differ. */
const MOTION: Motion = {
  ease: 'cubic-bezier(0.61, 0, 0.39, 1)',
  build: 0.7,
  lag: 0.5,
  beat: 0.8,
  pulse: 0.56,
  pulseStep: 0.52,
  hold: 2.4,
};

/**
 * Categorical steps for a dark surface, in assignment order.
 *
 * Not invented: these are a validated categorical set with 4geeks blue in the
 * first slot, confirmed against #17202A with the palette validator. Reordering
 * them re-opens the colour-blindness check, because the check is on *adjacent*
 * pairs — the order is part of what passed.
 */
const SERIES_DARK = [
  '#0084FF', // 4geeks blue
  '#D95926', // orange
  '#199E70', // aqua
  '#C98500', // yellow
  '#D55181', // magenta
  '#008300', // green
] as const;

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
  nodeStroke: 1.25,
  edgeStroke: 1.2,
  radius: 6,
  panelRadius: 12,
  // 16 of clear air either side of a label, which is DESIGN 10.2's floor.
  padX: 16,
  padY: 8,
  padShape: 12,
  gapNode: 24,
  gapLayer: 48,
  clusterPad: 24,
  // The line stops 6 short of the outline so the head reads as meeting the box
  // rather than piercing it. DESIGN 10.3.
  edgeGap: 6,
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
    name: 'manim',
    label: 'Manim',
    description: "Manim's own palette on black. Reads as 3Blue1Brown at a glance.",
    bg: '#000000',
    surface: '#171A1F',
    ink: '#FFFFFF',
    quiet: '#888888',
    path: '#58C4DD',
    alt: '#FC6255',
    accent: '#F7D96F',
    edge: '#8A8F98',
    series: SERIES_DARK,
    titleFont: SERIF,
  },
  // Values taken from 4geeks.com's own Chakra theme rather than sampled by eye:
  // blue.default, yellow.default, darkTheme and featuredDark are the tokens the
  // site actually ships, so a chart sits on its pages as part of the design
  // rather than next to it.
  geeks: {
    ...shared,
    name: 'geeks',
    label: 'Geeks',
    description: "4geeks.com's own tokens — blue #0084FF on the site's dark surface.",
    bg: '#17202A',
    surface: '#232F3C',
    ink: '#FFFFFF',
    quiet: '#8794A3',
    path: '#0084FF',
    alt: '#FFB718',
    accent: '#00ABE9',
    edge: '#6B7889',
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
