import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAny, type AnyReply, type Session } from '../src/browser.ts';
import { getSession } from './helpers/session.ts';
import { cachedRender } from './helpers/render-cache.ts';

/**
 * The Node engine (`renderNode()`, `@geekchart/core/node`) against the
 * browser engine (`renderAny`, the same `render()` from `@geekchart/core`
 * driven inside headless Chromium) — every fixture, not just the six
 * `packages/cli/scripts/spike-node.mjs` compares by default.
 *
 * The two measure text differently (fontkit's glyph advances, rounded to
 * match Chromium, vs. a real hidden `<text>` + `getBBox()`) and are not
 * expected to draw byte-identical SVGs — `viewBox` should still match
 * exactly (a fixture is either the same overall size or something is really
 * wrong), and every drawn box (`x`/`y`/`width`/`height` on a node, panel,
 * plate or point) should land within 2 units of the browser's, the same bar
 * `docs/dev/` set for this port.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const fixturesRoot = join(repo, 'fixtures');
const fixturesBlog = join(fixturesRoot, 'blog');

const FIXTURES = [
  ...readdirSync(fixturesRoot)
    .filter((f) => f.endsWith('.mmd'))
    .map((f) => join(fixturesRoot, f)),
  ...readdirSync(fixturesBlog)
    .filter((f) => f.endsWith('.mmd'))
    .map((f) => join(fixturesBlog, f)),
].sort();

let session: Session;
let renderNode: (source: string, options?: Record<string, unknown>) => Promise<{ svg: string }>;

before(async () => {
  session = await getSession();
  ({ renderNode } = await import('../../core/src/node/render.ts'));
});

const ok = (reply: AnyReply): Extract<AnyReply, { ok: true }> => {
  assert.equal(reply.ok, true, reply.ok ? '' : JSON.stringify(reply));
  return reply as Extract<AnyReply, { ok: true }>;
};

function viewBoxOf(svg: string): string | undefined {
  return svg.match(/viewBox="([^"]*)"/)?.[1];
}

function boxNumsOf(svg: string): number[] {
  return [...svg.matchAll(/\b(?:x|y|width|height)="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
}

for (const path of FIXTURES) {
  const name = path
    .split('/')
    .pop()!
    .replace(/\.mmd$/, '');

  test(`${name}: Node and browser engines agree on viewBox and every box within 2 units`, async () => {
    const source = readFileSync(path, 'utf8');
    const options = { width: 1180 };

    const browserReply = ok(
      await cachedRender('renderAny', source, options, () => renderAny(session.page, source, options)),
    );
    const nodeResult = await cachedRender('renderNode', source, options, () => renderNode(source, options));

    assert.equal(viewBoxOf(nodeResult.svg), viewBoxOf(browserReply.svg), 'viewBox should match exactly');

    const nodeNums = boxNumsOf(nodeResult.svg);
    const browserNums = boxNumsOf(browserReply.svg);
    assert.equal(nodeNums.length, browserNums.length, 'same number of boxes drawn');
    let maxDelta = 0;
    for (let i = 0; i < nodeNums.length; i++) {
      maxDelta = Math.max(maxDelta, Math.abs((nodeNums[i] ?? 0) - (browserNums[i] ?? 0)));
    }
    assert.ok(maxDelta < 2, `expected every box within 2 units, worst was ${maxDelta}`);
  });
}

test('python-or-java at display 620: Node and browser engines agree, DESIGN 1.5', async () => {
  // The leaf-stacking pass (DESIGN 1.5) reruns ELK several times inside
  // `layout()` before settling — worth its own parity case rather than
  // trusting the loop above's `width: 1180` (a different option entirely,
  // the HTML frame, not the canvas cap) to exercise it at all.
  const source = readFileSync(join(fixturesBlog, 'python-or-java.mmd'), 'utf8');
  const options = { display: 620 };

  const browserReply = ok(
    await cachedRender('renderAny', source, options, () => renderAny(session.page, source, options)),
  );
  const nodeResult = await cachedRender('renderNode', source, options, () => renderNode(source, options));

  assert.equal(viewBoxOf(nodeResult.svg), viewBoxOf(browserReply.svg), 'viewBox should match exactly');
  assert.match(nodeResult.svg, /data-display="620"/, 'Node engine should stamp the declared display');
  assert.match(browserReply.svg, /data-display="620"/, 'browser engine should stamp the declared display');

  const nodeNums = boxNumsOf(nodeResult.svg);
  const browserNums = boxNumsOf(browserReply.svg);
  assert.equal(nodeNums.length, browserNums.length, 'same number of boxes drawn');
  let maxDelta = 0;
  for (let i = 0; i < nodeNums.length; i++) {
    maxDelta = Math.max(maxDelta, Math.abs((nodeNums[i] ?? 0) - (browserNums[i] ?? 0)));
  }
  assert.ok(maxDelta < 2, `expected every box within 2 units, worst was ${maxDelta}`);
});
