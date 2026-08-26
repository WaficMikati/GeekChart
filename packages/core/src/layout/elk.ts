/**
 * The ELK layout engine adapter.
 *
 * No DESIGN.md rule of its own — this is the loader for the third-party
 * layered-graph engine everything else in `layout/` drives. The geometry
 * rules live in the modules that call into it.
 */

interface ElkNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkNode[];
  layoutOptions?: Record<string, string>;
  edges?: { id: string; sources: string[]; targets: string[] }[];
}
type ElkApi = { layout(graph: ElkNode): Promise<ElkNode> };

// ~1.4 MB unminified: only flowchart/state/class/er diagrams ever call
// `layout()`, so it is loaded here, in its own chunk, rather than statically —
// exactly the way mermaid lazy-loads its own per-diagram-type code elsewhere in
// this file's callers. Sequence, chronicle, board, plot, radial and commits
// charts never fetch it at all.
let elkPromise: Promise<ElkApi> | undefined;
function getElk(): Promise<ElkApi> {
  if (!elkPromise) {
    elkPromise = import('elkjs/lib/elk.bundled.js').then((ELKModule) => {
      // elkjs ships a UMD bundle; its default export lands in different places
      // depending on how the consumer resolves modules.
      const ElkCtor = ((ELKModule as unknown as { default?: unknown }).default ??
        ELKModule) as unknown as new () => ElkApi;
      return new ElkCtor();
    });
  }
  return elkPromise;
}

export type { ElkNode, ElkApi };
export { getElk };
