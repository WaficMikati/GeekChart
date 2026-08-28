import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAny, type AnyReply, type Session } from '../src/browser.ts';
import { getSession } from './helpers/session.ts';
import { cachedRender } from './helpers/render-cache.ts';

/**
 * Edge geometry, measured. DESIGN 6.1–6.7, 2.1, 2.3, 2.6, 10.3.
 *
 * Every assertion here is a fault a reviewer found in a screenshot and nothing
 * in the pipeline objected to: a diagonal joining two rows of a wrapped flow, a
 * link cutting through a cylinder it had nothing to do with, four channels
 * converging on one point on a panel, a retry drawn as a free arc over the top.
 * None of them fail a render, none of them fail the design gate, and all of them
 * are arithmetic — which is why they belong here rather than in a review note.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', '..', 'fixtures');

/** The families this file speaks for: mermaid parses, ELK places, `draw` draws. */
const GRAPHS = [
  'flow.mmd',
  'subgraphs.mmd',
  '4geeks-journey.mmd',
  'state.mmd',
  'class.mmd',
  'er.mmd',
  'control-plane.mmd',
  'architecture.mmd',
  'org-chart.mmd',
];

let session: Session;
before(async () => {
  session = await getSession();
});

const ok = (reply: AnyReply): Extract<AnyReply, { ok: true }> => {
  assert.equal(reply.ok, true, reply.ok ? '' : JSON.stringify(reply));
  return reply as Extract<AnyReply, { ok: true }>;
};

const measureBundle = join(here, '..', 'dist', 'measure.js');

/** The gate's own DESIGN.md checks (packages/cli/src/measure/), the same
 *  bundle gate.mjs injects — see packages/cli/scripts/gate.mjs. */
type GateGlobal = {
  geekchartMeasure: {
    runCheck: (
      svg: SVGSVGElement,
      id: string,
      opts: { chartId: string },
    ) => { severity: 'fail' | 'warn'; message: string }[];
  };
};

async function gateFindings(id: string): Promise<string[]> {
  if (!existsSync(measureBundle)) {
    throw new Error('run `pnpm --filter @geekchart/cli build` first');
  }
  await session.page.addScriptTag({ path: measureBundle });
  return session.page.evaluate((checkId) => {
    const svg = document.querySelector('svg.gc-chart') as SVGSVGElement;
    return (window as unknown as GateGlobal).geekchartMeasure
      .runCheck(svg, checkId, { chartId: '' })
      .map((f) => f.message);
  }, id);
}

async function mount(name: string) {
  const source = readFileSync(join(fixtures, name), 'utf8');
  const options = { motion: false };
  const reply = ok(
    await cachedRender('renderAny', source, options, () => renderAny(session.page, source, options)),
  );
  await session.page.setContent(reply.html, { waitUntil: 'load' });
  await session.page.evaluate(() => document.fonts.ready);
  return reply;
}

/** What the browser reports back about one chart's edges and boxes. */
interface Measured {
  edges: {
    id: string;
    from: string;
    to: string;
    /** Straight runs, in order. A rounded corner is not one. */
    runs: { x1: number; y1: number; x2: number; y2: number }[];
    /** Corners, as the three points that define the quadratic. */
    corners: { ax: number; ay: number; cx: number; cy: number; bx: number; by: number }[];
    head: { tipX: number; tipY: number; baseX: number; baseY: number } | null;
    lastX: number;
    lastY: number;
  }[];
  nodes: { id: string; x: number; y: number; w: number; h: number }[];
  clusters: { id: string; x: number; y: number; w: number; h: number }[];
}

const measure = (): Promise<Measured> =>
  session.page.evaluate(() => {
    const svg = document.querySelector('svg.gc-chart')!;
    const numbers = (t: string) => (t.match(/-?\d+\.?\d*/g) ?? []).map(Number);

    const edges = [...svg.querySelectorAll<SVGPathElement>('.gc-edge')].map((line) => {
      const d = line.getAttribute('d') ?? '';
      const runs: Measured['edges'][number]['runs'] = [];
      const corners: Measured['edges'][number]['corners'] = [];
      let at = { x: 0, y: 0 };
      for (const step of d.matchAll(/([MLQ])([^MLQ]*)/g)) {
        const n = numbers(step[2] ?? '');
        if (step[1] === 'M') {
          at = { x: n[0]!, y: n[1]! };
        } else if (step[1] === 'L') {
          runs.push({ x1: at.x, y1: at.y, x2: n[0]!, y2: n[1]! });
          at = { x: n[0]!, y: n[1]! };
        } else {
          corners.push({ ax: at.x, ay: at.y, cx: n[0]!, cy: n[1]!, bx: n[2]!, by: n[3]! });
          at = { x: n[2]!, y: n[3]! };
        }
      }
      const mark = svg.querySelector<SVGPathElement>(
        `.gc-arrow[data-id="${line.dataset.id}"]:not(.gc-tip-line)`,
      );
      const m = mark ? numbers(mark.getAttribute('d') ?? '') : [];
      return {
        id: line.dataset.id!,
        from: line.dataset.from!,
        to: line.dataset.to!,
        runs,
        corners,
        head:
          m.length >= 6
            ? { tipX: m[2]!, tipY: m[3]!, baseX: (m[0]! + m[4]!) / 2, baseY: (m[1]! + m[5]!) / 2 }
            : null,
        lastX: at.x,
        lastY: at.y,
      };
    });

    const boxOf = (el: Element) => {
      const b = (el as SVGGraphicsElement).getBBox();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    };
    const nodes = [...svg.querySelectorAll<SVGGElement>('.gc-node')].map((n) => ({
      id: n.dataset.id!,
      ...boxOf(n.querySelector('.gc-outline, .gc-fill')!),
    }));
    const clusters = [...svg.querySelectorAll<SVGGElement>('.gc-cluster')].map((c) => ({
      id: c.dataset.id!,
      ...boxOf(c.querySelector('.gc-cluster-box')!),
    }));
    return { edges, nodes, clusters };
  });

describe('every edge is orthogonal', () => {
  test('no segment travels in two directions at once', async () => {
    // The wrapped second row of the flowchart was joined to the first by a long
    // diagonal, and the learner journey folded the same way. DESIGN 6.1: a
    // renderer that placed the boxes itself has no excuse for a diagonal.
    for (const name of GRAPHS) {
      await mount(name);
      const { edges } = await measure();
      assert.ok(edges.length > 0, `${name} drew no edges`);
      for (const edge of edges) {
        for (const run of edge.runs) {
          const dx = Math.abs(run.x2 - run.x1);
          const dy = Math.abs(run.y2 - run.y1);
          assert.ok(
            dx < 0.5 || dy < 0.5,
            `${name} ${edge.id}: a run goes ${dx.toFixed(1)} across and ${dy.toFixed(1)} down`,
          );
        }
        // A rounded corner is the only curve allowed, and it is only a corner if
        // its control point squares up with both ends. A quadratic between two
        // free points is a diagonal wearing a hat.
        for (const c of edge.corners) {
          const inLine = Math.abs(c.cx - c.ax) < 0.5 || Math.abs(c.cy - c.ay) < 0.5;
          const outLine = Math.abs(c.bx - c.cx) < 0.5 || Math.abs(c.by - c.cy) < 0.5;
          assert.ok(inLine && outLine, `${name} ${edge.id}: a corner is not a right angle`);
        }
      }
    }
  });

  test('nothing runs through a box it does not connect to', async () => {
    // The Worker → API link crossed the Cache cylinder, which is DESIGN 6.1's
    // named example. Measured against every box rather than that one.
    for (const name of GRAPHS) {
      await mount(name);
      const { edges, nodes, clusters } = await measure();
      const holds = new Map(clusters.map((c) => [c.id, new Set<string>()]));
      for (const node of nodes) {
        for (const c of clusters) {
          const inside =
            node.x >= c.x - 1 &&
            node.x + node.w <= c.x + c.w + 1 &&
            node.y >= c.y - 1 &&
            node.y + node.h <= c.y + c.h + 1;
          if (inside) holds.get(c.id)!.add(node.id);
        }
      }
      for (const edge of edges) {
        for (const node of nodes) {
          if (node.id === edge.from || node.id === edge.to) continue;
          // A group the edge has an end inside is not something it crosses.
          if (
            [...holds].some(([id, set]) => (id === edge.from || id === edge.to) && set.has(node.id))
          )
            continue;
          for (const run of edge.runs) {
            // A run has no thickness, so the overlap on its own axis has to be
            // asked as "is the line inside the box" rather than measured — an
            // area test says no every time and the check silently passes.
            const span = (lo: number, hi: number, from: number, to: number) =>
              lo === hi ? (lo > from && lo < to ? 1 : -1) : Math.min(hi, to) - Math.max(lo, from);
            const w = span(
              Math.min(run.x1, run.x2),
              Math.max(run.x1, run.x2),
              node.x + 3,
              node.x + node.w - 3,
            );
            const h = span(
              Math.min(run.y1, run.y2),
              Math.max(run.y1, run.y2),
              node.y + 3,
              node.y + node.h - 3,
            );
            assert.ok(
              w <= 0 || h <= 0,
              `${name} ${edge.id}: runs ${Math.min(w, h).toFixed(0)} through ${node.id}`,
            );
          }
        }
      }
    }
  });

  test('the head is on the outline and square to the run that ends there', async () => {
    // DESIGN 6.3 and 10.3. The head's point meets the box; the line stops 6
    // short so the two read as one mark. Both are arithmetic off the last run,
    // so a head that disagrees with its line means they were built apart.
    // Class and ER relationships end in stroked notation rather than a filled
    // head, so the count is kept across the set instead of per chart.
    let checked = 0;
    for (const name of GRAPHS) {
      await mount(name);
      const { edges, nodes, clusters } = await measure();
      const boxes = new Map([...nodes, ...clusters].map((b) => [b.id, b]));
      for (const edge of edges) {
        if (!edge.head) continue;
        const last = edge.runs[edge.runs.length - 1];
        if (!last) continue;
        const deg = (dx: number, dy: number) => (Math.atan2(dy, dx) * 180) / Math.PI;
        const off =
          deg(edge.head.tipX - edge.head.baseX, edge.head.tipY - edge.head.baseY) -
          deg(last.x2 - last.x1, last.y2 - last.y1);
        assert.ok(
          Math.abs(((off + 540) % 360) - 180) < 1,
          `${name} ${edge.id}: head is ${off.toFixed(2)} degrees off its last run`,
        );

        const target = boxes.get(edge.to);
        if (target) {
          const dx = Math.max(target.x - edge.head.tipX, edge.head.tipX - (target.x + target.w), 0);
          const dy = Math.max(target.y - edge.head.tipY, edge.head.tipY - (target.y + target.h), 0);
          assert.ok(
            Math.hypot(dx, dy) < 2,
            `${name} ${edge.id}: head stops ${Math.hypot(dx, dy).toFixed(1)} off the outline`,
          );
        }
        // The line ends where the head begins, give or take the notch.
        assert.ok(
          Math.hypot(edge.lastX - edge.head.baseX, edge.lastY - edge.head.baseY) < 1.5,
          `${name} ${edge.id}: the line does not meet its head`,
        );
        checked++;
      }
    }
    assert.ok(checked >= 20, `only ${checked} arrowheads were checked`);
  });
});

describe('panels, loops and the grid', () => {
  test('a panel takes one straight channel per column, in and out', async () => {
    // DESIGN 2.6 and 6.4. Four inputs converged on a single point on the panel's
    // top edge and the outputs fanned from a single point below it; the columns
    // above and below did not line up with each other at all.
    await mount('control-plane.mmd');
    const { edges, nodes, clusters } = await measure();
    const panel = clusters[0]!;
    const touching = edges.filter((e) => e.from === panel.id || e.to === panel.id);
    assert.ok(touching.length >= 8, 'the fixture feeds and drains the panel');

    const columns = { in: [] as number[], out: [] as number[] };
    for (const edge of touching) {
      assert.equal(edge.corners.length, 0, `${edge.id}: a channel into a panel must not bend`);
      assert.equal(edge.runs.length, 1, `${edge.id}: a channel into a panel is one run`);
      const run = edge.runs[0]!;
      assert.ok(Math.abs(run.x2 - run.x1) < 0.5, `${edge.id}: the channel is not vertical`);
      (edge.to === panel.id ? columns.in : columns.out).push(Math.round(run.x1));
    }
    columns.in.sort((a, b) => a - b);
    columns.out.sort((a, b) => a - b);
    assert.deepEqual(columns.out, columns.in, 'inputs and outputs must share their columns');
    // …and no two share one, which is what "converging on one pixel" was.
    assert.equal(new Set(columns.in).size, columns.in.length, 'two inputs share a column');

    // Each column is a box's own middle, so the channel leaves and lands square.
    for (const x of columns.in) {
      assert.ok(
        nodes.some((n) => Math.abs(n.x + n.w / 2 - x) < 1),
        `the channel at ${x} is not on any box's centre line`,
      );
    }
  });

  test('a loop back goes around, 24 clear of everything it passes', async () => {
    // DESIGN 6.7. A loop used to be a free arc drawn over the diagram; then it
    // was sent all the way to the canvas margin. Neither is the rule. Since the
    // "nearest corridor" scoring in route.ts, a loop takes the closest gap that
    // fits — between two rows, past a side, wherever — and what makes it
    // "around" is clearance: every long run of the loop keeps 24 from every
    // box it is not attached to. flow.mmd and 4geeks-journey both have retries.
    for (const name of ['flow.mmd', '4geeks-journey.mmd']) {
      await mount(name);
      const { edges, nodes } = await measure();
      const loops = edges.filter((e) => e.corners.length >= 3);
      assert.ok(loops.length > 0, `${name} has a retry that has to go around`);
      for (const edge of loops) {
        const own = edge.id.match(/^L_(.+?)_(.+?)_\d+$/)?.slice(1, 3) ?? [];
        for (const run of edge.runs) {
          const long = Math.abs(run.x2 - run.x1) > 40 || Math.abs(run.y2 - run.y1) > 40;
          if (!long) continue;
          const x1 = Math.min(run.x1, run.x2),
            x2 = Math.max(run.x1, run.x2);
          const y1 = Math.min(run.y1, run.y2),
            y2 = Math.max(run.y1, run.y2);
          for (const n of nodes) {
            if (own.includes(n.id)) continue; // its own ends are governed by 6.2
            const touches = (px: number, py: number) =>
              px >= n.x - 8 && px <= n.x + n.w + 8 && py >= n.y - 8 && py <= n.y + n.h + 8;
            if (touches(run.x1, run.y1) || touches(run.x2, run.y2)) continue; // an attachment stub
            const dx = Math.max(n.x - x2, x1 - (n.x + n.w), 0);
            const dy = Math.max(n.y - y2, y1 - (n.y + n.h), 0);
            const clear = Math.max(dx, dy);
            assert.ok(
              clear >= 23.5,
              `${name} ${edge.id}: a loop run passes ${clear.toFixed(0)} from ${n.id}, not 24`,
            );
          }
        }
      }
    }
  });

  test('rows share a y, columns share an x, and boxes are on the 8-grid', async () => {
    // DESIGN 2.1, 2.2, 2.3. With every edge now axis-aligned, a row that is a
    // fifth of a unit out of true turns each of its edges into a visible jog.
    for (const name of GRAPHS) {
      await mount(name);
      const { nodes } = await measure();
      for (const node of nodes) {
        assert.equal(
          Math.round(node.w) % 8,
          0,
          `${name} ${node.id}: width ${node.w} is off the grid`,
        );
        assert.equal(
          Math.round(node.h) % 8,
          0,
          `${name} ${node.id}: height ${node.h} is off the grid`,
        );
      }
      // Boxes whose middles are within half a box of each other are one row, and
      // a row has exactly one middle.
      const band = (of: (n: (typeof nodes)[number]) => number) => {
        const groups: number[][] = [];
        for (const value of nodes.map(of).sort((a, b) => a - b)) {
          const last = groups[groups.length - 1];
          if (last && value - last[last.length - 1]! <= 9) last.push(value);
          else groups.push([value]);
        }
        return groups;
      };
      for (const row of band((n) => n.y + n.h / 2)) {
        assert.ok(
          Math.max(...row) - Math.min(...row) < 0.5,
          `${name}: a row's middles span ${(Math.max(...row) - Math.min(...row)).toFixed(1)}`,
        );
      }
      for (const column of band((n) => n.x + n.w / 2)) {
        assert.ok(
          Math.max(...column) - Math.min(...column) < 0.5,
          `${name}: a column's middles span ${(Math.max(...column) - Math.min(...column)).toFixed(1)}`,
        );
      }
    }
  });
});

describe('label clearance', () => {
  // DESIGN 6.9: an edge label keeps 8 units clear of every node box it does
  // not belong to. Both of these were real fails once the gate could see
  // it: G→I's "no" (4geeks-journey) sat 5.68 short of the decision diamond
  // it answers, and the "leads" relationship name (er) sat squeezed between
  // MENTOR and COHORT with under 8 either side. Fixed at the placer itself
  // (DESIGN 1.5's own `capOffLineReach` cap aside, every chart shares this
  // search), not per chart — these pin the fix in place.
  test('4geeks-journey: no label sits within 8 of a node box', async () => {
    await mount('4geeks-journey.mmd');
    const findings = await gateFindings('6.9-label-clear');
    assert.deepEqual(findings, [], findings.join('; '));
  });

  test('er: no relationship name sits within 8 of an entity box', async () => {
    await mount('er.mmd');
    const findings = await gateFindings('6.9-label-clear');
    assert.deepEqual(findings, [], findings.join('; '));
  });
});

describe('label placement (placeLabels rewrite)', () => {
  // The old placer (a capped search, off-line offsets, a dodge-nudge array,
  // a corridor-growth retry) had grown by patches until it could no longer
  // satisfy 6.5 and 6.11 together: `python-or-java`'s "no, enterprise or
  // Android" swallowed its own edge; `state`'s "final project shipped" and
  // "holiday" did too; `4geeks-journey`'s "no" landed 8 short of its own
  // edge and near another one; `er`'s "submits"/"leads" were the same drift.
  // Rewritten as one constrained search (draw.ts's `placeLabels`) — these
  // pin every one of those in place so none of them come back.
  test('python-or-java: no label swallows its edge or drifts off it', async () => {
    await mount('blog/python-or-java.mmd');
    assert.deepEqual(await gateFindings('6.5-label-swallow'), []);
    assert.deepEqual(await gateFindings('6.11-label-on-edge'), []);
  });

  test('4geeks-journey: no label swallows its edge or drifts off it', async () => {
    await mount('4geeks-journey.mmd');
    assert.deepEqual(await gateFindings('6.5-label-swallow'), []);
    assert.deepEqual(await gateFindings('6.11-label-on-edge'), []);
  });

  test('state: no label swallows its edge or drifts off it', async () => {
    await mount('state.mmd');
    assert.deepEqual(await gateFindings('6.5-label-swallow'), []);
    assert.deepEqual(await gateFindings('6.11-label-on-edge'), []);
  });

  test('er: no relationship name swallows its edge or drifts off it', async () => {
    await mount('er.mmd');
    assert.deepEqual(await gateFindings('6.5-label-swallow'), []);
    assert.deepEqual(await gateFindings('6.11-label-on-edge'), []);
  });
});
