import type { Hsl } from './tokens.ts';
import type { NormalizeSpec } from './normalize.ts';

/**
 * A style pack is a complete specification of how a diagram is drawn: its
 * palette, the weight and radius of every mark, its type, how far apart mermaid
 * spaces things, and how the geometry pass reshapes the result.
 *
 * They are whole directions rather than colour swaps, because that is the level
 * at which diagrams look designed or generated. Motion is deliberately not part
 * of a pack — any preset runs over any pack.
 */
export type StyleName = 'blueprint' | 'surface' | 'press';

export interface ThemedColor {
  light: Hsl;
  dark: Hsl;
}

export interface StyleSpec {
  label: string;
  description: string;

  /** Ground behind the diagram. */
  paper: ThemedColor;
  /** Fill inside a node. */
  fill: ThemedColor;
  /** Node outline. */
  border: ThemedColor;
  /** Edges and arrowheads. */
  line: ThemedColor;
  /** Node label text. */
  ink: ThemedColor;
  /** Edge labels, step marks, subtitles. */
  quiet: ThemedColor;

  /** Node corner radius, px. */
  radius: number;
  nodeStroke: number;
  edgeStroke: number;
  /** One depth cue at most: an outline, a tight shadow, or nothing. */
  depth: 'flat' | 'tight' | 'lifted';

  nodeFont: 'sans' | 'heading';
  nodeWeight: number;
  nodeSize: string;
  nodeTracking: string;

  edgeLabelMono: boolean;
  edgeLabelSize: string;
  edgeLabelTracking: string;
  edgeLabelUpper: boolean;

  /** Subgraph titles as a small tag rather than a heading. */
  clusterTag: boolean;
  clusterDash: string;
  /** Faint dot grid behind the diagram. */
  dotGrid: boolean;
  /** Step marks above each node. */
  numbering: boolean;

  /** Handed to mermaid before layout. */
  layout: {
    /** dagre routes edges through one dummy point per rank, which reads as noise. */
    engine: 'dagre' | 'elk';
    nodeSpacing: number;
    rankSpacing: number;
    padding: number;
    /** Narrower wrapping makes labels stack, which squares off decision diamonds. */
    wrappingWidth: number;
  };

  geometry: NormalizeSpec;
}

/**
 * Flat and technical. No shadows anywhere; a node is a box with a real outline,
 * and depth is communicated by the layout rather than by lighting.
 */
const blueprint: StyleSpec = {
  label: 'Blueprint',
  description: 'Flat, outlined, tight. Reads as an engineering drawing.',
  paper: { light: [0, 0, 100], dark: [220, 16, 7] },
  fill: { light: [0, 0, 100], dark: [220, 14, 11] },
  border: { light: [220, 13, 80], dark: [215, 12, 27] },
  line: { light: [220, 9, 58], dark: [215, 10, 52] },
  ink: { light: [223, 45, 11], dark: [210, 16, 93] },
  quiet: { light: [220, 9, 46], dark: [215, 10, 60] },

  radius: 4,
  nodeStroke: 1.25,
  edgeStroke: 1.25,
  depth: 'flat',

  nodeFont: 'sans',
  nodeWeight: 500,
  nodeSize: '13.5px',
  nodeTracking: '-.004em',

  edgeLabelMono: true,
  edgeLabelSize: '10px',
  edgeLabelTracking: '.1em',
  edgeLabelUpper: true,

  clusterTag: true,
  clusterDash: '0',
  dotGrid: false,
  numbering: false,

  layout: { engine: 'elk', nodeSpacing: 44, rankSpacing: 66, padding: 14, wrappingWidth: 150 },
  geometry: {
    uniformNodes: true, grid: 8, maxNodeWidth: 268, gutter: 26,
    edgeRouting: 'ports', edgeGap: 3, arrowLength: 8, arrowWidth: 6,
  },
};

/**
 * Soft product surfaces. Borderless cards on a tinted ground, lifted by one
 * tight shadow, with generous routing radii.
 */
const surface: StyleSpec = {
  label: 'Surface',
  description: 'Borderless cards, one tight shadow, soft routing.',
  paper: { light: [220, 24, 97], dark: [225, 14, 8] },
  fill: { light: [0, 0, 100], dark: [222, 13, 14] },
  border: { light: [220, 20, 92], dark: [222, 12, 19] },
  line: { light: [220, 12, 68], dark: [220, 10, 46] },
  ink: { light: [222, 40, 13], dark: [214, 18, 94] },
  quiet: { light: [220, 10, 50], dark: [216, 12, 62] },

  radius: 10,
  nodeStroke: 1,
  edgeStroke: 1.5,
  depth: 'tight',

  nodeFont: 'sans',
  nodeWeight: 600,
  nodeSize: '14px',
  nodeTracking: '-.008em',

  edgeLabelMono: false,
  edgeLabelSize: '11.5px',
  edgeLabelTracking: '0',
  edgeLabelUpper: false,

  clusterTag: false,
  clusterDash: '0',
  dotGrid: false,
  numbering: false,

  layout: { engine: 'elk', nodeSpacing: 52, rankSpacing: 80, padding: 16, wrappingWidth: 175 },
  geometry: {
    uniformNodes: true, grid: 8, maxNodeWidth: 280, gutter: 30,
    edgeRouting: 'ports', edgeGap: 5, arrowLength: 8, arrowWidth: 6,
  },
};

/**
 * Ink on paper. High contrast, hairline rules, near-square corners — a figure
 * set for print rather than a screen.
 */
const press: StyleSpec = {
  label: 'Press',
  description: 'Ink on warm paper. Hairlines, square corners, high contrast.',
  paper: { light: [40, 24, 98], dark: [250, 8, 9] },
  fill: { light: [40, 24, 98], dark: [250, 8, 9] },
  border: { light: [235, 22, 28], dark: [45, 12, 72] },
  line: { light: [235, 18, 38], dark: [45, 10, 64] },
  ink: { light: [235, 30, 12], dark: [45, 18, 92] },
  quiet: { light: [235, 12, 42], dark: [45, 8, 60] },

  radius: 2,
  nodeStroke: 1,
  edgeStroke: 1,
  depth: 'flat',

  nodeFont: 'heading',
  nodeWeight: 700,
  nodeSize: '13px',
  nodeTracking: '-.01em',

  edgeLabelMono: true,
  edgeLabelSize: '9.5px',
  edgeLabelTracking: '.16em',
  edgeLabelUpper: true,

  clusterTag: true,
  clusterDash: '3 4',
  dotGrid: false,
  numbering: true,

  layout: { engine: 'elk', nodeSpacing: 40, rankSpacing: 58, padding: 13, wrappingWidth: 140 },
  geometry: {
    uniformNodes: true, grid: 8, maxNodeWidth: 250, gutter: 24,
    edgeRouting: 'ports', edgeGap: 3, arrowLength: 8, arrowWidth: 6.5,
  },
};

export const styles: Record<StyleName, StyleSpec> = { blueprint, surface, press };

export const pick = (spec: ThemedColor, theme: 'light' | 'dark'): Hsl => spec[theme];
