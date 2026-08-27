/**
 * Reproducible performance benchmark: how fast Geekchart draws, how it
 * compares to mermaid's own renderer, what a first-time visitor over a slow
 * network pays before a chart appears, how the exported animation performs,
 * how the server path holds up under concurrency, and what ships on the wire.
 *
 *   pnpm bench            # writes docs/benchmarks/results.json
 *   pnpm bench:page       # (separate script) turns that JSON into a report page
 *
 * Every number is min/median/max over 10 runs after 1 warm-up run, unless a
 * section says otherwise and explains why (a "cold cache" pass, by
 * definition, cannot be repeated and stay cold).
 *
 * This script only reads fixtures/ and packages/{cli,core,geekchart}/dist —
 * it never writes to any of them. Run `pnpm --filter @geekchart/cli build &&
 * pnpm --filter geekchart build` first (the `bench` root script does this).
 */
import { chromium } from 'playwright';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { brotliCompressSync } from 'node:zlib';
import { createServer } from 'node:http';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { openSession, renderAny } from '../src/browser.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const fixturesRoot = join(repo, 'fixtures');
const fixturesBlog = join(fixturesRoot, 'blog');
const geekchartDist = join(repo, 'packages', 'geekchart', 'dist');
const outDir = join(repo, 'docs', 'benchmarks');
mkdirSync(outDir, { recursive: true });

const N = 10;
const WARMUP = 1;
const RENDER_OPTS = { width: 1180 }; // matches gallery.mjs, which gate.mjs measures

const notes = []; // "could not measure X because Y" — surfaced in the report
const note = (s) => {
  notes.push(s);
  process.stderr.write(`note: ${s}\n`);
};
const log = (s) => process.stderr.write(`${s}\n`);

function stats(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return { min: s[0], median, max: s[s.length - 1], n: s.length };
}

async function sampled(warmup, n, fn) {
  for (let i = 0; i < warmup; i++) await fn(-1);
  const out = [];
  for (let i = 0; i < n; i++) out.push(await fn(i));
  return out;
}

function brotliSize(buf) {
  return brotliCompressSync(buf).length;
}

// ---------------------------------------------------------------- fixtures

function listFixtures() {
  const out = [];
  for (const dir of [fixturesRoot, fixturesBlog]) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.mmd'))) {
      const id = dir === fixturesRoot ? f.slice(0, -4) : `blog/${f.slice(0, -4)}`;
      out.push({ id, path: join(dir, f), source: readFileSync(join(dir, f), 'utf8') });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const FAMILY_PATTERNS = [
  [/^flowchart|^graph\s/i, 'flow'],
  [/^sequenceDiagram/i, 'sequence'],
  [/^classDiagram/i, 'class'],
  [/^erDiagram/i, 'er'],
  [/^stateDiagram/i, 'state'],
  [/^gantt/i, 'gantt'],
  [/^journey/i, 'journey'],
  [/^timeline/i, 'timeline'],
  [/^pie/i, 'pie'],
  [/^mindmap/i, 'mindmap'],
  [/^gitGraph/i, 'gitgraph'],
  [/^quadrantChart/i, 'quadrant'],
  [/^xychart/i, 'xy'],
  [/^sankey/i, 'sankey'],
  [/^treemap/i, 'treemap'],
  [/^radar/i, 'radar'],
  [/^kanban/i, 'kanban'],
];
function familyOf(source) {
  const lines = source
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('```'));
  const first = lines[0] ?? '';
  for (const [re, name] of FAMILY_PATTERNS) if (re.test(first)) return name;
  return 'other';
}

// ------------------------------------------------------------- CDP helpers

async function withCpuThrottle(page, rate, fn) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  try {
    return await fn();
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cdp.detach().catch(() => {});
  }
}

// ---------------------------------------------------- 1. render time / gate

async function timedRenderAny(page, source, options) {
  return page.evaluate(
    ([src, opts]) =>
      (async () => {
        const t0 = performance.now();
        const reply = await window.geekchartAny(src, opts);
        const t1 = performance.now();
        return { reply, ms: t1 - t0 };
      })(),
    [source, options],
  );
}

async function benchRenderTime(fixtures) {
  log('1. render time per chart (desktop + 4x CPU)');
  const session = await openSession(1);
  const perChart = [];
  try {
    for (const fx of fixtures) {
      const desktop = await sampled(WARMUP, N, async () => {
        const { reply, ms } = await timedRenderAny(session.page, fx.source, RENDER_OPTS);
        if (!reply.ok) throw new Error(`${fx.id}: ${reply.error.message}`);
        return ms;
      });
      const throttled = await withCpuThrottle(session.page, 4, () =>
        sampled(WARMUP, N, async () => {
          const { reply, ms } = await timedRenderAny(session.page, fx.source, RENDER_OPTS);
          if (!reply.ok) throw new Error(`${fx.id}: ${reply.error.message}`);
          return ms;
        }),
      );
      const family = familyOf(fx.source);
      perChart.push({
        id: fx.id,
        family,
        desktop: stats(desktop),
        cpu4x: stats(throttled),
      });
      log(
        `  ${fx.id.padEnd(28)} ${stats(desktop).median.toFixed(1)}ms  ×4cpu ${stats(throttled).median.toFixed(1)}ms`,
      );
    }
  } finally {
    await session.close();
  }
  const families = {};
  for (const c of perChart) {
    families[c.family] ??= { desktop: [], cpu4x: [] };
    families[c.family].desktop.push(c.desktop.median);
    families[c.family].cpu4x.push(c.cpu4x.median);
  }
  const perFamily = Object.fromEntries(
    Object.entries(families).map(([name, v]) => [
      name,
      {
        desktopMedian: stats(v.desktop).median,
        cpu4xMedian: stats(v.cpu4x).median,
        count: v.desktop.length,
      },
    ]),
  );
  return { perChart, perFamily };
}

// -------------------------------------------------------- 2. mermaid baseline

async function buildMermaidBundle(scratch) {
  const entry = join(scratch, 'mermaid-entry.mjs');
  writeFileSync(
    entry,
    [
      "import mermaid from 'mermaid';",
      "mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' });",
      'window.__mermaid = mermaid;',
    ].join('\n'),
  );
  const outfile = join(scratch, 'mermaid-bundle.js');
  const result = await build({
    entryPoints: [entry],
    outdir: scratch,
    entryNames: 'mermaid-bundle',
    chunkNames: 'mermaid-chunk-[hash]',
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    metafile: true,
    logLevel: 'error',
    write: true,
    // The entry file lives in a scratch dir outside the workspace, so plain
    // node-style upward resolution from it would never find `mermaid` —
    // point esbuild at the package that actually declares the dependency.
    nodePaths: [join(repo, 'packages', 'core', 'node_modules')],
  });
  // Same technique as packages/geekchart/build.mjs: walk only the *static*
  // import graph from the entry — that is everything a browser fetches before
  // mermaid.initialize can even run. mermaid's own per-diagram-type chunks
  // hang off dynamic imports one level in and are excluded on purpose.
  const outputs = result.metafile.outputs;
  const entryKey = Object.keys(outputs).find((k) => k.endsWith('mermaid-bundle.js'));
  const closure = new Set();
  (function walk(key) {
    if (!key || closure.has(key)) return;
    closure.add(key);
    for (const imp of outputs[key].imports) {
      if (imp.external || imp.kind !== 'import-statement') continue;
      walk(imp.path);
    }
  })(entryKey);
  let raw = 0,
    brotli = 0;
  // Metafile output keys are paths relative to process.cwd(), however many
  // `..` segments that takes to reach the scratch dir — `resolve` (not
  // `join(repo, …)`) is the correct inverse of that.
  for (const key of closure) {
    const buf = readFileSync(resolve(key));
    raw += buf.length;
    brotli += brotliSize(buf);
  }
  return {
    outfile,
    bundleRaw: raw,
    bundleBrotli: brotli,
    files: [...closure].map((k) => k.split('/').pop()),
  };
}

async function benchMermaidBaseline(fixtures, scratch) {
  log('2. mermaid baseline render time + bundle size');
  const mermaidDir = join(scratch, 'mermaid');
  mkdirSync(mermaidDir, { recursive: true });
  const { bundleRaw, bundleBrotli, files } = await buildMermaidBundle(mermaidDir);
  // The entry script itself sets `window.__mermaid` (see buildMermaidBundle),
  // so the probe page just needs to load it with a real base URL: splitting
  // produces sibling chunks reached by *relative* import, which only resolve
  // correctly when the module is fetched from a real URL — an inline module
  // on about:blank has no base to resolve "./mermaid-chunk-*.js" against.
  writeFileSync(
    join(mermaidDir, 'index.html'),
    [
      '<!doctype html><meta charset="utf-8">',
      '<script type="module" src="./mermaid-bundle.js"></script>',
    ].join('\n'),
  );
  const { server, port } = await serveDir(mermaidDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => !!window.__mermaid);

  const perChart = [];
  const skipped = [];
  let counter = 0;
  for (const fx of fixtures) {
    try {
      // one dry run outside the timed samples, so a genuine parse error is
      // caught once rather than N+1 times, and doesn't pollute the warm-up.
      const probe = await page.evaluate(
        ([id, src]) =>
          window.__mermaid
            .render(id, src)
            .then(() => true)
            .catch((e) => String(e?.message ?? e)),
        [`m0`, fx.source],
      );
      if (probe !== true) throw new Error(probe);
      const samples = await sampled(WARMUP, N, async () => {
        const id = `m${counter++}`;
        const ms = await page.evaluate(
          ([id, src]) =>
            (async () => {
              const a = performance.now();
              await window.__mermaid.render(id, src);
              return performance.now() - a;
            })(),
          [id, fx.source],
        );
        return ms;
      });
      perChart.push({ id: fx.id, family: familyOf(fx.source), desktop: stats(samples) });
    } catch (err) {
      skipped.push({
        id: fx.id,
        reason: err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160),
      });
    }
  }
  await browser.close();
  server.close();
  if (skipped.length)
    note(
      `mermaid baseline skipped ${skipped.length} fixture(s) it cannot render: ${skipped.map((s) => s.id).join(', ')}`,
    );
  return { perChart, skipped, bundle: { raw: bundleRaw, brotli: bundleBrotli, files } };
}

// ------------------------------------------------- 3. first-chart experience

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html';
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript';
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.woff2')) return 'font/woff2';
  if (file.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

function serveDir(dir) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = join(dir, path === '/' ? 'index.html' : path);
    if (!existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    const buf = readFileSync(file);
    const type = contentType(file);
    const acceptsBr = (req.headers['accept-encoding'] || '').includes('br');
    const headers = {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=31536000, immutable',
    };
    if (acceptsBr && buf.length > 256) {
      const compressed = brotliCompressSync(buf);
      res.writeHead(200, {
        ...headers,
        'Content-Encoding': 'br',
        'Content-Length': compressed.length,
      });
      res.end(compressed);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': buf.length });
      res.end(buf);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function buildDemoPage(scratch, demoSource) {
  const dir = join(scratch, 'demo');
  mkdirSync(dir, { recursive: true });
  const appEntry = join(dir, '_app-entry.jsx');
  writeFileSync(
    appEntry,
    [
      "import React from 'react';",
      "import { createRoot } from 'react-dom/client';",
      `import { Geekchart } from ${JSON.stringify(join(repo, 'packages', 'geekchart', 'src', 'index.ts'))};`,
      `const source = ${JSON.stringify(demoSource)};`,
      "createRoot(document.getElementById('app')).render(",
      '  React.createElement(Geekchart, { source, scene: "manim" }),',
      ');',
    ].join('\n'),
  );
  await build({
    entryPoints: [appEntry],
    outdir: dir,
    entryNames: 'app',
    chunkNames: 'chunk-[hash]',
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    minify: true,
    logLevel: 'error',
    // Same reasoning as buildMermaidBundle: resolve react/react-dom from the
    // package that actually declares them, not from the scratch dir's (empty)
    // node_modules chain.
    nodePaths: [join(repo, 'packages', 'geekchart', 'node_modules')],
  });
  writeFileSync(
    join(dir, 'index.html'),
    [
      '<!doctype html><meta charset="utf-8"><title>bench</title>',
      '<div id="app"></div>',
      '<script>window.__ready = new Promise((resolve) => {',
      '  new MutationObserver(() => {',
      "    const svg = document.querySelector('#app svg.gc-chart');",
      '    if (svg) resolve(performance.now());',
      "  }).observe(document.getElementById('app'), { childList: true, subtree: true });",
      '});</script>',
      '<script type="module" src="./app.js"></script>',
    ].join('\n'),
  );
  return dir;
}

async function measureFirstChart(port) {
  const url = `http://127.0.0.1:${port}/`;
  const cold = [];
  const warm = [];
  for (let i = 0; i < WARMUP + N; i++) {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 150,
        downloadThroughput: (1.6 * 1024 * 1024) / 8,
        uploadThroughput: (750 * 1024) / 8,
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

      await page.goto(url, { waitUntil: 'commit' });
      const coldMs = await page.evaluate(() => window.__ready);
      // second navigation, same context: disk cache is warm, network/CPU
      // throttling stays applied (the point is the *download*, not the CPU).
      await page.goto(url, { waitUntil: 'commit' });
      const warmMs = await page.evaluate(() => window.__ready);

      if (i >= WARMUP) {
        cold.push(coldMs);
        warm.push(warmMs);
      }
    } finally {
      await browser.close();
    }
  }
  return { cold: stats(cold), warm: stats(warm) };
}

async function runLighthouse(port, scratch) {
  let lighthouse;
  try {
    ({ default: lighthouse } = await import('lighthouse'));
  } catch {
    note('lighthouse not installed — skipping the Lighthouse pass on the first-chart page');
    return null;
  }
  let chrome;
  try {
    const { chromium: pwChromium } = await import('playwright');
    const execPath = pwChromium.executablePath();
    const { spawn } = await import('node:child_process');
    const userDataDir = join(scratch, 'lh-profile');
    mkdirSync(userDataDir, { recursive: true });
    const debugPort = 9222 + Math.floor(Math.random() * 1000);
    chrome = spawn(
      execPath,
      [
        `--remote-debugging-port=${debugPort}`,
        '--headless=new',
        '--no-sandbox',
        `--user-data-dir=${userDataDir}`,
        '--disable-gpu',
      ],
      { stdio: 'ignore' },
    );
    await new Promise((r) => setTimeout(r, 1200));
    const runnerResult = await lighthouse(`http://127.0.0.1:${port}/`, {
      port: debugPort,
      output: 'json',
      logLevel: 'silent',
      onlyCategories: ['performance'],
      formFactor: 'mobile',
      screenEmulation: { mobile: true, width: 360, height: 640, deviceScaleFactor: 2 },
    });
    const lhr = runnerResult.lhr;
    return {
      performanceScore: lhr.categories.performance.score,
      lcpMs: lhr.audits['largest-contentful-paint']?.numericValue ?? null,
      tbtMs: lhr.audits['total-blocking-time']?.numericValue ?? null,
      cls: lhr.audits['cumulative-layout-shift']?.numericValue ?? null,
    };
  } catch (err) {
    note(`lighthouse run failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    chrome?.kill();
  }
}

async function benchFirstChart(fixtures, scratch) {
  log('3. first-chart experience over the network (Fast 3G + 4x CPU)');
  const flow = fixtures.find((f) => f.id === 'flow');
  const dir = await buildDemoPage(scratch, flow.source);
  const { server, port } = await serveDir(dir);
  try {
    const timeline = await measureFirstChart(port);
    log(`  cold ${timeline.cold.median.toFixed(0)}ms  warm ${timeline.warm.median.toFixed(0)}ms`);
    const lighthouseResult = await runLighthouse(port, scratch);
    return { timeline, lighthouse: lighthouseResult };
  } finally {
    server.close();
  }
}

// -------------------------------------------------------------- 4. animation

async function measureFps(page, ms) {
  return page
    .evaluate(
      (ms) =>
        new Promise((resolve) => {
          const times = [];
          const start = performance.now();
          function tick(t) {
            times.push(t);
            if (t - start < ms) requestAnimationFrame(tick);
            else resolve(times);
          }
          requestAnimationFrame(tick);
        }),
      ms,
    )
    .then((times) => {
      const deltas = [];
      for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);
      const duration = times[times.length - 1] - times[0];
      return { fps: (times.length - 1) / (duration / 1000), worstFrameMs: Math.max(...deltas) };
    });
}

async function benchAnimation(heaviest) {
  log(`4. animation fps on the ${heaviest.length} heaviest charts (desktop + 4x CPU)`);
  const session = await openSession(1, 'no-preference');
  const perChart = [];
  try {
    for (const fx of heaviest) {
      const reply = await renderAny(session.page, fx.source, { ...RENDER_OPTS, motion: true });
      if (!reply.ok) {
        note(`animation: ${fx.id} failed to render: ${reply.error.message}`);
        continue;
      }
      await session.page.setContent(reply.html, { waitUntil: 'load' });
      await session.page.evaluate(() => document.fonts.ready);

      const desktop = await sampled(WARMUP, N, () => measureFps(session.page, 3000));
      const throttled = await withCpuThrottle(session.page, 4, () =>
        sampled(WARMUP, N, () => measureFps(session.page, 3000)),
      );

      perChart.push({
        id: fx.id,
        desktop: {
          fps: stats(desktop.map((d) => d.fps)),
          worstFrameMs: stats(desktop.map((d) => d.worstFrameMs)),
        },
        cpu4x: {
          fps: stats(throttled.map((d) => d.fps)),
          worstFrameMs: stats(throttled.map((d) => d.worstFrameMs)),
        },
      });
      log(
        `  ${fx.id.padEnd(28)} ${stats(desktop.map((d) => d.fps)).median.toFixed(0)}fps  ×4cpu ${stats(throttled.map((d) => d.fps)).median.toFixed(0)}fps`,
      );
    }
  } finally {
    await session.close();
  }
  return perChart;
}

// ---------------------------------------------------------------- 5. server

class SimpleLru {
  constructor(max) {
    this.max = max;
    this.store = new Map();
  }
  get(k) {
    const v = this.store.get(k);
    if (v !== undefined) {
      this.store.delete(k);
      this.store.set(k, v);
    }
    return v;
  }
  set(k, v) {
    if (this.store.has(k)) this.store.delete(k);
    else if (this.store.size >= this.max) this.store.delete(this.store.keys().next().value);
    this.store.set(k, v);
  }
}

function psSnapshot() {
  const out = execFileSync('ps', ['-eo', 'pid,rss,comm']).toString();
  const map = new Map();
  for (const line of out.split('\n').slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (m) map.set(Number(m[1]), { rss: Number(m[2]), comm: m[3] });
  }
  return map;
}

/**
 * `engine`: `'browser'` (the shared headless Chromium session `geekchart/
 * server` used exclusively before) or `'node'` (fontkit + a lazy linkedom
 * shim, no browser at all — `renderToHtml`'s default since it gained an
 * `engine` option). Same measurements either way, so the two are directly
 * comparable in the report: `coldStartMs` means "the browser's own launch
 * plus the first render" for `'browser'` and "the first render, including
 * whatever module/font loading was still cold" for `'node'` — there is no
 * browser to launch on that path, but the module graph (mermaid, ELK,
 * fontkit) is exactly as cold on the very first call.
 */
async function benchServer(fixtures, engine) {
  log(
    `5. server path (geekchart/server, ${engine} engine): start time, warm miss, cache hit, throughput, RSS`,
  );
  const serverModPath = join(geekchartDist, 'server.js');
  if (!existsSync(serverModPath)) {
    note(
      'packages/geekchart/dist/server.js missing — run `pnpm --filter geekchart build` first; skipping section 5',
    );
    return null;
  }
  const { renderToHtml, closeServer } = await import(serverModPath);
  const flow = fixtures.find((f) => f.id === 'flow');
  const opts = (extra) => ({ engine, ...extra });

  const snap0 = psSnapshot();
  const t0 = performance.now();
  await renderToHtml(flow.source, opts({ cache: false }));
  const coldStartMs = performance.now() - t0;

  const warmMiss = await sampled(WARMUP, N, async () => {
    const a = performance.now();
    await renderToHtml(flow.source, opts({ cache: false }));
    return performance.now() - a;
  });

  await renderToHtml(flow.source, opts({})); // populate the default cache
  const cacheHit = await sampled(WARMUP, N, async () => {
    const a = performance.now();
    await renderToHtml(flow.source, opts({}));
    return performance.now() - a;
  });

  // A cold-cache full pass is, by definition, a one-shot measurement — the
  // second time through, the cache from the first pass makes it warm.
  const coldCache = new SimpleLru(200);
  const coldPassStart = performance.now();
  for (const fx of fixtures) await renderToHtml(fx.source, opts({ cache: coldCache }));
  const coldCachePassMs = performance.now() - coldPassStart;

  const throughput = {};
  for (const concurrency of [1, 4, 8]) {
    const runs = await sampled(WARMUP, N, async () => {
      const start = performance.now();
      for (let i = 0; i < fixtures.length; i += concurrency) {
        const batch = fixtures.slice(i, i + concurrency);
        await Promise.all(batch.map((fx) => renderToHtml(fx.source, opts({ cache: false }))));
      }
      const seconds = (performance.now() - start) / 1000;
      return fixtures.length / seconds;
    });
    throughput[concurrency] = stats(runs);
    log(`  concurrency ${concurrency}: ${stats(runs).median.toFixed(1)} renders/s`);
  }

  const snap1 = psSnapshot();
  let browserRssKb = 0;
  for (const [pid, info] of snap1) if (!snap0.has(pid)) browserRssKb += info.rss;
  const nodeRssKb = Math.round(process.memoryUsage().rss / 1024);

  await closeServer();
  // The Node engine never opens a browser session, so a diff against `ps`
  // finding no new process is the expected, correct result — not a failed
  // measurement the way it would be for the browser engine.
  if (!browserRssKb && engine === 'browser')
    note('could not isolate the server-path browser process by PID diff — browserRssKb is 0');

  return {
    engine,
    coldStartMs,
    warmMiss: stats(warmMiss),
    cacheHit: stats(cacheHit),
    coldCachePassMs,
    fixtureCount: fixtures.length,
    throughput,
    rss: { nodeKb: nodeRssKb, browserKb: browserRssKb },
  };
}

// ---------------------------------------------------------------- 6. bundle

function sizeOf(file) {
  const buf = readFileSync(file);
  return { raw: buf.length, brotli: brotliSize(buf) };
}

function benchBundle() {
  log('6. bundle sizes (packages/geekchart/dist)');
  if (!existsSync(geekchartDist)) {
    note(
      'packages/geekchart/dist missing — run `pnpm --filter geekchart build` first; skipping section 6',
    );
    return null;
  }
  const lazyChunkManifest = join(repo, 'packages', 'geekchart', '.lazy-chunk.json');
  const lazyChunkFiles = existsSync(lazyChunkManifest)
    ? JSON.parse(readFileSync(lazyChunkManifest, 'utf8'))
    : [];
  const entries = ['index.js', 'server.js', 'cli.js'].filter((f) =>
    existsSync(join(geekchartDist, f)),
  );
  const entrySizes = Object.fromEntries(entries.map((f) => [f, sizeOf(join(geekchartDist, f))]));
  const lazyChunkSizes = lazyChunkFiles.map((f) => ({
    file: f,
    ...sizeOf(join(geekchartDist, f)),
  }));
  const lazyChunkTotal = lazyChunkSizes.reduce(
    (acc, f) => ({ raw: acc.raw + f.raw, brotli: acc.brotli + f.brotli }),
    { raw: 0, brotli: 0 },
  );
  const allJs = readdirSync(geekchartDist).filter((f) => f.endsWith('.js'));
  const furtherLazy = allJs.filter((f) => !entries.includes(f) && !lazyChunkFiles.includes(f));
  const furtherLazySizes = furtherLazy
    .map((f) => sizeOf(join(geekchartDist, f)))
    .reduce((acc, s) => ({ raw: acc.raw + s.raw, brotli: acc.brotli + s.brotli }), {
      raw: 0,
      brotli: 0,
    });
  return {
    entries: entrySizes,
    lazyChunk: { files: lazyChunkSizes, total: lazyChunkTotal },
    furtherLazy: { count: furtherLazy.length, total: furtherLazySizes },
  };
}

// -------------------------------------------------------------- machine spec

function machineSpec() {
  const cpuInfo = (() => {
    try {
      return execFileSync('lscpu').toString();
    } catch {
      return '';
    }
  })();
  const model = cpuInfo.match(/Model name:\s*(.+)/)?.[1]?.trim() ?? 'unknown';
  const cores = cpuInfo.match(/^CPU\(s\):\s*(\d+)/m)?.[1] ?? String(os.cpus().length);
  const osRelease = (() => {
    try {
      return readFileSync('/etc/os-release', 'utf8');
    } catch {
      return '';
    }
  })();
  const osName = osRelease.match(/PRETTY_NAME="(.+)"/)?.[1] ?? process.platform;
  let kernel = '';
  try {
    kernel = execFileSync('uname', ['-r']).toString().trim();
  } catch {
    /* ignore */
  }
  let ramGb = null;
  try {
    const mem = execFileSync('free', ['-b']).toString();
    const bytes = Number(mem.split('\n')[1].trim().split(/\s+/)[1]);
    ramGb = +(bytes / 1024 ** 3).toFixed(1);
  } catch {
    /* ignore */
  }
  return {
    cpuModel: model,
    cpuCores: Number(cores) || null,
    ramGb,
    os: `${osName}${kernel ? ` (${kernel})` : ''}`,
  };
}

// --------------------------------------------------------------- README.md

const ms1 = (x) => x.toFixed(1);
const stat3 = (s) => `${ms1(s.min)} / ${ms1(s.median)} / ${ms1(s.max)}`;
const kb = (bytes) => (bytes / 1024).toFixed(1);

function renderReadme(results) {
  const {
    machine,
    config,
    renderTime,
    mermaidBaseline,
    firstChart,
    animation,
    server,
    serverNode,
    bundle,
  } = results;
  const lines = [];
  const p = (s = '') => lines.push(s);

  p('# Geekchart performance benchmarks');
  p();
  p(
    `Generated ${results.generatedAt} · min / median / max over ${config.runs} runs, ${config.warmup} warm-up run discarded (a "cold cache" pass is a single measurement — see §5).`,
  );
  p();
  p('## Machine');
  p();
  p(`- CPU: ${machine.cpuModel} (${machine.cpuCores} logical cores)`);
  p(`- RAM: ${machine.ramGb} GB`);
  p(`- OS: ${machine.os}`);
  p(`- Node: ${machine.nodeVersion} · Chromium: ${machine.chromiumVersion}`);
  p();

  p('## 1. Render time per chart');
  p();
  p(
    'Desktop and 4x CPU throttling, via the built renderer (same bundle `gate.mjs` measures against), in ms.',
  );
  p();
  p('| chart | family | desktop min/median/max | 4x CPU min/median/max |');
  p('|---|---|---|---|');
  for (const c of renderTime.perChart)
    p(`| ${c.id} | ${c.family} | ${stat3(c.desktop)} | ${stat3(c.cpu4x)} |`);
  p();
  p('Per-family median (of per-chart medians), ms:');
  p();
  p('| family | n | desktop | 4x CPU |');
  p('|---|---|---|---|');
  for (const [name, f] of Object.entries(renderTime.perFamily))
    p(`| ${name} | ${f.count} | ${ms1(f.desktopMedian)} | ${ms1(f.cpu4xMedian)} |`);
  p();

  p('## 2. Mermaid baseline');
  p();
  p(
    `mermaid's own \`mermaid.render\`, same fixtures, desktop only. Bundle: what a browser fetches eagerly to call it once (esbuild, code-split, only the static-import closure — the same method \`packages/geekchart/build.mjs\` uses for Geekchart's own lazy chunk): **${kb(mermaidBaseline.bundle.brotli)} kB brotli** (${kb(mermaidBaseline.bundle.raw)} kB raw, ${mermaidBaseline.bundle.files.length} files).`,
  );
  p();
  p('| chart | family | desktop min/median/max |');
  p('|---|---|---|');
  for (const c of mermaidBaseline.perChart) p(`| ${c.id} | ${c.family} | ${stat3(c.desktop)} |`);
  p();
  if (mermaidBaseline.skipped.length) {
    p(
      `Skipped (mermaid could not render the source as-is): ${mermaidBaseline.skipped.map((s) => `\`${s.id}\``).join(', ')}.`,
    );
    p();
  }

  p('## 3. First-chart experience (Fast 3G + 4x CPU)');
  p();
  p(
    "A minimal page mounting `<Geekchart source>` from the built `geekchart` package (React + ReactDOM + the component, esbuild-bundled, served brotli-compressed with far-future cache headers). Time from navigation to the chart's `svg.gc-chart` appearing.",
  );
  p();
  p('| | min | median | max |');
  p('|---|---|---|---|');
  p(
    `| cold (empty cache) | ${ms1(firstChart.timeline.cold.min)}ms | ${ms1(firstChart.timeline.cold.median)}ms | ${ms1(firstChart.timeline.cold.max)}ms |`,
  );
  p(
    `| warm (2nd navigation) | ${ms1(firstChart.timeline.warm.min)}ms | ${ms1(firstChart.timeline.warm.median)}ms | ${ms1(firstChart.timeline.warm.max)}ms |`,
  );
  p();
  if (firstChart.lighthouse) {
    const l = firstChart.lighthouse;
    p(
      `Lighthouse (mobile preset, single run): performance score **${l.performanceScore}**, LCP ${ms1(l.lcpMs)}ms, TBT ${ms1(l.tbtMs)}ms, CLS ${l.cls}.`,
    );
  } else {
    p('Lighthouse: not run (see notes).');
  }
  p();

  p('## 4. Animation');
  p();
  p(
    `fps and worst single-frame time over 3s, on the ${results.heaviestCharts.length} heaviest charts by desktop render time: ${results.heaviestCharts.join(', ')}.`,
  );
  p();
  p(
    '| chart | desktop fps min/median/max | desktop worst frame (ms) | 4x CPU fps min/median/max | 4x CPU worst frame (ms) |',
  );
  p('|---|---|---|---|---|');
  for (const a of animation) {
    p(
      `| ${a.id} | ${stat3(a.desktop.fps)} | ${ms1(a.desktop.worstFrameMs.max)} | ${stat3(a.cpu4x.fps)} | ${ms1(a.cpu4x.worstFrameMs.max)} |`,
    );
  }
  p();

  p('## 5. Server path (`geekchart/server`)');
  p();
  p(
    'Both engines behind the same `renderToHtml`/`renderToSvg` API — `engine: \'node\'` ' +
      "(the default: fontkit measures text, no browser) and `engine: 'browser'` (the shared " +
      'headless Chromium session, kept for parity checks). Same measurements, run back to back ' +
      'in this same process.',
  );
  p();
  if (server || serverNode) {
    p('| | Node engine | Browser engine |');
    p('|---|---|---|');
    const cold = (s) =>
      s
        ? s.engine === 'browser'
          ? `${ms1(s.coldStartMs)}ms (browser launch + first render)`
          : `${ms1(s.coldStartMs)}ms (first render, cold module/font load)`
        : 'not measured';
    p(`| cold start | ${cold(serverNode)} | ${cold(server)} |`);
    const cell = (s, pick) => (s ? `${ms1(pick(s).min)} / ${ms1(pick(s).median)} / ${ms1(pick(s).max)}ms` : 'n/a');
    p(
      `| warm miss (cache disabled) min/median/max | ${cell(serverNode, (s) => s.warmMiss)} | ${cell(server, (s) => s.warmMiss)} |`,
    );
    p(
      `| cache hit min/median/max | ${cell(serverNode, (s) => s.cacheHit)} | ${cell(server, (s) => s.cacheHit)} |`,
    );
    const fc = server?.fixtureCount ?? serverNode?.fixtureCount;
    p(
      `| cold-cache full pass, all ${fc} fixtures, sequential | ${serverNode ? `${ms1(serverNode.coldCachePassMs)}ms` : 'n/a'} | ${server ? `${ms1(server.coldCachePassMs)}ms` : 'n/a'} |`,
    );
    for (const c of [1, 4, 8]) {
      const t = (s) => (s ? `${s.throughput[c].median.toFixed(1)} r/s` : 'n/a');
      p(`| throughput at concurrency ${c} (median) | ${t(serverNode)} | ${t(server)} |`);
    }
    const rss = (s) =>
      s ? `Node ${(s.rss.nodeKb / 1024).toFixed(0)} MB${s.engine === 'browser' ? `, Chromium ${(s.rss.browserKb / 1024).toFixed(0)} MB` : ''}` : 'n/a';
    p(`| RSS after the throughput run | ${rss(serverNode)} | ${rss(server)} |`);
    p();
    p(
      `Fixtures per pass/throughput run: ${fc}. "min/median/max" over ${config.runs} sampled runs after ${config.warmup} warmup run(s), same as every other section.`,
    );
  } else {
    p('Not measured — see notes.');
  }
  p();

  p('## 6. Bundle sizes (`packages/geekchart/dist`)');
  p();
  if (bundle) {
    p('| entry | raw | brotli |');
    p('|---|---|---|');
    for (const [name, s] of Object.entries(bundle.entries))
      p(`| ${name} | ${kb(s.raw)} kB | ${kb(s.brotli)} kB |`);
    p(
      `| **lazy chunk (${bundle.lazyChunk.files.length} files, fetched on first chart mount)** | **${kb(bundle.lazyChunk.total.raw)} kB** | **${kb(bundle.lazyChunk.total.brotli)} kB** |`,
    );
    p(
      `| further lazy (mermaid's own per-diagram-type chunks, ${bundle.furtherLazy.count} files) | ${kb(bundle.furtherLazy.total.raw)} kB | ${kb(bundle.furtherLazy.total.brotli)} kB |`,
    );
  } else {
    p('Not measured — see notes.');
  }
  p();

  if (results.notes.length) {
    p('## Notes');
    p();
    for (const n of results.notes) p(`- ${n}`);
    p();
  }

  p('## Method');
  p();
  p(
    '- Every number is min/median/max over 10 runs after 1 discarded warm-up, except a cold-cache pass, which cannot be repeated and stay cold.',
  );
  p('- "4x CPU" is Chrome DevTools Protocol `Emulation.setCPUThrottlingRate({rate: 4})`.');
  p('- "Fast 3G" is `Network.emulateNetworkConditions` at 1.6 Mbps down, 150ms latency.');
  p(
    '- Render time is measured inside the page (`performance.now()` around the call), not around the Node round trip, so Playwright IPC overhead is excluded.',
  );
  p(
    '- The mermaid baseline and its bundle size use the same "static-import closure from one entry point" method `packages/geekchart/build.mjs` uses for Geekchart\'s own lazy chunk, so the two numbers are comparable.',
  );
  p();
  return lines.join('\n');
}

// ------------------------------------------------------------------- main

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'geekchart-bench-'));
  const fixtures = listFixtures();
  log(`${fixtures.length} fixtures, ${N} runs + ${WARMUP} warm-up each unless noted`);

  const renderTime = await benchRenderTime(fixtures);
  const mermaidBaseline = await benchMermaidBaseline(fixtures, scratch);
  const firstChart = await benchFirstChart(fixtures, scratch);

  const heaviest = [...renderTime.perChart]
    .sort((a, b) => b.desktop.median - a.desktop.median)
    .slice(0, 6)
    .map((c) => fixtures.find((f) => f.id === c.id));
  const animation = await benchAnimation(heaviest);

  // Node first: its RSS reading is the more useful one (what a Node-only
  // deployment actually carries), so it goes before anything in this same
  // process has a reason to load a browser.
  const serverNode = await benchServer(fixtures, 'node');
  const serverBrowser = await benchServer(fixtures, 'browser');
  const bundle = benchBundle();

  rmSync(scratch, { recursive: true, force: true });

  let chromiumVersion = 'unknown';
  try {
    const b = await chromium.launch();
    chromiumVersion = b.version();
    await b.close();
  } catch {
    /* ignore */
  }

  const results = {
    generatedAt: new Date().toISOString(),
    machine: {
      ...machineSpec(),
      nodeVersion: process.version,
      chromiumVersion,
      pnpmWorkspace: true,
    },
    config: { runs: N, warmup: WARMUP, renderOptions: RENDER_OPTS },
    fixtureCount: fixtures.length,
    heaviestCharts: heaviest.map((f) => f.id),
    renderTime,
    mermaidBaseline,
    firstChart,
    animation,
    server: serverBrowser,
    serverNode,
    bundle,
    notes,
  };
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  writeFileSync(join(outDir, 'README.md'), renderReadme(results) + '\n');
  log(`\nwrote ${join(outDir, 'results.json')} and README.md`);
  if (notes.length) log(`notes:\n${notes.map((n) => `  - ${n}`).join('\n')}`);
}

await main();
