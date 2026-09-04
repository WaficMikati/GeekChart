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
 * axis. Measured on the cross axis — horizontal for a TB fan, vertical for
 * an LR one (phase 3a's axis variant; same rule, axes swapped).
 */
export const fanSymmetry: Check = {
  id: '2.8-fan-symmetry',
  rule: '2.8',
  run(svg, ctx) {
    if (!isChannels(svg)) return [];
    const fan = detectFan(ctx);
    if (!fan) return [];
    const ids = nodeById(ctx);
    const tb = svg.dataset.flow !== 'LR' && svg.dataset.flow !== 'RL';
    const lo = (b: DOMRect): number => (tb ? b.left : b.top);
    const hi = (b: DOMRect): number => (tb ? b.right : b.bottom);
    const tol = RULES['2.8']!.threshold! * ctx.unit;
    const hubRect = rect(outline(ids.get(fan.hub)!));
    const hubC = (lo(hubRect) + hi(hubRect)) / 2;
    const leafRects = fan.leaves.map((id) => rect(outline(ids.get(id)!)));
    const groupC = (Math.min(...leafRects.map(lo)) + Math.max(...leafRects.map(hi))) / 2;
    const findings: Finding[] = [];
    if (Math.abs(hubC - groupC) > tol) {
      findings.push({
        severity: 'fail',
        message: `2.8 parent off its children's centre by ${((hubC - groupC) / ctx.unit).toFixed(1)}`,
      });
    }
    // Rows band by flow-axis overlap; each row's own centre holds the axis.
    const flo = (b: DOMRect): number => (tb ? b.top : b.left);
    const fhi = (b: DOMRect): number => (tb ? b.bottom : b.right);
    const rows: { top: number; bottom: number; rects: DOMRect[] }[] = [];
    for (const b of [...leafRects].sort((a, z) => flo(a) - flo(z))) {
      const row = rows.find((r) => flo(b) < r.bottom - 1 && fhi(b) > r.top + 1);
      if (row) {
        row.rects.push(b);
        row.top = Math.min(row.top, flo(b));
        row.bottom = Math.max(row.bottom, fhi(b));
      } else rows.push({ top: flo(b), bottom: fhi(b), rects: [b] });
    }
    let rowsOff = 0;
    for (const row of rows) {
      const c = (Math.min(...row.rects.map(lo)) + Math.max(...row.rects.map(hi))) / 2;
      if (Math.abs(c - groupC) > tol) rowsOff++;
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

/**
 * DESIGN 6.2 (phase 3a): a node side that receives an edge never emits one —
 * the user's own review of git-workflow found Merge with a line out of the
 * same side another came in. Held by construction in the channel planners
 * (arrivals on the flow-in face, departures on the flow-out or a free side
 * face), measured here from the drawn geometry: for each node, each face is
 * either all arrivals or all departures.
 */
export const sideExclusivity: Check = {
  id: '6.2-side-exclusivity',
  rule: '6.2',
  run(svg, ctx) {
    if (!isChannels(svg)) return [];
    const ids = nodeById(ctx);
    const sideOf = (p: [number, number], b: DOMRect): string => {
      const d = [
        Math.abs(p[1] - b.top),
        Math.abs(p[1] - b.bottom),
        Math.abs(p[0] - b.left),
        Math.abs(p[0] - b.right),
      ];
      const m = Math.min(...d);
      return m === d[0] ? 'top' : m === d[1] ? 'bottom' : m === d[2] ? 'left' : 'right';
    };
    const roles = new Map<string, Set<'in' | 'out'>>();
    for (const m of edgeMeta(ctx)) {
      const ctm = m.e.getScreenCTM();
      if (!ctm) continue;
      const pts = pathPointsHV(m.e.getAttribute('d'), ctm);
      if (pts.length < 2) continue;
      const src = m.from && ids.get(m.from);
      const dst = m.to && ids.get(m.to);
      if (src) {
        const key = `${m.from}|${sideOf(pts[0]!, rect(outline(src)))}`;
        if (!roles.has(key)) roles.set(key, new Set());
        roles.get(key)!.add('out');
      }
      if (dst) {
        const key = `${m.to}|${sideOf(pts[pts.length - 1]!, rect(outline(dst)))}`;
        if (!roles.has(key)) roles.set(key, new Set());
        roles.get(key)!.add('in');
      }
    }
    const mixed = [...roles.entries()].filter(([, r]) => r.size > 1).map(([k]) => k);
    return mixed.length
      ? [
          {
            severity: 'fail',
            message: `6.2 ${mixed.length} node sides both receive and emit (${mixed.slice(0, 3).join(' ')})`,
          },
        ]
      : [];
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

/**
 * DESIGN 6.14: returns are buses too. Re-detected from the DOM the way every
 * other check here is — loop-backs are the `gc-back` edges, their groups are
 * the ones sharing a `data-to`, and a "corridor run" is a vertical run of a
 * loop path long enough to be a leg rather than a turn.
 *
 * Four measurements, one per clause of the rule:
 *   - at most one distinct corridor run per flank of the target, within a
 *     group (three workers returning to one hub is one line up one side, not
 *     three concentric rings);
 *   - every shared run drawn once: the runs that fall on one corridor are
 *     coincident copies of a single trunk, so the ink they cover is the
 *     longest of them — not several runs stacked end to end at one x;
 *   - one arrowhead where the group arrives (6.3, earned by construction:
 *     every branch ends at one point, so a second head cannot be drawn);
 *   - across groups, no nesting — neither route's bounding box strictly
 *     contains the other's.
 */
export const returnBus: Check = {
  id: '6.14-return-bus',
  rule: '6.14',
  run(svg, ctx) {
    if (!isChannels(svg)) return [];
    const ids = nodeById(ctx);
    interface Run {
      x: number;
      y1: number;
      y2: number;
    }
    interface Branch {
      id: string;
      pts: [number, number][];
      runs: Run[];
    }
    const groups = new Map<string, Branch[]>();
    for (const m of edgeMeta(ctx)) {
      if (!m.to || !m.e.classList.contains('gc-back')) continue;
      const ctm = m.e.getScreenCTM();
      if (!ctm) continue;
      const pts = pathPointsHV(m.e.getAttribute('d'), ctm);
      if (pts.length < 2) continue;
      const runs: Run[] = [];
      for (let i = 1; i < pts.length; i++) {
        const [x1, y1] = pts[i - 1]!;
        const [x2, y2] = pts[i]!;
        // A corner arc moves ≤12 on each axis; a corridor leg is longer.
        if (Math.abs(x1 - x2) < 1 && Math.abs(y1 - y2) > 16 * ctx.unit) {
          runs.push({ x: x1, y1: Math.min(y1, y2), y2: Math.max(y1, y2) });
        }
      }
      groups.set(m.to, [...(groups.get(m.to) ?? []), { id: m.e.dataset.id!, pts, runs }]);
    }
    if (!groups.size) return [];
    const findings: Finding[] = [];

    for (const [to, branches] of groups) {
      const target = ids.get(to);
      if (!target) continue;
      const tb = rect(outline(target));
      const tc = (tb.left + tb.right) / 2;
      // Cluster every branch's corridor runs by x; a cluster is one drawn
      // vertical line however many branches ride it.
      const clusters: { x: number; runs: Run[] }[] = [];
      for (const b of branches) {
        for (const r of b.runs) {
          // A run on the target's own centre line is the arrival leg, not a
          // corridor: it is the trunk's last drop into the face. Only that
          // line is excused — a corridor that happens to pass under a wide
          // target is still a corridor.
          if (Math.abs(r.x - tc) <= 2 * ctx.unit) continue;
          const c = clusters.find((k) => Math.abs(k.x - r.x) <= 1.5);
          if (c) c.runs.push(r);
          else clusters.push({ x: r.x, runs: [r] });
        }
      }
      for (const flank of [-1, 1] as const) {
        const onFlank = clusters.filter((c) => Math.sign(c.x - tc) === flank);
        if (onFlank.length > 1) {
          findings.push({
            severity: 'fail',
            message:
              `6.14 ${onFlank.length} loop corridors on one flank of ${to} ` +
              `(${onFlank.map((c) => Math.round((c.x - tc) / ctx.unit)).join(' ')})`,
          });
        }
      }
      // Drawn once: within a corridor, the runs are copies of one trunk, so
      // their union is the longest of them. Two runs at one x that do not
      // overlap are two lines, not one.
      for (const c of clusters) {
        const lo = Math.min(...c.runs.map((r) => r.y1));
        const hi = Math.max(...c.runs.map((r) => r.y2));
        const longest = Math.max(...c.runs.map((r) => r.y2 - r.y1));
        if (hi - lo > longest + 1) {
          findings.push({
            severity: 'fail',
            message: `6.14 the corridor into ${to} is drawn as ${c.runs.length} separate runs`,
          });
        }
      }
      // One arrowhead where the group arrives (6.3's merged head).
      const end = branches[0]!.pts[branches[0]!.pts.length - 1]!;
      const scattered = branches.some((b) => {
        const p = b.pts[b.pts.length - 1]!;
        return Math.abs(p[0] - end[0]) > 1.5 || Math.abs(p[1] - end[1]) > 1.5;
      });
      if (branches.length > 1 && scattered) {
        findings.push({
          severity: 'fail',
          message: `6.14 ${branches.length} returns into ${to} arrive at different points`,
        });
      } else {
        let heads = 0;
        for (const a of svg.querySelectorAll('.gc-arrow[data-id]')) {
          const owner = svg.querySelector<SVGPathElement>(
            `.gc-edge[data-id="${a.getAttribute('data-id')}"]`,
          );
          const ctm = owner?.getScreenCTM();
          if (!owner || !ctm) continue;
          const pts = pathPointsHV(owner.getAttribute('d'), ctm);
          const p = pts[pts.length - 1];
          if (!p) continue;
          if (Math.abs(p[0] - end[0]) <= 1.5 && Math.abs(p[1] - end[1]) <= 1.5) heads++;
        }
        if (heads !== 1) {
          findings.push({
            severity: 'fail',
            message: `6.14 ${heads} arrowheads where the returns into ${to} arrive`,
          });
        }
      }
    }

    // Across groups: no nesting.
    const boxes = [...groups.entries()].map(([to, branches]) => {
      const all = branches.flatMap((b) => b.pts);
      return {
        to,
        x1: Math.min(...all.map((p) => p[0])),
        y1: Math.min(...all.map((p) => p[1])),
        x2: Math.max(...all.map((p) => p[0])),
        y2: Math.max(...all.map((p) => p[1])),
      };
    });
    for (const a of boxes) {
      for (const b of boxes) {
        if (a === b) continue;
        if (a.x1 <= b.x1 - 1 && a.y1 <= b.y1 - 1 && a.x2 >= b.x2 + 1 && a.y2 >= b.y2 + 1) {
          findings.push({
            severity: 'fail',
            message: `6.14 the returns into ${b.to} nest inside the returns into ${a.to}`,
          });
        }
      }
    }
    return findings;
  },
};

export const CHANNEL_CHECKS: Check[] = [
  pillOnLine,
  fanSymmetry,
  ribbon,
  sideExclusivity,
  returnBus,
];
