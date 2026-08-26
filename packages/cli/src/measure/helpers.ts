/**
 * Shared bits for the DESIGN.md checks: rect/visibility helpers, path parsing,
 * and the handful of derived structures (node lookup, edge endpoints, edge
 * geometry with arrival sides) that more than one rule group needs. Each is
 * cached on the `Ctx` for the lifetime of one `measureChart` call, so a chart
 * with many checks pays for e.g. building `nodeById` once, not once per check.
 *
 * This runs inside the page (bundled into dist/measure.js), so it only uses
 * DOM APIs available there — no Node built-ins.
 */

export type Severity = 'fail' | 'warn';

export interface Finding {
  severity: Severity;
  message: string;
}

export interface Check {
  /** Stable id, `<rule>-<slug>`. */
  id: string;
  /** The DESIGN.md rule number this check enforces. */
  rule: string;
  run(svg: SVGSVGElement, ctx: Ctx): Finding[];
}

export interface MeasureOptions {
  /** The narrowest common viewer width; DESIGN 3.1 measures on-screen size here. */
  stagePx?: number;
  /** The chart's short id (e.g. "er") — ER's crow's-foot marks are legitimately
   *  several `.gc-arrow` per edge, which the 6.3 stacked-arrowheads check exempts. */
  chartId?: string;
}

export interface Ctx {
  svg: SVGSVGElement;
  vb: { width: number; height: number };
  /** The svg's on-screen rect. */
  sb: DOMRect;
  /** Screen pixels per viewBox unit. */
  unit: number;
  stagePx: number;
  chartId: string;
  /** Compute-once-per-chart cache, keyed by an arbitrary string the caller picks. */
  memo<T>(key: string, compute: () => T): T;
}

export function createCtx(svg: SVGSVGElement, opts: MeasureOptions = {}): Ctx {
  const vbb = svg.viewBox.baseVal;
  const sb = svg.getBoundingClientRect();
  const cache = new Map<string, unknown>();
  return {
    svg,
    vb: { width: vbb.width, height: vbb.height },
    sb,
    unit: sb.width / vbb.width,
    stagePx: opts.stagePx ?? 760,
    chartId: opts.chartId ?? '',
    memo<T>(key: string, compute: () => T): T {
      if (!cache.has(key)) cache.set(key, compute());
      return cache.get(key) as T;
    },
  };
}

export const rect = (el: Element): DOMRect => el.getBoundingClientRect();

/** True unless `el` or an ancestor up to (not including) `root` is hidden. */
export function visible(el: Element, root: Element): boolean {
  for (let e: Element | null = el; e && e !== root; e = e.parentElement) {
    const cs = getComputedStyle(e);
    if (cs.opacity === '0' || cs.display === 'none' || cs.visibility === 'hidden') return false;
  }
  return true;
}

/**
 * Every number in a path's `d`, paired as (x, y). Correct for every path this
 * renderer draws with M/L only (all node and edge geometry) — a path built
 * with H, V, Q or C needs {@link pathPointsHV} instead.
 */
export function pathPoints(d: string | null): [number, number][] {
  const nums = (d || '').match(/-?\d+(\.\d+)?/g)?.map(Number) || [];
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i]!, nums[i + 1]!]);
  return pts;
}

/**
 * Command-aware path walk: M/L/H/V/Q/C all update a running (x, y), so an H or
 * V segment (as git-graph connectors use) still yields one point per vertex.
 * Points are transformed to screen space by `ctm`.
 */
export function pathPointsHV(d: string | null, ctm: DOMMatrix): [number, number][] {
  const pts: [number, number][] = [];
  let cx = 0;
  let cy = 0;
  for (const seg of (d || '').matchAll(/([MLHVQCZ])([^MLHVQCZ]*)/gi)) {
    const cmd = seg[1]!.toUpperCase();
    const ns = (seg[2]!.match(/-?\d+(\.\d+)?/g) || []).map(Number);
    if (cmd === 'H') cx = ns[0]!;
    else if (cmd === 'V') cy = ns[0]!;
    else if (ns.length >= 2) {
      cx = ns[ns.length - 2]!;
      cy = ns[ns.length - 1]!;
    } else continue;
    pts.push([cx * ctm.a + ctm.e, cy * ctm.d + ctm.f]);
  }
  return pts;
}

/** The rect a node's box is drawn as. */
export function outline(n: Element): Element {
  return n.querySelector('.gc-outline,.gc-fill') || n;
}

/** An edge's endpoints, from `data-from`/`data-to` or the `L_<from>_<to>_n` id. */
export function edgeFromTo(e: Element): { from: string | null; to: string | null } {
  const m = (e.getAttribute('data-id') || '').match(/^L_(.+?)_(.+?)_\d+$/);
  return {
    from: e.getAttribute('data-from') || (m && m[1]) || null,
    to: e.getAttribute('data-to') || (m && m[2]) || null,
  };
}

export function nodeById(ctx: Ctx): Map<string, SVGGElement> {
  return ctx.memo('nodeById', () => {
    const map = new Map<string, SVGGElement>();
    for (const n of ctx.svg.querySelectorAll('.gc-node[data-id]')) {
      map.set(n.getAttribute('data-id')!, n as SVGGElement);
    }
    return map;
  });
}

export function edgeEls(ctx: Ctx): SVGPathElement[] {
  return ctx.memo(
    'edgeEls',
    () => [...ctx.svg.querySelectorAll('.gc-edge[data-id]')] as SVGPathElement[],
  );
}

export function texts(ctx: Ctx): SVGTextElement[] {
  return ctx.memo(
    'texts',
    () =>
      [...ctx.svg.querySelectorAll('text')].filter(
        (t) => visible(t, ctx.svg) && (t.textContent || '').trim(),
      ) as SVGTextElement[],
  );
}

export function clusters(ctx: Ctx): Element[] {
  return ctx.memo('clusters', () => [...ctx.svg.querySelectorAll('.gc-cluster')]);
}

/** One entry per edge with a resolvable id, whether or not it names real nodes. */
export function edgeMeta(
  ctx: Ctx,
): { e: SVGPathElement; from: string | null; to: string | null }[] {
  return ctx.memo('edgeMeta', () => edgeEls(ctx).map((e) => ({ e, ...edgeFromTo(e) })));
}

export interface EdgeGeom {
  A: SVGGElement;
  B: SVGGElement;
  ra: DOMRect;
  rb: DOMRect;
  back: boolean;
  arrives: 'top' | 'bottom' | 'left' | 'right';
  from: string;
  to: string;
}

/** The side of `rb` that `end` is closest to. */
function sideOfEnd(end: [number, number], rb: DOMRect): 'top' | 'bottom' | 'left' | 'right' {
  const dT = Math.abs(end[1] - rb.top);
  const dB = Math.abs(end[1] - rb.bottom);
  const dL = Math.abs(end[0] - rb.left);
  const dR = Math.abs(end[0] - rb.right);
  const m = Math.min(dT, dB, dL, dR);
  return m === dT ? 'top' : m === dB ? 'bottom' : m === dL ? 'left' : 'right';
}

/** Whether the chart flows top-to-bottom: `data-flow` if present, else majority vote. */
export function isTB(ctx: Ctx): boolean {
  return ctx.memo('isTB', () => {
    const ids = nodeById(ctx);
    let downCount = 0;
    let rightCount = 0;
    for (const { e, from, to } of edgeMeta(ctx)) {
      const A = from && ids.get(from);
      const B = to && ids.get(to);
      if (!A || !B || e.classList.contains('gc-back')) continue;
      const ra = rect(A);
      const rb = rect(B);
      if (rb.top >= ra.bottom - 1) downCount++;
      else if (rb.left >= ra.right - 1) rightCount++;
    }
    const declared = ctx.svg.dataset.flow;
    return declared ? /^(TB|TD|BT)$/.test(declared) : downCount >= rightCount;
  });
}

/**
 * Per-forward-edge geometry (endpoints, rects, arrival side), plus hairpins —
 * two consecutive bends turning back within 24 units — found along the way
 * since both walk the same run-collapsed points. Shared by the 6.2 arrival,
 * 2.3 sole-child and 6.7 hairpin/long-loop checks.
 */
export function geomAndHairpins(ctx: Ctx): {
  geom: Map<SVGPathElement, EdgeGeom>;
  hairpins: string[];
} {
  return ctx.memo('geomAndHairpins', () => {
    const ids = nodeById(ctx);
    const geom = new Map<SVGPathElement, EdgeGeom>();
    const hairpinIds: string[] = [];
    for (const { e, from, to } of edgeMeta(ctx)) {
      const ctm = e.getScreenCTM();
      if (!ctm) continue;
      const nums = (e.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g)?.map(Number) || [];
      const pts: [number, number][] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        pts.push([nums[i]! * ctm.a + ctm.e, nums[i + 1]! * ctm.d + ctm.f]);
      }
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
      for (let k = 0; k + 2 < runs.length; k++) {
        const s0 = runs[k]!;
        const s1 = runs[k + 1]!;
        const s2 = runs[k + 2]!;
        const len1 = Math.hypot(s1.b[0] - s1.a[0], s1.b[1] - s1.a[1]) / ctx.unit;
        const d0 = s0.dir === 'h' ? Math.sign(s0.b[0] - s0.a[0]) : Math.sign(s0.b[1] - s0.a[1]);
        const d2 = s2.dir === 'h' ? Math.sign(s2.b[0] - s2.a[0]) : Math.sign(s2.b[1] - s2.a[1]);
        if (s0.dir === s2.dir && d0 === -d2 && len1 < 24) {
          hairpinIds.push(e.dataset.id!);
          break;
        }
      }
      const A = from && ids.get(from);
      const B = to && ids.get(to);
      if (!A || !B || !pts.length) continue;
      const ra = rect(outline(A));
      const rb = rect(outline(B));
      const back = e.classList.contains('gc-back');
      geom.set(e, {
        A,
        B,
        ra,
        rb,
        back,
        arrives: sideOfEnd(pts[pts.length - 1]!, rb),
        from: from!,
        to: to!,
      });
    }
    return { geom, hairpins: hairpinIds };
  });
}

/** Forward in-degree / out-degree per node id, ignoring back edges. */
export function degrees(ctx: Ctx): { parents: Map<string, number>; children: Map<string, number> } {
  return ctx.memo('degrees', () => {
    const parents = new Map<string, number>();
    const children = new Map<string, number>();
    for (const { e, from, to } of edgeMeta(ctx)) {
      if (!from || !to || e.classList.contains('gc-back')) continue;
      children.set(from, (children.get(from) || 0) + 1);
      parents.set(to, (parents.get(to) || 0) + 1);
    }
    return { parents, children };
  });
}

export interface CompositionRows {
  rowsOff: number;
  rowOffIds: string[];
  rowGaps: number;
  rowGapIds: string[];
}

/**
 * In a chart with panels, group top-level boxes (panel boxes, and nodes
 * outside any panel) into rows by vertical overlap. 7.3: each row is centred
 * on the whole composition's centre within 8 units. 2.3: gutters inside a row
 * are the standard 32 (±8) unless the flanking items are column-aligned with
 * something in the row above or below. Shared because both walk the same rows.
 */
export function compositionRows(ctx: Ctx): CompositionRows {
  return ctx.memo('compositionRows', () => {
    const result: CompositionRows = { rowsOff: 0, rowOffIds: [], rowGaps: 0, rowGapIds: [] };
    const cls = clusters(ctx);
    if (!cls.length) return result;
    const boxes: { id: string; b: DOMRect }[] = [];
    for (const c of cls) {
      const bx = c.querySelector('.gc-cluster-box, rect');
      if (bx && visible(bx, ctx.svg))
        boxes.push({ id: (c as HTMLElement).dataset.id || 'panel', b: rect(bx) });
    }
    for (const n of ctx.svg.querySelectorAll('.gc-node')) {
      const nb = rect(n);
      if (!nb.width) continue;
      const cx = (nb.left + nb.right) / 2;
      const cy = (nb.top + nb.bottom) / 2;
      const inPanel = boxes.some(
        ({ b }) => cx > b.left && cx < b.right && cy > b.top && cy < b.bottom,
      );
      if (!inPanel) boxes.push({ id: (n as HTMLElement).dataset.id || 'node', b: nb });
    }
    const rows: { top: number; bottom: number; items: { id: string; b: DOMRect }[] }[] = [];
    for (const bx of boxes.sort((a, b) => a.b.top - b.b.top)) {
      const row = rows.find((rw) => bx.b.top < rw.bottom - 1 && bx.b.bottom > rw.top + 1);
      if (row) {
        row.items.push(bx);
        row.top = Math.min(row.top, bx.b.top);
        row.bottom = Math.max(row.bottom, bx.b.bottom);
      } else rows.push({ top: bx.b.top, bottom: bx.b.bottom, items: [bx] });
    }
    const allL = Math.min(...boxes.map((x) => x.b.left));
    const allR = Math.max(...boxes.map((x) => x.b.right));
    const centre = (allL + allR) / 2;
    for (const rw of rows) {
      const l = Math.min(...rw.items.map((x) => x.b.left));
      const rg = Math.max(...rw.items.map((x) => x.b.right));
      const off = ((l + rg) / 2 - centre) / ctx.unit;
      if (Math.abs(off) > 8) {
        result.rowsOff++;
        result.rowOffIds.push(`${rw.items.map((x) => x.id).join('+')}:${Math.round(off)}`);
      }
    }
    const sorted = rows.map((rw) => [...rw.items].sort((a, b) => a.b.left - b.b.left));
    for (let ri = 0; ri < sorted.length; ri++) {
      const neighbours = [sorted[ri - 1], sorted[ri + 1]].filter(Boolean).flat() as {
        id: string;
        b: DOMRect;
      }[];
      const aligned = (it: { id: string; b: DOMRect }) =>
        neighbours.some(
          (o) => Math.abs((o.b.left + o.b.right) / 2 - (it.b.left + it.b.right) / 2) < 8 * ctx.unit,
        );
      const row = sorted[ri]!;
      for (let k = 1; k < row.length; k++) {
        const a = row[k - 1]!;
        const b = row[k]!;
        const gap = (b.b.left - a.b.right) / ctx.unit;
        if (Math.abs(gap - 32) > 8 && !(aligned(a) && aligned(b))) {
          result.rowGaps++;
          result.rowGapIds.push(`${a.id}|${b.id}:${Math.round(gap)}`);
        }
      }
    }
    return result;
  });
}

/** What each node's forward in-edges arrive on — the side the flow enters. */
export function flowInSides(ctx: Ctx): Map<string, string> {
  return ctx.memo('flowInSides', () => {
    const { geom } = geomAndHairpins(ctx);
    const flowIn = new Map<string, string>();
    for (const g of geom.values()) {
      if (!g.back && !flowIn.has(g.to)) flowIn.set(g.to, g.arrives);
    }
    return flowIn;
  });
}
