# Implementation plan — bring the whole library to DESIGN.md

Goal: every chart in `pnpm gallery` passes `pnpm gate`, and the panel family is
indistinguishable from `fixtures/golden/control-plane.svg` at review size.
Work is ordered so the shared foundations land first; they fix most of the 22
current failures on their own, and every later pass builds on them.

Each pass has: the files it owns, the DESIGN rules it implements, and the gate
line that proves it done. A pass is done when its gate line reads as written
and its tests are in. Do not start a later pass while an earlier one FAILs on
the charts it owns.

Conventions for whoever implements a pass (human or agent):

- Before code: list the rule numbers and the measured before → after values.
- Change the renderer, not CSS over mermaid geometry.
- `pnpm gallery && pnpm gate <charts>` after; paste the lines.
- One Playwright assertion per defect fixed, in `packages/cli/test/`.
- Report: gate lines + files touched + anything the rules didn't cover. Nothing
  else.

---

## Phase 0 — Gate in the loop

Owner files: `package.json`, `packages/cli/test/gate.test.mts` (new).

- `pnpm test` runs the gate on `gallery.html` and fails on any FAIL line. Start
  with an allowlist of the 22 known failures so the suite is green today; every
  pass below removes its charts from the allowlist. The allowlist shrinking is
  the progress bar.
- Gate gains `--json` for machine reading.

Done when: `pnpm test` green with the allowlist; the allowlist file lists
exactly the charts failing today.

## Phase 1 — Canvas and scale `[1.1 1.2 1.3 1.4 3 3.1 10.2 10.3]`

Owner files: `packages/core/src/scene.ts`, `layout.ts`, `normalize.ts`,
`styles.ts`, `draw.ts`.

- Every renderer lays out on a **1000-wide canvas** (boards may use up to
  1200). Outer margin 48. Scene carries `canvas: {width, margin}`; nothing else
  invents a width.
- Type sizes come from one table in `scene.ts` matching DESIGN §3 (title 22,
  name 12/600, caption 8.5 mono, label 8 mono caps, kicker 9 mono). Nothing in
  a family file sets a font size.
- Text baselines by cap height: name at box-middle − 4, caption at +12 for the
  56 box (the golden's +24/+40 on a 56 box).
- Left-to-right graphs with more than 6 nodes on the longest path **wrap** into
  rows (layout.ts: ELK layered with a row break, or a second pass that folds
  the longest path). Top-to-bottom stacks taller than 1.4× width go side by side.

Done when: every chart reports `1000×H` (boards ≤ 1200) with H ≤ 1.4×W, no
3.1 failures, and Flowchart / Learner journey / ER / Org / Timeline / Kanban are
no longer strips.

## Phase 2 — Boxes, edges, panels `[2.1–2.6 4.1–4.4 6.1–6.7]`

Owner files: `normalize.ts`, `route.ts`, `tips.ts`, `geometry.ts`, `scene.ts`.

- Fixed box sizes from DESIGN 2.2; at most two per chart; labels shorten or
  wrap (2 lines max) instead of widening. Diamonds and terminals from 2.4.
- Rows share y, columns share x, gutters equal. Everything on the 8-grid.
- Edges orthogonal or straight; attach at side midpoints; line ends 6 short of
  the outline, one 8×6 head on it; fan from separate points; loop-backs route
  around as one rounded orthogonal path. Edge labels on knockout plates, never
  overlapping.
- Panels: 24 padding, `rx 12`, children on the panel's own grid; inputs above
  and outputs below align column-for-column.
- Strokes per 4.1; one depth cue per box; flat fills; one fill opacity.

Done when: gate shows no 2.x / 6.x FAIL or WARN on the graph family, and
`control-plane` passes **golden parity** (Phase 4).

## Phase 3 — Motion vocabulary `[8.1–8.5 10.4]`

Owner files: `motion.ts`, `animate.ts`, `styles.ts`.

Replace the per-element scale-on-arrival with the golden's vocabulary, as
named primitives every family calls:

- `draw(el, at)` — stroke draws on (pathLength 1), fill follows .3s later.
- `grow(edge, at)` — channels scale from their origin so dash patterns survive.
- `wave(edges, at, lag = .15, travel = .7)` — dots leave with lag; each dot
  scales 1.5→3, is absorbed (→1) into a `ripple` (3→14) at the far outline.
- `press(node, at)` — scale 1→1.03→1 over .6s, `cubic-bezier(.22,1.2,.36,1)`,
  outline to accent, caption to ink for the beat.
- `flash(container, at, dur)` — one stroke flash spanning a wave's landings.
- `indicate(node, at)` — the focal node's lift + accent flash.
- `still(≥ 2s)` before loop.

Rules baked into the primitives: easing `cubic-bezier(0.61,0,0.39,1)`
everywhere except press; static styles are the finished frame and keyframes
carry the start state; nothing hidden at rest uses fill-mode `both` with a
visible first keyframe; heads always stack above bars, plates and dots.

Done when: Flowchart, Control plane and Sequence loop with build → wave → still,
the gate's still render equals the finished frame, and a test asserts no
element is visible at t=0 that is hidden at rest.

## Phase 4 — Panel family to golden parity `[10.6]`

Owner files: `flow.ts`, `normalize.ts`, `route.ts`, `fixtures/control-plane.mmd`.

- Re-author `fixtures/control-plane.mmd` with the golden's content (BreatheCode
  cohort engine) so the comparison is like for like.
- Render, then diff against `fixtures/golden/control-plane.svg` in Playwright:
  every node's box within 2 units, every text baseline within 1, same stroke
  widths, same colours, same animation delays within .05s.
- Layered architecture and Org chart follow the same rules; they are the
  regression set for panels.

Done when: `packages/cli/test/golden.test.mts` passes and a reviewer cannot
tell the two apart at 1116px.

## Phase 5 — Sequence `[3 6.5 8.5 10.2]`

Owner files: `sequence.ts`.

- Actors as 160×56 two-tier boxes; lifelines 0.8 dashed; messages 8 mono caps
  on plates; returns dashed `5 4`; activation bars under heads; frames (`alt`,
  `loop`) as hairline boxes with a mono tag, not filled bands.
- Waves run down the first message chain; the receiving actor presses.

Done when: `sequence`, `sequence-rich` gate `ok` with no collisions.

## Phase 6 — Chronicle: timeline, gantt, journey `[2.1 3 7.5]`

Owner files: `chronicle.ts`.

- One grid for phase bars, ticks, bars and chips; bar labels always inside (or
  always outside when none fit); milestones inside the grid; ≤ 3 body sizes.
- Build: the axis draws, bars grow from their start date with lag; one
  milestone indicates.

Done when: `timeline`, `gantt`, `gantt-states`, `journey` gate `ok`, with the
3-size warning gone.

## Phase 7 — Plots: xy, radar, quadrant `[3 3.4 7.5]`

Owner files: `plot.ts`.

- Title 22 regardless of plot width; one rotated axis label max; quadrant
  labels pulled 8 inside the border; point labels on plates; legend row per 7.2.
- Build: axes draw, series draw on as a stroke, bars grow, points ripple in.

Done when: `xy`, `radar`, `quadrant` gate `ok`.

## Phase 8 — Boards: sankey, treemap, kanban `[4.3 7.1 3.1]`

Owner files: `boards.ts`.

- Sankey gets a title and flat link colours (one hue per source at 0.35
  opacity, no blending); treemap hides labels that don't fit rather than
  shrinking them, and lists the hidden slivers in a caption; kanban cards
  are 2-tier at the §3 sizes on a canvas that uses its height.

Done when: `sankey`, `treemap`, `kanban` gate `ok`.

## Phase 9 — Native pie, mindmap, git graph `[7.6 9]`

Owner files: new `packages/core/src/radial.ts` (pie, mindmap), `commits.ts`
(git graph); `flow.ts` dispatch.

- Pie: donut, hairline separators, labels outside on leader lines, legend row.
- Mindmap: radial with 160×48 nodes, orthogonal-curved hairline links, depth
  by stroke opacity not colour.
- Git graph: lanes as channels, commits as 6-radius dots, labels upright on
  plates beside the dot, never rotated.
- All three: build with draw/grow, one wave along the main branch / largest
  slice.

Done when: the three gate `ok` and the "mermaid" tag leaves the gallery nav.

## Phase 10 — Repair and theme `[9]`

Owner files: `repair.ts`, `packages/cli/scripts/gallery.mjs`, `web`.

- Repair never leaves a fence as a node label; the flag text lists exactly what
  it changed.
- Light theme redefines `--stage` and the seven `--gc-*` values from DESIGN 5.5
  everywhere a chart is mounted (gallery, web app, React export).

Done when: `messy` renders without the "```" node; the gallery toggled light has
no dark stage; the light gate run is `ok` for every chart.

---

## Running it with agents

Each phase is one agent task on **Opus** (not the default model), with this
prompt shape:

> Implement Phase N of PLAN.md in this repo. Read CLAUDE.md and DESIGN.md
> first. Before code, list the rule numbers and before → after values. Then
> implement, run `pnpm gallery && pnpm gate <charts>`, add the Playwright
> assertions, and report: the gate lines, files touched, and any rule the work
> exposed as wrong or missing — in that order, nothing else, under 200 words.

Phases 0–3 are sequential (each depends on the previous). Phases 5–9 are
independent once 3 is in and can run in parallel worktrees. Phase 4 gates
Phase 2+3; Phase 10 is last.

Review between phases is a Fable turn on the gate output and `pnpm gate
--shots` contact sheet — short, numbers first.
