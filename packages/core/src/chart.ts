import { repair } from './repair.ts';
import {
  renderBoard, renderChronicle, renderCommits, renderFlow, renderPlot, renderRadial, renderSequence,
  type DrawnType, type FlowOptions,
} from './flow.ts';
import { ChartError } from './chart-error.ts';
import type { RenderInput } from './render.ts';
import { svgDocument } from './export.ts';
import type { RepairNote } from './types.ts';
import type { SceneName } from './scene.ts';

/**
 * The one entry point.
 *
 * Flowcharts go through the drawn pipeline — mermaid parses, ELK places, we draw
 * and animate. Every other diagram type still goes through mermaid's own
 * renderer with the older restyling layer, so nothing regresses while those are
 * ported one at a time.
 *
 * Repair runs here rather than inside either renderer, so a damaged paste is
 * cleaned once and both paths see the same corrected source. The flow renderer
 * had been skipping it entirely.
 */

export interface RenderOptions extends FlowOptions {
  /** Forces a path. Mostly for tests; normally the diagram type decides. */
  path?: 'flow' | 'legacy';
  /** Options handed to the legacy renderer for non-flowchart diagrams. */
  legacy?: RenderInput;
}

export interface RenderResult {
  /** Which renderer produced this. */
  path: 'flow' | 'legacy';
  svg: string;
  /** Standalone `.svg` document, ready to write to disk. */
  svgFile: string;
  html: string;
  css: string;
  /** Everything the repair pass changed, to show the user. */
  repairs: RepairNote[];
  /** Seconds for one animation loop; 0 when static. */
  cycle: number;
  diagram: string;
  nodes: number;
  edges: number;
  /** Ids along the spine, when the drawn pipeline handled it. */
  primaryPath: string[];
  /**
   * A one-line description of what the chart shows.
   *
   * Exists so an embedded chart has an accessible name. An SVG with no
   * alternative text is announced as nothing at all, and a generated component
   * that ships without one makes every page that uses it worse.
   */
  summary: string;
  /** Things worth telling the user that are not errors. */
  warnings: string[];
}

/** Name the diagram by what is actually in it, for screen readers. */
function describe(kind: string, titles: string[], edges: number): string {
  const named = titles.filter(Boolean);
  const noun = kind === 'flowchart' ? 'Flowchart' :
    kind === 'state' ? 'State diagram' :
    kind === 'class' ? 'Class diagram' :
    kind === 'er' ? 'Entity relationship diagram' : 'Diagram';
  if (!named.length) return `${noun} with ${edges} connection${edges === 1 ? '' : 's'}.`;
  const shown = named.slice(0, 8);
  const rest = named.length - shown.length;
  const list = shown.join(', ') + (rest > 0 ? `, and ${rest} more` : '');
  return `${noun}: ${list}. ${edges} connection${edges === 1 ? '' : 's'}.`;
}

/**
 * The diagram types the drawn pipeline handles, keyed by the word that opens the
 * source. Anything absent still goes to mermaid's own renderer.
 */
const DRAWN: [RegExp, DrawnType][] = [
  [/^(?:flowchart|graph)\b/i, 'flowchart'],
  [/^stateDiagram(?:-v2)?\b/i, 'state'],
  [/^classDiagram(?:-v2)?\b/i, 'class'],
  [/^erDiagram\b/i, 'er'],
  [/^sequenceDiagram\b/i, 'sequence'],
  [/^timeline\b/i, 'timeline'],
  [/^gantt\b/i, 'gantt'],
  [/^journey\b/i, 'journey'],
  [/^quadrantChart\b/i, 'quadrant'],
  [/^radar(?:-beta)?\b/i, 'radar'],
  [/^xychart(?:-beta)?\b/i, 'xy'],
  [/^sankey(?:-beta)?\b/i, 'sankey'],
  [/^treemap(?:-beta)?\b/i, 'treemap'],
  [/^kanban\b/i, 'kanban'],
  [/^pie\b/i, 'pie'],
  [/^mindmap\b/i, 'mindmap'],
  [/^gitGraph\b/i, 'gitgraph'],
];

/** The three that share only their chrome — a flow, an area, a board. */
const BOARDS = new Set<DrawnType>(['sankey', 'treemap', 'kanban']);

/** The three whose marks encode quantities, so charting rules apply. */
const PLOTS = new Set<DrawnType>(['quadrant', 'radar', 'xy']);

/** The three that share a time axis rather than a graph. */
const CHRONICLES = new Set<DrawnType>(['timeline', 'gantt', 'journey']);

/** Pie and mindmap: everything placed relative to one centre. */
const RADIAL = new Set<DrawnType>(['pie', 'mindmap']);

/** Strip front matter and `%%{init}%%` directives so the first word is the type. */
function body(source: string): string {
  return source
    .replace(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/^(\s*%%\{[\s\S]*?\}%%\s*\n)+/, '')
    .replace(/^(?:\s*%%[^\n]*\n)+/, '')
    .trimStart();
}

/** Which drawn renderer handles this source, if any. */
export function drawnType(source: string): DrawnType | null {
  const text = body(source);
  for (const [pattern, type] of DRAWN) if (pattern.test(text)) return type;
  return null;
}

/** Does this look like a flowchart, ignoring front matter and directives? */
export function isFlowchart(source: string): boolean {
  return drawnType(source) === 'flowchart';
}

export async function render(source: string, options: RenderOptions = {}): Promise<RenderResult> {
  const { source: cleaned, notes } = repair(source);
  if (!cleaned.trim()) {
    throw new ChartError({ message: 'Nothing to draw — the diagram is empty.' });
  }

  const detected = drawnType(cleaned);
  const kind = options.kind ?? detected ?? 'flowchart';
  const useFlow = options.path ? options.path === 'flow' : detected !== null;

  if (useFlow && BOARDS.has(kind)) {
    const b = await renderBoard(cleaned, kind as 'sankey' | 'treemap' | 'kanban', options);
    return {
      path: 'flow', svg: b.svg, svgFile: svgDocument(b.svg, b.css), html: b.html, css: b.css,
      repairs: notes, cycle: b.cycle, diagram: kind, nodes: b.items, edges: b.lanes,
      primaryPath: [], summary: b.summary, warnings: b.warnings,
    };
  }

  if (useFlow && PLOTS.has(kind)) {
    const p = await renderPlot(cleaned, kind as 'quadrant' | 'radar' | 'xy', options);
    return {
      path: 'flow', svg: p.svg, svgFile: svgDocument(p.svg, p.css), html: p.html, css: p.css,
      repairs: notes, cycle: p.cycle, diagram: kind, nodes: p.items, edges: p.lanes,
      primaryPath: [], summary: p.summary, warnings: p.warnings,
    };
  }

  if (useFlow && CHRONICLES.has(kind)) {
    const chron = await renderChronicle(cleaned, kind as 'timeline' | 'gantt' | 'journey', options);
    return {
      path: 'flow',
      svg: chron.svg,
      svgFile: svgDocument(chron.svg, chron.css),
      html: chron.html,
      css: chron.css,
      repairs: notes,
      cycle: chron.cycle,
      diagram: kind,
      nodes: chron.items,
      edges: chron.lanes,
      primaryPath: [],
      summary: chron.summary,
      warnings: chron.warnings,
    };
  }

  if (useFlow && RADIAL.has(kind)) {
    const rad = await renderRadial(cleaned, kind as 'pie' | 'mindmap', options);
    return {
      path: 'flow', svg: rad.svg, svgFile: svgDocument(rad.svg, rad.css), html: rad.html, css: rad.css,
      repairs: notes, cycle: rad.cycle, diagram: kind, nodes: rad.items, edges: rad.lanes,
      primaryPath: [], summary: rad.summary, warnings: rad.warnings,
    };
  }

  if (useFlow && kind === 'gitgraph') {
    const commits = await renderCommits(cleaned, options);
    return {
      path: 'flow', svg: commits.svg, svgFile: svgDocument(commits.svg, commits.css), html: commits.html, css: commits.css,
      repairs: notes, cycle: commits.cycle, diagram: kind, nodes: commits.items, edges: commits.lanes,
      primaryPath: [], summary: commits.summary, warnings: commits.warnings,
    };
  }

  if (useFlow && kind === 'sequence') {
    const seq = await renderSequence(cleaned, options);
    return {
      path: 'flow',
      svg: seq.svg,
      svgFile: svgDocument(seq.svg, seq.css),
      html: seq.html,
      css: seq.css,
      repairs: notes,
      cycle: seq.cycle,
      diagram: 'sequence',
      nodes: seq.participants,
      edges: seq.messages,
      primaryPath: [],
      summary: seq.summary,
      warnings: seq.warnings,
    };
  }

  if (useFlow) {
    const flow = await renderFlow(cleaned, { ...options, kind });
    return {
      path: 'flow',
      svg: flow.svg,
      svgFile: svgDocument(flow.svg, flow.css),
      html: flow.html,
      css: flow.css,
      repairs: notes,
      cycle: flow.cycle,
      diagram: kind,
      nodes: flow.graph.nodes.length,
      edges: flow.graph.edges.length,
      primaryPath: flow.graph.primaryPath,
      summary: describe(
        kind,
        flow.graph.nodes.map((n) => n.title),
        flow.graph.edges.length,
      ),
      warnings: flow.warnings,
    };
  }

  // Dynamic: mermaid's own full render — theming, roughjs, markdown-in-labels —
  // is dead weight for every diagram type the drawn pipeline above already
  // handles, and this branch is the only caller left. A static import would put
  // it back in every bundle that reaches this file, flow diagrams included.
  const { renderChart } = await import('./render.ts');
  const legacy = await renderChart(cleaned, options.legacy ?? {});
  return {
    path: 'legacy',
    svg: legacy.svg,
    svgFile: svgDocument(legacy.svg),
    html: legacy.html,
    css: legacy.css,
    // The legacy renderer repairs internally too; these are the notes from the
    // single pass above, which is the one that actually changed the source.
    repairs: notes,
    cycle: legacy.runtime,
    diagram: legacy.analysis.diagram,
    nodes: legacy.analysis.elements.filter((e) => e.kind === 'node').length,
    edges: legacy.analysis.elements.filter((e) => e.kind === 'edge').length,
    primaryPath: [],
    summary: `${legacy.analysis.diagram} diagram.`,
    warnings: [],
  };
}

export type { SceneName };
export type { Aspect } from './flow.ts';
