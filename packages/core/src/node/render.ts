// `render`/`drawnType` are imported dynamically, inside the function, never
// at this module's top level: `chart.ts` statically imports `flow.ts` →
// `graph.ts` → `mermaid`, and mermaid's default import evaluates its
// DOMPurify singleton immediately, against whatever `window`/`document`
// exist *at that moment* — DOMPurify has no later hook to redo that
// detection. A static import here would resolve before `ensureNodeDom()`
// below ever runs, permanently wiring mermaid to a no-op sanitizer (missing
// even `addHook`) that fails on the first real parse. Only a dynamic
// `import()`, issued after the DOM shim is installed, orders this correctly.
import type { RenderOptions, RenderResult } from '../chart.ts';
import { ChartError } from '../chart-error.ts';
import { repair } from '../repair.ts';
import { ensureNodeDom } from './dom.ts';
import { makeNodeMeasurer } from './measure.ts';

/**
 * `render()`, without a browser anywhere in reach.
 *
 * Every diagram type `render()` recognizes (`drawnType()` — flowchart, state,
 * class, er, sequence, timeline, gantt, journey, quadrant, radar, xy, sankey,
 * treemap, kanban, pie, mindmap, gitgraph) goes through the drawn pipeline
 * (`flow.ts` and the family draw functions), which needs only two things a
 * browser used to provide: text measurement (`../node/measure.ts`'s fontkit
 * measurer, in place of a hidden `<text>` + `getBBox()`) and a `document` for
 * mermaid's own parser to sanitize labels through (`./dom.ts`'s lazy
 * `linkedom` shim). Neither needs Playwright, and nothing in this file's
 * import graph reaches it.
 *
 * Text outside that recognized set falls back to `render()`'s legacy path
 * (`render.ts`, `decorate.ts`, `normalize.ts`) — mermaid's own full renderer
 * plus a restyling layer, built on real `getBBox()` measurements and DOM
 * construction a `<canvas>` and SVG layout engine actually run. `linkedom`
 * does not implement any of that, so this throws early with a clear reason
 * instead of failing partway through with a missing-method error. Every
 * fixture in `fixtures/` recognizes as one of the drawn types; the legacy
 * path exists for mermaid syntax outside the charts this repo ships.
 */
export async function renderNode(source: string, options: RenderOptions = {}): Promise<RenderResult> {
  if (options.path === 'legacy') {
    throw new ChartError({
      message:
        'renderNode() cannot use the legacy mermaid renderer — it measures with a real getBBox() and builds ' +
        'a DOM linkedom does not implement. Render this with render() in a browser instead.',
    });
  }

  await ensureNodeDom();
  const { render, drawnType } = await import('../chart.ts');

  const { source: cleaned } = repair(source);
  const kind = options.kind ?? drawnType(cleaned);
  if (options.path !== 'flow' && kind === null) {
    throw new ChartError({
      message:
        "renderNode() doesn't recognize this diagram's type, so render() would fall back to the legacy " +
        "mermaid renderer, which needs a real browser. Pass options.kind to name a family explicitly, or " +
        'render this with render() in a browser.',
    });
  }

  return render(source, { ...options, measurer: options.measurer ?? makeNodeMeasurer() });
}
