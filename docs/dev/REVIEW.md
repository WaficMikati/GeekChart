# Review punch list — 2026-08-20

Against the gallery at https://claude.ai/code/artifact/691404b7-6a65-41ec-b51f-acce8c1bd524
(25 charts, 22 native). Each chart was rendered settled in Playwright and
measured: **0** overlapping labels, **0** labels escaping their box, **0**
elements outside the viewBox. Everything below is a design rule from
`DESIGN.md`, not a geometry crash. Rule numbers in brackets.

Tick an item only after `pnpm gate` passes on it and the screenshot agrees.

## Systemic — fix once

- [ ] **Canvas is unconstrained.** ViewBox widths run 248 (Class) to 2980
      (Learner journey). Make every renderer lay out on the 1000-wide canvas
      and wrap LR flows. [1.1, 1.2, 1.4]
- [ ] **Type scales with the canvas.** Title 25 / caption 13 fixed in SVG units
      means ~9px / ~5px on screen for Learner journey and 25px for Radar. Move
      to the table in DESIGN §3 and assert on-screen minimums. [3, 3.1]
- [ ] **Node boxes fitted to text.** Switch to the fixed-size list; shorten or
      wrap labels instead of widening. [2.2, 2.3]
- [ ] **Three charts are raw mermaid** (Pie, Mindmap, Git graph). Draw them
      natively. Until then they should not sit in the same gallery. [7.6]
- [ ] **Golden parity.** Panel renderer output for `control-plane.mmd` must match `fixtures/golden/control-plane.svg` at review size (DESIGN 10.6). Do this right after the canvas fix.
- [ ] **Light theme**: `--stage` not redefined, so a white toolbar sits above a
      dark stage. [9]

## Per chart

- [ ] Flowchart — thin strip on empty stage; YES/NO labels ~5px on screen;
      loop-back is a free arc under the diagram. [1.2, 3.1, 6.7]
- [ ] Subgraphs — Worker→API edge is a diagonal through the Cache cylinder;
      chart is 470×1095, taller than wide. [6.1, 1.4]
- [ ] Learner journey — doubled arrowhead on "16-week bootcamp → Portfolio
      projects"; strip layout; captions illegible. [6.3, 1.2, 3.1]
- [ ] State — fine structurally; captions ("COHORT FULL") sit on the edge
      without a plate. [6.5]
- [ ] Class — 248 wide; three boxes of three different heights; fine otherwise.
      [1.1, 2.2]
- [ ] Entity relationship — strip layout; four boxes, three widths. [1.2, 2.2]
- [ ] Sequence — ok. Message labels 14 on an 898 canvas are on the small side.
      [3]
- [ ] Sequence, with frames — activation bar drawn on top of arrowheads. [8.5]
- [ ] Control plane — four top edges converge on one point; Brand edge swoops
      around the outside and crosses Campaigns; bottom fan from one point.
      Inputs and outputs should align column-for-column (the Lyzr reference
      does exactly this). [6.4, 6.1, 2.6]
- [ ] Layered architecture — good. Check 8-grid and panel padding. [2.1, 2.6]
- [ ] Org chart — blue vs yellow boxes with no legend; director→Admissions
      edge enters at an angle. [5.3, 6.2]
- [ ] Timeline — good. Phase bars, ticks and chips all on one grid? Measure.
      [2.1]
- [ ] Gantt — ok. Bar label sits outside the bar for "Setup" and inside for
      the others; pick one. [2.3]
- [ ] Gantt, with states — "Demo day" diamond clips past the grid's right
      edge. [7.5]
- [ ] User journey — ok.
- [ ] Bar and line — ok. Legend row fine.
- [ ] Radar — title 25 on a 560 canvas: the biggest title in the set. [1.1, 3]
- [ ] Quadrant — "Paid social" touches the right border; rotated axis labels
      float far from the plot. [7.5, 3.4]
- [ ] Sankey — no title; blended link colours go muddy brown/olive (tints
      layered on tints). [7.1, 4.3]
- [ ] Treemap — unlabelled slivers; 13-unit labels on a 924 canvas. [3.1]
- [ ] Kanban — 1134×210 strip; 13-unit card text. [1.2, 3.1]
- [ ] Pie (mermaid) — title and legend text invisible on the dark ground. [9]
- [ ] Mindmap (mermaid) — white nodes, "Full stack" clipped in its circle,
      fat red/green/yellow curves. [7.6]
- [ ] Git graph (mermaid) — rotated labels collide with commits, "scaffold"
      cut off. [3.4, 7.5]
- [ ] Damaged paste — one node's label is literally "```"; the repair flag
      says the fence was removed. Fix the repair, then the flag is true. [9]
