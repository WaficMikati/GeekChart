/**
 * Checks for charts drawn by the channel engine (DESIGN 2.7) — keyed on the
 * `data-gc-engine="channels"` attribute `draw.ts` stamps on the SVG root, so
 * none of them ever fires on an old-path chart. Modeled on `ringLayout`
 * (canvas.ts): the shape is re-detected from the DOM itself, never assumed.
 */
import { RULES } from '@geekchart/core';
import {
  edgeMeta,
  nodeById,
  outline,
  pathPointsHV,
  rect,
  visible,
  type Check,
  type Ctx,
  type Finding,
} from './helpers.ts';

/** True for a chart the channel engine laid out. */
export function isChannels(svg: SVGSVGElement): boolean {
  return svg.dataset.gcEngine === 'channels';
}

function distPointSeg(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

interface PlateBox {
  id: string;
  b: DOMRect;
}

function plates(ctx: Ctx): PlateBox[] {
  return ctx.memo('channelPlates', () => {
    const out: PlateBox[] = [];
    for (const g of ctx.svg.querySelectorAll('.gc-edge-label[data-id]')) {
      const plate = g.querySelector('.gc-plate');
      if (!plate || !visible(plate, ctx.svg)) continue;
      const b = rect(plate);
      if (b.width) out.push({ id: g.getAttribute('data-id')!, b });
    }
    return out;
  });
}

/**
 * DESIGN 6.5 as the channel engine implements it: every pill's centre sits
 * within 1 of its own edge's drawn path, and pills overlap nothing — not
 * each other, not a node. (The old beside-the-line placement checks are
 * branched off for these charts; this is their replacement.)
 */
export const pillOnLine: Check = {
  id: '6.5-pill-on-line',
  rule: '6.5',
  run(svg, ctx) {
    if (!isChannels(svg)) return [];
    const findings: Finding[] = [];
    const tol = RULES['6.5-on-line']!.threshold! * ctx.unit;
    const all = plates(ctx);

    let offLine = 0;
    const offIds: string[] = [];
    for (const p of all) {
      const e = svg.querySelector<SVGGeometryElement>(`.gc-edge[data-id="${p.id}"]`);
      const ctm = e?.getScreenCTM();
      if (!e || !ctm) continue;
      const pts = pathPointsHV(e.getAttribute('d'), ctm);
      const cx = (p.b.left + p.b.right) / 2;
      const cy = (p.b.top + p.b.bottom) / 2;
      let nearest = Infinity;
      for (let i = 1; i < pts.length; i++) {
        nearest = Math.min(
          nearest,
          distPointSeg(cx, cy, pts[i - 1]![0], pts[i - 1]![1], pts[i]![0], pts[i]![1]),
        );
      }
      if (nearest > tol) {
        offLine++;
        offIds.push(`${p.id}:${(nearest / ctx.unit).toFixed(1)}`);
      }
    }
    if (offLine) {
      findings.push({
        severity: 'fail',
        message: `6.5 ${offLine} pills off their own line (${offIds.slice(0, 3).join(' ')})`,
      });
    }

    let pillPill = 0;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!.b;
        const b = all[j]!.b;
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1)
          pillPill++;
      }
    }
    let pillNode = 0;
    for (const p of all) {
      for (const n of nodeById(ctx).values()) {
        const nb = rect(outline(n));
        if (!nb.width) continue;
        if (
          p.b.left < nb.right - 1 &&
          nb.left < p.b.right - 1 &&
          p.b.top < nb.bottom - 1 &&
          nb.top < p.b.bottom - 1
        )
          pillNode++;
      }
    }
    if (pillPill || pillNode) {
      findings.push({
        severity: 'fail',
        message: `6.5 pill overlaps: ${pillPill} pill/pill, ${pillNode} pill/node`,
      });
    }
    return findings;
  },
};

/** A fan re-detected from the DOM: one hub, every other node one edge to or
 *  from it. Returns null when the chart is not that shape. */
function detectFan(ctx: Ctx): { hub: string; leaves: string[] } | null {
  const ids = nodeById(ctx);
  const meta = edgeMeta(ctx).filter((m) => m.from && m.to);
  if (ids.size < 4 || meta.length !== ids.size - 1) return null;
  for (const dir of ['from', 'to'] as const) {
    const counts = new Map<string, number>();
    for (const m of meta) counts.set(m[dir]!, (counts.get(m[dir]!) ?? 0) + 1);
    const hub = [...counts.entries()].find(([, c]) => c === ids.size - 1)?.[0];
    if (!hub || !ids.has(hub)) continue;
    const other = dir === 'from' ? 'to' : 'from';
    const leaves = meta.map((m) => m[other]!);
    if (new Set(leaves).size === ids.size - 1 && leaves.every((l) => l !== hub && ids.has(l))) {
      return { hub, leaves };
    }
  }
  return null;
}

/**
 * DESIGN 2.8: the parent sits centred on the geometric extent of its
 * children as a group, within ±1, and every wrapped row centres on the same
 * axis.
 */
export const fanSymmetry: Check = {
  id: '2.8-fan-symmetry',
  rule: '2.8',
  run(svg, ctx) {
    if (!isChannels(svg)) return [];
    const fan = detectFan(ctx);
    if (!fan) return [];
    const ids = nodeById(ctx);
    const tol = RULES['2.8']!.threshold! * ctx.unit;
    const hubRect = rect(outline(ids.get(fan.hub)!));
    const hubCx = (hubRect.left + hubRect.right) / 2;
    const leafRects = fan.leaves.map((id) => rect(outline(ids.get(id)!)));
    const groupCx =
      (Math.min(...leafRects.map((b) => b.left)) + Math.max(...leafRects.map((b) => b.right))) / 2;
    const findings: Finding[] = [];
    if (Math.abs(hubCx - groupCx) > tol) {
      findings.push({
        severity: 'fail',
        message: `2.8 parent off its children's centre by ${((hubCx - groupCx) / ctx.unit).toFixed(1)}`,
      });
    }
    // Rows band by vertical overlap; each row's own centre holds the axis.
    const rows: { top: number; bottom: number; rects: DOMRect[] }[] = [];
    for (const b of [...leafRects].sort((a, z) => a.top - z.top)) {
      const row = rows.find((r) => b.top < r.bottom - 1 && b.bottom > r.top + 1);
      if (row) {
        row.rects.push(b);
        row.top = Math.min(row.top, b.top);
        row.bottom = Math.max(row.bottom, b.bottom);
      } else rows.push({ top: b.top, bottom: b.bottom, rects: [b] });
    }
    let rowsOff = 0;
    for (const row of rows) {
      const cx =
        (Math.min(...row.rects.map((b) => b.left)) + Math.max(...row.rects.map((b) => b.right))) / 2;
      if (Math.abs(cx - groupCx) > tol) rowsOff++;
    }
    if (rowsOff) {
      findings.push({
        severity: 'fail',
        message: `2.8 ${rowsOff} wrapped rows off the fan's axis`,
      });
    }
    return findings;
  },
};

/** A chain re-detected from the DOM: unique forward next-map covering every
 *  node once, start to end. */
function detectChain(ctx: Ctx): string[] | null {
  const ids = nodeById(ctx);
  const meta = edgeMeta(ctx).filter((m) => m.from && m.to);
  if (ids.size < 4 || meta.length !== ids.size - 1) return null;
  const next = new Map<string, string>();
  const hasParent = new Set<string>();
  for (const m of meta) {
    if (m.from === m.to || next.has(m.from!)) return null;
    next.set(m.from!, m.to!);
    hasParent.add(m.to!);
  }
  const start = [...ids.keys()].find((id) => !hasParent.has(id));
  if (!start) return null;
  const order = [start];
  const seen = new Set([start]);
  let cur = start;
  while (next.has(cur)) {
    const nxt = next.get(cur)!;
    if (seen.has(nxt)) return null;
    order.push(nxt);
    seen.add(nxt);
    cur = nxt;
  }
  return order.length === ids.size ? order : null;
}

/**
 * DESIGN 1.9: a channel chain is a reading-order ribbon — every row reads
 * left to right, and the turn count (edges connecting different rows) is
 * exactly rows − 1. A single column is the degenerate vertical list: no
 * returns at all.
 */
export const ribbon: Check = {
  id: '1.9-ribbon',
  rule: '1.9',
  run(svg, ctx) {
    if (!isChannels(svg)) return [];
    const order = detectChain(ctx);
    if (!order) return [];
    const ids = nodeById(ctx);
    const rects = order.map((id) => rect(outline(ids.get(id)!)));
    // Band the chain's nodes into rows by vertical overlap, in chain order.
    const rowIndex: number[] = [];
    const rows: { top: number; bottom: number }[] = [];
    for (const b of rects) {
      let idx = rows.findIndex((r) => b.top < r.bottom - 1 && b.bottom > r.top + 1);
      if (idx === -1) {
        rows.push({ top: b.top, bottom: b.bottom });
        idx = rows.length - 1;
      } else {
        rows[idx]!.top = Math.min(rows[idx]!.top, b.top);
        rows[idx]!.bottom = Math.max(rows[idx]!.bottom, b.bottom);
      }
      rowIndex.push(idx);
    }
    const findings: Finding[] = [];
    // Every row reads left-to-right: within a row, successive chain members
    // sit strictly further right.
    let wrongWay = 0;
    for (let i = 1; i < order.length; i++) {
      if (rowIndex[i] === rowIndex[i - 1] && rects[i]!.left <= rects[i - 1]!.left) wrongWay++;
    }
    if (wrongWay) {
      findings.push({
        severity: 'fail',
        message: `1.9 ${wrongWay} chain steps running right-to-left inside a row`,
      });
    }
    const turns = rowIndex.filter((r, i) => i > 0 && r !== rowIndex[i - 1]).length;
    const rowCount = new Set(rowIndex).size;
    // A vertical list is one node per row — n−1 "turns" by this count, but
    // zero returns; only a genuine multi-column ribbon is measured here.
    const vertical = rowCount === order.length;
    if (!vertical && turns !== rowCount - 1) {
      findings.push({
        severity: 'fail',
        message: `1.9 ribbon has ${turns} turns for ${rowCount} rows (expected ${rowCount - 1})`,
      });
    }
    return findings;
  },
};

export const CHANNEL_CHECKS: Check[] = [pillOnLine, fanSymmetry, ribbon];
