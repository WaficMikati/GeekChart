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
   Done (`packages/core/src/layout/channels.ts`).
3. **Generalize** to trees, diamonds, clusters; delete the router, label
   search and corridor growth. Phase 3a done (`layout/grid.ts`): trees with
   1.5 leaf stacking, decision diamonds and reconverging branches (6.3's
   merged arrival, 6.2's side exclusivity), rank-skipping joins via reserved
   corridors, loop-backs per 6.7/6.8, and the LR/TB axis variants — the
   planner verifies its own result against the gate's budgets and declines
   to the old path when a shape can't hold them. Phase 3b done
   (`layout/panelgrid.ts`): flowcharts with subgraphs, against DESIGN 2.6's
   approved panel language and 2.10's one panel row — a recursive planner
   over the cluster forest, each container ranking its own items and
   reserving the band between them, panels sized from what they hold. Still
   open in 3b: labeled cross-panel edges (a corridor has to be sized for the
   plate), edges naming a PANEL rather than a shape inside it (control-plane,
   architecture, platform-layers, pyenv-resolution — the old path's own
   composition), backward edges across a panel border, and deleting the old
   router.
4. **Bugs**: dotted/thick strokes, box-to-text sizing, caption casing in
   normalize, edge-label length cap, ring closing-edge port.
5. **Re-render the 201-chart review** for user sign-off.

## The seed

`channel-engine-seed/` is the spike prototype verbatim: `engine.mts` (the
floor-plan/plan/derive structure phase 2 ports), `measure.mts` (invariant
checks against emitted SVG — the model for the new gate checks), and the
measured results. It renders the fan family standalone; it is reference,
not wired code.

## Where 2.6 and 2.10 pull against each other

2.6 says the title strip is reserved and no edge crosses it. 2.10 says a
cross-panel edge leaves the child shape's own face and crosses the panel
border perpendicular, never using the border as a proxy. In a top-to-bottom
chart an edge from outside into a panel's first row has to do both: the strip
spans the whole width of the top border, so any perpendicular entry passes
through it.

The reading the engine and the gate both use: **nothing travels along a
strip, and no edge that neither starts nor ends inside the panel enters one.**
A perpendicular crossing by an edge that lands on a shape in the panel
occupies none of the strip's own width and so cannot collide with the kicker,
which is what the reservation is for. The alternative — sending the entry
round to a side border below the strip — costs three bends (over 6.1's budget
of two) and puts the source off its own child's centre line (2.3). Worth a
sentence in DESIGN 2.6 the next time it is edited.
