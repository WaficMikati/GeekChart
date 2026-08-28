/**
 * DESIGN.md §1 (canvas), §7.3/7.4 (centring, coverage, orphan columns),
 * §7.5 (clipping), §7.6 (native drawing).
 */
import { RULES, tokens } from '@geekchart/core';
const { CANVAS } = tokens;
import {
  clusters,
  compositionRows,
  edgeMeta,
  nodeById,
  outline,
  rect,
  texts,
  visible,
  type Check,
  type Ctx,
} from './helpers.ts';

function contentBBox(ctx: Ctx): { minX: number; minY: number; maxX: number; maxY: number } {
  return ctx.memo('contentBBox', () => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of ctx.svg.querySelectorAll(
      '.gc-node, .gc-cluster, .gc-edge, text, rect, path',
    )) {
      if (!visible(el, ctx.svg)) continue;
      const b = rect(el);
      if (!b.width) continue;
      minX = Math.min(minX, b.left);
      minY = Math.min(minY, b.top);
      maxX = Math.max(maxX, b.right);
      maxY = Math.max(maxY, b.bottom);
    }
    return { minX, minY, maxX, maxY };
  });
}

interface ChainInfo {
  chain: string[];
  rows: number;
  wraps: boolean;
}

/**
 * 1.2's wrapped-chain fold: follow the primary path's forward edges from its
 * unparented start, then note whether the chain ever steps down-and-left (a
 * wrap) and how many 8-unit row bands its inner nodes fall into.
 */
function chainInfo(ctx: Ctx): { chainInfo: ChainInfo | null; unbalanced: string } {
  return ctx.memo('chainInfo', () => {
    const pathNodes = [...ctx.svg.querySelectorAll('.gc-node.gc-role-path[data-id]')];
    if (pathNodes.length < 4) return { chainInfo: null, unbalanced: '' };
    const ordered = pathNodes.map(
      (n) => [n.getAttribute('data-id')!, rect(outline(n))] as [string, DOMRect],
    );
    const pathIds = new Set(ordered.map(([id]) => id));
    const next = new Map<string, string>();
    const hasParent = new Set<string>();
    for (const g of edgeMeta(ctx)) {
      if (
        g.from &&
        g.to &&
        pathIds.has(g.from) &&
        pathIds.has(g.to) &&
        !g.e.classList.contains('gc-back')
      ) {
        if (!next.has(g.from)) next.set(g.from, g.to);
        hasParent.add(g.to);
      }
    }
    let cur = ordered.find(([id]) => !hasParent.has(id))?.[0];
    const chain: string[] = [];
    while (cur && !chain.includes(cur)) {
      chain.push(cur);
      cur = next.get(cur);
    }
    if (chain.length < 4) return { chainInfo: null, unbalanced: '' };
    const inner = chain.slice(1, -1);
    const rowsMap = new Map<number, number>();
    let wraps = false;
    for (let k = 1; k < chain.length; k++) {
      const a = ordered.find(([i]) => i === chain[k - 1])![1];
      const b = ordered.find(([i]) => i === chain[k])![1];
      if (b.top >= a.bottom - 1 && b.right <= a.left + 1) wraps = true;
    }
    const info: ChainInfo = { chain, rows: 0, wraps };
    for (const id of inner) {
      const b = ordered.find(([i]) => i === id)![1];
      const cy = Math.round((b.top + b.bottom) / 2 / ctx.unit / 8);
      rowsMap.set(cy, (rowsMap.get(cy) || 0) + 1);
    }
    const counts = [...rowsMap.values()];
    info.rows = counts.length;
    let unbalanced = '';
    if (counts.length >= 2 && Math.max(...counts) - Math.min(...counts) > 1)
      unbalanced = counts.join('/');
    return { chainInfo: info, unbalanced };
  });
}

export const canvasWidth: Check = {
  id: '1.1-canvas-width',
  rule: '1.1',
  run(svg) {
    const w = Math.round(svg.viewBox.baseVal.width);
    const display = Number(svg.dataset.display) || 1000;
    // DESIGN 1.1: the 480 floor is there so an undeclared-display chart never
    // renders embarrassingly narrow — but a caller naming a phone column
    // below that has already said what narrow means for them, and holding
    // them to 480 anyway would force a scale-down past the very cap this
    // option exists to respect (revised 2026-08-28 alongside 1.6).
    const min = Math.min(CANVAS.min, display);
    if (w < min || w > CANVAS.max) return [{ severity: 'fail', message: `1.1 canvas ${w}w` }];
    // DESIGN 1.5: leaf stacking (then DESIGN 1.2's fold) pack toward the
    // declared display width, but a chart whose shared box size alone needs
    // more than that can still come out wider — accepted, per 1.5's own
    // words, as a WARN rather than a silent rescale or a FAIL.
    return w > display
      ? [{ severity: 'warn', message: `1.1 wider than the declared display width (${w} > ${display})` }]
      : [];
  },
};

export const aspect: Check = {
  id: '1.4-aspect',
  rule: '1.4',
  run(svg) {
    const w = Math.round(svg.viewBox.baseVal.width);
    const h = Math.round(svg.viewBox.baseVal.height);
    // DESIGN 1.4's own remedy for a chart this tall is "go side by side
    // instead" — read for a canvas with room to go either way. A caller who
    // declared a narrower-than-default display has already fixed that
    // choice: going wider is the one thing DESIGN 1.6's own packing is not
    // allowed to do there, so the height it buys instead is the point, not
    // a defect (revised 2026-08-28 alongside 1.6).
    const display = Number(svg.dataset.display) || 0;
    if (display && display < CANVAS.width) return [];
    return h > w * CANVAS.maxAspect
      ? [{ severity: 'fail', message: `1.4 taller than ${CANVAS.maxAspect}×w (${h})` }]
      : [];
  },
};

export const unbalancedRows: Check = {
  id: '1.2-unbalanced-rows',
  rule: '1.2',
  run(svg, ctx) {
    const { unbalanced } = chainInfo(ctx);
    return unbalanced
      ? [
          {
            severity: 'fail',
            message: `1.2 primary path folded into unbalanced rows (${unbalanced})`,
          },
        ]
      : [];
  },
};

export const centred: Check = {
  id: '7.3-centred',
  rule: '7.3',
  run(svg, ctx) {
    const { minX, maxX } = contentBBox(ctx);
    const offCentre = Math.round((minX - ctx.sb.left - (ctx.sb.right - maxX)) / ctx.unit);
    return Math.abs(offCentre) > RULES['7.3']!.threshold!
      ? [{ severity: 'fail', message: `7.3 content off-centre by ${offCentre}` }]
      : [];
  },
};

export const rowCentre: Check = {
  id: '7.3-row-centre',
  rule: '7.3',
  run(svg, ctx) {
    const { rowsOff, rowOffIds } = compositionRows(ctx);
    return rowsOff
      ? [
          {
            severity: 'fail',
            message: `7.3 ${rowsOff} rows off the composition centre (${rowOffIds.join(' ')})`,
          },
        ]
      : [];
  },
};

export const coverage: Check = {
  id: '7.4-coverage',
  rule: '7.4',
  run(svg, ctx) {
    const { minX, minY, maxX, maxY } = contentBBox(ctx);
    const fill =
      ctx.sb.width && ctx.sb.height
        ? +(((maxX - minX) * (maxY - minY)) / (ctx.sb.width * ctx.sb.height)).toFixed(2)
        : 0;
    return fill < RULES['7.4']!.threshold!
      ? [{ severity: 'warn', message: `7.4 content covers ${Math.round(fill * 100)}% of canvas` }]
      : [];
  },
};

export const orphanColumns: Check = {
  id: '7.4-orphan-column',
  rule: '7.4',
  run(svg, ctx) {
    const cls = clusters(ctx);
    const { chainInfo: info } = chainInfo(ctx);
    if (cls.length || !info || !info.wraps) return [];
    const ids = nodeById(ctx);
    const cols = new Map<number, string[]>();
    for (const [id, n] of ids) {
      if (n.classList.contains('gc-kind-marker')) continue;
      const b = rect(outline(n));
      if (!b.width) continue;
      const key = Math.round((b.left + b.right) / 2 / ctx.unit / 16);
      if (!cols.has(key)) cols.set(key, []);
      cols.get(key)!.push(id);
    }
    if (cols.size < 3) return [];
    const inner = new Set(info.chain.slice(1, -1));
    let orphanCols = 0;
    const orphanIds: string[] = [];
    for (const [, colIds] of cols) {
      if (colIds.length === 1 && inner.has(colIds[0]!)) {
        orphanCols++;
        orphanIds.push(colIds[0]!);
      }
    }
    return orphanCols
      ? [
          {
            severity: 'fail',
            message: `7.4 ${orphanCols} orphan columns (${orphanIds.slice(0, 3).join(' ')})`,
          },
        ]
      : [];
  },
};

/**
 * DESIGN 7.4: two nodes in the same row band are never more than 200 units
 * apart edge-to-edge unless a node or label sits between them — the prose
 * version of "content covers a share of the canvas" made measurable at the
 * gap level, not just the aggregate. Row bands group by vertical overlap
 * (compositionRows' own approach, applied to nodes directly rather than
 * panel boxes), so a wide, empty stretch inside one row reads as a fail
 * whether or not the chart's overall coverage number still clears 7.4's
 * other threshold.
 */
export const evenWhitespace: Check = {
  id: '7.4-even-whitespace',
  rule: '7.4',
  run(svg, ctx) {
    const boxes = [...nodeById(ctx)]
      .filter(([, n]) => !n.classList.contains('gc-kind-marker'))
      .map(([id, n]) => ({ id, b: rect(outline(n)) }))
      .filter((x) => x.b.width);
    const bands: { top: number; bottom: number; items: typeof boxes }[] = [];
    for (const bx of [...boxes].sort((a, b) => a.b.top - b.b.top)) {
      const band = bands.find((r) => bx.b.top < r.bottom - 1 && bx.b.bottom > r.top + 1);
      if (band) {
        band.items.push(bx);
        band.top = Math.min(band.top, bx.b.top);
        band.bottom = Math.max(band.bottom, bx.b.bottom);
      } else {
        bands.push({ top: bx.b.top, bottom: bx.b.bottom, items: [bx] });
      }
    }
    const labelBoxes = texts(ctx)
      .map((t) => rect(t))
      .filter((b) => b.width);
    const threshold = RULES['7.4-even-whitespace']!.threshold!;
    let violations = 0;
    const ids: string[] = [];
    for (const band of bands) {
      const items = [...band.items].sort((a, b) => a.b.left - b.b.left);
      for (let i = 1; i < items.length; i++) {
        const prev = items[i - 1]!;
        const next = items[i]!;
        const gap = (next.b.left - prev.b.right) / ctx.unit;
        if (gap <= threshold) continue;
        const l = prev.b.right;
        const r = next.b.left;
        const between =
          boxes.some(
            (x) =>
              x.id !== prev.id &&
              x.id !== next.id &&
              x.b.left < r - 1 &&
              x.b.right > l + 1 &&
              x.b.top < band.bottom + 1 &&
              x.b.bottom > band.top - 1,
          ) ||
          labelBoxes.some(
            (b) =>
              b.left < r - 1 && b.right > l + 1 && b.top < band.bottom + 1 && b.bottom > band.top - 1,
          );
        if (!between) {
          violations++;
          ids.push(`${prev.id}~${next.id}:${Math.round(gap)}`);
        }
      }
    }
    return violations
      ? [
          {
            severity: 'fail',
            message: `7.4 ${violations} row gaps wider than ${threshold} with nothing between them (${ids.slice(0, 3).join(' ')})`,
          },
        ]
      : [];
  },
};

export const clipped: Check = {
  id: '7.5-clipped',
  rule: '7.5',
  run(svg, ctx) {
    let n = 0;
    for (const el of svg.querySelectorAll('text,rect,path,circle,polygon')) {
      if (!visible(el, svg)) continue;
      const b = rect(el);
      if (
        b.width &&
        (b.left < ctx.sb.left - 1 ||
          b.right > ctx.sb.right + 1 ||
          b.top < ctx.sb.top - 1 ||
          b.bottom > ctx.sb.bottom + 1)
      ) {
        n++;
      }
    }
    return n ? [{ severity: 'fail', message: `7.5 ${n} clipped at edge` }] : [];
  },
};

export const native: Check = {
  id: '7.6-native',
  rule: '7.6',
  run(svg) {
    // gate.mjs mounts a chart inside `.mount`; a check running directly
    // against a bare render (as the tests do) has no such ancestor, so this
    // falls back to the svg itself — which always carries `class="gc-chart"`
    // when natively drawn, so the result is the same either way.
    const root = svg.closest('.mount') ?? svg;
    const drawn = !!(
      root.matches('[class^="gc-"],[class*=" gc-"]') ||
      root.querySelector('[class^="gc-"],[class*=" gc-"]')
    );
    const raw = !!svg.querySelector(
      '.mermaid, [id^="mermaid"], .pieCircle, .mindmap-node, .commit',
    );
    return drawn && !raw ? [] : [{ severity: 'fail', message: '7.6 raw mermaid' }];
  },
};

export const CANVAS_CHECKS: Check[] = [
  native,
  canvasWidth,
  aspect,
  centred,
  coverage,
  rowCentre,
  clipped,
  unbalancedRows,
  orphanColumns,
  evenWhitespace,
];
