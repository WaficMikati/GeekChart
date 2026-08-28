/**
 * DESIGN 8.4 (rev. 2026-08-28): a chart marked `data-gc-play="once"` or
 * `"in-view"` plays its build once and holds the finished frame — nothing in
 * its stylesheet may still be looping. Charts left at the old `'loop'`
 * default carry no `data-gc-play` attribute at all, so this only ever runs
 * against a chart that actually asked for the new behaviour; the review
 * gallery and gate (which render every fixture with `play: 'loop'`, see
 * `packages/cli/scripts/gallery.mjs`) are untouched by it.
 */
import type { Check, Finding } from './helpers.ts';

export const holdsFinished: Check = {
  id: '8.4-holds',
  rule: '8.4',
  run(svg) {
    const play = svg.getAttribute('data-gc-play');
    if (play !== 'once' && play !== 'in-view') return [];

    const findings: Finding[] = [];
    const css = [...svg.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');

    // Scoped to this renderer's own `gc-`-prefixed animation names (see
    // `scope.ts`'s note on that prefix, and `animate.ts`'s `applyPlayMode`,
    // which is scoped the same way). The legacy render path also embeds
    // mermaid's own CSS verbatim, which ships an unrelated, never-applied
    // `dash`/`edge-animation-*` pair that loops forever regardless of
    // `data-gc-play` — not a rule this renderer draws with, so it must not
    // fail this check.
    const shorthand = [...css.matchAll(/animation:\s*(gc-[\w-]*[^;{}]*)/g)].map((m) => m[1]!);

    const stillInfinite = shorthand.filter((v) => /\binfinite\b/.test(v));
    if (stillInfinite.length) {
      findings.push({
        severity: 'fail',
        message: `8.4 ${stillInfinite.length} animation(s) still \`infinite\` while data-gc-play="${play}" — a chart that plays once must hold its finished state, not loop.`,
      });
    }

    // Every `animation:` shorthand this renderer emits for a repeating track
    // carries no fill-mode of its own (that is exactly what made it loop
    // forever instead of holding); once its iteration-count stops at 1, it
    // needs `forwards` or `both` or it snaps back to frame zero the instant
    // the single pass ends.
    const missingHold = shorthand.filter((v) => !/\b(forwards|both)\b/.test(v));
    if (missingHold.length) {
      findings.push({
        severity: 'fail',
        message: `8.4 ${missingHold.length} animation shorthand rule(s) have no forwards/both fill-mode while data-gc-play="${play}" — the chart would snap back to its start frame once the pass finishes.`,
      });
    }

    return findings;
  },
};

/**
 * DESIGN 8.6: a chart stamped `data-gc-speed` asked for one multiplier on
 * every duration and delay in its stylesheet. The gate sees one rendered
 * chart at a time, with no unsped twin of the same source to divide back
 * against, so it can only check what a single render actually proves: the
 * multiplier is a real number inside the designed 0.25-4 range, and the
 * chart it is stamped on has timed motion at all — a `data-gc-speed` on a
 * chart with no `animation-duration`/`-delay`/`animation:` anywhere would be
 * a renderer bug (nothing for the multiplier to apply to), not a value a
 * caller could get wrong. The exact-factor claim — every value equals the
 * design timing times the multiplier, ±1 ms — needs a paired `speed: 1`
 * render of the same source to divide back against; that comparison lives
 * in `packages/cli/test/render.test.mts`, not here. Runs only when
 * `data-gc-speed` is present — the gallery and gate render every fixture at
 * the default speed (1), which carries no attribute at all, so this is a
 * no-op for `pnpm gate`'s ordinary sweep.
 */
export const speedInRange: Check = {
  id: '8.6-speed',
  rule: '8.6',
  run(svg) {
    const raw = svg.getAttribute('data-gc-speed');
    if (raw === null) return [];

    const findings: Finding[] = [];
    const value = Number(raw);
    const EPS = 1e-9;
    if (!Number.isFinite(value) || value < 0.25 - EPS || value > 4 + EPS) {
      findings.push({
        severity: 'fail',
        message: `8.6 data-gc-speed="${raw}" is outside the supported 0.25-4 range.`,
      });
    }

    const css = [...svg.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
    const hasTiming = /\banimation(?:-duration|-delay)?\s*:/.test(css);
    if (!hasTiming) {
      findings.push({
        severity: 'fail',
        message: `8.6 data-gc-speed="${raw}" is stamped on a chart with no animation-duration/-delay anywhere in its stylesheet.`,
      });
    }

    return findings;
  },
};

export const MOTION_CHECKS: Check[] = [holdsFinished, speedInRange];
