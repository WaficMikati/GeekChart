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

export const MOTION_CHECKS: Check[] = [holdsFinished];
