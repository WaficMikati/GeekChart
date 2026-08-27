/**
 * The smallest DOM mermaid's parser needs, for the process that has none.
 *
 * `render()`'s drawn pipeline (`flow.ts` and the family draw functions) no
 * longer touches a real DOM at all once a `Measurer` is supplied — see
 * `./measure.ts` and `Drawing.extent` in `../draw.ts`. The one thing left
 * that still reaches for `document` is mermaid's own parser
 * (`graph.ts`'s `parseWith`, via `mermaid.mermaidAPI.getDiagramFromText`):
 * mermaid sanitizes every label through DOMPurify before handing back a
 * diagram database, and DOMPurify's sanitizer needs a real-enough `document`
 * to build a throwaway DOM tree in and walk it.
 *
 * Found by running each of the 37 fixtures' diagram types through
 * `mermaidAPI.getDiagramFromText` with nothing but `linkedom`'s `document`
 * installed, adding one more global each time something threw on a missing
 * constructor, until every fixture parsed clean. The final list, and why
 * DOMPurify wants each one:
 *
 *   - `document`   — `document.implementation.createHTMLDocument()` builds
 *                    the scratch document DOMPurify sanitizes into.
 *   - `window`     — DOMPurify's own feature-detection reads `window` before
 *                    it will run at all (`createDOMPurify(window)`'s guard).
 *   - `Node`       — `instanceof Node` gates every node DOMPurify visits.
 *   - `NodeFilter` — `NodeFilter.SHOW_ELEMENT` et al., for the `TreeWalker`
 *                    DOMPurify sanitizes with.
 *   - `Element`, `HTMLElement`, `SVGElement`
 *                  — `instanceof` checks that decide how a given node is
 *                    sanitized (mermaid labels can carry inline SVG/HTML).
 *   - `Text`, `Comment`
 *                  — node-type checks while walking the tree (text nodes
 *                    pass through untouched; comments are stripped).
 *
 * Nothing else in the parse or draw path was found to touch a DOM global —
 * confirmed by running all 37 fixtures through `renderNode()` with only this
 * list installed (see `packages/cli/scripts/gate.mjs --engine=node`).
 *
 * Installed lazily (only from `renderNode()`, never from this module's own
 * top level) and only when nothing has already put a `document` on
 * `globalThis` — a real browser, a test's own jsdom, or an earlier call to
 * this same function in the same process. A process that already has a DOM
 * keeps using it untouched; this never overwrites one.
 */
let installed = false;

const REQUIRED_GLOBALS = [
  'window',
  'Node',
  'NodeFilter',
  'Element',
  'HTMLElement',
  'SVGElement',
  'Text',
  'Comment',
] as const;

export async function ensureNodeDom(): Promise<void> {
  if (installed || typeof document !== 'undefined') return;
  // Dynamic and lazy: a caller that already has a real DOM (the browser
  // renderer, a browser test) never pays for linkedom, and never imports it
  // at all — `renderNode()` is the only caller.
  const { parseHTML } = await import('linkedom');
  const { window, document: doc } = parseHTML('<!doctype html><html><body></body></html>');
  const target = globalThis as Record<string, unknown>;
  for (const key of REQUIRED_GLOBALS) {
    if (target[key] === undefined) target[key] = (window as unknown as Record<string, unknown>)[key];
  }
  target.document = doc;
  installed = true;
}
