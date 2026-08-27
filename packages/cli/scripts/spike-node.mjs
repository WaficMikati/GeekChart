#!/usr/bin/env node
/**
 * Spike: can Geekchart render without a browser?
 *
 * The renderer has two browser-dependent seams:
 *   - `makeMeasurer` (packages/core/src/layout/measure.ts) — a hidden SVG
 *     `<text>` + `getBBox().width`, used by every family to size labels.
 *   - mermaid's own parser, which needs a `document` for DOMPurify even
 *     though nothing downstream uses mermaid's own rendering.
 * (The third seam this was framed around — `flow.ts`'s `getBBox()` on the
 * finished root, for canvas framing — is gone: `draw()` now returns
 * `drawing.extent`, computed from the boxes and points it already placed, and
 * `flow.ts` frames to that instead. See `packages/core/src/draw.ts`'s
 * `Drawing.extent` doc comment and `flow.ts`'s `fitToCanvas`.)
 *
 * `packages/core/src/node/measure.ts` answers the first with fontkit reading
 * the embedded font files directly. This script answers the second with a
 * `linkedom` global shim, then renders the same six fixtures both ways —
 * the existing renderer in a real headless Chromium, and the Node path — and
 * compares: every text-measurement call, every drawn box/point, the final
 * viewBox, the gate, a pixel diff, and wall-clock time.
 *
 * Usage: node packages/cli/scripts/spike-node.mjs
 */
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseHTML } from 'linkedom';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const coreIndex = join(repo, 'packages', 'core', 'src', 'index.ts');
const nodeMeasurePath = join(repo, 'packages', 'core', 'src', 'node', 'measure.ts');
const measureJs = join(repo, 'packages', 'cli', 'dist', 'measure.js');

const FIXTURES = [
  'fixtures/control-plane.mmd',
  'fixtures/flow.mmd',
  'fixtures/sequence.mmd',
  'fixtures/gantt.mmd',
  'fixtures/blog/regex-engine.mmd',
  'fixtures/blog/pyenv-resolution.mmd',
].map((rel) => ({
  name: rel
    .split('/')
    .pop()
    .replace(/\.mmd$/, ''),
  path: join(repo, rel),
}));

// `motion: false` draws the finished, still frame directly — the pixel diff
// and gate check both want the settled chart, not the reveal animation's
// hidden starting keyframe (see AGENTS.md: "the gate renders the still frame").
const RENDER_OPTIONS = { width: 1000, motion: false };
const SHOT_VIEWPORT = { width: 1100, height: 900 };

const workDir = mkdtempSync(join(tmpdir(), 'geekchart-spike-'));

/** Every `x`/`y`/`width`/`height` attribute value in an SVG string, in the
 *  order they appear — a browser-independent proxy for "every drawn box",
 *  since it also catches label plates, panel rects and the outer viewport's
 *  own width/height, not just node boxes. */
function extractBoxNums(svg) {
  const nums = [];
  const re = /\b(?:x|y|width|height)="(-?[\d.]+)"/g;
  let m;
  while ((m = re.exec(svg))) nums.push(Number(m[1]));
  return nums;
}

function maxMeanAbsDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let max = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    max = Math.max(max, d);
    sum += d;
  }
  return { max, mean: n ? sum / n : 0, countMismatch: a.length !== b.length, lenA: a.length, lenB: b.length };
}

function viewBoxOf(svg) {
  return svg.match(/viewBox="([^"]*)"/)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// 1. A debug bundle exposing `render` on `window`, for the browser side.
//    Same source, same function `render()` from `@geekchart/core` that every
//    real caller uses — just not wrapped in the CLI's own browser-entry.ts,
//    which does not hand back the raw SVG/warnings this needs.
// ---------------------------------------------------------------------------
const entryFile = join(workDir, 'entry.ts');
writeFileSync(
  entryFile,
  `import { render } from ${JSON.stringify(coreIndex)};\nwindow.__spikeRender = render;\n`,
);
const bundleFile = join(workDir, 'bundle.js');
await build({
  entryPoints: [entryFile],
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  platform: 'browser',
  outfile: bundleFile,
  logLevel: 'error',
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: SHOT_VIEWPORT });
await page.goto('about:blank');
await page.addScriptTag({ path: bundleFile });
const hasMeasure = existsSync(measureJs);
if (hasMeasure) await page.addScriptTag({ path: measureJs });
else console.error(`warning: ${measureJs} missing — run "pnpm --filter @geekchart/cli build" first; gate column will be skipped`);

async function renderInBrowser(source, options) {
  return page.evaluate(
    async ([src, opts]) => {
      const log = [];
      // `getBBox` is a `SVGGraphicsElement` method, one step closer in the
      // prototype chain than `SVGElement` — patching `SVGElement.prototype`
      // instead leaves the real implementation reached first and never calls
      // this at all.
      const orig = SVGGraphicsElement.prototype.getBBox;
      SVGGraphicsElement.prototype.getBBox = function (...args) {
        const r = orig.apply(this, args);
        if (this.tagName === 'text') {
          log.push({
            text: this.textContent,
            font: this.style.fontFamily,
            size: this.style.fontSize,
            tracking: this.style.letterSpacing,
            width: r.width,
          });
        }
        return r;
      };
      const t0 = performance.now();
      let result;
      let error = null;
      try {
        result = await window.__spikeRender(src, opts);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const ms = performance.now() - t0;
      SVGGraphicsElement.prototype.getBBox = orig;
      if (error) return { error };
      return { svg: result.svg, css: result.css, html: result.html, ms, log, warnings: result.warnings };
    },
    [source, options],
  );
}

async function gateCheck(svg, css, chartId) {
  if (!hasMeasure) return { skipped: true };
  return page.evaluate(
    ({ svg, css, chartId }) => {
      const host = document.createElement('div');
      host.innerHTML = `<style>${css}</style>${svg}`;
      document.body.appendChild(host);
      const svgEl = host.querySelector('svg');
      let result;
      try {
        result = window.geekchartMeasure.measureChart(svgEl, { stagePx: 760, chartId });
      } finally {
        host.remove();
      }
      return result;
    },
    { svg, css, chartId },
  );
}

async function screenshotHtml(html, outPath) {
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: outPath });
}

// ---------------------------------------------------------------------------
// 2. The Node side: a `linkedom` global shim (mermaid's parser needs a
//    `document` for DOMPurify — nothing else in the drawn pipeline touches
//    one any more, now that `flow.ts` no longer calls `getBBox()`), the same
//    `render()`, and `makeNodeMeasurer` in place of the browser measurer.
// ---------------------------------------------------------------------------
const { window: linkedomWindow, document: linkedomDocument } = parseHTML(
  '<!doctype html><html><body></body></html>',
);
for (const key of ['window', 'Node', 'NodeFilter', 'Element', 'HTMLElement', 'SVGElement', 'Text', 'Comment']) {
  if (linkedomWindow[key] !== undefined) globalThis[key] = linkedomWindow[key];
}
globalThis.document = linkedomDocument;

const { render } = await import(coreIndex);
const { makeNodeMeasurer } = await import(nodeMeasurePath);

async function renderInNode(source, options) {
  const log = [];
  const base = makeNodeMeasurer();
  const measurer = {
    measure(text, font, size, tracking) {
      const w = base.measure(text, font, size, tracking);
      log.push({ text: text || ' ', font, size: `${size}px`, tracking: tracking ?? 'normal', width: w });
      return w;
    },
    done: () => base.done(),
  };
  const t0 = performance.now();
  let result;
  let error = null;
  try {
    result = await render(source, { ...options, measurer });
  } catch (e) {
    error = e instanceof Error ? e.stack : String(e);
  }
  const ms = performance.now() - t0;
  if (error) return { error };
  return {
    svg: result.svg,
    css: result.css,
    html: result.html,
    ms,
    log,
    warnings: result.warnings,
    fontWarnings: base.warnings,
  };
}

// ---------------------------------------------------------------------------
// 3. Render each fixture both ways and compare.
// ---------------------------------------------------------------------------
const rows = [];
for (const fixture of FIXTURES) {
  const source = readFileSync(fixture.path, 'utf8');

  const b = await renderInBrowser(source, RENDER_OPTIONS);
  const n = await renderInNode(source, RENDER_OPTIONS);

  if (b.error || n.error) {
    rows.push({ name: fixture.name, error: b.error ?? n.error, side: b.error ? 'browser' : 'node' });
    continue;
  }

  const textWidths = maxMeanAbsDiff(
    b.log.map((c) => c.width),
    n.log.map((c) => c.width),
  );
  let worstCall = null;
  const pairCount = Math.min(b.log.length, n.log.length);
  for (let i = 0; i < pairCount; i++) {
    const bc = b.log[i];
    const nc = n.log[i];
    const d = Math.abs(bc.width - nc.width);
    if (!worstCall || d > worstCall.d) {
      worstCall = { text: bc.text, font: bc.font, size: bc.size, bw: bc.width, nw: nc.width, d };
    }
  }
  if (process.env.SPIKE_DUMP) {
    const d = process.env.SPIKE_DUMP;
    writeFileSync(join(d, `${fixture.name}-browser.svg`), b.svg); writeFileSync(join(d, `${fixture.name}-browser.css`), b.css);
    writeFileSync(join(d, `${fixture.name}-node.svg`), n.svg); writeFileSync(join(d, `${fixture.name}-node.css`), n.css);
  }
  const boxes = maxMeanAbsDiff(extractBoxNums(b.svg), extractBoxNums(n.svg));
  const vbBrowser = viewBoxOf(b.svg);
  const vbNode = viewBoxOf(n.svg);

  const gate = await gateCheck(n.svg, n.css, fixture.name);
  const gateStatus = gate.skipped
    ? 'skipped'
    : gate.fails?.length
      ? `FAIL (${gate.fails.join('; ')})`
      : gate.warns?.length
        ? `WARN (${gate.warns.join('; ')})`
        : 'ok';

  const browserPng = join(workDir, `${fixture.name}-browser.png`);
  const nodePng = join(workDir, `${fixture.name}-node.png`);
  const diffPng = join(workDir, `${fixture.name}-diff.png`);
  await screenshotHtml(b.html, browserPng);
  await screenshotHtml(n.html, nodePng);
  let pixelDiff = 'n/a';
  try {
    execFileSync('compare', ['-metric', 'AE', browserPng, nodePng, diffPng], { stdio: ['ignore', 'pipe', 'pipe'] });
    pixelDiff = '0'; // compare exits 0 only when images are identical
  } catch (e) {
    const stderr = (e.stderr ?? '').toString().trim();
    pixelDiff = stderr || `error (${e.status})`;
  }

  rows.push({
    name: fixture.name,
    textWidths,
    boxes,
    vbBrowser,
    vbNode,
    vbEqual: vbBrowser === vbNode,
    gateStatus,
    pixelDiff,
    nodeMs: n.ms.toFixed(1),
    browserMs: b.ms.toFixed(1),
    fontWarnings: n.fontWarnings,
    callCountMismatch: textWidths.countMismatch ? `${textWidths.lenA} vs ${textWidths.lenB}` : null,
    worstCall,
  });
}

await browser.close();

// ---------------------------------------------------------------------------
// 4. Report.
// ---------------------------------------------------------------------------
console.log('\nfixture            max Δtext  mean Δtext  max Δbox  viewBox=  gate      pixel AE   node ms   browser ms');
for (const r of rows) {
  if (r.error) {
    console.log(`${r.name.padEnd(18)} ERROR (${r.side}): ${r.error.split('\n')[0]}`);
    continue;
  }
  const twMax = r.callCountMismatch ? 'n/a' : r.textWidths.max.toFixed(2);
  const twMean = r.callCountMismatch ? 'n/a' : r.textWidths.mean.toFixed(2);
  console.log(
    `${r.name.padEnd(18)} ${twMax.padStart(9)}  ${twMean.padStart(10)}  ` +
      `${r.boxes.max.toFixed(2).padStart(8)}  ${String(r.vbEqual).padEnd(8)}  ${r.gateStatus.padEnd(8)}  ` +
      `${String(r.pixelDiff).padEnd(9)}  ${r.nodeMs.padStart(8)}  ${r.browserMs.padStart(10)}`,
  );
  if (r.callCountMismatch) console.log(`  ! measure call count differs: ${r.callCountMismatch}`);
  if (r.worstCall) {
    console.log(
      `  worst text-width match: "${r.worstCall.text}" @ ${r.worstCall.font} ${r.worstCall.size} — ` +
        `browser ${r.worstCall.bw.toFixed(2)} vs node ${r.worstCall.nw.toFixed(2)} (Δ${r.worstCall.d.toFixed(2)})`,
    );
  }
  if (r.vbBrowser !== r.vbNode) console.log(`  ! viewBox browser=${r.vbBrowser} node=${r.vbNode}`);
  if (r.fontWarnings.length) for (const w of r.fontWarnings) console.log(`  ! ${w}`);
}
console.log(`\nscreenshots and diffs in ${workDir}`);
