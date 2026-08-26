/**
 * DESIGN.md §6.5: labels never overlap another label, collide with a shape
 * they are not inside of, swallow most of the edge they sit on, or sit on
 * another edge than their own.
 */
import { RULES } from '@geekchart/core';
import { pathPoints, rect, texts, visible, type Check } from './helpers.ts';

function transformPts(pts: [number, number][], ctm: DOMMatrix): [number, number][] {
  return pts.map(([x, y]) => [x * ctm.a + ctm.e, y * ctm.d + ctm.f]);
}

export const labelOverlaps: Check = {
  id: '6.5-label-overlaps',
  rule: '6.5',
  run(svg, ctx) {
    const tb = texts(ctx).map((t) => ({ t, b: rect(t) }));
    let overlaps = 0;
    for (let i = 0; i < tb.length; i++) {
      for (let j = i + 1; j < tb.length; j++) {
        const a = tb[i]!.b;
        const b = tb[j]!.b;
        if (
          a.width &&
          b.width &&
          a.left < b.right - 1 &&
          b.left < a.right - 1 &&
          a.top < b.bottom - 1 &&
          b.top < a.bottom - 1
        ) {
          overlaps++;
        }
      }
    }
    return overlaps ? [{ severity: 'fail', message: `6.5 ${overlaps} label overlaps` }] : [];
  },
};

export const textShapeCollision: Check = {
  id: '6.5-text-shape-collision',
  rule: '6.5',
  run(svg, ctx) {
    const tb = texts(ctx).map((t) => ({ t, b: rect(t) }));
    const shapes = [...svg.querySelectorAll('rect, circle, polygon')].filter(
      (e) => visible(e, svg) && !e.classList.contains('bg') && !e.classList.contains('gc-plate'),
    );
    let collisions = 0;
    for (const { t, b } of tb) {
      for (const sh of shapes) {
        if (sh.contains(t) || (t.parentElement === sh.parentElement && sh.closest('.gc-node')))
          continue;
        const s = rect(sh);
        if (!s.width) continue;
        const inside =
          b.left >= s.left - 1 &&
          b.right <= s.right + 1 &&
          b.top >= s.top - 1 &&
          b.bottom <= s.bottom + 1;
        const touches =
          b.left < s.right - 1 &&
          s.left < b.right - 1 &&
          b.top < s.bottom - 1 &&
          s.top < b.bottom - 1;
        if (touches && !inside) collisions++;
      }
    }
    return collisions
      ? [{ severity: 'fail', message: `6.5 ${collisions} text/shape collisions` }]
      : [];
  },
};

export const labelOnOtherEdge: Check = {
  id: '6.5-label-on-other-edge',
  rule: '6.5',
  run(svg) {
    const edgeEls = [...svg.querySelectorAll<SVGGeometryElement>('.gc-edge[data-id]')];
    let labelOnEdge = 0;
    for (const t of svg.querySelectorAll('.gc-edge-label text, .gc-card, text.gc-msg-label')) {
      if (!visible(t, svg)) continue;
      const b = rect(t);
      if (!b.width) continue;
      const own = t.closest('[data-id]')?.getAttribute('data-id');
      for (const e of edgeEls) {
        if (e.getAttribute('data-id') === own) continue;
        const ctm = e.getScreenCTM();
        if (!ctm) continue;
        const pts = transformPts(pathPoints(e.getAttribute('d')), ctm);
        // Breaks only this edge's own segment scan — a label overlapping more
        // than one other edge is counted once per edge, matching the gate.
        for (let i = 1; i < pts.length; i++) {
          const [x1, y1] = pts[i - 1]!;
          const [x2, y2] = pts[i]!;
          const sx1 = Math.min(x1, x2);
          const sx2 = Math.max(x1, x2);
          const sy1 = Math.min(y1, y2);
          const sy2 = Math.max(y1, y2);
          if (sx1 < b.right && sx2 > b.left && sy1 < b.bottom && sy2 > b.top) {
            labelOnEdge++;
            break;
          }
        }
      }
    }
    return labelOnEdge
      ? [{ severity: 'fail', message: `6.5 ${labelOnEdge} labels sitting on another edge` }]
      : [];
  },
};

export const labelSwallow: Check = {
  id: '6.5-label-swallow',
  rule: '6.5',
  run(svg) {
    let swallowed = 0;
    const swallowIds: string[] = [];
    for (const t of svg.querySelectorAll('.gc-edge-label text, .gc-card')) {
      if (!visible(t, svg)) continue;
      const b = rect(t);
      if (!b.width) continue;
      const own = t.closest('[data-id]')?.getAttribute('data-id');
      const e = own && svg.querySelector<SVGGeometryElement>(`.gc-edge[data-id="${own}"]`);
      if (!e) continue;
      const ctm = e.getScreenCTM()!;
      const pts = transformPts(pathPoints(e.getAttribute('d')), ctm);
      const cx = (b.left + b.right) / 2;
      const cy = (b.top + b.bottom) / 2;
      for (let i = 1; i < pts.length; i++) {
        const [x1, y1] = pts[i - 1]!;
        const [x2, y2] = pts[i]!;
        const horiz = Math.abs(y1 - y2) < 1;
        const vert = Math.abs(x1 - x2) < 1;
        const onH =
          horiz && Math.abs(cy - y1) < b.height && cx > Math.min(x1, x2) && cx < Math.max(x1, x2);
        const onV =
          vert && Math.abs(cx - x1) < b.width && cy > Math.min(y1, y2) && cy < Math.max(y1, y2);
        if (onH && b.width > RULES['6.5']!.threshold! * Math.abs(x2 - x1)) {
          swallowed++;
          swallowIds.push(own!);
          break;
        }
        if (
          onV &&
          (b.height > RULES['6.5-vertical']!.threshold! * Math.abs(y2 - y1) ||
            Math.abs(y2 - y1) < RULES['6.5-min-run']!.threshold!)
        ) {
          swallowed++;
          swallowIds.push(own!);
          break;
        }
      }
    }
    return swallowed
      ? [
          {
            severity: 'fail',
            message: `6.5 ${swallowed} labels swallowing their edge (${swallowIds.slice(0, 3).join(' ')})`,
          },
        ]
      : [];
  },
};

export const LABEL_CHECKS: Check[] = [
  labelOverlaps,
  labelSwallow,
  textShapeCollision,
  labelOnOtherEdge,
];
