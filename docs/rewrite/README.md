# The channel-engine rewrite

Working notes for the 0.2.0 layout rewrite, approved 2026-09-03. The plan,
its evidence, and the current phase.

## Why

Three bodies of evidence converged (details in the repo history and the
decision artifacts):

1. Industry research: every trusted engine makes routing a layout output —
   labels and edges get space by construction, never by post-hoc search.
2. The ELK/Graphviz spikes: no general engine can host our composition
   (wrapping, centring, symmetry); configured ELK topped out at 4/11.
3. A 201-chart user review: 46 flagged charts, all flowcharts, clustering
   into label placement (~15), chain wrapping (13), symmetry (~10), port
   sense (~11), and four plain bugs — every cluster a consequence of
   boxes-first layout with edges squeezed in afterwards.

The adopted pattern (proven by the pr-lens renderer, and by our own
channel-engine spike: 13/13 fan-family charts, zero overlaps, parent
centring 0.00px): reserved corridors and bands, routes as plans over grid
indices, channel sizes derived from their contents, labels pinned to their
edge's longest exclusive run.

## Phases (each on its own local branch, gate + 41 fixtures + the 46
flagged review charts as the wall; ship as 0.2.0 only at green)

1. **DESIGN first** (this branch): rules 1.9, 2.7, 2.8, 6.3, 6.5, 6.9
   rewritten; caption casing freed; ring port sense in 1.8. Done here.
2. **Channel engine into core** for fans and chains; rings and buses stay.
3. **Generalize** to trees, diamonds, clusters; delete the router, label
   search and corridor growth.
4. **Bugs**: dotted/thick strokes, box-to-text sizing, caption casing in
   normalize, edge-label length cap, ring closing-edge port.
5. **Re-render the 201-chart review** for user sign-off.

## The seed

`channel-engine-seed/` is the spike prototype verbatim: `engine.mts` (the
floor-plan/plan/derive structure phase 2 ports), `measure.mts` (invariant
checks against emitted SVG — the model for the new gate checks), and the
measured results. It renders the fan family standalone; it is reference,
not wired code.
