# Geekchart — working rules

Geekchart turns pasted mermaid into animated, designed SVG charts in the 4geeks
look. Dark ground, customizable palette, three interfaces (CLI, web, Cloudflare
page), React export. Output quality is the product.

## The standard

`DESIGN.md` is the spec. It was derived by measuring the references the team
chose; it is the only thing a chart is judged against. Do not reach for the
reference images again — they are other brands, and reproducing one is as
wrong as ignoring it. If a rule in DESIGN.md seems wrong, say so and propose a
measured replacement; do not silently work around it.

`AGENTS.md` is the tool-agnostic guide (repo map, commands, gotchas) — read it
first. The 2026-08 punch list and plan are done and archived in `docs/history/`;
the current state is `pnpm gate` and the tests, not a list.

## How every drawing or layout change is done

1. **Before writing code**, list the DESIGN.md rule numbers the change touches
   and the measured value each will have after (e.g. "1.1: flow canvas
   2494 → 1000; 3.1: min on-screen 6.3px → 9.5px"). If you cannot name a rule,
   the change is probably decoration — stop and ask.
2. Make the change in the renderer, not in CSS on top of mermaid's geometry.
   Anything that changes how designed a chart looks lives in
   `packages/core/src/normalize.ts` and the drawing code, not in a stylesheet.
3. **Run `pnpm gallery && pnpm gate`** and paste the gate lines for the charts
   you touched. A change is not done while its charts FAIL. WARN lines need a
   sentence each: fixed, or why it is acceptable.
4. Add a Playwright assertion for each defect you fixed to
   `packages/cli/test/flow.test.mts` (or the matching test) so it cannot come
   back. That file is one assertion per bug that was once invisible.
5. Only then look at the screenshot (`pnpm gate --shots` writes `.gate/*.png`).
   Looking is the second check, never the only one.

## Things that have already been decided

- Manim's easing `cubic-bezier(0.61, 0, 0.39, 1)` everywhere; stroke draws on,
  then fill — never a plain fade.
- One depth cue per box. Colour carries motion, not decoration.
- Light chart = a palette, not a scene. No warm/paper background.
- Demos ship as inline SVG, not video.
- Every chart type is drawn natively. Raw mermaid output is a stopgap, not a
  deliverable.

## Reporting

Lead with what changed and the gate numbers. No narration of steps taken.
