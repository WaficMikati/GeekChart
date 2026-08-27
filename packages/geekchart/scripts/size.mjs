/**
 * Fails the build if the chunk fetched the moment a chart first mounts grows
 * past what pages using this package should have to pay for on first render.
 *
 * mermaid, `@mermaid-js/layout-elk` and `elkjs` are `external` in the real
 * build (they're ordinary npm `dependencies` now, resolved from a host app's
 * own `node_modules`, not bundled into `dist/`) — so `dist/index.js` alone
 * understates what a page actually downloads. `build.mjs` accounts for that
 * with a "host probe": a second, throwaway esbuild pass over `dist/index.js`
 * with those dependencies included, the way a consumer's bundler would
 * resolve them. That probe's output lands in `.probe/`, and the set of files
 * that make up the first-mount chunk — the one dynamic `import('@geekchart/core')`
 * in `Geekchart.tsx`, resolved to a chunk that in turn statically imports
 * several more, which together are what a browser fetches before anything
 * can draw — is recorded in `.lazy-chunk.json` as filenames relative to
 * `.probe/`. mermaid's *own* further lazy-loading (one chunk per diagram type
 * it still renders itself) is excluded on purpose: those load later, only
 * for diagram types that need them, so they are not part of this budget.
 */
import { brotliCompressSync } from 'node:zlib';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const probeDir = join(root, '.probe');
const manifest = join(root, '.lazy-chunk.json');
const BUDGET_BYTES = 420 * 1024;

if (!existsSync(manifest) || !existsSync(probeDir)) {
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
  const buf = readFileSync(join(probeDir, file));
  const raw = statSync(join(probeDir, file)).size;
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
