import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAny, type AnyReply, type Session } from '../src/browser.ts';
import { applyPlayMode } from '../../core/src/animate.ts';
import { getSession } from './helpers/session.ts';
import { cachedRender } from './helpers/render-cache.ts';

/**
 * DESIGN 8.4 (rev. 2026-08-28): a chart plays its build once, then holds the
 * finished frame. The mechanism (`animate.ts`'s `applyPlayMode`, and every
 * family's own "every track ends at its resting value at `cycle`" contract —
 * see `motion.ts`'s file comment) only works if the frame a `'once'` chart
 * settles on is pixel-for-pixel the frame `pnpm gate` measures, which is the
 * *default* render with every animation switched off entirely
 * (`gallery.mjs`'s `body.still` — animation:none, not "paused at the end").
 * Those are two independently-specified things — one is a keyframe's last
 * offset, the other is an element's plain, unanimated style — and nothing
 * stops them from drifting apart. This file is the check that they don't,
 * for every fixture.
 *
 * `renderAny`/`FlowOptions` has no `play` parameter — DESIGN 8.4 was wired up
 * by rewriting the *finished* stylesheet after the fact (see `animate.ts`'s
 * long comment on `applyPlayMode`), not by threading a mode through
 * `flow.ts` and the family files it drives. So "render it both ways" means:
 * one `renderAny` call, then two derivations from the same `{ svg, css }` —
 * `applyPlayMode(..., 'once')` for the held frame, and the CSS gate.mjs's
 * `body.still` applies (`animation: none !important` on everything) for the
 * still frame — exactly what `Geekchart.tsx`, `geekchart/server.ts` and
 * `gallery.mjs`'s node engine already do with the same function.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, '..', '..', '..', 'fixtures');

const FIXTURES = [
  ...readdirSync(fixturesRoot)
    .filter((f) => f.endsWith('.mmd'))
    .sort(),
  ...readdirSync(join(fixturesRoot, 'blog'))
    .filter((f) => f.endsWith('.mmd'))
    .sort()
    .map((f) => join('blog', f)),
];

let session: Session;
before(async () => {
  session = await getSession();
});

const ok = (reply: AnyReply): Extract<AnyReply, { ok: true }> => {
  assert.equal(reply.ok, true, reply.ok ? '' : JSON.stringify(reply));
  return reply as Extract<AnyReply, { ok: true }>;
};

/** The same request `pnpm gallery` makes for every fixture (see gallery.mjs). */
async function renderCached(source: string) {
  return cachedRender('renderAny', source, { width: 1180 }, () =>
    renderAny(session.page, source, { width: 1180 }),
  );
}

/**
 * One property snapshot per animatable element, in document order — both
 * mounts come from the same markup, so the same index is the same element in
 * both. Numeric fields are pre-rounded here (in the browser) so float noise
 * between an interpolated `finish()` and a plain static value never registers
 * as a false mismatch; `fill` and the element's own id/class are left exact.
 */
interface ElementSnapshot {
  id: string;
  cls: string;
  opacity: number;
  dashoffset: number | null;
  transform: string;
  fill: string;
}

async function snapshot(): Promise<ElementSnapshot[]> {
  return session.page.evaluate(() => {
    const svg = document.querySelector('svg')!;
    const round = (n: number, p: number) => Math.round(n * 10 ** p) / 10 ** p;
    return [...svg.querySelectorAll('[data-id], [class*="gc-"]')].map((el) => {
      const cs = getComputedStyle(el);
      let transform = 'none';
      if (cs.transform && cs.transform !== 'none') {
        const m = new DOMMatrix(cs.transform);
        const parts = [m.a, m.b, m.c, m.d, m.e, m.f].map((n) => round(n, 2));
        // A finished Web Animation can leave an explicit identity matrix
        // where an unanimated element has no `transform` at all — same
        // picture, different way of saying "nothing moved". Fold both into
        // 'none' so that difference in bookkeeping isn't read as a defect.
        const isIdentity = parts.join(',') === '1,0,0,1,0,0';
        transform = isIdentity ? 'none' : parts.join(',');
      }
      const rawOffset = cs.strokeDashoffset;
      const dashoffset =
        rawOffset && rawOffset !== 'none' ? round(parseFloat(rawOffset), 1) : null;
      return {
        id: el.getAttribute('data-id') ?? '',
        cls: el.getAttribute('class') ?? '',
        opacity: round(parseFloat(cs.opacity), 2),
        dashoffset,
        transform,
        fill: cs.fill,
      };
    });
  });
}

/**
 * Mount the `once` markup and drive every animation to its held end state.
 *
 * `finish()` alone leaves the (now-finished) Animation objects attached to
 * their elements, and Chromium keeps those elements on their own compositor
 * layer for as long as an Animation is attached — which shifts glyph
 * anti-aliasing by a channel or two relative to the same text painted with
 * no animation ever attached. That is real, but it is a browser rendering
 * quirk with zero relationship to DESIGN 8.4, and it produced ~1-2% "pixel"
 * mismatches on every fixture with any label near an animated element
 * (verified: `commitStyles()` written back as an inline style, then
 * `cancel()` to drop the Animation and its layer, took every one of those
 * fixtures to a 0-pixel diff with no change to the CSS or the fixture).
 * `commitStyles()` writes the exact values `finish()` computed, so this
 * changes nothing about what is being asserted — it only removes the
 * leftover Animation object that was never part of the picture being judged.
 */
async function mountHeld(svg: string, css: string): Promise<void> {
  const played = applyPlayMode({ svg, css }, 'once');
  await session.page.setContent(`<style>${played.css}</style>${played.svg}`, {
    waitUntil: 'load',
  });
  await session.page.evaluate(() => document.fonts.ready);
  await session.page.evaluate(() => {
    const svgEl = document.querySelector('svg')!;
    for (const a of svgEl.getAnimations({ subtree: true })) {
      a.finish();
      try {
        a.commitStyles();
      } catch {
        // A handful of effects (independent transforms, SVG-only properties)
        // cannot be committed in every engine — `finish()` already put the
        // element at its held frame either way, this is only cleanup.
      }
      a.cancel();
    }
  });
}

/** Mount the default (looping) markup with every animation switched off —
 *  the same effect gallery.mjs's `body.still` rule has on the gate's page. */
async function mountStill(svg: string, css: string): Promise<void> {
  const still = `${css}\nsvg *, svg { animation: none !important; }`;
  await session.page.setContent(`<style>${still}</style>${svg}`, { waitUntil: 'load' });
  await session.page.evaluate(() => document.fonts.ready);
}

/**
 * Decode both PNG buffers and diff them pixel-by-pixel inside the browser
 * (`<canvas>`/`getImageData`) rather than reaching for a PNG-decoding
 * dependency — neither `pixelmatch` nor `pngjs` is installed anywhere in
 * this workspace, and adding one is outside this task's touched files.
 * A pixel counts as differing when any channel is off by more than 16/255;
 * the fixture fails when more than 0.1% of pixels do.
 */
async function pixelDiff(
  held: Buffer,
  still: Buffer,
): Promise<{ ok: boolean; ratio: number; total: number; diff: number; reason?: string }> {
  return session.page.evaluate(
    ([a, b]) => {
      const load = (b64: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('image failed to decode'));
          img.src = `data:image/png;base64,${b64}`;
        });
      return Promise.all([load(a), load(b)]).then(([imgA, imgB]) => {
        if (imgA.naturalWidth !== imgB.naturalWidth || imgA.naturalHeight !== imgB.naturalHeight) {
          return {
            ok: false,
            ratio: 1,
            total: 0,
            diff: 0,
            reason: `size mismatch ${imgA.naturalWidth}x${imgA.naturalHeight} vs ${imgB.naturalWidth}x${imgB.naturalHeight}`,
          };
        }
        const canvas = document.createElement('canvas');
        canvas.width = imgA.naturalWidth;
        canvas.height = imgA.naturalHeight;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(imgA, 0, 0);
        const dataA = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(imgB, 0, 0);
        const dataB = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let diff = 0;
        const TOL = 16;
        for (let i = 0; i < dataA.length; i += 4) {
          if (
            Math.abs(dataA[i]! - dataB[i]!) > TOL ||
            Math.abs(dataA[i + 1]! - dataB[i + 1]!) > TOL ||
            Math.abs(dataA[i + 2]! - dataB[i + 2]!) > TOL ||
            Math.abs(dataA[i + 3]! - dataB[i + 3]!) > TOL
          ) {
            diff++;
          }
        }
        const total = dataA.length / 4;
        return { ok: true, ratio: diff / total, total, diff };
      });
    },
    [held.toString('base64'), still.toString('base64')] as const,
  );
}

describe('a played-once chart holds the same picture the gate\'s still frame measures', () => {
  for (const name of FIXTURES) {
    test(name, async () => {
      const reply = ok(await renderCached(readFileSync(join(fixturesRoot, name), 'utf8')));

      await mountHeld(reply.svg, reply.css);
      const heldSnapshot = await snapshot();
      const heldShot = await (await session.page.$('svg'))!.screenshot();

      await mountStill(reply.svg, reply.css);
      const stillSnapshot = await snapshot();
      const stillShot = await (await session.page.$('svg'))!.screenshot();

      assert.equal(
        heldSnapshot.length,
        stillSnapshot.length,
        `${name}: held mount has ${heldSnapshot.length} animatable elements, still mount has ${stillSnapshot.length}`,
      );

      for (let i = 0; i < heldSnapshot.length; i++) {
        const held = heldSnapshot[i]!;
        const still = stillSnapshot[i]!;
        const label = held.id ? `data-id="${held.id}"` : `class="${held.cls}"`;
        assert.equal(
          held.opacity,
          still.opacity,
          `${name} ${label}: opacity ${held.opacity} held vs ${still.opacity} still`,
        );
        // An element that is fully transparent in both mounts contributes
        // nothing to either picture — its dash offset, transform and fill are
        // unobservable, so a decorative element (a spent trail, a spark
        // parked at its start point) that never resets its geometry once
        // faded out is not a picture difference and is not asserted below.
        if (held.opacity === 0 && still.opacity === 0) continue;
        assert.equal(
          held.dashoffset,
          still.dashoffset,
          `${name} ${label}: stroke-dashoffset ${held.dashoffset} held vs ${still.dashoffset} still`,
        );
        assert.equal(
          held.transform,
          still.transform,
          `${name} ${label}: transform ${held.transform} held vs ${still.transform} still`,
        );
        assert.equal(
          held.fill,
          still.fill,
          `${name} ${label}: fill ${held.fill} held vs ${still.fill} still`,
        );
      }

      const diff = await pixelDiff(heldShot, stillShot);
      assert.ok(diff.ok, `${name}: ${diff.reason ?? 'pixel comparison failed'}`);
      assert.ok(
        diff.ratio <= 0.001,
        `${name}: ${diff.diff}/${diff.total} pixels (${(diff.ratio * 100).toFixed(2)}%) differ between the held and still frames`,
      );
    });
  }
});
