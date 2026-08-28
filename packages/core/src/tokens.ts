/**
 * 4Geeks design tokens.
 *
 * Values lifted from the token block in 4geeks.com's stylesheet (shadcn-style
 * HSL triples), so the charts sit next to their real UI without clashing.
 * Everything downstream reads from here — change a colour once, it propagates
 * to mermaid's own theme variables, our CSS layer and the exported HTML.
 */

export type Hsl = readonly [h: number, s: number, l: number];

export interface Palette {
  background: Hsl;
  foreground: Hsl;
  card: Hsl;
  muted: Hsl;
  mutedForeground: Hsl;
  border: Hsl;
  primary: Hsl;
  primaryForeground: Hsl;
  accent: Hsl;
  accentForeground: Hsl;
  /** Series colours, used to tint node groups and edge families. */
  chart: readonly [Hsl, Hsl, Hsl, Hsl, Hsl];
}

export const light: Palette = {
  background: [0, 0, 100],
  foreground: [223, 100, 5],
  card: [0, 0, 100],
  muted: [0, 0, 98],
  mutedForeground: [0, 0, 45],
  border: [0, 0, 90],
  primary: [210, 100, 50],
  primaryForeground: [0, 0, 100],
  accent: [43, 100, 55],
  accentForeground: [223, 100, 5],
  chart: [
    [210, 100, 50],
    [43, 100, 55],
    [142, 71, 45],
    [0, 75, 45],
    [40, 80, 55],
  ],
};

export const dark: Palette = {
  background: [0, 0, 8],
  foreground: [0, 0, 95],
  card: [0, 0, 10],
  muted: [0, 0, 14],
  mutedForeground: [0, 0, 65],
  border: [0, 0, 16],
  primary: [210, 100, 50],
  primaryForeground: [0, 0, 100],
  accent: [195, 100, 35],
  accentForeground: [0, 0, 100],
  chart: [
    [210, 100, 65],
    [9, 75, 65],
    [190, 70, 60],
    [280, 65, 65],
    [40, 80, 60],
  ],
};

export const fonts = {
  /** 4geeks.com uses Archivo for body copy and Lato for headings. */
  sans: '"Archivo", "Lato", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  heading: '"Lato", "Archivo", ui-sans-serif, system-ui, sans-serif',
  mono: 'ui-monospace, Menlo, "SF Mono", Consolas, monospace',
  /** Loaded from Google Fonts unless the caller asks for embedded fonts. */
  googleHref:
    'https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Lato:wght@400;700;900&display=swap',
} as const;

export const radius = 12; // px — 4geeks --radius is .75rem

/** `hsl(h s% l%)` string, optionally with alpha. */
export function hsl([h, s, l]: Hsl, alpha = 1): string {
  return alpha === 1 ? `hsl(${h} ${s}% ${l}%)` : `hsl(${h} ${s}% ${l}% / ${alpha})`;
}

/**
 * Hex form. Mermaid runs its own colour maths (lighten/darken) over the theme
 * variables we hand it, and hex is the input it is best tested against.
 */
export function hex([h, s, l]: Hsl): string {
  const sat = s / 100;
  const lum = l / 100;
  const chroma = (1 - Math.abs(2 * lum - 1)) * sat;
  const second = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const match = lum - chroma / 2;
  const sextant = Math.floor(h / 60) % 6;
  const rgb = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ][sextant] as [number, number, number];
  return (
    '#' +
    rgb
      .map((c) =>
        Math.round((c + match) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

/** Nudge lightness, clamped. Used for hover/rim/shadow derivations. */
export function shift([h, s, l]: Hsl, delta: number): Hsl {
  return [h, s, Math.max(0, Math.min(100, l + delta))];
}

/** Move lightness towards a target while keeping hue — for subtle node fills. */
export function tint(color: Hsl, towards: number, amount: number): Hsl {
  const [h, s, l] = color;
  return [h, s, l + (towards - l) * amount];
}

// ---------------------------------------------------------------------------
// DESIGN.md's numbers — the spec every chart is checked against (see
// /DESIGN.md). These are unrelated to the 4geeks.com HSL palette above (that
// one themes raw mermaid output; these size and colour the native renderer).
// One value per rule, cited by number, so scene.ts and the gate's rule table
// (rules.ts) both read the same source instead of each keeping its own copy.
// ---------------------------------------------------------------------------

/** DESIGN 2.1: positions, widths, heights and gutters all sit on this. */
export const GRID = 8;

export interface Extent {
  width: number;
  height: number;
}

/**
 * DESIGN 2.2: the four fixed box sizes a node may take. A chart uses at most
 * two of them — a fitted-to-label box is what rule 9's "boxes of different
 * widths in one row" comes from.
 */
export const BOX_SIZES: {
  compact: Extent;
  standard: Extent;
  /** Title + caption. DESIGN 3.2's two-tier node gets this one. */
  captioned: Extent;
  wide: Extent;
} = {
  compact: { width: 120, height: 48 },
  standard: { width: 160, height: 48 },
  captioned: { width: 160, height: 56 },
  wide: { width: 200, height: 48 },
};

/**
 * DESIGN 2.3: gutters between siblings, always one of these two, both
 * already on the 8-grid. `panel` is the wider one panel-level layout passes
 * use (`enforceClusterGutters`, `alignPanels`, satellite placement) so a
 * repacked row matches its neighbours rather than introducing a third value;
 * it is unrelated to a scene's own `gapLayer` (vertical rank spacing, not a
 * number this rule names).
 */
export const GUTTER = { sibling: 24, panel: 32 } as const;

/** DESIGN 4.1: hairline stroke weights. Node outlines, edges, cluster/panel
 *  boxes and the dividers inside a record row each get their own weight, and
 *  nothing else is allowed to invent a fifth. */
export const STROKE = { node: 1.5, edge: 1.5, cluster: 1, divider: 0.8 } as const;

/**
 * Clearances: DESIGN 6.1/6.8's 16 units an edge keeps from a node it does not
 * connect to (also what makes an edge under 16 long "touching" its nodes,
 * 2.3); 6.7's 24 around whatever a loop-back goes around; the stub an arrow's
 * line stops short by — the head's own length (5× the edge stroke, 7.5), so
 * the head's base meets the line exactly and reads as meeting the box rather
 * than piercing it.
 */
export const CLEARANCE = { node: 16, loop: 24, stub: STROKE.edge * 5 } as const;

/** DESIGN 8.1: Manim's `smooth()`, fitted to within 0.01 — the only ease used
 *  anywhere except the one exception below. */
export const EASE = 'cubic-bezier(0.61, 0, 0.39, 1)';

/** DESIGN 10.4: the arrival press's settling curve — the one place something
 *  overshoots rather than following `EASE`. */
export const PRESS_EASE = 'cubic-bezier(.22,1.2,.36,1)';

/** DESIGN 10.4: seconds between siblings leaving or building together, so a
 *  group reads as one event rather than a queue. */
export const WAVE_LAG = 0.15;

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
 * DESIGN §3, the one type table, measured rather than chosen here.
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

/**
 * DESIGN 1.1 and 1.3: the stage every chart is drawn on.
 *
 * One width for the whole library is the reason type reads the same size on
 * every chart: a 12-unit name is 12px on screen because the canvas is shown at
 * its own width. A renderer that picks its own width undoes that for every
 * chart in the set, not just its own.
 */
export interface CanvasSpec {
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

export const CANVAS: CanvasSpec = { width: 1000, min: 480, max: 1200, margin: 48, maxAspect: 1.4 };

export interface Motion {
  /**
   * Manim's `smooth()` is a sigmoid smoothstep, not a CSS ease. Fitted to within
   * 0.01 by this curve (`EASE`). It nearly stops at both ends, which is what
   * makes the motion read as deliberate rather than mechanical.
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
  /** Seconds held on the finished frame before the loop repeats. DESIGN 10.4's
   *  still beat floor is 2s; this clears it. */
  hold: number;
}

/** Shared across both scenes: only colour and type are allowed to differ. */
export const MOTION: Motion = {
  ease: EASE,
  build: 0.7,
  lag: 0.5,
  beat: 0.8,
  pulse: 0.56,
  pulseStep: 0.52,
  hold: 2.4,
};

export interface RoleColours {
  bg: string;
  surface: string;
  ink: string;
  quiet: string;
  path: string;
  alt: string;
  accent: string;
  edge: string;
}

/**
 * DESIGN §5's role colours, dark ground. Not invented: `manim` is Manim
 * Community's own palette, and `geeks` is 4geeks.com's own tokens
 * (blue.default, yellow.default, darkTheme, featuredDark).
 */
export const PALETTE_DARK: { manim: RoleColours; geeks: RoleColours } = {
  manim: {
    bg: '#000000',
    surface: '#171A1F',
    ink: '#FFFFFF',
    quiet: '#888888',
    path: '#58C4DD',
    alt: '#FC6255',
    accent: '#F7D96F',
    edge: '#8A8F98',
  },
  geeks: {
    bg: '#17202A',
    surface: '#232F3C',
    ink: '#FFFFFF',
    quiet: '#8794A3',
    path: '#0084FF',
    alt: '#FFB718',
    accent: '#00ABE9',
    edge: '#6B7889',
  },
};

/**
 * DESIGN 5.5: the recommended light palette, gated on the golden. Not a
 * built-in scene — pass it to `palette` (or the CLI's `--color-*` flags) to
 * render on a light ground. No `alt`: 5.5 does not name a second hue for it,
 * and a chart that needs one should set it explicitly (5.3).
 */
export const PALETTE_LIGHT: Omit<RoleColours, 'alt'> = {
  bg: '#FFFFFF',
  ink: '#17202A',
  quiet: '#5A6672',
  edge: '#9AA5B1',
  surface: '#EEF2F6',
  path: '#0075E0',
  accent: '#0096D6',
};

/**
 * DESIGN 5.2/5.3: categorical series colours for a dark surface, in
 * assignment order. Not invented: a validated categorical set with 4geeks
 * blue in the first slot, confirmed against #17202A with the palette
 * validator — lightness band, chroma floor, adjacent-pair separation under
 * protanopia and deuteranopia, and contrast against the surface all pass.
 * Reordering re-opens that check, because it is on *adjacent* pairs — the
 * order is part of what passed.
 */
export const SERIES_DARK = [
  '#0084FF', // 4geeks blue
  '#D95926', // orange
  '#199E70', // aqua
  '#C98500', // yellow
  '#D55181', // magenta
  '#008300', // green
] as const;
