import type { ElkNode } from './elk.ts';
import { CLEARANCE, GUTTER } from '../tokens.ts';

/**
 * DESIGN 1.6: sibling wrapping.
 *
 * Leaf stacking (1.5) and the chain fold (1.2) both reshape *one* fan or
 * *one* chain. Neither helps when the leftover width comes from several
 * already-collapsed siblings sitting in the same row — two leaf-stacked fans
 * side by side, say, each already as narrow as 1.5 can make it. This is the
 * last packing move before 1.1's own scale fallback: it never runs unless
 * both of those already had their turn and the layout is still wider than
 * the display.
 *
 * Operates on the flat, already-placed top-level ELK tree (the same one
 * `layout/index.ts` hands to `place()`), not on the graph model — a row here
 * is a cluster box, a stacked-fan stand-in, or a plain node, whichever ELK
 * put at the top level, grouped by the vertical band it landed in. Moving
 * `x`/`y` here is picked up by the ordinary placement and routing that
 * follow, exactly the way `fold`'s own row wrap is invisible to everything
 * downstream of it.
 */

interface Row {
  items: ElkNode[];
  top: number;
  bottom: number;
}

/** Group top-level items into rows by vertical overlap — DESIGN 2.3's "nodes
 *  in the same row share an exact y" reversed: whatever ELK already lined up
 *  vertically is read back as one row, not recomputed from scratch. */
function bandRows(items: ElkNode[]): Row[] {
  const rows: Row[] = [];
  for (const item of [...items].sort((a, b) => (a.y ?? 0) - (b.y ?? 0))) {
    const y0 = item.y ?? 0;
    const y1 = y0 + (item.height ?? 0);
    const row = rows.find((r) => y0 < r.bottom && y1 > r.top);
    if (row) {
      row.items.push(item);
      row.top = Math.min(row.top, y0);
      row.bottom = Math.max(row.bottom, y1);
    } else {
      rows.push({ items: [item], top: y0, bottom: y1 });
    }
  }
  return rows;
}

/**
 * Wrap every row of top-level siblings that is still wider than `room` into
 * as many rows as it takes, mutating `children` in place. Rows below a
 * wrapped one shift down by whatever height the wrap added, so nothing below
 * ends up overlapping it.
 *
 * DESIGN 1.6: filled left to right like text, each resulting row centred on
 * the original row's own centre line (so a symmetric pair of branches — the
 * common case, two branches off one decision — stays centred under their
 * shared parent), 32 between rows (`GUTTER.panel`, the same gap a panel-to-
 * panel row already uses).
 *
 * Returns, for every item that landed on a line other than a row's first, how
 * far right of *its own left edge* a parent's edge into it should route down
 * before turning in — a corridor 24 outside the rightmost edge any line in
 * the row reaches, so the trunk clears every line in between by more than
 * 6.1's 16-unit floor. Anchored to the left edge rather than the right:
 * where a stacked fan is the item, the stand-in `x`/`width` this function
 * sees is the *whole* fan — parent plus its indented leaf column (DESIGN
 * 1.5) — but the parent the edge actually resolves to at draw time is
 * narrower, so "24 past the stand-in's right edge" and "24 past the
 * parent's own right edge" are different numbers; only `x` (the stand-in's
 * left edge) is one both agree on, because the parent always sits there,
 * unmoved (`layout/stack.ts`'s own `expandFan`). The right side, not the
 * left DESIGN 1.5's own leaf trunk uses: a stacked fan's leaf column already
 * reaches right of its parent, so a corridor there sits inside room the
 * drawing already claims instead of opening a new one on the side nothing
 * else needs — DESIGN 7.3's own centring check is what caught a left
 * corridor here spending 28 units of canvas nothing on the other side gave
 * back. Relative, not the corridor's raw canvas `x`: `square()` (DESIGN 2.1)
 * still runs after this and can shift the whole drawing to pull it back to
 * the origin, which every node and cluster hears about and an edge's own
 * stored number cannot — the offset survives that shift unchanged because
 * the item it is relative to moves by the same amount. The caller (`layout/
 * index.ts`) turns each of these into the same drawn bus `layout/stack.ts`'s
 * own leaf trunk uses (`edge.bus`) — a hanging port off the parent, straight
 * down the corridor, one turn into the sibling's right side — because a
 * plain routed edge has no reason to expect a whole sibling sitting in the
 * lane between it and its target, and does not look for one.
 *
 * Also returns, for every row actually wrapped, the ids of every item in it
 * (both lines) and the centre line they were wrapped onto — `layout/
 * index.ts` uses it to re-centre a now-single shared parent (DESIGN 7.3):
 * ELK placed that parent over the *pre-wrap* row, which read fine spread
 * side by side but leaves the parent off-centre once its own children read
 * as one column instead of two branches.
 */
export interface WrappedRow {
  ids: string[];
  centreX: number;
}

/**
 * `needsLabelGap` names items whose own incoming edge (once wrapped) will
 * carry a label (`layout/index.ts` resolves this from the graph before
 * calling in, since this module never sees edges) — DESIGN 6.9 wants that
 * label 8 clear of every node, on both sides, and the ordinary 32
 * (`GUTTER.panel`) a row-to-row gap gets is not tall enough to hold one
 * (label height + 16 is more than 32 for this chart's own type size): the
 * gap immediately above such an item grows to `labelGap` instead, the same
 * "make room rather than crowd it" move DESIGN 2.7/6.10 already make
 * elsewhere.
 */
export function wrapSiblings(
  children: ElkNode[],
  room: number,
  needsLabelGap: ReadonlySet<string> = new Set(),
  labelGap: number = GUTTER.panel,
): { corridors: Map<string, number>; rows: WrappedRow[] } {
  const bands = bandRows(children);
  const corridors = new Map<string, number>();
  const wrapped: WrappedRow[] = [];
  let addedHeight = 0;

  for (const row of bands) {
    if (addedHeight > 0) {
      for (const item of row.items) item.y = (item.y ?? 0) + addedHeight;
    }

    const items = [...row.items].sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
    const left = Math.min(...items.map((n) => n.x ?? 0));
    const right = Math.max(...items.map((n) => (n.x ?? 0) + (n.width ?? 0)));
    if (right - left <= room || items.length < 2) continue;

    // The row's own sibling gutter, read back from however ELK or the fold
    // above spaced it — never assumed, so a row of panels (32 apart) and a
    // row of plain nodes (24 apart) each keep their own rhythm once rewrapped.
    const gaps: number[] = [];
    for (let i = 1; i < items.length; i++) {
      gaps.push((items[i]!.x ?? 0) - ((items[i - 1]!.x ?? 0) + (items[i - 1]!.width ?? 0)));
    }
    const gap = gaps.length ? Math.max(...gaps) : GUTTER.sibling;

    // Greedy fill, left to right, exactly the rule a line of text wraps by:
    // keep adding the next sibling to the current row until it would overflow,
    // then start a new one.
    const lines: ElkNode[][] = [[]];
    let lineWidth = 0;
    for (const item of items) {
      const w = item.width ?? 0;
      const line = lines[lines.length - 1]!;
      const next = line.length ? lineWidth + gap + w : w;
      if (line.length && next > room) {
        lines.push([item]);
        lineWidth = w;
      } else {
        line.push(item);
        lineWidth = next;
      }
    }
    // Every sibling already fit alone (a fan or a cluster this wide would
    // have failed 1.5/1.2's own packing, not reached here as one piece), so a
    // one-item line here only happens because it genuinely does not share
    // its row with anything else.
    if (lines.length < 2) continue;

    const centreX = (left + right) / 2;
    const originalTop = row.top + addedHeight;
    let y = originalTop;
    let placedRight = -Infinity;
    lines.forEach((line, i) => {
      const totalWidth =
        line.reduce((sum, n) => sum + (n.width ?? 0), 0) + gap * (line.length - 1);
      placedRight = Math.max(placedRight, centreX + totalWidth / 2);
      const lineHeight = Math.max(...line.map((n) => n.height ?? 0));
      let x = centreX - totalWidth / 2;
      for (const item of line) {
        item.x = x;
        item.y = y;
        x += (item.width ?? 0) + gap;
      }
      // The gap grows when the *next* line needs room above it for its own
      // incoming label — never for the line just placed, which already has
      // its own position settled.
      const next = lines[i + 1];
      const nextNeedsLabel = next?.some((item) => needsLabelGap.has(item.id)) ?? false;
      y += lineHeight + Math.max(GUTTER.panel, nextNeedsLabel ? labelGap : 0);
    });
    // Every line shares this row's own centre, so the widest line's right
    // edge — never further left than any narrower line's — is the one
    // corridor position guaranteed clear of every line at once. Read back
    // from where the lines actually landed, not the pre-wrap row's own span
    // (which sat at a completely different width). Cleared by exactly
    // DESIGN 6.1's own 16-unit floor, not a wider gutter — every extra unit
    // here is a unit a wrap edge's own label (routed through the row gap
    // this corridor feeds into) never gets back. DESIGN 2.1: kept on the
    // 8-grid like everything else the layout places.
    const corridorX = Math.ceil((placedRight + CLEARANCE.node) / 8) * 8;
    lines.forEach((line, i) => {
      if (i === 0) return;
      // Stored relative to the item's own *left* edge, not as an absolute
      // canvas coordinate and not off its right edge either: a stacked
      // fan's own stand-in is wider than the parent node the edge actually
      // resolves to (DESIGN 1.5's leaf indent), so the two disagree about
      // where "the right edge" is — `x` is the one coordinate a fan's
      // stand-in and its parent always share (the parent sits at the
      // stand-in's own origin, unmoved). `square()` (DESIGN 2.1's grid
      // pass, run after this) can still shift the whole drawing by a
      // uniform amount to pull it back to the origin, and an edge's own
      // stored trunk column has no way to hear about that shift the way
      // every node and cluster does — the offset survives it unchanged
      // because the item it is relative to moves by the same amount.
      for (const item of line) corridors.set(item.id, corridorX - (item.x ?? 0));
    });
    wrapped.push({ ids: items.map((n) => n.id), centreX });
    const newHeight = y - GUTTER.panel - originalTop;
    addedHeight += newHeight - (row.bottom - row.top);
  }
  return { corridors, rows: wrapped };
}
