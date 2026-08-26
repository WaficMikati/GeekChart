import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSession, renderAny, type AnyReply, type Session } from '../src/browser.ts';

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
  session = await openSession();
});
after(async () => {
  await session?.close();
});

const ok = (reply: AnyReply): Extract<AnyReply, { ok: true }> => {
  assert.equal(reply.ok, true, reply.ok ? '' : JSON.stringify(reply));
  return reply as Extract<AnyReply, { ok: true }>;
};

async function mount(source: string, options = {}) {
  const reply = ok(await renderAny(session.page, source, options));
  await session.page.setContent(reply.html, { waitUntil: 'load' });
  await session.page.evaluate(() => document.fonts.ready);
  return reply;
}

const named = (name: string) => readFileSync(join(fixtures, `${name}.mmd`), 'utf8');

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
      // Half a unit of slack: a 1.25 hairline is drawn centred on its path, so
      // the outermost ink sits a fraction outside the geometry it belongs to.
      assert.ok(
        ink.left > -0.5 && ink.right < m.width + 0.5,
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
      await mount(named(name));
      const m = await measure();
      const ink = m.ink!;
      const leftMargin = ink.left;
      const rightMargin = m.width - ink.right;
      assert.ok(
        Math.abs(leftMargin - rightMargin) <= 8,
        `${name}: left margin ${leftMargin.toFixed(1)} vs right margin ${rightMargin.toFixed(1)} (DESIGN 7.3)`,
      );
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
    const reply = ok(await renderAny(session.page, named('pie'), {}));
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
    // six were the strips: 1469×200, 1588×316, 1134×210 and friends.
    for (const name of ['flow', '4geeks-journey', 'er', 'org-chart', 'timeline', 'kanban']) {
      await mount(named(name));
      const m = await measure();
      const ink = m.ink!;
      const covered = ((ink.right - ink.left) * (ink.bottom - ink.top)) / (m.width * m.height);
      assert.ok(
        covered > 0.35,
        `${name}: content covers ${Math.round(covered * 100)}% of the canvas (DESIGN 7.4)`,
      );
    }
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
    await mount(named('quadrant'));
    const rotated = await session.page.evaluate(() => {
      const svg = document.querySelector('svg.gc-chart') as SVGSVGElement;
      let n = 0;
      for (const t of svg.querySelectorAll('text')) {
        const tr =
          (t.getAttribute('transform') ?? '') + (t.parentElement?.getAttribute('transform') ?? '');
        if (/rotate\(\s*-?(?!0[\s)])\d/.test(tr)) n++;
      }
      return n;
    });
    assert.ok(rotated <= 1, `found ${rotated} rotated text runs (DESIGN 3.4)`);
  });

  test('git graph has zero rotated text — commit and branch labels stay upright', async () => {
    // Unlike quadrant, DESIGN's git graph rule allows no exception at all:
    // "labels upright (never rotated)". A commit id set along its lane, the
    // usual way a hand-drawn git graph is tempted to save horizontal room,
    // would trip this.
    await mount(named('gitgraph'));
    const rotated = await session.page.evaluate(() => {
      const svg = document.querySelector('svg.gc-chart') as SVGSVGElement;
      let n = 0;
      for (const t of svg.querySelectorAll('text')) {
        const tr =
          (t.getAttribute('transform') ?? '') + (t.parentElement?.getAttribute('transform') ?? '');
        if (/rotate\(\s*-?(?!0[\s)])\d/.test(tr)) n++;
      }
      return n;
    });
    assert.equal(rotated, 0, `found ${rotated} rotated text runs on the git graph (DESIGN 3.4)`);
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
});
