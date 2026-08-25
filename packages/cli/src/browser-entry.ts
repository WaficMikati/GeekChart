import { ChartError, componentName, reactComponent, render, renderFlow, sceneCss, scenes, svgDocument, type RenderOptions, type SceneName } from '@geekchart/core';
// Mermaid's own full render (theming, roughjs, markdown-in-labels) is only
// worth the weight for whatever `drawnType` does not recognize — the drawn
// pipeline the rest of this file drives already handles everything else — so
// it lives behind its own subpath rather than the main entry.
import { renderChart, type RenderInput } from '@geekchart/core/legacy';

declare global {
  interface Window {
    geekchartRender: (
      source: string,
      options: RenderInput,
    ) => Promise<
      | { ok: true; svg: string; svgDocument: string; html: string; runtime: number; repairs: unknown[]; diagram: string; parts: number }
      | { ok: false; error: { message: string; line?: number; excerpt?: string } }
    >;
  }
}

/**
 * Errors are returned, not thrown: an exception crossing the Playwright
 * boundary arrives as an opaque string, and the CLI needs the line number.
 */
window.geekchartRender = async (source, options) => {
  try {
    const result = await renderChart(source, options);
    return {
      ok: true,
      svg: result.svg,
      svgDocument: svgDocument(result.svg),
      html: result.html,
      runtime: result.runtime,
      repairs: result.repairs,
      diagram: result.analysis.diagram,
      parts: result.analysis.elements.length,
    };
  } catch (err) {
    if (err instanceof ChartError) return { ok: false, error: err.detail };
    return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
  }
};

/** The new flowchart path: mermaid parses, ELK places, we draw. */
(window as unknown as { geekchartFlow: unknown }).geekchartFlow = async (
  source: string,
  options: { scene?: SceneName; width?: number },
) => {
  try {
    const result = await renderFlow(source, options);
    return {
      ok: true,
      svg: result.svg,
      html: result.html,
      nodes: result.graph.nodes.length,
      edges: result.graph.edges.length,
      clusters: result.graph.clusters.length,
      primaryPath: result.graph.primaryPath,
      cycle: result.cycle,
    };
  } catch (err) {
    return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
  }
};

(window as unknown as { geekchartSceneCss: unknown }).geekchartSceneCss = (name: SceneName) =>
  sceneCss(scenes[name]);

/** Bake a rendered chart into a standalone React component. */
(window as unknown as { geekchartReact: unknown }).geekchartReact = (input: {
  fileName: string;
  svg: string;
  css: string;
  summary: string;
  source?: string;
  meta?: string;
  javascript?: boolean;
  inherited?: boolean;
  measuredWith?: string;
}) =>
  reactComponent({
    ...input,
    name: componentName(input.fileName),
  });

/**
 * The unified entry the CLI drives: repair, then the drawn pipeline for
 * flowcharts and mermaid's renderer for everything else.
 */
(window as unknown as { geekchartAny: unknown }).geekchartAny = async (
  source: string,
  options: RenderOptions,
) => {
  try {
    const r = await render(source, options);
    return {
      ok: true,
      path: r.path,
      svg: r.svg,
      // The stylesheet on its own, for anything embedding the SVG rather than
      // opening the page: a gallery, a React component, a CMS block.
      css: r.css,
      svgFile: r.svgFile,
      html: r.html,
      repairs: r.repairs,
      cycle: r.cycle,
      diagram: r.diagram,
      nodes: r.nodes,
      edges: r.edges,
      summary: r.summary,
      warnings: r.warnings,
    };
  } catch (err) {
    if (err instanceof ChartError) return { ok: false, error: err.detail };
    return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
  }
};

export {};
