import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openSession,
  render,
  renderAny,
  type RenderRequest,
  type Session,
} from '../src/browser.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', '..', 'fixtures');
const names = readdirSync(fixtures)
  .filter((f) => f.endsWith('.mmd'))
  .sort();

const baseRequest: RenderRequest = {
  theme: 'light',
  style: 'blueprint',
  animation: { preset: 'cascade', stagger: 0.34, duration: 0.62, delay: 0.15 },
  width: 900,
  panel: true,
  interactive: false,
};

let session: Session;
before(async () => {
  session = await openSession();
});
after(async () => {
  await session?.close();
});

const source = (name: string) => readFileSync(join(fixtures, name), 'utf8');

describe('every fixture renders', () => {
  for (const name of names) {
    for (const style of ['blueprint', 'surface', 'press'] as const) {
      test(`${name} · ${style}`, async () => {
        const reply = await render(session.page, source(name), { ...baseRequest, style });
        assert.equal(reply.ok, true, reply.ok ? '' : `${name}: ${JSON.stringify(reply)}`);
        if (!reply.ok) return;
        assert.ok(reply.svg.includes('<svg'), 'produced an svg');
        assert.ok(reply.parts > 0, 'found something to animate');
        assert.ok(reply.runtime > 0, 'animation has a duration');
      });
    }
  }
});

describe('mermaid contract', () => {
  // If mermaid renames a class we key off, these break loudly at upgrade time
  // instead of silently producing a chart that never animates.
  const expected: Record<string, number> = {
    'flow.mmd': 12,
    'subgraphs.mmd': 12,
    'sequence.mmd': 6,
    'state.mmd': 8,
    'class.mmd': 4,
    'er.mmd': 4,
  };
  for (const [name, minimum] of Object.entries(expected)) {
    test(`${name} still exposes at least ${minimum} animatable parts`, async () => {
      const reply = await render(session.page, source(name), baseRequest);
      assert.equal(reply.ok, true);
      if (!reply.ok) return;
      assert.ok(
        reply.parts >= minimum,
        `${name}: found ${reply.parts}, expected at least ${minimum}. ` +
          'Mermaid may have renamed the classes analyze.ts looks for.',
      );
    });
  }
});

describe('the animation is actually wired up', () => {
  test('edges carry a real dash pattern', async () => {
    // Regression: mermaid's own `.edge-pattern-solid { stroke-dasharray: 0 }`
    // used to win the cascade, leaving every edge fully drawn at frame one.
    const reply = await render(session.page, source('flow.mmd'), baseRequest);
    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    await session.page.setContent(reply.html, { waitUntil: 'load' });
    const dashes = await session.page.evaluate(() =>
      Array.from(document.querySelectorAll('[class~="gc-edge"]')).map(
        (el) => getComputedStyle(el).strokeDasharray,
      ),
    );
    assert.ok(dashes.length > 0, 'found drawable edges');
    for (const dash of dashes) {
      assert.notEqual(dash, '0px', 'an edge with no dash pattern cannot draw itself on');
      assert.notEqual(dash, 'none');
    }
  });

  test('the page reports animations a capture can seek', async () => {
    // Regression: without this the video export silently produced a still.
    const reply = await render(session.page, source('flow.mmd'), baseRequest);
    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    await session.page.setContent(reply.html, { waitUntil: 'load' });
    const count = await session.page.evaluate(() => document.getAnimations().length);
    assert.ok(count > 5, `expected several animations, got ${count}`);
  });

  test('every animated part has a start time', async () => {
    const reply = await render(session.page, source('subgraphs.mmd'), baseRequest);
    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    await session.page.setContent(reply.html, { waitUntil: 'load' });
    const missing = await session.page.evaluate(
      () =>
        Array.from(
          document.querySelectorAll('[class~="gc-node"], [class~="gc-edge"], [class~="gc-fade"]'),
        ).filter((el) => !(el as HTMLElement).style.getPropertyValue('--gc-t')).length,
    );
    assert.equal(missing, 0);
  });
});

describe('styling survives serialisation', () => {
  test('edge labels sit on the page background, not the ink', async () => {
    // Regression: these rendered as solid black boxes.
    const reply = await render(session.page, source('flow.mmd'), baseRequest);
    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    await session.page.setContent(reply.html, { waitUntil: 'load' });
    const fills = await session.page.evaluate(() =>
      Array.from(document.querySelectorAll('[class~="edgeLabel"] rect')).map(
        (el) => getComputedStyle(el).fill,
      ),
    );
    assert.ok(fills.length > 0, 'this fixture has labelled edges');
    for (const fill of fills) assert.equal(fill, 'rgb(255, 255, 255)');
  });

  test('the injected stylesheet contains no XML-escapable characters', async () => {
    // Regression: XMLSerializer turns `>` into `&gt;`, which corrupts the rule
    // that follows it once the SVG is re-parsed.
    const reply = await render(session.page, source('flow.mmd'), baseRequest);
    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(reply.svg);
    assert.ok(style, 'the svg carries its own stylesheet');
    assert.equal(/[<>&]/.test(style![1]!), false, `found: ${/[<>&]/.exec(style![1]!)?.[0]}`);
  });

  test('labels are SVG text, never foreignObject', async () => {
    // foreignObject clips its contents and does not render outside a browser, so
    // an HTML label both crops long text and breaks the standalone .svg export.
    for (const name of ['flow.mmd', 'subgraphs.mmd', 'state.mmd', 'class.mmd']) {
      const reply = await render(session.page, source(name), baseRequest);
      assert.equal(reply.ok, true);
      if (!reply.ok) return;
      assert.equal(reply.svg.includes('foreignObject'), false, `${name} used an HTML label`);
    }
  });

  test('labels fit inside the boxes drawn for them', async () => {
    // Regression: mermaid measured at weight 400 while our CSS drew at 500, so
    // every label came out a few pixels too wide and lost its last glyph.
    const reply = await render(session.page, source('flow.mmd'), baseRequest);
    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    await session.page.setContent(reply.html, { waitUntil: 'load' });
    const overflowing = await session.page.evaluate(() =>
      Array.from(document.querySelectorAll('[class~="node"]'))
        .map((node) => {
          const shape = node.querySelector('rect, polygon, path, ellipse, circle');
          const label = node.querySelector('text');
          if (!shape || !label) return null;
          const box = shape.getBoundingClientRect().width;
          const text = label.getBoundingClientRect().width;
          return text > box - 4 ? { label: label.textContent, box, text } : null;
        })
        .filter(Boolean),
    );
    assert.deepEqual(overflowing, [], 'labels wider than their shape get clipped');
  });

  test('a one-line label keeps one colour throughout', async () => {
    // Regression: the subtitle rule matched mermaid's per-word tspans, so every
    // word after the first turned grey.
    const reply = await render(session.page, source('flow.mmd'), baseRequest);
    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    await session.page.setContent(reply.html, { waitUntil: 'load' });
    const fills = await session.page.evaluate(() => {
      const label = Array.from(document.querySelectorAll('[class~="node"] text')).find((t) =>
        (t.textContent ?? '').includes('Onboarding'),
      );
      if (!label) return [];
      return Array.from(label.querySelectorAll('tspan')).map((t) => getComputedStyle(t).fill);
    });
    assert.ok(fills.length > 0, 'found the multi-word label');
    assert.equal(
      new Set(fills).size,
      1,
      `one line should be one colour, got ${[...new Set(fills)].join(', ')}`,
    );
  });

  test('the brand font is loaded before mermaid measures text', async () => {
    const reply = await render(session.page, source('flow.mmd'), baseRequest);
    assert.equal(reply.ok, true);
    const loaded = await session.page.evaluate(() => document.fonts.check('500 15px Archivo'));
    assert.equal(loaded, true, 'labels get measured at fallback-font widths otherwise');
  });
});

describe('bad input', () => {
  test('a messy paste is repaired and reported', async () => {
    const reply = await render(session.page, source('messy.mmd'), baseRequest);
    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    assert.ok(reply.repairs.length >= 3, 'each fix is reported back to the user');
    assert.ok(reply.repairs.some((r) => r.rule === 'code-fence'));
    assert.ok(reply.repairs.some((r) => r.rule === 'quote-parens'));
    // Regression: the closing ``` fence used to survive the strip and mermaid
    // parsed it as a node declaration, rendering a box labelled "```".
    const textBlocks = reply.svg.match(/<text[\s\S]*?<\/text>/g) ?? [];
    for (const block of textBlocks) {
      assert.ok(!block.includes('`'), `label contains a stray code-fence backtick: ${block}`);
    }
  });

  test('a genuine syntax error comes back located, not thrown', async () => {
    const reply = await render(session.page, 'flowchart TD\n  A --> \n  B -->|', baseRequest);
    assert.equal(reply.ok, false);
    if (reply.ok) return;
    assert.ok(reply.error.message.length > 0);
    assert.ok(typeof reply.error.line === 'number', 'the message points at a line');
  });

  test('an empty diagram fails cleanly', async () => {
    const reply = await render(session.page, '   \n  \n', baseRequest);
    assert.equal(reply.ok, false);
  });
});

describe('chronicle geometry', () => {
  test('gantt-states: nothing sits outside the svg viewBox', async () => {
    // Regression: the last milestone on a plan (a diamond with a zero-width bar)
    // sits at the very end of the date axis, and its label has to flip to the
    // left of the diamond rather than run off the canvas. DESIGN 7.5.
    const reply = await renderAny(
      session.page,
      readFileSync(join(fixtures, 'gantt-states.mmd'), 'utf8'),
      {},
    );
    assert.equal(reply.ok, true, reply.ok ? '' : JSON.stringify(reply));
    if (!reply.ok) return;
    await session.page.setContent(reply.html, { waitUntil: 'load' });
    const overflowing = await session.page.evaluate(() => {
      const svg = document.querySelector('svg')!;
      const sb = svg.getBoundingClientRect();
      const out: { tag: string; cls: string | null; text: string | null }[] = [];
      for (const el of svg.querySelectorAll('text, rect, path, circle, polygon')) {
        const b = el.getBoundingClientRect();
        if (!b.width && !b.height) continue;
        if (
          b.left < sb.left - 1 ||
          b.right > sb.right + 1 ||
          b.top < sb.top - 1 ||
          b.bottom > sb.bottom + 1
        ) {
          out.push({
            tag: el.tagName,
            cls: el.getAttribute('class'),
            text: el.textContent?.slice(0, 24) ?? null,
          });
        }
      }
      return out;
    });
    assert.deepEqual(overflowing, [], "an element's bbox reaches past the svg viewBox");
  });
});

describe('sequence geometry', () => {
  test('sequence-rich: activation bars sit below arrowheads in document order', async () => {
    // DESIGN 8.5: activation bars, plates and sparks sit below arrowheads in
    // stacking order, so a head is never covered. In SVG, "below" means earlier
    // in document order — later elements paint on top.
    const reply = await renderAny(
      session.page,
      readFileSync(join(fixtures, 'sequence-rich.mmd'), 'utf8'),
      {},
    );
    assert.equal(reply.ok, true, reply.ok ? '' : JSON.stringify(reply));
    if (!reply.ok) return;
    await session.page.setContent(reply.html, { waitUntil: 'load' });
    const order = await session.page.evaluate(() =>
      Array.from(document.querySelectorAll('.gc-active, .gc-arrow')).map((el) =>
        el.classList.contains('gc-active') ? 'bar' : 'arrow',
      ),
    );
    const lastBar = order.lastIndexOf('bar');
    const firstArrow = order.indexOf('arrow');
    assert.ok(lastBar >= 0, 'the fixture has activation bars');
    assert.ok(firstArrow >= 0, 'the fixture has arrowheads');
    assert.ok(
      lastBar < firstArrow,
      `an activation bar (index ${lastBar}) comes after an arrowhead (index ${firstArrow})`,
    );
  });

  test('first-ai-app: every visible label clears the 11-unit legibility floor', async () => {
    // Regression: 5 participants sized their lanes to the widest one-line
    // message, dragging the drawing to ~1440 wide. fitCanvas's last-resort
    // scale then shrank everything, including 11-unit type, below what
    // DESIGN 3.1 calls legible. Wrapping long messages to two lines keeps the
    // lanes — and the canvas — inside the 1000-unit cap, so nothing shrinks.
    const reply = await renderAny(session.page, source('blog/first-ai-app.mmd'), {});
    assert.equal(reply.ok, true, reply.ok ? '' : JSON.stringify(reply));
    if (!reply.ok) return;
    await session.page.setContent(reply.html, { waitUntil: 'load' });
    const sizes = await session.page.evaluate(() => {
      const svg = document.querySelector('svg')!;
      return Array.from(svg.querySelectorAll('text'))
        .filter((t) => (t.textContent ?? '').trim())
        .map((t) => {
          const fontSize = parseFloat(getComputedStyle(t).fontSize);
          const ctm = (t as SVGTextElement).getCTM();
          const scale = ctm ? Math.sqrt(ctm.a * ctm.a + ctm.b * ctm.b) : 1;
          return { text: t.textContent!.trim().slice(0, 24), effective: fontSize * scale };
        });
    });
    assert.ok(sizes.length > 0, 'first-ai-app has no visible labels');
    for (const { text, effective } of sizes) {
      assert.ok(
        effective >= 11 - 0.05,
        `"${text}" renders at an effective ${effective.toFixed(2)} units, below the 11-unit floor`,
      );
    }
  });

  test('rigobot-loop: frame boxes and tags stay inside the svg viewBox', async () => {
    // Regression: an alt/loop frame draws 12 units past the lifelines' own
    // span on each side. The extent handed to fitCanvas used to assume the
    // nominal content box, so the frame — and its kind tab — clipped at the
    // canvas edge (DESIGN 7.5).
    const reply = await renderAny(session.page, source('blog/rigobot-loop.mmd'), {});
    assert.equal(reply.ok, true, reply.ok ? '' : JSON.stringify(reply));
    if (!reply.ok) return;
    await session.page.setContent(reply.html, { waitUntil: 'load' });
    // Settle the entrance animation first — an actor box starts translated
    // up 10px, and measuring mid-transition reads as a false clip at the top
    // edge that has nothing to do with DESIGN 7.5. The cycle loops forever,
    // so `Animation.finish()` throws; dropping the `animation` property
    // instead falls back to the element's unanimated (= settled) CSS state.
    await session.page.evaluate(() => {
      for (const el of document.querySelectorAll('svg *'))
        (el as HTMLElement).style.animation = 'none';
    });
    const overflowing = await session.page.evaluate(() => {
      const svg = document.querySelector('svg')!;
      const sb = svg.getBoundingClientRect();
      const out: { tag: string; cls: string | null; text: string | null }[] = [];
      for (const el of svg.querySelectorAll('text, rect, path, circle, polygon')) {
        const b = el.getBoundingClientRect();
        if (!b.width && !b.height) continue;
        if (
          b.left < sb.left - 1 ||
          b.right > sb.right + 1 ||
          b.top < sb.top - 1 ||
          b.bottom > sb.bottom + 1
        ) {
          out.push({
            tag: el.tagName,
            cls: el.getAttribute('class'),
            text: el.textContent?.slice(0, 24) ?? null,
          });
        }
      }
      return out;
    });
    assert.deepEqual(overflowing, [], 'a frame box or tag reaches past the svg viewBox');
  });
});

describe('board chrome', () => {
  test('sankey: has a title and its ribbons are flat fills, not gradients', async () => {
    // DESIGN 7.1: every chart has a title. sankey-beta's own grammar has no
    // title syntax, so this was the one board type that always rendered
    // without one. DESIGN 4.3: fills are flat — a ribbon's colour never comes
    // from a <linearGradient>.
    const reply = await renderAny(
      session.page,
      readFileSync(join(fixtures, 'sankey.mmd'), 'utf8'),
      {},
    );
    assert.equal(reply.ok, true, reply.ok ? '' : JSON.stringify(reply));
    if (!reply.ok) return;
    assert.match(
      reply.svg,
      /<text class="gc-board-title"[^>]*>[^<]+<\/text>/,
      'no title text in the sankey svg',
    );
    assert.doesNotMatch(reply.svg, /linearGradient/, 'a sankey ribbon is using a gradient fill');
  });

  test('sankey: a ribbon reveals by growing, not by fading in whole', async () => {
    // DESIGN 8.2/10.4: a ribbon draws on left to right, layer by layer, rather
    // than fading in as a flat rectangle. Every ribbon's own @keyframes block
    // must carry a clip-path change — opacity alone is the old, wrong build.
    const reply = await renderAny(
      session.page,
      readFileSync(join(fixtures, 'sankey.mmd'), 'utf8'),
      {},
    );
    assert.equal(reply.ok, true, reply.ok ? '' : JSON.stringify(reply));
    if (!reply.ok) return;
    const ids = [...reply.svg.matchAll(/class="gc-ribbon[^"]*" data-id="(l-[^"]+)"/g)].map(
      (m) => m[1]!,
    );
    assert.ok(ids.length > 0, 'sankey.mmd drew no ribbons');
    for (const id of ids) {
      const selector = `.gc-ribbon[data-id="${id}"]{animation:`;
      const at = reply.css.indexOf(selector);
      assert.ok(at >= 0, `${id}: no animation rule on the ribbon itself`);
      const name = /^(\S+)/.exec(reply.css.slice(at + selector.length))![1];
      const kfStart = reply.css.indexOf(`@keyframes ${name}{`);
      assert.ok(kfStart >= 0, `${id}: no @keyframes block for ${name}`);
      const kfEnd = reply.css.indexOf('\n', kfStart);
      const body = reply.css.slice(kfStart, kfEnd === -1 ? reply.css.length : kfEnd);
      assert.match(
        body,
        /clip-path/,
        `${id}: a ribbon must grow via clip-path, not just fade — keyframes were "${body}"`,
      );
    }
  });
});
