#!/usr/bin/env node
/**
 * Skip a package's build when nothing it depends on has changed since its
 * last output. `pnpm test` used to build `@geekchart/cli` and `geekchart` on
 * every run — about 1.2s and 4.4s respectively — even when nothing changed,
 * because the gallery and the test suite load the bundled `dist`, not
 * source. Comparing mtimes lets an unchanged run skip straight to the tests.
 *
 * CI always forces a real build: GitHub Actions sets `CI`, and a stale check
 * must never be able to hide a broken build in the one place that matters.
 *
 * Usage: node scripts/build-if-stale.mjs <cli|geekchart>
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

const TARGETS = {
  cli: {
    inputs: ['packages/cli/src', 'packages/cli/build.mjs', 'packages/core/src'],
    outputs: ['packages/cli/dist/renderer.js', 'packages/cli/dist/measure.js'],
    command: ['pnpm', '--filter', '@geekchart/cli', 'build'],
  },
  geekchart: {
    inputs: [
      'packages/geekchart/src',
      'packages/geekchart/build.mjs',
      'packages/core/src',
      // Copied into geekchart's own dist by its build — see build.mjs there.
      'packages/cli/dist/renderer.js',
    ],
    outputs: [
      'packages/geekchart/dist/index.js',
      'packages/geekchart/dist/server.js',
      'packages/geekchart/dist/cli.js',
    ],
    command: ['pnpm', '--filter', 'geekchart', 'build'],
  },
};

const name = process.argv[2];
const target = TARGETS[name];
if (!target) {
  console.error(`usage: build-if-stale.mjs <${Object.keys(TARGETS).join('|')}>`);
  process.exit(1);
}

function latestMtime(path) {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return -Infinity;
  if (st.isFile()) return st.mtimeMs;
  if (!st.isDirectory()) return -Infinity;
  let latest = st.mtimeMs;
  for (const entry of readdirSync(path)) {
    if (entry === 'dist' || entry === 'node_modules') continue;
    latest = Math.max(latest, latestMtime(join(path, entry)));
  }
  return latest;
}

const newestInput = Math.max(...target.inputs.map((p) => latestMtime(resolve(repo, p))));
const outputPaths = target.outputs.map((p) => resolve(repo, p));
const oldestOutput = outputPaths.every(existsSync)
  ? Math.min(...outputPaths.map((p) => statSync(p).mtimeMs))
  : -Infinity;

if (!process.env.CI && oldestOutput > newestInput) {
  console.error(`build-if-stale: ${name} is up to date, skipping build`);
  process.exit(0);
}

const [command, ...args] = target.command;
const result = spawnSync(command, args, { cwd: repo, stdio: 'inherit' });
process.exit(result.status ?? 1);
