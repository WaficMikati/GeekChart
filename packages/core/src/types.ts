export type ThemeName = 'light' | 'dark';

export type PresetName = 'cascade' | 'reveal' | 'flow' | 'spotlight' | 'none';

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
