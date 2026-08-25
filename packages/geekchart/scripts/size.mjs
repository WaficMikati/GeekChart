/**
 * Fails the build if the chunk fetched the moment a chart first mounts grows
 * past what pages using this package should have to pay for on first render.
 *
 * The set of files that make up that chunk is computed by `build.mjs` — the
 * one dynamic `import('@geekchart/core')` in `Geekchart.tsx` resolves to a
 * chunk that in turn statically imports several more, and that whole group is
 * what a browser fetches before anything can draw. mermaid's *own* further
 * lazy-loading (one chunk per diagram type it still renders itself) is
 * excluded on purpose: those load later, only for diagram types that need
 * them, so they are not part of this budget. See `build.mjs` for the graph
 * walk that tells the two apart, recorded in `.lazy-chunk.json`.
 */
import { brotliCompressSync } from 'node:zlib';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(root, 'dist');
const manifest = join(root, '.lazy-chunk.json');
const BUDGET_BYTES = 420 * 1024;

if (!existsSync(manifest) || !existsSync(dist)) {
  console.error('geekchart: no build output — run `pnpm --filter geekchart build` first.');
  process.exit(1);
}

const files = JSON.parse(readFileSync(manifest, 'utf8'));
if (files.length === 0) {
  console.error('geekchart: .lazy-chunk.json lists no files. Expected at least the @geekchart/core chunk.');
  process.exit(1);
}

let totalRaw = 0;
let totalBrotli = 0;
for (const file of files) {
  const buf = readFileSync(join(dist, file));
  const raw = statSync(join(dist, file)).size;
  const brotli = brotliCompressSync(buf).length;
  totalRaw += raw;
  totalBrotli += brotli;
  console.log(`  ${file}  ${(raw / 1024).toFixed(1)} kB raw  ${(brotli / 1024).toFixed(1)} kB brotli`);
}

console.log(`  total: ${(totalRaw / 1024).toFixed(1)} kB raw, ${(totalBrotli / 1024).toFixed(1)} kB brotli`);
console.log(`  budget: ${(BUDGET_BYTES / 1024).toFixed(0)} kB brotli`);

if (totalBrotli > BUDGET_BYTES) {
  console.error(
    `\ngeekchart: the chunk fetched on first chart mount is ${(totalBrotli / 1024).toFixed(1)} kB brotli, ` +
      `over the ${(BUDGET_BYTES / 1024).toFixed(0)} kB budget.`,
  );
  process.exit(1);
}
