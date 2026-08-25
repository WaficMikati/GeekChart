/**
 * Turn docs/benchmarks/results.json into docs/benchmarks/index.html — a
 * report page, not a dashboard: it reads a file written once by `pnpm bench`
 * and never talks to a browser itself except through `renderToHtml`.
 *
 * The four charts on the page are drawn by Geekchart's own server renderer
 * (`geekchart/server`'s `renderToHtml`) from `xychart-beta` sources built
 * from the same numbers as the tables next to them — the benchmark report
 * dogfoods the thing it is benchmarking.
 *
 *   pnpm bench:page
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const outDir = join(repo, 'docs', 'benchmarks');
const resultsPath = join(outDir, 'results.json');
const serverModPath = join(repo, 'packages', 'geekchart', 'dist', 'server.js');

if (!existsSync(resultsPath)) {
  console.error(`no ${resultsPath} — run \`pnpm bench\` first`);
  process.exit(2);
}
if (!existsSync(serverModPath)) {
  console.error('packages/geekchart/dist/server.js missing — run `pnpm --filter geekchart build` first');
  process.exit(2);
}

const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
const { renderToHtml, closeServer } = await import(serverModPath);

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const round1 = (x) => Math.round(x * 10) / 10;
const kb = (bytes) => (bytes / 1024).toFixed(1);

/** A minimal `xychart-beta` source — every chart on this page is one of these,
 * drawn by the renderer under test rather than by a generic charting lib. */
function xy(title, categories, series, yTitle) {
  const cats = categories.map((c) => `"${c.replace(/"/g, "'")}"`).join(', ');
  const bars = series
    .map((s) => `  bar "${s.name.replace(/"/g, "'")}" [${s.values.map(round1).join(', ')}]`)
    .join('\n');
  const allValues = series.flatMap((s) => s.values);
  const yMax = Math.ceil(Math.max(...allValues, 1) * 1.15);
  return [
    'xychart-beta',
    `  title "${title.replace(/"/g, "'")}"`,
    `  x-axis [${cats}]`,
    `  y-axis "${yTitle}" 0 --> ${yMax}`,
    bars,
  ].join('\n');
}

// `renderToHtml` already wraps its output in a scoped `<div id><style>…svg`.
async function chart(source, width = 860) {
  const html = await renderToHtml(source, { width, cache: false });
  return `<div class="chart-embed">${html}</div>`;
}

// ------------------------------------------------------------- data prep

const families = Object.keys(results.renderTime.perFamily).sort(
  (a, b) => results.renderTime.perFamily[b].desktopMedian - results.renderTime.perFamily[a].desktopMedian,
);
const mermaidByFamily = {};
for (const c of results.mermaidBaseline.perChart) {
  (mermaidByFamily[c.family] ??= []).push(c.desktop.median);
}
const mermaidFamilyMedian = (fam) => {
  const vals = mermaidByFamily[fam];
  if (!vals || !vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// All 17 families is too many x-axis labels for a legible chart at
// Geekchart's fixed 1000-unit canvas (a DESIGN.md constant, not something a
// render option can widen) — the chart shows the top ones by Geekchart's own
// median; the table right below it has every family.
const CHART_FAMILY_LIMIT = 10;
const chartFamilies = families.slice(0, CHART_FAMILY_LIMIT);
const renderByFamilySource = xy(
  `Render time by family (desktop, median, top ${CHART_FAMILY_LIMIT})`,
  chartFamilies,
  [
    { name: 'Geekchart', values: chartFamilies.map((f) => results.renderTime.perFamily[f].desktopMedian) },
    { name: 'mermaid', values: chartFamilies.map((f) => mermaidFamilyMedian(f)) },
  ],
  'ms',
);

const downloadSource = xy(
  'What a browser fetches before the first chart can draw',
  ['Geekchart lazy chunk', 'mermaid bundle'],
  [{ name: 'brotli', values: [results.bundle?.lazyChunk?.total.brotli ?? 0, results.mermaidBaseline.bundle.brotli].map((b) => b / 1024) }],
  'kB brotli',
);

const fpsSource = xy(
  'Animation fps, 6 heaviest charts',
  results.animation.map((a) => a.id),
  [
    { name: 'desktop', values: results.animation.map((a) => a.desktop.fps.median) },
    { name: '4x CPU', values: results.animation.map((a) => a.cpu4x.fps.median) },
  ],
  'fps',
);

const timelineSource = xy(
  'First chart over Fast 3G + 4x CPU',
  ['Cold', 'Warm'],
  [{ name: 'ms', values: [results.firstChart.timeline.cold.median, results.firstChart.timeline.warm.median] }],
  'ms',
);

// Rendered one at a time, not via Promise.all: a spot-check while building this
// page (concurrent renderToHtml calls, one of the four sharing an id with
// another) once returned four identical embeds. A dedicated repro against the
// real throughput scenario (37 fixtures, batches of 4/8 — see docs/benchmarks
// section 5) found no corruption, but these four charts have nothing to gain
// from running concurrently, so there's no reason to carry the risk here.
const renderByFamilyChart = await chart(renderByFamilySource, 1500);
const downloadChart = await chart(downloadSource, 640);
const fpsChart = await chart(fpsSource, 1100);
const timelineChart = await chart(timelineSource, 640);

await closeServer();

// ------------------------------------------------------------------ tiles

const overallMedian = (() => {
  const meds = results.renderTime.perChart.map((c) => c.desktop.median).sort((a, b) => a - b);
  return meds[Math.floor(meds.length / 2)];
})();
const overallWorst = Math.max(...results.renderTime.perChart.map((c) => c.desktop.max));

const tiles = [
  { label: 'Render, median', value: `${round1(overallMedian)}ms`, sub: `${results.fixtureCount} charts, desktop` },
  { label: 'Render, worst sample', value: `${round1(overallWorst)}ms`, sub: 'desktop, any chart' },
  { label: 'First chart, cold', value: `${round1(results.firstChart.timeline.cold.median)}ms`, sub: 'Fast 3G + 4x CPU' },
  { label: 'First chart, warm', value: `${round1(results.firstChart.timeline.warm.median)}ms`, sub: '2nd navigation, disk cache' },
  { label: 'Lazy chunk', value: results.bundle ? `${kb(results.bundle.lazyChunk.total.brotli)} kB` : '—', sub: 'brotli, first mount' },
  { label: 'Server throughput', value: results.server ? `${results.server.throughput['8'].median.toFixed(0)}/s` : '—', sub: 'concurrency 8' },
  { label: 'RSS after run', value: results.server ? `${(results.server.rss.browserKb / 1024).toFixed(0)} MB` : '—', sub: 'Chromium, server path' },
  { label: '60fps', value: `${results.animation.filter((a) => a.desktop.fps.median >= 55).length}/${results.animation.length}`, sub: 'heaviest charts, desktop' },
];

// --------------------------------------------------------------- markup

function table(headers, rows) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const renderTable = table(
  ['chart', 'family', 'desktop min/median/max (ms)', '4x CPU min/median/max (ms)'],
  results.renderTime.perChart.map((c) => [
    esc(c.id), esc(c.family),
    `${round1(c.desktop.min)} / ${round1(c.desktop.median)} / ${round1(c.desktop.max)}`,
    `${round1(c.cpu4x.min)} / ${round1(c.cpu4x.median)} / ${round1(c.cpu4x.max)}`,
  ]),
);

const mermaidTable = table(
  ['chart', 'family', 'desktop min/median/max (ms)'],
  results.mermaidBaseline.perChart.map((c) => [
    esc(c.id), esc(c.family),
    `${round1(c.desktop.min)} / ${round1(c.desktop.median)} / ${round1(c.desktop.max)}`,
  ]),
);

const fpsTable = table(
  ['chart', 'desktop fps (min/median/max)', 'desktop worst frame (ms)', '4x CPU fps (min/median/max)', '4x CPU worst frame (ms)'],
  results.animation.map((a) => [
    esc(a.id),
    `${round1(a.desktop.fps.min)} / ${round1(a.desktop.fps.median)} / ${round1(a.desktop.fps.max)}`,
    round1(a.desktop.worstFrameMs.max),
    `${round1(a.cpu4x.fps.min)} / ${round1(a.cpu4x.fps.median)} / ${round1(a.cpu4x.fps.max)}`,
    round1(a.cpu4x.worstFrameMs.max),
  ]),
);

const throughputTable = results.server
  ? table(
      ['concurrency', 'renders/s min', 'median', 'max'],
      [1, 4, 8].map((c) => [c, results.server.throughput[c].min.toFixed(1), results.server.throughput[c].median.toFixed(1), results.server.throughput[c].max.toFixed(1)]),
    )
  : '<p class="dim">Not measured — see notes.</p>';

const bundleTable = results.bundle
  ? table(
      ['file', 'raw', 'brotli'],
      [
        ...Object.entries(results.bundle.entries).map(([name, s]) => [esc(name), `${kb(s.raw)} kB`, `${kb(s.brotli)} kB`]),
        [`<strong>lazy chunk (${results.bundle.lazyChunk.files.length} files)</strong>`, `<strong>${kb(results.bundle.lazyChunk.total.raw)} kB</strong>`, `<strong>${kb(results.bundle.lazyChunk.total.brotli)} kB</strong>`],
        [`further lazy (${results.bundle.furtherLazy.count} files)`, `${kb(results.bundle.furtherLazy.total.raw)} kB`, `${kb(results.bundle.furtherLazy.total.brotli)} kB`],
      ],
    )
  : '<p class="dim">Not measured — see notes.</p>';

const lighthouseBlock = results.firstChart.lighthouse
  ? `<p>Lighthouse (mobile preset, single run): performance score <strong>${results.firstChart.lighthouse.performanceScore}</strong>, ` +
    `LCP ${round1(results.firstChart.lighthouse.lcpMs)}ms, TBT ${round1(results.firstChart.lighthouse.tbtMs)}ms, CLS ${results.firstChart.lighthouse.cls}.</p>`
  : '<p class="dim">Lighthouse was not run — see notes.</p>';

const notesBlock = results.notes.length
  ? `<section class="card"><h2>Notes</h2><ul>${results.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>`
  : '';

const page = `<meta charset="utf-8">
<title>Geekchart benchmarks</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
  :root {
    --page:#0B121A; --card:#131C26; --line:#26313D; --fg:#F2F5F8; --dim:#8794A3;
    --brand:#0084FF; --warn:#FFB718; --good:#3FBF7F; --stage:#17202A;
  }
  /* Dark is the default (no gating selector), matching the gallery. The seven
     --gc-* chart variables are the same ones DESIGN 5.5 defines. */
  .chart-embed { --gc-bg:#17202A; --gc-ink:#FFFFFF; --gc-quiet:#8794A3; --gc-edge:#6B7889;
    --gc-surface:#232F3C; --gc-path:#0084FF; --gc-accent:#00ABE9; }
  :root[data-theme="light"] {
    --page:#EEF2F6; --card:#FFFFFF; --line:#DAE1E8; --fg:#17202A; --dim:#5A6672;
    --brand:#0075E0; --warn:#B4700A; --good:#1F8A5B; --stage:#FFFFFF;
  }
  :root[data-theme="light"] .chart-embed {
    --gc-bg:#FFFFFF; --gc-ink:#17202A; --gc-quiet:#5A6672; --gc-edge:#9AA5B1;
    --gc-surface:#EEF2F6; --gc-path:#0075E0; --gc-accent:#0096D6;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      --page:#EEF2F6; --card:#FFFFFF; --line:#DAE1E8; --fg:#17202A; --dim:#5A6672;
      --brand:#0075E0; --warn:#B4700A; --good:#1F8A5B; --stage:#FFFFFF;
    }
    :root:not([data-theme="dark"]) .chart-embed {
      --gc-bg:#FFFFFF; --gc-ink:#17202A; --gc-quiet:#5A6672; --gc-edge:#9AA5B1;
      --gc-surface:#EEF2F6; --gc-path:#0075E0; --gc-accent:#0096D6;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin:0; background:var(--page); color:var(--fg);
    font-family:Archivo, ui-sans-serif, system-ui, sans-serif; line-height:1.55; }
  body { padding:0 0 5rem; }
  header { max-width:72rem; margin:0 auto; padding:2.4rem clamp(1rem,3vw,2.2rem) 1rem; }
  h1 { margin:0 0 .3rem; font-size:1.9rem; font-weight:700; letter-spacing:-.02em; }
  h1 span { color:var(--brand); }
  .meta { color:var(--dim); font-size:.86rem; font-family:'JetBrains Mono',monospace; }
  main { max-width:72rem; margin:0 auto; padding:0 clamp(1rem,3vw,2.2rem); display:grid; gap:1.2rem; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(11.5rem,1fr)); gap:.8rem; margin-bottom:.4rem; }
  .tile { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:1rem 1.1rem; }
  .tile .label { color:var(--dim); font-size:.72rem; letter-spacing:.08em; text-transform:uppercase; }
  .tile .value { font-size:1.55rem; font-weight:700; margin:.2rem 0; font-family:'JetBrains Mono',monospace; }
  .tile .sub { color:var(--dim); font-size:.78rem; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:1.3rem clamp(1rem,2.5vw,1.8rem); }
  .card h2 { margin:0 0 .3rem; font-size:1.15rem; }
  .card .note { color:var(--dim); font-size:.86rem; margin:0 0 1rem; }
  .chart-embed { background:var(--stage); border:1px solid var(--line); border-radius:10px;
    padding:clamp(.7rem,2vw,1.3rem); overflow:auto; margin-bottom:1rem; }
  .chart-embed svg { display:block; width:100%; height:auto; margin:0 auto; }
  .table-wrap { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:.84rem; }
  th, td { text-align:left; padding:.4rem .7rem; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--dim); font-weight:600; font-size:.72rem; letter-spacing:.06em; text-transform:uppercase; }
  td { font-family:'JetBrains Mono',monospace; }
  .dim { color:var(--dim); }
  ul { padding-left:1.2rem; }
  footer.method { max-width:72rem; margin:2rem auto 0; padding:0 clamp(1rem,3vw,2.2rem); color:var(--dim); font-size:.82rem; }
  footer.method h2 { color:var(--fg); font-size:.95rem; }
  ::-webkit-scrollbar { width:7px; height:7px; }
  ::-webkit-scrollbar-thumb { background:color-mix(in srgb, var(--dim) 38%, transparent); border-radius:99px; }
</style>

<header>
  <h1>Geek<span>chart</span> benchmarks</h1>
  <p class="meta">Generated ${esc(results.generatedAt)} · ${esc(results.machine.cpuModel)} (${results.machine.cpuCores} cores) · ${results.machine.ramGb} GB RAM · ${esc(results.machine.os)} · Node ${results.machine.nodeVersion} · Chromium ${results.machine.chromiumVersion}</p>
</header>
<main>
  <div class="tiles">
    ${tiles.map((t) => `<div class="tile"><div class="label">${esc(t.label)}</div><div class="value">${esc(t.value)}</div><div class="sub">${esc(t.sub)}</div></div>`).join('')}
  </div>

  <section class="card">
    <h2>Render time, Geekchart vs. mermaid</h2>
    <p class="note">Desktop, median ms, grouped by diagram family — top ${CHART_FAMILY_LIMIT} of ${families.length} families by Geekchart's own median (all ${families.length} are in the table). Drawn with <code>geekchart/server</code>'s own renderer, from the same data as the table.</p>
    ${renderByFamilyChart}
    ${renderTable}
  </section>

  <section class="card">
    <h2>mermaid baseline</h2>
    <p class="note">mermaid's own <code>mermaid.render</code>, same fixtures, desktop only.</p>
    ${mermaidTable}
    ${results.mermaidBaseline.skipped.length ? `<p class="note">Skipped: ${results.mermaidBaseline.skipped.map((s) => `<code>${esc(s.id)}</code>`).join(', ')} — mermaid could not render the source as-is.</p>` : ''}
  </section>

  <section class="card">
    <h2>What ships before the first chart draws</h2>
    <p class="note">Brotli-compressed size of the static-import closure from one entry point — the same method for both bundles.</p>
    ${downloadChart}
  </section>

  <section class="card">
    <h2>First-chart experience</h2>
    <p class="note">A minimal page mounting <code>&lt;Geekchart source&gt;</code>, Fast 3G (1.6 Mbps down, 150ms latency) + 4x CPU throttling. Time to the chart's <code>svg.gc-chart</code> appearing.</p>
    ${timelineChart}
    ${lighthouseBlock}
  </section>

  <section class="card">
    <h2>Animation</h2>
    <p class="note">fps and worst single frame over 3s, on the ${results.heaviestCharts.length} heaviest charts by desktop render time.</p>
    ${fpsChart}
    ${fpsTable}
  </section>

  <section class="card">
    <h2>Server throughput (<code>geekchart/server</code>)</h2>
    <p class="note">${results.server ? `${results.server.fixtureCount} fixtures per run, <code>Promise.all</code> batches. Cold start ${round1(results.server.coldStartMs)}ms, warm miss ${round1(results.server.warmMiss.median)}ms, cache hit ${round1(results.server.cacheHit.median)}ms, cold-cache full pass ${round1(results.server.coldCachePassMs)}ms (single measurement).` : 'Not measured — see notes.'}</p>
    ${throughputTable}
  </section>

  <section class="card">
    <h2>Bundle sizes</h2>
    <p class="note"><code>packages/geekchart/dist</code>, raw and brotli.</p>
    ${bundleTable}
  </section>

  ${notesBlock}
</main>
<footer class="method">
  <h2>Method</h2>
  <p>Every number is min/median/max over ${results.config.runs} runs after ${results.config.warmup} discarded warm-up run, except a cold-cache pass, which cannot be repeated and stay cold. "4x CPU" is Chrome DevTools Protocol <code>Emulation.setCPUThrottlingRate({ rate: 4 })</code>. "Fast 3G" is <code>Network.emulateNetworkConditions</code> at 1.6 Mbps down, 150ms latency. Render time is measured inside the page with <code>performance.now()</code>, not around the Node round trip, so Playwright IPC overhead is excluded. Source: <code>packages/cli/scripts/bench.mjs</code>, <code>packages/cli/scripts/bench-page.mjs</code>.</p>
</footer>
`;

writeFileSync(join(outDir, 'index.html'), page);
console.log(`wrote ${join(outDir, 'index.html')}`);
