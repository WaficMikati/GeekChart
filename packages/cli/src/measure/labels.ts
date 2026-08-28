/**
 * DESIGN.md §6.5: labels never overlap another label, collide with a shape
 * they are not inside of, swallow most of the edge they sit on, or sit on
 * another edge than their own.
 */
import { RULES } from '@geekchart/core';
import {
  pathPoints,
  rect,
  texts,
  trimCoincidentRuns,
  visible,
  type Check,
  type Seg,
  pathPointsHV,
} from './helpers.ts';

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
  run(svg, ctx) {
    const edgeEls = [...svg.querySelectorAll<SVGGeometryElement>('.gc-edge[data-id]')];
    const pointsOf = new Map<string, [number, number][]>();
    for (const e of edgeEls) {
      const ctm = e.getScreenCTM();
      if (!ctm) continue;
      pointsOf.set(e.getAttribute('data-id')!, transformPts(pathPoints(e.getAttribute('d')), ctm));
    }
    const tol = 1.5 * ctx.unit;
    let labelOnEdge = 0;
    for (const t of svg.querySelectorAll('.gc-edge-label text, .gc-card, text.gc-msg-label')) {
      if (!visible(t, svg)) continue;
      const b = rect(t);
      if (!b.width) continue;
      const own = t.closest('[data-id]')?.getAttribute('data-id');
      const ownPts = own ? pointsOf.get(own) : undefined;
      const ownSegs: Seg[] = [];
      for (let j = 1; ownPts && j < ownPts.length; j++) {
        const [x1, y1] = ownPts[j - 1]!;
        const [x2, y2] = ownPts[j]!;
        ownSegs.push({ x1, y1, x2, y2 });
      }
      for (const [id, pts] of pointsOf) {
        if (id === own) continue;
        // Breaks only this edge's own segment scan — a label overlapping more
        // than one other edge is counted once per edge, matching the gate.
        let hit = false;
        for (let i = 1; i < pts.length && !hit; i++) {
          const [x1, y1] = pts[i - 1]!;
          const [x2, y2] = pts[i]!;
          // DESIGN 6.4/6.8: the stretch this other edge shares with the
          // label's own path (a bus trunk, or two branches leaving one
          // point together) is not "another edge" — only that shared
          // stretch is trimmed away, not the rest past where they part.
          for (const { x1: sx1, y1: sy1, x2: sx2, y2: sy2 } of trimCoincidentRuns(
            { x1, y1, x2, y2 },
            ownSegs,
            tol,
          )) {
            const lo1 = Math.min(sx1, sx2);
            const hi1 = Math.max(sx1, sx2);
            const lo2 = Math.min(sy1, sy2);
            const hi2 = Math.max(sy1, sy2);
            if (lo1 < b.right && hi1 > b.left && lo2 < b.bottom && hi2 > b.top) {
              hit = true;
              break;
            }
          }
        }
        if (hit) labelOnEdge++;
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
      // Command-aware: a rounded corner (Q) contributes only its end point,
      // so the run either side of it is measured whole and the corner never
      // reads as a 12-unit "segment" of its own. Runs shorter than 16 are
      // corner stubs, not somewhere a label can be.
      const pts = pathPointsHV(e.getAttribute('d'), ctm);
      for (let i = 1; i < pts.length; i++) {
        const [x1, y1] = pts[i - 1]!;
        const [x2, y2] = pts[i]!;
        const horiz = Math.abs(y1 - y2) < 1;
        const vert = Math.abs(x1 - x2) < 1;
        const len = horiz ? Math.abs(x2 - x1) : vert ? Math.abs(y2 - y1) : 0;
        if (len < 16) continue;
        // "On" the run means the line passes through the label's box.
        const onH =
          horiz && y1 > b.top && y1 < b.bottom && b.right > Math.min(x1, x2) && b.left < Math.max(x1, x2);
        const onV =
          vert && x1 > b.left && x1 < b.right && b.bottom > Math.min(y1, y2) && b.top < Math.max(y1, y2);
        if (onH && b.width > RULES['6.5']!.threshold! * len) {
          swallowed++;
          swallowIds.push(own!);
          break;
        }
        if (
          onV &&
          (b.height > RULES['6.5-vertical']!.threshold! * len ||
            len < RULES['6.5-min-run']!.threshold!)
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
