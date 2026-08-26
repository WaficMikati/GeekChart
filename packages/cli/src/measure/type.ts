/**
 * DESIGN.md §3 (type sizes, rotation, raw tags), §9 (contrast), §10.2 (text
 * centred in its box).
 */
import { rect, texts, type Check, type Ctx } from './helpers.ts';

function typeStats(ctx: Ctx): {
  sizes: number[];
  minScreen: number;
  minScreenText: string;
  rotated: number;
} {
  return ctx.memo('typeStats', () => {
    const scale = Math.min(1, ctx.stagePx / ctx.vb.width);
    const sizes = new Set<number>();
    let minScreen = Infinity;
    let minScreenText = '';
    let rotated = 0;
    for (const t of texts(ctx)) {
      const px = parseFloat(getComputedStyle(t).fontSize);
      sizes.add(px);
      if (px * scale < minScreen) {
        minScreen = px * scale;
        minScreenText = (t.textContent || '').trim().slice(0, 24);
      }
      const tr =
        (t.getAttribute('transform') || '') + (t.parentElement?.getAttribute('transform') || '');
      if (/rotate\(\s*-?(?!0[\s)])\d/.test(tr)) rotated++;
    }
    return {
      sizes: [...sizes].sort((a, b) => a - b),
      minScreen: +minScreen.toFixed(1),
      minScreenText,
      rotated,
    };
  });
}

export const typeSizes: Check = {
  id: '3-type-sizes',
  rule: '3',
  run(svg, ctx) {
    const { sizes } = typeStats(ctx);
    return sizes.length > 5
      ? [{ severity: 'warn', message: `3 ${sizes.length} text sizes (${sizes.join('/')})` }]
      : [];
  },
};

export const minLegible: Check = {
  id: '3.1-min-legible',
  rule: '3.1',
  run(svg, ctx) {
    const { minScreen, minScreenText } = typeStats(ctx);
    return minScreen < 8
      ? [{ severity: 'fail', message: `3.1 ${minScreen}px on screen "${minScreenText}"` }]
      : [];
  },
};

export const rotation: Check = {
  id: '3.4-rotation',
  rule: '3.4',
  run(svg, ctx) {
    const { rotated } = typeStats(ctx);
    if (rotated > 1) return [{ severity: 'fail', message: `3.4 ${rotated} rotated` }];
    if (rotated) return [{ severity: 'warn', message: '3.4 1 rotated (axis label is allowed)' }];
    return [];
  },
};

export const rawTag: Check = {
  id: '3.2-raw-tag',
  rule: '3.2',
  run(svg, ctx) {
    const n = texts(ctx).filter((t) => /<br\s*\/?>|&lt;br/i.test(t.textContent || '')).length;
    return n ? [{ severity: 'fail', message: `3.2 ${n} labels with a literal <br>` }] : [];
  },
};

export const textCentred: Check = {
  id: '10.2-text-centred',
  rule: '10.2',
  run(svg, ctx) {
    let offText = 0;
    for (const n of svg.querySelectorAll('.gc-node')) {
      const shape = n.querySelector('rect.gc-outline, rect.gc-fill');
      if (!shape) continue;
      const s = rect(shape);
      for (const t of n.querySelectorAll('text')) {
        const b = rect(t);
        if (!b.width) continue;
        if (getComputedStyle(t).textAnchor !== 'middle') continue;
        if (Math.abs((b.left + b.right) / 2 - (s.left + s.right) / 2) > 1.5 * ctx.unit) offText++;
      }
    }
    return offText
      ? [{ severity: 'fail', message: `10.2 ${offText} labels off-centre in box` }]
      : [];
  },
};

function luminance(color: string): number | null {
  const m = color.match(/\d+(\.\d+)?/g);
  if (!m) return null;
  const [R, G, B] = m
    .map(Number)
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * R! + 0.7152 * G! + 0.0722 * B!;
}

export const contrast: Check = {
  id: '9-contrast',
  rule: '9',
  run(svg, ctx) {
    // gate.mjs always mounts a chart inside `.stage`; a check running directly
    // against a bare render (as the tests do) has no such ancestor, so a
    // near-black default keeps the check meaningful without one.
    const stage = svg.closest('.stage');
    const bg = stage ? (luminance(getComputedStyle(stage).backgroundColor) ?? 0) : 0;
    let lowContrast = 0;
    for (const t of texts(ctx)) {
      const L = luminance(getComputedStyle(t).fill);
      if (L == null) continue;
      const ratio = (Math.max(L, bg) + 0.05) / (Math.min(L, bg) + 0.05);
      if (ratio < 3) lowContrast++;
    }
    return lowContrast
      ? [{ severity: 'fail', message: `9 ${lowContrast} low-contrast texts` }]
      : [];
  },
};

export const TYPE_CHECKS: Check[] = [
  typeSizes,
  minLegible,
  rotation,
  rawTag,
  textCentred,
  contrast,
];
