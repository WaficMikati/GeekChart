import type { Graph, GraphEdge, GraphNode } from '../graph.ts';
import type { Scene } from '../scene.ts';
import { layoutSafe } from './safe.ts';
import type { ChannelLayout } from './channels.ts';

/**
 * DESIGN 1.5, mirrored: two or more plain sources feeding one hub, when their
 * row (grid.ts's own `busSources`) cannot stand at the display width.
 *
 * grid.ts's general planner seats a shared-hub source row crosswise, beside
 * the hub, and declines when that row — or the chart the row is part of —
 * does not fit. Before 2026-09-05 the only thing below that decline was the
 * safe layout, which has no idea the sources share a hub at all: it puts
 * every node on its own rank in one column, so a four-source pipeline drew as
 * a false sequence with the hub parked mid-column and four improvised routes
 * (the case this module exists to fix).
 *
 * The fix stacks the sources in one column instead of a row — one box width,
 * 16 apart (DESIGN 1.5's own leaf gap) — joined by a single collecting trunk
 * in a 24-unit indent strip on their right, each source a short branch off
 * its own right face, descending to one arrival into the hub. The hub sits
 * after the stack (below it), centred on it, never interleaved beside it.
 *
 * "Whatever chain continues from the hub packs by its own rules" — the safe
 * layout's rank mechanics, reused wholesale rather than reimplemented: this
 * module builds a standalone sub-graph of the hub and everything reachable
 * from it, hands that to `layoutSafe` (which never declines), and rigidly
 * offsets its result to sit right after the source stack. The two pictures
 * never overlap by construction: the stack occupies everything above the
 * hub's own top face, the sub-graph everything at or below it.
 *
 * Deliberately narrow: no panels, no loop-backs anywhere in the chart, and
 * the sources plus the hub's own forward reach must be the *whole* graph — a
 * shared hub sitting inside a larger picture with other structure around it
 * is the general planner's business, not this one's.
 */

/** DESIGN 1.5: leaves (and, mirrored, sources) stack this far apart. Exported
 *  so panelgrid.ts's own port of this move (a panel-scoped fan-in) reuses the
 *  same derivation rather than picking a new number. */
export const STACK_GAP = 16;
/** DESIGN 1.5 mirrored: the collecting trunk's own indent strip. */
export const TRUNK_INDENT = 24;
/** Room between the stack's last source and the hub, for the trunk's own
 *  final turn into the hub's top face plus a standoff before the arrowhead. */
export const HUB_GAP = 48;
/** How far above the hub's own top face the trunk turns to run level, before
 *  its last, vertical drop into that face — DESIGN 6.1/6.8's 16-unit
 *  clearance from the last source's own bottom edge, plus the two turns the
 *  trunk spends getting off its own line and into the hub's. */
export const HUB_ENTRY_DROP = 24;

export function layoutMirroredSourceStack(
  graph: Graph,
  scene: Scene,
  measureLine: (s: string) => number,
): ChannelLayout | null {
  if (graph.clusters.length) return null; // panels are 2.6/2.10's own shape
  if (graph.edges.some((e) => e.backward)) return null; // no loop-backs in scope

  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const insOf = new Map<string, GraphEdge[]>(graph.nodes.map((n) => [n.id, []]));
  const outsOf = new Map<string, GraphEdge[]>(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) {
    insOf.get(e.to)!.push(e);
    outsOf.get(e.from)!.push(e);
  }

  // The hub: two or more plain sources — a root with no arrivals of its own
  // and this hub its only exit — and nothing else about them (a label on the
  // shared arrival has no run of its own to sit on, same guard grid.ts's own
  // busSources keeps).
  let hub: GraphNode | undefined;
  let sources: GraphNode[] = [];
  for (const node of graph.nodes) {
    const arrivals = insOf.get(node.id)!;
    if (arrivals.length < 2) continue;
    const srcs = arrivals.map((e) => byId.get(e.from)!);
    const plain = srcs.every(
      (s) => insOf.get(s.id)!.length === 0 && outsOf.get(s.id)!.length === 1,
    );
    if (!plain || arrivals.some((e) => e.label)) continue;
    // Every node in the chart is a source, this hub, or reachable forward
    // from it — the shape this module draws is the *whole* picture, not one
    // corner of a larger one.
    const reachable = new Set<string>([node.id]);
    const queue = [node.id];
    while (queue.length) {
      const id = queue.pop()!;
      for (const e of outsOf.get(id)!) {
        if (!reachable.has(e.to)) {
          reachable.add(e.to);
          queue.push(e.to);
        }
      }
    }
    if (reachable.size + srcs.length !== graph.nodes.length) continue;
    hub = node;
    sources = srcs.sort(
      (a, b) => graph.nodes.indexOf(a) - graph.nodes.indexOf(b),
    );
    break;
  }
  if (!hub || sources.length < 2) return null;

  const sourceIds = new Set(sources.map((s) => s.id));
  const downstreamIds = new Set(graph.nodes.map((n) => n.id).filter((id) => !sourceIds.has(id)));

  // ---- The stack: one column, `STACK_GAP` apart, left-aligned on the
  // widest source (2.2/2.3 already share one box width per chart, so this is
  // almost always every source's own width).
  const srcW = Math.max(...sources.map((s) => s.width!));
  const srcX = new Map<string, number>();
  const srcY = new Map<string, number>();
  let cursorY = 0;
  for (const s of sources) {
    srcX.set(s.id, (srcW - s.width!) / 2);
    srcY.set(s.id, cursorY);
    cursorY += s.height! + STACK_GAP;
  }
  const stackBottom = cursorY - STACK_GAP;
  const trunkX = srcW + TRUNK_INDENT;

  // ---- The hub: after the stack, centred on it.
  const hubX = (srcW - hub.width!) / 2;
  const hubY = stackBottom + HUB_GAP;
  const hubCentreX = hubX + hub.width! / 2;

  // ---- The chain continuing from the hub: a standalone sub-graph, laid out
  // by the safe layout's own never-decline rank mechanics, then rigidly
  // offset to sit right after the stack.
  const subNodes = graph.nodes.filter((n) => downstreamIds.has(n.id));
  const subEdges = graph.edges.filter(
    (e) => downstreamIds.has(e.from) && downstreamIds.has(e.to),
  );
  const subGraph: Graph = {
    direction: 'TB',
    nodes: subNodes,
    edges: subEdges,
    clusters: [],
    primaryPath: [],
  };
  layoutSafe(subGraph, scene, measureLine);

  const subHub = byId.get(hub.id)!;
  const offsetX = hubCentreX - (subHub.x! + subHub.width! / 2);
  const offsetY = hubY - subHub.y!;
  for (const n of subNodes) {
    n.x = n.x! + offsetX;
    n.y = n.y! + offsetY;
  }
  for (const e of subEdges) {
    if (!e.channel) continue;
    for (const p of e.channel.points) {
      p.x += offsetX;
      p.y += offsetY;
    }
    if (e.channel.label) {
      e.channel.label.x += offsetX;
      e.channel.label.y += offsetY;
    }
  }

  // ---- Seat the sources and draw the trunk. Every source's own edge runs
  // the full trunk from its own branch down to the hub's one arrival point —
  // DESIGN 6.4's fan-bus exemption, the same idiom `grid.ts`'s stacked leaf
  // trunk and `channels.ts`'s fan-in bus already use: edges overlap on
  // purpose, which is what reads as one shared line instead of several.
  const hubTopY = hubY;
  // The trunk runs level a little above the hub's own top face, then turns
  // for one last, vertical drop into it — the same reason every other
  // fan-in bus in this engine (grid.ts's stacked leaf trunk, its shared-hub
  // row) never lands its final segment sideways: DESIGN 6.2 wants an arrival
  // perpendicular to the face it lands on, and the hub's top face is
  // horizontal, so only a vertical last segment meets it that way.
  const entryY = hubTopY - HUB_ENTRY_DROP;
  for (const s of sources) {
    s.x = srcX.get(s.id)!;
    s.y = srcY.get(s.id)!;
  }
  for (const s of sources) {
    const edge = insOf.get(hub.id)!.find((e) => e.from === s.id)!;
    const sRightX = srcX.get(s.id)! + s.width!;
    const sCentreY = srcY.get(s.id)! + s.height! / 2;
    edge.channel = {
      points: [
        { x: sRightX, y: sCentreY },
        { x: trunkX, y: sCentreY },
        { x: trunkX, y: entryY },
        { x: hubCentreX, y: entryY },
        { x: hubCentreX, y: hubTopY },
      ],
      startSide: 'right',
      endSide: 'top',
      exempt: 'bus',
    };
  }

  // ---- Extent and commit.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const n of graph.nodes) {
    grow(n.x!, n.y!);
    grow(n.x! + n.width!, n.y! + n.height!);
  }
  for (const e of graph.edges) {
    for (const p of e.channel?.points ?? []) grow(p.x, p.y);
    if (e.channel?.label) {
      grow(e.channel.label.x, e.channel.label.y);
      grow(e.channel.label.x + e.channel.label.width, e.channel.label.y + e.channel.label.height);
    }
  }
  for (const n of graph.nodes) {
    n.x = n.x! - minX;
    n.y = n.y! - minY;
  }
  for (const e of graph.edges) {
    if (!e.channel) continue;
    for (const p of e.channel.points) {
      p.x -= minX;
      p.y -= minY;
    }
    if (e.channel.label) {
      e.channel.label.x -= minX;
      e.channel.label.y -= minY;
    }
  }

  graph.engine = 'channels';
  // The picture reads top to bottom whatever the source declared — the
  // stack, trunk and hub are a vertical shape by construction, and the
  // sub-graph below the hub already committed to `layoutSafe`'s own "TB
  // whatever the source declared" (safe.ts). `data-flow` is what the gate
  // reads for 6.2's arrival side and 6.7's corridor clearance, so it has to
  // agree with the geometry actually drawn.
  graph.direction = 'TB';
  // A designed shape, never the `safe` stamp — but its downstream chain is
  // exactly as tall-by-construction as a plain safe column (`flow.ts` reads
  // this to exempt it from DESIGN 1.4's aspect cap the same way).
  graph.layoutKind = 'source-stack';
  return { width: maxX - minX, height: maxY - minY, warnings: [] };
}
