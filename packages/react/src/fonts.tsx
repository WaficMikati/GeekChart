import { fontFaceCss } from '@geekchart/core/font-data';
import type { JSX } from 'react';

/**
 * The typefaces every chart's layout was measured in.
 *
 * A diagram's boxes are sized from the text inside them, at render time, in the
 * real faces. Ship the chart without them and the geometry is still correct for
 * fonts the page does not have: labels overflow their outlines, or sit in boxes
 * far too wide. It is not a flash of unstyled text — the wrong measurements are
 * already baked into the SVG.
 *
 * Include this once, near the root of the app. Each chart component then costs
 * only its own markup rather than carrying a copy of the fonts.
 *
 * ```tsx
 * // app/layout.tsx
 * import { GeekchartFonts } from '@geekchart/react';
 *
 * export default function RootLayout({ children }) {
 *   return (
 *     <html>
 *       <head><GeekchartFonts /></head>
 *       <body>{children}</body>
 *     </html>
 *   );
 * }
 * ```
 *
 * The faces are inlined as data URLs rather than linked, so a chart renders the
 * same offline, in CI, and when a font host is slow — and no third party learns
 * who is reading the page. Prefer a plain stylesheet? `import
 * '@geekchart/react/fonts.css'` does the same thing.
 */
export function GeekchartFonts(): JSX.Element {
  return <style data-geekchart-fonts="" dangerouslySetInnerHTML={{ __html: fontFaceCss }} />;
}

/** The same `@font-face` rules as a string, for a custom setup. */
export { fontFaceCss as geekchartFontFaceCss };
