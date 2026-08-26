import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { brotliCompressSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Guards the shipped artefact, not the source — needs `pnpm --filter
 * geekchart build` to have already run (`pretest` does this). */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(root, 'dist');
const BUDGET_BYTES = 420 * 1024;

test('dist has the three published entries and fonts.css', () => {
  assert.ok(existsSync(dist), 'dist/ is missing — run `pnpm --filter geekchart build` first');
  for (const file of ['index.js', 'server.js', 'cli.js', 'fonts.css']) {
    assert.ok(existsSync(join(dist, file)), `missing dist/${file}`);
  }
});

test('the chunk fetched on first chart mount stays under the 420 kB brotli budget', () => {
  const manifestPath = join(root, '.lazy-chunk.json');
  assert.ok(existsSync(manifestPath), '.lazy-chunk.json is missing — run the build first');
  const files = JSON.parse(readFileSync(manifestPath, 'utf8')) as string[];
  assert.ok(files.length > 0, 'expected at least the @geekchart/core chunk');

  const total = files.reduce(
    (sum, f) => sum + brotliCompressSync(readFileSync(join(dist, f))).length,
    0,
  );
  assert.ok(
    total <= BUDGET_BYTES,
    `first-mount chunk is ${(total / 1024).toFixed(1)} kB brotli, over the ${(BUDGET_BYTES / 1024).toFixed(0)} kB budget`,
  );
});

test('the browser renderer ships inside dist, so geekchart/server works outside the monorepo', () => {
  // renderToSvg injects dist/renderer.js into a headless page. The build copies it
  // from @geekchart/cli; without it every server render throws "Renderer bundle missing".
  assert.ok(existsSync(join(dist, 'renderer.js')), 'dist/renderer.js is missing');
});
