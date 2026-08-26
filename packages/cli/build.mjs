/**
 * Bundle @geekchart/core for the browser.
 *
 * The CLI does not render mermaid itself — it injects this bundle into a
 * headless Chromium and calls the same function the web app calls. One renderer,
 * so a chart can never look different in the video than it did in the preview.
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'dist'), { recursive: true });

await build({
  entryPoints: [join(here, 'src', 'browser-entry.ts')],
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  platform: 'browser',
  minify: true,
  legalComments: 'none',
  outfile: join(here, 'dist', 'renderer.js'),
  logLevel: 'error',
});

console.error('built dist/renderer.js');

// The DESIGN.md checks (packages/cli/src/measure/), bundled the same way so
// the gate and the test suite call the exact same code inside the page.
await build({
  entryPoints: [join(here, 'src', 'measure-entry.ts')],
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  platform: 'browser',
  minify: true,
  legalComments: 'none',
  outfile: join(here, 'dist', 'measure.js'),
  logLevel: 'error',
});

console.error('built dist/measure.js');
