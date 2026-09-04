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
  // Measure the still frame, the way the gate does (gate.mjs's `still`
  // class): mid-animation, an element still waiting on its own draw-on sits
  // at opacity 0 and the visibility-aware checks (7.3's centring) would
  // read a half-built chart.
  await session.page.addStyleTag({ content: 'svg.gc-chart, svg.gc-chart * { animation: none !important; }' });
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

  test('a TB chain is the grid planner’s vertical list (phase 3a’s axis variant)', async () => {
    const tbChain = chain(5).replace('flowchart LR', 'flowchart TB');
    const reply = await mount(tbChain);
    assert.ok(isChannels(reply.svg), `expected channels engine for:\n${tbChain}`);
  });

  test('everything else keeps the old path: a too-wide LR decision flow, a 3-node fan, a cluster', async () => {
    // flow.mmd is an LR run of six ranks — wider than the undeclared room —
    // so the grid planner declines it and the old path runs unchanged.
    const flow = readFileSync(join(fixtures, 'flow.mmd'), 'utf8');
    const twoLeaves = `flowchart TB\n  Q{Pick}\n  A[Left]\n  B[Right]\n  Q -->|yes| A\n  Q -->|no| B`;
    const clustered = readFileSync(join(fixtures, 'subgraphs.mmd'), 'utf8');
    for (const src of [flow, twoLeaves, clustered]) {
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

describe('channel engine — the grid planner (phase 3a)', () => {
  const fixture = (name: string) => readFileSync(join(fixtures, name), 'utf8');
  const nodeBox = async (id: string) =>
    session.page.evaluate((nid) => {
      const n = document.querySelector(`svg.gc-chart .gc-node[data-id="${nid}"] .gc-outline`);
      const b = (n as SVGGraphicsElement).getBBox();
      return { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2 };
    }, id);
  const edgeXs = async (id: string) =>
    session.page.evaluate((eid) => {
      const e = document.querySelector(`svg.gc-chart .gc-edge[data-id="${eid}"]`)!;
      const nums = (e.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g)!.map(Number);
      return nums.filter((_, i) => i % 2 === 0);
    }, id);

  test('two-diamonds: the second decision sits under the first, not off to the side', async () => {
    // The user's review: "Second being on the left, aligned to Start, is
    // nonsensical." The deep branch keeps its parent's axis: Q2 directly
    // under Q1's own column band, and Q2 centred on C/D as a group (2.8).
    const reply = await mount(fixture('two-diamonds.mmd'));
    assert.ok(isChannels(reply.svg));
    const [q1, q2, c, d] = await Promise.all(['Q1', 'Q2', 'C', 'D'].map(nodeBox));
    assert.ok(
      q2!.cx > q1!.x && q2!.cx < q1!.x + q1!.w,
      `Q2's centre ${q2!.cx} sits outside Q1's column band [${q1!.x}, ${q1!.x + q1!.w}]`,
    );
    assert.ok(Math.abs(q1!.cx - q2!.cx) <= 1, `Q2 is ${Math.abs(q1!.cx - q2!.cx)} off Q1's axis`);
    const groupC = (Math.min(c!.x, d!.x) + Math.max(c!.x + c!.w, d!.x + d!.w)) / 2;
    assert.ok(Math.abs(q2!.cx - groupC) <= 1, `Q2 is ${Math.abs(q2!.cx - groupC)} off C/D's centre`);
  });

  test('diamond-cascade: every label on its own line, every run orthogonal', async () => {
    // The user's review flagged bare diagonal-ish runs with labels floating
    // beside them; a channel chart draws neither.
    const reply = await mount(fixture('diamond-cascade.mmd'));
    assert.ok(isChannels(reply.svg));
    assert.deepEqual(await gateCheck('6.5-pill-on-line'), []);
    const diagonal = await session.page.evaluate(() => {
      let bad = 0;
      for (const e of document.querySelectorAll('svg.gc-chart .gc-edge[data-id]')) {
        const nums = (e.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g)!.map(Number);
        for (let i = 2; i + 1 < nums.length; i += 2) {
          const dx = Math.abs(nums[i]! - nums[i - 2]!);
          const dy = Math.abs(nums[i + 1]! - nums[i - 1]!);
          if (dx > 12 && dy > 12) bad++; // a rounded corner moves ≤12 on each axis
        }
      }
      return bad;
    });
    assert.equal(diagonal, 0, `${diagonal} diagonal-ish runs`);
    // The cascade's spine holds one axis: each Check sits under the last.
    const [q1, q2, q3] = await Promise.all(['Q1', 'Q2', 'Q3'].map(nodeBox));
    assert.ok(Math.abs(q1!.cx - q2!.cx) <= 1 && Math.abs(q2!.cx - q3!.cx) <= 1);
  });

  test('ternary-tree: the root centres on the widest row, the branch row on the same axis', async () => {
    const reply = await mount(fixture('ternary-tree.mmd'));
    assert.ok(isChannels(reply.svg));
    const boxes = await session.page.evaluate(() => {
      return [...document.querySelectorAll('svg.gc-chart .gc-node[data-id]')].map((n) => {
        const b = (n.querySelector('.gc-outline') as SVGGraphicsElement).getBBox();
        return { id: n.getAttribute('data-id')!, x: b.x, y: b.y, w: b.width };
      });
    });
    const root = boxes.find((b) => b.id === 'ROOT')!;
    const rows = new Map<number, typeof boxes>();
    for (const b of boxes) {
      const key = Math.round(b.y / 8);
      rows.set(key, [...(rows.get(key) ?? []), b]);
    }
    const widest = [...rows.values()].sort(
      (a, b) =>
        Math.max(...b.map((n) => n.x + n.w)) -
        Math.min(...b.map((n) => n.x)) -
        (Math.max(...a.map((n) => n.x + n.w)) - Math.min(...a.map((n) => n.x))),
    )[0]!;
    const widestC =
      (Math.min(...widest.map((n) => n.x)) + Math.max(...widest.map((n) => n.x + n.w))) / 2;
    assert.ok(
      Math.abs(root.x + root.w / 2 - widestC) <= 1,
      `root is ${Math.abs(root.x + root.w / 2 - widestC).toFixed(1)} off the widest row's centre`,
    );
    const branches = boxes.filter((b) => /^R\d$/.test(b.id));
    assert.equal(branches.length, 4);
    const branchC =
      (Math.min(...branches.map((n) => n.x)) + Math.max(...branches.map((n) => n.x + n.w))) / 2;
    assert.ok(
      Math.abs(root.x + root.w / 2 - branchC) <= 1,
      `second row is ${Math.abs(root.x + root.w / 2 - branchC).toFixed(1)} off the root's axis`,
    );
  });

  test('git-workflow: no node side both receives and emits, labels on their lines', async () => {
    // The user's review: Merge had a line out of the same side one came in.
    const reply = await mount(fixture('git-workflow.mmd'));
    assert.ok(isChannels(reply.svg));
    assert.deepEqual(await gateCheck('6.2-side-exclusivity'), []);
    assert.deepEqual(await gateCheck('6.5-pill-on-line'), []);
  });

  test('login-flow: the rank-skipping MFA→S edge hugs the free side of OTP, not the long way', async () => {
    const reply = await mount(fixture('login-flow.mmd'));
    assert.ok(isChannels(reply.svg));
    const otp = await nodeBox('OTP');
    const xs = await edgeXs('L_MFA_S_0');
    const beyond = Math.max(...xs) - (otp!.x + otp!.w);
    assert.ok(beyond > 8, `MFA→S never leaves OTP's column (max x ${Math.max(...xs)})`);
    assert.ok(
      beyond <= 120,
      `MFA→S swings ${beyond.toFixed(0)} past OTP — the long way, not the adjacent corridor`,
    );
    assert.ok(
      Math.min(...xs) >= otp!.x - 40,
      `MFA→S also wanders past OTP's other side (min x ${Math.min(...xs)})`,
    );
  });

  test('back-to-start: an LR chain with a loop-back arrives where the forward flow arrives, one head', async () => {
    const reply = await mount(fixture('back-to-start.mmd'));
    assert.ok(isChannels(reply.svg));
    const { back, bends, heads } = await session.page.evaluate(() => {
      const e = document.querySelector('svg.gc-chart .gc-edge[data-id="L_D_B_0"]')!;
      const nums = (e.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g)!.map(Number);
      const pts: [number, number][] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i]!, nums[i + 1]!]);
      let bendCount = 0;
      let prev: 'h' | 'v' | null = null;
      for (let i = 1; i < pts.length; i++) {
        const dx = Math.abs(pts[i]![0] - pts[i - 1]![0]);
        const dy = Math.abs(pts[i]![1] - pts[i - 1]![1]);
        if (dx < 0.5 && dy < 0.5) continue;
        const dir: 'h' | 'v' = dx >= dy ? 'h' : 'v';
        if (prev && dir !== prev) bendCount++;
        prev = dir;
      }
      const headCount = ['L_A_B_0', 'L_D_B_0'].filter((id) =>
        document.querySelector(`svg.gc-chart .gc-arrow[data-id="${id}"]`),
      ).length;
      return { back: e.classList.contains('gc-back'), bends: bendCount, heads: headCount };
    });
    assert.ok(back, 'D→B must draw as a loop-back');
    assert.ok(bends <= 4, `loop-back has ${bends} bends`);
    assert.equal(heads, 1, 'the loop and the forward edge into Triage merge into one arrowhead');
    assert.deepEqual(await gateCheck('6.2-side-exclusivity'), []);
    assert.deepEqual(await gateCheck('6.14-return-bus'), []);
  });

  test('hub-with-returns: three returns are one bus — one corridor, one trunk, one head', async () => {
    // The user's review: three workers returning to one scheduler drew three
    // independent 4-bend loops — concentric rings, each individually legal.
    // DESIGN 6.14: they merge into one bus instead.
    const reply = await mount(fixture('hub-with-returns.mmd'));
    assert.ok(isChannels(reply.svg));
    assert.deepEqual(await gateCheck('6.14-return-bus'), []);

    const shape = await session.page.evaluate(() => {
      const svg = document.querySelector('svg.gc-chart') as SVGSVGElement;
      const pts = (d: string): [number, number][] => {
        const out: [number, number][] = [];
        let cx = 0;
        let cy = 0;
        for (const seg of d.matchAll(/([MLHVQCZ])([^MLHVQCZ]*)/gi)) {
          const ns = (seg[2]!.match(/-?\d+(\.\d+)?/g) || []).map(Number);
          if (ns.length < 2) continue;
          cx = ns[ns.length - 2]!;
          cy = ns[ns.length - 1]!;
          out.push([cx, cy]);
        }
        return out;
      };
      const returns = ['L_W1_HUB_0', 'L_W2_HUB_0', 'L_W3_HUB_0'].map(
        (id) => svg.querySelector(`.gc-edge[data-id="${id}"]`) as SVGPathElement,
      );
      // Distinct long vertical runs across all three returns: the trunk.
      const trunks = new Set<number>();
      for (const e of returns) {
        const p = pts(e.getAttribute('d') || '');
        for (let i = 1; i < p.length; i++) {
          if (Math.abs(p[i]![0] - p[i - 1]![0]) < 1 && Math.abs(p[i]![1] - p[i - 1]![1]) > 40)
            trunks.add(Math.round(p[i]![0]));
        }
      }
      // The arrival: every branch ends at one point, so one head is drawn.
      const ends = returns.map((e) => {
        const p = pts(e.getAttribute('d') || '');
        return p[p.length - 1]!;
      });
      const heads = returns.filter((e) =>
        svg.querySelector(`.gc-arrow[data-id="${e.getAttribute('data-id')}"]`),
      ).length;
      // The trunk's own start — the band turning up into the corridor. Every
      // branch draws it, so read it off the first: the corner must be an arc
      // (a Q), not two perpendicular line segments meeting at a square edge.
      const d0 = returns[0]!.getAttribute('d') || '';
      const p0 = pts(d0);
      const trunkX = [...trunks][0]!;
      const cmds = [...d0.matchAll(/([MLHVQCZ])([^MLHVQCZ]*)/gi)].map((m) => m[1]!.toUpperCase());
      let cornerIsArc: boolean | null = null;
      for (let i = 1; i < p0.length; i++) {
        // The turn from the band (horizontal) onto the trunk (vertical).
        const horizontal = Math.abs(p0[i]![1] - p0[i - 1]![1]) < 1;
        if (horizontal && Math.abs(p0[i]![0] - trunkX) < 14 && i + 1 < p0.length) {
          cornerIsArc = cmds[i + 1] === 'Q' || cmds[i + 1] === 'C';
          break;
        }
      }
      return {
        corridors: trunks.size,
        ends,
        heads,
        cornerIsArc,
        returnClass: returns.every((e) => e.classList.contains('gc-return')),
      };
    });

    assert.equal(shape.corridors, 1, 'three returns ride one corridor, not three');
    assert.ok(shape.returnClass, 'each branch is drawn as part of the return bus');
    for (const e of shape.ends) {
      assert.ok(
        Math.abs(e[0] - shape.ends[0]![0]) < 1.5 && Math.abs(e[1] - shape.ends[0]![1]) < 1.5,
        `returns arrive at different points: ${JSON.stringify(shape.ends)}`,
      );
    }
    assert.equal(shape.heads, 1, 'one arrowhead into Scheduler, by construction');
    assert.equal(shape.cornerIsArc, true, 'the trunk starts with a rounded turn, not a square corner');
    assert.deepEqual(await gateCheck('6.2-side-exclusivity'), []);
    assert.deepEqual(await gateCheck('6.7-long-loop'), []);
  });

  test('git-workflow: two returns to different targets take separate flanks and never nest', async () => {
    await mount(fixture('git-workflow.mmd'));
    assert.deepEqual(await gateCheck('6.14-return-bus'), []);
    const sides = await session.page.evaluate(() => {
      const svg = document.querySelector('svg.gc-chart') as SVGSVGElement;
      const box = (id: string) => {
        const e = svg.querySelector(`.gc-edge[data-id="${id}"]`)!;
        const nums = (e.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g)!.map(Number);
        const xs = nums.filter((_, i) => i % 2 === 0);
        const ys = nums.filter((_, i) => i % 2 === 1);
        return { x1: Math.min(...xs), x2: Math.max(...xs), y1: Math.min(...ys), y2: Math.max(...ys) };
      };
      return { rc: box('L_R_C_0'), mgm: box('L_MG_M_0') };
    });
    const { rc, mgm } = sides;
    const nests = (a: typeof rc, b: typeof rc) =>
      a.x1 <= b.x1 - 1 && a.y1 <= b.y1 - 1 && a.x2 >= b.x2 + 1 && a.y2 >= b.y2 + 1;
    assert.ok(!nests(rc, mgm) && !nests(mgm, rc), 'the two loop routes must not nest');
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
      ['two-diamonds', readFileSync(join(fixtures, 'two-diamonds.mmd'), 'utf8'), {}],
      ['diamond-cascade', readFileSync(join(fixtures, 'diamond-cascade.mmd'), 'utf8'), {}],
      ['ternary-tree', readFileSync(join(fixtures, 'ternary-tree.mmd'), 'utf8'), {}],
      ['git-workflow', readFileSync(join(fixtures, 'git-workflow.mmd'), 'utf8'), {}],
      ['login-flow', readFileSync(join(fixtures, 'login-flow.mmd'), 'utf8'), {}],
      ['back-to-start', readFileSync(join(fixtures, 'back-to-start.mmd'), 'utf8'), {}],
      ['hub-with-returns', readFileSync(join(fixtures, 'hub-with-returns.mmd'), 'utf8'), {}],
    ];
    for (const [name, src, options] of cases) {
      const reply = await mount(src, options);
      assert.ok(isChannels(reply.svg), `${name} should route through the channel engine`);
      const fails = await gateFails();
      assert.deepEqual(fails, [], `${name}: ${fails.join('; ')}`);
    }
  });
});
