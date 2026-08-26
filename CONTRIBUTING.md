# Contributing to Geekchart

This is a monorepo (`packages/core`, `packages/cli`, `packages/react`,
`packages/geekchart`, `packages/web`) built around one idea: every chart is
judged against `DESIGN.md`, a numbered, measured spec, and a script (the
"gate") checks charts against it automatically. Read `AGENTS.md` first — it
has the map of the codebase and the rule that governs every drawing change.
This file is the practical side: how to set your machine up, and the concrete
steps for the changes people make most often.

## Setup

```
pnpm install
pnpm --filter @geekchart/cli exec playwright install --with-deps chromium
```

Node 18+ (CI runs Node 24). The renderer runs inside headless Chromium — the
gallery, the gate and most of the test suite drive a real browser through
Playwright, so that Chromium install is not optional.

```
pnpm dev                     # the paste-and-preview app, for poking at things by hand
pnpm gallery && pnpm gate    # render every fixture, measure it against DESIGN.md
pnpm test                    # ~260 assertions, one per bug that was once invisible
pnpm typecheck / lint / format / size
```

`pnpm gallery` reads the built CLI, not the source — after touching
`packages/core/src` or `packages/cli/src` you need
`pnpm --filter @geekchart/cli build` before `pnpm gallery` picks the change
up. `pnpm test` does this build for you; `pnpm gallery` on its own does not.

## The change loop (for any drawing or layout change)

This is `AGENTS.md`'s loop, spelled out:

1. **Name the rule before you touch code.** Open `DESIGN.md`, find the
   section number(s) the change is about, and write down the measured value
   before and the value you expect after (e.g. "3.1: min on-screen 6.3px →
   9.5px"). If you can't point at a rule, the change is probably decoration —
   ask before writing it, don't silently add it.
2. **Change the renderer, not a stylesheet on top of it.** Sizes live in the
   type table in `packages/core/src/scene.ts`; everything sits on the 8-unit
   grid. A fix that only works by overriding mermaid's own geometry in CSS is
   the wrong fix even if it looks right.
3. **Build, then measure:**
   ```
   pnpm --filter @geekchart/cli build && pnpm gallery && pnpm gate
   ```
   A chart is not done while its line says `FAIL`. A `WARN` needs one
   sentence in your PR description saying why it's acceptable or what you
   fixed. `pnpm gate <chart-id> [<chart-id> ...]` measures just the charts you
   name, which is faster while iterating.
4. **Add a test.** One Playwright assertion per defect you fixed, in
   `packages/cli/test/` — reuse a file that already opens a Playwright
   session (`flow.test.mts` is the template: one assertion per bug that was
   once invisible) rather than starting a new one. This is what stops the
   defect from coming back silently.
5. **Only then look at it.** `pnpm gate --shots` writes PNGs to `.gate/`.
   Looking is the second check, never the only one — every real defect in
   this codebase looked fine at a glance and was only caught by a number.

If a `DESIGN.md` rule seems wrong for a case you're looking at, say so and
propose a measured replacement in your PR. Don't quietly work around it —
the rule is either correct and your change is the bug, or the rule needs
fixing for everyone.

## Adding a chart type

Diagram families are drawn natively, one file per family — there's no
"generic mermaid passthrough" path:

| family | parse | layout | draw + motion |
|---|---|---|---|
| flowchart, state, class, ER | `graph.ts`, `unified.ts` | `layout.ts`, `route.ts` | `draw.ts`, `motion.ts`, `animate.ts` |
| sequence | `sequence.ts` | `sequence.ts` | `sequence.ts` |
| timeline, gantt, journey | `chronicle.ts` | `chronicle.ts` | `chronicle.ts` |
| xy, radar, quadrant | `plot.ts` | `plot.ts` | `plot.ts` |
| sankey, treemap, kanban | `boards.ts` | `boards.ts` | `boards.ts` |
| pie, mindmap | `radial.ts` | `radial.ts` | `radial.ts` |
| git graph | `commits.ts` | `commits.ts` | `commits.ts` |

To add a new chart (a new family, or a new fixture in an existing one):

1. Drop a `.mmd` fixture in `fixtures/` (a synthetic, minimal example of the
   feature) or `fixtures/blog/` (a real chart pulled from an actual article —
   these exercise the renderer against messier, real-world input).
2. Register it in `packages/cli/scripts/gallery.mjs`'s `GROUPS` array: add
   `[fileId, 'Display title', 'mermaid keyword']` to the right group's
   `items`, or start a new group if it's a genuinely new shape of thing. The
   `dir` field picks `fixturesRoot` or `fixturesBlog`.
3. Build, then run the gallery and gate:
   ```
   pnpm --filter @geekchart/cli build && pnpm gallery && pnpm gate
   ```
   A brand-new chart type usually needs new drawing code before the gate is
   happy — that's `packages/core/src`, per the table above, following the
   change loop above. The gate is expected to end at "N charts, 0 failing"
   for whatever N the fixture count is; don't add a fixture that regresses
   that number.
4. Add tests in `packages/cli/test/` the same way as any other defect fix.

## Adding a DESIGN.md rule

Rules get added when a chart shows a fault `DESIGN.md` doesn't yet name — per
`AGENTS.md`: fix the systemic cause, not the one chart, and turn the fault
into a rule so it can't come back unnoticed anywhere else.

1. Write the rule in `DESIGN.md`: a numbered point, stated as a measurement
   ("X is at least Nunits", not "X should look good"), in the section it
   belongs to.
2. Add a check for it to `packages/cli/scripts/gate.mjs`, following the
   pattern of an existing check in that file (measure something on the
   rendered SVG, compare it to the rule's number, push a FAIL or WARN line).

   Note for AI coding agents: `docs/dev/AGENT-BRIEF.md` tells scoped
   implementation agents never to edit `gate.mjs` directly, so the gate can't
   be quietly loosened by whichever agent is trying to pass it. If you're
   such an agent, add the check by asking a human (or a differently-scoped
   session) to make the `gate.mjs` edit, or propose the exact diff for
   review instead of applying it yourself.
3. Add a Playwright assertion for the rule in `packages/cli/test/`, on a
   fixture that would have failed the old, ruleless gate.
4. Run `pnpm gallery && pnpm gate` and fix whatever the new rule catches
   until every chart is clean or has a reasoned `WARN`.

## Commit conventions

- Plain, present-tense messages that say why, not just what
  ("fix sankey ribbon width on wrap" not "update boards.ts").
- No AI attribution of any kind — no `Co-Authored-By: Claude`, no "Generated
  with" footers, in commits, PR text, or code comments, regardless of what
  tool made the change.
- Formatting changes (`pnpm format`) go in their own commit, separate from
  behavioural or lint fixes, so a reviewer can skip the format diff.
- Delete files with `gio trash`, never `rm -rf` or an unrecoverable erase.
- Never `--no-verify`. If a hook fails, fix the underlying problem.

## CI

`.github/workflows/ci.yml` runs, in order, on every push and PR:

```
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm build
pnpm size                                                     # lazy-chunk budget
pnpm --filter @geekchart/cli exec playwright install --with-deps chromium
pnpm gallery && pnpm gate
pnpm test
```

Running the same commands locally before pushing is the fastest way to know
CI will pass.
