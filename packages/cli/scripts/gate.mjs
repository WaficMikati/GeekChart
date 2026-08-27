/**
 * Design gate: measure every chart in gallery.html against DESIGN.md.
 *
 *   pnpm gallery && pnpm gate            # all charts, browser-rendered
 *   pnpm gate flow control-plane         # just these
 *   pnpm gate --shots                    # also write PNGs to .gate/
 *   pnpm gate --json                     # the same results as JSON, for tests
 *   pnpm gallery --engine=node && pnpm gate --engine=node
 *                                         # same 47 checks against renderNode()'s SVGs
 *
 * Prints one line per chart with the rules it breaks (rule numbers are the
 * section numbers in DESIGN.md) and exits 1 if anything is a FAIL. WARN lines
 * are things the gate can only approximate; a human decides those from the
 * screenshot. The point is that "looks fine" is not an argument — the numbers
 * are.
 *
 * `--engine=node` only changes which gallery file this reads by default
 * (`gallery-node.html`, from `pnpm gallery --engine=node`, instead of
 * `gallery.html`) — it does not change how the gate measures. This still
 * runs in a real headless Chromium either way: the checks themselves
 * (packages/cli/src/measure/) are DOM code, and mounting a chart plus
 * reading its computed geometry needs a real browser regardless of which
 * engine drew the SVG being measured. What changes is only where that SVG
 * came from.
 *
 * The checks themselves live in packages/cli/src/measure/ (one file per
 * DESIGN.md section, one check per rule id) and are bundled to dist/measure.js
 * the same way dist/renderer.js is. This script just mounts each chart,
 * injects that bundle, and calls it — see AGENT-BRIEF.md before editing it.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const args = process.argv.slice(2);
const shots = args.includes('--shots');
const asJson = args.includes('--json');
const engine = args.find((a) => a.startsWith('--engine='))?.slice('--engine='.length) === 'node' ? 'node' : 'browser';
const only = new Set(args.filter((a) => !a.startsWith('--')));
const defaultPage = join(repo, engine === 'node' ? 'gallery-node.html' : 'gallery.html');
const page = args.find((a) => a.startsWith('--file='))?.slice(7) ?? defaultPage;
if (!existsSync(page)) {
  const how = engine === 'node' ? 'pnpm gallery --engine=node' : 'pnpm gallery';
  console.error(`no ${page} — run "${how}" first`);
  process.exit(2);
}
const measureJs = join(here, '..', 'dist', 'measure.js');
if (!existsSync(measureJs)) {
  console.error(`no ${measureJs} — run "pnpm --filter @geekchart/cli build" first`);
  process.exit(2);
}
const outDir = join(repo, '.gate');
if (shots) mkdirSync(outDir, { recursive: true });

// What the stage shows a 1000-wide canvas at in the review gallery; on-screen
// sizes are computed against this so the numbers match what a reviewer sees.
const STAGE_PX = 760; // narrowest common viewer (artifact panel); DESIGN 3.1 measures here

const browser = await chromium.launch();
const pg = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await pg.goto('file://' + page);
await pg.addScriptTag({ content: readFileSync(measureJs, 'utf8') });
await pg.waitForTimeout(1200);
const charts = await pg.$$eval('.chart', (cs) =>
  cs.map((c) => ({ id: c.id, title: c.querySelector('h2')?.textContent.trim() ?? c.id })),
);

let failed = 0;
const rows = [];
const results = [];
for (const { id } of charts) {
  const short = id.replace(/^gc-/, '');
  if (only.size && !only.has(short)) continue;
  await pg.evaluate((h) => { location.hash = h; }, '#' + id);
  await pg.waitForTimeout(250);
  await pg.evaluate(() => document.body.classList.add('still'));
  await pg.waitForTimeout(150);

  const m = await pg.evaluate(
    ({ stagePx, chartId }) => {
      const svg = document.querySelector('.chart:not([hidden]) .stage svg');
      if (!svg) return null;
      const vb = svg.viewBox.baseVal;
      const { fails, warns } = window.geekchartMeasure.measureChart(svg, { stagePx, chartId });
      return { vb: [Math.round(vb.width), Math.round(vb.height)], fails, warns };
    },
    { stagePx: STAGE_PX, chartId: short },
  );

  if (!m) {
    rows.push(`${short.padEnd(16)} FAIL  no svg`);
    results.push({ chart: short, status: 'FAIL', viewBox: null, fails: ['no svg'], warns: [] });
    failed++;
    continue;
  }
  if (shots) {
    const el = await pg.$('.chart:not([hidden]) .stage svg');
    await el.screenshot({ path: join(outDir, `${short}.png`) });
  }

  const { fails, warns } = m;
  if (fails.length) failed++;
  const status = fails.length ? 'FAIL' : warns.length ? 'WARN' : 'ok  ';
  results.push({ chart: short, status: status.trim(), viewBox: m.vb, fails, warns });
  rows.push(`${short.padEnd(16)} ${status}  ${m.vb.join('×')}`.padEnd(36) + [...fails, ...warns.map((w) => `(${w})`)].join('; '));
}
await browser.close();

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(rows.join('\n'));
  console.log(`\n${rows.length} charts, ${failed} failing${shots ? `, shots in ${outDir}` : ''}`);
}
process.exit(failed ? 1 : 0);
