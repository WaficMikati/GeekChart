# The 3c census — what still runs on the old path

Measured 2026-09-04 on `rewrite/channel-engine` at commit
`DESIGN 2.8: a shallow sibling counts toward its parent's centre`, over all 53
gallery fixtures at three display settings: none declared (the default 1180
render), `--display=620`, and `--display=358`.

Nothing here changes code. It is the inventory 3c needs before it deletes the
router, the label search and the corridor-growth loop.

## How it was measured

`renderNode()` once per fixture per display, with `console.warn` captured
around each call so `GC_GRID_DEBUG=1`'s decline lines
(`packages/core/src/layout/grid.ts:75`, `packages/core/src/layout/panelgrid.ts:83`)
attribute to the chart that produced them. Engine is read off the emitted SVG:
`data-gc-engine="channels"`, stamped at `packages/core/src/draw.ts:1099`.

**Attribution is the final render, never the log.** The engine column is read
off `data-gc-engine` in the SVG that actually came back, and the whole sweep
was then repeated through a second entry point — `renderToSvg`
(`packages/geekchart/src/server.ts:390`) instead of `renderNode` — and the two
runs compared: 159 fixture×display pairs, zero disagreements.

For the reachability half, `draw.ts` and `layout/index.ts` were temporarily
instrumented with one `console.warn` at each call site of interest and the
sweep re-run; the instrumentation was reverted afterwards and is not in the
tree. Those counts are attempt-free by construction and by check.
`layout/index.ts:348` returns as soon as the channel engine succeeds, so
`fold()` and everything downstream of it is only ever reached after the engine
has given up for good; and cross-checking every probe hit against the corrected
engine column finds no chart whose final render is on channels entering any old
module, at any display.

Two things to read carefully:

- **"old" is not always "declined."** 25 of the 53 fixtures are not flowcharts
  at all (sequence, state, class, ER, timeline, gantt, journey, xy, radar,
  quadrant, sankey, treemap, kanban, pie, mindmap, gitgraph). They never reach
  the channel dispatch at `packages/core/src/layout/index.ts:348`, so they log
  no decline. `buzz-context-loop` and `buzz-context-loop-6` are flowcharts but
  rings — `layout/ring.ts` (DESIGN 1.8) places them, also never the channel
  engine.
- **A decline line on a chart the engine did draw** is an abandoned attempt
  inside the engine's own search (`grid.ts:982` `attempt`, retried with
  different flip/same-row/wrap settings), not a fallback. Only a chart with no
  `data-gc-engine` actually fell through to the old path.

## Totals

| display | on the channel engine | on the old path | of which are flowcharts the engine turned down |
|---|---|---|---|
| default (1180) | 19 | 34 | 7 |
| 620 | 18 | 35 | 8 |
| 358 | 13 | 40 | 13 |

On the channel engine at each display:

- **default (19):** python-or-java, python-or-java-short, buzz-one-log,
  subgraphs, two-diamonds, diamond-cascade, ternary-tree, git-workflow,
  login-flow, back-to-start, hub-with-returns, subgraph-pair,
  labeled-cross-panel, three-subgraphs, nested-subgraph, nested-depth-3,
  architecture, org-chart, messy
- **620 (18):** incident-response, python-or-java-short, prompt-anatomy,
  platform-layers, pyenv-resolution, two-diamonds, diamond-cascade,
  ternary-tree, git-workflow, login-flow, hub-with-returns, subgraph-pair,
  labeled-cross-panel, nested-subgraph, nested-depth-3, architecture,
  org-chart, messy
- **358 (13):** incident-response, prompt-anatomy, two-diamonds,
  diamond-cascade, ternary-tree, git-workflow, login-flow, subgraph-pair,
  labeled-cross-panel, three-subgraphs, nested-subgraph, org-chart, messy

Twenty distinct fixtures reach the old path at one display or another and are
flowcharts or flowchart-like (state/class/ER share the flow pipeline). Which
displays matters — most of them are on the engine at the other two, and reading
this list as "always old" is the mistake to avoid:

- **old at all three:** flow, 4geeks-journey, control-plane, and the four
  non-flowchart families that still draw through `draw.ts` (regex-engine,
  state, class, er)
- **old at the default display only:** incident-response, prompt-anatomy
- **old at default and 358, on the engine at 620:** platform-layers,
  pyenv-resolution
- **old at 620 and 358, on the engine at default:** python-or-java,
  buzz-one-log, subgraphs, back-to-start
- **old at 620 only:** three-subgraphs
- **old at 358 only:** python-or-java-short, hub-with-returns, nested-depth-3,
  architecture

Plus buzz-context-loop and buzz-context-loop-6 at all three, by design — they
are rings.

## Per fixture

Decline reasons are de-duplicated (the planner logs the same line twice for the
same configuration) and shown in the order they were logged. `[panels]` marks a
decline from `layout/panelgrid.ts`; everything else is `layout/grid.ts`.

| fixture | type | default | default decline(s) | 620 | 620 decline(s) | 358 | 358 decline(s) |
|---|---|---|---|---|---|---|---|
| incident-response | flowchart | old | too tall (928 > 1.4×480; w=261 band=48 rows=72/72/112/72/72/72/72) | channels | — | channels | — |
| first-ai-app | sequenceDiagram | old | — | old | — | old | — |
| rigobot-loop | sequenceDiagram | old | — | old | — | old | — |
| python-or-java | flowchart | channels | — | old | declared display: 1.5 alone fits, the old path packs it | old | pill L_Q1_JAVA_0 overlaps PYWEB / too wide (460 > 262; x 0..460; nodes START@8 Q1@0 PY@8 PYWEB@8 PYDATA@8 JAVA@8 JAVAENT@8 JAVAAND@8) / wrapping could not reach the display (984 > 262) |
| python-or-java-short | flowchart | channels | — | channels | wrapping could not reach the display (864 > 524) | old | wrapping could not reach the display (792 > 262) / wrapping could not reach the display (424 > 262) |
| regex-engine | stateDiagram-v2 | old | — | old | — | old | — |
| buzz-context-loop | flowchart | old | — | old | — | old | — |
| buzz-context-loop-6 | flowchart | old | — | old | — | old | — |
| buzz-one-log | flowchart | channels | — | old | wrapping could not reach the display (872 > 524) | old | wrapping could not reach the display (872 > 262) |
| prompt-anatomy | flowchart + subgraph | old | [panels] decline: too wide (1144 > 904) | channels | — | channels | — |
| platform-layers | flowchart + subgraph | old | [panels] decline: too wide (1723 > 904) | channels | — | old | [panels] decline: too wide (371 > 262) |
| pyenv-resolution | flowchart + subgraph | old | [panels] decline: too wide (1346 > 904) | channels | — | old | [panels] decline: too wide (398 > 262) |
| geekforce-timeline | timeline | old | — | old | — | old | — |
| learn-js-plan | gantt | old | — | old | — | old | — |
| outcomes-2024 | xychart-beta | old | — | old | — | old | — |
| bootcamp-worth-it | quadrantChart | old | — | old | — | old | — |
| flow | flowchart | old | too wide (1296 > 904; x 0..1296; nodes A@0 B@224 C@464 D@464 E@688 F@912 G@1136) | old | too wide (1296 > 524; x 0..1296; nodes A@0 B@224 C@464 D@464 E@688 F@912 G@1136) | old | too wide (1296 > 262; x 0..1296; nodes A@0 B@224 C@464 D@464 E@688 F@912 G@1136) |
| subgraphs | flowchart | channels | [panels] decline: C is 76 off B's centre line | old | [panels] decline: edge L_C_E_0 hugs D | old | [panels] decline: edge L_C_E_0 hugs D |
| 4geeks-journey | flowchart | old | too wide (1632 > 904; x 0..1632; nodes A@0 B@224 C@512 D@512 E@736 F@960 G@1184 H@1472 I@1472) | old | too wide (1632 > 524; x 0..1632; nodes A@0 B@224 C@512 D@512 E@736 F@960 G@1184 H@1472 I@1472) | old | loop L_D_B_0 over budget (2056 > 1816+128) / loop L_D_B_0 over budget (2232 > 2080+128) / wrapping could not reach the display (363 > 262) |
| state | stateDiagram-v2 | old | — | old | — | old | — |
| class | classDiagram | old | — | old | — | old | — |
| er | erDiagram | old | — | old | — | old | — |
| sequence | sequenceDiagram | old | — | old | — | old | — |
| sequence-rich | sequenceDiagram | old | — | old | — | old | — |
| two-diamonds | flowchart | channels | — | channels | wrapping could not reach the display (552 > 524) | channels | wrapping could not reach the display (552 > 262) |
| diamond-cascade | flowchart | channels | — | channels | wrapping could not reach the display (568 > 524) / too wide (612 > 524; x 0..612; nodes S@222 Q1@214 Q2@214 E1@222 Q3@104 E2@443 OK@0 E3@224) | channels | wrapping could not reach the display (568 > 262) |
| ternary-tree | flowchart | channels | — | channels | too wide (528 > 524; x 0..528; nodes ROOT@176 R0@0 R1@176 R2@352 R3@176 L00@32 L01@32 L02@32 L10@208 L11@208 L12@208 L20@384 L21@384 L22@384 L30@208 L31@208 L32@208) | channels | — |
| git-workflow | flowchart | channels | — | channels | — | channels | — |
| login-flow | flowchart | channels | — | channels | — | channels | wrapping could not reach the display (424 > 262) |
| back-to-start | flowchart | channels | — | old | too wide (888 > 524; x 0..888; nodes A@0 B@192 C@384 D@576 E@768) | old | too wide (888 > 262; x 0..888; nodes A@0 B@192 C@384 D@576 E@768) |
| hub-with-returns | flowchart | channels | — | channels | — | old | L_HUB_W2_0/L_W1_HUB_0 share a v-run / wrapping could not reach the display (408 > 262) |
| subgraph-pair | flowchart + subgraph | channels | — | channels | — | channels | — |
| labeled-cross-panel | flowchart + subgraph | channels | — | channels | — | channels | — |
| three-subgraphs | flowchart + subgraph | channels | — | old | [panels] decline: a wrap of 2 panels a row needs 1.9's return, which this planner has not | channels | — |
| nested-subgraph | flowchart + subgraph | channels | — | channels | — | channels | — |
| nested-depth-3 | flowchart + subgraph | channels | [panels] decline: A is 76 off C's centre line / [panels] decline: A is 28 off C's centre line | channels | — | old | [panels] decline: too wide (264 > 262) |
| control-plane | flowchart + subgraph | old | [panels] decline: 4 edges on OS's top face against 6 columns inside | old | [panels] decline: 4 edges on OS's top face against 6 columns inside | old | [panels] decline: 4 edges on OS's top face against 6 columns inside |
| architecture | flowchart + subgraph | channels | — | channels | — | old | [panels] decline: too wide (407 > 262) |
| org-chart | flowchart | channels | — | channels | — | channels | — |
| timeline | timeline | old | — | old | — | old | — |
| gantt | gantt | old | — | old | — | old | — |
| gantt-states | gantt | old | — | old | — | old | — |
| journey | journey | old | — | old | — | old | — |
| xy | xychart-beta | old | — | old | — | old | — |
| radar | radar-beta | old | — | old | — | old | — |
| quadrant | quadrantChart | old | — | old | — | old | — |
| sankey | sankey-beta | old | — | old | — | old | — |
| treemap | treemap-beta | old | — | old | — | old | — |
| kanban | kanban | old | — | old | — | old | — |
| pie | pie | old | — | old | — | old | — |
| mindmap | mindmap | old | — | old | — | old | — |
| gitgraph | gitGraph | old | — | old | — | old | — |
| messy | flowchart (repaired paste) | channels | — | channels | wrapping could not reach the display (552 > 524) | channels | wrapping could not reach the display (552 > 262) |

## What of the old machinery is still reachable

Measured by instrumenting each call site and re-running the sweep, so these are
the charts that actually enter the code, not the charts that could.

### The orthogonal router — `packages/core/src/route/plan.ts` `planRoutes` (1289 lines in `plan.ts`, plus `cost.ts` 236)

Called once from `packages/core/src/draw.ts:369`, on
`routed.filter((e) => !e.bus && !e.ring && !e.channel)`. Every edge a channel
chart draws carries `edge.channel`, so on those charts the call is made with an
empty list and does nothing. Charts that hand it real edges:

| display | count | fixtures |
|---|---|---|
| default | 11 | 4geeks-journey, class, control-plane, er, flow, incident-response, platform-layers, prompt-anatomy, pyenv-resolution, regex-engine, state |
| 620 | 12 | 4geeks-journey, back-to-start, buzz-one-log, class, control-plane, er, flow, python-or-java, regex-engine, state, subgraphs, three-subgraphs |
| 358 | 17 | 4geeks-journey, architecture, back-to-start, buzz-one-log, class, control-plane, er, flow, hub-with-returns, nested-depth-3, platform-layers, pyenv-resolution, python-or-java, python-or-java-short, regex-engine, state, subgraphs |

No chart mixes the two: at every display each chart's edges are either all
`gc-channel` or none of them are.

The rest of `route/` is **not** the router and is not going anywhere:
`elbows.ts`'s `arrowHead` draws every arrowhead in the product
(`packages/core/src/tips.ts:2`), and `plan.ts`'s other export `routeEdges` is
the raw-mermaid stopgap's port router, called from
`packages/core/src/normalize.ts:568` for chart families that still keep
mermaid's own geometry.

### The label search — `packages/core/src/draw.ts:1606` `placeLabels` (376 lines, plus `trimCoincidentRuns` at :1474, 132 lines)

Called unconditionally at `draw.ts:1085`, but with `pendingLabels` — and a
channel chart's labels never join that list: they are emitted straight from the
seated pill at `draw.ts:942` (the `edge.channel` branch) and the loop `continue`s. Charts that give it a
non-empty request list:

| display | count | fixtures |
|---|---|---|
| default | 8 | 4geeks-journey, buzz-context-loop, buzz-context-loop-6, er, flow, incident-response, regex-engine, state |
| 620 | 9 | 4geeks-journey, back-to-start, buzz-context-loop, buzz-context-loop-6, er, flow, python-or-java, regex-engine, state |
| 358 | 10 | 4geeks-journey, back-to-start, buzz-context-loop, buzz-context-loop-6, er, flow, python-or-java, python-or-java-short, regex-engine, state |

Note `buzz-context-loop` and `buzz-context-loop-6`: rings route their own edges
(`draw.ts:389` draws them straight from `layout/ring.ts`'s grid, outside
`planRoutes`) but still hand their labels to the search. **The label search
outlives the router.**

### The corridor-growth loop — `GrowthAllowed` at `draw.ts:276`, `NeedsCorridorGrowth` at :257, the retry loop in `draw()` at :1146 (~80 lines together)

Only fires when `placeLabels` throws, so it is a strict subset of the above.
Charts where a growth actually happened:

| display | count | fixtures |
|---|---|---|
| default | 5 | 4geeks-journey, buzz-context-loop, buzz-context-loop-6, er, state |
| 620 | 6 | 4geeks-journey, buzz-context-loop, buzz-context-loop-6, er, python-or-java, state |
| 358 | 4 | buzz-context-loop-6, python-or-java, python-or-java-short, state |

### `packToDisplay`'s old moves — `packages/core/src/layout/index.ts`

Three separate mechanisms, and they behave very differently:

- **The stacked-fan / fold search** (`index.ts:732`, the `packToDisplay && first.width > room` block, ~110 lines): never runs at the default display — by construction, `packToDisplay` is only set when a caller names one. 9 fixtures at 620, 14 at 358.
- **`wrapOnTop`** (`index.ts:687`, the 1.6 sibling wrap over ELK's result, ~50 lines): 0 at default, 3 at 620 (buzz-one-log, control-plane, flow), 14 at 358.
- **The declared-display diamond title wrap** (`index.ts:246`, ~40 lines): 0 at default, 0 at 620, 2 at 358 (python-or-java, python-or-java-short).
- **`fold()` itself** (`layout/fold.ts`, 595 lines, plus `layout/elk.ts`, `satellites.ts`, `wrap.ts`, `align.ts`, `panels.ts`) runs for every old-path flowchart at every display: 11 at default, 11 at 620, 17 at 358. It is the old path's layout engine, not a `packToDisplay` extra.

## Assessment: what 3c can delete today

**Today, with zero behaviour change: nothing in this list.** Every one of the
four bodies of machinery is entered by a real fixture at the default display —
the router by 11 charts, the label search by 8, the growth loop by 5, and
`fold()` by 11. There is no dead subset to lift out ahead of the migrations.

The one thing that is *nearly* free is the `packToDisplay` block at
`index.ts:246` (the declared-display diamond title wrap, ~40 lines): it fires
for exactly two charts, both at 358, both of which the channel engine already
declines for other reasons. It is not free — deleting it changes
python-or-java and python-or-java-short at 358 — but it is the smallest
blast radius on the list, and it goes away with the same migration that takes
those two charts.

### What has to land first, and what it releases

| blocker | fixtures it holds | what it releases when done |
|---|---|---|
| control-plane's column-count question (`[panels] decline: 4 edges on OS's top face against 6 columns inside`) | control-plane, at all three displays | the last panel chart on the old path at the default display |
| width declines in the panel planner (`[panels] decline: too wide`) | platform-layers, pyenv-resolution, prompt-anatomy at default; platform-layers, pyenv-resolution, architecture, nested-depth-3 at 358 | 3 charts at default, 4 at 358 |
| LR cross-panel returns / `subgraphs`' `edge L_C_E_0 hugs D` | subgraphs at 620 and 358 | 1 chart at two displays |
| the 2+-panel-row wrap (`a wrap of 2 panels a row needs 1.9's return, which this planner has not`) | three-subgraphs at 620 | 1 chart at one display |
| a plain-grid `too wide` decline | **at every display:** flow, 4geeks-journey. **at 620 and 358 only:** back-to-start, buzz-one-log, python-or-java (620 declines with "declared display: 1.5 alone fits, the old path packs it"), and python-or-java-short at 358 alone | 2 charts at the default display, 6 under a declared one — and the only users of the growth loop besides the rings |
| the ring family (`layout/ring.ts`, DESIGN 1.8, deliberately not the channel engine) | buzz-context-loop, buzz-context-loop-6 | the label search and the growth loop — **these two charts alone keep both alive**, since rings bypass `planRoutes` but not `placeLabels` |
| the non-flowchart families that still draw through `draw.ts` (state, class, ER) | regex-engine, state, class, er | the last non-panel users of the router and the label search |

The order that actually shortens the file:

1. **The router (`plan.ts` + `cost.ts`, 1525 lines)** goes when the panel
   blockers, the too-wide flowcharts, *and* state/class/ER are all on the
   engine. State and class/ER are the surprise on that list — they are not
   flowcharts and were never in the 3c plan, but they share `draw.ts` and hand
   it un-channelled edges.
2. **The label search and the growth loop (~590 lines)** go strictly after the
   router, because rings keep them alive after the router is gone. Either
   `layout/ring.ts` must seat its own pills the way `grid.ts` does, or ring
   charts have to move onto the channel engine.
3. **`fold.ts` + `elk.ts` + `satellites.ts` + `align.ts` + `panels.ts`
   (1557 lines; `wrap.ts`'s 219 stay, `graph.ts` and `draw.ts` both use it)**
   and the `packToDisplay` blocks in `layout/index.ts` go last: they are the old path's whole layout stage and
   nothing can be trimmed off them while any chart still falls through.

Net: **~3900 lines are on the table across `route/`, `draw.ts`'s label half and
`layout/`'s old stage — and zero of them can come out this week.**
