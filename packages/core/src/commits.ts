import { parseWith } from './graph.ts';
import { makeMeasurer } from './layout.ts';
import { Track } from './motion.ts';
import { fitCanvas, frameTransform, type Scene } from './scene.ts';

/**
 * Git graph.
 *
 * One thing only, so it earns its own file rather than joining radial.ts: a set
 * of lanes (branches) and a sequence of dots on them (commits), connected across
 * lanes wherever a commit's parent sits on a different branch. Time runs left to
 * right; nothing here is a tree radiating from a centre, which is what makes it
 * a different shape from mindmap rather than a variant of it.
 *
 * Lanes are not canvas-wide rules (DESIGN 10.5): main runs from 24 before its
 * first commit to 24 after its last, and a side branch runs only between its
 * own first and last commit — the fork and merge connectors are what carry the
 * eye into and out of it, so the lane itself never has to.
 */

export type CommitKind = 'gitgraph';

/** Mermaid's own commitType enum (gitGraphAst.ts). Only MERGE matters here. */
const MERGE_TYPE = 3;

interface CommitInfo {
  id: string;
  seq: number;
  branch: string;
  parents: string[];
  /** type === MERGE_TYPE. A merge commit is drawn as a hollow ring and
   *  labelled with the branch it merged, never its (often hash-like) id. */
  merge: boolean;
}

export interface Commits {
  kind: CommitKind;
  title?: string;
  branches: string[];
  commits: CommitInfo[];
}

const clean = (t: unknown) => String(t ?? '').trim();

export async function toCommits(source: string): Promise<Commits> {
  const db = await parseWith(source);
  const title = clean(db.getDiagramTitle?.());
  const branches = ((db.getBranchesAsObjArray?.() as { name?: string }[] | undefined) ?? []).map((b) => clean(b.name));
  const raw =
    (db.getCommitsArray?.() as
      | { id?: string; seq?: number; branch?: string; parents?: string[]; type?: number }[]
      | undefined) ?? [];
  const commits: CommitInfo[] = raw
    .map((c) => ({
      id: clean(c.id),
      seq: Number(c.seq) || 0,
      branch: clean(c.branch),
      parents: (c.parents ?? []).map(clean).filter(Boolean),
      merge: Number(c.type) === MERGE_TYPE,
    }))
    .sort((a, b) => a.seq - b.seq);
  if (!commits.length) throw new Error('Nothing to draw — this git graph has no commits.');
  return {
    kind: 'gitgraph',
    ...(title ? { title } : {}),
    branches: branches.length ? branches : [...new Set(commits.map((c) => c.branch))],
    commits,
  };
}

/* ------------------------------------------------------------------ drawing */

const SVGNS = 'http://www.w3.org/2000/svg';
const esc = (t: string) =>
  t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const round = (n: number) => Number(n.toFixed(2));

export interface CommitsDrawing {
  svg: string;
  css: string;
  cycle: number;
  summary: string;
  groups: number;
  items: number;
}

type Measure = (t: string, font: string, size: number, tracking?: string) => number;
interface Mark {
  id: string;
  markup: string;
  /** A commit's own x, so it can pop when the drawing head reaches it. */
  commit?: { cx: number; rawId: string };
  /** A connector spans two commits' own pop times — it grows from the fork,
   *  or into the merge, whichever end came later, DESIGN 8.2/10.4. */
  connector?: { fromId: string; toId: string };
}

/** A connector's own drawn shape: the standalone path, the same path without
 *  its leading `M` (for chaining onto a pen already there), and the point on
 *  the branch's row where it stops/starts — the point a branch's lane must be
 *  extended to meet (DESIGN 6.4/10.5). */
interface Bend {
  d: string;
  body: string;
  drop: { x: number; y: number };
  /** The vertical run's own x, and the full y-range it spans (source row to
   *  target row) — any lane whose own row sits strictly between them is
   *  crossed, not touched, by this connector (DESIGN 6.1's over/under). */
  crossX: number;
  crossYMin: number;
  crossYMax: number;
}

/** A fork/merge connector, kept around so a branch's lane can be extended to
 *  meet it and the live-phase spark can retrace its route. */
interface ConnGeom extends Bend {
  fromId: string;
  toId: string;
}

/** A side branch's live-phase spark: the parent it split from, the merge it
 *  rejoins at (if any), and the combined fork→lane→merge path it travels. */
interface BranchSpark {
  id: string;
  d: string;
  forkCommitId: string;
  mergeCommitId?: string;
  branchLastId: string;
}

/** DESIGN 6.4: a connector's own run collinear with any lane is ≤ 16 units. */
const CONNECTOR_FLAT = 12;
/** DESIGN's connector corner radius. */
const CONNECTOR_RADIUS = 12;

/**
 * A connector between a commit on main and a commit on a side branch: a short
 * flat off whichever end sits on main (corner within 12 of that commit's
 * edge), a quarter arc, the vertical, and a quarter arc onto the branch's row
 * — then it stops. The far end is never drawn by the connector at all; the
 * branch's own lane is extended to meet `drop` instead (DESIGN 6.4/10.5), so
 * main's stroke never gets a second colour painted along it and the branch's
 * stroke never has to detour through the connector's own long flat.
 *
 * `hug: 'start'` hugs `(x1,y1)` (the fork case — main is the parent);
 * `hug: 'end'` hugs `(x2,y2)` (the merge case — main is the child). The path
 * is always authored parent -> child, so a fork connector still visibly grows
 * out of its parent and a merge connector still visibly grows into the merge
 * commit (DESIGN 8.2/10.4).
 */
function bendHugging(x1: number, y1: number, x2: number, y2: number, hug: 'start' | 'end'): Bend {
  const dirX = x2 >= x1 ? 1 : -1;
  const dirY = y2 >= y1 ? 1 : -1;
  const rr = Math.min(CONNECTOR_RADIUS, Math.abs(y2 - y1) / 2);
  const reach = CONNECTOR_FLAT + rr;
  const jogX = hug === 'start' ? x1 + dirX * reach : x2 - dirX * reach;
  const arc =
    `Q${round(jogX)},${round(y1)} ${round(jogX)},${round(y1 + dirY * rr)} ` +
    `V${round(y2 - dirY * rr)} Q${round(jogX)},${round(y2)} ${round(jogX + dirX * rr)},${round(y2)}`;
  const crossing = { crossX: jogX, crossYMin: Math.min(y1, y2), crossYMax: Math.max(y1, y2) };
  if (hug === 'start') {
    const body = `H${round(jogX - dirX * rr)} ${arc}`;
    return { d: `M${round(x1)},${round(y1)} ${body}`, body, drop: { x: jogX + dirX * rr, y: y2 }, ...crossing };
  }
  const body = `${arc} H${round(x2)}`;
  return { d: `M${round(jogX - dirX * rr)},${round(y1)} ${body}`, body, drop: { x: jogX - dirX * rr, y: y1 }, ...crossing };
}

export function drawCommits(g: Commits, scene: Scene, measureWith?: string): CommitsDrawing {
  const measurer = makeMeasurer(measureWith);
  const width: Measure = (t, f, s, tr) => measurer.measure(t, f, s, tr);
  const pad = scene.canvas.margin;

  const laneOf = new Map(g.branches.map((b, i) => [b, i]));
  const mainIdx = g.branches.includes('main') ? g.branches.indexOf('main') : 0;
  const mainBranchName = g.branches[mainIdx] ?? 'main';
  const laneGap = 64;

  const byId = new Map(g.commits.map((c) => [c.id, c]));
  // A merge commit's own id is whatever mermaid generated for it — often a
  // hash — so it is never shown (DESIGN 3.2). Its label is the branch it
  // merged, read off the parent that isn't its own branch.
  const mergedBranchName = (c: CommitInfo): string => {
    const other = c.parents.map((pid) => byId.get(pid)).find((p): p is CommitInfo => p != null && p.branch !== c.branch);
    return other?.branch ?? 'merge';
  };
  const labelFor = (c: CommitInfo): string => (c.merge ? `MERGE ${mergedBranchName(c).toUpperCase()}` : c.id.toUpperCase());

  const byBranch = new Map<string, CommitInfo[]>();
  for (const c of g.commits) {
    const list = byBranch.get(c.branch);
    if (list) list.push(c);
    else byBranch.set(c.branch, [c]);
  }
  const idxInBranch = new Map<string, number>();
  for (const list of byBranch.values()) list.forEach((c, i) => idxInBranch.set(c.id, i));

  const labelW = (c: CommitInfo) => width(labelFor(c), scene.rowFont, scene.type.label, scene.type.labelTracking);
  const maxLabelW = Math.max(...g.commits.map(labelW), 40);
  // 96 apart on the 8-grid (DESIGN 2.1), stretched only as far as the widest
  // label needs so two labels can never touch. No longer stretched to fill the
  // canvas — the chart hugs its content (DESIGN 1.1 rev. 2026-08-21) rather
  // than padding columns out to a fixed width.
  const colGap = Math.max(96, maxLabelW + 32);
  const left = pad + 32;
  const colX = (seq: number) => left + seq * colGap;

  const hasTitle = Boolean(g.title);
  const titleY = pad + scene.type.title;
  // DESIGN 7.1: title (if mermaid gave one) plus a kicker summarising the
  // graph — "3 commits on main · 2 on feature · 1 merge" — always present,
  // since it is the one place a reader learns the shape of the graph before
  // tracing it lane by lane.
  const kickerY = hasTitle ? titleY + scene.type.kicker + 9 : pad + scene.type.kicker;
  const top = kickerY + scene.gapLayer;
  const laneY = (i: number) => top + i * laneGap;

  const mergeCount = g.commits.filter((c) => c.merge).length;
  const kickerParts: string[] = [];
  for (const b of g.branches) {
    const n = (byBranch.get(b) ?? []).filter((c) => !c.merge).length;
    if (!n) continue;
    kickerParts.push(b === mainBranchName ? `${n} commits on ${b}` : `${n} on ${b}`);
  }
  if (mergeCount) kickerParts.push(`${mergeCount} merge${mergeCount === 1 ? '' : 's'}`);

  const parts: string[] = [];
  const marks: Mark[] = [];

  if (hasTitle) {
    parts.push(`<text class="gc-commit-title" x="${round(pad)}" y="${round(titleY)}">${esc(g.title!)}</text>`);
  }
  parts.push(`<text class="gc-commit-kicker" x="${round(pad)}" y="${round(kickerY)}">${esc(kickerParts.join(' · '))}</text>`);

  // Main is the one accent (DESIGN 5.2) and stays plain path-blue. Every other
  // branch already carries its own legend — the name beside its lane — so it
  // earns its own hue too (DESIGN 5.3), the same categorical palette kanban's
  // columns and mindmap's branches use, rather than every side branch reading
  // as one undifferentiated grey.
  const seriesFor = (i: number) => ` gc-series-${i % scene.series.length}`;

  // Connectors first, so a branch's lane (below) can be extended to meet
  // wherever its fork/merge connector actually lands (DESIGN 6.4/10.5), and so
  // every lane knows where a connector crosses it (DESIGN 6.1's over/under).
  const forkOf = new Map<string, ConnGeom>();
  const mergeOf = new Map<string, ConnGeom>();
  const crossings: { x: number; yMin: number; yMax: number }[] = [];
  for (const c of g.commits) {
    for (const pid of c.parents) {
      const parent = byId.get(pid);
      if (!parent || parent.branch === c.branch) continue;
      const x1 = colX(parent.seq), y1 = laneY(laneOf.get(parent.branch) ?? 0);
      const x2 = colX(c.seq), y2 = laneY(laneOf.get(c.branch) ?? 0);
      const id = `k-${parent.id}-${c.id}`;
      // A connector belongs to whichever end is a side branch — the branch
      // the reader is following across the merge — not to main.
      const owner = c.branch !== mainBranchName ? laneOf.get(c.branch) : laneOf.get(parent.branch);
      const series = owner !== undefined && owner !== mainIdx ? seriesFor(owner) : '';
      // Main is always the anchor a connector hugs tightly: a fork hugs its
      // parent (main), a merge hugs its child (also main) — the branch's own
      // lane, not the connector, carries the rest of the distance either way.
      const hug: 'start' | 'end' = c.branch === mainBranchName ? 'end' : 'start';
      const bend = bendHugging(x1, y1, x2, y2, hug);
      marks.push({
        id,
        markup: `<path class="gc-commit-connector${series}" data-id="${esc(id)}" pathLength="1" d="${bend.d}"/>`,
        connector: { fromId: parent.id, toId: c.id },
      });
      const geom: ConnGeom = { ...bend, fromId: parent.id, toId: c.id };
      if (c.branch !== mainBranchName) forkOf.set(c.branch, geom);
      if (parent.branch !== mainBranchName) mergeOf.set(parent.branch, geom);
      crossings.push({ x: bend.crossX, yMin: bend.crossYMin, yMax: bend.crossYMax });
    }
  }

  // DESIGN 10.5: a lane spans only its own content. Main gets 24 clearance on
  // both ends because nothing else draws past it. A side branch is extended
  // to meet its own fork/merge connector's drop point instead — the
  // connector itself only ever draws a short hug near main (DESIGN 6.4), so
  // the branch's lane is what actually carries the eye from there to its
  // first commit, and from its last commit to the merge.
  // DESIGN 6.1: where a connector crosses a lane it doesn't belong to (not its
  // own fork/merge row, a genuine pass-through), the lane leaves a 6-unit
  // ground-colour gap right there — one path, a break in its own `d`, never a
  // second element sitting over the first.
  const GAP = 6;
  const laneSpans: { id: string; sx: number; ex: number }[] = [];
  g.branches.forEach((b, i) => {
    const list = byBranch.get(b);
    if (!list || !list.length) return;
    const main = i === mainIdx;
    const series = main ? '' : seriesFor(i);
    const first = list[0]!, last = list[list.length - 1]!;
    let sx = colX(first.seq), ex = colX(last.seq);
    if (main) {
      sx -= 24;
      ex += 24;
    } else {
      const fork = forkOf.get(b);
      const merge = mergeOf.get(b);
      if (fork) sx = Math.min(sx, fork.drop.x);
      if (merge) ex = Math.max(ex, merge.drop.x);
    }
    const y = laneY(i);
    const gaps = crossings
      .filter((cr) => cr.yMin < y - 0.5 && cr.yMax > y + 0.5 && cr.x > sx + GAP && cr.x < ex - GAP)
      .map((cr) => cr.x)
      .sort((a, b2) => a - b2);
    let d = `M${round(sx)},${round(y)}`;
    for (const gx of gaps) d += ` H${round(gx - GAP / 2)} M${round(gx + GAP / 2)},${round(y)}`;
    d += ` H${round(ex)}`;
    const id = `lane-${i}`;
    laneSpans.push({ id, sx, ex });
    parts.push(
      // pathLength="1" lets the lane draw on left to right via stroke-dashoffset
      // (DESIGN 8.2) regardless of its actual on-screen length.
      `<path class="gc-commit-lane${series} gc-stroke-dotted${main ? ' gc-commit-lane-main' : ''}" ` +
        `data-id="${esc(id)}" pathLength="1" d="${d}"/>` +
        // The name sits at the start of its own lane (DESIGN), left-anchored,
        // above the rail — never inline with it, so it never sits on top of
        // the first commit's dot. The universal "first commit of a lane goes
        // below" rule (see the pop loop) keeps this slot free for it.
        `<text class="gc-commit-branch${series}" x="${round(sx)}" y="${round(y - 14)}">${esc(b.toUpperCase())}</text>`,
    );
  });

  // DESIGN: r6 dots with a 2px ground-colour ring (r8) so a lane visibly
  // passes *under* every commit rather than through it. A merge commit is a
  // hollow ring instead of a filled dot — same halo underneath it.
  g.commits.forEach((c) => {
    const laneI = laneOf.get(c.branch) ?? 0;
    const main = laneI === mainIdx;
    const series = main ? '' : seriesFor(laneI);
    const cx = colX(c.seq), cy = laneY(laneI);
    const label = labelFor(c);
    const tw = width(label, scene.rowFont, scene.type.label, scene.type.labelTracking);
    const boxW = tw + 12, boxH = scene.type.label * 2 + 4;
    // Alternate above/below per commit within its own lane so neighbours never
    // crowd (DESIGN). A lane's first commit always goes below, which leaves
    // the space above it free for that lane's own name.
    const idx = idxInBranch.get(c.id) ?? 0;
    const above = idx % 2 === 1;
    const off = above ? -20 : 20;
    const boxX = cx - boxW / 2, boxY = cy + off - boxH / 2;
    const id = `c-${c.id}`;
    const body = c.merge
      ? `<circle class="gc-commit-halo" cx="${round(cx)}" cy="${round(cy)}" r="8"/>` +
        `<circle class="gc-commit-ring${series}${main ? ' gc-commit-ring-main' : ''}" cx="${round(cx)}" cy="${round(cy)}" r="6"/>`
      : `<circle class="gc-commit-halo" cx="${round(cx)}" cy="${round(cy)}" r="8"/>` +
        `<circle class="gc-commit-dot${series}${main ? ' gc-commit-dot-main' : ''}" cx="${round(cx)}" cy="${round(cy)}" r="6"/>`;
    marks.push({
      id,
      markup:
        `<g class="gc-commit" data-id="${esc(id)}">` +
        body +
        `<rect class="gc-plate" x="${round(boxX)}" y="${round(boxY)}" width="${round(boxW)}" height="${round(boxH)}" rx="3"/>` +
        `<text class="gc-commit-label" x="${round(cx)}" y="${round(boxY + boxH / 2 + scene.type.label * 0.32)}">${esc(label)}</text>` +
        `</g>`,
      commit: { cx, rawId: c.id },
    });
  });

  measurer.done();

  // DESIGN 8.4/10.4: after the build, one spark travels main end to end. At
  // each fork it splits — a second spark rides the branch out and back,
  // rejoining main at the merge with a ripple on the ring — then the still
  // beat, per the live phase spec.
  const mainList = byBranch.get(mainBranchName) ?? [];
  const mainFirstId = mainList[0]?.id;
  const mainLastId = mainList[mainList.length - 1]?.id;
  const mainFirstX = mainList.length ? colX(mainList[0]!.seq) : left;
  const mainLastX = mainList.length ? colX(mainList[mainList.length - 1]!.seq) : left;
  parts.push(
    `<circle class="gc-commit-travel" r="5" ` +
      `style="offset-path:path('M${round(mainFirstX)},${round(laneY(mainIdx))} H${round(mainLastX)}')"/>`,
  );

  const branchSparks: BranchSpark[] = [];
  for (const b of g.branches) {
    if (b === mainBranchName) continue;
    const fork = forkOf.get(b);
    const list = byBranch.get(b);
    if (!fork || !list || !list.length) continue;
    const laneRow = laneY(laneOf.get(b) ?? 0);
    const lastX = colX(list[list.length - 1]!.seq);
    const merge = mergeOf.get(b);
    // The spark's own path: the fork's full bend, then the lane (a plain H,
    // since both ends sit on the branch's own row), then — if this branch
    // merges — the merge bend's body picked up exactly where the lane left it.
    let d = fork.d;
    const rightEdge = merge ? merge.drop.x : lastX;
    if (rightEdge !== fork.drop.x) d += ` H${round(rightEdge)}`;
    if (merge) d += ` ${merge.body}`;
    const sparkId = `spark-${b}`;
    branchSparks.push({
      id: sparkId,
      d,
      forkCommitId: fork.fromId,
      mergeCommitId: merge?.toId,
      branchLastId: list[list.length - 1]!.id,
    });
    parts.push(`<circle class="gc-commit-spark" data-id="${esc(sparkId)}" r="5" style="offset-path:path('${d}')"/>`);
    if (merge) {
      const mc = byId.get(merge.toId);
      const mx = mc ? colX(mc.seq) : merge.drop.x;
      const my = mc ? laneY(laneOf.get(mc.branch) ?? mainIdx) : laneRow;
      parts.push(`<circle class="gc-commit-ripple" data-id="${esc(sparkId)}" cx="${round(mx)}" cy="${round(my)}" r="3"/>`);
    }
  }

  // The global left-to-right sweep every commit's pop is timed against —
  // widest lane's own clearance, not any one lane's own extent.
  const allX = g.commits.map((c) => colX(c.seq));
  const sweepLeft = Math.min(...allX) - 24;
  const sweepRight = Math.max(...allX) + 24;

  const builtWidth = sweepRight + pad;
  const builtHeight = laneY(g.branches.length - 1) + pad + 24;

  const frame = fitCanvas({ x: 0, y: 0, width: builtWidth, height: builtHeight }, scene.canvas);
  const svg =
    `<svg class="gc-chart" viewBox="0 0 ${frame.width} ${frame.height}" ` +
    `width="${frame.width}" height="${frame.height}" role="img" xmlns="${SVGNS}">` +
    `<g class="gc-frame" transform="${frameTransform(frame)}">` +
    parts.join('') + marks.map((m) => m.markup).join('') + `</g></svg>`;

  const motion = animate(
    marks, hasTitle, scene, sweepLeft, sweepRight,
    { firstId: mainFirstId, lastId: mainLastId },
    branchSparks, laneSpans,
  );
  return {
    svg,
    css: motion.css,
    cycle: motion.cycle,
    summary: `Git graph${g.title ? `: ${g.title}` : ''}. ${g.branches.length} branches, ${g.commits.length} commits.`,
    groups: g.branches.length,
    items: g.commits.length,
  };
}

/** DESIGN 10.4's press: an arrival overshoots slightly before settling. */
const PRESS_EASE = 'cubic-bezier(.22,1.2,.36,1)';

/**
 * Time at which the scene's own ease (cubic-bezier(0.61, 0, 0.39, 1)) has
 * covered `fraction` of the distance. Copied from chronicle.ts's
 * `easedTimeFor` (not exported there): the main spark is eased, so a fork at
 * 50% of main's length is reached well after 50% of the travel time — timing
 * the split linearly would fire it before the spark actually got there.
 * Solved by bisection on the Bézier's y, then read back as x (the time axis).
 */
function easedTimeFor(fraction: number): number {
  const v = Math.min(1, Math.max(0, fraction));
  const x1 = 0.61, y1 = 0, x2 = 0.39, y2 = 1;
  const bx = (t: number) => 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t ** 2 * x2 + t ** 3;
  const by = (t: number) => 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t ** 2 * y2 + t ** 3;
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (by(mid) < v) lo = mid; else hi = mid; }
  return bx((lo + hi) / 2);
}

function animate(
  marks: Mark[], hasTitle: boolean, scene: Scene, sweepLeft: number, sweepRight: number,
  mainSpan: { firstId?: string; lastId?: string },
  branchSparks: BranchSpark[],
  laneSpans: { id: string; sx: number; ex: number }[],
): { css: string; cycle: number } {
  const m = scene.motion;
  const tracks = new Map<string, Track>();
  const track = (sel: string) => {
    const found = tracks.get(sel);
    if (found) return found;
    const made = new Track();
    tracks.set(sel, made);
    return made;
  };
  const lead = 0.25;
  const commits = marks.filter((mk) => mk.commit);
  // The lanes' own left-to-right draw is the "drawing head": a commit pops in
  // exactly when that stroke would have reached its x, so the two read as one
  // motion rather than a lane draw and an unrelated commit cadence.
  const laneBuild = Math.min(1.8, 0.35 + commits.length * 0.14);
  const laneStart = lead + 0.08;
  const laneEnd = laneStart + laneBuild;
  const POP = Math.min(m.build, 0.4);
  const fracOf = (cx: number) => (sweepRight > sweepLeft ? Math.min(1, Math.max(0, (cx - sweepLeft) / (sweepRight - sweepLeft))) : 0);
  // The head's own eased x position: at real time T within [laneStart,laneEnd],
  // the lane's stroke-dashoffset (eased by the same m.ease CSS timing function
  // between these two keyframes) has revealed fracOf(x) of the sweep exactly
  // when T = laneStart + easedTimeFor(fracOf(x)) * laneBuild — the inverse of
  // the forward easing the browser applies. A commit pops the moment the head
  // reaches it, so it must be scheduled by this eased mapping, not a linear one.
  const commitStart = new Map<string, number>();
  const cxOf = new Map<string, number>();
  for (const mk of commits) {
    commitStart.set(mk.commit!.rawId, laneStart + easedTimeFor(fracOf(mk.commit!.cx)) * laneBuild);
    cxOf.set(mk.commit!.rawId, mk.commit!.cx);
  }

  const last = laneEnd + POP;

  // DESIGN 8.4/10.4: one spark travels main from first commit to last, timed
  // by the same ease as everything else — a fork it passes is reached at the
  // eased time for that fraction of the distance, not the linear one.
  const mainFirstX = mainSpan.firstId !== undefined ? (cxOf.get(mainSpan.firstId) ?? sweepLeft) : sweepLeft;
  const mainLastX = mainSpan.lastId !== undefined ? (cxOf.get(mainSpan.lastId) ?? sweepRight) : sweepRight;
  const mainTravelStart = last + 0.15;
  const mainDist = Math.max(1, mainLastX - mainFirstX);
  const TRAVEL_MAIN = Math.min(1.6, 0.5 + mainDist / 400);
  const mainTravelEnd = mainTravelStart + TRAVEL_MAIN;
  const timeAtX = (x: number) => mainTravelStart + easedTimeFor(Math.min(1, Math.max(0, (x - mainFirstX) / mainDist))) * TRAVEL_MAIN;

  // Each side branch: when the main spark passes its fork, a second spark
  // splits off, rides the branch, and (if the branch merges back) rejoins
  // main at the exact moment the main spark itself would have reached the
  // merge commit — the "rejoin" is a shared arrival time, not a shared route.
  const sparkTiming = branchSparks.map((sp) => {
    const forkX = cxOf.get(sp.forkCommitId) ?? mainFirstX;
    const forkTime = timeAtX(forkX);
    let endTime: number;
    if (sp.mergeCommitId) {
      const mergeX = cxOf.get(sp.mergeCommitId) ?? mainLastX;
      endTime = Math.max(forkTime + 0.2, timeAtX(mergeX));
    } else {
      const lastX = cxOf.get(sp.branchLastId) ?? forkX;
      endTime = forkTime + Math.min(1.2, 0.4 + Math.abs(lastX - forkX) / 400);
    }
    return { sp, forkTime, endTime };
  });
  const RIPPLE = 0.5;
  const liveEnd = Math.max(
    mainTravelEnd,
    ...sparkTiming.map(({ endTime, sp }) => endTime + (sp.mergeCommitId ? RIPPLE + 0.1 : 0.25)),
  );
  // DESIGN 10.4: a still beat of at least 2s, because the still frame is what
  // most people see. `m.hold` (2.4s) clears that floor.
  const cycle = liveEnd + m.hold;

  const fade = (sel: string, from: number, over = m.build * 0.8) => {
    const t = track(sel);
    t.at(0, { opacity: '0' });
    t.at(from, { opacity: '0' });
    t.at(from + over, { opacity: '1' });
    t.at(cycle, { opacity: '1' });
  };

  // A lane draws on left to right (DESIGN 8.2) instead of fading in whole.
  // `settled` is the opacity it rests at once drawn — connectors sit at .7 at
  // rest (see the static rule below), and the reveal must land there too, not
  // at a flat 1 that then never matches the finished chart.
  const grow = (sel: string, from: number, to: number, settled = 1) => {
    const t = track(sel);
    const over = Math.max(0.05, to - from);
    t.at(0, { 'stroke-dashoffset': '1', opacity: '0' });
    t.at(from, { 'stroke-dashoffset': '1', opacity: '0' });
    t.at(from + over * 0.1, { opacity: String(settled) });
    t.at(to, { 'stroke-dashoffset': '0' });
    t.at(cycle, { 'stroke-dashoffset': '0', opacity: String(settled) });
  };

  // A commit pops rather than fades: r grows 0 -> target with the arrival's
  // overshoot easing, DESIGN 10.4. The halo pops to 8, the dot/ring to 6.
  const pop = (sel: string, from: number, r = 6) => {
    const t = track(sel);
    t.at(0, { r: '0', opacity: '0' });
    t.at(from, { r: '0', opacity: '0', 'animation-timing-function': PRESS_EASE });
    t.at(from + POP, { r: String(r), opacity: '1', 'animation-timing-function': m.ease });
    t.at(cycle, { r: String(r), opacity: '1' });
  };

  // A lane's own drawn end must never lead the head. Every lane — main
  // included — is sampled at the same shared set of real times, and at each
  // one its dashoffset is set from the *same* headX(T) value (the forward
  // evaluation of the scene's ease, the mirror of `easedTimeFor`'s inverse).
  // Two lanes sampling at different x-driven times (the earlier approach) can
  // drift a few units apart wherever the browser's own reapplied easing
  // interpolates between their differently-placed keyframes; sharing the
  // breakpoints keeps every lane reading off the identical head position at
  // the instants that matter, so a branch can never be caught ahead of it.
  const cssEaseForward = (inputFraction: number): number => {
    const s = Math.min(1, Math.max(0, inputFraction));
    const x1 = 0.61, y1 = 0, x2 = 0.39, y2 = 1;
    const bx = (t: number) => 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t ** 2 * x2 + t ** 3;
    const by = (t: number) => 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t ** 2 * y2 + t ** 3;
    let lo = 0, hi = 1;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (bx(mid) < s) lo = mid; else hi = mid; }
    return by((lo + hi) / 2);
  };
  const TIME_SAMPLES = 32;
  const timeSamples: number[] = [];
  for (let i = 0; i <= TIME_SAMPLES; i++) timeSamples.push(laneStart + (laneBuild * i) / TIME_SAMPLES);
  const headXAt = new Map<number, number>(
    timeSamples.map((T) => [T, sweepLeft + cssEaseForward((T - laneStart) / laneBuild) * (sweepRight - sweepLeft)]),
  );
  const growLane = (sel: string, sx: number, ex: number) => {
    const t = track(sel);
    t.at(0, { 'stroke-dashoffset': '1', opacity: '0' });
    for (const T of timeSamples) {
      const headX = headXAt.get(T)!;
      const local = ex > sx ? Math.min(1, Math.max(0, (headX - sx) / (ex - sx))) : 1;
      // Opacity is pinned at 0 for every sample before the head arrives —
      // never left to interpolate all the way from t=0 — so a branch lane
      // that starts late still pops in over one sample's width, not a slow
      // fade spanning the whole build.
      t.at(T, { 'stroke-dashoffset': String(1 - local), opacity: local > 0.001 ? '1' : '0' });
    }
    t.at(cycle, { 'stroke-dashoffset': '0', opacity: '1' });
  };

  if (hasTitle) fade('.gc-commit-title', lead, m.build * 0.7);
  fade('.gc-commit-kicker', lead + 0.02, m.build * 0.7);
  fade('.gc-commit-branch', lead + 0.08);
  // Every lane gets its own selector/track (data-id="lane-N") — sharing one
  // selector across lanes of different lengths is exactly what let a short
  // branch lane finish "drawn" at the same wall-clock moment as main's much
  // longer one, regardless of where the head actually was.
  for (const lane of laneSpans) growLane(`.gc-commit-lane[data-id="${lane.id}"]`, lane.sx, lane.ex);

  for (const mk of marks) {
    if (mk.commit) {
      const start = commitStart.get(mk.commit.rawId)!;
      pop(`.gc-commit[data-id="${mk.id}"] .gc-commit-dot, .gc-commit[data-id="${mk.id}"] .gc-commit-ring`, start, 6);
      pop(`.gc-commit[data-id="${mk.id}"] .gc-commit-halo`, start, 8);
      // The label reads once its commit has actually arrived, not alongside it.
      fade(`.gc-commit[data-id="${mk.id}"] .gc-commit-label, .gc-commit[data-id="${mk.id}"] .gc-plate`, start + POP * 0.6);
    } else if (mk.connector) {
      // Grows from whichever end is the parent — always the earlier commit,
      // so a branch connector already starts at its fork and a merge
      // connector already ends at the merge commit (see the note where these
      // are built).
      const from = commitStart.get(mk.connector.fromId) ?? laneStart;
      const to = Math.max(from + 0.1, commitStart.get(mk.connector.toId) ?? laneEnd);
      grow(`.gc-commit-connector[data-id="${mk.id}"]`, from, to, 0.7);
    }
  }

  // The one travelling accent along main: hidden through the whole build,
  // then one pass end to end.
  const travel = track('.gc-commit-travel');
  travel.at(0, { opacity: '0', 'offset-distance': '0%' });
  travel.at(mainTravelStart, { opacity: '0', 'offset-distance': '0%' });
  travel.at(mainTravelStart + 0.02, { opacity: '1' });
  travel.at(mainTravelEnd, { 'offset-distance': '100%' });
  travel.at(Math.min(cycle, mainTravelEnd + 0.25), { opacity: '0' });
  travel.at(cycle, { opacity: '0', 'offset-distance': '0%' });

  // Each branch's own spark: splits off main at the fork, rides the fork
  // connector then its own lane then (if it merges) the merge connector, and
  // fades either at its own end or right as the merge ripple takes over.
  for (const { sp, forkTime, endTime } of sparkTiming) {
    const spark = track(`.gc-commit-spark[data-id="${sp.id}"]`);
    spark.at(0, { opacity: '0', 'offset-distance': '0%' });
    spark.at(forkTime, { opacity: '0', 'offset-distance': '0%' });
    spark.at(forkTime + 0.02, { opacity: '1' });
    spark.at(endTime, { 'offset-distance': '100%', opacity: sp.mergeCommitId ? '0' : '1' });
    if (!sp.mergeCommitId) spark.at(Math.min(cycle, endTime + 0.25), { opacity: '0' });
    spark.at(cycle, { opacity: '0', 'offset-distance': '0%' });

    if (sp.mergeCommitId) {
      // DESIGN: they rejoin at the merge with a small ripple on the ring.
      const ripple = track(`.gc-commit-ripple[data-id="${sp.id}"]`);
      ripple.at(0, { r: '3', opacity: '0' });
      ripple.at(endTime, { r: '3', opacity: '0' });
      ripple.at(endTime + RIPPLE * 0.12, { opacity: '.9' });
      ripple.at(endTime + RIPPLE, { r: '14', opacity: '0' });
      ripple.at(cycle, { r: '3', opacity: '0' });
    }
  }

  const rules: string[] = [];
  const frames: string[] = [];
  let i = 0;
  for (const [sel, value] of tracks) {
    if (value.empty) continue;
    const name = `gc-g${i++}`;
    rules.push(`${sel}{animation:${name} ${cycle.toFixed(2)}s ${m.ease} infinite}`);
    frames.push(`@keyframes ${name}{${value.frames(cycle)}}`);
  }
  return {
    cycle,
    css: `\n@media (prefers-reduced-motion: no-preference) {\n${rules.join('\n')}\n${frames.join('\n')}\n}\n`,
  };
}

export function commitsCss(scene: Scene): string {
  // Each side branch gets a hue from the same categorical palette kanban and
  // mindmap use; --gc-mark only exists on a lane that carries a gc-series-N
  // class, so main (which never gets one) keeps falling through to its own
  // rules below undisturbed.
  const series = scene.series
    .map((c, i) => `.gc-series-${i} { --gc-mark: var(--gc-series-${i + 1}, ${c}); }`)
    .join('\n');
  return `
${series}
.gc-commit-title { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.titleFont};
  font-weight: ${scene.type.titleWeight}; font-size: ${scene.type.title}px;
  letter-spacing: ${scene.type.titleTracking}; text-anchor: start; }
.gc-commit-kicker { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.rowFont};
  font-size: ${scene.type.kicker}px; letter-spacing: ${scene.type.kickerTracking};
  text-transform: uppercase; text-anchor: start; }
.gc-commit-lane { fill: none; stroke: var(--gc-mark, var(--gc-edge, ${scene.edge})); stroke-width: ${scene.edgeStroke}px;
  stroke-linecap: round; }
/* Two classes so this beats the plain .gc-stroke-dotted rule's own dasharray
   while the lane is drawing on (DESIGN 8.2) — a brief loss of the dotted
   pattern while it draws beats reading as unfolded. */
.gc-commit-lane.gc-stroke-dotted { stroke-dasharray: 1; }
.gc-commit-lane-main { stroke: var(--gc-path, ${scene.path}); }
.gc-commit-branch { fill: var(--gc-mark, var(--gc-quiet, ${scene.quiet})); font-family: ${scene.rowFont};
  font-size: ${scene.type.label}px; letter-spacing: ${scene.type.labelTracking}; text-transform: uppercase; }
.gc-commit-connector { fill: none; stroke: var(--gc-mark, var(--gc-edge, ${scene.edge})); stroke-width: ${scene.edgeStroke}px;
  stroke-linecap: round; stroke-dasharray: 1; opacity: .7; }
/* The 2px ground-colour ring every commit sits in, so a lane visibly passes
   under it rather than through it (DESIGN). */
.gc-commit-halo { fill: var(--gc-bg, ${scene.bg}); }
.gc-commit-dot { fill: var(--gc-mark, var(--gc-quiet, ${scene.quiet})); }
.gc-commit-dot-main { fill: var(--gc-path, ${scene.path}); }
/* A merge commit: a hollow ring, never a filled dot, so it reads as a
   different kind of commit at a glance. */
.gc-commit-ring { fill: var(--gc-bg, ${scene.bg}); stroke: var(--gc-mark, var(--gc-quiet, ${scene.quiet})); stroke-width: 2px; }
.gc-commit-ring-main { stroke: var(--gc-path, ${scene.path}); }
/* The one post-build accent pass along main, DESIGN 8.4 — hidden at rest,
   same pattern as a flowchart's .gc-spark. */
.gc-commit-travel { fill: var(--gc-accent, ${scene.accent}); opacity: 0; }
/* A side branch's own spark, split off main at its fork (DESIGN 10.4). */
.gc-commit-spark { fill: var(--gc-accent, ${scene.accent}); opacity: 0; }
/* The ripple a rejoining spark leaves on the merge ring. */
.gc-commit-ripple { fill: none; stroke: var(--gc-accent, ${scene.accent}); stroke-width: 1.2px; opacity: 0; }
/* Upright, never rotated: DESIGN 3.4. A knockout plate reads over the lane's
   own dotted line without either fighting the other for contrast. */
.gc-commit-label { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.rowFont};
  font-size: ${scene.type.label}px; letter-spacing: ${scene.type.labelTracking};
  text-anchor: middle; text-transform: uppercase; }
`;
}
