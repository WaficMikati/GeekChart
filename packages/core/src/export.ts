import type { RenderOptions } from './types.ts';
import { getFontFaceCss } from './fonts.ts';
import { pageCss } from './theme.ts';

export interface ExportOptions extends RenderOptions {
  /** Add the replay affordance. The chart still animates without it. */
  interactive?: boolean;
  /**
   * Link Google Fonts instead of embedding the faces. Smaller file, but the page
   * then needs the network and can render in a fallback font before they land.
   */
  webFonts?: boolean;
}

const GOOGLE_FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Lato:wght@400;700;900&display=swap';

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/**
 * Replay control.
 *
 * Re-inserting the SVG restarts every CSS animation on it, which is both the
 * shortest and the most reliable way to replay — no animation bookkeeping, no
 * risk of a half-reset element. The page animates fine with this script blocked.
 */
const replayScript = `
for (const svg of document.querySelectorAll('.gc-chart')) {
  const figure = svg.closest('.gc-figure') || svg.parentElement;
  const replay = () => {
    const parent = svg.parentNode, next = svg.nextSibling;
    svg.remove(); void document.body.offsetWidth; parent.insertBefore(svg, next);
  };
  const button = document.createElement('button');
  button.className = 'gc-replay'; button.type = 'button';
  button.textContent = 'Replay'; button.addEventListener('click', replay);
  figure.appendChild(button);
  svg.style.cursor = 'pointer';
  svg.addEventListener('click', replay);
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    for (const b of document.querySelectorAll('.gc-replay')) b.click();
  }
});
`;

const replayCss = `
.gc-replay { appearance: none; border: 1px solid currentColor; background: transparent;
  color: inherit; opacity: .5; font: inherit; font-size: 13px; padding: 6px 14px;
  border-radius: 999px; cursor: pointer; transition: opacity .15s; }
.gc-replay:hover { opacity: 1; }
@media print { .gc-replay { display: none; } }
`;

/** A page you can open, share or hand to the video capture — same markup for all three. */
export function standaloneHtml(svg: string, options: ExportOptions): string {
  const interactive = options.interactive ?? true;
  // Embedded by default: the exported page renders identically offline, and the
  // diagram was measured against these exact faces.
  const webFonts = options.webFonts ?? false;
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(options.title ?? 'Chart')}</title>`,
    webFonts
      ? '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
        `<link rel="stylesheet" href="${GOOGLE_FONTS_HREF}">`
      : `<style>${getFontFaceCss()}</style>`,
  ]
    .filter(Boolean)
    .join('\n  ');

  const heading =
    options.title || options.subtitle
      ? `<header class="gc-head">
      ${options.title ? `<h1 class="gc-title">${escapeHtml(options.title)}</h1>` : ''}
      ${options.subtitle ? `<p class="gc-subtitle">${escapeHtml(options.subtitle)}</p>` : ''}
    </header>`
      : '';

  const body = options.panel
    ? `<div class="gc-panel" style="padding:${options.padding + 8}px">${svg}</div>`
    : svg;

  return `<!doctype html>
<html lang="en" data-theme="${options.theme}">
<head>
  ${head}
  <style>${pageCss(options.theme)}${interactive ? replayCss : ''}</style>
</head>
<body>
  <figure class="gc-figure" style="max-width:min(${options.width}px, 100%)">
    ${heading}
    ${body}
  </figure>
  ${interactive ? `<script>${replayScript}</script>` : ''}
</body>
</html>
`;
}

/**
 * Standalone `.svg`, for dropping into a deck or a README.
 *
 * Animates in any browser; degrades to the final frame everywhere else, because
 * the un-animated state is the finished diagram rather than a blank one.
 */
export function svgDocument(svg: string, css?: string): string {
  const withNs = svg.includes('xmlns=')
    ? svg
    : svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  // The drawn pipeline keeps its stylesheet on the page rather than in the SVG,
  // so a standalone file has to carry a copy or it opens unstyled.
  const styled = css
    ? withNs.replace(/(<svg[^>]*>)/, `$1<style>${css.replace(/[<>&]/g, ' ')}</style>`)
    : withNs;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${styled}\n`;
}
