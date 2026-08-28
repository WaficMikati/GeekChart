export type ThemeName = 'light' | 'dark';

export type PresetName = 'cascade' | 'reveal' | 'flow' | 'spotlight' | 'none';

/**
 * How the finished animation behaves once it has run.
 *
 * `'loop'` is the old, always-on behaviour (DESIGN 8.4 before 2026-08-28):
 * every element's timeline repeats forever. `'once'` plays the whole build —
 * including the accent's one pass along the primary path — and then holds the
 * finished frame; nothing restarts. `'in-view'` is the same single pass, but
 * held paused until the chart is scrolled into view (see
 * `packages/geekchart/src/observe.ts`'s `playInView`).
 */
export type PlayMode = 'loop' | 'once' | 'in-view';

export interface AnimationOptions {
  preset: PresetName;
  /** Seconds before the first element moves. */
  delay: number;
  /** Seconds between consecutive elements in the stagger. */
  stagger: number;
  /** Seconds a single element takes to arrive. */
  duration: number;
  /** Keep edge dashes travelling after the diagram has settled. */
  loop: boolean;
  /** Respect `prefers-reduced-motion` by showing the final frame instantly. */
  respectReducedMotion: boolean;
  /** DESIGN 8.4: loop forever, play once, or once on scroll into view. */
  play: PlayMode;
}

export interface RenderOptions {
  theme: ThemeName;
  /** Visual pack: see styles.ts. */
  style: import('./styles.ts').StyleName;
  animation: Partial<AnimationOptions>;
  /** Diagram width in px used for layout; the SVG stays responsive. */
  width: number;
  /** Extra breathing room around the diagram, in px. */
  padding: number;
  /** Draw the 4geeks background panel behind the diagram. */
  panel: boolean;
  /** Optional heading rendered above the chart in the export. */
  title?: string;
  /** Optional sub-heading. */
  subtitle?: string;
  /** Convenience for `animation.play` — set directly on the request rather
   *  than nested, folded into `animation` before the bake. */
  play?: PlayMode;
  /**
   * DESIGN 8.6: stretch or hurry the whole build by one multiplier — `0.5`
   * plays at half speed, `2` at double, `1` (the default) is the designed
   * timing. Clamped to 0.25–4. Order, easing and lag ratios never change;
   * see `animate.ts`'s `applySpeed`.
   */
  speed?: number;
}

export interface RepairNote {
  /** Stable id so the UI can group and the tests can assert. */
  rule: string;
  /** Human sentence: "removed the ```mermaid fence". */
  message: string;
  count: number;
}

export interface RepairResult {
  source: string;
  notes: RepairNote[];
}

export interface ParseError {
  message: string;
  /** 1-based, when mermaid tells us. */
  line?: number;
  column?: number;
  /** The offending source line, for inline display. */
  excerpt?: string;
}

/** One animatable thing found in the rendered SVG. */
export interface Element {
  el: SVGElement;
  kind: 'node' | 'edge' | 'label' | 'cluster' | 'decoration';
  /** Centre point in SVG user units, used for the geometric stagger. */
  cx: number;
  cy: number;
  /** Path length, for stroke draw-on. Only set on edges. */
  length?: number;
  /** Wave index — elements sharing an index animate together. */
  wave: number;
}

export interface Analysis {
  diagram: string;
  direction: 'TB' | 'LR' | 'RL' | 'BT' | 'radial';
  elements: Element[];
}

export interface RenderResult {
  /** The themed, animation-baked SVG markup. */
  svg: string;
  /** Stylesheet the SVG needs. Already inlined into `svg` and `html`. */
  css: string;
  /** Standalone page, ready to open or serve. */
  html: string;
  analysis: Analysis;
  repairs: RepairNote[];
  /** Total animation runtime in seconds — the CLI uses it to size the video. */
  runtime: number;
}
