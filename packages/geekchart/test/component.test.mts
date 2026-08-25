import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Under the package root, not `os.tmpdir()`: the compiled file imports the
// bare specifiers `react` and `react-dom/server`, and Node resolves those by
// walking up from the importing file looking for `node_modules` — which a
// directory under `/tmp` does not have.
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const scratchDirs: string[] = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * The component under a fake SSR: `react-dom/server` in plain Node, with no
 * DOM at all. If anything in the module touched `document` or `window` at
 * import time or during render, this would throw before the assertions ever
 * run — that failure mode is the point of the test, not just the markup it
 * checks.
 *
 * Compiled with esbuild first because plain Node strips TypeScript types but
 * not JSX. `@geekchart/core` is left external and never resolved: the
 * component's only reference to it is a dynamic `import()` inside `useEffect`,
 * and `react-dom/server` never runs effects, so it must never be reached here.
 */

test('Geekchart renders a sized placeholder under SSR, never touching document', async () => {
  const dir = mkdtempSync(join(packageRoot, '.gc-ssr-'));
  scratchDirs.push(dir);
  const out = join(dir, 'Geekchart.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../src/Geekchart.tsx', import.meta.url))],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', '@geekchart/core'],
    logLevel: 'error',
  });

  const [{ Geekchart }, { createElement }, { renderToStaticMarkup }] = await Promise.all([
    import(out),
    import('react'),
    import('react-dom/server'),
  ]);

  const html = renderToStaticMarkup(
    createElement(Geekchart, { source: 'flowchart TD\nA-->B', className: 'my-chart' }),
  );

  assert.match(html, /class="my-chart"/);
  assert.match(html, /aspect-ratio/);
  // The placeholder, not a drawn chart — the parser chunk never ran.
  assert.doesNotMatch(html, /gc-chart/);
});

test('an explicit aspect sizes the placeholder to that ratio, not the 1000×560 default', async () => {
  const dir = mkdtempSync(join(packageRoot, '.gc-ssr-'));
  scratchDirs.push(dir);
  const out = join(dir, 'Geekchart.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../src/Geekchart.tsx', import.meta.url))],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', '@geekchart/core'],
    logLevel: 'error',
  });

  const [{ Geekchart }, { createElement }, { renderToStaticMarkup }] = await Promise.all([
    import(out),
    import('react'),
    import('react-dom/server'),
  ]);

  const html = renderToStaticMarkup(
    createElement(Geekchart, { source: 'flowchart TD\nA-->B', aspect: '1:1' }),
  );
  assert.match(html, /aspect-ratio:1(?:\.0+)?(?:;|"|$)/);
});
