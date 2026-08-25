/**
 * Build the React package.
 *
 * Three entries, because they have very different costs and nobody should pay
 * for one by importing another:
 *
 *   index      the live component; the renderer is dynamically imported, so
 *              mermaid and ELK land in a chunk fetched only when one mounts
 *   fonts      <GeekchartFonts />, which inlines the faces as data URLs — about
 *              300 kB, and opt-in for exactly that reason
 *   fonts.css  the same faces as real .woff2 files the bundler can serve and
 *              the browser can cache, which is the better default
 *
 * The distinction that makes real files safe here: core embeds its fonts because
 * it must *measure* text before laying anything out, and a face arriving late
 * bakes wrong geometry into the SVG permanently. A shipped component is already
 * laid out, so a face arriving late only restyles text that is already in the
 * right place.
 */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fontFaceCss } from '../core/src/font-data.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
mkdirSync(join(dist, 'fonts'), { recursive: true });

const result = await build({
  entryPoints: [join(here, 'src', 'index.ts'), join(here, 'src', 'fonts.tsx')],
  outdir: dist,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  // React stays the host app's copy; bundling a second one breaks hooks.
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  metafile: true,
  logLevel: 'error',
});

// Unpack the embedded faces into files the bundler can fingerprint and the
// browser can cache across pages.
let css = fontFaceCss;
let n = 0;
for (const [, family, base64] of fontFaceCss.matchAll(
  /font-family:'([^']+)'[^}]*?url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/g,
)) {
  const file = `${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${n++}.woff2`;
  writeFileSync(join(dist, 'fonts', file), Buffer.from(base64, 'base64'));
  css = css.replace(`data:font/woff2;base64,${base64}`, `./fonts/${file}`);
}
writeFileSync(join(dist, 'fonts.css'), css + '\n');

const sizes = Object.entries(result.metafile.outputs)
  .map(([f, o]) => `  ${f.replace(/.*dist\//, '')}  ${(o.bytes / 1024).toFixed(0)} kB`)
  .sort()
  .join('\n');
process.stderr.write(`${sizes}\n  extracted ${n} font files\n`);
