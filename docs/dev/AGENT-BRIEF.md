# Brief for implementation agents (read this, then only what it points to)

Token budget is the constraint. Do not explore. Do not read files not named in
your task. Do not read screenshots. Do not read test transcripts.

- Spec: DESIGN.md — read only the sections your task cites.
- Target picture: fixtures/golden/control-plane.svg (read once if your task
  touches graph/panel geometry or motion; otherwise skip).
- Check: `pnpm --filter @geekchart/cli build && pnpm gallery && pnpm gate <charts>` (only your charts; the build step matters — gallery reads the bundled dist, not src). A line is
  `name ok 1000×H` when done. If the gate prints "no svg", rerun once (a
  parallel agent may have been rewriting gallery.html).
- Keep `pnpm typecheck` clean. Run `pnpm test` once at the end.
- Add one node:test assertion per defect fixed in packages/cli/test/ (reuse an
  existing file that already has a Playwright session).
- Never edit: fixtures/golden/, packages/cli/scripts/gate.mjs,
  packages/cli/test/gate-allowlist.json, DESIGN.md.
- Delete with `gio trash`, never rm -rf. No AI attribution anywhere.

Report: gate lines for your charts, files touched as `file:line`, and one line
per rule you could not meet and why. Under 80 words plus the gate lines.
Nothing else.
