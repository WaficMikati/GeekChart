import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { renderToSvg } from '../src/server.ts';

/**
 * End-to-end check that a real `npm install` of this package — not this
 * repo's pnpm workspace symlinks — gets a working `geekchart`. This is the
 * one test in the suite that would have caught mermaid/ELK/fontkit/linkedom
 * staying `external` in build.mjs without becoming `dependencies` in
 * package.json: pnpm's workspace already has those packages on disk for
 * every other test here to find by accident, even if package.json never
 * declared them. A fresh `npm install` of the packed tarball has no such
 * accident to fall back on.
 *
 * Network access is required (installing the tarball plus `react`,
 * `react-dom`, and this package's own new `dependencies` from the real npm
 * registry) and this can take the better part of a minute, hence the long
 * timeout.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const repoRoot = join(packageRoot, '..', '..');

const controlPlane = join(repoRoot, 'fixtures', 'control-plane.mmd');
const firstAiApp = join(repoRoot, 'fixtures', 'blog', 'first-ai-app.mmd');

const RENDER_SCRIPT = `
import { renderToSvg } from 'geekchart/server';
import { readFileSync } from 'node:fs';

const [, , ...fixturePaths] = process.argv;
const svgs = [];
for (const path of fixturePaths) {
  const source = readFileSync(path, 'utf8');
  const { svg } = await renderToSvg(source, { cache: false });
  svgs.push(svg);
}
process.stdout.write(JSON.stringify(svgs));
`;

test(
  'a real npm install of the packed tarball renders and bundles without pulling in workspace symlinks',
  { timeout: 5 * 60 * 1000 },
  async () => {
    const packDir = mkdtempSync(join(tmpdir(), 'geekchart-pack-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'geekchart-consumer-'));
    try {
      // (a) Pack the package exactly as `npm publish` would ship it.
      const packJson = execFileSync(
        'npm',
        ['pack', '--pack-destination', packDir, '--json'],
        { cwd: packageRoot, encoding: 'utf8' },
      );
      const [{ filename }] = JSON.parse(packJson) as [{ filename: string }];
      const tarball = join(packDir, filename);

      // (b) A fresh project, unrelated to this repo's pnpm workspace — no
      // symlinks into the monorepo's node_modules are reachable from here,
      // so `mermaid` et al. can only resolve if npm actually installed them
      // as this package's own `dependencies`.
      writeFileSync(
        join(projectDir, 'package.json'),
        JSON.stringify({ name: 'geekchart-consumer-test', type: 'module', private: true }, null, 2),
      );
      try {
        execFileSync('npm', ['install', tarball, 'react', 'react-dom'], {
          cwd: projectDir,
          stdio: 'pipe',
        });
      } catch (err) {
        const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? String(err);
        assert.fail(`npm install failed in the consumer project:\n${stderr}`);
      }

      // (c) Render the same two fixtures both ways and require byte-for-byte
      // identical SVG: the installed package's dist/server.js against this
      // repo's own src/server.ts, with the same options.
      const scriptPath = join(projectDir, 'render.mjs');
      writeFileSync(scriptPath, RENDER_SCRIPT);
      const stdout = execFileSync(
        process.execPath,
        [scriptPath, controlPlane, firstAiApp],
        { cwd: projectDir, encoding: 'utf8' },
      );
      const [installedControlPlane, installedFirstAiApp] = JSON.parse(stdout) as [string, string];

      const expectedControlPlane = await renderToSvg(readFileSync(controlPlane, 'utf8'), { cache: false });
      const expectedFirstAiApp = await renderToSvg(readFileSync(firstAiApp, 'utf8'), { cache: false });

      assert.equal(installedControlPlane, expectedControlPlane.svg);
      assert.equal(installedFirstAiApp, expectedFirstAiApp.svg);

      // (d) The installed package still bundles cleanly for the browser with
      // a host bundler's own React external and everything else (mermaid,
      // ELK, …) resolved from the consumer's own `node_modules` — exactly
      // the scenario `THIRD_PARTY_EXTERNAL` in build.mjs is built for.
      const result = await build({
        absWorkingDir: projectDir,
        entryPoints: ['geekchart'],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        external: ['react', 'react/jsx-runtime', 'react-dom'],
        logLevel: 'silent',
      });
      assert.equal(result.errors.length, 0, 'host bundle of the installed package should succeed');
      const bundled = result.outputFiles.map((f) => f.text).join('\n');

      const bareImports = new Set<string>();
      for (const m of bundled.matchAll(/(?:import|export)[^'"(]*?from\s*["']([^"'.][^"']*)["']/g)) {
        if (m[1]) bareImports.add(m[1]);
      }
      const allowed = new Set(['react', 'react/jsx-runtime', 'react-dom']);
      const unexpected = [...bareImports].filter((spec) => !allowed.has(spec));
      assert.deepEqual(
        unexpected,
        [],
        `host bundle should resolve every dependency but react itself; found bare imports of: ${unexpected.join(', ')}`,
      );
    } finally {
      rmSync(packDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
);
