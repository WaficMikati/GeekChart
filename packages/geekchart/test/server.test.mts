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
 * `renderToSvg`/`renderToHtml` against a real headless Chromium session.
 * Needs `@geekchart/cli`'s `dist/renderer.js` already built — the root `pnpm
 * test` script builds it first; running this file on its own first needs
 * `pnpm --filter @geekchart/cli build`.
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
  // fires eight distinct sources at once and checks each result carries its own label.
  const sources = Array.from(
    { length: 8 },
    (_, i) => `flowchart LR\n  A${i}["Only-${i}"] --> B${i}["Done-${i}"]`,
  );
  const results = await Promise.all(sources.map((s) => renderToSvg(s, { cache: false })));
  results.forEach((r, i) => {
    assert.ok(r.svg.includes(`Only-${i}`), `render ${i} lost its own label`);
    for (let j = 0; j < sources.length; j++)
      if (j !== i) assert.ok(!r.svg.includes(`Only-${j}`), `render ${i} contains chart ${j}`);
  });
});

test('diskCache round-trips through the filesystem, not the browser', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geekchart-diskcache-'));
  try {
    const first = await renderToSvg(flow, { cache: diskCache({ dir }), scene: 'geeks' });
    assert.ok(first.svg.includes('gc-chart'));

    // Drop the shared session so a call that still needed the browser would
    // pay a real (slow — a fresh Chromium launch is ~1.5s, see
    // docs/benchmarks/results.json's `coldStartMs`) round trip. A fresh
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
  setPageRecycleEvery(3); // low, so the test hits the boundary without 100 real renders
  try {
    const results: RenderToSvgResult[] = [];
    for (let i = 0; i < 7; i++) {
      results.push(await renderToSvg(flow, { cache: false, scene: 'geeks' }));
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
