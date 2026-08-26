/**
 * Git graph specifics: a lane spans only its own commits (DESIGN 10.5), no
 * commit is labelled with a raw hash (3.2), and a connector never rides along
 * a lane it doesn't belong to (6.4).
 */
import { pathPointsHV, rect, type Check } from './helpers.ts';

function lanes(svg: SVGSVGElement): Element[] {
  return [...svg.querySelectorAll('.gc-commit-lane')];
}

export const laneOverrun: Check = {
  id: '10.5-lane-overrun',
  rule: '10.5',
  run(svg, ctx) {
    const ls = lanes(svg);
    if (!ls.length) return [];
    const dots = [...svg.querySelectorAll('.gc-commit-dot')].map(rect);
    const conns = [...svg.querySelectorAll('.gc-commit-connector')].map(rect);
    let n = 0;
    for (const lane of ls) {
      const lb = rect(lane);
      const cy = (lb.top + lb.bottom) / 2;
      const onLane = [...dots, ...conns].filter((b) => b.top - 2 <= cy && b.bottom + 2 >= cy);
      if (!onLane.length) continue;
      const l = Math.min(...onLane.map((b) => b.left));
      const rg = Math.max(...onLane.map((b) => b.right));
      if (lb.left < l - 24 * ctx.unit - 1 || lb.right > rg + 24 * ctx.unit + 1) n++;
    }
    return n ? [{ severity: 'fail', message: `10.5 ${n} lanes running past their commits` }] : [];
  },
};

export const hashLabel: Check = {
  id: '3.2-hash-label',
  rule: '3.2',
  run(svg) {
    if (!lanes(svg).length) return [];
    let n = 0;
    for (const t of svg.querySelectorAll('.gc-commit-label')) {
      if (/^[0-9a-f]{1,2}-?[0-9a-f]{6,}$/i.test((t.textContent || '').trim())) n++;
    }
    return n ? [{ severity: 'fail', message: `3.2 ${n} commits labelled with a hash` }] : [];
  },
};

export const laneRide: Check = {
  id: '6.4-lane-ride',
  rule: '6.4',
  run(svg, ctx) {
    const ls = lanes(svg);
    if (!ls.length) return [];
    const laneRects = ls.map(rect);
    let n = 0;
    for (const c of svg.querySelectorAll<SVGGeometryElement>('.gc-commit-connector')) {
      const ctm = c.getScreenCTM();
      if (!ctm) continue;
      const pts = pathPointsHV(c.getAttribute('d'), ctm);
      for (let i = 1; i < pts.length; i++) {
        const [x1, y1] = pts[i - 1]!;
        const [x2, y2] = pts[i]!;
        if (Math.abs(y1 - y2) > 0.5) continue; // only horizontal runs can ride a lane
        const run = Math.abs(x2 - x1);
        for (const lr of laneRects) {
          const ly = (lr.top + lr.bottom) / 2;
          if (
            Math.abs(y1 - ly) < 2 &&
            run > 16 * ctx.unit &&
            Math.max(x1, x2) > lr.left &&
            Math.min(x1, x2) < lr.right
          ) {
            n++;
            break;
          }
        }
      }
    }
    return n ? [{ severity: 'fail', message: `6.4 ${n} connector runs riding along a lane` }] : [];
  },
};

export const CHART_CHECKS: Check[] = [laneRide, laneOverrun, hashLabel];
