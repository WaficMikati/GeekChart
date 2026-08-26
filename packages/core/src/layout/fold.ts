import type { Graph, GraphNode } from '../graph.ts';
import type { Scene } from '../scene.ts';
import type { ElkNode } from './elk.ts';
import { snapOrphanColumns } from './satellites.ts';

/**
 * Wrapping a chain that overruns the canvas into rows, and scoring how well a
 * candidate wrap reads. DESIGN 1.1, 1.2, 1.4, 2.1, 2.3, 6.7, 6.8, 7.4.
 */

/**
 * Wrap a run that does not fit the canvas into rows. DESIGN 1.2 and 1.4.
 *
 * A nine-step flow laid left to right is 2500 units of picture on a 1000-unit
 * stage; shown at stage width its type is 5px and the diagram is a thin strip
 * across an empty page. Both are the same fault, and neither is fixable in CSS:
 * the answer is fewer nodes per row, which is a layout decision.
 *
 * ELK's layered algorithm can do this itself — `wrapping.strategy` cuts the
 * chain into chunks and stacks them — but only if it is told what shape to aim
 * for. So the aspect targets are tried in order from "one long row" to "nearly
 * square", and the first result that fits the content box is taken. Doing it
 * inside ELK rather than folding afterwards keeps the edges routed: a fold pass
 * would move nodes out from under the routes that were computed for them.
 */
export async function fold(
  run: (extra: Record<string, string>) => Promise<ElkNode>,
  graph: Graph,
  scene: Scene,
  flow: 'horizontal' | 'vertical',
  context: { claimed: Set<string>; satelliteIds: Set<string>; soleParent: Map<string, string> },
): Promise<ElkNode> {
  const room = scene.canvas.width - scene.canvas.margin * 2;
  const tall = room * scene.canvas.maxAspect;

  // ELK lays a graph out by mutating the same node objects it was handed
  // (`children`, closed over inside `run`) rather than returning fresh ones, so
  // every retry in the loop below writes new x/y straight over whatever the
  // previous attempt left there. A candidate kept only by reference — as `best`
  // used to be — silently turns into the *last* attempt's positions by the time
  // the loop ends, even though its own `width`/`height` (a fresh wrapper object
  // each call) still read correctly. Comparing more than one candidate, which
  // choosing the best-quality fold requires, means every candidate that might
  // still be needed after another `run()` call has to be copied out first.
  const cloneElk = (n: ElkNode): ElkNode => ({
    id: n.id,
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
    children: n.children?.map(cloneElk),
  });

  const first = cloneElk(await run({}));
  const fits = (r: ElkNode) => (r.width ?? 0) <= room && (r.height ?? 0) <= tall;
  // A left-to-right run of more than six nodes wraps even when it would just
  // about fit: past six the row is a strip whatever the arithmetic says.
  const overlong = flow === 'horizontal' && longestPath(graph) > 6;
  // The other half of the same fault. A stack that uses a third of the width is
  // as wrong as a run that needs three times it — both leave most of the stage
  // empty, which is what DESIGN 1.4 and 7.4 are about. Folding a tall stack into
  // columns is exactly "tall stacks go side by side".
  // Wrapping a short chain that answers itself with a back edge (a retry, a
  // state that returns) can wedge a node between two ranks it has real edges
  // to on both sides — state.mmd's Paused ended up sharing Graduated's row,
  // boxing in Graduated → root_end, only because ELK's MULTI_EDGE wrap had to
  // put its six states somewhere once folding was asked for. There is no real
  // freedom in a chain this short anyway (the same "more than six" the
  // horizontal case above uses), so a plain back-edge diagram this size skips
  // the wasteful trigger and stays tall — content this small still reads
  // fine on a narrow canvas. A diagram with no back edge (class.mmd's plain
  // record chain) still folds exactly as before; the risk is specific to the
  // shape a cycle creates, not to being short.
  const shortBackEdged = graph.edges.some((e) => e.backward) && longestPath(graph) <= 6;
  const wasteful = (r: ElkNode) =>
    !shortBackEdged && ((r.width ?? 0) < room * 0.55 || (r.height ?? 0) > (r.width ?? 1) * 1.2);
  if (fits(first) && !overlong && !wasteful(first)) return first;

  // ELK's own wrapping (`wrapping.strategy: MULTI_EDGE`, below) cannot be
  // pointed at a chosen cut point in this bundle — `wrapping.cutting.cuts`
  // throws — so it wraps wherever its own heuristic lands, which is what
  // stranded 4geeks-journey's bootcamp step alone in a column (DESIGN 7.4).
  // A graph with a real node chain (not platform-layers's chain of clusters,
  // which has no usable `primaryPath` and falls through to ELK below) gets
  // its own serpentine fold instead: DESIGN 1.2, 2.3, 7.4.
  const serpentined = buildSerpentine(graph, scene, room, context);
  if (serpentined) return serpentined;

  // Widest fold first, and stop at the first one that fits: a wrapped diagram
  // should use the canvas it has rather than huddle in the middle of it. 3.2 is
  // one row of a six-step flow; 0.9 is the squarest worth making before the
  // thing stops reading as a sequence at all.
  //
  // That "first that fits" search is kept exactly as it was — it is `original`
  // below, the fallback whenever nothing better turns up. But "fits" alone
  // isn't enough of a bar: the widest fit can still cut the chain into
  // unbalanced rows (DESIGN 1.2) or strand a chain node by itself in a column
  // once the fold wraps (DESIGN 7.4) — 4geeks-journey's bootcamp step did both,
  // landing alone at the end of row one instead of paired with Portfolio in row
  // two, at an aspect ratio ELK never even offered a "fits" candidate for. So
  // every aspect is tried (rather than stopping at the first fit), each one
  // scored for chain quality as well as `cost`, and a candidate that clears the
  // balance/orphan bar wins over one that doesn't — even if it costs more —
  // because a fold that reads as tacked-on is a worse fault than a fold that
  // needed fitCanvas's own last-resort shrink a little harder. Among
  // quality-passing candidates the existing preference order still applies:
  // the widest that fits, or else the one `cost` likes best — which is what
  // "closest to the canvas's aspect target" means here, since the aspect list
  // itself runs from that target outward.
  let originalBest = first;
  let originalBestCost = cost(first, room, tall);
  let originalFirstFit: ElkNode | null = null;
  let qualityFirstFit: ElkNode | null = null;
  let qualityBest: ElkNode | null = null;
  let qualityBestCost = Infinity;
  for (const aspect of [3.2, 2.4, 1.8, 1.4, 1.1, 0.9]) {
    let candidate: ElkNode;
    try {
      // Cloned immediately: this candidate must survive whatever the next
      // `run()` call in the loop does to the shared node objects.
      candidate = cloneElk(
        await run({
          'elk.aspectRatio': String(aspect),
          'elk.layered.wrapping.strategy': 'MULTI_EDGE',
          'elk.layered.wrapping.additionalEdgeSpacing': String(scene.gapNode),
          'elk.layered.wrapping.correctionFactor': '1',
        }),
      );
    } catch {
      // A graph ELK cannot wrap keeps the layout it already has.
      break;
    }
    snapOrphanColumns(candidate.children ?? [], graph.primaryPath, graph.edges);
    const quality = foldQuality(candidate.children ?? [], graph.primaryPath);
    const passes = quality.balanced && quality.orphanFree;
    // A candidate that clears the room by only a sliver is a real fit: `fitCanvas`
    // absorbs anything this close with its own last-resort shrink (scene.ts), so
    // rejecting it here on the strict `room` test just sent the search on to a
    // narrower, worse-shaped fold — one `cost()` scored lower purely because it
    // weighs overflow far above wasted area, not because it reads better. Taking
    // the widest near-fit is what "stop at the first one that fits" (above)
    // already says to do.
    if (fits(candidate) || (candidate.width ?? 0) <= room * 1.05) {
      if (!originalFirstFit) originalFirstFit = candidate;
      if (passes && !qualityFirstFit) qualityFirstFit = candidate;
      continue;
    }
    const c = cost(candidate, room, tall);
    if (c < originalBestCost) {
      originalBest = candidate;
      originalBestCost = c;
    }
    if (passes && c < qualityBestCost) {
      qualityBest = candidate;
      qualityBestCost = c;
    }
  }
  const original = originalFirstFit ?? originalBest;
  const quality = qualityFirstFit ?? qualityBest;
  return quality ?? original;
}

interface PlacedNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ChainGrid {
  placed: PlacedNode[];
  /** Chain nodes by row, in the order they land in — column index is position in the row. */
  rows: GraphNode[][];
  /** Each column's shared left edge and width (DESIGN 2.3). */
  colX: number[];
  colW: number[];
  width: number;
  height: number;
}

/**
 * Split `n` items into as few rows as `k` allows, sizes differing by at most
 * one (DESIGN 1.2's "balanced"), the short rows first — the shape
 * 4geeks-journey's own single lead-in node needs: one row of one, then full
 * rows of `k`, never a short row stuck at the tail where it would read as an
 * afterthought instead of a lead-in.
 */
function chunkChainRows(n: number, k: number): number[] {
  const rowCount = Math.ceil(n / k);
  const base = Math.floor(n / rowCount);
  const long = n - base * rowCount; // rows carrying one extra node
  const sizes: number[] = [];
  for (let i = 0; i < rowCount - long; i++) sizes.push(base);
  for (let i = 0; i < long; i++) sizes.push(base + 1);
  return sizes;
}

/**
 * Lay a chain into a `k`-wide grid: every row left to right, column `c`
 * sharing one `x`/width across every row that reaches it (DESIGN 2.3), rows
 * pitched by their own height plus a 64-unit corridor (room for the wrap
 * edge and, where one lands, a fanned-off branch). Because every row fills
 * left to right starting at column 0, row `r+1`'s first node always lands
 * directly under row `r`'s first node — the Z-wrap DESIGN 1.2 asks for,
 * rather than a boustrophedon that would reverse direction every other row.
 */
function buildChainGrid(
  chainNodes: GraphNode[],
  k: number,
  gutter: number,
  corridor: number,
): ChainGrid {
  const sizes = chunkChainRows(chainNodes.length, k);
  const rows: GraphNode[][] = [];
  let idx = 0;
  for (const size of sizes) {
    rows.push(chainNodes.slice(idx, idx + size));
    idx += size;
  }
  const cols = Math.max(...sizes);
  const colW: number[] = [];
  for (let c = 0; c < cols; c++) {
    colW.push(Math.max(...rows.filter((r) => r[c]).map((r) => r[c]!.width!)));
  }
  const colX: number[] = [0];
  for (let c = 1; c < cols; c++) colX.push(colX[c - 1]! + colW[c - 1]! + gutter);
  const rowH = rows.map((row) => Math.max(...row.map((n) => n.height!)));
  const rowCy: number[] = [rowH[0]! / 2];
  for (let r = 1; r < rows.length; r++) {
    rowCy.push(rowCy[r - 1]! + rowH[r - 1]! / 2 + corridor + rowH[r]! / 2);
  }
  const placed: PlacedNode[] = [];
  rows.forEach((row, r) => {
    row.forEach((node, c) => {
      placed.push({
        id: node.id,
        x: colX[c]! + (colW[c]! - node.width!) / 2,
        y: rowCy[r]! - node.height! / 2,
        width: node.width!,
        height: node.height!,
      });
    });
  });
  return {
    placed,
    rows,
    colX,
    colW,
    width: colX[cols - 1]! + colW[cols - 1]!,
    height: rowCy[rows.length - 1]! + rowH[rows.length - 1]! / 2,
  };
}

/**
 * Replace ELK's wrap with our own for a graph whose primary path is a real
 * node chain. DESIGN 1.2, 2.3, 6.7, 7.4.
 *
 * Only the chain enters the grid built above. Everything else `fold`'s
 * caller still hands to this pass — a decision's "no" branch, a retry
 * source, anything with a real edge to a chain node that isn't itself a
 * dead-end satellite (those are pinned separately, after layout, by the
 * existing satellite pass) — hangs off the chain node it is tied to: to its
 * right, 24 clear of its centre line, above or below depending which side is
 * free. A node this pass doesn't recognise (no edge to any chain node at
 * all) returns `null` for the whole graph, which sends the caller to ELK's
 * own wrap instead of drawing something broken.
 */
function buildSerpentine(
  graph: Graph,
  scene: Scene,
  room: number,
  ctx: { claimed: Set<string>; satelliteIds: Set<string>; soleParent: Map<string, string> },
): ElkNode | null {
  const chain = graph.primaryPath;
  if (chain.length < 4) return null;
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  if (!chain.every((id) => byId.has(id) && !ctx.claimed.has(id))) return null;
  const chainNodes = chain.map((id) => byId.get(id)!);
  if (chainNodes.some((n) => n.width === undefined || n.height === undefined)) return null;

  // Wider than a plain sibling gutter (DESIGN 2.3's 24/32 governs a row's own
  // rhythm, which the gate only checks inside a panel — plain-flowchart rows
  // are free to breathe more): a decision's "no" branch loops back into its
  // own diamond from the side its forward edge arrived on (DESIGN 6.8), which
  // can mean cutting back through the very column gap it sits beside. A
  // 32-unit gap leaves zero margin for 16 clearance on both flanking
  // nodes at once; 64 leaves room to actually route it.
  const gutter = 64;
  const corridor = 64;
  const chainSet = new Set(chain);

  // Every k from 2 up to "more than six is a strip whatever the arithmetic
  // says" (the same cap `fold`'s overlong check uses): among the ones that
  // fit the content box, the one closest to DESIGN 1.4's own aspect ceiling
  // is preferred. The canvas hugs its content (DESIGN 1.1), so there is no
  // "half the width" floor to defend here the way an unwrapped run has to —
  // a narrower, taller fold just hugs down to a smaller canvas. What a fold
  // can still get wrong is being flatter than it needs to be: a two-row
  // spread across six columns reads as a strip with the wrap spent on width
  // it didn't need, so the target is 1.4 itself (as tall as 1.4 allows),
  // not 1 (square) — the fold that gets closest to *using* the ceiling
  // without crossing it.
  const target = scene.canvas.maxAspect;
  const maxK = Math.min(chainNodes.length - 1, 6);
  const candidates: ChainGrid[] = [];
  for (let k = 2; k <= maxK; k++) candidates.push(buildChainGrid(chainNodes, k, gutter, corridor));
  const pool = candidates.filter((g) => g.width <= room && g.height <= g.width * target);
  if (!pool.length) return null;
  const best = pool.reduce((a, b) =>
    Math.abs(b.height / b.width - target) < Math.abs(a.height / a.width - target) ? b : a,
  );

  const placed = new Map<string, PlacedNode>();
  for (const p of best.placed) placed.set(p.id, p);

  const overlaps = (a: PlacedNode, b: PlacedNode) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const collides = (p: PlacedNode) =>
    [...placed.values()].some((o) => o.id !== p.id && overlaps(p, o));

  // The wrap edge itself needs the corridor between two rows whenever the
  // row above ends past column 0 — the Z-wrap's drop-and-return travels the
  // full width from that row's last column back to column 0 (DESIGN 1.2), so
  // a satellite parked in that span crowds the one edge this whole pass
  // exists to make room for.
  const corridorPad = 16;
  const corridors: PlacedNode[] = [];
  for (let r = 0; r < best.rows.length - 1; r++) {
    const row = best.rows[r]!;
    if (row.length < 2) continue;
    const lastCol = row.length - 1;
    const x0 = best.colX[0]! - corridorPad;
    const x1 = best.colX[lastCol]! + best.colW[lastCol]! + corridorPad;
    const rowBottom = Math.max(...row.map((n) => placed.get(n.id)!.y + placed.get(n.id)!.height));
    const nextRow = best.rows[r + 1]!;
    const rowTop = Math.min(...nextRow.map((n) => placed.get(n.id)!.y));
    corridors.push({
      id: `corridor:${r}`,
      x: x0,
      y: rowBottom - corridorPad,
      width: x1 - x0,
      height: rowTop - rowBottom + corridorPad * 2,
    });
  }
  const blocked = (p: PlacedNode) => collides(p) || corridors.some((c) => overlaps(p, c));

  // Everything ELK would otherwise have been handed: clusters and the
  // existing dead-end satellite pass have already been excluded upstream.
  const nonChain = graph.nodes.filter(
    (n) => !chainSet.has(n.id) && !ctx.claimed.has(n.id) && !ctx.satelliteIds.has(n.id),
  );
  for (const node of nonChain) {
    if (node.width === undefined || node.height === undefined) return null;
    // A decision's own branch (a forward edge from the chain) takes priority
    // over a retry's target (a backward edge into the chain) when a node is
    // both — a "no" branch that loops back to its own diamond is anchored on
    // the diamond it visibly hangs off, not on itself.
    const forwardParent = graph.edges.find(
      (e) => e.to === node.id && !e.backward && chainSet.has(e.from),
    )?.from;
    const retryTarget = graph.edges.find(
      (e) => e.from === node.id && e.backward && chainSet.has(e.to),
    )?.to;
    const anchorId = forwardParent ?? retryTarget;
    const anchor = anchorId ? placed.get(anchorId) : undefined;
    const anchorRow = anchorId
      ? best.rows.findIndex((row) => row.some((n) => n.id === anchorId))
      : -1;
    if (!anchorId || !anchor || anchorRow < 0) return null;

    const row = best.rows[anchorRow]!;
    const anchorCol = row.findIndex((n) => n.id === anchorId);
    let ok = false;

    // The anchor is the last node in its own row: a fresh column past it, on
    // its own row's exact centre line, reads as "B, its yes-child, its
    // no-branch" left to right, and DESIGN 2.3's directly-connected-pair
    // carve-out covers sharing that row with the anchor. Only safe when
    // nothing else sits between them — with a row-mate in the way (the
    // anchor is *not* last), a same-row port draws a straight line through
    // that row-mate instead of bending around it, which the router doesn't
    // do on its own (4geeks-journey's Prep course, once tried past its
    // diamond's own "yes" sibling, drew straight through it).
    if (anchorCol === row.length - 1) {
      const rowRight = best.colX[row.length - 1]! + best.colW[row.length - 1]!;
      const sameRow = [...placed.values()].filter(
        (p) => Math.abs(p.y + p.height / 2 - (anchor.y + anchor.height / 2)) < 4,
      );
      const left = Math.max(rowRight, ...sameRow.map((p) => p.x + p.width));
      const x = left + gutter;
      const y = anchor.y + anchor.height / 2 - node.height / 2;
      const trial: PlacedNode = { id: node.id, x, y, width: node.width, height: node.height };
      if (!blocked(trial)) {
        placed.set(node.id, trial);
        ok = true;
      }
    }

    // Otherwise, immediately beside the anchor itself — close enough that
    // its forward edge bends right away rather than travelling at the
    // anchor's own exit height past whatever row-mate sits further along
    // (an ordinary forward edge has no obstacle check of its own; sending it
    // even part-way down a row-mate's own row before turning is what drew a
    // straight line through it, or a wide loop around it, in earlier
    // attempts at this) — and only 8 clear above or below the anchor's own
    // edge, not the full 24 a still-blocked candidate steps out to, so it
    // never has to reach far enough to invade a neighbouring row's band
    // (DESIGN 2.3 — that row is not the one this satellite has a real edge
    // to). Clamped the same way regardless, so a tight corridor still wins
    // over a stray band overlap.
    if (!ok) {
      const x = anchor.x + anchor.width + 24;
      const above =
        anchorRow > 0
          ? Math.max(
              ...best.rows[anchorRow - 1]!.map(
                (n) => placed.get(n.id)!.y + placed.get(n.id)!.height,
              ),
            )
          : -Infinity;
      const below =
        anchorRow < best.rows.length - 1
          ? Math.min(...best.rows[anchorRow + 1]!.map((n) => placed.get(n.id)!.y))
          : Infinity;
      for (const clearance of [8, 16, 24]) {
        const candidates = [
          Math.max(anchor.y - clearance - node.height, above + 8),
          Math.min(anchor.y + anchor.height + clearance, below - 8 - node.height),
        ];
        for (const y of candidates) {
          const trial: PlacedNode = { id: node.id, x, y, width: node.width, height: node.height };
          if (!blocked(trial)) {
            placed.set(node.id, trial);
            ok = true;
            break;
          }
        }
        if (ok) break;
      }
    }
    if (!ok) return null;
  }

  const all = [...placed.values()];
  return {
    id: 'root',
    width: Math.max(...all.map((p) => p.x + p.width)),
    height: Math.max(...all.map((p) => p.y + p.height)),
    children: all.map((p) => ({ id: p.id, x: p.x, y: p.y, width: p.width, height: p.height })),
  };
}

/**
 * How a folded candidate's primary-path chain reads once wrapped. DESIGN 1.2,
 * 7.4.
 *
 * Mirrors the gate's own checks so the layout aims for exactly what it
 * measures: `balanced` is false when the chain's inner rows differ by more
 * than one node, `orphanFree` is false when some inner chain node ends up
 * alone in its column (a 16-unit x-band shared by no other node anywhere in
 * the diagram) — the tell that a fold tacked one node on rather than pairing
 * it. Both only mean anything once the chain actually wraps (some step goes
 * down and back to the left) — a plain single-row chain has every node in its
 * own column by construction, which would misread as wall-to-wall orphans if
 * this didn't check first. Row and column are read straight off ELK's own
 * coordinates, which are already in canvas units, so the tolerance windows (8
 * for a shared row, 16 for a shared column) match the grid DESIGN 2.1/2.3
 * draws nodes on.
 */
/**
 * Group items by centre the same way `square()`'s own `gridUp` pass does: sort
 * by centre, start a new group whenever the gap to the *previous* item (not
 * the group's start) exceeds the tolerance. That "compare to the last item
 * added" rule is what lets a diamond's tall body chain three siblings into one
 * group even though the two ends are further apart than the tolerance alone
 * would allow — replicating that quirk here is the point, since it is what
 * decides which columns `gridUp` will actually produce.
 */
export function bandByCentre(
  items: ElkNode[],
  centreOf: (n: ElkNode) => number,
  tolerance = 9,
): ElkNode[][] {
  const order = [...items].sort((a, b) => centreOf(a) - centreOf(b));
  const groups: ElkNode[][] = [];
  let group: ElkNode[] = [];
  for (const item of order) {
    if (group.length && centreOf(item) - centreOf(group[group.length - 1]!) > tolerance) {
      groups.push(group);
      group = [];
    }
    group.push(item);
  }
  if (group.length) groups.push(group);
  return groups;
}

/** Does this chain's layout actually wrap (some step goes down and back left)? */
export function chainWraps(byId: Map<string, ElkNode>, chain: string[]): boolean {
  for (let k = 1; k < chain.length; k++) {
    const a = byId.get(chain[k - 1]!);
    const b = byId.get(chain[k]!);
    if (!a || !b) continue;
    if (a.x === undefined || a.y === undefined || a.width === undefined || a.height === undefined)
      continue;
    if (b.x === undefined || b.y === undefined || b.width === undefined) continue;
    if (b.y >= a.y + a.height - 1 && b.x + b.width <= a.x + 1) return true;
  }
  return false;
}

function foldQuality(
  children: ElkNode[],
  chain: string[],
): { balanced: boolean; orphanFree: boolean } {
  const inner = chain.slice(1, -1);
  if (inner.length < 2) return { balanced: true, orphanFree: true };
  const byId = new Map(children.map((n) => [n.id, n] as const));
  // Nested-cluster coordinates are relative to their parent, not the canvas,
  // so a chain that dips into a cluster can't be scored against top-level
  // nodes here — leave it be rather than compare unlike bases.
  if (!chain.every((id) => byId.has(id))) return { balanced: true, orphanFree: true };
  if (!chainWraps(byId, chain)) return { balanced: true, orphanFree: true };

  // Rows and columns here have to predict what `square()`'s own `gridUp` pass
  // will do to this candidate once it's chosen, not just describe the raw ELK
  // coordinates — hence banding by centre instead of rounding into fixed-size
  // buckets, which let a candidate that *looked* orphan-free on its raw
  // coordinates (16-unit buckets happened to separate every node into its own
  // bucket) turn out to still strand a node once banded for real.
  const innerNodes = inner
    .map((id) => byId.get(id)!)
    .filter((n) => n.y !== undefined && n.height !== undefined);
  const rowGroups = bandByCentre(innerNodes, (n) => n.y! + n.height! / 2);
  const counts = rowGroups.map((g) => g.length);
  const balanced = counts.length < 2 || Math.max(...counts) - Math.min(...counts) <= 1;

  const withXY = children.filter((n) => n.x !== undefined && n.width !== undefined);
  const colGroups = bandByCentre(withXY, (n) => n.x! + n.width! / 2);
  const innerSet = new Set(inner);
  const orphanFree =
    colGroups.length < 3 || colGroups.every((g) => !(g.length === 1 && innerSet.has(g[0]!.id)));

  return { balanced, orphanFree };
}

/**
 * How badly a layout misses the canvas.
 *
 * Overflow past the content box is what actually breaks a rule, so it is
 * weighted an order of magnitude above the emptiness left behind — a diagram
 * with room to spare is worse-looking, one that runs off the stage is wrong.
 */
function cost(r: ElkNode, room: number, tall: number): number {
  const w = r.width ?? 0;
  const h = r.height ?? 0;
  const over = Math.max(0, w - room) + Math.max(0, h - tall);
  const waste = Math.max(0, room - w) * 0.06;
  return over * 10 + waste;
}

/** Nodes on the longest chain, which is what a row has to hold. DESIGN 1.2. */
export function longestPath(graph: Graph): number {
  const next = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.from === e.to || e.backward) continue;
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  }
  const seen = new Map<string, number>();
  const walk = (id: string, stack: Set<string>): number => {
    if (stack.has(id)) return 0; // a cycle contributes nothing further
    const known = seen.get(id);
    if (known !== undefined) return known;
    stack.add(id);
    const depth = 1 + Math.max(0, ...(next.get(id) ?? []).map((n) => walk(n, stack)));
    stack.delete(id);
    seen.set(id, depth);
    return depth;
  };
  return Math.max(0, ...graph.nodes.map((n) => walk(n.id, new Set())));
}
