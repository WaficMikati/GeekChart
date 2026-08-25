import type { FontOptions } from './scene.ts';

/**
 * Make the brand fonts usable before mermaid measures any text.
 *
 * Mermaid sizes every node from the text it renders, so a font that arrives
 * after layout leaves the boxes at fallback-font widths and the labels
 * overflowing. Unlike an ordinary flash of unstyled text, the wrong
 * measurements are baked into the SVG permanently.
 *
 * The faces are embedded rather than linked. `document.fonts.load()` resolves
 * immediately when no matching `@font-face` has been parsed yet, so waiting on a
 * `<link>` to Google Fonts is a race that quietly succeeds — and it makes the
 * output depend on the network. Inline data URLs register synchronously, which
 * turns the wait into a real one.
 *
 * `font-data.ts` is ~300 kB of base64 — nothing a chart drawn with
 * `fonts: 'inherit'` (the embedded component's default) ever reads. It is
 * imported dynamically, below, purely so a bundler puts it in its own chunk;
 * a caller that never asks for the embedded faces never pays to fetch it.
 */
const STYLE_ID = 'geekchart-fonts';

/**
 * Every face a scene can ask for, at the weights the scenes actually set.
 *
 * The serif and the mono belong here as much as the sans: the Manim scene sets
 * its titles in Source Serif 4 and its compartment rows in JetBrains Mono, so
 * leaving them out meant layout was measured against a fallback and then drawn
 * in the real face once it arrived.
 */
const WANTED = [
  '400 15px Archivo',
  '500 15px Archivo',
  '600 15px Archivo',
  '400 15px Lato',
  '700 15px Lato',
  "400 25px 'Source Serif 4'",
  "600 25px 'Source Serif 4'",
  "400 14px 'JetBrains Mono'",
  "500 14px 'JetBrains Mono'",
];

let pending: Promise<void> | null = null;
let cachedCss: string | undefined;

/**
 * Load the embedded faces, unless nothing drawn this render will use them.
 *
 * `fonts` is the same option a render call took: `'inherit'` hands every role
 * to the host page, so nothing downstream ever names Archivo, Lato, Source
 * Serif 4 or JetBrains Mono, and the ~300 kB of embedded font data can stay
 * unfetched. Anything else — the scene's own defaults, or a partial
 * `FontOptions` — may still use a brand face for at least one role, so it
 * loads as before.
 */
export function ensureFonts(fonts?: FontOptions | 'inherit', timeoutMs = 8000): Promise<void> {
  if (fonts === 'inherit') return Promise.resolve();

  // Trusting the cached promise alone is not enough. Anything that replaces the
  // document — `setContent` in a driven browser, a client-side route swap —
  // takes the injected faces with it, while this module still believes they are
  // loaded. Every render after that silently measures in a fallback face, which
  // is the one outcome embedding the fonts exists to prevent. Re-check that the
  // element is still there rather than assuming.
  const present = typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null;
  if (pending && present) return pending;

  pending = (async () => {
    const { fontFaceCss } = await import('./font-data.ts');
    cachedCss = fontFaceCss;

    if (typeof document === 'undefined' || !('fonts' in document)) return;

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = fontFaceCss;
      document.head.appendChild(style);
    }

    const load = Promise.all(WANTED.map((spec) => document.fonts.load(spec).catch(() => undefined)))
      .then(() => document.fonts.ready)
      .then(() => undefined);

    // Capped so a pathological environment renders in the fallback font rather
    // than hanging the whole tool.
    await Promise.race([load, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  })();

  return pending;
}

/** Test hook — forget that fonts were loaded. */
export function resetFonts(): void {
  pending = null;
  cachedCss = undefined;
}

/**
 * The embedded `@font-face` rules, once `ensureFonts` has loaded them.
 *
 * Empty before that, or after a render whose `fonts` was `'inherit'` — both
 * mean nothing on the page names a brand face, so a caller baking a standalone
 * export (`export.ts`) has nothing that needs embedding either.
 */
export function getFontFaceCss(): string {
  return cachedCss ?? '';
}
