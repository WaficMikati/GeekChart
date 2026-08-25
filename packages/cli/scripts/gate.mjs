/**
 * Design gate: measure every chart in gallery.html against DESIGN.md.
 *
 *   pnpm gallery && pnpm gate            # all charts
 *   pnpm gate flow control-plane         # just these
 *   pnpm gate --shots                    # also write PNGs to .gate/
 *   pnpm gate --json                     # the same results as JSON, for tests
 *
 * Prints one line per chart with the rules it breaks (rule numbers are the
 * section numbers in DESIGN.md) and exits 1 if anything is a FAIL. WARN lines
 * are things the gate can only approximate; a human decides those from the
 * screenshot. The point is that "looks fine" is not an argument — the numbers
 * are.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const args = process.argv.slice(2);
const shots = args.includes('--shots');
const asJson = args.includes('--json');
const only = new Set(args.filter((a) => !a.startsWith('--')));
const page = args.find((a) => a.startsWith('--file='))?.slice(7) ?? join(repo, 'gallery.html');
if (!existsSync(page)) {
  console.error(`no ${page} — run "pnpm gallery" first`);
  process.exit(2);
}
const outDir = join(repo, '.gate');
if (shots) mkdirSync(outDir, { recursive: true });

// What the stage shows a 1000-wide canvas at in the review gallery; on-screen
// sizes are computed against this so the numbers match what a reviewer sees.
const STAGE_PX = 760; // narrowest common viewer (artifact panel); DESIGN 3.1 measures here

const browser = await chromium.launch();
const pg = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await pg.goto('file://' + page);
await pg.waitForTimeout(1200);
const charts = await pg.$$eval('.chart', (cs) =>
  cs.map((c) => ({ id: c.id, title: c.querySelector('h2')?.textContent.trim() ?? c.id })),
);

let failed = 0;
const rows = [];
const results = [];
for (const { id } of charts) {
  const short = id.replace(/^gc-/, '');
  if (only.size && !only.has(short)) continue;
  await pg.evaluate((h) => { location.hash = h; }, '#' + id);
  await pg.waitForTimeout(250);
  await pg.evaluate(() => document.body.classList.add('still'));
  await pg.waitForTimeout(150);

  const m = await pg.evaluate((STAGE_PX) => {
    const svg = document.querySelector('.chart:not([hidden]) .stage svg');
    if (!svg) return null;
    const vb = svg.viewBox.baseVal;
    const scale = Math.min(1, STAGE_PX / vb.width); // the stage never upscales
    const r = (x) => x.getBoundingClientRect();
    const sb = r(svg);
    const visible = (el) => {
      for (let e = el; e && e !== svg; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.opacity === '0' || cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      return true;
    };
    const texts = [...svg.querySelectorAll('text')].filter((t) => visible(t) && t.textContent.trim());
    const f = {};

    // 1.1 / 1.4 canvas
    f.vb = [Math.round(vb.width), Math.round(vb.height)];
    // 3 / 3.1 type
    const sizes = new Set();
    let minScreen = Infinity, minScreenText = '';
    let rotated = 0;
    for (const t of texts) {
      const px = parseFloat(getComputedStyle(t).fontSize);
      sizes.add(px);
      if (px * scale < minScreen) { minScreen = px * scale; minScreenText = t.textContent.trim().slice(0, 24); }
      const tr = (t.getAttribute('transform') || '') + (t.parentElement?.getAttribute('transform') || '');
      if (/rotate\(\s*-?(?!0[\s)])\d/.test(tr)) rotated++;
    }
    f.sizes = [...sizes].sort((a, b) => a - b);
    f.minScreen = +minScreen.toFixed(1);
    f.minScreenText = minScreenText;
    f.rotated = rotated;

    // 6.5 / 7.5 overlap, escape, clip
    const tb = texts.map((t) => ({ t, b: r(t) }));
    let overlaps = 0;
    for (let i = 0; i < tb.length; i++) for (let j = i + 1; j < tb.length; j++) {
      const a = tb[i].b, b = tb[j].b;
      if (a.width && b.width && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps++;
    }
    // text vs any shape it is not inside of (legend swatches, neighbouring boxes)
    let collisions = 0;
    const shapes = [...svg.querySelectorAll('rect, circle, polygon')].filter((e) => visible(e) && !e.classList.contains('bg') && !e.classList.contains('gc-plate'));
    for (const { t, b } of tb) for (const sh of shapes) {
      if (sh.contains(t) || t.parentElement === sh.parentElement && sh.closest('.gc-node')) continue;
      const s = r(sh); if (!s.width) continue;
      const inside = b.left >= s.left - 1 && b.right <= s.right + 1 && b.top >= s.top - 1 && b.bottom <= s.bottom + 1;
      const touches = b.left < s.right - 1 && s.left < b.right - 1 && b.top < s.bottom - 1 && s.top < b.bottom - 1;
      if (touches && !inside) collisions++;
    }
    f.collisions = collisions;
    f.overlaps = overlaps;
    let escapes = 0;
    for (const n of svg.querySelectorAll('.gc-node')) {
      const shape = n.querySelector('.gc-outline,.gc-fill');
      if (!shape) continue;
      const s = r(shape);
      for (const t of n.querySelectorAll('text')) {
        const b = r(t);
        if (b.width && (b.left < s.left - 2 || b.right > s.right + 2 || b.top < s.top - 2 || b.bottom > s.bottom + 2)) escapes++;
      }
    }
    f.escapes = escapes;
    // 2.6 a panel hugs its contents: every text and child box inside, and the box is
    //     contents + 24 padding on the left, right and bottom (±8); title band on top
    let panelEscapes = 0, panelSlack = 0; const slackIds = []; const pu = sb.width / vb.width;
    for (const c of svg.querySelectorAll('.gc-cluster')) {
      const box = c.querySelector('.gc-cluster-box, rect'); if (!box) continue;
      const cb = r(box); if (!cb.width) continue;
      let l = Infinity, rgt = -Infinity, b = -Infinity;
      // contents: the panel's own texts, plus every node whose centre lies inside the box
      const inside = [];
      for (const el of c.querySelectorAll('text')) { if (visible(el)) inside.push(el); }
      for (const n of svg.querySelectorAll('.gc-node')) { const nb = r(n); const cx = (nb.left + nb.right) / 2, cy = (nb.top + nb.bottom) / 2; if (cx > cb.left && cx < cb.right && cy > cb.top && cy < cb.bottom) inside.push(n); }
      for (const el of inside) {
        const eb = r(el); if (!eb.width) continue;
        if (eb.left < cb.left - 1 || eb.right > cb.right + 1 || eb.top < cb.top - 1 || eb.bottom > cb.bottom + 1) panelEscapes++;
        l = Math.min(l, eb.left); rgt = Math.max(rgt, eb.right); b = Math.max(b, eb.bottom);
      }
      if (l === Infinity) continue;
      const padL = (l - cb.left) / pu, padR = (cb.right - rgt) / pu, padB = (cb.bottom - b) / pu;
      if (Math.abs(padL - 24) > 8 || Math.abs(padR - 24) > 8 || Math.abs(padB - 24) > 8) { panelSlack++; slackIds.push(`${c.dataset.id || '?'}:${Math.round(padL)}/${Math.round(padR)}/${Math.round(padB)}`); }
    }
    f.panelEscapes = panelEscapes; f.panelSlack = panelSlack; f.slackIds = slackIds.slice(0, 3);
    // 7.3 in a composition (a chart with panels) every row is centred on the chart's
    //     content centre within 8 units. A row = top-level boxes (panels, and nodes
    //     outside any panel) whose vertical bands overlap.
    let rowsOff = 0; const rowOffIds = []; let rowGaps = 0; const rowGapIds = [];
    const clusters = [...svg.querySelectorAll('.gc-cluster')];
    if (clusters.length) {
      const boxes = [];
      for (const c of clusters) { const bx = c.querySelector('.gc-cluster-box, rect'); if (bx && visible(bx)) boxes.push({ id: c.dataset.id || 'panel', b: r(bx) }); }
      for (const n of svg.querySelectorAll('.gc-node')) { const nb = r(n); if (!nb.width) continue; const cx = (nb.left + nb.right) / 2, cy = (nb.top + nb.bottom) / 2; const inPanel = boxes.some(({ b }) => cx > b.left && cx < b.right && cy > b.top && cy < b.bottom); if (!inPanel) boxes.push({ id: n.dataset.id || 'node', b: nb }); }
      const rows = [];
      for (const bx of boxes.sort((a, b) => a.b.top - b.b.top)) { const row = rows.find((rw) => bx.b.top < rw.bottom - 1 && bx.b.bottom > rw.top + 1); if (row) { row.items.push(bx); row.top = Math.min(row.top, bx.b.top); row.bottom = Math.max(row.bottom, bx.b.bottom); } else rows.push({ top: bx.b.top, bottom: bx.b.bottom, items: [bx] }); }
      const allL = Math.min(...boxes.map((x) => x.b.left)), allR = Math.max(...boxes.map((x) => x.b.right)); const centre = (allL + allR) / 2;
      for (const rw of rows) { const l = Math.min(...rw.items.map((x) => x.b.left)), rg = Math.max(...rw.items.map((x) => x.b.right)); const off = ((l + rg) / 2 - centre) / pu; if (Math.abs(off) > 8) { rowsOff++; rowOffIds.push(`${rw.items.map((x) => x.id).join('+')}:${Math.round(off)}`); } }
      // 2.3 gutters inside a row are the standard 32 (±8) unless an item is column-
      //     aligned (centre within 8) with an item in the row above or below
      const sorted = rows.map((rw) => [...rw.items].sort((a, b) => a.b.left - b.b.left));
      for (let ri = 0; ri < sorted.length; ri++) {
        const neighbours = [sorted[ri - 1], sorted[ri + 1]].filter(Boolean).flat();
        const aligned = (it) => neighbours.some((o) => Math.abs((o.b.left + o.b.right) / 2 - (it.b.left + it.b.right) / 2) < 8 * pu);
        for (let k = 1; k < sorted[ri].length; k++) {
          const a = sorted[ri][k - 1], b = sorted[ri][k]; const gap = (b.b.left - a.b.right) / pu;
          if (Math.abs(gap - 32) > 8 && !(aligned(a) && aligned(b))) { rowGaps++; rowGapIds.push(`${a.id}|${b.id}:${Math.round(gap)}`); }
        }
      }
    }
    f.rowsOff = rowsOff; f.rowOffIds = rowOffIds.slice(0, 3); f.rowGaps = rowGaps; f.rowGapIds = rowGapIds.slice(0, 3);
    let clipped = 0;
    for (const el of svg.querySelectorAll('text,rect,path,circle,polygon')) {
      if (!visible(el)) continue;
      const b = r(el);
      if (b.width && (b.left < sb.left - 1 || b.right > sb.right + 1 || b.top < sb.top - 1 || b.bottom > sb.bottom + 1)) clipped++;
    }
    f.clipped = clipped;

    // 2.1 / 2.2 node sizes
    const dims = new Map();
    let offGrid = 0;
    for (const n of svg.querySelectorAll('.gc-node')) {
      const shape = n.querySelector('rect.gc-outline, rect.gc-fill');
      if (!shape) continue;
      const w = Math.round(shape.getBBox().width), h = Math.round(shape.getBBox().height);
      dims.set(`${w}x${h}`, (dims.get(`${w}x${h}`) || 0) + 1);
      if (w % 8 || h % 8) offGrid++;
    }
    f.nodeSizes = [...dims.entries()].map(([k, v]) => `${k}×${v}`);
    f.offGrid = offGrid;

    // 6.3 arrowheads per edge
    const heads = new Map();
    for (const a of svg.querySelectorAll('.gc-arrow[data-id]')) heads.set(a.dataset.id, (heads.get(a.dataset.id) || 0) + 1);
    f.doubleHeads = [...heads.values()].filter((n) => n > 1).length;

    // 7.4 how much of the canvas the content uses
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of svg.querySelectorAll('.gc-node, .gc-cluster, .gc-edge, text, rect, path')) {
      if (!visible(el)) continue;
      const b = r(el);
      if (!b.width) continue;
      minX = Math.min(minX, b.left); minY = Math.min(minY, b.top);
      maxX = Math.max(maxX, b.right); maxY = Math.max(maxY, b.bottom);
    }
    // 7.3 content centred: left and right margins equal within 8 canvas units
    const unit = sb.width / vb.width;
    f.offCentre = Math.round(((minX - sb.left) - (sb.right - maxX)) / unit);
    // 3.5 / 10.2 text centred in its box: per node, |text centre − box centre| ≤ 1.5
    let offText = 0;
    for (const n of svg.querySelectorAll('.gc-node')) {
      const shape = n.querySelector('rect.gc-outline, rect.gc-fill'); if (!shape) continue;
      const s = r(shape);
      for (const t of n.querySelectorAll('text')) { const b = r(t); if (!b.width) continue; if (getComputedStyle(t).textAnchor !== 'middle') continue; if (Math.abs((b.left + b.right) / 2 - (s.left + s.right) / 2) > 1.5 * unit) offText++; }
    }
    f.offText = offText;
    // 6.2 a straight vertical/horizontal edge between two nodes runs through both their midpoints
    //     (|segment x − node centre x| ≤ 1) and has no jog: a segment shorter than 6 between two longer ones
    let offMid = 0, jogs = 0;
    const nodeById = new Map([...svg.querySelectorAll('.gc-node[data-id]')].map((n) => [n.dataset.id, n]));
    for (const e of svg.querySelectorAll('.gc-edge[data-id]')) {
      const d = e.getAttribute('d') || ''; const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) || [];
      const pts = []; for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
      const segs = []; for (let i = 1; i < pts.length; i++) segs.push(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      for (let i = 1; i + 1 < segs.length; i++) if (segs[i] > 0 && segs[i] < 6 && segs[i - 1] > 24 && segs[i + 1] > 24) jogs++;
      const m = (e.dataset.id || '').match(/^L_(.+?)_(.+?)_\d+$/); if (!m) continue;
      const a = nodeById.get(m[1]), b = nodeById.get(m[2]); if (!a || !b || pts.length < 2) continue;
      const ra = r(a.querySelector('.gc-outline,.gc-fill') || a), rb = r(b.querySelector('.gc-outline,.gc-fill') || b);
      const re = r(e); // rendered rect — includes the frame translate
      const vertical = re.width < 2 * unit && Math.abs(ra.left - rb.left) < unit;
      if (vertical) { const cx = (ra.left + ra.right) / 2; if (Math.abs((re.left + re.right) / 2 - cx) > 1.5 * unit) offMid++; }
    }
    f.offMid = offMid; f.jogs = jogs;
    // 3.2 a literal markup tag in rendered text means a label was never split
    f.rawTags = texts.filter((t) => /<br\s*\/?>|&lt;br/i.test(t.textContent)).length;
    // 6.5 an edge label must not sit on an edge other than its own
    let labelOnEdge = 0;
    const edgeEls = [...svg.querySelectorAll('.gc-edge[data-id]')];
    for (const t of svg.querySelectorAll('.gc-edge-label text, .gc-card, text.gc-msg-label')) {
      if (!visible(t)) continue; const b = r(t); if (!b.width) continue;
      const own = t.closest('[data-id]')?.dataset.id;
      for (const e of edgeEls) {
        if (e.dataset.id === own) continue;
        const d = e.getAttribute('d') || ''; const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) || [];
        const ctm = e.getScreenCTM(); if (!ctm) continue;
        for (let i = 2; i + 1 < nums.length; i += 2) {
          const x1 = nums[i - 2] * ctm.a + ctm.e, y1 = nums[i - 1] * ctm.d + ctm.f, x2 = nums[i] * ctm.a + ctm.e, y2 = nums[i + 1] * ctm.d + ctm.f;
          const sx1 = Math.min(x1, x2), sx2 = Math.max(x1, x2), sy1 = Math.min(y1, y2), sy2 = Math.max(y1, y2);
          if (sx1 < b.right && sx2 > b.left && sy1 < b.bottom && sy2 > b.top) { labelOnEdge++; break; }
        }
      }
    }
    f.labelOnEdge = labelOnEdge;
    // 6.5 a label on its own edge covers at most 60% of the segment it sits on;
    //     wider labels sit beside the line, never knocking most of it out
    let swallowed = 0; const swallowIds = [];
    for (const t of svg.querySelectorAll('.gc-edge-label text, .gc-card')) {
      if (!visible(t)) continue; const b = r(t); if (!b.width) continue;
      const own = t.closest('[data-id]')?.dataset.id; const e = own && svg.querySelector(`.gc-edge[data-id="${own}"]`); if (!e) continue;
      const ctm = e.getScreenCTM(); const nums = (e.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g)?.map(Number) || [];
      const pts = []; for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i] * ctm.a + ctm.e, nums[i + 1] * ctm.d + ctm.f]);
      const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
      for (let i = 1; i < pts.length; i++) {
        const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
        const horiz = Math.abs(y1 - y2) < 1, vert = Math.abs(x1 - x2) < 1;
        const onH = horiz && Math.abs(cy - y1) < b.height && cx > Math.min(x1, x2) && cx < Math.max(x1, x2);
        const onV = vert && Math.abs(cx - x1) < b.width && cy > Math.min(y1, y2) && cy < Math.max(y1, y2);
        if (onH && b.width > 0.6 * Math.abs(x2 - x1)) { swallowed++; swallowIds.push(own); break; }
        if (onV && (b.height > 0.4 * Math.abs(y2 - y1) || Math.abs(y2 - y1) < 64)) { swallowed++; swallowIds.push(own); break; }
      }
    }
    f.swallowed = swallowed; f.swallowIds = swallowIds.slice(0, 3);
    // 6.1 / 6.7 a forward edge is no longer than 2× the Manhattan distance between
    //           its ends (+32 for two elbows); longer is a detour, not a route
    let detours = 0; const detourIds = []; let touching = 0; let overBent = 0; const bentIds = [];
    for (const e of edgeEls) {
      if (e.classList.contains('gc-back') || /back|loop/.test(e.dataset.kind || '')) continue;
      const d = e.getAttribute('d') || ''; const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) || [];
      const pts = []; for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
      if (pts.length < 2) continue;
      let len = 0; for (let i = 1; i < pts.length; i++) len += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
      const a = pts[0], b = pts[pts.length - 1]; const direct = Math.hypot(b[0] - a[0], b[1] - a[1]) + 32;
      if (len < 16) { touching++; }
      const m = (e.dataset.id || '').match(/^L_(.+?)_(.+?)_\d+$/);
      const isBack = m && nodeById.get(m[1]) && nodeById.get(m[2]) && r(nodeById.get(m[2])).top < r(nodeById.get(m[1])).top - 8 && r(nodeById.get(m[2])).left <= r(nodeById.get(m[1])).left + 8;
      const back = isBack || e.classList.contains('gc-back');
      if (!back && len > 1.4 * direct) { detours++; detourIds.push(e.dataset.id); }
      // bends: direction changes between consecutive non-trivial segments
      let bends = 0, prev = null;
      for (let i = 1; i < pts.length; i++) { const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1]; if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue; const dir = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v'; if (prev && dir !== prev) bends++; prev = dir; }
      if ((!back && bends > 2) || (back && bends > 4)) { overBent++; bentIds.push(`${e.dataset.id}:${bends}`); }
    }
    f.detours = detours; f.detourIds = detourIds.slice(0, 3); f.touching = touching; f.overBent = overBent; f.bentIds = bentIds.slice(0, 3);
    // 6.1 forward edges never cross each other (back edges may cross, once)
    let crossings = 0; const crossIds = [];
    const fwd = edgeEls.filter((e) => !e.classList.contains('gc-back'));
    const segList = fwd.map((e) => { const nums = (e.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g)?.map(Number) || []; const pts = []; for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]); const segs = []; for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]); return segs; });
    const cross = (a, b) => { const [p1, p2] = a, [p3, p4] = b; const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]); if (Math.abs(d) < 1e-6) return false; const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d; const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d; return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98; };
    const startOf = (segs) => segs.length ? segs[0][0] : null;
    for (let i = 0; i < segList.length; i++) for (let j = i + 1; j < segList.length; j++) { const a0 = startOf(segList[i]), b0 = startOf(segList[j]); if (a0 && b0 && Math.abs(a0[0] - b0[0]) < 1.5 && Math.abs(a0[1] - b0[1]) < 1.5) continue; let hit = false; for (const a of segList[i]) { for (const b of segList[j]) if (cross(a, b)) { hit = true; break; } if (hit) break; } if (hit) { crossings++; crossIds.push(`${fwd[i].dataset.id}×${fwd[j].dataset.id}`); } }
    f.crossings = crossings; f.crossIds = crossIds.slice(0, 3);
    // 6.1 a Z edge's middle segment is centred in the free channel between the nearest
    //     obstacles (nodes or panels) on either side of it, within 4 units
    let offChannel = 0; const offChannelIds = [];
    const obstacles = [];
    for (const n of svg.querySelectorAll('.gc-node')) { const b = r(n.querySelector('.gc-outline,.gc-fill') || n); if (b.width) obstacles.push(b); }
    for (const c of svg.querySelectorAll('.gc-cluster')) { const bx = c.querySelector('.gc-cluster-box, rect'); if (bx && visible(bx)) { const b = r(bx); if (b.width) obstacles.push(b); } }
    for (const e of fwd) {
      const ctm = e.getScreenCTM(); if (!ctm) continue;
      const nums = (e.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g)?.map(Number) || [];
      const pts = []; for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i] * ctm.a + ctm.e, nums[i + 1] * ctm.d + ctm.f]);
      // collapse to straight runs (drop the rounding points)
      const runs = []; for (let i = 1; i < pts.length; i++) { const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1]; if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue; const dir = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v'; const last = runs[runs.length - 1]; if (last && last.dir === dir) { last.b = pts[i]; } else runs.push({ dir, a: pts[i - 1], b: pts[i] }); }
      if (runs.length !== 3 || runs[0].dir !== runs[2].dir) continue;
      const mid = runs[1];
      if (mid.dir === 'v') {
        const x = (mid.a[0] + mid.b[0]) / 2, y1 = Math.min(mid.a[1], mid.b[1]), y2 = Math.max(mid.a[1], mid.b[1]);
        const lefts = obstacles.filter((o) => o.right <= x + 1 && o.bottom > y1 && o.top < y2).map((o) => o.right);
        const rights = obstacles.filter((o) => o.left >= x - 1 && o.bottom > y1 && o.top < y2).map((o) => o.left);
        if (!lefts.length || !rights.length) continue;
        const want = (Math.max(...lefts) + Math.min(...rights)) / 2;
        if (Math.abs(x - want) > 4 * unit) { offChannel++; offChannelIds.push(`${e.dataset.id}:${Math.round((x - want) / unit)}`); }
      } else {
        const y = (mid.a[1] + mid.b[1]) / 2, x1 = Math.min(mid.a[0], mid.b[0]), x2 = Math.max(mid.a[0], mid.b[0]);
        const tops = obstacles.filter((o) => o.bottom <= y + 1 && o.right > x1 && o.left < x2).map((o) => o.bottom);
        const bottoms = obstacles.filter((o) => o.top >= y - 1 && o.right > x1 && o.left < x2).map((o) => o.top);
        if (!tops.length || !bottoms.length) continue;
        const want = (Math.max(...tops) + Math.min(...bottoms)) / 2;
        if (Math.abs(y - want) > 4 * unit) { offChannel++; offChannelIds.push(`${e.dataset.id}:${Math.round((y - want) / unit)}`); }
      }
    }
    f.offChannel = offChannel; f.offChannelIds = offChannelIds.slice(0, 3);
    // 6.7 no hairpins: two consecutive bends turning back within 24 units (any edge,
    //     loop-backs included) — a loop goes around once, it never doubles back
    // 6.2 arrival side: in a top-to-bottom chart an edge arrives on the target's top
    //     (a loop-back too); left-to-right → the left side. Sides tolerance 8.
    // 2.3 a sole child sits on its sole parent's centre line (TB: same x; LR: same y)
    let hairpins = 0; const hairpinIds = []; let wrongArrive = 0; const arriveIds = []; let offColumn = 0; const columnIds = [];
    const parents = new Map(), children = new Map();
    const edgeMeta = edgeEls.map((e) => { const m = (e.dataset.id || '').match(/^L_(.+?)_(.+?)_\d+$/); return { e, from: e.dataset.from || (m && m[1]), to: e.dataset.to || (m && m[2]) }; });
    for (const { e, from, to } of edgeMeta) { if (!from || !to || e.classList.contains('gc-back')) continue; children.set(from, (children.get(from) || 0) + 1); parents.set(to, (parents.get(to) || 0) + 1); }
    // chart direction: more forward edges leaving bottoms than rights → TB
    let downCount = 0, rightCount = 0;
    for (const { e, from, to } of edgeMeta) { const A = from && nodeById.get(from), B = to && nodeById.get(to); if (!A || !B || e.classList.contains('gc-back')) continue; const ra = r(A), rb = r(B); if (rb.top >= ra.bottom - 1) downCount++; else if (rb.left >= ra.right - 1) rightCount++; }
    const declared = svg.dataset.flow; const dirTB = declared ? /^(TB|TD|BT)$/.test(declared) : downCount >= rightCount;
    const sideOfEnd = (end, rb) => { const dT = Math.abs(end[1] - rb.top), dB = Math.abs(end[1] - rb.bottom), dL = Math.abs(end[0] - rb.left), dR = Math.abs(end[0] - rb.right); const m = Math.min(dT, dB, dL, dR); return m === dT ? 'top' : m === dB ? 'bottom' : m === dL ? 'left' : 'right'; };
    const geom = new Map();
    for (const { e, from, to } of edgeMeta) {
      const ctm = e.getScreenCTM(); if (!ctm) continue;
      const nums = (e.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g)?.map(Number) || [];
      const pts = []; for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i] * ctm.a + ctm.e, nums[i + 1] * ctm.d + ctm.f]);
      const runs = []; for (let i = 1; i < pts.length; i++) { const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1]; if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue; const dir = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v'; const last = runs[runs.length - 1]; if (last && last.dir === dir) last.b = pts[i]; else runs.push({ dir, a: pts[i - 1], b: pts[i] }); }
      for (let k = 0; k + 2 < runs.length; k++) { const s0 = runs[k], s1 = runs[k + 1], s2 = runs[k + 2]; const len1 = Math.hypot(s1.b[0] - s1.a[0], s1.b[1] - s1.a[1]) / unit; const d0 = s0.dir === 'h' ? Math.sign(s0.b[0] - s0.a[0]) : Math.sign(s0.b[1] - s0.a[1]); const d2 = s2.dir === 'h' ? Math.sign(s2.b[0] - s2.a[0]) : Math.sign(s2.b[1] - s2.a[1]); if (s0.dir === s2.dir && d0 === -d2 && len1 < 24) { hairpins++; hairpinIds.push(e.dataset.id); break; } }
      const A = from && nodeById.get(from), B = to && nodeById.get(to); if (!A || !B || !pts.length) continue;
      const ra = r(A.querySelector('.gc-outline,.gc-fill') || A), rb = r(B.querySelector('.gc-outline,.gc-fill') || B);
      const back = e.classList.contains('gc-back');
      geom.set(e, { A, B, ra, rb, back, arrives: sideOfEnd(pts[pts.length - 1], rb), from, to });
    }
    // the side each node's forward in-edges arrive on (its "flow-in" side)
    const flowIn = new Map();
    for (const g of geom.values()) if (!g.back) { if (!flowIn.has(g.to)) flowIn.set(g.to, g.arrives); }
    for (const [e, g] of geom) {
      const { ra, rb, back, arrives, from, to } = g;
      let want;
      const below = rb.top >= ra.bottom - 1, above = rb.bottom <= ra.top + 1, right = rb.left >= ra.right - 1, leftOf = rb.right <= ra.left + 1;
      if (back) want = flowIn.get(to) || (dirTB ? 'top' : 'left');
      else if (dirTB) want = below ? 'top' : right ? 'left' : leftOf ? 'right' : 'bottom';
      else want = right ? 'left' : below ? 'top' : above ? 'bottom' : 'right';
      if (arrives !== want) { wrongArrive++; arriveIds.push(`${e.dataset.id}:${arrives}≠${want}`); }
      if (!back && children.get(from) === 1 && parents.get(to) === 1) {
        const dxc = Math.abs((ra.left + ra.right) / 2 - (rb.left + rb.right) / 2), dyc = Math.abs((ra.top + ra.bottom) / 2 - (rb.top + rb.bottom) / 2);
        if (rb.top >= ra.bottom - 1 && dxc > 1.5 * unit && dxc < (ra.width + rb.width) / 2) { offColumn++; columnIds.push(e.dataset.id); }
        if (rb.left >= ra.right - 1 && dyc > 1.5 * unit && dyc < (ra.height + rb.height) / 2) { offColumn++; columnIds.push(e.dataset.id); }
      }
    }
    // 6.7 a loop-back takes the nearest corridor: length ≤ Manhattan(ends) + 128
    let longLoops = 0; const longLoopIds = [];
    for (const [e, g] of geom) {
      if (!g.back) continue;
      const ctm = e.getScreenCTM(); const nums = (e.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g)?.map(Number) || [];
      const pts = []; for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
      let len = 0; for (let i = 1; i < pts.length; i++) len += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
      const a = pts[0], b = pts[pts.length - 1]; const manhattan = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
      if (len > manhattan + 128) { longLoops++; longLoopIds.push(`${e.dataset.id}:${Math.round(len)}>${Math.round(manhattan + 128)}`); }
    }
    f.longLoops = longLoops; f.longLoopIds = longLoopIds.slice(0, 3);
    // 6.3 one arrowhead per node side: edges arriving on the same side share a trunk and a head, centred on that side
    let multiHeads = 0; const multiHeadIds = [];
    const bySide = new Map();
    for (const [e, g] of geom) { const key = `${g.to}|${g.arrives}`; if (!bySide.has(key)) bySide.set(key, []); bySide.get(key).push(e); }
    for (const [key, list] of bySide) {
      if (list.length < 2) continue;
      const heads = new Set(list.map((e) => { const h = svg.querySelector(`.gc-arrow[data-id="${e.dataset.id}"]`); if (!h) return null; const hb = r(h); return `${Math.round(hb.left / unit)},${Math.round(hb.top / unit)}`; }).filter(Boolean));
      if (heads.size > 1) { multiHeads++; multiHeadIds.push(key.replace('|', ':')); }
    }
    f.multiHeads = multiHeads; f.multiHeadIds = multiHeadIds.slice(0, 3);
    // git graph (7.6 / 10.5): a lane spans only its own commits (from its fork or first
    // commit to its last commit or merge, +24), and no commit is labelled with a hash
    let laneOverrun = 0, hashLabels = 0;
    const lanes = [...svg.querySelectorAll('.gc-commit-lane')];
    if (lanes.length) {
      const dots = [...svg.querySelectorAll('.gc-commit-dot')].map((d) => r(d));
      const conns = [...svg.querySelectorAll('.gc-commit-connector')].map((c) => r(c));
      for (const lane of lanes) {
        const lb = r(lane); const cy = (lb.top + lb.bottom) / 2;
        const onLane = [...dots, ...conns].filter((b) => b.top - 2 <= cy && b.bottom + 2 >= cy);
        if (!onLane.length) continue;
        const l = Math.min(...onLane.map((b) => b.left)), rg = Math.max(...onLane.map((b) => b.right));
        if (lb.left < l - 24 * unit - 1 || lb.right > rg + 24 * unit + 1) laneOverrun++;
      }
      for (const t of svg.querySelectorAll('.gc-commit-label')) if (/^[0-9a-f]{1,2}-?[0-9a-f]{6,}$/i.test(t.textContent.trim())) hashLabels++;
    }
    // a connector never rides along a lane: its run collinear with any lane is ≤ 16
    let laneRide = 0;
    if (lanes.length) {
      const laneRects = lanes.map((l) => r(l));
      for (const c of svg.querySelectorAll('.gc-commit-connector')) {
        const ctm = c.getScreenCTM(); if (!ctm) continue;
        // walk the path properly: H/V carry one number, M/L/Q/C carry pairs
        const pts = []; let cx = 0, cy = 0;
        for (const seg of (c.getAttribute('d') || '').matchAll(/([MLHVQCZ])([^MLHVQCZ]*)/gi)) {
          const cmd = seg[1].toUpperCase(); const ns = (seg[2].match(/-?\d+(\.\d+)?/g) || []).map(Number);
          if (cmd === 'H') { cx = ns[0]; } else if (cmd === 'V') { cy = ns[0]; } else if (ns.length >= 2) { cx = ns[ns.length - 2]; cy = ns[ns.length - 1]; } else continue;
          pts.push([cx * ctm.a + ctm.e, cy * ctm.d + ctm.f]);
        }
        for (let i = 1; i < pts.length; i++) {
          const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
          if (Math.abs(y1 - y2) > 0.5) continue; // only horizontal runs can ride a lane
          const run = Math.abs(x2 - x1);
          for (const lr of laneRects) { const ly = (lr.top + lr.bottom) / 2; if (Math.abs(y1 - ly) < 2 && run > 16 * unit && Math.max(x1, x2) > lr.left && Math.min(x1, x2) < lr.right) { laneRide++; break; } }
        }
      }
    }
    f.laneRide = laneRide;
    f.laneOverrun = laneOverrun; f.hashLabels = hashLabels;
    f.hairpins = hairpins; f.hairpinIds = hairpinIds.slice(0, 3); f.wrongArrive = wrongArrive; f.arriveIds = arriveIds.slice(0, 3); f.offColumn = offColumn; f.columnIds = columnIds.slice(0, 3);
    // 6.4 two edges never share a segment: collinear overlap of more than 8 units
    const segsOf = (e) => { const nums = (e.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g)?.map(Number) || []; const pts = []; for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]); const out = []; out.start = pts[0]; out.end = pts[pts.length - 1]; for (let i = 1; i < pts.length; i++) { const [x1, y1] = pts[i - 1], [x2, y2] = pts[i]; if (Math.abs(x1 - x2) < 0.5 && Math.abs(y1 - y2) > 8) out.push({ v: true, c: x1, a: Math.min(y1, y2), b: Math.max(y1, y2) }); else if (Math.abs(y1 - y2) < 0.5 && Math.abs(x1 - x2) > 8) out.push({ v: false, c: y1, a: Math.min(x1, x2), b: Math.max(x1, x2) }); } return out; };
    let shared = 0; const allSegs = edgeEls.map(segsOf);
    for (let i = 0; i < allSegs.length; i++) for (let j = i + 1; j < allSegs.length; j++) for (const p of allSegs[i]) for (const q of allSegs[j]) {
      if (p.v !== q.v || Math.abs(p.c - q.c) > 1.5) continue;
      const o = Math.min(p.b, q.b) - Math.max(p.a, q.a); if (o <= 8) continue;
      // a bus is fine: both edges leave the same point or arrive at the same point
      const same = (u, w) => u && w && Math.abs(u[0] - w[0]) < 1.5 && Math.abs(u[1] - w[1]) < 1.5;
      if (same(allSegs[i].start, allSegs[j].start) || same(allSegs[i].end, allSegs[j].end)) continue;
      shared++;
    }
    f.sharedSegs = shared;
    // 6.4 parallel runs of different edges keep 16 apart (collinear or merely close, overlapping > 16)
    let crowded = 0; const crowdedIds = [];
    for (let i = 0; i < allSegs.length; i++) for (let j = i + 1; j < allSegs.length; j++) for (const p of allSegs[i]) for (const q of allSegs[j]) {
      if (p.v !== q.v) continue; const gap = Math.abs(p.c - q.c) / unit; if (gap < 1.5 || gap >= 16) continue;
      const o = Math.min(p.b, q.b) - Math.max(p.a, q.a); if (o / unit > 16) { crowded++; crowdedIds.push(`${edgeEls[i].dataset.id}|${edgeEls[j].dataset.id}:${Math.round(gap)}`); }
    }
    f.crowded = crowded; f.crowdedIds = crowdedIds.slice(0, 3);
    // 2.3 nodes whose vertical bands overlap are in the same row: same centre y (±1.5)
    let offRow = 0; const offRowIds = [];
    const adj = edgeEls.map((e) => { const m = (e.dataset.id || '').match(/^L_(.+?)_(.+?)_\d+$/); return { e, from: e.dataset.from || (m && m[1]), to: e.dataset.to || (m && m[2]) }; });
    const panelBoxes = [...svg.querySelectorAll('.gc-cluster')].map((c) => { const bx = c.querySelector('.gc-cluster-box, rect'); return bx ? r(bx) : null; }).filter(Boolean);
    const decisions = [...svg.querySelectorAll('.gc-node.gc-kind-decision, .gc-node.gc-kind-diamond')].map((n) => r(n.querySelector('.gc-outline,.gc-fill') || n));
    const nodeList = [...nodeById.entries()].map(([id, n]) => [id, r(n.querySelector('.gc-outline,.gc-fill') || n)]).filter(([, b]) => b.width);
    for (let i = 0; i < nodeList.length; i++) for (let j = i + 1; j < nodeList.length; j++) {
      const [ia, a] = nodeList[i], [ib, b] = nodeList[j];
      const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      // shapes differ in height (diamonds, markers), so a row is a shared centre line
      if (!(overlap > 4 * unit && Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) > 1.5 * unit)) continue;
      // exempt: different panels; or a decision node whose band spans both centres (its
      // branches fan above and below it — the diamond is the row they share)
      const panelOf = (b) => panelBoxes.findIndex((pb) => (b.left + b.right) / 2 > pb.left && (b.left + b.right) / 2 < pb.right && (b.top + b.bottom) / 2 > pb.top && (b.top + b.bottom) / 2 < pb.bottom);
      if (panelOf(a) !== panelOf(b)) continue;
      const ca = (a.top + a.bottom) / 2, cb = (b.top + b.bottom) / 2;
      const spanned = decisions.some((d) => d.top <= Math.min(ca, cb) && d.bottom >= Math.max(ca, cb))
        // …or one of the pair is itself the spanning shape (a diamond ≥ 1.5× taller than the other, holding its centre)
        || (a.height >= 1.5 * b.height && a.top <= cb && a.bottom >= cb) || (b.height >= 1.5 * a.height && b.top <= ca && b.bottom >= ca);
      if (spanned) continue;
      // a directly connected pair's alignment is governed by the edge rules, not the row rule
      if (adj.some((g) => (g.from === ia && g.to === ib) || (g.from === ib && g.to === ia))) continue;
      offRow++; offRowIds.push(`${ia}~${ib}`);
    }
    f.offRow = offRow; f.offRowIds = offRowIds.slice(0, 3);
    // 1.2 a wrapped primary path is folded into balanced rows: counting path nodes per row
    //     (ignoring the chain's first and last node), max − min ≤ 1
    let unbalanced = ''; let chainInfo = null;
    const pathNodes = [...svg.querySelectorAll('.gc-node.gc-role-path[data-id]')];
    if (pathNodes.length >= 4) {
      const ordered = pathNodes.map((n) => [n.dataset.id, r(n.querySelector('.gc-outline,.gc-fill') || n)]);
      // chain order: follow forward edges from the node with no path parent
      const pathIds = new Set(ordered.map(([id]) => id));
      const next = new Map(); const hasParent = new Set();
      for (const g of adj) if (pathIds.has(g.from) && pathIds.has(g.to) && !g.e.classList.contains('gc-back')) { if (!next.has(g.from)) next.set(g.from, g.to); hasParent.add(g.to); }
      let cur = ordered.find(([id]) => !hasParent.has(id))?.[0]; const chain = [];
      while (cur && !chain.includes(cur)) { chain.push(cur); cur = next.get(cur); }
      if (chain.length >= 4) {
        const inner = chain.slice(1, -1); const rows = new Map();
        // the chain wraps when some step goes down and back to the left
        let wraps = false; for (let k = 1; k < chain.length; k++) { const a = ordered.find(([i]) => i === chain[k - 1])[1], b = ordered.find(([i]) => i === chain[k])[1]; if (b.top >= a.bottom - 1 && b.right <= a.left + 1) wraps = true; }
        chainInfo = { chain, rows: 0, wraps };
        for (const id of inner) { const b = ordered.find(([i]) => i === id)[1]; const cy = Math.round((b.top + b.bottom) / 2 / unit / 8); rows.set(cy, (rows.get(cy) || 0) + 1); }
        const counts = [...rows.values()]; chainInfo.rows = counts.length; if (counts.length >= 2 && Math.max(...counts) - Math.min(...counts) > 1) unbalanced = counts.join('/');
      }
    }
    f.unbalanced = unbalanced;
    // 7.4 no orphan column on a wrapped chain: a primary-path node (not the chain's
    //     first or last) alone in its column while the chain wraps reads as tacked on
    let orphanCols = 0; const orphanIds = [];
    if (!clusters.length && chainInfo && chainInfo.wraps) {
      const cols = new Map();
      for (const [id, n] of nodeById) { if (n.classList.contains('gc-kind-marker')) continue; const b = r(n.querySelector('.gc-outline,.gc-fill') || n); if (!b.width) continue; const key = Math.round((b.left + b.right) / 2 / unit / 16); if (!cols.has(key)) cols.set(key, []); cols.get(key).push(id); }
      const inner = new Set(chainInfo.chain.slice(1, -1));
      if (cols.size >= 3) for (const [, ids] of cols) if (ids.length === 1 && inner.has(ids[0])) { orphanCols++; orphanIds.push(ids[0]); }
    }
    f.orphanCols = orphanCols; f.orphanIds = orphanIds.slice(0, 3);
    // 6.2 an edge leaves toward its target: target entirely below → from the bottom side;
    //     entirely to the right → from the right side (etc.). Uses data-from/data-to or L_a_b ids.
    let wrongSide = 0;
    for (const e of edgeEls) {
      const m = (e.dataset.id || '').match(/^L_(.+?)_(.+?)_\d+$/);
      const fromId = e.dataset.from || (m && m[1]), toId = e.dataset.to || (m && m[2]);
      const A = fromId && nodeById.get(fromId), B = toId && nodeById.get(toId); if (!A || !B) continue;
      if (e.classList.contains('gc-back')) continue;
      const ra = r(A.querySelector('.gc-outline,.gc-fill') || A), rb = r(B.querySelector('.gc-outline,.gc-fill') || B);
      const nums = (e.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g)?.map(Number) || []; if (nums.length < 2) continue;
      const ctm = e.getScreenCTM(); const sx = nums[0] * ctm.a + ctm.e, sy = nums[1] * ctm.d + ctm.f;
      const below = rb.top >= ra.bottom - 1, right = rb.left >= ra.right - 1, above = rb.bottom <= ra.top + 1, left = rb.right <= ra.left + 1;
      const overlapX = rb.left < ra.right && rb.right > ra.left;
      if (below && overlapX && Math.abs(sy - ra.bottom) > 8) wrongSide++;
      else if (above && overlapX && Math.abs(sy - ra.top) > 8) wrongSide++;
    }
    f.wrongSide = wrongSide;
    // 6.1 an edge keeps 16 units of clearance from every node it does not connect
    let hugging = 0; const hugIds = [];
    const nodeRects = [...nodeById.entries()].map(([id, n]) => [id, r(n.querySelector('.gc-outline,.gc-fill') || n)]);
    for (const e of edgeEls) {
      const m = (e.dataset.id || '').match(/^L_(.+?)_(.+?)_\d+$/);
      const fromId = e.dataset.from || (m && m[1]), toId = e.dataset.to || (m && m[2]);
      const ctm = e.getScreenCTM(); if (!ctm) continue;
      const nums = (e.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g)?.map(Number) || [];
      const pts = []; for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i] * ctm.a + ctm.e, nums[i + 1] * ctm.d + ctm.f]);
      let hit = false;
      for (let i = 1; i < pts.length && !hit; i++) {
        const x1 = Math.min(pts[i - 1][0], pts[i][0]), x2 = Math.max(pts[i - 1][0], pts[i][0]), y1 = Math.min(pts[i - 1][1], pts[i][1]), y2 = Math.max(pts[i - 1][1], pts[i][1]);
        if (x2 - x1 < 8 && y2 - y1 < 8) continue;
        for (const [id, nb] of nodeRects) {
          if (id === fromId || id === toId) continue;
          const clear = 16 * unit - 1;
          if (x1 < nb.right + clear && x2 > nb.left - clear && y1 < nb.bottom + clear && y2 > nb.top - clear) { hit = true; break; }
        }
      }
      if (hit) { hugging++; hugIds.push(e.dataset.id); }
    }
    f.hugging = hugging; f.hugIds = hugIds.slice(0, 3);
    // 6.2 an edge never passes through its own source or target box: only its first
    //     and last segments may touch them (the attachment stubs)
    let selfPierce = 0; const pierceIds = [];
    for (const e of edgeEls) {
      const m = (e.dataset.id || '').match(/^L_(.+?)_(.+?)_\d+$/);
      const fromId = e.dataset.from || (m && m[1]), toId = e.dataset.to || (m && m[2]);
      const ends = [fromId, toId].map((id) => id && nodeById.get(id)).filter(Boolean).map((n) => r(n.querySelector('.gc-outline,.gc-fill') || n));
      if (!ends.length) continue;
      const ctm = e.getScreenCTM(); if (!ctm) continue;
      const pts = []; let cx = 0, cy = 0;
      for (const seg of (e.getAttribute('d') || '').matchAll(/([MLHVQCZ])([^MLHVQCZ]*)/gi)) { const cmd = seg[1].toUpperCase(); const ns = (seg[2].match(/-?\d+(\.\d+)?/g) || []).map(Number); if (cmd === 'H') cx = ns[0]; else if (cmd === 'V') cy = ns[0]; else if (ns.length >= 2) { cx = ns[ns.length - 2]; cy = ns[ns.length - 1]; } else continue; pts.push([cx * ctm.a + ctm.e, cy * ctm.d + ctm.f]); }
      for (let i = 2; i < pts.length - 1; i++) { // interior segments only
        const x1 = Math.min(pts[i - 1][0], pts[i][0]), x2 = Math.max(pts[i - 1][0], pts[i][0]), y1 = Math.min(pts[i - 1][1], pts[i][1]), y2 = Math.max(pts[i - 1][1], pts[i][1]);
        if (x2 - x1 < 2 && y2 - y1 < 2) continue;
        if (ends.some((b) => x1 < b.right - 2 && x2 > b.left + 2 && y1 < b.bottom - 2 && y2 > b.top + 2)) { selfPierce++; pierceIds.push(e.dataset.id); break; }
      }
    }
    f.selfPierce = selfPierce; f.pierceIds = pierceIds.slice(0, 3);
    f.fill = sb.width && sb.height ? +(((maxX - minX) * (maxY - minY)) / (sb.width * sb.height)).toFixed(2) : 0;

    // 7.6 native or raw mermaid
    f.native = !!(svg.closest('.mount')?.querySelector('[class^="gc-"],[class*=" gc-"]')) && !svg.querySelector('.mermaid, [id^="mermaid"], .pieCircle, .mindmap-node, .commit');

    // 9 dark-on-dark text: cheap luminance check against the stage colour
    const lum = (c) => {
      const m = c.match(/\d+(\.\d+)?/g); if (!m) return null;
      const [R, G, B] = m.map(Number).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * R + 0.7152 * G + 0.0722 * B;
    };
    const bg = lum(getComputedStyle(svg.closest('.stage')).backgroundColor) ?? 0;
    let lowContrast = 0;
    for (const t of texts) {
      const L = lum(getComputedStyle(t).fill); if (L == null) continue;
      const ratio = (Math.max(L, bg) + 0.05) / (Math.min(L, bg) + 0.05);
      if (ratio < 3) lowContrast++;
    }
    f.lowContrast = lowContrast;
    return f;
  }, STAGE_PX);

  if (!m) {
    rows.push(`${short.padEnd(16)} FAIL  no svg`);
    results.push({ chart: short, status: 'FAIL', viewBox: null, fails: ['no svg'], warns: [] });
    failed++;
    continue;
  }
  if (shots) {
    const el = await pg.$('.chart:not([hidden]) .stage svg');
    await el.screenshot({ path: join(outDir, `${short}.png`) });
  }

  const svg_is_er = short === 'er'; // crow's-foot marks are several .gc-arrow per edge by design
  const fails = [], warns = [];
  if (!m.native) fails.push('7.6 raw mermaid');
  if (m.vb[0] < 480 || m.vb[0] > 1200) fails.push(`1.1 canvas ${m.vb[0]}w`);
  if (m.vb[1] > m.vb[0] * 1.4) fails.push(`1.4 taller than 1.4×w (${m.vb[1]})`);
  if (m.minScreen < 8) fails.push(`3.1 ${m.minScreen}px on screen "${m.minScreenText}"`);
  if (m.sizes.length > 5) warns.push(`3 ${m.sizes.length} text sizes (${m.sizes.join('/')})`);
  if (m.rotated > 1) fails.push(`3.4 ${m.rotated} rotated`);
  else if (m.rotated) warns.push('3.4 1 rotated (axis label is allowed)');
  if (m.overlaps) fails.push(`6.5 ${m.overlaps} label overlaps`);
  if (m.swallowed) fails.push(`6.5 ${m.swallowed} labels swallowing their edge (${m.swallowIds.join(' ')})`);
  if (m.collisions) fails.push(`6.5 ${m.collisions} text/shape collisions`);
  if (m.rowGaps) fails.push(`2.3 ${m.rowGaps} arbitrary gaps inside a row (${m.rowGapIds.join(' ')})`);
  if (m.rowsOff) fails.push(`7.3 ${m.rowsOff} rows off the composition centre (${m.rowOffIds.join(' ')})`);
  if (m.panelEscapes) fails.push(`2.6 ${m.panelEscapes} texts/boxes escaping their panel`);
  if (m.panelSlack) fails.push(`2.6 ${m.panelSlack} panels not hugging contents (${m.slackIds.join(' ')})`);
  if (m.escapes) fails.push(`2.2 ${m.escapes} labels escape box`);
  if (m.clipped) fails.push(`7.5 ${m.clipped} clipped at edge`);
  if (m.doubleHeads && !svg_is_er) fails.push(`6.3 ${m.doubleHeads} stacked arrowheads`);
  if (m.nodeSizes.length > 2) warns.push(`2.2 ${m.nodeSizes.length} box sizes (${m.nodeSizes.slice(0, 4).join(' ')})`);
  if (m.offGrid) warns.push(`2.1 ${m.offGrid} boxes off 8-grid`);
  if (m.fill < 0.35) warns.push(`7.4 content covers ${Math.round(m.fill * 100)}% of canvas`);
  if (m.lowContrast) fails.push(`9 ${m.lowContrast} low-contrast texts`);
  if (Math.abs(m.offCentre) > 8) fails.push(`7.3 content off-centre by ${m.offCentre}`);
  if (m.offText) fails.push(`10.2 ${m.offText} labels off-centre in box`);
  if (m.offMid) fails.push(`6.2 ${m.offMid} vertical edges off the node centreline`);
  if (m.jogs) fails.push(`6.1 ${m.jogs} short jogs in edges`);
  if (m.detours) fails.push(`6.1 ${m.detours} detouring edges (${m.detourIds.join(' ')})`);
  if (m.laneRide) fails.push(`6.4 ${m.laneRide} connector runs riding along a lane`);
  if (m.laneOverrun) fails.push(`10.5 ${m.laneOverrun} lanes running past their commits`);
  if (m.hashLabels) fails.push(`3.2 ${m.hashLabels} commits labelled with a hash`);
  if (m.longLoops) fails.push(`6.7 ${m.longLoops} loop-backs longer than the nearest corridor (${m.longLoopIds.join(' ')})`);
  if (m.multiHeads) fails.push(`6.3 ${m.multiHeads} node sides with more than one arrowhead (${m.multiHeadIds.join(' ')})`);
  if (m.hairpins) fails.push(`6.7 ${m.hairpins} hairpins (${m.hairpinIds.join(' ')})`);
  if (m.wrongArrive) fails.push(`6.2 ${m.wrongArrive} edges arriving on the wrong side (${m.arriveIds.join(' ')})`);
  if (m.offColumn) fails.push(`2.3 ${m.offColumn} sole children off their parent's centre line (${m.columnIds.join(' ')})`);
  if (m.offChannel) fails.push(`6.1 ${m.offChannel} Z edges not centred in their channel (${m.offChannelIds.join(' ')})`);
  if (m.overBent) fails.push(`6.1 ${m.overBent} edges with too many bends (${m.bentIds.join(' ')})`);
  if (m.crossings) fails.push(`6.1 ${m.crossings} forward edges crossing (${m.crossIds.join(' ')})`);
  if (m.selfPierce) fails.push(`6.2 ${m.selfPierce} edges passing through their own node (${m.pierceIds.join(' ')})`);
  if (m.hugging) fails.push(`6.1 ${m.hugging} edges within 16 of a foreign node (${m.hugIds.join(' ')})`);
  if (m.wrongSide) fails.push(`6.2 ${m.wrongSide} edges leaving the wrong side`);
  if (m.orphanCols) fails.push(`7.4 ${m.orphanCols} orphan columns (${m.orphanIds.join(' ')})`);
  if (m.unbalanced) fails.push(`1.2 primary path folded into unbalanced rows (${m.unbalanced})`);
  if (m.crowded) fails.push(`6.4 ${m.crowded} parallel edge runs closer than 16 (${m.crowdedIds.join(' ')})`);
  if (m.offRow) fails.push(`2.3 ${m.offRow} node pairs overlapping bands but not sharing a row (${m.offRowIds.join(' ')})`);
  if (m.sharedSegs) fails.push(`6.4 ${m.sharedSegs} edge pairs sharing a segment`);
  if (m.touching) fails.push(`2.3 ${m.touching} edges under 16 units — nodes touching`);
  if (m.rawTags) fails.push(`3.2 ${m.rawTags} labels with a literal <br>`);
  if (m.labelOnEdge) fails.push(`6.5 ${m.labelOnEdge} labels sitting on another edge`);

  if (fails.length) failed++;
  const status = fails.length ? 'FAIL' : warns.length ? 'WARN' : 'ok  ';
  results.push({ chart: short, status: status.trim(), viewBox: m.vb, fails, warns });
  rows.push(`${short.padEnd(16)} ${status}  ${m.vb.join('×')}`.padEnd(36) + [...fails, ...warns.map((w) => `(${w})`)].join('; '));
}
await browser.close();

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(rows.join('\n'));
  console.log(`\n${rows.length} charts, ${failed} failing${shots ? `, shots in ${outDir}` : ''}`);
}
process.exit(failed ? 1 : 0);
