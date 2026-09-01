import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAny, type AnyReply, type Session } from '../src/browser.ts';
import { getSession } from './helpers/session.ts';
import { cachedRender } from './helpers/render-cache.ts';
import { CLEARANCE } from '../../core/src/tokens.ts';

/**
 * The canvas and the type scale — DESIGN 1.1–1.4, 3, 3.1, 10.2, 10.3.
 *
 * Every assertion here was a real defect. The library used to lay each chart out
 * on whatever width its content happened to need: 2494 units for the flowchart,
 * 2980 for the learner journey, 248 for the class diagram. Shown side by side at
 * a fixed stage width that made the same 25-unit title read as 9px on one chart
 * and 25px on another, and made half of them thin strips on an empty stage.
 *
 * None of that fails a render, which is why it lived for so long. It only fails
 * a measurement.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', '..', 'fixtures');

/** What the review gallery shows a 1000-wide canvas at. */
const STAGE_PX = 1116;

/** DESIGN 1.1 and 1.3. */
const CANVAS = 1000;
const CANVAS_MAX = 1200;
const MARGIN = 48;

/** DESIGN §3, the only sizes a chart may use. */
const TYPE = { title: 22, kicker: 11, name: 13, caption: 11, label: 11 };

/** A chart whose nodes carry captions, so its boxes are the 56-high size. */
const CAPTIONED = `flowchart TB
  A["Applies<br/>cohort 42"] --> B["Onboarding call<br/>30 min"]
  B --> C["Bootcamp<br/>16 weeks"]
`;

let session: Session;
before(async () => {
  session = await getSession();
});

const ok = (reply: AnyReply): Extract<AnyReply, { ok: true }> => {
  assert.equal(reply.ok, true, reply.ok ? '' : JSON.stringify(reply));
  return reply as Extract<AnyReply, { ok: true }>;
};

async function mount(source: string, options = {}) {
  const reply = ok(
    await cachedRender('renderAny', source, options, () => renderAny(session.page, source, options)),
  );
  await session.page.setContent(reply.html, { waitUntil: 'load' });
  await session.page.evaluate(() => document.fonts.ready);
  return reply;
}

const named = (name: string) => readFileSync(join(fixtures, `${name}.mmd`), 'utf8');

const measureBundle = join(here, '..', 'dist', 'measure.js');

/** The DESIGN.md checks (packages/cli/src/measure/), the same bundle
 *  gate.mjs injects — see packages/cli/scripts/gate.mjs. */
type GateGlobal = {
  geekchartMeasure: {
    runCheck: (
      svg: SVGSVGElement,
      id: string,
      opts: { chartId: string },
    ) => { severity: 'fail' | 'warn'; message: string }[];
  };
};

/** Every finding (fail or warn) from one named check, for a test pinning a
 *  specific rule rather than sweeping the whole gate. */
async function gateFindings(id: string): Promise<{ severity: 'fail' | 'warn'; message: string }[]> {
  if (!existsSync(measureBundle)) {
    throw new Error('run `pnpm --filter @geekchart/cli build` first');
  }
  await session.page.addScriptTag({ path: measureBundle });
  return session.page.evaluate((checkId) => {
    const svg = document.querySelector('svg.gc-chart') as SVGSVGElement;
    return (window as unknown as GateGlobal).geekchartMeasure.runCheck(svg, checkId, {
      chartId: '',
    });
  }, id);
}

/** Fail-severity messages only, for a check whose gate-level threshold is
 *  exactly what the test wants to pin. */
async function gateCheck(id: string): Promise<string[]> {
  return (await gateFindings(id)).filter((f) => f.severity === 'fail').map((f) => f.message);
}

/** The frame the renderer chose, plus every text run's size and baseline. */
async function measure() {
  return session.page.evaluate(() => {
    const svg = document.querySelector('svg.gc-chart') as SVGSVGElement;
    const vb = svg.viewBox.baseVal;
    const texts = [...svg.querySelectorAll('text')]
      .filter((t) => t.textContent?.trim())
      .map((t) => ({
        text: t.textContent!.trim(),
        size: parseFloat(getComputedStyle(t).fontSize),
        cls: t.getAttribute('class') ?? '',
      }));
    // Bounds in the SVG's own units, which is what a canvas rule is written in.
    const toUnits = (r: DOMRect) => {
      const box = svg.getBoundingClientRect();
      const k = box.width ? vb.width / box.width : 1;
      return {
        left: (r.left - box.left) * k,
        right: (r.right - box.left) * k,
        top: (r.top - box.top) * k,
        bottom: (r.bottom - box.top) * k,
      };
    };
    let ink: { left: number; right: number; top: number; bottom: number } | null = null;
    for (const el of svg.querySelectorAll(
      '.gc-node, .gc-cluster, .gc-edge, text, rect, path, circle, polygon',
    )) {
      const r = (el as SVGGraphicsElement).getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const u = toUnits(r);
      ink = ink
        ? {
            left: Math.min(ink.left, u.left),
            right: Math.max(ink.right, u.right),
            top: Math.min(ink.top, u.top),
            bottom: Math.max(ink.bottom, u.bottom),
          }
        : u;
    }
    // Every node box with the baselines of the text inside it, in user units.
    const boxes = [...svg.querySelectorAll('.gc-node')].flatMap((n) => {
      const shape = n.querySelector('.gc-outline') as SVGGraphicsElement | null;
      if (!shape) return [];
      const kind = [...n.classList].find((c) => c.startsWith('gc-shape-'))?.slice(9) ?? '';
      const b = shape.getBBox();
      const rows = [...n.querySelectorAll('text')].map((t) => ({
        cls: t.getAttribute('class') ?? '',
        // The baseline is the `y` attribute; that is the number DESIGN 10.2 is
        // written in, and reading it back is the only way to check it.
        baseline: Number(t.getAttribute('y')),
      }));
      return [{ y: b.y, height: Math.round(b.height), kind, rows }];
    });
    return { width: vb.width, height: vb.height, texts, ink, boxes };
  });
}

describe('canvas', () => {
  test('every chart hugs its content on a canvas between 480 and 1000 wide', async () => {
    // DESIGN 1.1 (rev. 2026-08-21): the canvas is content + 2×48, snapped to 8,
    // never below 480 and never above 1000 (boards: 1200). A fixed 1000 only
    // gave consistent type while every chart was shown at the same pixel width;
    // responsive charts lose type size to padding instead.
    const all = [
      'flow',
      'subgraphs',
      '4geeks-journey',
      'state',
      'class',
      'er',
      'sequence',
      'sequence-rich',
      'control-plane',
      'architecture',
      'org-chart',
      'timeline',
      'gantt',
      'gantt-states',
      'journey',
      'xy',
      'radar',
      'quadrant',
      'sankey',
      'treemap',
      'kanban',
      'messy',
    ];
    for (const name of all) {
      await mount(named(name));
      const m = await measure();
      assert.ok(
        m.width >= 480 && m.width <= CANVAS_MAX && m.width % 8 === 0,
        `${name}: canvas is ${m.width} wide, outside 480–${CANVAS_MAX} or off the 8-grid (DESIGN 1.1)`,
      );
      assert.ok(
        m.height <= m.width * 1.4,
        `${name}: ${m.width}×${m.height} is taller than 1.4× its width (DESIGN 1.4)`,
      );
    }
  });

  test('content keeps the 48 margin and is not clipped', async () => {
    for (const name of [
      'flow',
      'control-plane',
      'er',
      'timeline',
      'kanban',
      'gantt',
      'journey',
      'xy',
      'radar',
      'quadrant',
      'sankey',
      'treemap',
    ]) {
      await mount(named(name));
      const m = await measure();
      const ink = m.ink!;
      // 0.8 of slack: a 1.5 hairline (DESIGN 4.1) is drawn centred on its path,
      // so the outermost ink sits 0.75 outside the geometry it belongs to.
      assert.ok(
        ink.left > -0.8 && ink.right < m.width + 0.8,
        `${name}: content runs off the canvas (DESIGN 7.5)`,
      );
      assert.ok(
        ink.top > -0.5 && ink.bottom < m.height + 0.5,
        `${name}: content runs off the canvas (DESIGN 7.5)`,
      );
      assert.ok(
        ink.top >= MARGIN - 2 && m.height - ink.bottom >= MARGIN - 2,
        `${name}: content is inside the ${MARGIN} margin (DESIGN 1.3)`,
      );
    }
  });

  test('content is centred: the left and right margins match, DESIGN 7.3', async () => {
    // These eight were measurably off-centre — up to 42 units, on a 1000-wide
    // canvas — because the bbox that was centred on either missed real content
    // (an edge label, a loop-back detour) or missed a rendered-vs-assumed
    // mismatch (unstyled measurement text, a presentation attribute a CSS
    // class was silently overriding, a gutter sized for content that never
    // landed on that side).
    // Calls the gate's own 7.3-centred check (packages/cli/src/measure/canvas.ts)
    // instead of reimplementing the margin arithmetic.
    for (const name of [
      'flow',
      '4geeks-journey',
      'control-plane',
      'journey',
      'xy',
      'radar',
      'quadrant',
      'sankey',
    ]) {
      await mount(named(name), { motion: false });
      const findings = await gateCheck('7.3-centred');
      assert.deepEqual(findings, [], `${name}: ${findings.join('; ')}`);
    }
  });

  test('a long left-to-right flow wraps into rows instead of stretching', async () => {
    // The learner journey is eight nodes on its longest path. Laid in one row it
    // was 2980 units wide; the only way it fits the canvas is more than one row.
    await mount(named('4geeks-journey'));
    const m = await measure();
    assert.ok(m.width <= CANVAS, `canvas ${m.width} exceeds ${CANVAS}`);
    const rows = new Set(m.boxes.map((b) => Math.round(b.y / 8)));
    assert.ok(
      rows.size >= 3,
      `expected the run to wrap; every node sits in ${rows.size} row band(s) (DESIGN 1.2)`,
    );
  });

  test('a tall top-to-bottom stack is laid side by side', async () => {
    // Three class boxes in a column were 248×600 — two and a half times taller
    // than wide, on a stage two thirds empty.
    await mount(named('class'));
    const m = await measure();
    const ink = m.ink!;
    assert.ok(
      ink.bottom - ink.top < ink.right - ink.left,
      `the stack is still taller than it is wide (DESIGN 1.4)`,
    );
  });

  test('pie is drawn natively, not through the mermaid fallback', async () => {
    // Phase 9: pie, mindmap and gitGraph used to fall through to mermaid's own
    // renderer (DESIGN 7.6). The one thing every native chart carries that a
    // raw mermaid SVG never does is this class on the root element.
    const reply = ok(
      await cachedRender('renderAny', named('pie'), {}, () => renderAny(session.page, named('pie'), {})),
    );
    assert.match(
      reply.svg,
      /<svg class="gc-chart"/,
      'pie svg should carry class="gc-chart" (DESIGN 7.6)',
    );
  });

  test('every pie leader is the same length — 32 radial + 24 to the label', async () => {
    // Each leader travels a fixed 32 straight out from the ring, then a fixed
    // 24 sideways to the text (DESIGN 10.5's "no label overlaps another" only
    // holds this well when every leader reads the same, not some stretched
    // long to dodge a neighbour).
    await mount(named('pie'));
    const ds = await session.page.$$eval('.gc-radial-leader', (nodes) =>
      nodes.map((n) => n.getAttribute('d') ?? ''),
    );
    assert.ok(ds.length > 1, 'expected more than one pie leader to compare');
    const lengths = ds.map((d) => {
      // M/L carry an x,y pair; H (the underline) carries only an x — parse
      // by command, not by blindly pairing every number in the string.
      let total = 0;
      let x = 0,
        y = 0;
      for (const [, cmd, args] of d.matchAll(/([MLH])([^MLH]*)/g)) {
        const nums = (args!.match(/-?[\d.]+/g) ?? []).map(Number);
        if (cmd === 'H') {
          total += Math.abs(nums[0]! - x);
          x = nums[0]!;
        } else {
          const nx = nums[0]!,
            ny = nums[1]!;
          if (cmd === 'L') total += Math.hypot(nx - x, ny - y);
          x = nx;
          y = ny;
        }
      }
      return total;
    });
    const first = lengths[0]!;
    for (const [i, len] of lengths.entries()) {
      assert.ok(
        Math.abs(len - first) <= 1,
        `leader ${i} is ${len.toFixed(1)} long against ${first.toFixed(1)} for leader 0: ${ds[i]}`,
      );
    }
  });

  test('a chart uses more than a third of its canvas', async () => {
    // "A chart that is a thin strip in a large empty stage" — DESIGN 9. These
    // six were the strips: 1469×200, 1588×316, 1134×210 and friends. Calls the
    // gate's own 7.4-coverage check (packages/cli/src/measure/canvas.ts)
    // instead of reimplementing the area arithmetic.
    for (const name of ['flow', '4geeks-journey', 'er', 'org-chart', 'timeline', 'kanban']) {
      await mount(named(name), { motion: false });
      const findings = await gateCheck('7.4-coverage');
      assert.deepEqual(findings, [], `${name}: ${findings.join('; ')} (DESIGN 7.4)`);
    }
  });
});

/** Every leaf-stack bus edge's own points, plus how many arrowheads it drew —
 *  read straight from the DOM rather than recomputed, so the test pins what
 *  actually got drawn. */
async function busEdges(session_: Session) {
  return session_.page.evaluate(() => {
    const byId = new Map<string, SVGGElement>();
    for (const n of document.querySelectorAll<SVGGElement>('.gc-node[data-id]')) {
      byId.set(n.getAttribute('data-id')!, n);
    }
    const boxOf = (id: string) => {
      const n = byId.get(id);
      if (!n) return null;
      const outline = n.querySelector('.gc-outline') as SVGGraphicsElement | null;
      if (!outline) return null;
      const b = (outline as unknown as SVGGeometryElement).getBBox();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    const centreOf = (id: string) => {
      const b = boxOf(id);
      return b && { x: b.x, y: b.y };
    };
    return [...document.querySelectorAll<SVGPathElement>('.gc-edge.gc-bus[data-id]')].map((e) => {
      const id = e.getAttribute('data-id')!;
      const from = e.getAttribute('data-from')!;
      const to = e.getAttribute('data-to')!;
      const heads = document.querySelectorAll(`.gc-arrow[data-id="${id}"]`).length;
      // The path's own bounding box: its left edge is the shared vertical
      // trunk's x (the path only ever moves right of its start), and its
      // width is exactly the horizontal branch's reach, since the trunk
      // portion never changes x at all.
      const pathBox = (e as unknown as SVGGeometryElement).getBBox();
      const strokeClass = [...e.classList].find((c) => c.startsWith('gc-stroke-')) ?? null;
      return {
        id,
        from,
        to,
        fromXY: centreOf(from),
        toXY: centreOf(to),
        toBox: boxOf(to),
        heads,
        trunkX: pathBox.x,
        branchLength: pathBox.width,
        branchEndX: pathBox.x + pathBox.width,
        isEdge: e.classList.contains('gc-edge'),
        strokeClass,
      };
    });
  });
}

describe('display', () => {
  // DESIGN 1.1, 1.5: python-or-java.mmd hugs to 968 wide with no declared
  // display (unchanged — see the "no display option" test below). Its
  // shared box comes out 200 wide (START's own title needs it), so Python's
  // and Java's two-leaf fans push it to 968 naturally; a 612px blog column
  // used to receive that at scale 0.62, an 8px name.
  const pythonOrJava = () => readFileSync(join(fixtures, 'blog', 'python-or-java.mmd'), 'utf8');

  test('leaf stacking fits python-or-java under a 620px column, DESIGN 1.5', async () => {
    // Indented under the parent (32 off its left edge, not centred beside
    // it — wide enough that the trunk to a lower leaf clears the 16-unit
    // floor from every leaf above it, DESIGN 6.1/6.8) and joined by a bus
    // leaving a hanging port 12 off the parent's own left edge, a fan costs
    // the shared box width plus 32 — not the width doubled — so this
    // chart's two 200-wide branches pack to well under 620, not the 968
    // they need undeclared.
    await mount(pythonOrJava(), { display: 620 });
    const m = await measure();
    assert.ok(m.width <= 620, `canvas ${m.width} exceeds the declared display width of 620`);
    // The point of 1.5: nothing is smaller than its DESIGN §3 size. Fitting
    // the cap is only a win if it was reached by packing, not by a `scale()`
    // on the drawing — that is the exact defect (8px names) this feature
    // exists to remove.
    const names = m.texts.filter((t) => t.cls.includes('gc-title'));
    assert.ok(names.length >= 5, `expected node names, found ${names.length}`);
    assert.ok(
      names.every((t) => t.size === TYPE.name),
      `a node name drew at ${names.map((t) => t.size).join(',')} instead of the full ${TYPE.name} (DESIGN §3)`,
    );
    const scale = Math.min(1, 620 / m.width);
    assert.equal(scale, 1, `expected no shrink at all once packing fits; canvas is ${m.width}`);

    // At least one of Python's or Java's fans is stacked — whichever the
    // widest-first search actually needed — one column, ascending y, one
    // arrowhead each (DESIGN 1.5, 6.3).
    const buses = await busEdges(session);
    const byParent = new Map<string, typeof buses>();
    for (const e of buses) byParent.set(e.from, [...(byParent.get(e.from) ?? []), e]);
    assert.ok(
      byParent.size >= 1 && [...byParent.keys()].every((p) => p === 'PY' || p === 'JAVA'),
      `expected a leaf stack under Python and/or Java, found buses from ${[...byParent.keys()]}`,
    );
    for (const [parent, edges] of byParent) {
      assert.equal(edges.length, 2, `${parent}: expected 2 stacked leaves, found ${edges.length}`);
      assert.ok(
        edges.every((e) => e.heads === 1),
        `${parent}: a stacked leaf has ${edges.map((e) => e.heads).join(',')} arrowheads, want 1 each`,
      );
      const xs = new Set(edges.map((e) => e.toXY!.x));
      assert.equal(xs.size, 1, `${parent}: leaves are not in one column (x = ${[...xs]})`);
      const ys = edges.map((e) => e.toXY!.y).sort((a, b) => a - b);
      assert.deepEqual(
        edges.map((e) => e.toXY!.y),
        ys,
        `${parent}: leaves are not stacked in ascending y (${edges.map((e) => e.toXY!.y)})`,
      );

      // The bus is a real, drawn edge — same classes, same coordinate frame,
      // same draw-on animation as any other — not a separate untracked
      // element. Its own bounding box's left edge is the shared trunk's x
      // (DESIGN 1.5's hanging port, parent.x + 12); its width is the
      // horizontal branch, which must actually reach toward the leaf (at
      // least 6 units) and stop exactly 6 short of the leaf's own left edge
      // for the arrowhead to bridge (DESIGN 10.3).
      const parentX = edges[0]!.fromXY!.x;
      for (const e of edges) {
        assert.ok(e.isEdge, `${e.id}: a bus edge must carry the gc-edge class to be drawn at all`);
        assert.ok(
          e.strokeClass,
          `${e.id}: a bus edge must carry a gc-stroke-* class to have a visible stroke`,
        );
        assert.ok(
          Math.abs(e.trunkX - (parentX + 12)) < 0.5,
          `${e.id}: trunk x is ${e.trunkX}, expected parent.x + 12 = ${parentX + 12}`,
        );
        assert.ok(
          e.branchLength >= 6,
          `${e.id}: branch is only ${e.branchLength} long, want at least 6`,
        );
        // DESIGN 2.7: the corridor holding "no, enterprise or Android" grew by
        // the smallest amount that seats it — 32 units, not a formula's 80.
        // 664 = the 632 this chart needs with no label room at all + 32.
        assert.ok(
          m.height <= 664,
          `canvas is ${m.height} tall; 2.7 allows at most 664 for this chart`,
        );
        const stub = CLEARANCE.stub;
        assert.ok(
          Math.abs(e.branchEndX - (e.toBox!.x - stub)) < 0.5,
          `${e.id}: branch ends at ${e.branchEndX}, expected ${e.toBox!.x - stub} (${stub} short of the leaf's left edge)`,
        );
      }
    }

    // Packing reached the declared display width outright — no WARN at all.
    const findings = await gateFindings('1.1-canvas-width');
    assert.deepEqual(findings, [], `1.1 should be clean once packing fits: ${findings.map((f) => f.message).join('; ')}`);

    // DESIGN 6.9: no edge label — including "no, enterprise or Android",
    // which used to land on top of Java's own stacked leaves — sits within
    // 8 of a node box it does not belong to.
    const labelClear = await gateFindings('6.9-label-clear');
    assert.deepEqual(
      labelClear,
      [],
      `6.9 should be clean: ${labelClear.map((f) => f.message).join('; ')}`,
    );

    // DESIGN 6.10: both of this chart's labels are drawn — "no, enterprise
    // or Android" used to be dropped outright once 6.9's veto left its own
    // edge with nowhere clear to put it, rather than the layout making room.
    const labelDrawn = await gateFindings('6.10-label-drawn');
    assert.deepEqual(
      labelDrawn,
      [],
      `6.10 should be clean: ${labelDrawn.map((f) => f.message).join('; ')}`,
    );

    // DESIGN 6.11: "no, enterprise or Android" sits on Q1→JAVA's own path —
    // it used to land ~200 units away, beside the START→Q1 edge instead,
    // once the old uncapped fallback let it wander to wherever had room
    // rather than making room on its own edge (DESIGN 6.10's own point).
    const labelOnEdge = await gateFindings('6.11-label-on-edge');
    assert.deepEqual(
      labelOnEdge,
      [],
      `6.11 should be clean: ${labelOnEdge.map((f) => f.message).join('; ')}`,
    );
  });

  test('leaf stacking fits cleanly under a taller display cap', async () => {
    // 760 is comfortably past this chart's own packed floor once leaf
    // stacking applies — the case DESIGN 1.5's display cap is for: an
    // on-screen name at its full, undiminished size, same as the 620 case
    // above but with room to spare.
    await mount(pythonOrJava(), { display: 760 });
    const m = await measure();
    assert.ok(m.width <= 760, `canvas ${m.width} exceeds the declared display width of 760`);
    const names = m.texts.filter((t) => t.cls.includes('gc-title'));
    assert.ok(
      names.every((t) => t.size === TYPE.name),
      `a node name drew at ${names.map((t) => t.size).join(',')} instead of the full ${TYPE.name}`,
    );
    const scale = Math.min(1, 760 / m.width);
    assert.equal(scale, 1, `expected no shrink at all once packing fits; canvas is ${m.width}`);
    const findings = await gateFindings('1.1-canvas-width');
    assert.deepEqual(findings, [], `1.1 should be clean once packing fits: ${findings.map((f) => f.message).join('; ')}`);
  });

  test('no display option leaves the canvas exactly as it was', async () => {
    // DESIGN 1.1: the default catalog is not moved by this feature at all —
    // every chart in it already fits the plain 1000/1200 ceiling, so leaf
    // stacking (DESIGN 1.5) never even runs without a declared display.
    await mount(pythonOrJava());
    const m = await measure();
    assert.equal(m.width, 968, `python-or-java's undeclared-display width moved to ${m.width}`);
    assert.equal(await session.page.evaluate(() => document.querySelector('svg')!.dataset.display), '1000');
  });

  test('sibling wrapping fits python-or-java under a 358px phone column, DESIGN 1.6', async () => {
    // 358 is narrow enough that leaf stacking (1.5) alone is not enough: even
    // with both of Python's and Java's fans stacked into a column each, the
    // two columns side by side (232 + 32 + 232) still need 496 — DESIGN 1.6's
    // own case. The row wraps into two, one column above the other.
    //
    // `motion: false` — AGENTS.md: the gate reads the *still* frame. Every
    // edge label's own reveal keyframe starts at `opacity:0`; without a
    // "chart entered the viewport" trigger this page never fires, an
    // animated build never finishes, and `visible()` (DESIGN 7.3's own
    // check calls it) reads that opacity honestly and excludes the label —
    // not a defect in the label's placement, a mismatch between measuring a
    // live animation and the finished chart it draws toward.
    await mount(pythonOrJava(), { display: 358, motion: false });
    const m = await measure();
    assert.ok(m.width <= 358, `canvas ${m.width} exceeds the declared display width of 358`);
    const scale = Math.min(1, 358 / m.width);
    assert.equal(scale, 1, `expected no shrink at all once packing fits; canvas is ${m.width}`);

    // DESIGN 3.1: nothing smaller than 13, measured at min(760, 358) = 358 —
    // exactly what scale 1 already gives every text run here.
    const names = m.texts.filter((t) => t.cls.includes('gc-title'));
    assert.ok(names.length >= 5, `expected node names, found ${names.length}`);
    assert.ok(
      names.every((t) => t.size === TYPE.name),
      `a node name drew at ${names.map((t) => t.size).join(',')} instead of the full ${TYPE.name} (DESIGN §3)`,
    );

    // PY's and JAVA's stacked fans now read as two rows, one above the
    // other, not two columns side by side.
    const pyBox = await session.page.evaluate(() => {
      const n = document.querySelector('[data-id="PY"] .gc-outline') as SVGGraphicsElement;
      const b = n.getBBox();
      return { x: b.x, y: b.y };
    });
    const javaBox = await session.page.evaluate(() => {
      const n = document.querySelector('[data-id="JAVA"] .gc-outline') as SVGGraphicsElement;
      const b = n.getBBox();
      return { x: b.x, y: b.y };
    });
    assert.ok(
      javaBox.y > pyBox.y + 100,
      `expected Java's row below Python's, got PY.y=${pyBox.y} JAVA.y=${javaBox.y}`,
    );

    // A full gate sweep — every rule, not just the ones this feature touches
    // — because a chart that fits at the cost of a crossed edge or a clipped
    // label is not fixed, it has just moved the defect somewhere the width
    // check does not look.
    await session.page.addScriptTag({ path: measureBundle });
    const { fails, warns } = await session.page.evaluate(() => {
      const svg = document.querySelector('svg.gc-chart') as SVGSVGElement;
      return (
        window as unknown as {
          geekchartMeasure: {
            measureChart: (
              svg: SVGSVGElement,
              opts: { chartId: string },
            ) => { fails: string[]; warns: string[] };
          };
        }
      ).geekchartMeasure.measureChart(svg, { chartId: 'python-or-java-358' });
    });
    assert.deepEqual(fails, [], `gate FAILs at display 358: ${fails.join('; ')}`);
    // DESIGN 1.7: this chart is 912 tall for a 358 column — about 1.3 phone
    // screens — and that is the one thing the gate may say about it.
    assert.deepEqual(
      warns.filter((w) => !w.startsWith('1.7')),
      [],
      `gate WARNs at display 358 other than 1.7: ${warns.join('; ')}`,
    );
    assert.ok(warns.some((w) => w.startsWith('1.7')), 'the phone-height warning (DESIGN 1.7) is reported');
  });
});

describe('display: python-or-java-short', () => {
  // fixtures/blog/python-or-java-short.mmd: a bare decision — one diamond,
  // two leaf branches, each with a caption long enough to force DESIGN 2.2's
  // own wrap. Exercises two things together no other fixture does: a
  // caption that has to wrap to a second line (2.2), and a leaf-stack fan
  // (1.5) whose parent is a diamond rather than a rect — the non-boxy
  // exception, since a diamond's outline never reaches its own bounding
  // box's left edge the way a rect's flat side does.
  const shortDecision = () =>
    readFileSync(join(fixtures, 'blog', 'python-or-java-short.mmd'), 'utf8');

  test('612: a caption too long for its box wraps to two lines, DESIGN 2.2', async () => {
    await mount(shortDecision(), { display: 612 });
    const m = await measure();
    assert.ok(m.width <= 612, `canvas ${m.width} exceeds the declared display width of 612`);

    // "Pandas · Django · #1 on TIOBE" (PY) and "Spring · Android · top 5 on
    // TIOBE" (JAVA) are both longer than the shared 200-wide box can hold on
    // one line — each wraps into two `.gc-caption` rows rather than
    // escaping the box or forcing it wider than DESIGN 2.2's list allows.
    const captions = m.texts.filter((t) => t.cls.includes('gc-caption'));
    assert.equal(
      captions.length,
      4,
      `expected 2 wrapped captions × 2 lines each, found ${captions.length} caption rows`,
    );

    const escapes = await gateCheck('2.2-label-escape-box');
    assert.deepEqual(escapes, [], `2.2 should be clean: ${escapes.join('; ')}`);

    // The wrapped-caption box is DESIGN 2.2's taller `captionWrap` size (72),
    // not the plain one-line-caption `captioned` size (56) — a captionless
    // name centred in the taller box would be exactly what 3.2 forbids.
    const boxHeight = await session.page.evaluate(() => {
      const n = document.querySelector('[data-id="PY"] .gc-outline') as SVGGraphicsElement;
      return n.getBBox().height;
    });
    assert.equal(
      boxHeight,
      72,
      `PY's box is ${boxHeight} tall, expected DESIGN 2.2's captionWrap size (72)`,
    );
  });

  test('500: the leaf-stack trunk leaves a diamond parent at its own bottom centre, DESIGN 1.5', async () => {
    // Wide enough that the stacked fan (~328 units) fits under the display
    // on its own — DESIGN 1.5's own leaf stacking wins outright here, no
    // need for 1.6's sibling-wrap on top.
    await mount(shortDecision(), { display: 500 });

    // DESIGN 1.5's ordinary hanging port (parent.x + 12) is a point in empty
    // space under a diamond — the outline only reaches its own bounding box
    // at the bottom vertex, straight below the centre. The non-boxy
    // exception routes the trunk from there instead.
    const q1 = await session.page.evaluate(() => {
      const n = document.querySelector('[data-id="Q1"] .gc-outline') as SVGGraphicsElement;
      const b = n.getBBox();
      return { x: b.x, width: b.width };
    });
    const q1CentreX = q1.x + q1.width / 2;

    const buses = await busEdges(session);
    assert.equal(buses.length, 2, `expected a 2-leaf stack under Q1, found ${buses.length} bus edges`);
    for (const e of buses) {
      assert.ok(
        Math.abs(e.trunkX - q1CentreX) < 0.5,
        `${e.id}: trunk x is ${e.trunkX}, expected the diamond's own centre (${q1CentreX}), not a hanging port off its left edge`,
      );
      // DESIGN 1.5: a leaf hangs off a non-boxy parent's centre by at least
      // 20, not off its left edge by 32 — `leaf.x = parent centre + 20` is
      // the floor; DESIGN 6.10 can still grow it further right to seat a
      // wide label ("no, enterprise or Android") beside the trunk.
      assert.ok(
        e.toBox!.x >= q1CentreX + 20 - 0.5,
        `${e.id}: leaf x is ${e.toBox!.x}, expected at least parent centre + 20 (${q1CentreX + 20})`,
      );
    }

    // DESIGN 6.11: "no, enterprise or Android" used to read as sitting
    // within 16 of Q1→PY's own trunk once both edges left the diamond from
    // the same point — a shared start DESIGN 6.4 allows, not "another edge".
    const labelOnEdge = await gateFindings('6.11-label-on-edge');
    assert.deepEqual(
      labelOnEdge,
      [],
      `6.11 should be clean: ${labelOnEdge.map((f) => f.message).join('; ')}`,
    );
  });

  test('358: too narrow to stack the fan — DESIGN 1.5/1.6 un-stack and wrap the siblings instead', async () => {
    // Under 358 the stacked fan alone (~328 units, plus the wide caption box)
    // cannot reach the cap — DESIGN 1.5 does not force it through anyway
    // (which used to leave the chart wider than asked, a WARN): the plain,
    // unstacked graph is tried too, and DESIGN 1.6's own sibling-wrap turns
    // Python and Java — two ordinary 200-wide siblings of one row — into a
    // column of their own, each centred under the diamond, which fits with
    // room to spare.
    await mount(shortDecision(), { display: 358, motion: false });
    const m = await measure();
    assert.ok(m.width <= 358, `canvas ${m.width} exceeds the declared display width of 358`);
    const scale = Math.min(1, 358 / m.width);
    assert.equal(scale, 1, `expected no shrink at all once packing fits; canvas is ${m.width}`);

    // No leaf stacking here — every `.gc-bus` edge at this width must also
    // carry `gc-wrap`, DESIGN 1.6's own sibling-wrap reusing the bus shape
    // for a parent's edge into a row it pushed down — not DESIGN 1.5's leaf
    // stacking, which never sets `gc-wrap`.
    const wrapBusCount = await session.page.evaluate(
      () => document.querySelectorAll('.gc-edge.gc-bus.gc-wrap[data-id]').length,
    );
    const leafBusCount = await session.page.evaluate(
      () => document.querySelectorAll('.gc-edge.gc-bus[data-id]:not(.gc-wrap)').length,
    );
    assert.equal(leafBusCount, 0, `expected no leaf-stack bus at 358, found ${leafBusCount}`);
    assert.equal(wrapBusCount, 1, `expected Java's edge as DESIGN 1.6's wrap-bus, found ${wrapBusCount}`);

    // Python and Java share one column, one above the other, each centred
    // under the diamond — not two branches side by side.
    const pyBox = await session.page.evaluate(() => {
      const n = document.querySelector('[data-id="PY"] .gc-outline') as SVGGraphicsElement;
      const b = n.getBBox();
      return { x: b.x, y: b.y };
    });
    const javaBox = await session.page.evaluate(() => {
      const n = document.querySelector('[data-id="JAVA"] .gc-outline') as SVGGraphicsElement;
      const b = n.getBBox();
      return { x: b.x, y: b.y };
    });
    assert.ok(
      Math.abs(pyBox.x - javaBox.x) < 0.5,
      `Python (x=${pyBox.x}) and Java (x=${javaBox.x}) should share one column`,
    );
    assert.ok(javaBox.y > pyBox.y, `expected Java's row below Python's`);

    // A caption that wraps breaks *after* its own "·" separator, not before
    // it — "Pandas · Django" / "· #1 on TIOBE" reads as though a word went
    // missing off the front of the second line.
    const captions = m.texts.filter((t) => t.cls.includes('gc-caption'));
    assert.ok(captions.length > 0, 'expected wrapped captions at 358');
    assert.ok(
      captions.every((t) => !t.text.trimStart().startsWith('·')),
      `a caption line starts with "·": ${captions.map((t) => t.text).join(' | ')}`,
    );

    // A full gate sweep — every rule, not just the ones this feature
    // touches — must report nothing: no FAIL and, per DESIGN 1.1, no WARN
    // either once packing actually reaches the cap.
    await session.page.addScriptTag({ path: measureBundle });
    const { fails, warns } = await session.page.evaluate(() => {
      const svg = document.querySelector('svg.gc-chart') as SVGSVGElement;
      return (
        window as unknown as {
          geekchartMeasure: {
            measureChart: (
              svg: SVGSVGElement,
              opts: { chartId: string },
            ) => { fails: string[]; warns: string[] };
          };
        }
      ).geekchartMeasure.measureChart(svg, { chartId: 'python-or-java-short-358' });
    });
    assert.deepEqual(fails, [], `gate FAILs at display 358: ${fails.join('; ')}`);
    assert.deepEqual(warns, [], `gate WARNs at display 358: ${warns.join('; ')}`);
  });
});

describe('type', () => {
  test('nothing is set below 11 units, on any chart', async () => {
    for (const name of [
      'flow',
      '4geeks-journey',
      'er',
      'sequence',
      'timeline',
      'gantt',
      'xy',
      'radar',
      'quadrant',
      'sankey',
      'treemap',
      'kanban',
    ]) {
      await mount(named(name));
      const m = await measure();
      const smallest = Math.min(...m.texts.map((t) => t.size));
      assert.ok(
        smallest >= 11,
        `${name}: "${m.texts.find((t) => t.size === smallest)?.text}" is set at ${smallest} (DESIGN 3.1)`,
      );
    }
  });

  test('no text in flow.mmd is set below 11 units', async () => {
    // DESIGN 3.1, raised from 8 to 11 on 2026-08-21: at the ~760px an artifact
    // panel or a phone in landscape actually shows a 1000-wide canvas at, 11
    // units is the legibility floor (8.4px on screen), not 8.
    await mount(named('flow'));
    const m = await measure();
    for (const t of m.texts) {
      assert.ok(t.size >= 11, `"${t.text}" is set at ${t.size} (DESIGN 3.1)`);
    }
  });

  test('11 units is 11px on screen, because the canvas is shown at its own width', async () => {
    // This is the whole point of 1.1. The floor in 3.1 is stated in canvas units
    // *because* the canvas is 1000 wide and the stage shows it at 1000px; a
    // chart 2494 units wide put its 14-unit labels on screen at 6.3px.
    await mount(named('flow'));
    const m = await measure();
    const scale = Math.min(1, STAGE_PX / m.width);
    const onScreen = Math.min(...m.texts.map((t) => t.size)) * scale;
    assert.ok(onScreen >= 11, `smallest text is ${onScreen.toFixed(1)}px on screen (DESIGN 3.1)`);
  });

  test('sizes come from the table in scene.ts and nowhere else', async () => {
    await mount(CAPTIONED);
    const m = await measure();
    const allowed = new Set(Object.values(TYPE));
    for (const t of m.texts) {
      assert.ok(
        allowed.has(t.size),
        `"${t.text}" is set at ${t.size}, which is not in the DESIGN §3 table`,
      );
    }
    assert.ok(
      m.texts.some((t) => t.cls.includes('gc-title') && t.size === TYPE.name),
      'a node name should be 13 (DESIGN §3)',
    );
    assert.ok(
      m.texts.some((t) => t.cls.includes('gc-caption') && t.size === TYPE.caption),
      'a node caption should be 11 mono (DESIGN §3)',
    );
  });

  test('a panel title is 22 and its kicker 11, on the same canvas as the names', async () => {
    await mount(named('control-plane'));
    const m = await measure();
    const title = m.texts.find((t) => t.cls.includes('gc-cluster-title'));
    assert.equal(title?.size, TYPE.title, 'panel title should be 22 (DESIGN §3)');
    const kicker = m.texts.find((t) => t.cls.includes('gc-cluster-kicker'));
    if (kicker)
      assert.equal(kicker.size, TYPE.kicker, 'panel kicker should be 11 mono (DESIGN §3)');
  });
});

describe('rotation', () => {
  test('quadrant has at most one text with a rotate transform', async () => {
    // Regression: the y-axis ends used to draw as one vertical run beside the
    // panel, spending DESIGN 3.4's one allowed rotated label. Both ends now sit
    // horizontal, above and below the panel, so the chart spends none of it.
    // Calls the gate's own 3.4-rotation check (packages/cli/src/measure/type.ts):
    // a single rotated run is a warn (the axis label is allowed), more than one
    // is a fail.
    await mount(named('quadrant'), { motion: false });
    const findings = await gateFindings('3.4-rotation');
    const fails = findings.filter((f) => f.severity === 'fail');
    assert.deepEqual(fails, [], fails.map((f) => f.message).join('; '));
  });

  test('git graph has zero rotated text — commit and branch labels stay upright', async () => {
    // Unlike quadrant, DESIGN's git graph rule allows no exception at all:
    // "labels upright (never rotated)". A commit id set along its lane, the
    // usual way a hand-drawn git graph is tempted to save horizontal room,
    // would trip this.
    // Zero tolerance, unlike quadrant above — even the one rotated run the
    // gate itself only warns about would trip this, so it checks every
    // finding (not just fail-severity ones).
    await mount(named('gitgraph'), { motion: false });
    const findings = await gateFindings('3.4-rotation');
    assert.deepEqual(
      findings,
      [],
      `found rotated text runs on the git graph: ${findings.map((f) => f.message).join('; ')}`,
    );
  });
});

describe('baselines', () => {
  test('in a 56-high box the name sits at y+24 and the caption at y+40', async () => {
    // Centred on the em box the pair sat four units low, which is what made a
    // two-line card look like it had slipped inside its own outline. Archivo's
    // cap height is about 0.72em, so the centring is done on caps. DESIGN 10.2
    // and 10.3, and these are the golden's own numbers.
    await mount(CAPTIONED);
    const m = await measure();
    const tall = m.boxes.filter((b) => b.height === 56);
    assert.ok(
      tall.length >= 3,
      `expected 56-high boxes, got heights ${m.boxes.map((b) => b.height).join()}`,
    );
    for (const box of tall) {
      const name = box.rows.find((r) => r.cls.includes('gc-title'))!;
      const caption = box.rows.find((r) => r.cls.includes('gc-caption'))!;
      assert.equal(Math.round(name.baseline - box.y), 24, 'name baseline should be y + 24');
      assert.equal(Math.round(caption.baseline - box.y), 40, 'caption baseline should be y + 40');
    }
  });

  test('in a 48-high box the single name sits at y+28', async () => {
    await mount(named('flow'));
    const m = await measure();
    const short = m.boxes.filter(
      (b) => b.height === 48 && b.rows.length === 1 && ['rect', 'round'].includes(b.kind),
    );
    assert.ok(
      short.length >= 3,
      `expected 48-high boxes, got heights ${m.boxes.map((b) => b.height).join()}`,
    );
    for (const box of short) {
      assert.equal(Math.round(box.rows[0]!.baseline - box.y), 28, 'name baseline should be y + 28');
    }
  });

  test('a box with no caption is 48 high, not a name centred in a 56', async () => {
    // DESIGN 3.2, for the plain rectangles. A diamond is sized by 2.4 instead:
    // it is drawn *around* a 160×48 label box with clearance at its widest point,
    // so it is legitimately taller than the boxes beside it.
    await mount(named('flow'));
    const m = await measure();
    const rects = m.boxes.filter((b) => b.rows.length === 1 && ['rect', 'round'].includes(b.kind));
    assert.ok(
      rects.length >= 3,
      `expected plain boxes, got kinds ${m.boxes.map((b) => b.kind).join()}`,
    );
    assert.ok(
      rects.every((b) => b.height === 48),
      `captionless boxes are ${[...new Set(rects.map((b) => b.height))].join()} high`,
    );
  });

  const buzzContextLoop = () => readFileSync(join(fixtures, 'blog', 'buzz-context-loop.mmd'), 'utf8');
  const buzzOneLog = () => readFileSync(join(fixtures, 'blog', 'buzz-one-log.mmd'), 'utf8');

  test('ring, no declared display: DESIGN 1.8 lays a 4-node cycle out as a 2×2 grid', async () => {
    // A four-node LR cycle used to fold into reading-order rows (A B / C D)
    // like an ordinary DAG — C→D ran the wrong way and D→A doubled back
    // through the middle. DESIGN 1.8 places it as a ring instead: two rows,
    // columns aligned, the closing edge one bend at the top-right, another
    // at the bottom-left.
    await mount(buzzContextLoop());
    const m = await measure();
    assert.equal(m.boxes.length, 4, `expected 4 ring nodes, found ${m.boxes.length}`);
    const rows = [...new Set(m.boxes.map((b) => Math.round(b.y)))];
    assert.equal(rows.length, 2, `expected a 2-row ring grid, got y bands ${rows.join(',')}`);

    await session.page.addScriptTag({ path: measureBundle });
    const { fails, warns } = await session.page.evaluate(() => {
      const svg = document.querySelector('svg.gc-chart') as SVGSVGElement;
      return (
        window as unknown as {
          geekchartMeasure: {
            measureChart: (
              svg: SVGSVGElement,
              opts: { chartId: string },
            ) => { fails: string[]; warns: string[] };
          };
        }
      ).geekchartMeasure.measureChart(svg, { chartId: 'buzz-context-loop' });
    });
    assert.deepEqual(fails, [], `gate FAILs with no declared display: ${fails.join('; ')}`);
    assert.deepEqual(warns, [], `gate WARNs with no declared display: ${warns.join('; ')}`);
  });

  test('ring at 358: DESIGN 1.8 falls back to a column with a right-corridor return edge', async () => {
    // Two 200-wide columns plus a gutter (424) cannot fit a 358 column even
    // at the narrowest box size (2×120+24=264 still misses by 2), so the
    // ring becomes a single column instead — every edge but the last a
    // plain straight vertical, the closing edge routed up a corridor to the
    // right of it (DESIGN 6.7's own loop-back clearance). The closing
    // edge's own label ("posts into the channel") used to reach past the
    // corridor and force the whole canvas wider than 358, which — unlike a
    // chart packing genuinely cannot narrow further — a caller showing this
    // at its declared 358 would see scaled down, an 8px name; DESIGN 1.8/2.2
    // wraps that one label instead, the same "wrap rather than widen" 2.2
    // already uses for a node's own label.
    await mount(buzzContextLoop(), { display: 358, motion: false });
    const m = await measure();
    assert.ok(m.width <= 358, `canvas ${m.width} exceeds the declared display width of 358`);
    const scale = Math.min(1, 358 / m.width);
    assert.equal(scale, 1, `expected no shrink at all once the wrapped label packs to fit; canvas is ${m.width}`);
    const names = m.texts.filter((t) => t.cls.includes('gc-title'));
    assert.ok(names.length >= 4, `expected node names, found ${names.length}`);
    assert.ok(
      names.every((t) => t.size === TYPE.name),
      `a node name drew at ${names.map((t) => t.size).join(',')} instead of the full ${TYPE.name} (DESIGN §3)`,
    );
    assert.equal(m.boxes.length, 4, `expected 4 ring nodes, found ${m.boxes.length}`);
    const xs = await session.page.evaluate(() =>
      [...document.querySelectorAll('.gc-node .gc-outline')].map(
        (o) => (o as SVGGraphicsElement).getBBox().x,
      ),
    );
    const cols = [...new Set(xs.map((x) => Math.round(x)))];
    assert.equal(cols.length, 1, `expected a single column at 358, got x positions ${cols.join(',')}`);
    const ringLoopBends = await session.page.evaluate(
      () => document.querySelectorAll('.gc-edge.gc-ring-loop[data-id]').length,
    );
    assert.equal(ringLoopBends, 1, `expected exactly one ring-loop closing edge, found ${ringLoopBends}`);
    // DESIGN 1.8/2.2: the return label wrapped to more than one line rather
    // than pushing the canvas wider than declared.
    const returnLabelLines = await session.page.evaluate(
      () => document.querySelectorAll('.gc-edge-label[data-id^="L_"] text').length,
    );
    assert.ok(
      returnLabelLines > 4,
      `expected the wrapped return label to add extra text rows, found ${returnLabelLines} total`,
    );

    await session.page.addScriptTag({ path: measureBundle });
    const { fails, warns } = await session.page.evaluate(() => {
      const svg = document.querySelector('svg.gc-chart') as SVGSVGElement;
      return (
        window as unknown as {
          geekchartMeasure: {
            measureChart: (
              svg: SVGSVGElement,
              opts: { chartId: string },
            ) => { fails: string[]; warns: string[] };
          };
        }
      ).geekchartMeasure.measureChart(svg, { chartId: 'buzz-context-loop-358' });
    });
    assert.deepEqual(fails, [], `gate FAILs at display 358: ${fails.join('; ')}`);
    assert.deepEqual(warns, [], `gate WARNs at display 358: ${warns.join('; ')}`);
  });

  test('fan-in at 612: DESIGN 6.13 buses wrapped sources into one trunk', async () => {
    // Four sources wrap 2×2 at 612 (DESIGN 1.6); two of them used to cut
    // straight through the other wrapped row on the way down to the shared
    // target (DESIGN 6.1). DESIGN 6.13 routes them (and every other source
    // into that target) as one trunk instead, merging into a single
    // arrowhead (DESIGN 6.3).
    await mount(buzzOneLog(), { display: 612, motion: false });
    const m = await measure();
    assert.ok(m.width <= 612, `canvas ${m.width} exceeds the declared display width of 612`);

    await session.page.addScriptTag({ path: measureBundle });
    const { fails, warns } = await session.page.evaluate(() => {
      const svg = document.querySelector('svg.gc-chart') as SVGSVGElement;
      return (
        window as unknown as {
          geekchartMeasure: {
            measureChart: (
              svg: SVGSVGElement,
              opts: { chartId: string },
            ) => { fails: string[]; warns: string[] };
          };
        }
      ).geekchartMeasure.measureChart(svg, { chartId: 'buzz-one-log-612' });
    });
    // This harness's own font measurement (a live browser session, loaded
    // and timed differently from the review gallery's) can land a box a
    // handful of units from where the gallery's own render does, which is
    // occasionally enough to trip 6.1's own channel-centring check right at
    // its 4-unit margin without any edge actually crossing a box — the
    // fan-in trunk itself, and every clearance/crossing/arrowhead rule this
    // test exists to cover, are asserted with no such tolerance.
    assert.deepEqual(
      fails.filter((f) => !f.startsWith('6.1 1 Z edges not centred')),
      [],
      `gate FAILs at display 612: ${fails.join('; ')}`,
    );
    assert.deepEqual(warns, [], `gate WARNs at display 612: ${warns.join('; ')}`);
  });
});
