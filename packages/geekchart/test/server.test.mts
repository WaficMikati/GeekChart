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
    /\[data-gc-play="in-view"\]:not\(\[data-gc-playing\]\) \* \{ animation-play-state: paused !important; \}/,
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


test('display width (DESIGN 1.1): no wider than the declared column, stamped as data-display', async () => {
  {
    const src = readFileSync(join(here, '..', '..', '..', 'fixtures', 'blog', 'python-or-java.mmd'), 'utf8');
    const wide = await renderToSvg(src, { cache: false });
    const narrow = await renderToSvg(src, { cache: false, display: 620 });
    const width = (svg: string) => Number(/viewBox="0 0 (\d+)/.exec(svg)![1]);
    assert.ok(width(wide.svg) > 620, `unconstrained render is ${width(wide.svg)} wide`);
    assert.ok(width(narrow.svg) <= 620, `display 620 render is ${width(narrow.svg)} wide`);
    assert.match(narrow.svg, /data-display="620"/);
  }
});

const pythonOrJava = readFileSync(
  join(here, '..', '..', '..', 'fixtures', 'blog', 'python-or-java.mmd'),
  'utf8',
);

test('display: { desktop, phone } (DESIGN 1.1/1.6) renders both, each stamped and within its own width', async () => {
  const result = await renderToSvg(pythonOrJava, { cache: false, display: { desktop: 612, phone: 358 } });
  const width = (svg: string) => Number(/viewBox="0 0 (\d+)/.exec(svg)![1]);
  assert.ok(result.variants, 'expected a variants field for the object-form display');
  const { desktop, phone } = result.variants!;
  assert.ok(width(desktop.svg) <= 612, `desktop variant is ${width(desktop.svg)} wide`);
  assert.match(desktop.svg, /data-display="612"/);
  assert.ok(width(phone.svg) <= 358, `phone variant is ${width(phone.svg)} wide`);
  assert.match(phone.svg, /data-display="358"/);
  // DESIGN 1.6: the phone column is narrow enough that python-or-java's
  // fan-branch row wraps into two, which the plain 612 desktop column never
  // needs to — the two variants are not just scaled copies of each other.
  assert.notEqual(width(desktop.svg), width(phone.svg));
  // `svg`/`css` at the top level stay the desktop variant, for a caller that
  // never asked for two widths and still reads `result.svg` directly.
  assert.equal(result.svg, desktop.svg);
  assert.equal(result.css, desktop.css);
});

test('display: { desktop, phone } is one cache entry, not two', async () => {
  const store = new Map<string, RenderToSvgResult>();
  const cache = {
    get: (key: string) => store.get(key),
    set: (key: string, value: RenderToSvgResult) => void store.set(key, value),
  };
  await renderToSvg(pythonOrJava, { cache, display: { desktop: 612, phone: 358 } });
  assert.equal(store.size, 1, 'both variants belong to one request and one cache entry');
  const hit = await renderToSvg(pythonOrJava, { cache, display: { desktop: 612, phone: 358 } });
  assert.ok(hit.variants, 'a cache hit should still carry both variants');
});

test('renderToHtml, given { desktop, phone }, emits both svgs and a 640px media query', async () => {
  const html = await renderToHtml(pythonOrJava, {
    cache: false,
    display: { desktop: 612, phone: 358 },
  });
  const idMatch = /^<div id="(gc-[0-9a-f]{12})"/.exec(html);
  assert.ok(idMatch, 'expected the usual scoped wrapper id');
  const id = idMatch![1];
  // The marker sits on a wrapper above the svg, so the variant-scoped pause
  // rule (a descendant selector) can reach the svg it targets.
  assert.match(html, /<div data-gc-variant="desktop"><svg /);
  assert.match(html, /<div data-gc-variant="phone"><svg /);
  assert.match(html, /@media \(max-width:640px\)/);
  // The rule that shows the phone svg and hides the desktop one lives inside
  // that media query, scoped under this render's own wrapper id.
  const mqStart = html.indexOf('@media (max-width:640px)');
  const mq = html.slice(mqStart, mqStart + 200);
  assert.ok(mq.includes(`#${id} [data-gc-variant="desktop"]{display:none}`));
  assert.ok(mq.includes(`#${id} [data-gc-variant="phone"]{display:block}`));
  // And outside it, the resting (desktop-first) state is the reverse.
  const outsideMq = html.slice(0, html.indexOf('@media'));
  assert.ok(outsideMq.includes(`#${id} [data-gc-variant="desktop"]{display:block}`));
  assert.ok(outsideMq.includes(`#${id} [data-gc-variant="phone"]{display:none}`));
});

// DESIGN 8.6: one multiplier stretches or hurries the whole build.
test('speed defaults to 1, with no data-gc-speed attribute', async () => {
  const result = await renderToSvg(flow, { cache: false, scene: 'geeks' });
  assert.doesNotMatch(result.svg, /data-gc-speed/);
});

test('speed 0.5 and 1 are different cache entries', async () => {
  const store = new Map<string, RenderToSvgResult>();
  const cache = {
    get: (key: string) => store.get(key),
    set: (key: string, value: RenderToSvgResult) => void store.set(key, value),
  };
  await renderToSvg(flow, { cache, scene: 'geeks' });
  await renderToSvg(flow, { cache, scene: 'geeks', speed: 0.5 });
  assert.equal(store.size, 2);
});

test('an explicit speed: 1 hits the same cache entry as leaving it unset', async () => {
  const store = new Map<string, RenderToSvgResult>();
  const cache = {
    get: (key: string) => store.get(key),
    set: (key: string, value: RenderToSvgResult) => void store.set(key, value),
  };
  const implicit = await renderToSvg(flow, { cache, scene: 'geeks' });
  const explicit = await renderToSvg(flow, { cache, scene: 'geeks', speed: 1 });
  assert.equal(store.size, 1, 'the default and its explicit spelling share one cache key');
  assert.equal(explicit, implicit);
});

test('an out-of-range speed clamps, and clamped requests share a cache entry', async () => {
  const store = new Map<string, RenderToSvgResult>();
  const cache = {
    get: (key: string) => store.get(key),
    set: (key: string, value: RenderToSvgResult) => void store.set(key, value),
  };
  const tooFast = await renderToSvg(flow, { cache, scene: 'geeks', speed: 100 });
  const atCeiling = await renderToSvg(flow, { cache, scene: 'geeks', speed: 4 });
  assert.equal(store.size, 1, 'both requests clamp to the same effective speed');
  assert.equal(tooFast, atCeiling);
  assert.match(tooFast.svg, /data-gc-speed="4"/);

  const tooSlow = await renderToSvg(flow, { cache: false, scene: 'geeks', speed: 0 });
  assert.match(tooSlow.svg, /data-gc-speed="0\.25"/);
});

test('DESIGN 1.7: a phone layout taller than two screens carries a warning', async () => {
  const src = readFileSync(join(here, '..', '..', '..', 'fixtures', 'blog', 'python-or-java.mmd'), 'utf8');
  const tall = await renderToSvg(src, { cache: false, display: 358 });
  assert.ok(tall.warnings.some((w) => w.startsWith('1.7')), `expected a 1.7 warning, got ${JSON.stringify(tall.warnings)}`);
  const short = readFileSync(join(here, '..', '..', '..', 'fixtures', 'blog', 'python-or-java-short.mmd'), 'utf8');
  const fine = await renderToSvg(short, { cache: false, display: 358 });
  assert.ok(!fine.warnings.some((w) => w.startsWith('1.7')), 'a one-screen chart has no 1.7 warning');
  const desktop = await renderToSvg(src, { cache: false, display: 612 });
  assert.ok(!desktop.warnings.some((w) => w.startsWith('1.7')), 'only phone widths warn');
});
