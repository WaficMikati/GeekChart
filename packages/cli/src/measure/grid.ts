/**
 * DESIGN.md §2: box sizing and the 8-grid (2.1/2.2), rows and gutters (2.3),
 * panels hugging their contents (2.6).
 */
import { RULES, tokens } from '@geekchart/core';
const { GRID } = tokens;
import {
  compositionRows,
  degrees,
  edgeMeta,
  geomAndHairpins,
  nodeById,
  outline,
  rect,
  visible,
  type Check,
  type Ctx,
} from './helpers.ts';
// edgeShapeStats also backs the 6.1 detour/bend checks in edges.ts; the 2.3
// touching check below shares its tally rather than re-walking every edge.
import { edgeShapeStats } from './edges.ts';

/** Distinct (w×h) box sizes and how many boxes sit off the 8-grid. Both 2.1/2.2
 *  walk the same `.gc-node` list, so they share the tally. */
function nodeDims(ctx: Ctx): { sizes: string[]; offGrid: number } {
  return ctx.memo('nodeDims', () => {
    const dims = new Map<string, number>();
    let offGrid = 0;
    for (const n of ctx.svg.querySelectorAll('.gc-node')) {
      const shape = n.querySelector('rect.gc-outline, rect.gc-fill') as SVGGraphicsElement | null;
      if (!shape) continue;
      const bb = shape.getBBox();
      const w = Math.round(bb.width);
      const h = Math.round(bb.height);
      dims.set(`${w}x${h}`, (dims.get(`${w}x${h}`) || 0) + 1);
      if (w % GRID || h % GRID) offGrid++;
    }
    return { sizes: [...dims.entries()].map(([k, v]) => `${k}×${v}`), offGrid };
  });
}

/** A panel hugs its contents: every text and child box inside, and the box is
 *  contents + 24 padding on the left/right/bottom (±8). Shared by 2.6's two checks. */
function panelStats(ctx: Ctx): { panelEscapes: number; panelSlack: number; slackIds: string[] } {
  return ctx.memo('panelStats', () => {
    let panelEscapes = 0;
    let panelSlack = 0;
    const slackIds: string[] = [];
    for (const c of ctx.svg.querySelectorAll('.gc-cluster')) {
      const box = c.querySelector('.gc-cluster-box, rect');
      if (!box) continue;
      const cb = rect(box);
      if (!cb.width) continue;
      let l = Infinity;
      let rgt = -Infinity;
      let b = -Infinity;
      const inside: Element[] = [];
      for (const el of c.querySelectorAll('text')) if (visible(el, ctx.svg)) inside.push(el);
      for (const n of ctx.svg.querySelectorAll('.gc-node')) {
        const nb = rect(n);
        const cx = (nb.left + nb.right) / 2;
        const cy = (nb.top + nb.bottom) / 2;
        if (cx > cb.left && cx < cb.right && cy > cb.top && cy < cb.bottom) inside.push(n);
      }
      for (const el of inside) {
        const eb = rect(el);
        if (!eb.width) continue;
        if (
          eb.left < cb.left - 1 ||
          eb.right > cb.right + 1 ||
          eb.top < cb.top - 1 ||
          eb.bottom > cb.bottom + 1
        ) {
          panelEscapes++;
        }
        l = Math.min(l, eb.left);
        rgt = Math.max(rgt, eb.right);
        b = Math.max(b, eb.bottom);
      }
      if (l === Infinity) continue;
      const padL = (l - cb.left) / ctx.unit;
      const padR = (cb.right - rgt) / ctx.unit;
      const padB = (cb.bottom - b) / ctx.unit;
      if (Math.abs(padL - 24) > 8 || Math.abs(padR - 24) > 8 || Math.abs(padB - 24) > 8) {
        panelSlack++;
        slackIds.push(
          `${(c as HTMLElement).dataset.id || '?'}:${Math.round(padL)}/${Math.round(padR)}/${Math.round(padB)}`,
        );
      }
    }
    return { panelEscapes, panelSlack, slackIds };
  });
}

export const boxSizes: Check = {
  id: '2.2-box-sizes',
  rule: '2.2',
  run(svg, ctx) {
    const { sizes } = nodeDims(ctx);
    return sizes.length > RULES['2.2']!.threshold!
      ? [
          {
            severity: 'warn',
            message: `2.2 ${sizes.length} box sizes (${sizes.slice(0, 4).join(' ')})`,
          },
        ]
      : [];
  },
};

export const offGridWarn: Check = {
  id: '2.1-off-grid',
  rule: '2.1',
  run(svg, ctx) {
    const { offGrid } = nodeDims(ctx);
    return offGrid ? [{ severity: 'warn', message: `2.1 ${offGrid} boxes off 8-grid` }] : [];
  },
};

export const labelEscapeBox: Check = {
  id: '2.2-label-escape-box',
  rule: '2.2',
  run(svg) {
    let escapes = 0;
    for (const n of svg.querySelectorAll('.gc-node')) {
      const shape = n.querySelector('.gc-outline,.gc-fill');
      if (!shape) continue;
      const s = rect(shape);
      for (const t of n.querySelectorAll('text')) {
        const b = rect(t);
        if (
          b.width &&
          (b.left < s.left - 2 ||
            b.right > s.right + 2 ||
            b.top < s.top - 2 ||
            b.bottom > s.bottom + 2)
        ) {
          escapes++;
        }
      }
    }
    return escapes ? [{ severity: 'fail', message: `2.2 ${escapes} labels escape box` }] : [];
  },
};

export const rowGutters: Check = {
  id: '2.3-row-gutters',
  rule: '2.3',
  run(svg, ctx) {
    const { rowGaps, rowGapIds } = compositionRows(ctx);
    return rowGaps
      ? [
          {
            severity: 'fail',
            message: `2.3 ${rowGaps} arbitrary gaps inside a row (${rowGapIds.join(' ')})`,
          },
        ]
      : [];
  },
};

export const soleChildCentre: Check = {
  id: '2.3-sole-child-centre',
  rule: '2.3',
  run(svg, ctx) {
    const { geom } = geomAndHairpins(ctx);
    const { parents, children } = degrees(ctx);
    let offColumn = 0;
    const columnIds: string[] = [];
    for (const [e, g] of geom) {
      const { ra, rb, back, from, to } = g;
      if (back || children.get(from) !== 1 || parents.get(to) !== 1) continue;
      const dxc = Math.abs((ra.left + ra.right) / 2 - (rb.left + rb.right) / 2);
      const dyc = Math.abs((ra.top + ra.bottom) / 2 - (rb.top + rb.bottom) / 2);
      if (rb.top >= ra.bottom - 1 && dxc > 1.5 * ctx.unit && dxc < (ra.width + rb.width) / 2) {
        offColumn++;
        columnIds.push(e.dataset.id!);
      }
      if (rb.left >= ra.right - 1 && dyc > 1.5 * ctx.unit && dyc < (ra.height + rb.height) / 2) {
        offColumn++;
        columnIds.push(e.dataset.id!);
      }
    }
    return offColumn
      ? [
          {
            severity: 'fail',
            message: `2.3 ${offColumn} sole children off their parent's centre line (${columnIds.slice(0, 3).join(' ')})`,
          },
        ]
      : [];
  },
};

export const minEdgeLength: Check = {
  id: '2.3-min-edge-length',
  rule: '2.3',
  run(svg, ctx) {
    const { touching } = edgeShapeStats(ctx);
    return touching
      ? [{ severity: 'fail', message: `2.3 ${touching} edges under 16 units — nodes touching` }]
      : [];
  },
};

export const sharedRow: Check = {
  id: '2.3-shared-row',
  rule: '2.3',
  run(svg, ctx) {
    const adj = edgeMeta(ctx);
    const panelBoxes = [...svg.querySelectorAll('.gc-cluster')]
      .map((c) => {
        const bx = c.querySelector('.gc-cluster-box, rect');
        return bx ? rect(bx) : null;
      })
      .filter((b): b is DOMRect => !!b);
    const decisions = [
      ...svg.querySelectorAll('.gc-node.gc-kind-decision, .gc-node.gc-kind-diamond'),
    ].map((n) => rect(outline(n)));
    const ids = nodeById(ctx);
    const nodeList = [...ids.entries()]
      .map(([id, n]) => [id, rect(outline(n))] as [string, DOMRect])
      .filter(([, b]) => b.width);
    let offRow = 0;
    const offRowIds: string[] = [];
    for (let i = 0; i < nodeList.length; i++) {
      for (let j = i + 1; j < nodeList.length; j++) {
        const [ia, a] = nodeList[i]!;
        const [ib, b] = nodeList[j]!;
        const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (!(
          overlap > 4 * ctx.unit &&
          Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) > 1.5 * ctx.unit
        ))
          continue;
        const panelOf = (box: DOMRect) =>
          panelBoxes.findIndex(
            (pb) =>
              (box.left + box.right) / 2 > pb.left &&
              (box.left + box.right) / 2 < pb.right &&
              (box.top + box.bottom) / 2 > pb.top &&
              (box.top + box.bottom) / 2 < pb.bottom,
          );
        if (panelOf(a) !== panelOf(b)) continue;
        const ca = (a.top + a.bottom) / 2;
        const cb = (b.top + b.bottom) / 2;
        const spanned =
          decisions.some((d) => d.top <= Math.min(ca, cb) && d.bottom >= Math.max(ca, cb)) ||
          (a.height >= 1.5 * b.height && a.top <= cb && a.bottom >= cb) ||
          (b.height >= 1.5 * a.height && b.top <= ca && b.bottom >= ca);
        if (spanned) continue;
        if (adj.some((g) => (g.from === ia && g.to === ib) || (g.from === ib && g.to === ia)))
          continue;
        offRow++;
        offRowIds.push(`${ia}~${ib}`);
      }
    }
    return offRow
      ? [
          {
            severity: 'fail',
            message: `2.3 ${offRow} node pairs overlapping bands but not sharing a row (${offRowIds.slice(0, 3).join(' ')})`,
          },
        ]
      : [];
  },
};

export const panelEscape: Check = {
  id: '2.6-panel-escape',
  rule: '2.6',
  run(svg, ctx) {
    const { panelEscapes } = panelStats(ctx);
    return panelEscapes
      ? [{ severity: 'fail', message: `2.6 ${panelEscapes} texts/boxes escaping their panel` }]
      : [];
  },
};

export const panelHug: Check = {
  id: '2.6-panel-hug',
  rule: '2.6',
  run(svg, ctx) {
    const { panelSlack, slackIds } = panelStats(ctx);
    return panelSlack
      ? [
          {
            severity: 'fail',
            message: `2.6 ${panelSlack} panels not hugging contents (${slackIds.slice(0, 3).join(' ')})`,
          },
        ]
      : [];
  },
};

export const GRID_CHECKS: Check[] = [
  boxSizes,
  offGridWarn,
  labelEscapeBox,
  rowGutters,
  soleChildCentre,
  minEdgeLength,
  sharedRow,
  panelEscape,
  panelHug,
];
