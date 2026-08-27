# Geekchart

Paste a mermaid diagram, get an animated, on-brand SVG chart. One renderer
draws every diagram type by hand — flowcharts, state, class and ER diagrams,
sequence diagrams, gantt / timeline / journey, quadrant / radar / xy, sankey /
treemap / kanban, pie / mindmap / git graph — against a written design spec,
and a measurement gate checks every chart against that spec.

**Using it:** install the [`geekchart`](packages/geekchart/README.md) package.
It has three entry points:

| you have | use | readers pay |
|---|---|---|
| diagrams as content on a Node site (blog posts, docs) | `geekchart/server` → `renderToHtml(source)` in your markdown pipeline, cached by content | nothing — inline SVG |
| diagrams edited in the browser, no deploy | the `<Geekchart source>` React component (lazy-loads the parser on first use) | one download of the parser chunk per visitor |
| a fixed diagram, or an SVG / React / HTML export | the CLI: `npx geekchart chart.mmd -o Chart.tsx` | nothing |

## This repository

```
packages/geekchart   the published package (component · server · cli)
packages/core        the renderer: parse, lay out, draw, animate
packages/cli         exports, the review gallery and the design gate
packages/react       the component's source (bundled into geekchart)
packages/web         the paste-and-preview app (Cloudflare page)
fixtures/            the charts the gate and tests run against
DESIGN.md            the spec every chart is judged against
```

```
pnpm install
pnpm dev                     # paste-and-preview app
pnpm gallery && pnpm gate    # render every fixture, measure it against DESIGN.md
pnpm test                    # ~250 Playwright assertions, one per bug that was once invisible
```

## How a chart is made

```
paste ─► repair ─► which diagram? ─► mermaid parses ─► we place ─► we draw ─► motion
```

Mermaid only parses. Layout is ours (ELK for trees and panels, our own
serpentine for chains that wrap), drawing is ours (fixed box sizes on an
8-grid, hairlines, one accent on the primary path), and motion follows the
Manim vocabulary: strokes draw on, fills follow, one thing moves at a time,
then a still beat. The rules, with the numbers, are in [DESIGN.md](DESIGN.md);
the gate (`pnpm gate`) enforces about forty of them on every chart, so a
change that breaks the look fails the build before anyone sees it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the change loop, and how to
add a chart type or a `DESIGN.md` rule. [AGENTS.md](AGENTS.md) has the fuller
map of the codebase. MIT licensed.
