# Geekchart design spec

This is the standard every chart is checked against. It was written by measuring
two references the team chose — the diagram-design gallery
(https://cathrynlavery.github.io/diagram-design/) and the Lyzr "Marketing Agentic
OS Control Plane" diagram — and then reading them as rules rather than pictures.
Do **not** copy either reference's colours, fonts or branding. Geekchart stays on
the 4geeks palette on a dark ground. What transfers is the discipline below.

Rules are numbered so a change can cite the ones it touches (see CLAUDE.md).
Numbers are in **canvas units** unless they say "on screen".

## 1. Canvas

The numbers in this file live in code as `packages/core/src/tokens.ts` (sizes,
strokes, gutters, clearances, motion timings, palettes) and `rules.ts`
(gate thresholds); the gate reads them from there, so this file, the renderer
and the check that enforces it cannot drift apart.

- **1.1** The canvas is **at most the declared display width** — a render
  option (`display`, in CSS px), default 1000 (boards 1200) when a caller
  names none — and **hugs its content**: width = content + 2×48, snapped to
  8, never below 480. Height is whatever the content needs. Charts are
  responsive, so a narrow chart padded out to its cap would only lose type
  size to the padding in a narrow viewer; hugging keeps 11-unit text at or
  near 1:1. When the natural layout is wider than the cap, the layout **packs
  to fit** — DESIGN 1.5's leaf stacking, then 1.2's chain fold — before
  anything is scaled: scaling a finished layout down to the cap is the same
  defect this option exists to remove, just moved from the embedding page's
  CSS into the SVG's own transform. A chart packing cannot bring under the
  cap is drawn at whatever width packing did reach instead, wider than asked
  (the gate's own WARN, never a FAIL — see 1.5). A server may render a chart
  for more than one display width; each variant obeys the rules at its own
  width. (Revised 2026-08-28 from a flat 1000: a chart bound for a 612px blog
  column was still laid out for 1000, and arrived at scale 0.62 — an 8px
  name.) The never-below-480 floor comes down with the cap on a narrower
  display: it exists so an undeclared-display chart never renders
  embarrassingly narrow, but holding a caller who named a 358px phone column
  to it anyway would force the exact scale-down this option exists to
  remove, only now for having asked. (Revised 2026-08-28 alongside 1.6.)
- **1.2** The content box is 904 wide (1000 − 2×48). A left-to-right run that
  does not fit it **wraps into rows** — in the reading-order ribbon shape and
  at the last possible moment, both defined by 1.9; a run that fits but uses
  under half the width is the same fault and is re-laid out. Content covers at
  least 35% of the canvas area (the gate's 7.4 check). A thin strip across an
  empty stage has failed this rule.
- **1.3** Outer margin 48. Content touches neither the edge nor the margin line.
- **1.4** Height never exceeds 1.4× width. Tall stacks (Subgraphs is 470×1095
  today) go side by side instead. Not under a declared display narrower than
  the plain 1000 default: going side by side is only better than going tall
  when the canvas has room to spare either way, and a caller who named a
  narrow column has already spent that room — 1.6's own sibling wrap turns a
  row too wide for it into a taller stack on purpose. (Revised 2026-08-28
  alongside 1.6.)
- **1.5** **Leaf stacking.** When the canvas would exceed the display width, a
  node whose children are all leaves (two or more of them) shows them as a
  vertical stack directly under it — one column, at the chart's own shared
  box width, indented 24 off the parent's own left edge, 16 apart — joined by
  a bus: one vertical trunk leaving the parent's bottom edge from a hanging
  port 12 off its left edge (the one attachment DESIGN 6.2's midpoint rule
  does not cover — earned by this pattern alone), straight down the 24-wide
  indent strip to the last leaf's centre line, then a short horizontal branch
  into each leaf's left side at its own row, one arrowhead per leaf. The
  trunk is drawn once, not once per leaf: every branch leaves it rather than
  repeating the shared run, which is what keeps a stack of leaves reading as
  one bus and not a bundle of coincidentally overlapping lines (DESIGN
  6.4/6.8's "no two edges share a segment, except a fan bus from one point").
  A fan this way costs the shared box width plus 24, not the width doubled —
  two 200-wide fans either side of a decision come to 224 + 32 + 224, not
  332 + 32 + 332. Stacking is applied to the widest fans first and stops as
  soon as the layout fits. If stacking every fan still is not enough, DESIGN
  1.2's chain fold gets a turn on top of it; past that, the chart is accepted
  as wide rather than shrunk — a gate WARN, not a FAIL. (Added 2026-08-28;
  revised the same day from a fan centred on the parent, which cost the
  parent's own half-width twice over and could not reach a 620px column.)
- **1.6** **Sibling wrapping.** When leaf stacking (1.5) and the chain fold
  (1.2) still leave the canvas wider than the display width, the siblings of
  one row wrap like text: filled left to right, the row breaks into as many
  rows as it takes, each new row 32 below the last, every row centred on the
  row's own original centre line — the common shape is two branches off one
  decision, and centring on the pre-wrap pair keeps both rows under their
  shared parent rather than under whichever one wrapping happened to compute
  first. Wrapping happens before scaling; a chart is scaled only when a
  single box plus margins cannot fit. A parent's edge into a sibling on any
  row but the first leaves the parent's bottom face at its centre, like the
  edges to its first-row siblings (6.4's shared start), drops into the gap
  below the parent, runs right to a corridor 24 past the widest row's right
  edge, down past the rows between, left along the gap above the sibling to
  its centre, and into its top face (6.2) — four bends, the loop-back's
  allowance, one arrowhead. Every edge starts on its source's outline
  (gate `6.2-departs-source`); the first version of this bus started at the
  corridor's x on the parent's bottom y, a line beginning in space.

- **1.7** **Phone height.** Full-size type on a phone column means height is
  boxes × rows, and nothing in the layout can shorten it. A chart laid out for
  a display of 480 or less that comes out taller than **twice its width** —
  about two phone screens — is reported as a WARN (`1.7-phone-height`) and
  the render's `warnings` carry the same sentence, so an editor can show the
  writer "this is N screens tall on a phone" while there is still time to
  split it. Guidance: more than about six boxes becomes a scroll; prefer two
  short charts over one long one. (Added 2026-08-28.)
- **1.8** **Rings.** A chain whose last node's only forward edge returns to
  its first is laid out as a ring, clockwise: the first half of the nodes
  left→right on the top row, the rest right→left on the bottom row, columns
  aligned; every edge is one straight run or one bend (top-right corner
  down, bottom-left corner up), labels on their own runs. A ring of 4 is a
  2×2; of 6 a 3×3 top/bottom. On a display too narrow for two columns the
  ring becomes a column with the return edge up a right corridor (the
  loop-back rules, 6.7). (Added 2026-09-01: a four-node LR cycle folded into
  reading-order rows instead — A B / C D — so C→D ran the wrong way and
  D→A doubled back through the middle; see buzz-context-loop.mmd.) A ring
  edge leaves by the face nearest its target's arrival face — the shortest
  clean path — never a farther face that happens to be free: in a 2-row ring
  of five, the odd node's closing edge exits its **left** face into the
  bottom-left corner, not its top. (Added 2026-09-03: rings of 5/7/9 sent the
  closing edge out the top while the left face sat empty and nearer,
  reading as a wrong turn — the user's own review, three charts.)
- **1.9** **Chain wrapping is a reading-order ribbon, wrapped at the last
  possible moment.** Columns = as many as the declared display fits at full
  box-plus-gutter pitch — a chain never wraps earlier than the width forces
  (the turn count is rows − 1, and every avoided row is one less snake across
  the page). Every row reads **left to right**; the return edge from a row's
  last node to the next row's first runs out the right gutter, down into the
  reserved band between the rows, along it, down the left gutter and into
  the next row's first node's left face — four bends (the same allowance
  1.6's wrap bus already earns), rounded turns, never crossing content,
  drawn the same on every chart. Rows after the first are never right-to-left: the
  boustrophedon reversal taxes the reader at every turn. On a display that
  fits only **one** column the ribbon degenerates to a vertical list — no
  returns exist, edges run straight down — which is the phone form for free.
  (Added 2026-09-03, replacing the alternating fold: a 10-step chain folded
  into 4 rows and 3 turns inside 584px of a 1000px canvas; wrapped at full
  width it is 2 rows and one turn. Chosen over the aligned serpentine and
  segmented-row candidates by team review — consistent reading direction
  plus a drawn, non-crossing return.)

## 2. Grid and sizing

- **2.1** Everything sits on an **8-unit grid**: positions, widths, heights,
  gutters.
- **2.2** Nodes come in **fixed sizes from a short list**, not fitted to their
  label: `160×48` (title only), `160×56` (title + caption), `200×48` (wide),
  `120×48` (compact). One chart uses at most two of these. Labels that don't
  fit are shortened or wrapped to a second line, never given a wider box.
  A diamond solves its own size from its label rather than sharing this list
  (2.4), which is exactly why leaf stacking, the chain fold and sibling
  wrapping (1.5, 1.2, 1.6) cannot pack a long diamond label the way they pack
  a row of nodes — none of the three reach inside a shape's own geometry. So
  under a declared display, a diamond whose one-line label alone keeps the
  canvas over the cap gets this same wrap-rather-than-widen instead of being
  left to force the whole chart's scale down. (Added 2026-08-28 alongside
  1.6: on a 358px phone column, python-or-java's own decision diamond — a
  35-character question — was the next thing over the cap once its two
  fanned branches no longer were.)
- **2.3** Nodes in the same row share an exact `y` and height; nodes in the same
  column share an exact `x` and width. Gutters between siblings are equal
  (24 or 32).
- **2.4** Diamonds are drawn around a 160×48 label box with 16 of clearance at
  the widest point. Terminals (ovals) are the same 160×48 with `rx` = half the
  height.
- **2.5** Corner radius is one value per chart: `rx 6` for nodes, `rx 12` for
  panels/clusters. Never mixed.
- **2.6** Panels (clusters, swimlanes, the Lyzr-style control plane) have 24
  inner padding on all sides and their children obey 2.3 inside them.
  Inputs above a panel and outputs below it line up **column for column**.

- **2.7** **Channels.** The floor plan reserves **corridors** (the vertical
  gaps between columns) and **bands** (the horizontal gaps between rows) as
  first-class members of the grid, before anything is placed. A route is a
  **plan over grid indices** — which corridor, which band, which face —
  and coordinates are derived from the plan last; a route is never searched
  for through finished geometry. A channel's size is **derived from what
  must live in it**: parallel runs at the 16 track pitch (6.4), each label
  pill it hosts (6.5) plus 2 clearance, the turn legs of its routes
  (standoff 4 + 2 × turn radius 12), and an arrowhead where one lands.
  Derived means derived: when traffic or labels need more room, that
  channel alone widens and the layout re-derives to a fixed point — nothing
  re-seats, nothing reorders, and an uncrowded chart is laid out exactly as
  if this rule did not exist. Band heights are uniform per chart (7.4's
  even whitespace); the uniform value is the largest any band needs.
  (Replaces the grow-8-retry-12-times loop of 2026-08-28 on 2026-09-03:
  growth-as-repair fixed the label that asked and starved the next one —
  sizing the gap from its contents up front is the same arithmetic run
  once, before routing instead of after it. Pattern proven in the
  channel-engine spike: 13/13 fan-family charts, zero overlaps, derived
  gaps of ~75 where the old pipeline spent up to 224.)
- **2.8** **Fan symmetry.** A parent sits centred on the geometric extent of
  its children as a group — measured, within **±1** — and a wrapped
  children group centres each row on the same axis; the axis holds through
  a wrap (the far row is fed by one spine down the near row's centre
  corridor, which 2.7's seating keeps free by giving the near row an even
  count). The old tell was a Dispatcher parked over its first child, or an
  Aggregator aligned to one producer of six. (Added 2026-09-03 from the
  user's review — ten charts flagged for exactly this.)

## 3. Type

Two families only: **Archivo** for names, **JetBrains Mono** for everything
technical (captions, edge labels, kickers, axis ticks). No third face, ever.

Sizes, in canvas units, on the 1000-wide canvas. The body of a chart uses at
most **three** of these (name, caption, label); the title block adds its two:

| role | size | weight | tracking | case |
|---|---|---|---|---|
| chart title | 22 | 600 | −0.02em | sentence |
| chart kicker / subtitle | 11 mono | 400 | 0.18em | UPPER |
| node name | 13 | 600 | normal | sentence |
| node caption | 11 mono | 400 | normal | as written |
| edge label, legend, axis tick | 11 mono | 400 | 0.08–0.14em | UPPER |
| record row (class member, ER column) | 11 mono | 400 | normal | as written |
| big index numeral (`01`) | 72 mono | 600 | — | — |

(Caption case revised 2026-09-03 from forced `lower`: a writer's "ships to
Production" arriving as "ships to production" read as a typo, not a style —
the renderer keeps what was written and writers own their casing.)

- **3.1** Nothing smaller than **11 canvas units**. Charts are responsive and a
  1000-unit canvas is routinely shown at ~760px (an artifact panel, a phone in
  landscape), where 11 units is 8.4px — the legibility floor. The gate measures
  on-screen size at **min(760, the declared display width)** — a chart laid
  out for a 620px column is never shown wider than that, so testing it at a
  flat 760 would check a width it will never actually be. (Raised from 8 on
  2026-08-21: the gallery's 8 was only legible because it never scaled below
  1:1. Revised 2026-08-28 for DESIGN 1.1's display option.)
- **3.2** Every node is **two-tier**: a name and a one-line caption (Lyzr:
  "CRM / pipeline", gallery: "Cloudflare / Pages · cache"). A node with no
  caption gets the 160×48 box, not a centred name in a 56-high box.
- **3.3** Captions joined with ` · ` (middle dot, spaces), never commas or
  slashes.
- **3.4** Text is never rotated, with one exception: a single vertical axis
  label on a chart with axes. If a node or commit label only fits rotated, the
  layout is wrong (see Git graph).
- **3.5** Text sits on the same baseline across a row. Baselines are set by
  cap height as in 10.2: name at `y + 24` and caption at `y + 40` in a 56-high
  box; single name at `y + 28` in a 48-high box. Rows inside a record (class
  members, ER columns) are caption-size mono on a 16 step.

## 4. Strokes, fills, depth

- **4.1** Hairlines. Node outlines 1.5, edges 1.5, cluster boxes 1, dividers
  0.8 at 50% opacity. (Raised from 1.25/1.2 on 2026-08-28: in a 612px blog
  column a 1.2 edge drew at 0.75px.) The accent path may be 1.8. Nothing above 2 except a
  deliberate thick-edge style (3.6) used once per chart at most.
- **4.2** **One depth cue per box**: either an outline or a fill, never both,
  and never a shadow. Lyzr uses solid dark tiles inside the panel and outlined
  tiles outside it — two tiers, and the difference means something
  (inside = the system, outside = what it talks to).
- **4.3** Fills are flat. No gradients, no translucent tints layered on tints.
  Fill opacity for "quiet" boxes is one value (0.12) across the chart.
- **4.4** Dividers inside a node (class/ER rows) are 0.8 hairlines at 50% and
  sit on the 8-grid.

## 5. Colour

- **5.1** The ground is dark (`--gc-bg`); ink is near-white; "quiet" is one
  grey. Those three do 90% of the work.
- **5.2** **One accent per chart**, and it is reserved for the one thing the
  reader should follow: the primary path, the focal layer, the current step.
  Gallery: "Color reserved for the happy path." If two things are accented,
  neither is.
- **5.3** A second hue (alt) is allowed only when it encodes a category the
  legend explains. Blue-vs-yellow boxes with no legend (today's Org chart) are
  noise.
- **5.4** Colour carries **motion**: the travelling dot, the flash on arrival,
  the stroke that draws on. Static colour on a static box is decoration.
- **5.5** Everything must survive the palette being swapped: no colour is
  hard-coded; every fill/stroke is a `--gc-*` variable with a fallback.
  The light palette, gated on the golden: bg `#FFFFFF`, ink `#17202A`, quiet
  `#5A6672`, edge `#9AA5B1`, surface `#EEF2F6`, path `#0075E0`, accent
  `#0096D6`. Edge stays a step quieter than ink in both (10.3).

## 6. Edges

- **6.1** Orthogonal (H/V with a single elbow) or straight. **No diagonals**
  across other nodes; a diagonal through a cylinder (today's Subgraphs) is a
  routing failure.
- **6.2** Edges attach at the **midpoint of a side**, on the outline, and leave
  it perpendicular. Never at a corner, never ending short of or inside the box.
  A side that **receives** an edge never **emits** one: arrivals own their
  face, and anything leaving the node takes a free one — a plan-time
  constraint in the channel engine, checked by the gate on channel charts
  (`6.2-side-exclusivity`). (Added 2026-09-03 from the user's review of
  git-workflow: Merge had a line out of the same side one came in.)
- **6.3** Exactly one arrowhead per directed edge, 8×6, filled, aligned to the
  last segment within 1°. A bidirectional edge is two edges or a double-headed
  one; never a stacked head. A fan-in earns its single head **by
  construction**: every arrival on one face shares one arrival point (6.8's
  merged trunk), so a second head on that face cannot be drawn, rather than
  being drawn and repaired. (Strengthened 2026-09-03; measured in the
  channel-engine spike — exactly one head per fan-in face on all 13 charts.)
- **6.4** Edges fan from **separate** attachment points, spaced on the 8-grid,
  never converging on one pixel (today's Control plane).
- **6.5** An edge label sits **on its own line**: 11 mono caps in a pill
  (height 22, rx 3, 8 side padding) the colour of the ground, masking the
  line behind it, centred — centre within 1 of the path — on the midpoint
  of its edge's **longest exclusive run**: the longest straight segment no
  other edge shares. Not the longest run outright: on a bus (1.5, 6.12,
  6.13) the longest footage is shared trunk, where pills from every branch
  would collide by construction; each branch's exclusive leg is where its
  pill belongs. Pills never overlap each other or a node; when two pills on
  one channel would touch, one slides **along its own run** — never off it —
  keeping 2 clear. A label longer than **28 characters** wraps to a second
  pill line; past two lines the render keeps the first two and WARNs
  (`6.5-label-length`) — a label that long is a sentence, and sentences
  belong in captions. (Rewritten 2026-09-03 from labels placed beside the
  line by search: the user's review flagged ~15 charts for exactly the
  inconsistency the old rule permitted — some labels on the line, some
  beside it, decided by whatever space the search happened to find.
  "Exclusive run" measured in the channel-engine spike: 13/13 charts,
  every pill centre within 0.00 of its own path, zero overlaps.)
- **6.6** Dashed = return / async / optional (`5 4`). Dotted (`1.5 6`) = the
  Lyzr style of a channel along which a dot travels. Solid = the main call.
- **6.7** Loops back go **around** the content, with a 24 clearance, as one
  rounded orthogonal path — not a free-form arc under the diagram.
- **6.8 What the gate measures on every edge of every graph chart** (added
  2026-08-22, no per-chart exceptions): orthogonal only; leaves the side facing
  its target; ≤ 2 bends forward, ≤ 4 on a loop-back; path ≤ 1.4× the straight
  distance (+32); forward edges never cross each other; no two edges share a
  segment except a fan bus from one point; 16 clearance from every node it does
  not connect; ports on one side ordered by where their targets are; a label
  sits on its line, always, per 6.5 (until 2026-09-03 this clause let a label
  sit beside the line when its plate covered too much of a short segment —
  superseded: 2.7 now sizes the run for the pill instead of the pill
  hunting for a run).
  Added 2026-08-22 (second pass): a forward edge **arrives** on the side facing
  its source with the flow axis taking priority; a loop-back arrives on the
  same side the target's forward edge arrived on ("you are back at this
  step"); no hairpins anywhere (a loop goes around once); a sole child sits on
  its sole parent's centre line; a Z edge's middle run is centred in the free
  channel between the nearest walls, panels included. A loop-back takes the
  nearest corridor (length ≤ Manhattan distance of its ends + 128), and edges
  arriving on one side of a node merge into a single centred trunk with one
  arrowhead.
- **6.9** **Label space is an input, not a search result.** Every edge label
  in the source is drawn exactly once, on its own edge (6.5), overlapping
  nothing — and this holds because the channel hosting the pill was sized
  for it before routing (2.7), never because a search found a gap. A pill
  keeps 8 clear of every box it does not belong to and 16 from every other
  edge's segments — as measured *consequences* of 2.7's derivation, checked
  by the gate, not as placement targets. (Rewritten 2026-09-03, absorbing
  6.10 and 6.11 of 2026-08-28: all three rules described one search — find
  a clear spot, grow if there is none, prove the spot found belongs to the
  right edge. With the space derived up front the search has nothing left
  to decide; the numbers stay as the wall.)

- **6.10** Absorbed into 6.9 (2026-09-03). The number stays reserved so
  older commits and gate lines still cite it truthfully.

- **6.11** Absorbed into 6.9 (2026-09-03), as 6.10.

- **6.12** A node with **three or more** forward edges whose targets all land
  on one shared row directly below it draws as a bus: the trunk leaves the
  parent's own bottom centre (6.4's fan-from-one-point — every branch shares
  it, so this earns no exception 6.2 doesn't already allow) straight down to
  the row's own true mid-line, then one bend into each child's own top face
  at its centre. This is 1.5's leaf-stack trunk's row-shaped cousin: the row
  itself is already fine (nothing here restacks it into a column), but each
  child's edge, routed independently by the ordinary search, wants the
  identical wall-bounded centre line — the same gap between the parent's row
  and the children's — so 6.4's mandatory 16-apart clearance forces every one
  of three or more of them off it, which no per-edge search can avoid.
  (Added 2026-09-01: buzz-one-log.mmd's LOG, fanning to four same-row leaves,
  had two of its four Z edges pulled 8 off true centre apiece to keep them
  16 apart — passing 6.4 only by failing 6.1.)

- **6.13** DESIGN 1.6's own sibling-wrap bus, mirrored: a forward source
  whose straight-ish path to its target would run through a sibling that
  display-width wrapping placed in an earlier row draws as a bus too — drop
  from the source's own bottom face into its row's own gap, into a shared
  corridor clear of every wrapped row, down, and into the target's top face
  at its centre — merging every such source into one trunk with the single
  arrowhead DESIGN 6.3 already asks for at a fan-in. (Added 2026-09-01:
  buzz-one-log.mmd's four sources into LOG, wrapped 2×2 at a 612px display —
  two of the four cut straight through the other wrapped row on the way
  down, 6.1's own "16 clearance from a foreign node.")

## 7. Composition

- **7.1** Every chart has a title (3: 22/600) and usually a kicker line in mono
  caps above or below it. The Lyzr panel's "LYZR AI · SKOTT · MODEL AGNOSTIC"
  line is the pattern: a tracked, dotted list of facts.
- **7.2** A **legend row** at the bottom when shape or colour means something:
  small swatches, 8 mono labels, one row, left-aligned.
- **7.3** Layout is symmetric about the canvas centre unless the content has a
  direction (timeline, layers). Inputs/outputs on either side of a panel are
  centred on it.
- **7.4** Whitespace is even. If the right half of the stage is empty, wrap,
  re-centre, or change the canvas height — never leave it.
- **7.5** Nothing is clipped at the canvas edge, including the last milestone
  diamond and the last quadrant label. Measured, not eyeballed.
- **7.6** Every chart type — including pie, mindmap, git graph — is drawn by
  Geekchart's own renderer with these rules. Raw mermaid output is never shown
  next to native charts.

## 8. Motion (from the Manim bar)

- **8.1** Easing is `cubic-bezier(0.61, 0, 0.39, 1)` everywhere. No ease-out.
- **8.2** Stroke draws on, then fill fades in (DrawBorderThenFill). A plain
  opacity fade on a node is wrong.
- **8.3** Elements overlap in time (`lag_ratio` 0.1–0.5) rather than queue.
- **8.4** After build, one pass of the accent travelling the primary path with
  an Indicate on each node; then the chart **holds its finished state**.
  Nothing restarts. Playback starts when the chart enters the viewport (40%
  visible), once. (Revised 2026-08-28 from a looping `wait()` beat: charts no
  longer loop, matching how every product site plays a build-out animation
  once on scroll-into-view.)
- **8.5** Activation bars, plates and sparks sit **below** arrowheads in stacking
  order; a head is never covered.
- **8.6** Speed. A chart may be slowed or hurried by one multiplier, 0.25–4,
  default 1, applied to every duration and delay alike; nothing else about
  the motion changes. The svg carries `data-gc-speed` when it is not 1. Gate:
  `8.6-speed` — every animation-duration and animation-delay in the
  stylesheet equals the design value × the multiplier (±1 ms), and the
  multiplier is inside the range. (Added 2026-08-28.) `duration` (seconds) is
  the writer-facing form: name how long the build should take and the
  multiplier is derived from that chart's own natural cycle, honouring the
  same 0.25–4 clamp; `duration` wins if both are given. (Added 2026-08-28.)
- **8.7** Emitted CSS is valid: no `NaN`, `undefined` or `Infinity` anywhere in
  a chart's stylesheet. Gate: `8.7-valid-css` — a string scan of the chart's
  own `<style>` block. A browser drops an invalid keyframe silently rather
  than erroring, so this class of bug never shows up as a broken render, only
  as an element that pops in instead of drawing on. (Added 2026-09-02: a
  ring's build-order walk (`motion.ts`) is Kahn's algorithm over forward
  indegree, which needs at least one node at zero to start from — a cycle
  gives every node exactly one, so nothing entered the queue and every ring
  edge's own timing stayed undefined; a channel edge into or out of a panel
  had the same gap, since a panel is not one of the walk's own nodes either.)

## 9. Don'ts (the amateur tells)

- Boxes of different widths in one row because the labels differ.
- Type that changes size between charts because the canvas changed size.
- Diagonal edges, converging fans, stacked arrowheads, arcs under the diagram.
- Rotated labels, clipped labels, labels escaping their box.
- Outline + fill + shadow on one box.
- Two accent colours with no legend.
- A chart that is a thin strip in a large empty stage.
- Raw mermaid output (default theme, white boxes, fat coloured curves).
- Dark-on-dark text (today's Pie title and legend).
- Light-theme page with a dark stage because one variable wasn't redefined.

## 10. Elegance — the part hygiene doesn't buy

Rules 1–9 remove what makes a chart look amateur. These make it look finished.

- **10.1 One loud element.** Each chart has exactly one thing at full weight —
  the title, or the focal tile — and everything else is a step quieter. If two
  elements compete for the eye, demote one. Measured: at most one text run at
  the largest size, and no outline brighter than the text it frames.
- **10.2 Air inside boxes.** Text occupies about a third of the box height. In
  the 56-high box: name baseline at `y + 24`, caption baseline at `y + 40`,
  nothing within 16 of the left or right edge. In the 48-high box the single
  name sits at `y + 28`. A box whose text touches its padding is too small or
  its label too long — shorten the label.
- **10.3 Optical centring.** Centre text by cap height, not by the em box
  (Archivo cap height ≈ 0.72em; for a 12px name that is the `+24` above, not
  `+28`). Arrowheads stop **on** the outline; the line under them ends 6 short
  so the head reads as meeting the box, not piercing it. Outline strokes are
  one step quieter than the text inside them (`--gc-edge`, not `--gc-ink`).
- **10.4 Motion is one wave, and everything it touches reacts.** After the
  build-in, the live phase is a single wave: sibling dots leave with a 0.15s
  lag and travel in ~0.7s, so they read as one event, not a queue. Nothing
  appears or vanishes flatly — a dot scales in from 1.5 to 3, the box it
  leaves flashes to the accent as it departs, the channel brightens while the
  dot is on it, and on arrival the dot is absorbed (r 3→1) into a ripple (r 3→14)
  on the outline while the shape it reaches **presses**: scale 1→1.03→1 over
  0.6s with a settling ease (`cubic-bezier(.22,1.2,.36,1)`), outline to the
  accent, caption brightened to ink for the beat, arrowhead taking the colour. A container acknowledges the
  wave once, as the last dot lands. Then a still beat of ≥ 2s, because the still
  frame is what most people see. Nothing hidden at rest may use fill-mode
  `both` with a visible first keyframe — it will show during its delay.
- **10.5 Subtract first.** Before styling an element, ask whether removing it
  loses information. A hairline divider instead of a box; a dot terminus
  instead of an arrowhead on a quiet edge; a knockout plate instead of a label
  background; no cluster box when alignment already groups the children. The
  references are elegant because of what is not drawn.
- **10.6 The golden.** `fixtures/golden/control-plane.svg` is one chart drawn
  by hand to every rule in this file, in the 4geeks palette. It is the picture
  of "done". A renderer change to panels is finished when `pnpm gate` passes
  **and** the rendered control plane is indistinguishable from the golden at
  review size. Never edit the golden to match the renderer.

## How to use this file

Before changing any drawing or layout code, list which rule numbers the change
touches and what the measured value will be after. After the change, run
`pnpm gate` (see `packages/cli/scripts/gate.mjs`) and paste the numbers. The
gate checks what it can check; the rest is reviewed against the screenshot.

## How the gate measures

`packages/cli/src/measure/` is the executable form of the rules above — one
check per rule id, one file per section (`canvas.ts`, `grid.ts`, `type.ts`,
`edges.ts`, `labels.ts`, `charts.ts`). It is bundled to `dist/measure.js` the
same way the renderer itself is bundled to `dist/renderer.js`, and both
`packages/cli/scripts/gate.mjs` and the test suite inject that same bundle and
call it — a rule's arithmetic is defined once, not once per caller. Reading a
rule's real threshold means reading its check, not this prose.
