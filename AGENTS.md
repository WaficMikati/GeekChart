# Working on Geekchart — instructions for any coding agent

Read this first. It applies to Claude Code, Cursor, Copilot and humans alike;
tool-specific files (`CLAUDE.md`, `.github/copilot-instructions.md`) just
point here.

## What this is

Paste a mermaid diagram, get an animated SVG chart in the 4geeks look. The
product is the *output quality*: every chart is judged against `DESIGN.md`,
a numbered spec measured from the references the team chose, and enforced by
a measurement gate. Read `DESIGN.md` before touching anything that draws.

## Map

```
packages/core/src     the renderer — one file per family
  graph.ts, unified.ts   mermaid parse → our graph model (flowchart, state, class, ER)
  layout.ts              placement: ELK for trees/panels, our serpentine for wrapped chains,
                         panel refit, row packing, alignment passes
  route.ts               edge routing: ports, elbows, loops, corridors, label placement rules
  draw.ts                graph markup (nodes, edges, plates, arrowheads)
  motion.ts, animate.ts  animation timelines (Manim vocabulary: draw on, wave, press, still)
  sequence.ts            sequence diagrams (own layout + motion)
  chronicle.ts           timeline, gantt, journey
  plot.ts                xy, radar, quadrant
  boards.ts              sankey, treemap, kanban
  radial.ts, commits.ts  pie + mindmap, git graph
  scene.ts               the type table, canvas rules, palettes  ← sizes live here, nowhere else
  repair.ts              fixes damaged pastes before parsing
  node/                  renderNode() — the drawn pipeline with no browser: measure.ts (fontkit
                         glyph advances, rounded to match Chromium), dom.ts (a lazy linkedom
                         shim, only for mermaid's own parser), render.ts (the entry point).
                         Exported as @geekchart/core/node, not from the main index, so a browser
                         bundle never pulls in fontkit/linkedom by way of it.
packages/geekchart      the published npm package: <Geekchart> (client), geekchart/server, CLI.
                        Both render with renderNode — no browser, no Playwright. Output is SVG,
                        plus tsx/jsx/html wrappers; PNG/MP4/GIF/WebM export and engine: 'browser'
                        were dropped. Playwright stays in the repo as a dev dependency only, for
                        packages/cli's review gallery, gate, parity test and benchmarks.
packages/cli            exports, the review gallery (scripts/gallery.mjs), the gate (scripts/gate.mjs),
                        benchmarks (scripts/bench.mjs), and most tests
fixtures/, fixtures/blog/   the 37 charts everything runs against
fixtures/golden/        a hand-drawn chart that defines "done" — never edit it to match the renderer
docs/benchmarks/        reproducible performance report (pnpm bench)
docs/history/           the 2026-08 rollout plan and punch list — done, kept for context only
```

## The loop for any drawing or layout change

1. Name the `DESIGN.md` rule numbers the change touches and the measured
   value before → after. If you can't name a rule, it is probably decoration:
   stop and ask.
2. Change the renderer, not CSS layered over geometry. Sizes come from the
   type table in `scene.ts`; positions sit on the 8-grid.
3. `pnpm --filter @geekchart/cli build && pnpm gallery && pnpm gate` — the
   build step matters: the gallery reads the bundled renderer, not source.
   A change is not done while a chart FAILs. Each WARN needs a sentence.
4. Add one Playwright assertion per defect fixed in `packages/cli/test/`
   (`flow.test.mts` is one assertion per bug that was once invisible).
5. Only then look: `pnpm gate --shots` writes `.gate/*.png`. Looking is the
   second check, never the only one — every real defect here looked fine at a
   glance and was caught by a number.

If a rule seems wrong, say so and propose a measured replacement; do not
silently work around it. Systemic fixes over per-chart patches: when a chart
shows a fault, first make the fault a gate rule, then fix the cause so every
chart passes.

## Commands

```
pnpm test        ~260 tests (builds first; needs Playwright's Chromium)
pnpm gate        measure all fixtures against DESIGN.md; --shots for PNGs; --json for tools
pnpm bench       reproducible benchmarks → docs/benchmarks/
pnpm lint / typecheck / size
```

## Things that trip people up

- The gate renders the *still* frame (animations off). Static styles must be
  the finished frame; keyframes carry the start state. Anything hidden at rest
  must not use fill-mode `both` with a visible first keyframe.
- `pnpm gallery` does not rebuild `packages/cli/dist` — build first.
- Loop-backs, satellites and wraps have their own rules (DESIGN 6.7, 6.8); read
  them before touching `route.ts` or `layout.ts`'s fold.
- `renderNode()`'s module graph (`chart.ts` → `flow.ts` → `graph.ts` →
  `mermaid`) must load *after* `node/dom.ts`'s shim installs its globals, not
  before. Mermaid's default import evaluates a DOMPurify singleton
  immediately against whatever `window`/`document` exist at that instant,
  with no later hook to redo the detection — a static import of `chart.ts`
  at the top of a file resolves before any function body in that file runs,
  so it always loses the race. `node/render.ts` only reaches it with a
  dynamic `import()`, issued after `ensureNodeDom()` — keep any future
  Node-side entry point the same way.
- `pnpm gate` and `pnpm test` still exercise the browser path only — there is
  no `--engine=node` flag on the gate yet. A change to `node/measure.ts` or
  `node/dom.ts` needs its own check: `packages/cli/scripts/spike-node.mjs`
  compares Node against the browser on six fixtures; widen its `FIXTURES`
  list to all of `fixtures/` for a full sweep before trusting a change there.
- Deletion goes to the trash (`gio trash`), never an unrecoverable erase. No AI
  attribution in commits, code or docs.
