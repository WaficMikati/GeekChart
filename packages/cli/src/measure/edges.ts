/**
 * DESIGN.md §6: orthogonal routing (6.1), side/arrival/self-pierce (6.2),
 * arrowheads (6.3), shared/parallel runs (6.4), hairpins and loop-backs (6.7).
 */
import {
  clusters,
  degrees,
  edgeEls,
  edgeFromTo,
  edgeMeta,
  flowInSides,
  geomAndHairpins,
  isTB,
  nodeById,
  outline,
  pathPoints,
  pathPointsHV,
  rect,
  type Check,
  type Ctx,
} from './helpers.ts';

/** offMid (6.2) and jogs (6.1) both walk one edge's own points once. */
function edgeLineStats(ctx: Ctx): { offMid: number; jogs: number } {
  return ctx.memo('edgeLineStats', () => {
    const ids = nodeById(ctx);
    let offMid = 0;
    let jogs = 0;
    for (const e of edgeEls(ctx)) {
      const pts = pathPoints(e.getAttribute('d'));
      const segs: number[] = [];
      for (let i = 1; i < pts.length; i++) {
        segs.push(Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
      }
      for (let i = 1; i + 1 < segs.length; i++) {
        if (segs[i]! > 0 && segs[i]! < 6 && segs[i - 1]! > 24 && segs[i + 1]! > 24) jogs++;
      }
      const m = (e.getAttribute('data-id') || '').match(/^L_(.+?)_(.+?)_\d+$/);
      if (!m) continue;
      const a = ids.get(m[1]!);
      const b = ids.get(m[2]!);
      if (!a || !b || pts.length < 2) continue;
      const ra = rect(outline(a));
      const rb = rect(outline(b));
      const re = rect(e);
      const vertical = re.width < 2 * ctx.unit && Math.abs(ra.left - rb.left) < ctx.unit;
      if (vertical) {
        const cx = (ra.left + ra.right) / 2;
        if (Math.abs((re.left + re.right) / 2 - cx) > 1.5 * ctx.unit) offMid++;
      }
    }
    return { offMid, jogs };
  });
}

/**
 * A forward edge no longer than 2× the Manhattan distance between its ends
 * (+32 for two elbows) is a route, not a detour (6.1); more than 2 bends (4
 * for a back edge) is too many (6.1); shorter than 16 units means the nodes
 * are touching (2.3, exported for grid.ts). One loop over the edges backs all
 * three, skipping back/loop-kind edges entirely as the original gate did.
 */
export function edgeShapeStats(ctx: Ctx): {
  detours: number;
  detourIds: string[];
  touching: number;
  overBent: number;
  bentIds: string[];
} {
  return ctx.memo('edgeShapeStats', () => {
    const ids = nodeById(ctx);
    let detours = 0;
    const detourIds: string[] = [];
    let touching = 0;
    let overBent = 0;
    const bentIds: string[] = [];
    for (const e of edgeEls(ctx)) {
      if (e.classList.contains('gc-back') || /back|loop/.test(e.dataset.kind || '')) continue;
      const pts = pathPoints(e.getAttribute('d'));
      if (pts.length < 2) continue;
      let len = 0;
      for (let i = 1; i < pts.length; i++) {
        len += Math.abs(pts[i]![0] - pts[i - 1]![0]) + Math.abs(pts[i]![1] - pts[i - 1]![1]);
      }
      const a = pts[0]!;
      const b = pts[pts.length - 1]!;
      const direct = Math.hypot(b[0] - a[0], b[1] - a[1]) + 32;
      if (len < 16) touching++;
      const m = (e.getAttribute('data-id') || '').match(/^L_(.+?)_(.+?)_\d+$/);
      const na = m && ids.get(m[1]!);
      const nb = m && ids.get(m[2]!);
      const isBack = !!(
        na &&
        nb &&
        rect(nb).top < rect(na).top - 8 &&
        rect(nb).left <= rect(na).left + 8
      );
      const back = isBack || e.classList.contains('gc-back');
      if (!back && len > 1.4 * direct) {
        detours++;
        detourIds.push(e.dataset.id!);
      }
      let bends = 0;
      let prev: 'h' | 'v' | null = null;
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i]![0] - pts[i - 1]![0];
        const dy = pts[i]![1] - pts[i - 1]![1];
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
        const dir: 'h' | 'v' = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
        if (prev && dir !== prev) bends++;
        prev = dir;
      }
      if ((!back && bends > 2) || (back && bends > 4)) {
        overBent++;
        bentIds.push(`${e.dataset.id}:${bends}`);
      }
    }
    return { detours, detourIds, touching, overBent, bentIds };
  });
}

interface Seg {
  v: boolean;
  c: number;
  a: number;
  b: number;
}

/** An edge's straight vertical/horizontal runs (>8 units), plus its two ends. */
function segsOf(e: SVGPathElement): {
  segs: Seg[];
  start?: [number, number];
  end?: [number, number];
} {
  const pts = pathPoints(e.getAttribute('d'));
  const segs: Seg[] = [];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1]!;
    const [x2, y2] = pts[i]!;
    if (Math.abs(x1 - x2) < 0.5 && Math.abs(y1 - y2) > 8)
      segs.push({ v: true, c: x1, a: Math.min(y1, y2), b: Math.max(y1, y2) });
    else if (Math.abs(y1 - y2) < 0.5 && Math.abs(x1 - x2) > 8)
      segs.push({ v: false, c: y1, a: Math.min(x1, x2), b: Math.max(x1, x2) });
  }
  return { segs, start: pts[0], end: pts[pts.length - 1] };
}

/** 6.4's shared-segment and parallel-clearance checks both compare every pair
 *  of edges' straight runs, so they share the O(n²) walk. */
function edgeRunOverlaps(ctx: Ctx): { shared: number; crowded: number; crowdedIds: string[] } {
  return ctx.memo('edgeRunOverlaps', () => {
    const els = edgeEls(ctx);
    const allSegs = els.map(segsOf);
    let shared = 0;
    let crowded = 0;
    const crowdedIds: string[] = [];
    const same = (u?: [number, number], w?: [number, number]) =>
      !!u && !!w && Math.abs(u[0] - w[0]) < 1.5 && Math.abs(u[1] - w[1]) < 1.5;
    for (let i = 0; i < allSegs.length; i++) {
      for (let j = i + 1; j < allSegs.length; j++) {
        for (const p of allSegs[i]!.segs) {
          for (const q of allSegs[j]!.segs) {
            if (p.v === q.v) {
              if (Math.abs(p.c - q.c) <= 1.5) {
                const o = Math.min(p.b, q.b) - Math.max(p.a, q.a);
                if (
                  o > 8 &&
                  !(
                    same(allSegs[i]!.start, allSegs[j]!.start) ||
                    same(allSegs[i]!.end, allSegs[j]!.end)
                  )
                )
                  shared++;
              }
              const gap = Math.abs(p.c - q.c) / ctx.unit;
              if (gap >= 1.5 && gap < 16) {
                const o = Math.min(p.b, q.b) - Math.max(p.a, q.a);
                if (o / ctx.unit > 16) {
                  crowded++;
                  crowdedIds.push(`${els[i]!.dataset.id}|${els[j]!.dataset.id}:${Math.round(gap)}`);
                }
              }
            }
          }
        }
      }
    }
    return { shared, crowded, crowdedIds };
  });
}

export const verticalMidline: Check = {
  id: '6.2-vertical-midline',
  rule: '6.2',
  run(svg, ctx) {
    const { offMid } = edgeLineStats(ctx);
    return offMid
      ? [{ severity: 'fail', message: `6.2 ${offMid} vertical edges off the node centreline` }]
      : [];
  },
};

export const shortJogs: Check = {
  id: '6.1-short-jogs',
  rule: '6.1',
  run(svg, ctx) {
    const { jogs } = edgeLineStats(ctx);
    return jogs ? [{ severity: 'fail', message: `6.1 ${jogs} short jogs in edges` }] : [];
  },
};

export const detour: Check = {
  id: '6.1-detour',
  rule: '6.1',
  run(svg, ctx) {
    const { detours, detourIds } = edgeShapeStats(ctx);
    return detours
      ? [
          {
            severity: 'fail',
            message: `6.1 ${detours} detouring edges (${detourIds.slice(0, 3).join(' ')})`,
          },
        ]
      : [];
  },
};

export const tooManyBends: Check = {
  id: '6.1-too-many-bends',
  rule: '6.1',
  run(svg, ctx) {
    const { overBent, bentIds } = edgeShapeStats(ctx);
    return overBent
      ? [
          {
            severity: 'fail',
            message: `6.1 ${overBent} edges with too many bends (${bentIds.slice(0, 3).join(' ')})`,
          },
        ]
      : [];
  },
};

export const crossing: Check = {
  id: '6.1-crossing',
  rule: '6.1',
  run(svg, ctx) {
    const fwd = edgeEls(ctx).filter((e) => !e.classList.contains('gc-back'));
    const segList = fwd.map((e) => {
      const pts = pathPoints(e.getAttribute('d'));
      const segs: [[number, number], [number, number]][] = [];
      for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1]!, pts[i]!]);
      return segs;
    });
    const cross = (
      a: [[number, number], [number, number]],
      b: [[number, number], [number, number]],
    ) => {
      const [p1, p2] = a;
      const [p3, p4] = b;
      const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
      if (Math.abs(d) < 1e-6) return false;
      const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
      const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
      return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
    };
    const startOf = (segs: [[number, number], [number, number]][]) =>
      segs.length ? segs[0]![0] : null;
    let crossings = 0;
    const crossIds: string[] = [];
    for (let i = 0; i < segList.length; i++) {
      for (let j = i + 1; j < segList.length; j++) {
        const a0 = startOf(segList[i]!);
        const b0 = startOf(segList[j]!);
        if (a0 && b0 && Math.abs(a0[0] - b0[0]) < 1.5 && Math.abs(a0[1] - b0[1]) < 1.5) continue;
        let hit = false;
        for (const a of segList[i]!) {
          for (const b of segList[j]!)
            if (cross(a, b)) {
              hit = true;
              break;
            }
          if (hit) break;
        }
        if (hit) {
          crossings++;
          crossIds.push(`${fwd[i]!.dataset.id}×${fwd[j]!.dataset.id}`);
        }
      }
    }
    return crossings
      ? [
          {
            severity: 'fail',
            message: `6.1 ${crossings} forward edges crossing (${crossIds.slice(0, 3).join(' ')})`,
          },
        ]
      : [];
  },
};

export const channelCentre: Check = {
  id: '6.1-channel-centre',
  rule: '6.1',
  run(svg, ctx) {
    const obstacles: DOMRect[] = [];
    for (const n of svg.querySelectorAll('.gc-node')) {
      const b = rect(outline(n));
      if (b.width) obstacles.push(b);
    }
    for (const c of clusters(ctx)) {
      const bx = c.querySelector('.gc-cluster-box, rect');
      if (bx) {
        const b = rect(bx);
        if (b.width) obstacles.push(b);
      }
    }
    const fwd = edgeEls(ctx).filter((e) => !e.classList.contains('gc-back'));
    let offChannel = 0;
    const offChannelIds: string[] = [];
    for (const e of fwd) {
      const ctm = e.getScreenCTM();
      if (!ctm) continue;
      const pts = pathPointsHV(e.getAttribute('d'), ctm);
      const runs: { dir: 'h' | 'v'; a: [number, number]; b: [number, number] }[] = [];
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i]![0] - pts[i - 1]![0];
        const dy = pts[i]![1] - pts[i - 1]![1];
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
        const dir: 'h' | 'v' = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
        const last = runs[runs.length - 1];
        if (last && last.dir === dir) last.b = pts[i]!;
        else runs.push({ dir, a: pts[i - 1]!, b: pts[i]! });
      }
      if (runs.length !== 3 || runs[0]!.dir !== runs[2]!.dir) continue;
      const mid = runs[1]!;
      if (mid.dir === 'v') {
        const x = (mid.a[0] + mid.b[0]) / 2;
        const y1 = Math.min(mid.a[1], mid.b[1]);
        const y2 = Math.max(mid.a[1], mid.b[1]);
        const lefts = obstacles
          .filter((o) => o.right <= x + 1 && o.bottom > y1 && o.top < y2)
          .map((o) => o.right);
        const rights = obstacles
          .filter((o) => o.left >= x - 1 && o.bottom > y1 && o.top < y2)
          .map((o) => o.left);
        if (!lefts.length || !rights.length) continue;
        const want = (Math.max(...lefts) + Math.min(...rights)) / 2;
        if (Math.abs(x - want) > 4 * ctx.unit) {
          offChannel++;
          offChannelIds.push(`${e.dataset.id}:${Math.round((x - want) / ctx.unit)}`);
        }
      } else {
        const y = (mid.a[1] + mid.b[1]) / 2;
        const x1 = Math.min(mid.a[0], mid.b[0]);
        const x2 = Math.max(mid.a[0], mid.b[0]);
        const tops = obstacles
          .filter((o) => o.bottom <= y + 1 && o.right > x1 && o.left < x2)
          .map((o) => o.bottom);
        const bottoms = obstacles
          .filter((o) => o.top >= y - 1 && o.right > x1 && o.left < x2)
          .map((o) => o.top);
        if (!tops.length || !bottoms.length) continue;
        const want = (Math.max(...tops) + Math.min(...bottoms)) / 2;
        if (Math.abs(y - want) > 4 * ctx.unit) {
          offChannel++;
          offChannelIds.push(`${e.dataset.id}:${Math.round((y - want) / ctx.unit)}`);
        }
      }
    }
    return offChannel
      ? [
          {
            severity: 'fail',
            message: `6.1 ${offChannel} Z edges not centred in their channel (${offChannelIds.slice(0, 3).join(' ')})`,
          },
        ]
      : [];
  },
};

export const clearance: Check = {
  id: '6.1-clearance',
  rule: '6.1',
  run(svg, ctx) {
    const ids = nodeById(ctx);
    const nodeRects = [...ids.entries()].map(
      ([id, n]) => [id, rect(outline(n))] as [string, DOMRect],
    );
    let hugging = 0;
    const hugIds: string[] = [];
    for (const e of edgeEls(ctx)) {
      const { from: fromId, to: toId } = edgeFromTo(e);
      const ctm = e.getScreenCTM();
      if (!ctm) continue;
      const pts = pathPointsHV(e.getAttribute('d'), ctm);
      let hit = false;
      for (let i = 1; i < pts.length && !hit; i++) {
        const x1 = Math.min(pts[i - 1]![0], pts[i]![0]);
        const x2 = Math.max(pts[i - 1]![0], pts[i]![0]);
        const y1 = Math.min(pts[i - 1]![1], pts[i]![1]);
        const y2 = Math.max(pts[i - 1]![1], pts[i]![1]);
        if (x2 - x1 < 8 && y2 - y1 < 8) continue;
        for (const [id, nb] of nodeRects) {
          if (id === fromId || id === toId) continue;
          const clear = 16 * ctx.unit - 1;
          if (
            x1 < nb.right + clear &&
            x2 > nb.left - clear &&
            y1 < nb.bottom + clear &&
            y2 > nb.top - clear
          ) {
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        hugging++;
        hugIds.push(e.dataset.id!);
      }
    }
    return hugging
      ? [
          {
            severity: 'fail',
            message: `6.1 ${hugging} edges within 16 of a foreign node (${hugIds.slice(0, 3).join(' ')})`,
          },
        ]
      : [];
  },
};

export const arrivalSide: Check = {
  id: '6.2-arrival-side',
  rule: '6.2',
  run(svg, ctx) {
    const { geom } = geomAndHairpins(ctx);
    const dirTB = isTB(ctx);
    const flowIn = flowInSides(ctx);
    let wrongArrive = 0;
    const arriveIds: string[] = [];
    for (const [e, g] of geom) {
      const { ra, rb, back, arrives, to } = g;
      const below = rb.top >= ra.bottom - 1;
      const above = rb.bottom <= ra.top + 1;
      const right = rb.left >= ra.right - 1;
      const leftOf = rb.right <= ra.left + 1;
      let want: string;
      if (back) want = flowIn.get(to) || (dirTB ? 'top' : 'left');
      else if (dirTB) want = below ? 'top' : right ? 'left' : leftOf ? 'right' : 'bottom';
      else want = right ? 'left' : below ? 'top' : above ? 'bottom' : 'right';
      if (arrives !== want) {
        wrongArrive++;
        arriveIds.push(`${e.dataset.id}:${arrives}≠${want}`);
      }
    }
    return wrongArrive
      ? [
          {
            severity: 'fail',
            message: `6.2 ${wrongArrive} edges arriving on the wrong side (${arriveIds.slice(0, 3).join(' ')})`,
          },
        ]
      : [];
  },
};

export const selfPierce: Check = {
  id: '6.2-self-pierce',
  rule: '6.2',
  run(svg, ctx) {
    const ids = nodeById(ctx);
    let n = 0;
    const pierceIds: string[] = [];
    for (const e of edgeEls(ctx)) {
      const { from: fromId, to: toId } = edgeFromTo(e);
      const ends = [fromId, toId]
        .map((id) => id && ids.get(id))
        .filter((x): x is SVGGElement => !!x)
        .map((el) => rect(outline(el)));
      if (!ends.length) continue;
      const ctm = e.getScreenCTM();
      if (!ctm) continue;
      const pts = pathPointsHV(e.getAttribute('d'), ctm);
      for (let i = 2; i < pts.length - 1; i++) {
        const x1 = Math.min(pts[i - 1]![0], pts[i]![0]);
        const x2 = Math.max(pts[i - 1]![0], pts[i]![0]);
        const y1 = Math.min(pts[i - 1]![1], pts[i]![1]);
        const y2 = Math.max(pts[i - 1]![1], pts[i]![1]);
        if (x2 - x1 < 2 && y2 - y1 < 2) continue;
        if (
          ends.some(
            (b) => x1 < b.right - 2 && x2 > b.left + 2 && y1 < b.bottom - 2 && y2 > b.top + 2,
          )
        ) {
          n++;
          pierceIds.push(e.dataset.id!);
          break;
        }
      }
    }
    return n
      ? [
          {
            severity: 'fail',
            message: `6.2 ${n} edges passing through their own node (${pierceIds.slice(0, 3).join(' ')})`,
          },
        ]
      : [];
  },
};

export const wrongSide: Check = {
  id: '6.2-wrong-side',
  rule: '6.2',
  run(svg, ctx) {
    const ids = nodeById(ctx);
    let n = 0;
    for (const e of edgeEls(ctx)) {
      if (e.classList.contains('gc-back')) continue;
      const { from: fromId, to: toId } = edgeFromTo(e);
      const A = fromId && ids.get(fromId);
      const B = toId && ids.get(toId);
      if (!A || !B) continue;
      const ra = rect(outline(A));
      const rb = rect(outline(B));
      const pts = pathPoints(e.getAttribute('d'));
      if (pts.length < 1) continue;
      const ctm = e.getScreenCTM();
      if (!ctm) continue;
      const sy = pts[0]![1] * ctm.d + ctm.f;
      const below = rb.top >= ra.bottom - 1;
      const above = rb.bottom <= ra.top + 1;
      const overlapX = rb.left < ra.right && rb.right > ra.left;
      if (below && overlapX && Math.abs(sy - ra.bottom) > 8) n++;
      else if (above && overlapX && Math.abs(sy - ra.top) > 8) n++;
    }
    return n ? [{ severity: 'fail', message: `6.2 ${n} edges leaving the wrong side` }] : [];
  },
};

export const stackedArrowheads: Check = {
  id: '6.3-stacked-arrowheads',
  rule: '6.3',
  run(svg, ctx) {
    if (ctx.chartId === 'er') return [];
    const heads = new Map<string, number>();
    for (const a of svg.querySelectorAll('.gc-arrow[data-id]')) {
      const id = a.getAttribute('data-id')!;
      heads.set(id, (heads.get(id) || 0) + 1);
    }
    const n = [...heads.values()].filter((c) => c > 1).length;
    return n ? [{ severity: 'fail', message: `6.3 ${n} stacked arrowheads` }] : [];
  },
};

export const multiHead: Check = {
  id: '6.3-multi-head',
  rule: '6.3',
  run(svg, ctx) {
    const { geom } = geomAndHairpins(ctx);
    const bySide = new Map<string, SVGPathElement[]>();
    for (const [e, g] of geom) {
      const key = `${g.to}|${g.arrives}`;
      if (!bySide.has(key)) bySide.set(key, []);
      bySide.get(key)!.push(e);
    }
    let multiHeads = 0;
    const multiHeadIds: string[] = [];
    for (const [key, list] of bySide) {
      if (list.length < 2) continue;
      const heads = new Set(
        list
          .map((e) => {
            const h = svg.querySelector(`.gc-arrow[data-id="${e.dataset.id}"]`);
            if (!h) return null;
            const hb = rect(h);
            return `${Math.round(hb.left / ctx.unit)},${Math.round(hb.top / ctx.unit)}`;
          })
          .filter((x): x is string => !!x),
      );
      if (heads.size > 1) {
        multiHeads++;
        multiHeadIds.push(key.replace('|', ':'));
      }
    }
    return multiHeads
      ? [
          {
            severity: 'fail',
            message: `6.3 ${multiHeads} node sides with more than one arrowhead (${multiHeadIds.slice(0, 3).join(' ')})`,
          },
        ]
      : [];
  },
};

export const sharedSegment: Check = {
  id: '6.4-shared-segment',
  rule: '6.4',
  run(svg, ctx) {
    const { shared } = edgeRunOverlaps(ctx);
    return shared
      ? [{ severity: 'fail', message: `6.4 ${shared} edge pairs sharing a segment` }]
      : [];
  },
};

export const parallelClearance: Check = {
  id: '6.4-parallel-clearance',
  rule: '6.4',
  run(svg, ctx) {
    const { crowded, crowdedIds } = edgeRunOverlaps(ctx);
    return crowded
      ? [
          {
            severity: 'fail',
            message: `6.4 ${crowded} parallel edge runs closer than 16 (${crowdedIds.slice(0, 3).join(' ')})`,
          },
        ]
      : [];
  },
};

export const hairpin: Check = {
  id: '6.7-hairpin',
  rule: '6.7',
  run(svg, ctx) {
    const { hairpins } = geomAndHairpins(ctx);
    return hairpins.length
      ? [
          {
            severity: 'fail',
            message: `6.7 ${hairpins.length} hairpins (${hairpins.slice(0, 3).join(' ')})`,
          },
        ]
      : [];
  },
};

export const longLoop: Check = {
  id: '6.7-long-loop',
  rule: '6.7',
  run(svg, ctx) {
    const { geom } = geomAndHairpins(ctx);
    let longLoops = 0;
    const longLoopIds: string[] = [];
    for (const [e, g] of geom) {
      if (!g.back) continue;
      const pts = pathPoints(e.getAttribute('d'));
      let len = 0;
      for (let i = 1; i < pts.length; i++) {
        len += Math.abs(pts[i]![0] - pts[i - 1]![0]) + Math.abs(pts[i]![1] - pts[i - 1]![1]);
      }
      const a = pts[0]!;
      const b = pts[pts.length - 1]!;
      const manhattan = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
      if (len > manhattan + 128) {
        longLoops++;
        longLoopIds.push(`${e.dataset.id}:${Math.round(len)}>${Math.round(manhattan + 128)}`);
      }
    }
    return longLoops
      ? [
          {
            severity: 'fail',
            message: `6.7 ${longLoops} loop-backs longer than the nearest corridor (${longLoopIds.slice(0, 3).join(' ')})`,
          },
        ]
      : [];
  },
};

// degrees/edgeMeta are re-exported only for grid.ts's 2.3 checks that need
// per-node in/out degree without recomputing it.
export { degrees, edgeMeta };

export const EDGE_CHECKS: Check[] = [
  verticalMidline,
  shortJogs,
  detour,
  tooManyBends,
  crossing,
  channelCentre,
  clearance,
  arrivalSide,
  selfPierce,
  wrongSide,
  stackedArrowheads,
  multiHead,
  sharedSegment,
  parallelClearance,
  hairpin,
  longLoop,
];
