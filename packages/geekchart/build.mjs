/**
 * Build the `geekchart` package: three entries, plus fonts.
 *
 * Only this repo's own code is bundled — `@geekchart/core`'s sources,
 * reached by relative import, are compiled straight in. mermaid,
 * `@mermaid-js/layout-elk`, `elkjs`, `fontkit` and `linkedom` are `external`
 * for every build below (see `THIRD_PARTY_EXTERNAL`): they ship as ordinary
 * `dependencies` in `package.json` instead, installed by npm alongside this
 * package rather than copied into `dist/`. A consumer's own bundler (or, in
 * Node, its own `node_modules` resolution) resolves them at their real
 * location, which is also what lets a bundler tree-shake mermaid instead of
 * receiving one fixed copy baked in here.
 *
 *   index    the live React component. Bundled for the browser with code
 *            splitting on, so the one dynamic `import('@geekchart/core')` in
 *            Geekchart.tsx lands in its own chunk — that chunk's own
 *            `import`s of mermaid and ELK are left as bare specifiers for the
 *            host app's bundler to resolve, fetched only when a chart first
 *            mounts.
 *   server   `renderToSvg`/`renderToHtml` for Node — SVG only, no browser.
 *   cli      `@geekchart/cli`'s own `main`, bundled straight in as the
 *            package's `bin`. `@geekchart/core` is `external` for this build
 *            (see `nodeCommon` below): neither entry imports it by its bare
 *            specifier in Node — both reach the Node renderer through a
 *            relative dynamic `import()` instead — and marking it external
 *            turns a future accidental static import into a loud runtime
 *            failure instead of a second multi-megabyte copy silently baked
 *            into the bundle. mermaid, ELK, fontkit and linkedom are resolved
 *            from `node_modules` at import time, same as any other npm
 *            dependency — Node needs no bundler step to do that.
 *
 * Every entry is minified with `legalComments: 'none'`. The only third-party
 * code still copied into `dist/` is the embedded font data (baked in by
 * `@geekchart/core/font-data`, unpacked into `dist/fonts/*.woff2` below) —
 * its licenses ship as one generated file, `dist/THIRD_PARTY_LICENSES`. This
 * package's own `LICENSE` is copied from the repo root at the bottom of this
 * script, into the package directory (not `dist`) — `npm pack` always
 * includes a `LICENSE` file found there, "files" whitelist or not.
 *
 * `dist` is wiped before every build. esbuild's code-splitting output is
 * content-hashed, so a build that reuses an old `dist` accumulates one stale
 * chunk per previous build rather than replacing it — which is exactly what
 * happened to `packages/react/dist` before this was added here.
 *
 * The one dynamic `import('@geekchart/core')` in Geekchart.tsx resolves to a
 * chunk that in turn statically imports several more of this package's own
 * files (the ones any render needs), and *that* whole statically-linked
 * group — now excluding mermaid and ELK themselves, which are external — is
 * what `.lazy-chunk.json` used to record directly from this build's own
 * metafile. It no longer does: with mermaid external, this build's own graph
 * understates what a page actually downloads, since a real host bundler
 * still has to fetch mermaid's code from wherever it resolves it. The "host
 * probe" step further down re-bundles `dist/index.js` with mermaid and its
 * dependencies included, the way a consumer's bundler would, and that walk
 * is what gets written to `.lazy-chunk.json` for `pnpm size` and the dist
 * test to measure.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fontFaceCss } from '../core/src/font-data.ts';

const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const probeDir = join(here, '.probe');

rmSync(dist, { recursive: true, force: true });
rmSync(probeDir, { recursive: true, force: true });
mkdirSync(join(dist, 'fonts'), { recursive: true });
mkdirSync(probeDir, { recursive: true });

// Walk an esbuild metafile's `outputs` from `startKey`, following only static
// `import-statement` edges (never `dynamic-import`, never `external`). Used
// below on two different metafiles: this build's own client bundle, and the
// throwaway "host probe" rebuild — same rule, same meaning either time:
// everything in the closure loads together, eagerly, the moment whatever
// dynamically imported `startKey` runs.
function staticClosure(outputs, startKey) {
  const closure = new Set();
  (function walk(key) {
    if (!key || closure.has(key)) return;
    closure.add(key);
    for (const imp of outputs[key].imports) {
      if (imp.external || imp.kind !== 'import-statement') continue;
      walk(imp.path);
    }
  })(startKey);
  return closure;
}

// React stays the host app's copy; bundling a second one breaks hooks.
const REACT_EXTERNAL = ['react', 'react/jsx-runtime', 'react-dom'];

// Third-party renderer dependencies: ordinary npm `dependencies` of this
// package (see package.json), never bundled into `dist/`. `elkjs/*` covers
// `elkjs/lib/elk.bundled.js`, the specific subpath `layout/elk.ts` dynamically
// imports.
const THIRD_PARTY_EXTERNAL = [
  'mermaid',
  '@mermaid-js/layout-elk',
  'elkjs',
  'elkjs/*',
  'fontkit',
  'linkedom',
];

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
  external: [...REACT_EXTERNAL, ...THIRD_PARTY_EXTERNAL],
  metafile: true,
  logLevel: 'error',
});

// This build's own dynamic-import closure from index.js — informational
// only now. With mermaid/ELK external, it no longer says what a browser
// actually downloads (see the "host probe" below, which does); it still
// shows how this package's own code is split.
const outputs = client.metafile.outputs;
const indexKey = Object.keys(outputs).find((f) => basename(f) === 'index.js');
const firstDynamic = outputs[indexKey].imports.find((i) => i.kind === 'dynamic-import');
const directLazyChunkFiles = [...staticClosure(outputs, firstDynamic?.path)].map((k) => basename(k)).sort();

// The "host probe": re-bundle the just-built `dist/index.js` with everything
// except React included — mermaid, `@mermaid-js/layout-elk`, `elkjs` resolved
// straight from `node_modules`, exactly as a consumer's own bundler would
// resolve this package's now-external dependencies. This is throwaway output
// (gitignored, rebuilt every `pnpm build`) that exists only so `pnpm size`
// can measure what a page really pays for on first chart mount, instead of
// the artificially small number this build's own metafile would report with
// those dependencies excluded.
const probe = await build({
  entryPoints: [join(dist, 'index.js')],
  outdir: probeDir,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  minify: true,
  legalComments: 'none',
  external: REACT_EXTERNAL,
  metafile: true,
  logLevel: 'error',
});

// Same "one dynamic import from index.js, then static edges only" rule as
// `directLazyChunkFiles` above, but on the probe's graph — this time mermaid
// and ELK are really there, so the closure is the true first-mount payload.
const probeOutputs = probe.metafile.outputs;
const probeIndexKey = Object.keys(probeOutputs).find((f) => basename(f) === 'index.js');
const probeFirstDynamic = probeOutputs[probeIndexKey].imports.find((i) => i.kind === 'dynamic-import');
const lazyChunkFiles = [...staticClosure(probeOutputs, probeFirstDynamic?.path)].map((k) => basename(k)).sort();

// Paths are bare filenames — they live directly under `.probe/`, not `dist/`
// — `pnpm size` (scripts/size.mjs) resolves them against `.probe/`.
writeFileSync(join(here, '.lazy-chunk.json'), JSON.stringify(lazyChunkFiles, null, 2) + '\n');

// mermaid's own further lazy-loading (one chunk per diagram type it still
// renders itself) only becomes visible now that the probe has mermaid's real
// code in its graph — these load later, only for diagram types that need
// them, so they're excluded from the budget above on purpose.
const probeJsFiles = readdirSync(probeDir).filter((f) => f.endsWith('.js')).sort();
const probeFurtherLazy = probeJsFiles.filter(
  (f) => f !== basename(probeIndexKey) && !lazyChunkFiles.includes(f),
);

const nodeCommon = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  minify: true,
  legalComments: 'none',
  // `@geekchart/core` itself is never imported by its bare specifier from
  // Node code in this build — `server.ts` and `cli.ts` both reach the Node
  // renderer (`renderNode`, `reactComponent`) through a relative dynamic
  // `import('../../core/src/...')` instead: a static import of a local file
  // does not drag that file's exported *types* into this package's own
  // `.d.ts` output the way a package import would. Keeping `@geekchart/core`
  // external regardless is a tripwire, not a size decision: a future static
  // `import from '@geekchart/core'` anywhere in this build's graph would
  // otherwise get silently re-bundled as a second copy of the whole graph —
  // it broke this way once before (`SYSTEM_STACK`, packages/cli/src/index.ts).
  // With it external, that mistake fails loudly at runtime instead of
  // bloating the tarball silently. mermaid/ELK/fontkit/linkedom are external
  // for the same reason `THIRD_PARTY_EXTERNAL` exists on the client build:
  // they're `dependencies` in package.json, resolved from `node_modules` at
  // runtime, not bundled here.
  external: ['@geekchart/core', ...THIRD_PARTY_EXTERNAL],
  logLevel: 'error',
};

// `server.ts` and `cli.ts` both dynamically import the same Node renderer
// (`@geekchart/core/node`'s `renderNode`, mermaid, ELK, fontkit, linkedom) —
// one `build()` call across both entries, with splitting on, is what lets
// esbuild notice that and put it in one shared chunk instead of bundling it
// twice. Built as two separate `outfile` builds before, `server.js` and
// `cli.js` each carried their own full copy of that graph.
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

// mermaid, ELK, fontkit and linkedom are `external` now (see
// `THIRD_PARTY_EXTERNAL` above) — their code is never copied into `dist/`,
// so their licenses travel with the copy npm installs from their own
// packages, not from here. The only third-party material still physically
// inside `dist/` is the embedded font data unpacked into `dist/fonts/*.woff2`
// just above — all four families are SIL Open Font License 1.1, whose terms
// require the copyright notice and the license text to travel with any copy.
const FONT_LICENSES = [
  ['JetBrains Mono', 'Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)'],
  ['Lato', 'Copyright (c) 2010-2014 by tyPoland Lukasz Dziedzic (team@latofonts.com) with Reserved Font Name "Lato"'],
  ['Source Serif 4', 'Copyright 2014 The Source Serif 4 Project Authors (https://github.com/adobe-fonts/source-serif)'],
  ['Archivo', 'Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)'],
];
const OFL_1_1_TEXT = `-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font
creation efforts of academic and linguistic communities, and to
provide a free and open framework in which fonts may be shared and
improved in partnership with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply to
any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software
components as distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to,
deleting, or substituting -- in part or in whole -- any of the
components of the Original Version, by changing formats or by porting
the Font Software to a new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed,
modify, redistribute, and sell modified and unmodified copies of the
Font Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in
Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the
corresponding Copyright Holder. This restriction only applies to the
primary font name as presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created using
the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.`;
const fontNotices = FONT_LICENSES.map(([family, notice]) => `${family}\n${notice}`).join('\n\n');
writeFileSync(
  join(dist, 'THIRD_PARTY_LICENSES'),
  'This package embeds the following fonts as base64-encoded woff2 data, unpacked\n' +
    'at build time into dist/fonts/*.woff2 and referenced from dist/fonts.css and\n' +
    'dist/fonts-manim.css. All four are licensed under the SIL Open Font License,\n' +
    'Version 1.1, reproduced once below for all of them.\n\n\n' +
    fontNotices + '\n\n\n' +
    OFL_1_1_TEXT + '\n',
);

// The repo's own LICENSE, so `npm pack` (which always includes a LICENSE file
// present in the package directory, "files" whitelist or not) ships one.
copyFileSync(join(here, '..', '..', 'LICENSE'), join(here, 'LICENSE'));

const jsFiles = readdirSync(dist).filter((f) => f.endsWith('.js')).sort();
const sizeLine = (f) => `  ${f}  ${(statSync(join(dist, f)).size / 1024).toFixed(1)} kB`;

process.stderr.write(
  `${jsFiles.map(sizeLine).join('\n')}\n` +
    `  fonts.css + fonts-manim.css + ${fontCount} font files\n` +
    `  this package's own eager chunk (mermaid/ELK external, not counted here): ${directLazyChunkFiles.join(', ')}\n` +
    `  host-probe first-mount chunk (\`pnpm size\` budget, mermaid/ELK resolved as a host bundler would, see .probe/): ${lazyChunkFiles.join(', ')}\n` +
    `  further lazy (mermaid's own per-diagram-type chunks, fetched only as needed): ${probeFurtherLazy.length} files\n`,
);
