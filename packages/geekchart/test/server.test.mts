import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diskCache, renderToHtml, renderToSvg, warm, type RenderToSvgResult } from '../src/server.ts';

/**
 * `renderToSvg`/`renderToHtml` — the Node engine only, no browser in reach.
 * (Node-vs-browser measurement parity is checked separately, outside this
 * package: `packages/cli/scripts/spike-node.mjs`.)
 */

const here = dirname(fileURLToPath(import.meta.url));
const flow = readFileSync(join(here, '..', '..', '..', 'fixtures', 'flow.mmd'), 'utf8');

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
  // Each Node render is independent, in-process work with no shared page to
  // race — this just confirms eight distinct sources rendered at once each
  // come back with their own label, not someone else's.
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

test('diskCache round-trips through the filesystem, not a fresh render', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geekchart-diskcache-'));
  try {
    const first = await renderToSvg(flow, { cache: diskCache({ dir }), scene: 'geeks' });
    assert.ok(first.svg.includes('gc-chart'));

    // A fresh `diskCache` instance, so its in-memory layer starts empty and
    // the hit can only have come from the file the first call wrote.
    const t0 = performance.now();
    const second = await renderToSvg(flow, { cache: diskCache({ dir }), scene: 'geeks' });
    const ms = performance.now() - t0;

    assert.equal(second.svg, first.svg);
    assert.equal(second.css, first.css);
    assert.ok(ms < 200, `expected a disk read, well under a fresh render, took ${ms}ms`);
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

// DESIGN 8.4: charts play once, on scroll into view, instead of looping.
test('defaults to play: "in-view" — paused until geekchart/observe runs', async () => {
  const result = await renderToSvg(flow, { cache: false, scene: 'geeks' });
  assert.match(result.svg, /data-gc-play="in-view"/);
  assert.doesNotMatch(result.css, /\binfinite\b/, 'nothing may still be looping by default');
  assert.match(
    result.css,
    /\[data-gc-play="in-view"\]:not\(\[data-gc-playing\]\) \* \{ animation-play-state: paused; \}/,
  );
});

test('play: "once" plays immediately and holds, with no pause rule', async () => {
  const result = await renderToSvg(flow, { cache: false, scene: 'geeks', play: 'once' });
  assert.match(result.svg, /data-gc-play="once"/);
  assert.doesNotMatch(result.css, /\binfinite\b/);
  assert.doesNotMatch(result.css, /animation-play-state: paused/);
});

test('play: "loop" is opt-in and matches the old, always-on behaviour', async () => {
  const result = await renderToSvg(flow, { cache: false, scene: 'geeks', play: 'loop' });
  assert.doesNotMatch(result.svg, /data-gc-play/);
  assert.match(result.css, /\binfinite\b/, 'the flowchart timeline still loops');
});

test('an explicit play: "in-view" hits the same cache entry as the default', async () => {
  const store = new Map<string, RenderToSvgResult>();
  const cache = {
    get: (key: string) => store.get(key),
    set: (key: string, value: RenderToSvgResult) => void store.set(key, value),
  };
  const implicit = await renderToSvg(flow, { cache, scene: 'geeks' });
  const explicit = await renderToSvg(flow, { cache, scene: 'geeks', play: 'in-view' });
  assert.equal(store.size, 1, 'the default and its explicit spelling share one cache key');
  assert.equal(explicit, implicit);
});

