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

    // DESIGN 6.5/10.3: the centre is the midpoint of the run's DRAWN extent —
    // the line as painted, which stops short of the arrowhead — not of the
    // vertex-to-face span. Measured on the end legs of a path, the two the
    // stub and the head shorten; a middle leg is a shared corridor or band,
    // where 6.5's own bus clause and 6.14 place the pill deliberately. A pill
    // the engine had to slide (6.5's one allowed movement) is measured for
    // being on its line, above, and not for centring: something is in the way
    // of the midpoint by construction.
    const offCentre: string[] = [];
    for (const p of all) {
      const e = svg.querySelector<SVGGeometryElement>(`.gc-edge[data-id="${p.id}"]`);
      const ctm = e?.getScreenCTM();
      if (!e || !ctm) continue;
      const pts = pathPointsHV(e.getAttribute('d'), ctm);
      if (pts.length < 2) continue;
      const cx = (p.b.left + p.b.right) / 2;
      const cy = (p.b.top + p.b.bottom) / 2;
      let best = -1;
      let bestD = Infinity;
      for (let i = 1; i < pts.length; i++) {
        const d = distPointSeg(cx, cy, pts[i - 1]![0], pts[i - 1]![1], pts[i]![0], pts[i]![1]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best !== 1 && best !== pts.length - 1) continue;
      const a = pts[best - 1]!;
      const b = pts[best]!;
      const vertical = Math.abs(a[0] - b[0]) < 1;
      const half = (vertical ? p.b.height : p.b.width) / 2;
      const lo = Math.min(vertical ? a[1] : a[0], vertical ? b[1] : b[0]);
      const hi = Math.max(vertical ? a[1] : a[0], vertical ? b[1] : b[0]);
      // Crowded: another pill, or a foreign edge riding the same run, is what
      // the slide exists for.
      const band = (vertical ? p.b.width : p.b.height) / 2 + 2 * ctx.unit;
      let crowded = all.some(
        (q) =>
          q !== p &&
          q.b.left < p.b.right + band &&
          p.b.left < q.b.right + band &&
          q.b.top < p.b.bottom + band &&
          p.b.top < q.b.bottom + band,
      );
      for (const other of svg.querySelectorAll<SVGGeometryElement>('.gc-edge[data-id]')) {
        if (crowded) break;
        if (other.dataset.id === p.id) continue;
        const octm = other.getScreenCTM();
        if (!octm) continue;
        const opts = pathPointsHV(other.getAttribute('d'), octm);
        for (let i = 1; i < opts.length && !crowded; i++) {
          const s1 = opts[i - 1]!;
          const s2 = opts[i]!;
          const near =
            distPointSeg((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, s1[0], s1[1], s2[0], s2[1]) < band ||
            distPointSeg(cx, cy, s1[0], s1[1], s2[0], s2[1]) < band;
          if (near) crowded = true;
        }
      }
      if (crowded) continue;
      const centre = vertical ? cy : cx;
      const drawnMid = (lo + hi) / 2;
      // A run with no slack cannot centre anything; that is 2.7's job, and
      // 2.9's own check measures the flank runs where it matters.
      if (hi - lo < 2 * half) continue;
      if (Math.abs(centre - drawnMid) > ctx.unit) {
        offCentre.push(`${p.id}:${((centre - drawnMid) / ctx.unit).toFixed(1)}`);
      }
    }
    if (offCentre.length) {
      findings.push({
        severity: 'fail',
        message:
          `6.5 ${offCentre.length} pills off the midpoint of their run's drawn extent ` +
          `(${offCentre.slice(0, 3).join(' ')})`,
      });
    }
    return findings;
  },
};

/**
 * DESIGN 2.4: one diamond size per chart. A decision solved from its own
 * label alone gives a chart two diamonds of different sizes — two-diamonds
 * drew First? at 120×64 beside Second? at 136×72 — which breaks 2.3's shared
 * column as well as the look, since a leaf beside the narrower one sits
 * further in.
 */
export const uniformDiamond: Check = {
  id: '2.4-uniform-diamond',
  rule: '2.4',
  run(svg, ctx) {
    if (!isChannels(svg)) return [];
    const sizes: { id: string; w: number; h: number }[] = [];
    for (const [id, n] of nodeById(ctx)) {
      if (!n.classList.contains('gc-shape-diamond')) continue;
      const b = rect(outline(n));
      if (b.width) sizes.push({ id, w: b.width / ctx.unit, h: b.height / ctx.unit });
    }
    if (sizes.length < 2) return [];
    const w = sizes[0]!.w;
    const h = sizes[0]!.h;
    const odd = sizes.filter((s) => Math.abs(s.w - w) > 1 || Math.abs(s.h - h) > 1);
    return odd.length
      ? [
          {
            severity: 'fail',
            message:
              `2.4 ${odd.length + 1} diamonds at different sizes ` +
              `(${sizes.map((s) => `${s.id} ${Math.round(s.w)}×${Math.round(s.h)}`).join(', ')})`,
          },
        ]
      : [];
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

/**
 * DESIGN 2.9: a terminal branch off a decision's side sits on the decision's
 * own row — one straight labeled run from the side vertex to the near face,
 * no rank drop, no bends, the pill on the run (6.5).
 *
 * The pattern is re-detected from the DOM, never assumed: a diamond, a child
 * nothing goes *forward* out of and only that decision enters, and at most
 * one other child — the branch that continues, which holds the axis and
 * leaves through the flow face, so the side vertex the leaf uses is free
 * (6.2). A leaf whose only exit is a loop-back to an earlier rank still
 * counts: the ranker ignores back edges, so that exit orders nothing.
 *
 * The rule's second guard is width: too narrow a flank and the leaf ranks
 * down instead of forcing a scale. Measured here as the room the chart's own
 * canvas has left inside the declared display — with no room to widen, the
 * drop is the rule working and nothing is reported.
 */
export const sameRowLeaf: Check = {
  id: '2.9-same-row-leaf',
  rule: '2.9',
  run(svg, ctx) {
    if (!isChannels(svg)) return [];
    // The rule is written on rows: the TB axis.
    if (svg.dataset.flow === 'LR' || svg.dataset.flow === 'RL') return [];
    const ids = nodeById(ctx);
    const meta = edgeMeta(ctx).filter((m) => m.from && m.to && ids.has(m.from) && ids.has(m.to));
    // Forward out-degree only: a leaf whose single exit loops back to an
    // earlier rank orders nothing downstream, so it is still terminal for
    // 2.9. Arrivals stay counted in full — the leaf's only way in must be
    // the decision's own run.
    const fwdOut = new Map<string, number>();
    const inDeg = new Map<string, number>();
    const loopy = new Set<string>();
    for (const m of meta) {
      inDeg.set(m.to!, (inDeg.get(m.to!) ?? 0) + 1);
      if (m.e.classList.contains('gc-back')) {
        loopy.add(m.from!);
        loopy.add(m.to!);
      } else {
        fwdOut.set(m.from!, (fwdOut.get(m.from!) ?? 0) + 1);
      }
    }
    const tol = RULES['2.9']!.threshold! * ctx.unit;
    const display = Number(svg.dataset.display ?? '0');
    const spare = (display || ctx.vb.width) - ctx.vb.width; // canvas units left
    const plateOf = new Map(plates(ctx).map((p) => [p.id, p.b] as const));
    const findings: Finding[] = [];
    const flankLeaves: { dir: -1 | 1; id: string; box: DOMRect }[] = [];

    for (const [id, node] of ids) {
      if (!node.classList.contains('gc-shape-diamond') || loopy.has(id)) continue;
      const kids = meta.filter((m) => m.from === id && !m.e.classList.contains('gc-back'));
      const term = kids.filter((m) => !fwdOut.get(m.to!) && inDeg.get(m.to!) === 1);
      const cont = kids.filter((m) => !term.includes(m));
      if (!term.length || term.length > 2 || cont.length > 1) continue;
      if (!cont.length && term.length !== 2) continue;
      const db = rect(outline(node));
      const dcy = (db.top + db.bottom) / 2;
      for (const m of term) {
        const leaf = ids.get(m.to!)!;
        const lb = rect(outline(leaf));
        // Guard: the flank has to fit the declared display.
        if (spare < lb.width / ctx.unit + 24) continue;
        const off = Math.abs((lb.top + lb.bottom) / 2 - dcy) / ctx.unit;
        if (off > RULES['2.9']!.threshold!) {
          findings.push({
            severity: 'fail',
            message: `2.9 terminal leaf ${m.to} sits ${off.toFixed(0)} off ${id}'s row`,
          });
          continue;
        }
        const ctm = m.e.getScreenCTM();
        if (!ctm) continue;
        const pts = pathPointsHV(m.e.getAttribute('d'), ctm);
        const straight =
          pts.length === 2 && Math.abs(pts[0]![1] - pts[1]![1]) <= tol;
        if (!straight) {
          findings.push({
            severity: 'fail',
            message: `2.9 the run ${id}→${m.to} is not one straight segment (${pts.length} points)`,
          });
          continue;
        }
        // From the decision's own side vertex to the leaf's near face.
        const x1 = Math.min(pts[0]![0], pts[1]![0]);
        const x2 = Math.max(pts[0]![0], pts[1]![0]);
        const rightward = pts[0]![0] < pts[1]![0];
        const vertex = rightward ? db.right : db.left;
        const face = rightward ? lb.left : lb.right;
        // Both ends stand off their own face — the edge gap at the start,
        // the arrowhead at the end — so the join is measured to a standoff,
        // not to the pixel.
        const standoff = 16 * ctx.unit;
        if (Math.abs(pts[0]![0] - vertex) > standoff || Math.abs(pts[1]![0] - face) > standoff) {
          findings.push({
            severity: 'fail',
            message: `2.9 the run ${id}→${m.to} does not join the side vertex to the near face`,
          });
        }
        flankLeaves.push({ dir: rightward ? 1 : -1, id: m.to!, box: lb });
        const plate = plateOf.get(m.e.dataset.id ?? '');
        if (plate) {
          const pcy = (plate.top + plate.bottom) / 2;
          if (
            Math.abs(pcy - pts[0]![1]) > tol ||
            plate.left < x1 - tol ||
            plate.right > x2 + tol
          ) {
            findings.push({
              severity: 'fail',
              message: `2.9 the label on ${id}→${m.to} is not centred on its run`,
            });
          }
          // The gutter is derived from the pill plus 16 of visible line
          // either side (2.9's geometry), so a run always reads as a line
          // with a label on it, never as two nubs — and the pill sits on the
          // midpoint of the DRAWN extent, so the two stubs match.
          const before = (plate.left - x1) / ctx.unit;
          const after = (x2 - plate.right) / ctx.unit;
          if (before < 15 || after < 15) {
            findings.push({
              severity: 'fail',
              message:
                `2.9 the run ${id}→${m.to} shows ${before.toFixed(1)}/${after.toFixed(1)} ` +
                `of line either side of its pill (16 each)`,
            });
          } else if (Math.abs(before - after) > 1) {
            findings.push({
              severity: 'fail',
              message:
                `2.9 the pill on ${id}→${m.to} is off the drawn midpoint: ` +
                `${before.toFixed(1)} of line one side, ${after.toFixed(1)} the other`,
            });
          }
        }
      }
    }

    // DESIGN 2.3 applied to flanks: one chart-wide gutter, so every leaf on
    // one flank shares an exact x however many rows apart they sit —
    // two-diamonds' Beta and Gamma, diamond-cascade's two Rejects.
    for (const dir of [-1, 1] as const) {
      const side = flankLeaves.filter((f) => f.dir === dir);
      if (side.length < 2) continue;
      const near = (f: (typeof side)[number]) => (dir === 1 ? f.box.left : f.box.right);
      const spread = Math.max(...side.map(near)) - Math.min(...side.map(near));
      if (spread > ctx.unit) {
        findings.push({
          severity: 'fail',
          message:
            `2.9 ${side.length} leaves on one flank sit at ${(spread / ctx.unit).toFixed(1)} ` +
            `different x (${side.map((f) => f.id).join(' ')})`,
        });
      }
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
  sameRowLeaf,
  uniformDiamond,
  ribbon,
  sideExclusivity,
  returnBus,
];
