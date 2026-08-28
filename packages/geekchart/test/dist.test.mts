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
const probeDir = join(root, '.probe');
const BUDGET_BYTES = 420 * 1024;

test('dist has the four published entries and fonts.css', () => {
  assert.ok(existsSync(dist), 'dist/ is missing — run `pnpm --filter geekchart build` first');
  for (const file of ['index.js', 'server.js', 'cli.js', 'observe.js', 'fonts.css']) {
    assert.ok(existsSync(join(dist, file)), `missing dist/${file}`);
  }
});

test('observe.js exports playInView and pulls in no React, mermaid or core', () => {
  // DESIGN 8.4: `geekchart/observe` has to run in a plain `<script
  // type="module">` on a page with no bundler and no other JavaScript at
  // all — nothing in its own dependency-free source may end up pulling in
  // React or this package's much heavier render path.
  const source = readFileSync(join(dist, 'observe.js'), 'utf8');
  assert.match(source, /playInView/);
  for (const forbidden of ['react', 'mermaid', '@geekchart/core']) {
    assert.ok(
      !source.toLowerCase().includes(forbidden),
      `dist/observe.js unexpectedly mentions "${forbidden}"`,
    );
  }
  // A few kB at most — this is one function and an IntersectionObserver
  // callback, not a bundle.
  assert.ok(source.length < 4096, `dist/observe.js is ${source.length} bytes, larger than expected`);
});

test('the chunk fetched on first chart mount stays under the 420 kB brotli budget', () => {
  // Measured from `.probe/` — build.mjs's throwaway re-bundle of dist/index.js
  // with mermaid/ELK resolved from node_modules, the way a host bundler
  // would, since those are `external` (npm `dependencies`) in the real build.
  const manifestPath = join(root, '.lazy-chunk.json');
  assert.ok(existsSync(manifestPath), '.lazy-chunk.json is missing — run the build first');
  const files = JSON.parse(readFileSync(manifestPath, 'utf8')) as string[];
  assert.ok(files.length > 0, 'expected at least the @geekchart/core chunk');

  const total = files.reduce(
    (sum, f) => sum + brotliCompressSync(readFileSync(join(probeDir, f))).length,
    0,
  );
  assert.ok(
    total <= BUDGET_BYTES,
    `first-mount chunk is ${(total / 1024).toFixed(1)} kB brotli, over the ${(BUDGET_BYTES / 1024).toFixed(0)} kB budget`,
  );
});
