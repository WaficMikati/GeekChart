/**
 * The executable form of DESIGN.md's measured rules — one check per rule id,
 * run against a rendered chart's `<svg>`. `pnpm gate` (packages/cli/scripts/
 * gate.mjs) and the test suite both call `measureChart` against the same
 * bundle (dist/measure.js), so a rule is defined once.
 */
import {
  canvasWidth,
  aspect,
  centred,
  coverage,
  rowCentre,
  clipped,
  unbalancedRows,
  orphanColumns,
  native,
} from './canvas.ts';
import {
  boxSizes,
  offGridWarn,
  labelEscapeBox,
  rowGutters,
  soleChildCentre,
  minEdgeLength,
  sharedRow,
  panelEscape,
  panelHug,
} from './grid.ts';
import { typeSizes, minLegible, rotation, rawTag, textCentred, contrast } from './type.ts';
import {
  verticalMidline,
  shortJogs,
  detour,
  tooManyBends,
  crossing,
  channelCentre,
  clearance,
  arrivalSide,
  selfPierce,
  wrongSide,
  stackedArrowheads,
  multiHead,
  sharedSegment,
  parallelClearance,
  hairpin,
  longLoop,
} from './edges.ts';
import { labelOverlaps, labelSwallow, textShapeCollision, labelOnOtherEdge } from './labels.ts';
import { laneRide, laneOverrun, hashLabel } from './charts.ts';
import { createCtx, type Check, type Finding, type MeasureOptions } from './helpers.ts';

// Exact order of the fails/warns pushes in the pre-extraction gate.mjs, so a
// chart's line of rule numbers reads the same before and after this split.
export const ALL_CHECKS: Check[] = [
  native,
  canvasWidth,
  aspect,
  minLegible,
  typeSizes,
  rotation,
  labelOverlaps,
  labelSwallow,
  textShapeCollision,
  rowGutters,
  rowCentre,
  panelEscape,
  panelHug,
  labelEscapeBox,
  clipped,
  stackedArrowheads,
  boxSizes,
  offGridWarn,
  coverage,
  contrast,
  centred,
  textCentred,
  verticalMidline,
  shortJogs,
  detour,
  laneRide,
  laneOverrun,
  hashLabel,
  longLoop,
  multiHead,
  hairpin,
  arrivalSide,
  soleChildCentre,
  channelCentre,
  tooManyBends,
  crossing,
  selfPierce,
  clearance,
  wrongSide,
  orphanColumns,
  unbalancedRows,
  parallelClearance,
  sharedRow,
  sharedSegment,
  minEdgeLength,
  rawTag,
  labelOnOtherEdge,
];

export interface MeasureResult {
  fails: string[];
  warns: string[];
}

export function measureChart(svg: SVGSVGElement, opts: MeasureOptions = {}): MeasureResult {
  const ctx = createCtx(svg, opts);
  const fails: string[] = [];
  const warns: string[] = [];
  for (const check of ALL_CHECKS) {
    const findings: Finding[] = check.run(svg, ctx);
    for (const f of findings) (f.severity === 'fail' ? fails : warns).push(f.message);
  }
  return { fails, warns };
}

export * from './helpers.ts';
export { CANVAS_CHECKS } from './canvas.ts';
export { GRID_CHECKS } from './grid.ts';
export { TYPE_CHECKS } from './type.ts';
export { EDGE_CHECKS, edgeShapeStats } from './edges.ts';
export { LABEL_CHECKS } from './labels.ts';
export { CHART_CHECKS } from './charts.ts';
