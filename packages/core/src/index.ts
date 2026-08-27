export { ChartError } from './chart-error.ts';
export { render, isFlowchart, drawnType } from './chart.ts';
// `renderChart` (mermaid's own full render, for whatever `drawnType` does not
// yet recognize) and `defaultOptions`/`resetIds` are not re-exported here:
// `renderChart` drags in mermaid's theming/roughjs/markdown-in-labels stack,
// none of which the drawn pipeline above needs, and `chart.ts`'s `render()`
// already reaches it through a dynamic `import('./render.ts')` for exactly the
// diagram types that still need it. A caller that wants the legacy renderer
// directly — the CLI's Playwright driver does — imports it from
// `@geekchart/core/legacy`.
export { scopeCss } from './scope.ts';
// `fontFaceCss` itself is not re-exported here: it is ~300 kB of base64, and a
// static edge to it from this module's own graph would pull that data into
// every bundle that reaches this file — exactly what `ensureFonts`'s dynamic
// `import('./font-data.ts')` exists to avoid. Import it from the
// `@geekchart/core/font-data` subpath instead, as `@geekchart/react`'s
// `<GeekchartFonts>` does.
export { reactComponent, componentName } from './react.ts';
export type { ReactComponentInput } from './react.ts';
export type { Aspect, DrawnType } from './flow.ts';
export type { RenderOptions, RenderResult } from './chart.ts';
export {
  renderFlow,
  renderSequence,
  renderChronicle,
  renderPlot,
  renderBoard,
  renderRadial,
  renderCommits,
  sceneCss,
} from './flow.ts';
export type { FlowResult, FlowOptions } from './flow.ts';
export type { Measurer } from './layout/measure.ts';
export { toGraph } from './graph.ts';
export { toUnifiedGraph } from './unified.ts';
export { drawSequence, sequenceCss } from './sequence.ts';
export { toChronicle, drawChronicle, chronicleCss } from './chronicle.ts';
export { toPlot, drawPlot, plotCss } from './plot.ts';
export { toBoard, drawBoard, boardCss } from './boards.ts';
export type { Board, BoardKind } from './boards.ts';
export { toRadial, drawRadial, radialCss } from './radial.ts';
export type { Radial, RadialKind } from './radial.ts';
export { toCommits, drawCommits, commitsCss } from './commits.ts';
export type { Commits, CommitKind } from './commits.ts';
export type { Plot, PlotKind } from './plot.ts';
export type { Chronicle, ChronicleKind } from './chronicle.ts';
export type { Graph, GraphNode, GraphEdge, GraphCluster } from './graph.ts';
export { scenes } from './scene.ts';
export type { Scene, SceneName, FontOptions } from './scene.ts';
export { withFonts, inheritsFonts, INHERIT, SYSTEM_STACK, fontStacks } from './scene.ts';
export type { RenderInput } from './render.ts';
export { repair, DIAGRAM_KEYWORDS } from './repair.ts';
export { analyze, diagramType, directionOf } from './analyze.ts';
export { bake, defaultAnimation } from './animate.ts';
export { standaloneHtml, svgDocument } from './export.ts';
export { ensureFonts } from './fonts.ts';
export type { ExportOptions } from './export.ts';
export { themeCss, themeVariables, pageCss, paletteFor, toAttributeSelectors } from './theme.ts';
export { styles } from './styles.ts';
export type { StyleName, StyleSpec } from './styles.ts';
export * as tokens from './tokens.ts';
export { RULES } from './rules.ts';
export type { Rule } from './rules.ts';
// The legacy renderer's option and result shapes clash by name with the ones the
// top-level `render` uses, so they are re-exported under explicit names rather
// than a wildcard.
export type {
  ThemeName,
  PresetName,
  AnimationOptions,
  RepairNote,
  RepairResult,
  ParseError,
  Element,
  Analysis,
} from './types.ts';
export type {
  RenderOptions as LegacyRenderOptions,
  RenderResult as LegacyRenderResult,
} from './types.ts';
