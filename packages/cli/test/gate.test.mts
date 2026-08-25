import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The design gate, in the test suite.
 *
 * `pnpm gate` measures every chart in gallery.html against DESIGN.md. This runs
 * it with `--json` and fails on any FAIL that is not in `gate-allowlist.json` —
 * the list of charts known to be broken today. Each phase of PLAN.md deletes
 * its charts from that list, so the list shrinking is the progress bar, and a
 * chart that regresses after being removed turns the suite red.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const gallery = join(repo, 'gallery.html');
const gate = join(repo, 'packages', 'cli', 'scripts', 'gate.mjs');
const allowlistFile = join(here, 'gate-allowlist.json');

type Result = {
  chart: string;
  status: 'ok' | 'WARN' | 'FAIL';
  viewBox: [number, number] | null;
  fails: string[];
  warns: string[];
};

let results: Result[];

before(() => {
  if (!existsSync(gallery)) {
    const built = spawnSync('pnpm', ['gallery'], { cwd: repo, stdio: 'inherit' });
    assert.equal(built.status, 0, 'pnpm gallery failed');
  }
  // The gate exits 1 while anything FAILs, which is expected here — the
  // allowlist, not the exit code, decides whether this suite is green.
  const run = spawnSync(process.execPath, [gate, '--json'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.error, undefined, String(run.error));
  assert.ok(run.status === 0 || run.status === 1, `gate exited ${run.status}: ${run.stderr}`);
  results = JSON.parse(run.stdout);
  assert.ok(results.length > 0, 'gate measured no charts');
});

describe('design gate', () => {
  test('no chart FAILs that is not on the allowlist', () => {
    const allowed = new Set<string>(JSON.parse(readFileSync(allowlistFile, 'utf8')).charts);
    const unexpected = results
      .filter((r) => r.status === 'FAIL' && !allowed.has(r.chart))
      .map((r) => `${r.chart}: ${r.fails.join('; ')}`);
    assert.deepEqual(unexpected, [], `charts failing the gate that are not allowlisted:\n${unexpected.join('\n')}`);

    // Not a failure, but the reason the allowlist exists: say what can go.
    const fixed = [...allowed].filter((c) => !results.some((r) => r.chart === c && r.status === 'FAIL'));
    if (fixed.length) console.log(`allowlist entries that now pass — delete them: ${fixed.join(', ')}`);
  });
});
