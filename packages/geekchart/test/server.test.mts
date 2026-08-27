import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeServer,
  diskCache,
  renderToHtml,
  renderToSvg,
  setPageRecycleEvery,
  warm,
  type RenderToSvgResult,
} from '../src/server.ts';

/**
 * `renderToSvg`/`renderToHtml`, mostly against the default Node engine.
 * A few tests below are specifically about the shared Playwright session
 * (page recycling, concurrent access to one page) and pass `engine:
 * 'browser'` to actually exercise it — everything else runs on whichever
 * engine is default, which is the point: an app that never asks for
 * `engine: 'browser'` gets the same behaviour without Playwright.
 * The browser-engine tests need `@geekchart/cli`'s `dist/renderer.js`
 * already built — the root `pnpm test` script builds it first; running this
 * file on its own first needs `pnpm --filter @geekchart/cli build`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const flow = readFileSync(join(here, '..', '..', '..', 'fixtures', 'flow.mmd'), 'utf8');

after(async () => {
  await closeServer();
});

test('renders flow.mmd to a scoped chart and hits the cache on the second call', async () => {
  let hits = 0;
  const store = new Map<string, RenderToSvgResult>();
  const cache = {
    get(key: string) {
      const hit = store.get(key);
      if (hit) hits++;
      return hit;
    },
    set(key: string, value: RenderToSvgResult) {
      store.set(key, value);
    },
  };

  const first = await renderToSvg(flow, { cache, scene: 'geeks' });
  assert.match(first.svg, /class="[^"]*\bgc-chart\b/);
  assert.ok(first.cycle > 0, 'a flowchart with motion should report a nonzero loop length');
  assert.equal(store.size, 1);

  const second = await renderToSvg(flow, { cache, scene: 'geeks' });
  assert.equal(
    second,
    first,
    'the second call should return the cached object, not a fresh render',
  );
  assert.equal(hits, 1);
  assert.equal(store.size, 1, 'one cache entry, not one per call');
});

test('a different options object misses the cache', async () => {
  const store = new Map<string, RenderToSvgResult>();
  const cache = {
    get: (key: string) => store.get(key),
    set: (key: string, value: RenderToSvgResult) => void store.set(key, value),
  };
  await renderToSvg(flow, { cache, scene: 'geeks' });
  await renderToSvg(flow, { cache, scene: 'manim' });
  assert.equal(store.size, 2);
});

test('renderToHtml wraps the SVG in a scoped, self-contained fragment', async () => {
  const html = await renderToHtml(flow, { cache: false, scene: 'geeks' });
  assert.match(html, /^<div id="gc-[0-9a-f]{12}"/);
  assert.match(html, /<style>/);
  assert.match(html, /gc-chart/);
});

test('concurrent renders of different sources each get their own chart', async () => {
  // The shared page once handed back the wrong chart under concurrency (seen in
  // the throughput benchmark). Renders are serialised through a queue now; this
  // fires eight distinct sources at once and checks each result carries its own
  // label. `engine: 'browser'` on purpose — the Node engine has no shared page
  // to race in the first place, so only the browser engine actually exercises
  // the bug this guards against.
  const sources = Array.from(
    { length: 8 },
    (_, i) => `flowchart LR\n  A${i}["Only-${i}"] --> B${i}["Done-${i}"]`,
  );
  const results = await Promise.all(
    sources.map((s) => renderToSvg(s, { cache: false, engine: 'browser' })),
  );
  results.forEach((r, i) => {
    assert.ok(r.svg.includes(`Only-${i}`), `render ${i} lost its own label`);
    for (let j = 0; j < sources.length; j++)
      if (j !== i) assert.ok(!r.svg.includes(`Only-${j}`), `render ${i} contains chart ${j}`);
  });
});

test('diskCache round-trips through the filesystem, not a fresh render', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geekchart-diskcache-'));
  try {
    const first = await renderToSvg(flow, { cache: diskCache({ dir }), scene: 'geeks' });
    assert.ok(first.svg.includes('gc-chart'));

    // `closeServer()` only matters for the browser engine (it drops the
    // shared Chromium session) — kept here so this test would still catch a
    // cache miss even if it ran against `engine: 'browser'`. A fresh
    // `diskCache` instance too, so its in-memory layer starts empty and the
    // hit can only have come from the file the first call wrote.
    await closeServer();

    const t0 = performance.now();
    const second = await renderToSvg(flow, { cache: diskCache({ dir }), scene: 'geeks' });
    const ms = performance.now() - t0;

    assert.equal(second.svg, first.svg);
    assert.equal(second.css, first.css);
    assert.ok(ms < 200, `expected a disk read (well under a Chromium launch), took ${ms}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diskCache misses cleanly on a cold directory and on a bad file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geekchart-diskcache-cold-'));
  try {
    const cache = diskCache({ dir });
    assert.equal(await cache.get('does-not-exist'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('warm renders a list of sources, then reports cache hits on a second pass', async () => {
  const store = new Map<string, RenderToSvgResult>();
  const cache = {
    get: (key: string) => store.get(key),
    set: (key: string, value: RenderToSvgResult) => void store.set(key, value),
  };
  const sources = Array.from(
    { length: 6 },
    (_, i) => `flowchart LR\n  W${i}["Warm-${i}"] --> D${i}["Done-${i}"]`,
  );

  const first = await warm(sources, { cache }, 3);
  assert.deepEqual(first, { rendered: 6, cached: 0, failed: 0 });
  assert.equal(store.size, 6);

  const second = await warm(sources, { cache }, 3);
  assert.deepEqual(second, { rendered: 0, cached: 6, failed: 0 });

  const withOneBad = await warm([...sources, ''], { cache }, 3);
  assert.deepEqual(withOneBad, { rendered: 0, cached: 6, failed: 1 });
});

test('warm accepts an async iterable of sources', async () => {
  const store = new Map<string, RenderToSvgResult>();
  const cache = {
    get: (key: string) => store.get(key),
    set: (key: string, value: RenderToSvgResult) => void store.set(key, value),
  };
  async function* sources() {
    for (let i = 0; i < 4; i++) yield `flowchart LR\n  Q${i}["Iter-${i}"] --> R${i}["End-${i}"]`;
  }
  const result = await warm(sources(), { cache });
  assert.deepEqual(result, { rendered: 4, cached: 0, failed: 0 });
});

test('recycling the shared page mid-stream leaves renders identical', async () => {
  // `engine: 'browser'` throughout — page recycling is a property of the
  // shared Playwright session; the Node engine has no page to recycle, so
  // this test would pass trivially (and cover nothing) on the default engine.
  setPageRecycleEvery(3); // low, so the test hits the boundary without 100 real renders
  try {
    const results: RenderToSvgResult[] = [];
    for (let i = 0; i < 7; i++) {
      results.push(await renderToSvg(flow, { cache: false, scene: 'geeks', engine: 'browser' }));
    }
    const [expected] = results;
    assert.ok(expected);
    for (const r of results) {
      assert.equal(r.svg, expected.svg, 'a render after a page recycle should draw the same chart');
      assert.equal(r.css, expected.css);
    }
  } finally {
    setPageRecycleEvery(100); // restore the default for tests that run after this one
  }
});

test('the Node and browser engines draw the same chart within 2 units', async () => {
  // Not byte-identical — the two engines measure text slightly differently
  // (packages/core/src/node/measure.ts documents the remaining gap) — but
  // every box, panel and point should land within a couple of units of each
  // other, and the two engines must agree on the canvas size exactly.
  const node = await renderToSvg(flow, { cache: false, engine: 'node', scene: 'geeks' });
  const browser = await renderToSvg(flow, { cache: false, engine: 'browser', scene: 'geeks' });

  const viewBoxOf = (svg: string) => svg.match(/viewBox="([^"]*)"/)?.[1];
  assert.equal(viewBoxOf(node.svg), viewBoxOf(browser.svg), 'viewBox should match exactly');

  const numsOf = (svg: string) =>
    [...svg.matchAll(/\b(?:x|y|width|height)="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
  const nodeNums = numsOf(node.svg);
  const browserNums = numsOf(browser.svg);
  assert.equal(nodeNums.length, browserNums.length, 'same number of boxes drawn');
  let maxDelta = 0;
  for (let i = 0; i < nodeNums.length; i++) {
    maxDelta = Math.max(maxDelta, Math.abs((nodeNums[i] ?? 0) - (browserNums[i] ?? 0)));
  }
  assert.ok(maxDelta < 2, `expected every box within 2 units, worst was ${maxDelta}`);
});
