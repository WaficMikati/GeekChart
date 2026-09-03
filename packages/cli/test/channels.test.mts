import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAny, type AnyReply, type AnyRequest, type Session } from '../src/browser.ts';
import { getSession } from './helpers/session.ts';
import { cachedRender } from './helpers/render-cache.ts';

/**
 * The channel engine (DESIGN 2.7), phase 2: fans and chains. One assertion
 * per behaviour the old pipeline could not hold — pills seated on their own
 * line by construction (6.5), a fan-in's single arrowhead by construction
 * (6.3), parent centring through a wrap (2.8), and the reading-order ribbon
 * with its counted returns (1.9). Every chart here also runs the full gate:
 * the engine's output obeys the same rules as everything else.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', '..', 'fixtures');
const measureBundle = join(here, '..', 'dist', 'measure.js');

const fanout = (n: number): string =>
  `flowchart TB\n  D[Dispatcher]\n` +
  Array.from({ length: n }, (_, i) => `  H${i + 1}[Handler ${i + 1}]`).join('\n') +
  '\n' +
  Array.from({ length: n }, (_, i) => `  D -->|route ${i + 1}| H${i + 1}`).join('\n');

const fanin = (n: number): string =>
  `flowchart TB\n  A[Aggregator]\n` +
  Array.from({ length: n }, (_, i) => `  P${i + 1}[Producer ${i + 1}]`).join('\n') +
  '\n' +
  Array.from({ length: n }, (_, i) => `  P${i + 1} -->|emits| A`).join('\n');

const chain = (n: number, labeled = false): string =>
  `flowchart LR\n` +
  Array.from({ length: n }, (_, i) => `  N${i + 1}[Step ${i + 1}]`).join('\n') +
  '\n' +
  Array.from(
    { length: n - 1 },
    (_, i) => `  N${i + 1} ${labeled ? `-->|then ${i + 1}|` : '-->'} N${i + 2}`,
  ).join('\n');

const diamondFan = `flowchart TB
  R{Ready?}
  A[Deploy]
  B[Wait]
  C[Abort]
  R -->|yes| A
  R -->|no| B
  R -->|never| C`;

let session: Session;
before(async () => {
  session = await getSession();
});

const ok = (reply: AnyReply): Extract<AnyReply, { ok: true }> => {
  assert.equal(reply.ok, true, reply.ok ? '' : JSON.stringify(reply));
  return reply as Extract<AnyReply, { ok: true }>;
};

async function mount(source: string, options: AnyRequest = {}) {
  const reply = ok(
    await cachedRender('renderAny', source, options, () => renderAny(session.page, source, options)),
  );
  await session.page.setContent(reply.html, { waitUntil: 'load' });
  await session.page.evaluate(() => document.fonts.ready);
  return reply;
}

type GateGlobal = {
  geekchartMeasure: {
    measureChart: (
      svg: SVGSVGElement,
      opts: { chartId: string },
    ) => { fails: string[]; warns: string[] };
    runCheck: (
      svg: SVGSVGElement,
      id: string,
      opts: { chartId: string },
    ) => { severity: 'fail' | 'warn'; message: string }[];
  };
};

async function gateFails(): Promise<string[]> {
  await session.page.addScriptTag({ path: measureBundle });
  return session.page.evaluate(() => {
    const svg = document.querySelector('svg.gc-chart') as SVGSVGElement;
    return (window as unknown as GateGlobal).geekchartMeasure.measureChart(svg, { chartId: '' })
      .fails;
  });
}

async function gateCheck(id: string): Promise<string[]> {
  await session.page.addScriptTag({ path: measureBundle });
  return session.page.evaluate(
    (checkId) => {
      const svg = document.querySelector('svg.gc-chart') as SVGSVGElement;
      return (window as unknown as GateGlobal).geekchartMeasure
        .runCheck(svg, checkId, { chartId: '' })
        .filter((f) => f.severity === 'fail')
        .map((f) => f.message);
    },
    id,
  );
}

const isChannels = (svg: string): boolean => svg.includes('data-gc-engine="channels"');

describe('channel engine — routing and scope', () => {
  test('a labeled fan, a fan-in, a diamond fan and an LR chain go to the channel engine', async () => {
    for (const src of [fanout(4), fanin(6), diamondFan, chain(6)]) {
      const reply = await mount(src);
      assert.ok(isChannels(reply.svg), `expected channels engine for:\n${src}`);
    }
  });

  test('everything else keeps the old path: a decision flow, a 3-leaf-less fan, a TB chain', async () => {
    const flow = readFileSync(join(fixtures, 'flow.mmd'), 'utf8');
    const twoLeaves = `flowchart TB\n  Q{Pick}\n  A[Left]\n  B[Right]\n  Q -->|yes| A\n  Q -->|no| B`;
    const tbChain = chain(5).replace('flowchart LR', 'flowchart TB');
    for (const src of [flow, twoLeaves, tbChain]) {
      const reply = await mount(src);
      assert.ok(!isChannels(reply.svg), `expected old path for:\n${src}`);
    }
  });
});

describe('channel engine — fans', () => {
  test('DESIGN 6.5: every pill on a labeled fan sits on its own exclusive run, centre on the path', async () => {
    await mount(fanout(4));
    assert.deepEqual(await gateCheck('6.5-pill-on-line'), []);
    // The pin, measured directly: each plate's centre within 1 unit of its
    // own edge's drawn path.
    const worst = await session.page.evaluate(() => {
      const svg = document.querySelector('svg.gc-chart') as SVGSVGElement;
      const unit = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
      let max = 0;
      for (const g of svg.querySelectorAll('.gc-edge-label[data-id]')) {
        const plate = g.querySelector('.gc-plate')!.getBoundingClientRect();
        const e = svg.querySelector(`.gc-edge[data-id="${g.getAttribute('data-id')}"]`)!;
        const ctm = (e as SVGGraphicsElement).getScreenCTM()!;
        const nums = (e.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g)!.map(Number);
        const pts: [number, number][] = [];
        for (let i = 0; i + 1 < nums.length; i += 2)
          pts.push([nums[i]! * ctm.a + ctm.e, nums[i + 1]! * ctm.d + ctm.f]);
        const cx = (plate.left + plate.right) / 2;
        const cy = (plate.top + plate.bottom) / 2;
        let best = Infinity;
        for (let i = 1; i < pts.length; i++) {
          const [x1, y1] = pts[i - 1]!;
          const [x2, y2] = pts[i]!;
          const dx = x2 - x1;
          const dy = y2 - y1;
          const len2 = dx * dx + dy * dy;
          let t = len2 ? ((cx - x1) * dx + (cy - y1) * dy) / len2 : 0;
          t = Math.max(0, Math.min(1, t));
          best = Math.min(best, Math.hypot(cx - (x1 + t * dx), cy - (y1 + t * dy)));
        }
        max = Math.max(max, best / unit);
      }
      return max;
    });
    assert.ok(worst <= 1, `pill centre ${worst.toFixed(2)} units off its own path`);
  });

  test('DESIGN 6.3: a fan-in earns its single arrowhead by construction', async () => {
    await mount(fanin(6));
    const arrows = await session.page.evaluate(
      () => document.querySelectorAll('svg.gc-chart .gc-arrow').length,
    );
    assert.equal(arrows, 1, 'six producers into one sink must draw exactly one arrowhead');
    assert.deepEqual(await gateCheck('6.3-multi-head'), []);
  });

  test('DESIGN 2.8: fan symmetry holds through a wrap (fanout-10, two rows)', async () => {
    await mount(fanout(10));
    assert.deepEqual(await gateCheck('2.8-fan-symmetry'), []);
    const { rows, offset } = await session.page.evaluate(() => {
      const svg = document.querySelector('svg.gc-chart') as SVGSVGElement;
      const unit = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
      const leaves = [...svg.querySelectorAll('.gc-node[data-id]')].filter(
        (n) => n.getAttribute('data-id') !== 'D',
      );
      const hub = svg.querySelector('.gc-node[data-id="D"]')!.getBoundingClientRect();
      const rects = leaves.map((l) => l.getBoundingClientRect());
      const tops = [...new Set(rects.map((r) => Math.round(r.top)))];
      const left = Math.min(...rects.map((r) => r.left));
      const right = Math.max(...rects.map((r) => r.right));
      return {
        rows: tops.length,
        offset: Math.abs((hub.left + hub.right) / 2 - (left + right) / 2) / unit,
      };
    });
    assert.equal(rows, 2, 'ten leaves at display 1000 wrap into two rows');
    assert.ok(offset <= 1, `hub ${offset.toFixed(2)} units off its children's centre`);
  });

  test('DESIGN 6.5: a long label wraps at 28 characters; a third line is dropped with a warning', async () => {
    const src = `flowchart TB
  D[Dispatcher]
  A[Alpha]
  B[Beta]
  C[Gamma]
  D -->|this label is far too long to fit on one pill line at all| A
  D -->|wraps to a second pill line| B
  D -->|ok| C`;
    const reply = await mount(src);
    assert.ok(isChannels(reply.svg));
    assert.ok(
      reply.warnings.some((w) => w.startsWith('6.5-label-length')),
      `expected a 6.5-label-length warning, got: ${JSON.stringify(reply.warnings)}`,
    );
    // The truncated label renders exactly two stacked rows, never a third.
    const rows = await session.page.evaluate(() => {
      const g = document.querySelector('svg.gc-chart .gc-edge-label[data-id="L_D_A_0"]');
      return g ? g.querySelectorAll('text').length : -1;
    });
    assert.equal(rows, 2);
    assert.deepEqual(await gateCheck('6.5-pill-on-line'), []);
  });
});

describe('channel engine — chains (DESIGN 1.9)', () => {
  test('a 10-chain at display 1000 is a two-row ribbon with one return', async () => {
    await mount(chain(10), { display: 1000 });
    assert.deepEqual(await gateCheck('1.9-ribbon'), []);
    const { rows, returns } = await session.page.evaluate(() => {
      const svg = document.querySelector('svg.gc-chart') as SVGSVGElement;
      const tops = new Set(
        [...svg.querySelectorAll('.gc-node[data-id]')].map((n) =>
          Math.round(n.getBoundingClientRect().top),
        ),
      );
      return { rows: tops.size, returns: svg.querySelectorAll('.gc-edge.gc-return').length };
    });
    assert.equal(rows, 2, 'wrapped at the last possible moment: two rows');
    assert.equal(returns, 1, 'turn count = rows − 1');
  });

  test('at display 358 the ribbon degenerates to a vertical list — no returns, straight edges', async () => {
    await mount(chain(10), { display: 358 });
    const { columns, returns, bentEdges } = await session.page.evaluate(() => {
      const svg = document.querySelector('svg.gc-chart') as SVGSVGElement;
      const lefts = new Set(
        [...svg.querySelectorAll('.gc-node[data-id]')].map((n) =>
          Math.round(n.getBoundingClientRect().left),
        ),
      );
      let bent = 0;
      for (const e of svg.querySelectorAll('.gc-edge[data-id]')) {
        if (/[QC]/.test(e.getAttribute('d') || '')) bent++;
      }
      return {
        columns: lefts.size,
        returns: svg.querySelectorAll('.gc-edge.gc-return').length,
        bentEdges: bent,
      };
    });
    assert.equal(columns, 1, 'one column');
    assert.equal(returns, 0, 'no returns exist in the vertical list');
    assert.equal(bentEdges, 0, 'every edge runs straight down');
  });

  test('a labeled chain keeps every pill on its own run, the return pill on the band', async () => {
    await mount(chain(8, true), { display: 800 });
    assert.deepEqual(await gateCheck('6.5-pill-on-line'), []);
    assert.deepEqual(await gateCheck('1.9-ribbon'), []);
  });
});

describe('channel engine — the whole gate still applies', () => {
  test('every channel chart passes the full measure suite', async () => {
    const cases: [string, string, AnyRequest][] = [
      ['fanout-4', fanout(4), {}],
      ['fanout-10', fanout(10), {}],
      ['fanin-6', fanin(6), {}],
      ['fanin-10', fanin(10), {}],
      ['diamond-fan', diamondFan, {}],
      ['chain-6', chain(6), {}],
      ['chain-10', chain(10), { display: 1000 }],
      ['chain-10-phone', chain(10), { display: 358 }],
      ['labeled-chain-8', chain(8, true), {}],
    ];
    for (const [name, src, options] of cases) {
      const reply = await mount(src, options);
      assert.ok(isChannels(reply.svg), `${name} should route through the channel engine`);
      const fails = await gateFails();
      assert.deepEqual(fails, [], `${name}: ${fails.join('; ')}`);
    }
  });
});
