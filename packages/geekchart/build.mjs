/**
 * Build the `geekchart` package: three entries, plus fonts.
 *
 *   index    the live React component. Bundled for the browser with code
 *            splitting on, so the one dynamic `import('@geekchart/core')` in
 *            Geekchart.tsx lands in its own chunk — mermaid, ELK and the
 *            renderer, fetched only when a chart first mounts.
 *   server   `renderToSvg`/`renderToHtml`/`closeServer` for Node. Bundled for
 *            node with `playwright` external, since it is only a peer
 *            dependency: an app that never renders never needs it installed.
 *   cli      `@geekchart/cli`'s own `main`, bundled straight in as the
 *            package's `bin`. `@geekchart/core` is `external` for this build
 *            (see `nodeCommon` below): the CLI never imports it in Node, it
 *            drives the copy already sitting in `dist/renderer.js` through a
 *            headless page, and marking it external turns a future accidental
 *            static import into a loud runtime failure instead of a second
 *            multi-megabyte copy silently baked into `cli.js`.
 *
 * Every entry is minified with `legalComments: 'none'`; the notices that
 * strips from mermaid's and ELK's own code ship instead as one generated
 * file, `dist/THIRD_PARTY_LICENSES`. This package's own `LICENSE` is copied
 * from the repo root at the bottom of this script, into the package directory
 * (not `dist`) — `npm pack` always includes a `LICENSE` file found there,
 * "files" whitelist or not.
 *
 * `dist` is wiped before every build. esbuild's code-splitting output is
 * content-hashed, so a build that reuses an old `dist` accumulates one stale
 * chunk per previous build rather than replacing it — which is exactly what
 * happened to `packages/react/dist` before this was added here.
 *
 * mermaid does its own further lazy-loading internally — one chunk per
 * diagram type it still renders itself (pie, mindmap, gitgraph, …) — so the
 * one `import('@geekchart/core')` in Geekchart.tsx does not resolve to a
 * single file. It resolves to a chunk that in turn statically imports several
 * more (the ones any render needs, not just some diagram types), and *that*
 * whole statically-linked group is what a browser actually fetches before a
 * chart can draw at all. Files reachable only through a *further* dynamic
 * import inside that group are excluded on purpose: they load later, only for
 * the diagram types that need them.
 *
 * The exact file list found by that walk is written to `.lazy-chunk.json`
 * (outside `dist`, so it never ships) for `pnpm size` and the dist test to
 * measure without redoing esbuild's own graph analysis.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fontFaceCss } from '../core/src/font-data.ts';

const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const ENTRY_FILES = new Set(['index.js', 'server.js', 'cli.js']);

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'fonts'), { recursive: true });

// React stays the host app's copy; bundling a second one breaks hooks.
const REACT_EXTERNAL = ['react', 'react/jsx-runtime', 'react-dom'];

const client = await build({
  entryPoints: [join(here, 'src', 'index.ts')],
  outdir: dist,
  entryNames: '[name]',
  chunkNames: 'chunk-[hash]',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  legalComments: 'none',
  external: REACT_EXTERNAL,
  metafile: true,
  logLevel: 'error',
});

// Walk from index.js's one dynamic import, following only static edges: that
// is everything fetched together, eagerly, the moment a chart first mounts.
const outputs = client.metafile.outputs;
const indexKey = Object.keys(outputs).find((f) => basename(f) === 'index.js');
const firstDynamic = outputs[indexKey].imports.find((i) => i.kind === 'dynamic-import');
const closure = new Set();
(function walk(key) {
  if (!key || closure.has(key)) return;
  closure.add(key);
  for (const imp of outputs[key].imports) {
    if (imp.external || imp.kind !== 'import-statement') continue;
    walk(imp.path);
  }
})(firstDynamic?.path);

const lazyChunkFiles = [...closure].map((k) => basename(k)).sort();
writeFileSync(join(here, '.lazy-chunk.json'), JSON.stringify(lazyChunkFiles, null, 2) + '\n');

const nodeCommon = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  minify: true,
  legalComments: 'none',
  // `playwright` is a peer dependency, not a bundled one — it ships native
  // browser binaries and must come from whatever install the host app did.
  //
  // `@geekchart/core` itself is never imported by its bare specifier from
  // Node code in this build — `server.ts` and `cli.ts` both reach the Node
  // renderer (`renderNode`, `reactComponent`) through a relative dynamic
  // `import('../../core/src/...')` instead, the same trick `browser.ts`'s
  // own dynamic import uses, and for the same reason: a static import of a
  // local file does not drag that file's exported *types* into this
  // package's own `.d.ts` output the way a package import would. Keeping
  // `@geekchart/core` external regardless is a tripwire, not a size
  // decision: a future static `import from '@geekchart/core'` anywhere in
  // this build's graph would otherwise get silently re-bundled as a second,
  // browser-flavoured copy of the whole graph — it broke this way once
  // before (`SYSTEM_STACK`, packages/cli/src/index.ts). With it external,
  // that mistake fails loudly at runtime instead of bloating the tarball
  // silently.
  external: ['playwright', '@geekchart/core'],
  logLevel: 'error',
};

// `server.ts` and `cli.ts` both dynamically import the same Node renderer
// (`@geekchart/core/node`'s `renderNode`, mermaid, ELK, fontkit, linkedom) —
// one `build()` call across both entries, with splitting on, is what lets
// esbuild notice that and put it in one shared chunk instead of bundling it
// twice. Built as two separate `outfile` builds before, `server.js` and
// `cli.js` each carried their own full copy of that graph (~7.3 MB each) on
// top of the ~6.3 MB browser bundle `dist/renderer.js` already ships for
// PNG/MP4 and `engine: 'browser'` — three copies of largely the same code.
// `chunkNames` gets its own `-node-` prefix so these chunks never collide
// with the client bundle's `chunk-[hash].js` files sitting in the same
// `dist/` directory (harmless even if they did, since names are content
// hashes, but there is no reason to rely on that).
await build({
  ...nodeCommon,
  entryPoints: [join(here, 'src', 'server.ts'), join(here, 'src', 'cli.ts')],
  outdir: dist,
  entryNames: '[name]',
  chunkNames: 'chunk-node-[hash]',
  splitting: true,
});
// `banner` on a multi-entry build would stamp the shebang onto every output,
// including `server.js` — prepended by hand to `cli.js` alone instead.
const cliJsPath = join(dist, 'cli.js');
writeFileSync(cliJsPath, `#!/usr/bin/env node\n${readFileSync(cliJsPath, 'utf8')}`);
chmodSync(cliJsPath, 0o755);

// Types, generated separately: esbuild only transpiles, it never checks or
// emits declarations. tsc's own rootDir/outDir rules mean this lands nested
// (see tsconfig.build.json) with a few unreferenced extras alongside it —
// declarations for files server.ts only reaches through a dynamic `import()`,
// which tsc still adds to the program and emits for regardless of whether
// anything published actually points at them. Only the four files this
// package's own source declares get promoted to `dist/*.d.ts`; the rest of
// the scratch tree is discarded.
const declTmp = join(dist, '.decl-tmp');
execFileSync(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), '-p', join(here, 'tsconfig.build.json')],
  { stdio: 'inherit' },
);
const declSrc = join(declTmp, 'geekchart', 'src');
for (const file of ['index.d.ts', 'Geekchart.d.ts', 'types.d.ts', 'server.d.ts']) {
  const text = readFileSync(join(declSrc, file), 'utf8')
    // `allowImportingTsExtensions` lets the source write `./Geekchart.tsx`,
    // but tsc's declaration emitter (unlike its JS emitter) writes that
    // specifier through verbatim rather than dropping the extension — and a
    // consumer's own type checker has no `Geekchart.tsx` to resolve it
    // against, only the `Geekchart.d.ts` this loop is about to write.
    .replace(/(from ['"]\.[^'"]*)\.tsx?(['"])/g, '$1$2');
  writeFileSync(join(dist, file), text);
}
rmSync(declTmp, { recursive: true, force: true });

// Unpack the embedded faces into files the bundler can fingerprint and the
// browser can cache across pages, same as `@geekchart/react` does.
//
// Source Serif 4 is set only by the `manim` scene's titles — every other
// scene never names it. It still gets its own `.woff2` file below (a consumer
// rendering `manim` needs it), but its `@font-face` rule goes to
// `fonts-manim.css` instead of the default `fonts.css`, the same way
// `ensureFonts` (`@geekchart/core/src/fonts.ts`) only fetches the embedded
// faces a render will actually use rather than all of them unconditionally.
let css = '';
let manimCss = '';
let fontCount = 0;
for (const [block, body] of fontFaceCss.matchAll(/(@font-face\{([^}]*)\})/g)) {
  const family = /font-family:'([^']+)'/.exec(body)[1];
  const base64 = /base64,([A-Za-z0-9+/=]+)\)/.exec(body)[1];
  const file = `${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${fontCount++}.woff2`;
  writeFileSync(join(dist, 'fonts', file), Buffer.from(base64, 'base64'));
  const rule = block.replace(`data:font/woff2;base64,${base64}`, `./fonts/${file}`);
  if (family === 'Source Serif 4') manimCss += rule;
  else css += rule;
}
writeFileSync(join(dist, 'fonts.css'), css + '\n');
writeFileSync(join(dist, 'fonts-manim.css'), manimCss + '\n');

// The server entry and the CLI render in a headless browser by injecting the
// browser renderer bundle, which @geekchart/cli builds. It has to ship inside
// this package's dist — an npm consumer has no monorepo to find it in.
const renderer = join(here, '..', 'cli', 'dist', 'renderer.js');
if (!existsSync(renderer)) throw new Error('packages/cli/dist/renderer.js is missing — run `pnpm --filter @geekchart/cli build` first');
copyFileSync(renderer, join(dist, 'renderer.js'));

// `legalComments: 'none'` on every build above drops mermaid's and ELK's own
// license headers from the minified output. They stay permissive enough to
// bundle (MIT, EPL-2.0) but the notice still has to travel with the code
// somewhere — ship their license texts as one file instead of the inline
// comments esbuild would otherwise scatter through dist.
const THIRD_PARTY = [
  ['mermaid', 'MIT'],
  ['elkjs', 'EPL-2.0 OR GPL-3.0-or-later'],
  ['@mermaid-js/layout-elk', 'MIT'],
];
// Resolved from `@geekchart/core`, not this package: mermaid/elkjs are its
// dependencies, not `geekchart`'s own, and pnpm's per-package node_modules
// means `require` from here can't see them directly.
const coreRequire = createRequire(join(here, '..', 'core', 'package.json'));
const thirdPartyText = THIRD_PARTY.map(([name, license]) => {
  const dir = dirname(coreRequire.resolve(`${name}/package.json`));
  const licenseFile = ['LICENSE', 'LICENSE.md', 'LICENCE'].map((f) => join(dir, f)).find(existsSync);
  const text = licenseFile
    ? readFileSync(licenseFile, 'utf8').trim()
    : '(license text not found alongside the package; see its package.json "license" field)';
  const heading = `${name} — ${license}`;
  return `${heading}\n${'='.repeat(heading.length)}\n${text}`;
}).join('\n\n\n');
writeFileSync(
  join(dist, 'THIRD_PARTY_LICENSES'),
  'This package bundles the following third-party code, minified, with their own\n' +
    "license comment headers stripped by esbuild's `legalComments: 'none'`. The\n" +
    'notices below travel with it instead.\n\n\n' +
    thirdPartyText + '\n',
);

// The repo's own LICENSE, so `npm pack` (which always includes a LICENSE file
// present in the package directory, "files" whitelist or not) ships one.
copyFileSync(join(here, '..', '..', 'LICENSE'), join(here, 'LICENSE'));

const jsFiles = readdirSync(dist).filter((f) => f.endsWith('.js')).sort();
const furtherLazy = jsFiles.filter((f) => !ENTRY_FILES.has(f) && !lazyChunkFiles.includes(f));
const sizeLine = (f) => `  ${f}  ${(statSync(join(dist, f)).size / 1024).toFixed(1)} kB`;

process.stderr.write(
  `${jsFiles.map(sizeLine).join('\n')}\n` +
    `  fonts.css + fonts-manim.css + ${fontCount} font files\n` +
    `  eager lazy chunk (\`pnpm size\` budget): ${lazyChunkFiles.join(', ')}\n` +
    `  further lazy (mermaid's own per-diagram-type chunks, fetched only as needed): ${furtherLazy.length} files\n`,
);
