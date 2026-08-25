import type { ThemeName } from './types.ts';
import { dark, fonts, hex, hsl, light, shift, type Hsl, type Palette } from './tokens.ts';
import { pick, styles, type StyleName, type StyleSpec } from './styles.ts';

export function paletteFor(theme: ThemeName): Palette {
  return theme === 'dark' ? dark : light;
}

export const specFor = (style: StyleName): StyleSpec => styles[style];

/** Every colour a pack uses, resolved for one theme. */
function resolve(spec: StyleSpec, theme: ThemeName) {
  const at = (c: { light: Hsl; dark: Hsl }) => pick(c, theme);
  return {
    paper: at(spec.paper), fill: at(spec.fill), border: at(spec.border),
    line: at(spec.line), ink: at(spec.ink), quiet: at(spec.quiet),
  };
}

/**
 * Mermaid's own theme variables.
 *
 * These matter for the diagram types that paint with presentation attributes —
 * sequence, gantt, pie, git — which CSS cannot reach cleanly. Keeping them in
 * step with the pack means a diagram type we have never rendered still lands
 * close to the mark.
 */
export function themeVariables(theme: ThemeName, style: StyleName = 'blueprint'): Record<string, string> {
  const spec = styles[style];
  const c = resolve(spec, theme);
  const p = paletteFor(theme);
  const isDark = theme === 'dark';

  return {
    darkMode: String(isDark),
    background: hex(c.paper),
    fontFamily: fonts.sans,
    fontSize: '14px',

    primaryColor: hex(c.fill),
    primaryTextColor: hex(c.ink),
    primaryBorderColor: hex(c.border),
    mainBkg: hex(c.fill),
    nodeBorder: hex(c.border),
    nodeTextColor: hex(c.ink),
    secondaryColor: hex(shift(c.fill, isDark ? 4 : -3)),
    tertiaryColor: hex(shift(c.paper, isDark ? 3 : -2)),

    lineColor: hex(c.line),
    arrowheadColor: hex(c.line),
    textColor: hex(c.ink),
    edgeLabelBackground: hex(c.paper),

    clusterBkg: hex(shift(c.paper, isDark ? 2 : -2)),
    clusterBorder: hex(c.border),
    titleColor: hex(c.ink),

    actorBkg: hex(c.fill),
    actorBorder: hex(c.border),
    actorTextColor: hex(c.ink),
    actorLineColor: hex(c.border),
    signalColor: hex(c.line),
    signalTextColor: hex(c.ink),
    labelBoxBkgColor: hex(c.fill),
    labelBoxBorderColor: hex(c.border),
    labelTextColor: hex(c.ink),
    loopTextColor: hex(c.ink),
    activationBkgColor: hex(shift(c.fill, isDark ? 6 : -5)),
    activationBorderColor: hex(c.border),
    sequenceNumberColor: hex(c.paper),
    noteBkgColor: hex(shift(c.paper, isDark ? 4 : -4)),
    noteBorderColor: hex(c.border),
    noteTextColor: hex(c.ink),

    labelColor: hex(c.ink),
    altBackground: hex(shift(c.paper, isDark ? 2 : -2)),
    compositeBackground: hex(shift(c.paper, isDark ? 2 : -2)),
    compositeTitleBackground: hex(shift(c.paper, isDark ? 3 : -3)),
    compositeBorder: hex(c.border),
    innerEndBackground: hex(c.ink),
    specialStateColor: hex(c.ink),
    classText: hex(c.ink),

    ...Object.fromEntries(
      p.chart.flatMap((series, i) => [
        [`cScale${i}`, hex(series)],
        [`cScaleLabel${i}`, hex(isDark ? c.ink : c.paper)],
        [`pie${i + 1}`, hex(series)],
        [`git${i}`, hex(series)],
        [`gitBranchLabel${i}`, hex(c.paper)],
      ]),
    ),
    pieTitleTextColor: hex(c.ink),
    pieSectionTextColor: hex(isDark ? c.ink : c.paper),
    pieStrokeColor: hex(c.paper),
    pieOuterStrokeColor: hex(c.border),

    sectionBkgColor: hex(shift(c.paper, isDark ? 2 : -3)),
    sectionBkgColor2: hex(c.paper),
    taskBkgColor: hex(p.primary),
    taskTextColor: hex(p.primaryForeground),
    taskTextOutsideColor: hex(c.ink),
    taskTextDarkColor: hex(c.ink),
    gridColor: hex(c.border),
    todayLineColor: hex(p.accent),
    doneTaskBkgColor: hex(c.line),
    critBkgColor: hex(p.chart[3]),
  };
}

/**
 * The half of the styling that changes how wide text is.
 *
 * Handed to mermaid as `themeCSS`, so it is in force while mermaid measures
 * labels rather than applied after. Getting this wrong is invisible in review
 * and obvious in the output: boxes sized for one font, drawn with another.
 */
export function metricsCss(style: StyleName = 'blueprint'): string {
  const spec = styles[style];
  const nodeFace = spec.nodeFont === 'heading' ? fonts.heading : fonts.sans;
  const labelFace = spec.edgeLabelMono ? fonts.mono : fonts.sans;
  return `
.nodeLabel, .nodeLabel p, .label, .label text, text.actor tspan {
  font-family: ${nodeFace}; font-weight: ${spec.nodeWeight};
  font-size: ${spec.nodeSize}; letter-spacing: ${spec.nodeTracking}; }
.edgeLabel, .edgeLabel p { font-family: ${labelFace}; font-size: ${spec.edgeLabelSize};
  font-weight: 500; letter-spacing: ${spec.edgeLabelTracking};
  text-transform: ${spec.edgeLabelUpper ? 'uppercase' : 'none'}; }
/* Sequence diagrams get their type from inline styles mermaid writes onto each
   text element, so nothing but !important reaches them. It has to be here in the
   measurement sheet as well as in the rendered one, or mermaid reserves space
   for 16px text and then draws 10px into it. */
.messageText, .loopText, .noteText {
  font-family: ${labelFace} !important; font-size: ${spec.edgeLabelSize} !important;
  font-weight: 500 !important; letter-spacing: ${spec.edgeLabelTracking} !important;
  text-transform: ${spec.edgeLabelUpper ? 'uppercase' : 'none'} !important; }
.cluster-label text, .cluster-label p, .cluster span {
  font-family: ${spec.clusterTag ? fonts.mono : fonts.heading};
  font-weight: ${spec.clusterTag ? '500' : '700'};
  font-size: ${spec.clusterTag ? '10px' : '14px'};
  letter-spacing: ${spec.clusterTag ? '.16em' : '.005em'};
  text-transform: ${spec.clusterTag ? 'uppercase' : 'none'}; }
`;
}

/**
 * How the diagram looks at rest.
 *
 * Scoped to `#${id}` so several charts share a page. Written without the `>`
 * combinator and without `&`: `XMLSerializer` escapes those, and the escape
 * corrupts the rule that follows once the SVG is parsed back.
 */
export function themeCss(id: string, theme: ThemeName, style: StyleName = 'blueprint'): string {
  const spec = styles[style];
  const c = resolve(spec, theme);
  const isDark = theme === 'dark';
  // The id is repeated on purpose. Mermaid scopes its own rules as `#id .thing`,
  // which ties with ours on specificity and then wins on document order because
  // its stylesheet is appended after. `#id#id` outranks it without scattering
  // !important through the sheet — the sequence diagram's message text was being
  // drawn larger than it was measured because of exactly this.
  const s = `#${id}#${id}`;
  const p = paletteFor(theme);
  const nodeFace = spec.nodeFont === 'heading' ? fonts.heading : fonts.sans;
  const labelFace = spec.edgeLabelMono ? fonts.mono : fonts.sans;

  // One depth cue, never two. A box either has an outline or a shadow.
  const shadow =
    spec.depth === 'tight'
      ? isDark
        ? 'drop-shadow(0 1px 1px hsl(0 0% 0% / .55)) drop-shadow(0 2px 4px hsl(0 0% 0% / .4))'
        : 'drop-shadow(0 1px 1px hsl(222 30% 20% / .05)) drop-shadow(0 2px 4px hsl(222 30% 20% / .07))'
      : 'none';

  return `
${s} { --gc-paper: ${hsl(c.paper)}; --gc-fill: ${hsl(c.fill)}; --gc-border: ${hsl(c.border)};
  --gc-line: ${hsl(c.line)}; --gc-ink: ${hsl(c.ink)}; --gc-quiet: ${hsl(c.quiet)};
  --gc-accent: ${hsl(p.primary)}; --gc-node-stroke: ${spec.nodeStroke}px;
  font-family: ${fonts.sans}; max-width: 100%; height: auto; overflow: visible;
  -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; }

/* Text -------------------------------------------------------------------- */
${s} .nodeLabel, ${s} .label, ${s} text, ${s} tspan {
  font-family: ${nodeFace}; font-weight: ${spec.nodeWeight}; font-size: ${spec.nodeSize};
  letter-spacing: ${spec.nodeTracking}; fill: var(--gc-ink); color: var(--gc-ink); }
${s} .label text tspan.text-outer-tspan:nth-child(n+2) {
  fill: var(--gc-quiet); font-size: .84em; font-weight: 400; }

/* Nodes ------------------------------------------------------------------- */
${s} .node rect, ${s} .node polygon, ${s} .node circle, ${s} .node ellipse, ${s} .node path,
${s} .node .basic.label-container {
  rx: ${spec.radius}px; ry: ${spec.radius}px;
  fill: var(--gc-fill); stroke: var(--gc-border); stroke-width: ${spec.nodeStroke}px; }
${s} .node { filter: ${shadow}; }
${s} .gc-index { fill: var(--gc-quiet); opacity: .7; font-family: ${fonts.mono};
  font-weight: 500; font-size: 9px; letter-spacing: .16em; pointer-events: none; }

/* Edges ------------------------------------------------------------------- */
${s} .edgePath .path, ${s} .flowchart-link, ${s} .messageLine0, ${s} .messageLine1,
${s} .transition, ${s} .relation, ${s} .relationshipLine {
  stroke: var(--gc-line); stroke-width: ${spec.edgeStroke}px; stroke-linecap: round;
  stroke-linejoin: round; fill: none; }
${s} .gc-arrowhead { fill: var(--gc-line); stroke: none; }
${s} .arrowheadPath, ${s} marker path, ${s} marker circle, ${s} marker polygon {
  fill: var(--gc-line); stroke: var(--gc-line); stroke-width: .6px; }

/* Edge labels ------------------------------------------------------------- */
${s} .edgeLabel { font-family: ${labelFace}; font-size: ${spec.edgeLabelSize};
  font-weight: 500; letter-spacing: ${spec.edgeLabelTracking};
  text-transform: ${spec.edgeLabelUpper ? 'uppercase' : 'none'}; }
${s} .edgeLabel text, ${s} .edgeLabel tspan { fill: var(--gc-quiet);
  font-size: ${spec.edgeLabelSize}; font-weight: 500; letter-spacing: ${spec.edgeLabelTracking}; }
${s} .edgeLabel rect, ${s} .edgeLabel .labelBkg, ${s} .labelBkg {
  fill: var(--gc-paper) !important; stroke: none !important; opacity: 1; }

/* Subgraphs --------------------------------------------------------------- */
${s} .cluster rect, ${s} .cluster path {
  rx: ${spec.radius + 2}px; ry: ${spec.radius + 2}px;
  fill: ${hsl(shift(c.paper, isDark ? 2 : -2))}; stroke: var(--gc-border);
  stroke-width: 1px; ${spec.clusterDash === '0' ? '' : `stroke-dasharray: ${spec.clusterDash};`} }
${s} .cluster-label text, ${s} .cluster span {
  font-family: ${spec.clusterTag ? fonts.mono : fonts.heading};
  font-weight: ${spec.clusterTag ? '500' : '700'};
  font-size: ${spec.clusterTag ? '10px' : '14px'};
  letter-spacing: ${spec.clusterTag ? '.16em' : '.005em'};
  text-transform: ${spec.clusterTag ? 'uppercase' : 'none'};
  fill: ${spec.clusterTag ? 'var(--gc-quiet)' : 'var(--gc-ink)'}; }

/* Sequence and state ------------------------------------------------------ */
${s} .actor { stroke-width: ${spec.nodeStroke}px; fill: var(--gc-fill); stroke: var(--gc-border); }
${s} .actor-line { stroke: var(--gc-border); stroke-dasharray: 2 4; }
${s} .messageText, ${s} .loopText, ${s} .noteText {
  font-family: ${labelFace} !important; font-size: ${spec.edgeLabelSize} !important;
  font-weight: 500 !important; fill: var(--gc-quiet) !important;
  letter-spacing: ${spec.edgeLabelTracking} !important;
  text-transform: ${spec.edgeLabelUpper ? 'uppercase' : 'none'} !important; }
${s} .stateGroup .state-title { font-family: ${nodeFace}; font-weight: ${spec.nodeWeight}; }

/* Hover, for the live preview --------------------------------------------- */
${s} .node:hover :is(rect, polygon, circle, ellipse, path) { stroke: var(--gc-accent); }
`;
}

/** Page chrome around an exported chart. */
export function pageCss(theme: ThemeName, style: StyleName = 'blueprint'): string {
  const spec = styles[style];
  const c = resolve(spec, theme);
  const isDark = theme === 'dark';
  return `
:root { color-scheme: ${theme}; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 48px 24px;
  background: ${hsl(c.paper)}; color: ${hsl(c.ink)}; font-family: ${fonts.sans};
  -webkit-font-smoothing: antialiased; }
.gc-figure { display: flex; flex-direction: column; align-items: center; gap: 24px;
  width: fit-content; max-width: 100%; }
.gc-head { text-align: center; max-width: 60ch; }
.gc-title { font-family: ${fonts.heading}; font-weight: 900; font-size: clamp(22px, 3vw, 32px);
  letter-spacing: -.025em; margin: 0; }
.gc-subtitle { margin: 10px 0 0; color: ${hsl(c.quiet)}; font-size: 15px; line-height: 1.55; }
.gc-panel { background: ${hsl(c.paper)}; border: 1px solid ${hsl(c.border)};
  border-radius: ${spec.radius + 6}px; padding: 36px; max-width: 100%; overflow-x: auto;
  ${isDark ? '' : 'box-shadow: 0 1px 2px hsl(222 30% 20% / .04);'} }
.gc-panel svg { display: block; margin: 0 auto; }
`;
}

/**
 * Rewrite `.someClass` into `[class~="someClass"]` throughout a stylesheet's
 * selectors.
 *
 * Inside an inline-SVG `<style>`, Chrome does not match class selectors that
 * contain uppercase letters — `.edgeLabel` silently selects nothing while
 * `.node` works, so only some rules break and the failure looks random. The
 * attribute form matches reliably and carries identical specificity.
 *
 * Only selector preludes are touched, which is what keeps lengths like `.82em`
 * and `.5s` intact.
 */
export function toAttributeSelectors(css: string): string {
  const convert = (text: string) =>
    text.replace(/\.(-?[A-Za-z_][\w-]*)/g, (_, name: string) => `[class~="${name}"]`);

  let out = '';
  let prelude = '';
  let i = 0;

  while (i < css.length) {
    const char = css[i]!;
    if (char !== '{') {
      if (char === '}') {
        out += prelude + char;
        prelude = '';
      } else {
        prelude += char;
      }
      i++;
      continue;
    }

    // An at-rule wraps more rules, so keep walking into it. A style rule wraps
    // declarations, which are copied through untouched.
    const isAtRule = prelude.trimStart().startsWith('@');
    out += (isAtRule ? prelude : convert(prelude)) + char;
    prelude = '';
    i++;
    if (isAtRule) continue;

    let depth = 1;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
      out += css[i];
      i++;
    }
    out += '}';
    i++;
  }

  return out + prelude;
}
