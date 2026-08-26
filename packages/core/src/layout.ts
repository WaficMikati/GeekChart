import type { Graph, GraphCluster, GraphNode } from './graph.ts';
import { clusterHeadroom, type Scene } from './scene.ts';
import { tipReach } from './tips.ts';
import { getElk, type ElkNode } from './layout/elk.ts';

/**
 * Size the nodes, then let ELK place them.
 *
 * The order matters and is the whole point of owning this step. Sizes are
 * decided *before* layout, so ELK spaces boxes that are already their final
 * dimensions — nothing collides afterwards and nothing needs re-fitting. The
 * previous pipeline sized boxes after the fact and spent most of its complexity
 * repairing the damage.
 */

/**
 * Measure a string without laying anything out permanently.
 *
 * `measureWith` is what the font role `inherit` resolves to here. The measuring
 * element inherits from this host, so naming the page's stack once makes every
 * inherited measurement match what the chart will meet when it gets there.
 */
export function makeMeasurer(measureWith?: string): { measure: (text: string, font: string, size: number, tracking?: string) => number; done: () => void } {
  const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:10px;height:10px;overflow:visible;';
  if (measureWith) host.style.fontFamily = measureWith;
  const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  host.appendChild(text);
  document.body.appendChild(host);

  return {
    measure(value, font, size, tracking = 'normal') {
      text.style.fontFamily = font;
      text.style.fontSize = `${size}px`;
      text.style.letterSpacing = tracking;
      text.textContent = value || ' ';
      return text.getBBox().width;
    },
    done() {
      host.remove();
    },
  };
}

/**
 * Split a title into two lines at the word boundary that keeps both lines
 * under `maxWidth`, favouring the split whose wider line is narrowest.
 * A single unsplittable word, or a title with no space to break at, returns
 * `null` — the caller keeps the one-line label rather than force a break
 * that would leave a word overhanging.
 */
function wrapTitle(
  title: string,
  measure: (s: string) => number,
  maxWidth: number,
): [string, string] | null {
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  let best: { lines: [string, string]; worst: number } | null = null;
  for (let i = 1; i < words.length; i++) {
    const l1 = words.slice(0, i).join(' ');
    const l2 = words.slice(i).join(' ');
    const w1 = measure(l1);
    const w2 = measure(l2);
    const worst = Math.max(w1, w2);
    if (w1 <= maxWidth && w2 <= maxWidth && (!best || worst < best.worst)) {
      best = { lines: [l1, l2], worst };
    }
  }
  return best?.lines ?? null;
}

/** What a node's own content demands, before any shared sizing is applied. */
interface Metrics {
  node: GraphNode;
  /** The label block, excluding padding. */
  label: { width: number; height: number };
  /** Compartment rows: the widest line, how many there are, and how many groups. */
  rows: { width: number; count: number; groups: number };
}

/**
 * Fit a shape around its own label.
 *
 * A blanket multiplier off the widest label in the diagram makes a diamond
 * enormous — it inherits the size of a box it has nothing to do with. Each
 * shape is solved against the text it actually contains instead.
 */
function fitShape(
  m: Metrics,
  base: { width: number; height: number },
  scene: Scene,
  flow: 'horizontal' | 'vertical',
): { width: number; height: number } {
  const { label, rows } = m;
  const pad = scene.padShape;
  switch (m.node.shape) {
    case 'diamond': {
      // The rhombus edge is `bx + ay = ab`, so the label's corner (w/2, h/2) sits
      // at perpendicular distance (ab - bw/2 - ah/2) / hypot(a, b). Setting that
      // to the pad and fixing the aspect a = r*b leaves one equation in b.
      const r = 1.85; // matches the reference proportion
      const b =
        (pad * Math.hypot(r, 1) + label.width / 2 + (r * label.height) / 2) / r;
      return { width: 2 * r * b, height: 2 * b };
    }
    case 'circle': {
      // The corner of the label box is the furthest point from the centre.
      const d = 2 * (Math.hypot(label.width, label.height) / 2 + pad);
      return { width: d, height: d };
    }
    case 'cylinder': {
      // The label has to clear the ellipse capping each end, not just the sides.
      const ry = Math.min(18, base.height * 0.2);
      return { width: base.width, height: base.height + ry * 2 };
    }
    case 'hexagon':
    case 'parallelogram':
    case 'trapezoid':
      // The slanted end steals horizontal room at the text's own height; the
      // clearance needed grows with how far the label sits from the centre line.
      return { width: base.width + pad * 2.2, height: base.height };

    // A compartmented box is sized by its own contents, never by the shared box.
    // Class boxes vary wildly in height and forcing them to a common size would
    // either clip the longest or leave the shortest mostly empty.
    case 'panel': {
      const header = scene.titleSize * 1.16 + scene.padY * 2;
      const body = rows.count
        ? rows.count * scene.rowStep + rows.groups * scene.padY
        : 0;
      // 200 is DESIGN 2.2's "wide" box, and a record is what it is for: a class
      // or entity table holds a column of declarations, so it is the one node
      // that is always the wide size rather than the 160 default.
      return {
        width: Math.max(200, Math.max(label.width, rows.width) + scene.padX * 2),
        height: header + body,
      };
    }
    // The state machine's endpoints and its fork bars are marks, not boxes: they
    // carry no label, so they get a fixed size rather than one derived from text.
    case 'dot':
      return { width: 22, height: 22 };
    case 'ring':
      return { width: 30, height: 30 };
    case 'bar':
      return flow === 'horizontal' ? { width: 8, height: 120 } : { width: 120, height: 8 };
    case 'note':
      // A note is an aside; sizing it to the shared box would give it the same
      // visual weight as the states it is annotating.
      return {
        width: label.width + scene.padX * 1.4,
        height: label.height + scene.padY * 1.8,
      };
    default:
      return base;
  }
}

export interface LayoutResult {
  width: number;
  height: number;
}

/**
 * Give every node its size, then run the layout.
 *
 * One width and one height across the diagram wherever a label allows it —
 * ragged boxes are the single loudest sign that a picture was generated. Shapes
 * that genuinely need more room (a diamond has to hold its label inside a
 * rhombus) get a proportional allowance rather than breaking the rhythm.
 */
export async function layout(graph: Graph, scene: Scene, measureWith?: string): Promise<LayoutResult> {
  const measurer = makeMeasurer(measureWith);
  const flow = graph.direction === 'LR' || graph.direction === 'RL' ? 'horizontal' : 'vertical';

  // Shapes that solve their own geometry from the label (a diamond, a note)
  // are never wrapped here — DESIGN 2.2's fixed-box list is about the shared
  // rect/process box, not the shapes that already size themselves to fit.
  const ownShape: string[] = ['diamond', 'circle', 'panel', 'dot', 'ring', 'bar', 'note'];

  const intrinsic: Metrics[] = graph.nodes.map((node) => {
    const title = measurer.measure(node.title, scene.titleFont, scene.titleSize);
    const caption = node.caption
      ? measurer.measure(node.caption, scene.captionFont, scene.captionSize, scene.captionTracking)
      : 0;
    // The caption is a smaller face, not a second title line. Counting it as one
    // made every box half again too tall.
    const text = scene.titleSize * 1.16 + (node.caption ? scene.captionSize * 1.3 + 4 : 0);
    const flat = (node.rows ?? []).flat();
    const rowWidth = flat.length
      ? Math.max(...flat.map((r) => measurer.measure(r.text, scene.rowFont, scene.rowSize)))
      : 0;
    return {
      node,
      label: { width: Math.max(title, caption), height: text },
      rows: { width: rowWidth, count: flat.length, groups: (node.rows ?? []).length },
    };
  });
  // Edge labels are measured here too, because this is the only place with a
  // live measurer. Drawing previously estimated the plate from the character
  // count, which is wrong by enough to clip a label or to overhang its line.
  for (const edge of graph.edges) {
    if (!edge.label) continue;
    edge.labelWidth = measurer.measure(
      scene.edgeLabelUpper ? edge.label.toUpperCase() : edge.label,
      scene.edgeLabelFont,
      scene.edgeLabelSize,
      scene.edgeLabelTracking,
    );
  }
  // A panel's title and kicker are content it has to hug too (DESIGN 2.6) —
  // measured here, alongside everything else, while the measurer is live.
  for (const cluster of graph.clusters) {
    const t = measurer.measure(cluster.title, scene.titleFont, scene.type.title, scene.type.titleTracking);
    const k = cluster.kicker
      ? measurer.measure(
          cluster.kicker.toUpperCase(),
          scene.clusterFont,
          scene.type.kicker,
          scene.type.kickerTracking,
        )
      : 0;
    cluster.headerWidth = Math.max(t, k);
  }

  // The common box is sized by the widest ordinary label, so plain nodes share
  // one size. Shapes that need their own geometry are solved separately, and the
  // marks and panels are kept out of the pool entirely — a class box's width
  // would otherwise set the size of every state in the diagram.
  const plain = intrinsic.filter((i) => !ownShape.includes(i.node.shape));
  const pool = plain.length ? plain : intrinsic;
  // 160 is the narrowest box on DESIGN 2.2's list, so it is the floor as well
  // as the common case: a box fitted to a 12-unit name is 90 units wide, and a
  // row of those is the "thin strip on an empty stage" of rule 9.
  // DESIGN 2.2's list, not a fitted width. A box is 120, 160 or 200 and the
  // label lives with it: the smallest that holds the widest plain label wins.
  // Wrapping (below) never feeds back into this — one long caption-less title
  // is not allowed to drag every other node's shared width up with it.
  const wanted = Math.max(...pool.map((i) => i.label.width + scene.padX * 2));
  const baseWidth = [120, 160, 200].find((w) => w >= wanted) ?? 200;

  // DESIGN 2.2: "a label that will not fit is the label's problem, not the
  // box's." Once the chart's shared width is settled, any caption-less title
  // that still would not fit *that* box — the box every one of its siblings
  // already has — is wrapped to a second line, in the title's own style,
  // rather than left to overhang or drag the box wider than the list allows.
  for (const item of pool) {
    const { node } = item;
    if (node.caption || ownShape.includes(node.shape)) continue;
    if (item.label.width + scene.padX * 2 <= baseWidth) continue;
    const wrapped = wrapTitle(
      node.title,
      (s) => measurer.measure(s, scene.titleFont, scene.titleSize),
      baseWidth - scene.padX * 2,
    );
    if (!wrapped) continue;
    node.titleLines = wrapped;
    item.label.width = Math.max(...wrapped.map((l) => measurer.measure(l, scene.titleFont, scene.titleSize)));
  }
  measurer.done();

  const grid = 8;
  const roundUp = (v: number) => Math.ceil(v / grid) * grid;

  // Two box heights only, and which one a chart uses is decided by the chart,
  // not by the node: 56 when anything in it carries a caption, 48 when nothing
  // does. DESIGN 2.2 and 3.2 — a captionless name centred in a 56-high box is
  // the thing 3.2 forbids, and one row of 48s beside a row of 56s breaks 2.3.
  // A wrapped title's second line gets the same 56-high box a caption would.
  const twoTier = graph.nodes.some((n) => Boolean(n.caption) || Boolean(n.titleLines));
  const base = { width: baseWidth, height: twoTier ? 56 : 48 };

  for (const item of intrinsic) {
    const fitted = fitShape(item, base, scene, flow);
    item.node.width = roundUp(fitted.width);
    item.node.height = roundUp(fitted.height);
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const claimed = new Set(graph.clusters.flatMap((c) => c.nodes));
  const clusterIds = new Set(graph.clusters.map((c) => c.id));

  const asElkNode = (node: GraphNode) => ({
    id: node.id,
    width: node.width!,
    height: node.height!,
  });

  // A dead-end branch off the primary path — a single failure state hanging
  // off a happy-path chain, the shape DESIGN 1.2 calls out — reads as "off the
  // row" only if it never enters the layered/wrapped computation that lines
  // the row up in the first place. Left in, ELK's own layer assignment can
  // land it between two primary-path rows once a long LR chain has to wrap,
  // which is what regex-engine's `NO` state did: sharing its parent's column
  // but a layer of its own, it read as sitting *in* the chain rather than
  // beside it. So it is pulled out before layout and pinned under its parent
  // afterward instead — the same node, drawn in a place ELK never chose.
  //
  // Kept narrow on purpose: only a node with exactly one inbound edge from a
  // primary-path node, and at most one outbound edge, qualifies — and neither
  // edge may be a retry loop (DESIGN 6.6's dashed return). A "no" branch that
  // comes back to a decision (Prep course → Meets the prerequisites?) is a
  // cycle, not a stub, and pulling it out would strand the loop; a true
  // dead end never has a backward edge touching it at all.
  const primaryIds = new Set(graph.primaryPath);
  const inCount = new Map<string, number>();
  const outCount = new Map<string, number>();
  const cyclic = new Set<string>();
  for (const e of graph.edges) {
    if (e.from === e.to) continue;
    inCount.set(e.to, (inCount.get(e.to) ?? 0) + 1);
    outCount.set(e.from, (outCount.get(e.from) ?? 0) + 1);
    if (e.backward) { cyclic.add(e.from); cyclic.add(e.to); }
  }
  const soleParent = new Map<string, string>();
  for (const e of graph.edges) {
    if (e.from === e.to) continue;
    if (inCount.get(e.to) === 1) soleParent.set(e.to, e.from);
  }
  const foldLikely = flow === 'horizontal' && longestPath(graph) > 6;
  const satelliteIds = new Set(
    foldLikely
      ? graph.nodes
          .filter((n) => {
            if (primaryIds.has(n.id) || claimed.has(n.id) || cyclic.has(n.id)) return false;
            const parent = soleParent.get(n.id);
            if (!parent || !primaryIds.has(parent)) return false;
            return (outCount.get(n.id) ?? 0) <= 1;
          })
          .map((n) => n.id)
      : [],
  );

  // clusterHeadroom is where the *rule* sits (shared with draw.ts, which
  // places it half a clusterPad above this) — but the rule sits mid-way
  // through that trailing pad, so content starting right at the rule's own
  // headroom value only gets half the gap below the rule that the bottom of
  // the panel gets above the last row. The extra half-pad here is what makes
  // the two match (DESIGN 2.6: padding on *all* sides).
  const headroom = clusterHeadroom(scene) + scene.clusterPad * 0.5;

  /**
   * Members of a group that are not connected to each other are *packed*, not
   * routed.
   *
   * A layered graph engine given six unconnected nodes has nothing to layer by,
   * so it strings them out in a single row the width of the page. But being in a
   * group with no edges between them is itself the statement — these things
   * belong together and no order is implied — and a grid says that where a row
   * does not. The grid is computed here rather than delegated, so the columns
   * are even and the result is the same every run.
   */
  const packed = new Map<string, { width: number; height: number }>();
  for (const cluster of graph.clusters) {
    const members = cluster.nodes.map((id) => byId.get(id)).filter(Boolean) as GraphNode[];
    const inner = graph.edges.filter(
      (e) => cluster.nodes.includes(e.from) && cluster.nodes.includes(e.to),
    );
    if (members.length < 3 || inner.length > 0) continue;

    // Choose the column count that leaves the fewest empty cells, and among
    // those the widest. A ragged last row is the thing that makes a packed group
    // look accidental — three cards in a 2×2 grid leaves an obvious hole where
    // three across leaves none. Capped at four, past which the cards get narrow
    // and the panel outgrows whatever it sits beside.
    // Score = empty cells + rows. Minimising empties alone is a trap: with five
    // members the only arrangement with no hole is a single column, and a
    // five-high stack is far worse than three across with one gap. Counting rows
    // too keeps the block compact, and the two together land on the arrangement
    // a person would have chosen.
    const columns = [1, 2, 3, 4]
      .filter((c) => c <= members.length)
      .map((c) => {
        const rows = Math.ceil(members.length / c);
        return { c, score: c * rows - members.length + rows };
      })
      .sort((a, b) => a.score - b.score || b.c - a.c)[0]!.c;
    const cellW = Math.max(...members.map((m) => m.width!));
    const cellH = Math.max(...members.map((m) => m.height!));
    const gap = scene.gapNode * 0.42;
    members.forEach((node, i) => {
      node.width = cellW;
      node.height = cellH;
      node.gridX = (i % columns) * (cellW + gap);
      node.gridY = Math.floor(i / columns) * (cellH + gap);
    });
    const rows = Math.ceil(members.length / columns);
    // DESIGN 2.6: the panel's own title/kicker count as content too, so a
    // packed grid narrower than its header still hugs the header, not just
    // the cards.
    const gridWidth = columns * cellW + (columns - 1) * gap;
    packed.set(cluster.id, {
      width: Math.max(gridWidth, cluster.headerWidth ?? 0) + scene.clusterPad * 2,
      height: rows * cellH + (rows - 1) * gap + headroom + scene.clusterPad,
    });
  }

  const children = [
    ...graph.clusters.map((cluster) => {
      const grid = packed.get(cluster.id);
      // A packed group is handed to ELK as a plain box of the size we worked
      // out; its children are placed by us afterwards.
      if (grid) return { id: `cluster:${cluster.id}`, width: grid.width, height: grid.height };
      return {
        id: `cluster:${cluster.id}`,
        layoutOptions: {
          'elk.padding': `[top=${headroom},left=${scene.clusterPad},bottom=${scene.clusterPad},right=${scene.clusterPad}]`,
          // The root's node spacing does not cascade to a nested graph, so a
          // panel with an edge inside it (DESIGN 2.6's "children obey 2.3")
          // falls back to ELK's own default — under the 16-unit floor once an
          // arrowhead's reach is subtracted from it. Set explicitly, on the
          // 24/32 gutter DESIGN 2.3 allows.
          'elk.spacing.nodeNode': '32',
          'elk.layered.spacing.nodeNodeBetweenLayers': '32',
        },
        children: cluster.nodes.map((id) => byId.get(id)).filter(Boolean).map((n) => asElkNode(n!)),
      };
    }),
    ...graph.nodes.filter((n) => !claimed.has(n.id) && !satelliteIds.has(n.id)).map(asElkNode),
  ];
  // An edge may point at a group rather than at a node in it. ELK knows the
  // group by its prefixed id, so the endpoint has to be rewritten or the edge
  // refers to nothing.
  const endpoint = (id: string) => (clusterIds.has(id) ? `cluster:${id}` : id);

  const elkDirection = { TB: 'DOWN', BT: 'UP', LR: 'RIGHT', RL: 'LEFT' }[graph.direction];

  // A crow's foot with a minimum-cardinality mark behind it reaches nearly 30px
  // back from the entity, at both ends. Left out of the spacing, two of them plus
  // a relationship label have to share a gap sized for a bare arrowhead, and the
  // marks end up sitting on the text.
  const tipLen = scene.edgeStroke * scene.tipLength;
  const reach = graph.edges.reduce(
    (most, e) => Math.max(most, tipReach(e.tipEnd ?? 'arrow', tipLen) + tipReach(e.tipStart ?? 'none', tipLen)),
    0,
  );

  // A label lies across the gap between layers, so which of its dimensions eats
  // into that gap depends on which way the diagram runs. Left to right it is the
  // label's width, and an ER relationship name is wide enough to cover the whole
  // line — the entities ended up joined by nothing but a pair of floating marks.
  // Top to bottom it is the label's height, which the base gap already clears.
  const labelRoom =
    flow === 'horizontal'
      ? graph.edges.reduce((most, e) => Math.max(most, e.label ? (e.labelWidth ?? 0) + 30 : 0), 0)
      : 0;

  const runLayout = async (extra: Record<string, string>) =>
    (await getElk()).layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': elkDirection,
        // Straightest possible spines; this is what keeps a linear run truly linear.
        'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
        'elk.spacing.nodeNode': String(scene.gapNode),
        'elk.layered.spacing.nodeNodeBetweenLayers': String(Math.round(scene.gapLayer + reach + labelRoom)),
        'elk.spacing.edgeNode': String(scene.gapNode * 0.5),
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        // We draw our own curves between ports, so ELK's routes are never read.
        'elk.edgeRouting': 'POLYLINE',
        ...extra,
      },
      children,
      // Retry edges are handed to ELK reversed. Left as-is they make the layering
      // pass treat the loop's target as a prerequisite, which drags the node it
      // returns to into the first layer — the entry node ends up second.
      edges: graph.edges
        .filter((edge) => !satelliteIds.has(edge.from) && !satelliteIds.has(edge.to))
        .map((edge) => ({
          id: edge.id,
          sources: [endpoint(edge.backward ? edge.to : edge.from)],
          targets: [endpoint(edge.backward ? edge.from : edge.to)],
        })),
    } as ElkNode) as Promise<ElkNode>;

  const result = await fold(runLayout, graph, scene, flow, { claimed, satelliteIds, soleParent });

  // ELK reports child coordinates relative to their parent; flatten to the root.
  const place = (list: ElkNode[] | undefined, dx: number, dy: number): void => {
    for (const item of list ?? []) {
      const x = (item.x ?? 0) + dx;
      const y = (item.y ?? 0) + dy;
      if (item.id.startsWith('cluster:')) {
        const cluster = graph.clusters.find((c) => `cluster:${c.id}` === item.id);
        if (cluster) {
          cluster.x = x;
          cluster.y = y;
          cluster.width = item.width ?? 0;
          cluster.height = item.height ?? 0;
          // A packed group has no ELK children to walk; its members carry the
          // offsets worked out above and are placed relative to the panel.
          if (packed.has(cluster.id)) {
            for (const id of cluster.nodes) {
              const node = byId.get(id);
              if (!node || node.gridX === undefined) continue;
              node.x = x + scene.clusterPad + node.gridX;
              node.y = y + headroom + node.gridY!;
            }
          }
        }
        place(item.children, x, y);
        continue;
      }
      const node = byId.get(item.id);
      if (node) {
        node.x = x;
        node.y = y;
        node.width = item.width ?? node.width;
        node.height = item.height ?? node.height;
      }
    }
  };
  place(result.children, 0, 0);

  // Pin each excluded satellite on a row's centre line of its own — never in
  // the gap between two (DESIGN 2.3: a node's band overlapping a row without
  // sharing its exact centre is the same fault as two rows failing to
  // align), and never sharing an existing row's column either. Slotting it
  // into the very next row (DT/TLD's, in regex-engine) reads fine for 2.3 on
  // its own, but that row sits one gap above the row its *own* outgoing edge
  // has to reach — the same gap a real chain edge (`TLD`→`OK`) already
  // crosses — so the two end up sharing a corridor no amount of relabelling
  // one edge's lane can clear without either drifting off its own channel's
  // true centre (DESIGN 6.1) or the two landing under 16 apart (6.4): a
  // dead end's own row and column are both free of the rest of the chart
  // instead, appended after the last row on the grid and past its far edge,
  // so every edge it touches crosses a gap nothing else uses.
  const gutter = 32;
  const others0 = graph.nodes.filter((n) => n.x !== undefined && !satelliteIds.has(n.id));
  const rowCentres: number[] = [];
  for (const c of others0.map((n) => n.y! + n.height! / 2).sort((a, b) => a - b)) {
    if (rowCentres.length && c - rowCentres[rowCentres.length - 1]! <= 9) continue;
    rowCentres.push(c);
  }
  const pitch = rowCentres.length > 1 ? rowCentres[1]! - rowCentres[0]! : 0;

  for (const id of satelliteIds) {
    const node = byId.get(id);
    const parent = byId.get(soleParent.get(id)!);
    if (!node || !parent || parent.x === undefined) continue;
    const others = graph.nodes.filter((n) => n.id !== id && n.x !== undefined);
    const overlapsAt = (x: number, y: number) =>
      others.some((n) =>
        x < n.x! + n.width! && x + node.width! > n.x! &&
        y < n.y! + n.height! && y + node.height! > n.y!,
      );

    const parentCentre = parent.y! + parent.height! / 2;
    const lastRow = rowCentres[rowCentres.length - 1] ?? parentCentre;
    const y = lastRow + (pitch || (parent.height ?? 0) + gutter) - node.height! / 2;

    const rightEdge = others.length ? Math.max(...others.map((n) => n.x! + n.width!)) : parent.x!;
    const leftEdge = others.length ? Math.min(...others.map((n) => n.x!)) : parent.x!;
    // Past whichever edge of the grid the parent's own column already sits
    // on, not just the right one: nothing else has ever occupied the space
    // beyond the grid's own outer column, on either side, so extending past
    // the side the parent is already the extreme of keeps every row between
    // it and the satellite clear the whole way down. Extending the *other*
    // way instead — past the far edge when the parent sits at the near one —
    // is what used to put another column's whole run of nodes directly
    // between parent and satellite (regex-engine's `AT`, in the grid's own
    // first column, reaching right past the second column instead of left
    // past nothing at all).
    const pastLeft = leftEdge - gutter - node.width!;
    const pastRight = rightEdge + gutter;
    const preferLeft = Math.abs(parent.x! - leftEdge) < 0.5;
    const order = preferLeft ? [pastLeft, pastRight] : [pastRight, pastLeft];
    node.x = order.find((cx) => !overlapsAt(cx, y)) ?? order[0]!;
    node.y = y;
  }

  square(graph, scene);
  const bounds = extentOf(graph);
  return { width: bounds.width, height: bounds.height };
}

interface Rect { x: number; y: number; width: number; height: number }

const onGrid = (v: number, step = 8) => Math.round(v / step) * step;

/** Everything that has been placed, as one box. */
function extentOf(graph: Graph): Rect {
  const boxes: Rect[] = [
    ...graph.nodes.filter((n) => n.x !== undefined).map((n) => ({
      x: n.x!, y: n.y!, width: n.width!, height: n.height!,
    })),
    ...graph.clusters.filter((c) => c.x !== undefined).map((c) => ({
      x: c.x!, y: c.y!, width: c.width!, height: c.height!,
    })),
  ];
  if (!boxes.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: 0, y: 0, width: x1, height: y1 };
}

/**
 * Put the layout back on the grid. DESIGN 2.1, 2.3, 2.6.
 *
 * A layout engine optimises for edge length and crossings; it has no reason to
 * care that two boxes in the same row are a fifth of a unit apart vertically, or
 * that a column sits at x 292.1. Nobody sees the fifth of a unit — but with
 * every edge now axis-aligned, a row that is not exactly a row turns each of its
 * edges into a jog, and eight jogs is what "generated" looks like.
 *
 * So the placement is read as rows and columns, each is given one exact
 * coordinate on the 8-grid, and the panels are refitted around whatever moved.
 */
function square(graph: Graph, scene: Scene): void {
  const placed = graph.nodes.filter((n) => n.x !== undefined && n.width !== undefined);
  if (!placed.length) return;

  // Rows and columns are found by *centre*, because a diamond in a row of boxes
  // shares the row's middle and nothing else about it.
  const band = (
    items: GraphNode[],
    centreOf: (n: GraphNode) => number,
    move: (n: GraphNode, to: number) => void,
  ) => {
    const order = [...items].sort((a, b) => centreOf(a) - centreOf(b));
    let group: GraphNode[] = [];
    const flush = () => {
      if (!group.length) return;
      const mean = group.reduce((sum, n) => sum + centreOf(n), 0) / group.length;
      const target = onGrid(mean);
      for (const n of group) move(n, target);
      group = [];
    };
    for (const n of order) {
      if (group.length && centreOf(n) - centreOf(group[group.length - 1]!) > 9) flush();
      group.push(n);
    }
    flush();
  };

  // A record — a class box, an entity table — is as tall as its own contents, so
  // a row of them is a row of three different heights with nothing lining up.
  // DESIGN 2.3 says a row shares a height; the extra room goes under the last
  // member row, which is where a table's spare space belongs anyway.
  const records = placed.filter((n) => n.shape === 'panel');
  const rows: GraphNode[][] = [];
  for (const node of [...records].sort((a, b) => a.y! - b.y!)) {
    const found = rows.find((r) =>
      r.some((o) => node.y! < o.y! + o.height! && o.y! < node.y! + node.height!));
    if (found) found.push(node);
    else rows.push([node]);
  }
  for (const row of rows) {
    if (row.length < 2) continue;
    const top = Math.min(...row.map((n) => n.y!));
    const height = Math.max(...row.map((n) => n.height!));
    for (const node of row) {
      node.y = top;
      node.height = height;
    }
  }

  const gridUp = () => {
    band(placed, (n) => n.y! + n.height! / 2, (n, to) => { n.y = to - n.height! / 2; });
    band(placed, (n) => n.x! + n.width! / 2, (n, to) => { n.x = to - n.width! / 2; });
  };
  gridUp();

  alignPanels(graph, scene);

  // A cluster is whatever its members now occupy, plus its padding and the room
  // its heading needs. Refitting is what keeps a member from hanging out of its
  // own group after the grid moved it.
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // Same adjustment as the forward placement above — this recovers a cluster's
  // top edge from where its members actually ended up, so it has to use the
  // same content-start offset that put them there in the first place.
  const headroom = clusterHeadroom(scene) + scene.clusterPad * 0.5;
  const refit = () => {
    for (const cluster of graph.clusters) {
      const members = cluster.nodes
        .map((id) => byId.get(id))
        .filter((n): n is GraphNode => n !== undefined && n.x !== undefined);
      if (!members.length) continue;
      const contentX0 = Math.min(...members.map((n) => n.x!));
      const contentX1 = Math.max(...members.map((n) => n.x! + n.width!));
      // DESIGN 2.6: the panel's own title/kicker text count as content it has
      // to hug too. When they are wider than the children, the box grows
      // around the content's own centre rather than the children's edges —
      // padding stays 24 on both sides instead of piling onto one.
      const contentWidth = Math.max(contentX1 - contentX0, cluster.headerWidth ?? 0);
      const contentCx = (contentX0 + contentX1) / 2;
      const x0 = onGrid(contentCx - contentWidth / 2 - scene.clusterPad);
      const x1 = onGrid(contentCx + contentWidth / 2 + scene.clusterPad);
      const y0 = Math.min(...members.map((n) => n.y!)) - headroom;
      const y1 = Math.max(...members.map((n) => n.y! + n.height!)) + scene.clusterPad;
      cluster.x = x0;
      cluster.y = y0;
      cluster.width = x1 - x0;
      cluster.height = y1 - y0;
    }
  };
  refit();

  // The grid pass above bands every node's centre by proximity across the
  // *whole* diagram, which can pull a cluster's own rows a few units off
  // whatever gap ELK gave them inside the panel — enough, once an arrowhead's
  // reach is subtracted from it, to land under the 16-unit rendered floor.
  // DESIGN 2.6 says a panel's children obey 2.3's 24/32 gutter regardless, so
  // it is enforced directly here rather than left to survive the rounding.
  enforceClusterGutters(graph);
  refit();

  spreadClusters(graph, scene);
  // Moving whole groups puts their contents into new rows and columns with each
  // other, so the grid is read again now that they are neighbours.
  gridUp();
  refit();
  shareClusterGrid(graph);
  centreRows(graph);
  alignSoleChildren(graph);

  // Pull the whole drawing back to the origin: bands and panels both move things
  // left and up, and a drawing that starts at -40 loses its margin.
  const boxes = [
    ...placed.map((n) => ({ x: n.x!, y: n.y! })),
    ...graph.clusters.filter((c) => c.x !== undefined).map((c) => ({ x: c.x!, y: c.y! })),
  ];
  const dx = Math.min(...boxes.map((b) => b.x));
  const dy = Math.min(...boxes.map((b) => b.y));
  if (dx || dy) {
    for (const n of placed) { n.x! -= dx; n.y! -= dy; }
    for (const c of graph.clusters) {
      if (c.x === undefined) continue;
      c.x -= dx;
      c.y! -= dy;
    }
  }
}

/**
 * Force a 32-unit gutter between vertically stacked siblings inside a panel.
 * DESIGN 2.3, 2.6.
 *
 * ELK is handed this spacing already (the cluster's own `elk.spacing.nodeNode`
 * / `nodeNodeBetweenLayers`), but the row-banding pass above snaps every
 * node's centre by its proximity to every *other* node in the diagram, not
 * just its cluster-mates — close enough to a neighbour outside the panel and
 * a row can be pulled a handful of units off the gap ELK actually gave it.
 * Once an arrowhead's reach is subtracted from what is left, that is enough
 * to put the drawn edge under the 16-unit floor. So the gutter is checked
 * directly, per column of siblings that actually overlap in x, and anything
 * still short is pushed down — carrying whatever sits below it in the same
 * column along, so closing one gap can never reopen the next.
 *
 * Only a column pair with an actual edge between them is touched. A packed
 * group (DESIGN 2.6's unconnected cards, laid out by `packed` above) has no
 * inner edges at all, so nothing measures the gap between its rows — its
 * tighter grid is the point, not a bug, and forcing 32 between its rows would
 * only push its own boundary into whatever sits below the panel.
 */
function enforceClusterGutters(graph: Graph): void {
  const gutter = 32;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const connected = new Set(graph.edges.map((e) => [e.from, e.to].sort().join('|')));
  const linked = (a: GraphNode, b: GraphNode) => connected.has([a.id, b.id].sort().join('|'));
  for (const cluster of graph.clusters) {
    const members = cluster.nodes
      .map((id) => byId.get(id))
      .filter((n): n is GraphNode => n !== undefined && n.x !== undefined);
    if (members.length < 2) continue;
    const columns: GraphNode[][] = [];
    for (const node of [...members].sort((a, b) => a.x! - b.x!)) {
      const column = columns.find((c) =>
        c.some((o) => node.x! < o.x! + o.width! && o.x! + o.width! > node.x!));
      if (column) column.push(node);
      else columns.push([node]);
    }
    for (const column of columns) {
      column.sort((a, b) => a.y! - b.y!);
      for (let i = 1; i < column.length; i++) {
        if (!linked(column[i - 1]!, column[i]!)) continue;
        const need = column[i - 1]!.y! + column[i - 1]!.height! + gutter;
        if (column[i]!.y! < need) {
          const dy = need - column[i]!.y!;
          for (let j = i; j < column.length; j++) column[j]!.y! += dy;
        }
      }
    }
  }
}

/**
 * Line a panel's inputs and outputs up column for column. DESIGN 2.6.
 *
 * This is the one composition the reference the spec was measured from is built
 * on, and the one thing a layout engine will never do: it has no notion that the
 * four things feeding a panel and the four things it produces are the *same four
 * columns*, so it spaces each row for itself and every edge arrives at an angle.
 *
 * Given the columns, each edge is one straight vertical from an input's bottom
 * into the panel's top, and out of its bottom into an output's top — which is
 * the whole of the golden's edge geometry.
 */
function alignPanels(graph: Graph, scene: Scene): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const inside = new Set(graph.clusters.flatMap((c) => c.nodes));

  for (const cluster of graph.clusters) {
    if (cluster.x === undefined) continue;
    const outside = (id: string) => !inside.has(id) && byId.has(id);
    const feeds = graph.edges.filter((e) => e.to === cluster.id && outside(e.from)).map((e) => e.from);
    const yields = graph.edges.filter((e) => e.from === cluster.id && outside(e.to)).map((e) => e.to);
    const inputs = [...new Set(feeds)].map((id) => byId.get(id)!);
    const outputs = [...new Set(yields)].map((id) => byId.get(id)!);
    if (!inputs.length && !outputs.length) continue;

    const columns = Math.max(inputs.length, outputs.length);
    if (columns < 2) continue;
    const width = Math.max(...[...inputs, ...outputs].map((n) => n.width!));
    const room = scene.canvas.width - scene.canvas.margin * 2;
    // Equal gutters on the 8-grid, as wide as the canvas can carry. DESIGN 2.3.
    const gutter = [32, 24, 16, 8].find((g) => columns * width + (columns - 1) * g <= room) ?? 8;
    const span = columns * width + (columns - 1) * gutter;
    const left = onGrid((room - span) / 2);

    const lay = (row: GraphNode[]) => {
      if (!row.length) return;
      // A short row keeps the same columns, centred among them.
      const skip = Math.floor((columns - row.length) / 2);
      const y = onGrid(Math.min(...row.map((n) => n.y!)));
      row.forEach((node, i) => {
        node.width = width;
        node.x = left + (skip + i) * (width + gutter);
        node.y = y;
      });
    };
    lay(inputs);
    lay(outputs);

    // The panel spans every column it talks to, so each channel drops straight
    // in rather than converging on the panel's middle.
    const centres = [...inputs, ...outputs].map((n) => n.x! + n.width! / 2);
    const members = cluster.nodes
      .map((id) => byId.get(id))
      .filter((n): n is GraphNode => n !== undefined && n.x !== undefined);
    const pad = scene.clusterPad;
    const x0 = onGrid(Math.min(...centres) - pad * 2);
    const x1 = onGrid(Math.max(...centres) + pad * 2);
    if (!members.length) continue;

    // Re-space the children across the widened panel, on its own grid.
    const rows = new Map<number, GraphNode[]>();
    for (const node of members) {
      const key = onGrid(node.y! + node.height! / 2);
      rows.set(key, [...(rows.get(key) ?? []), node]);
    }
    // The panel's own grid (2.6): one gutter of 24, and the cards take the rest.
    // Spreading fixed-width cards across the panel instead leaves gutters three
    // times the size of the ones outside it, which is 2.3's "gutters are equal"
    // broken at the level nobody thinks to check.
    const inner = x1 - x0 - pad * 2;
    const gap = 24;
    for (const row of rows.values()) {
      row.sort((a, b) => a.x! - b.x!);
      const cellWidth = Math.max(
        Math.max(...row.map((n) => n.width!)),
        onGrid((inner - (row.length - 1) * gap) / row.length),
      );
      const total = row.length * cellWidth + (row.length - 1) * gap;
      const start = x0 + pad + Math.max(0, onGrid((inner - total) / 2));
      row.forEach((node, i) => {
        node.width = cellWidth;
        node.x = start + i * (cellWidth + gap);
      });
    }
  }
}


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
async function fold(
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
    !shortBackEdged &&
    ((r.width ?? 0) < room * 0.55 || (r.height ?? 0) > (r.width ?? 1) * 1.2);
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
      candidate = cloneElk(await run({
        'elk.aspectRatio': String(aspect),
        'elk.layered.wrapping.strategy': 'MULTI_EDGE',
        'elk.layered.wrapping.additionalEdgeSpacing': String(scene.gapNode),
        'elk.layered.wrapping.correctionFactor': '1',
      }));
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

interface PlacedNode { id: string; x: number; y: number; width: number; height: number }

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
function buildChainGrid(chainNodes: GraphNode[], k: number, gutter: number, corridor: number): ChainGrid {
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
    Math.abs(b.height / b.width - target) < Math.abs(a.height / a.width - target) ? b : a);

  const placed = new Map<string, PlacedNode>();
  for (const p of best.placed) placed.set(p.id, p);

  const overlaps = (a: PlacedNode, b: PlacedNode) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const collides = (p: PlacedNode) => [...placed.values()].some((o) => o.id !== p.id && overlaps(p, o));

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
    corridors.push({ id: `corridor:${r}`, x: x0, y: rowBottom - corridorPad, width: x1 - x0, height: rowTop - rowBottom + corridorPad * 2 });
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
    const forwardParent = graph.edges.find((e) => e.to === node.id && !e.backward && chainSet.has(e.from))?.from;
    const retryTarget = graph.edges.find((e) => e.from === node.id && e.backward && chainSet.has(e.to))?.to;
    const anchorId = forwardParent ?? retryTarget;
    const anchor = anchorId ? placed.get(anchorId) : undefined;
    const anchorRow = anchorId ? best.rows.findIndex((row) => row.some((n) => n.id === anchorId)) : -1;
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
      if (!blocked(trial)) { placed.set(node.id, trial); ok = true; }
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
      const above = anchorRow > 0
        ? Math.max(...best.rows[anchorRow - 1]!.map((n) => placed.get(n.id)!.y + placed.get(n.id)!.height))
        : -Infinity;
      const below = anchorRow < best.rows.length - 1
        ? Math.min(...best.rows[anchorRow + 1]!.map((n) => placed.get(n.id)!.y))
        : Infinity;
      for (const clearance of [8, 16, 24]) {
        const candidates = [
          Math.max(anchor.y - clearance - node.height, above + 8),
          Math.min(anchor.y + anchor.height + clearance, below - 8 - node.height),
        ];
        for (const y of candidates) {
          const trial: PlacedNode = { id: node.id, x, y, width: node.width, height: node.height };
          if (!blocked(trial)) { placed.set(node.id, trial); ok = true; break; }
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
function bandByCentre(items: ElkNode[], centreOf: (n: ElkNode) => number, tolerance = 9): ElkNode[][] {
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
function chainWraps(byId: Map<string, ElkNode>, chain: string[]): boolean {
  for (let k = 1; k < chain.length; k++) {
    const a = byId.get(chain[k - 1]!);
    const b = byId.get(chain[k]!);
    if (!a || !b) continue;
    if (a.x === undefined || a.y === undefined || a.width === undefined || a.height === undefined) continue;
    if (b.x === undefined || b.y === undefined || b.width === undefined) continue;
    if (b.y >= a.y + a.height - 1 && b.x + b.width <= a.x + 1) return true;
  }
  return false;
}

/**
 * Pull a chain node that ends up alone in its column onto a nearby column —
 * an existing shared one, or another orphan close enough to pair with — never
 * moving one when the move would cost more than it's worth. DESIGN 7.4.
 *
 * A decision diamond's two outgoing edges shift its own rank position by a
 * dozen-odd units off where a plain box in the equivalent spot would land —
 * just past `gridUp`'s 9-unit banding tolerance, so nothing downstream ever
 * merges them even though the mismatch is a routing artefact, not a real
 * design difference. This applies the same "close enough to read as a line
 * that slipped, not its own column" reasoning `alignSoleChildren` already
 * uses for a single edge, but across the wrap.
 *
 * "Cost" is measured directly on the node's own edges rather than guessed at
 * from which ones happen to be loop-backs: every move is scored by how much
 * it stretches the Manhattan span of that node's edges, and among every
 * (orphan, target) pairing — not just each orphan's own nearest target — the
 * search always takes the cheapest one first. That is what finds "move
 * Portfolio 11 units onto the decision diamond's column" over "move the
 * diamond itself 300 units to reach Portfolio's neighbours", the same 11-unit
 * gap looked at from the other node. A move never taken at all when nothing
 * safe stays under budget is a smaller fault than a stretched loop-back or a
 * detour dragged across the whole diagram — `foldQuality` still marks that
 * candidate as failing, so a cleaner one wins the search instead.
 */
function snapOrphanColumns(children: ElkNode[], chain: string[], edges: { from: string; to: string }[]): void {
  const inner = chain.slice(1, -1);
  if (inner.length < 2) return;
  const byId = new Map(children.map((n) => [n.id, n] as const));
  if (!chain.every((id) => byId.has(id))) return;
  if (!chainWraps(byId, chain)) return;

  const withXY = children.filter(
    (n) => n.x !== undefined && n.y !== undefined && n.width !== undefined && n.height !== undefined,
  );
  const cx = (n: ElkNode) => n.x! + n.width! / 2;
  const cy = (n: ElkNode) => n.y! + n.height! / 2;
  const innerSet = new Set(inner);
  const overlaps = (a: ElkNode, b: ElkNode) =>
    a.x! < b.x! + b.width! && a.x! + a.width! > b.x! && a.y! < b.y! + b.height! && a.y! + a.height! > b.y!;
  // A move this cheap reads as the line having merely slipped a rounding
  // error; past it, it is spending someone else's edge budget to buy this
  // node a column, which `foldQuality` failing on the result is honest about
  // and leaves for a cleaner candidate to win instead.
  const budget = 48;

  interface Move { node: ElkNode; x: number; cost: number }
  const cheapestMove = (): Move | null => {
    const groups = bandByCentre(withXY, cx);
    const orphans = groups.filter((g) => g.length === 1 && innerSet.has(g[0]!.id)).map((g) => g[0]!);
    let best: Move | null = null;
    for (const node of orphans) {
      const own = groups.find((g) => g[0] === node)!;
      const targets = groups.filter((g) => g !== own).map((g) => g.reduce((sum, n) => sum + cx(n), 0) / g.length);
      for (const groupCx of targets) {
        // Landing exactly on the target's mean is more than the merge needs —
        // gridUp only requires being within its own 9-unit gap tolerance, so
        // the node moves only as far as the near edge of that window, the
        // smallest move that still bands with it.
        const targetCx = Math.max(groupCx - 8, Math.min(groupCx + 8, cx(node)));
        const x = targetCx - node.width! / 2;
        const trial: ElkNode = { ...node, x };
        if (withXY.some((other) => other !== node && overlaps(trial, other))) continue;
        const cost = edges.reduce((sum, e) => {
          if (e.from !== node.id && e.to !== node.id) return sum;
          const other = byId.get(e.from === node.id ? e.to : e.from);
          if (!other || other.x === undefined) return sum;
          const before = Math.abs(cx(node) - cx(other)) + Math.abs(cy(node) - cy(other));
          const after = Math.abs(targetCx - cx(other)) + Math.abs(cy(node) - cy(other));
          return sum + Math.max(0, after - before);
        }, 0);
        if (!best || cost < best.cost) best = { node, x, cost };
      }
    }
    return best;
  };

  // Cheapest move first, across every remaining orphan, not just each one's
  // own nearest target — a later, now-cheaper move can beat an earlier one
  // once an earlier merge has changed the columns on offer.
  for (let guard = 0; guard < inner.length; guard++) {
    const move = cheapestMove();
    if (!move || move.cost > budget) break;
    move.node.x = move.x;
  }
}

function foldQuality(children: ElkNode[], chain: string[]): { balanced: boolean; orphanFree: boolean } {
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
  const innerNodes = inner.map((id) => byId.get(id)!).filter((n) => n.y !== undefined && n.height !== undefined);
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
function longestPath(graph: Graph): number {
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


/** Move a cluster and everything in it. */
function shiftCluster(cluster: GraphCluster, byId: Map<string, GraphNode>, dx: number, dy: number): void {
  cluster.x! += dx;
  cluster.y! += dy;
  for (const id of cluster.nodes) {
    const node = byId.get(id);
    if (!node || node.x === undefined) continue;
    node.x += dx;
    node.y! += dy;
  }
}

/**
 * A stack of narrow groups goes side by side instead. DESIGN 1.2, 1.4, 2.3.
 *
 * Three groups of two boxes each, laid top to bottom, is a 200-wide strip down
 * the middle of a 1000-wide stage and three times taller than it needs to be —
 * the fault 1.4 names and 7.4 measures. The content itself says which way it
 * wants to go: groups that are narrow relative to the canvas read as columns of
 * a pipeline, and a pipeline runs across. Wide groups (a layer with three
 * services in it) are left stacked, because that is what a layer diagram is.
 */
function spreadClusters(graph: Graph, scene: Scene): void {
  const clusters = graph.clusters.filter((c) => c.x !== undefined && c.nodes.length);
  if (clusters.length < 2) return;
  const held = new Set(clusters.flatMap((c) => c.nodes));
  if (!graph.nodes.every((n) => held.has(n.id))) return;

  const room = scene.canvas.width - scene.canvas.margin * 2;
  const widest = Math.max(...clusters.map((c) => c.width!));
  if (widest >= room * 0.55) return;

  const gutter = 32;
  const total = clusters.reduce((sum, c) => sum + c.width!, 0) + gutter * (clusters.length - 1);
  if (total > room) return;

  // Reading order comes from the edges between the groups, not from where the
  // layout happened to put them — a chain laid out as an L still reads A, B, C.
  const owner = new Map<string, string>();
  for (const c of clusters) for (const id of c.nodes) owner.set(id, c.id);
  const after = new Map<string, Set<string>>(clusters.map((c) => [c.id, new Set<string>()]));
  const before = new Map<string, number>(clusters.map((c) => [c.id, 0]));
  for (const edge of graph.edges) {
    const a = owner.get(edge.from) ?? edge.from;
    const b = owner.get(edge.to) ?? edge.to;
    if (a === b || !after.has(a) || !after.has(b) || after.get(a)!.has(b)) continue;
    after.get(a)!.add(b);
    before.set(b, before.get(b)! + 1);
  }
  const queue = clusters.filter((c) => before.get(c.id) === 0).map((c) => c.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of after.get(id) ?? []) {
      before.set(next, before.get(next)! - 1);
      if (before.get(next) === 0) queue.push(next);
    }
  }
  for (const c of clusters) if (!order.includes(c.id)) order.push(c.id);

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let x = 0;
  for (const id of order) {
    const cluster = clusters.find((c) => c.id === id)!;
    shiftCluster(cluster, byId, x - cluster.x!, -cluster.y!);
    x += cluster.width! + gutter;
  }
}

/**
 * Groups line up with each other, the same way their contents do. DESIGN 2.3.
 *
 * Two panels side by side with tops a few units apart, or a stack of panels
 * three different widths, is the row-and-column fault one level up. Sharing the
 * edge means the group boxes read as a grid rather than as three rectangles that
 * happen to be near each other.
 */
function shareClusterGrid(graph: Graph): void {
  const clusters = graph.clusters.filter((c) => c.x !== undefined && c.nodes.length);
  if (clusters.length < 2) return;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const groupBy = (
    lo: (c: GraphCluster) => number,
    hi: (c: GraphCluster) => number,
  ): GraphCluster[][] => {
    const out: GraphCluster[][] = [];
    for (const cluster of [...clusters].sort((a, b) => lo(a) - lo(b))) {
      const found = out.find((g) => g.some((o) => lo(cluster) < hi(o) && lo(o) < hi(cluster)));
      if (found) found.push(cluster);
      else out.push([cluster]);
    }
    return out;
  };

  // A row of groups: one top edge, so title bands line up. Each panel keeps
  // its own hugged height — DESIGN 2.6's bottom padding is the panel's own
  // children plus 24, never stretched to match a taller sibling.
  for (const row of groupBy((c) => c.y!, (c) => c.y! + c.height!)) {
    if (row.length < 2) continue;
    const top = onGrid(Math.min(...row.map((c) => c.y!)));
    for (const cluster of row) {
      shiftCluster(cluster, byId, 0, top - cluster.y!);
    }
  }
  // A column of groups: centred on the column's widest member, DESIGN 7.3 —
  // each panel keeps its own hugged width rather than being stretched to a
  // sibling's.
  for (const column of groupBy((c) => c.x!, (c) => c.x! + c.width!)) {
    if (column.length < 2) continue;
    const left = onGrid(Math.min(...column.map((c) => c.x!)));
    const width = Math.max(...column.map((c) => c.x! + c.width!)) - left;
    for (const cluster of column) {
      const inset = onGrid((width - cluster.width!) / 2);
      shiftCluster(cluster, byId, left + inset - cluster.x!, 0);
      cluster.x = left + inset;
    }
  }
}

/**
 * Every row of a composition shares one vertical axis. DESIGN 7.3.
 *
 * `shareClusterGrid` above lines panels up with their own cluster neighbours,
 * but a composition also has top-level nodes that are not panels at all — an
 * output node under a chain of panels, say — and those never enter that pass.
 * ELK sizes each row for its own contents and leaves it wherever that placement
 * landed; nothing so far has made a narrow row share a centre with a wide one,
 * so it reads as pushed aside rather than as the next step of the same story.
 *
 * A row is read as a rigid unit for the centring step below — every panel and
 * every free node whose vertical band overlaps it — but the gap *inside* a
 * row is fixed first (DESIGN 2.3): ELK placed a folded row's members by the
 * cluster sizes it was handed before `refit` (above) hugged each panel down
 * to its actual contents, so the interior gap is wherever the pre-shrink
 * boxes happened to leave it, not a real 32. Each row is repacked at that
 * gutter, in ELK's own left-to-right order, before the row is slid onto the
 * widest row's centre.
 *
 * An item stays where it is instead when it lines up (centre within 8) with
 * something in the row above or below — a tree's fan-out, a panel's aligned
 * inputs/outputs (2.6) — and the rest of the row is packed around it rather
 * than through it.
 *
 * Only charts built from panels are compositions in this sense (DESIGN 7.3
 * applies to those; a plain flowchart wrapped into rows of boxes is a chain
 * folded to fit the canvas, not a composition, and rule 1.2/1.4 already govern
 * it). So this is skipped whenever the chart has no clusters at all.
 */
function centreRows(graph: Graph): void {
  if (!graph.clusters.length) return;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const inside = new Set(graph.clusters.flatMap((c) => c.nodes));

  interface Item { cluster?: GraphCluster; node?: GraphNode; x0: number; x1: number; y0: number; y1: number }
  const items: Item[] = [];
  for (const c of graph.clusters) {
    if (c.x === undefined) continue;
    items.push({ cluster: c, x0: c.x, x1: c.x + c.width!, y0: c.y!, y1: c.y! + c.height! });
  }
  for (const n of graph.nodes) {
    if (n.x === undefined || inside.has(n.id)) continue;
    items.push({ node: n, x0: n.x, x1: n.x + n.width!, y0: n.y!, y1: n.y! + n.height! });
  }
  if (items.length < 2) return;

  interface Row { items: Item[]; top: number; bottom: number }
  const rows: Row[] = [];
  for (const it of [...items].sort((a, b) => a.y0 - b.y0)) {
    const row = rows.find((r) => it.y0 < r.bottom - 1 && it.y1 > r.top + 1);
    if (row) {
      row.items.push(it);
      row.top = Math.min(row.top, it.y0);
      row.bottom = Math.max(row.bottom, it.y1);
    } else {
      rows.push({ items: [it], top: it.y0, bottom: it.y1 });
    }
  }
  // "Above" and "below" (the packing exception just below) mean top to bottom,
  // not the order rows happened to be discovered in.
  rows.sort((a, b) => a.top - b.top);
  for (const row of rows) row.items.sort((a, b) => a.x0 - b.x0);

  const shift = (it: Item, dx: number) => {
    if (!dx) return;
    if (it.cluster) shiftCluster(it.cluster, byId, dx, 0);
    else if (it.node) it.node.x! += dx;
    it.x0 += dx;
    it.x1 += dx;
  };

  // DESIGN 2.3 allows 24 or 32; 32 is the gutter every panel-level pass already
  // uses (enforceClusterGutters, alignPanels), so a repacked row matches its
  // neighbours rather than introducing a third value.
  const gutter = 32;
  const centreOf = (it: Item) => (it.x0 + it.x1) / 2;
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri]!;
    if (row.items.length < 2) continue;
    const neighbours = [rows[ri - 1], rows[ri + 1]]
      .filter((r): r is Row => Boolean(r))
      .flatMap((r) => r.items);
    const aligned = (it: Item) => neighbours.some((o) => Math.abs(centreOf(o) - centreOf(it)) < 8);

    // The first aligned item anchors the row; anything left of it packs
    // backward from its fixed edge so order and gutter both hold.
    const anchor = row.items.findIndex((it) => aligned(it));
    if (anchor > 0) {
      let right = row.items[anchor]!.x0 - gutter;
      for (let k = anchor - 1; k >= 0; k--) {
        const w = row.items[k]!.x1 - row.items[k]!.x0;
        shift(row.items[k]!, right - w - row.items[k]!.x0);
        right -= w + gutter;
      }
    }
    // Everything from the anchor (or the row's own first item, if nothing in
    // it aligns with a neighbour) rightward packs forward at the gutter,
    // skipping — but not moving — any further aligned item it meets.
    let cursor = row.items[Math.max(anchor, 0)]!.x1;
    for (let i = Math.max(anchor, 0) + 1; i < row.items.length; i++) {
      const it = row.items[i]!;
      if (aligned(it)) { cursor = it.x1; continue; }
      const w = it.x1 - it.x0;
      const newX0 = cursor + gutter;
      shift(it, newX0 - it.x0);
      cursor = newX0 + w;
    }
  }

  if (rows.length < 2) return;

  const span = (row: Row) => {
    const left = Math.min(...row.items.map((i) => i.x0));
    const right = Math.max(...row.items.map((i) => i.x1));
    return { centre: (left + right) / 2, width: right - left };
  };
  const widest = rows.reduce((best, row) => (span(row).width > span(best).width ? row : best), rows[0]!);
  const target = span(widest).centre;

  for (const row of rows) {
    const dx = onGrid(target - span(row).centre);
    for (const it of row.items) shift(it, dx);
  }
}

/**
 * A sole child sits on its sole parent's centre line. DESIGN 2.3.
 *
 * `square`'s own grid pass (`band`, above) merges any two centres within 9
 * units of each other, which is how most rows and columns end up sharing an
 * exact line for free. It only misses a node with nothing on either side
 * close enough to band with — a fold that hands a row exactly one member
 * (`4geeks-journey.mmd`'s "Applies online", alone in row one, left at
 * whatever x the pre-fold LR layout gave it) or two nodes that are each
 * alone in their own row and so never get a neighbour to band against at all
 * (`messy.mmd`'s Start and its diamond). Run last, once every other pass has
 * settled, so nothing later pulls the pair apart again.
 *
 * Only a genuine chain link counts: the parent's one forward edge out, the
 * child's one forward edge in — a branch or a merge has real reasons to sit
 * off the line and is left alone (2.3 does not ask a diamond's two children
 * to share its centre). Between the two, the one with fewer edges elsewhere
 * in the graph moves — it has the least else riding on where it sits — onto
 * the centre line of the one with more; a tie moves the child, since it
 * reads as downstream of the parent the eye already followed to reach it.
 */
function alignSoleChildren(graph: Graph): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const forwardOut = new Map<string, number>();
  const forwardIn = new Map<string, number>();
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    if (e.backward || e.from === e.to) continue;
    forwardOut.set(e.from, (forwardOut.get(e.from) ?? 0) + 1);
    forwardIn.set(e.to, (forwardIn.get(e.to) ?? 0) + 1);
  }
  for (const edge of graph.edges) {
    if (edge.backward || edge.from === edge.to) continue;
    if (forwardOut.get(edge.from) !== 1 || forwardIn.get(edge.to) !== 1) continue;
    const parent = byId.get(edge.from);
    const child = byId.get(edge.to);
    if (!parent || !child) continue;
    if (parent.x === undefined || child.x === undefined) continue;

    const stackedTB = child.y! >= parent.y! + parent.height! - 1;
    const sideBySideLR = child.x! >= parent.x! + parent.width! - 1;
    if (!stackedTB && !sideBySideLR) continue;

    const parentCentre = stackedTB ? parent.x! + parent.width! / 2 : parent.y! + parent.height! / 2;
    const childCentre = stackedTB ? child.x! + child.width! / 2 : child.y! + child.height! / 2;
    const gap = Math.abs(parentCentre - childCentre);
    // Already aligned, or so far apart it reads as its own column rather
    // than a line that slipped — DESIGN 2.3's own tolerance either way.
    const limit = (stackedTB ? parent.width! + child.width! : parent.height! + child.height!) / 2;
    if (gap < 1.5 || gap >= limit) continue;

    // Landing on the other one's *exact* centre is the point — a diamond's
    // clearance (2.4) can leave its own centre off the 8-grid to begin with,
    // and rounding the mover back onto the grid here is exactly what
    // reopened the 1.5-unit gap this pass exists to close.
    const moveParent = (degree.get(edge.from) ?? 0) < (degree.get(edge.to) ?? 0);
    if (moveParent) {
      if (stackedTB) parent.x = childCentre - parent.width! / 2;
      else parent.y = childCentre - parent.height! / 2;
    } else {
      if (stackedTB) child.x = parentCentre - child.width! / 2;
      else child.y = parentCentre - child.height! / 2;
    }
  }
}
