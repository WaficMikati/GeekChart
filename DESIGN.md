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
  does not fit it **wraps into rows**; a run that fits but uses under half the
  width is the same fault and is re-laid out. Content covers at least 35% of
  the canvas area (the gate's 7.4 check). A thin strip across an empty stage has
  failed this rule.
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
  D→A doubled back through the middle; see buzz-context-loop.mmd.)

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

- **2.7** Room for a label is the smallest that works. When no spot on a
  label's own edge clears 6.5/6.9/6.11, the corridor that edge runs through
  grows by **one grid step (8) at a time**, re-routes and tries again — along
  an axis the edge actually runs on (a column gap for a horizontal run, a row
  gap for a vertical one), the one adding less area first, and never past the
  declared display width (1.1). An edge still unseated after 12 steps on an
  axis stops asking; its label takes the best spot and the gate reports it.
  Growth moves whole row bands (a node is past the corridor when its centre
  is). Row gaps differ for other reasons too (panels, folds, satellites), so
  this is pinned by test rather than gate: packages/cli/test/canvas.test.mts
  holds the article chart at display 620 to its minimal height. (Added
  2026-08-28: a formula-sized growth gave that chart 80 units for a label
  that needed 32.)

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
| node caption | 11 mono | 400 | normal | lower |
| edge label, legend, axis tick | 11 mono | 400 | 0.08–0.14em | UPPER |
| record row (class member, ER column) | 11 mono | 400 | normal | as written |
| big index numeral (`01`) | 72 mono | 600 | — | — |

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
- **6.3** Exactly one arrowhead per directed edge, 8×6, filled, aligned to the
  last segment within 1°. A bidirectional edge is two edges or a double-headed
  one; never a stacked head.
- **6.4** Edges fan from **separate** attachment points, spaced on the 8-grid,
  never converging on one pixel (today's Control plane).
- **6.5** Edge labels are 8 mono caps on a knockout plate the colour of the
  ground, 6 padding, centred on the segment's midpoint, and plates never overlap
  each other or a node.
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
  sits on its line only if its plate covers ≤ 60% of a horizontal segment or
  ≤ 40% of a vertical one at least 64 long — otherwise it sits beside the line.
  Added 2026-08-22 (second pass): a forward edge **arrives** on the side facing
  its source with the flow axis taking priority; a loop-back arrives on the
  same side the target's forward edge arrived on ("you are back at this
  step"); no hairpins anywhere (a loop goes around once); a sole child sits on
  its sole parent's centre line; a Z edge's middle run is centred in the free
  channel between the nearest walls, panels included. A loop-back takes the
  nearest corridor (length ≤ Manhattan distance of its ends + 128), and edges
  arriving on one side of a node merge into a single centred trunk with one
  arrowhead.
- **6.9** An edge label never overlaps a node box; it keeps **8 units clear**
  of every box it does not belong to. (Added 2026-08-28: DESIGN 1.5's own
  labels exposed a placement the gate had never measured — a wide label
  beside a short run can still, technically, avoid its own edge's two nodes
  while landing on someone else's.)

- **6.10** Every edge label in the source is drawn exactly once. When no
  position clears 6.9, the layout makes room — the edge's corridor grows by
  the label's height + 8 — rather than the label disappearing. (Added
  2026-08-28: enforcing 6.9 without this let a label with nowhere clear to
  sit be dropped instead, which is worse than a crowded one — a missing
  label reads as the edge having none, not as a placement failure.)

- **6.11** A label sits on its own edge: its box comes within **8** of some
  point of its own path — one gap, the same 8 a label beside its line has
  always kept clear of the line itself (6.5) — and stays at least **16**
  from every other edge's segments. (Added 2026-08-28: 6.10's own growing
  corridor only means something if the label that needed the room lands
  back on the edge it belongs to — the first attempt at 6.10 let it drift
  onto whatever nearby edge had space instead. Revised the same day from 4:
  a label legitimately sitting *beside* its line, not on it, is still on
  its own edge.)

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
