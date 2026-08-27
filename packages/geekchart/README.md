# geekchart

Paste a mermaid diagram, get back an animated, on-brand SVG chart — flowcharts,
state/class/ER diagrams, sequence diagrams, gantt/timeline/journey, quadrant/
radar/xy, sankey/treemap/kanban, plus pie/mindmap/gitgraph. One renderer draws
all of it (`@geekchart/core`, running mermaid's own parser and ELK's layout
engine, drawn and animated by hand rather than left as mermaid's default
look), reached three ways from this package: a React component for diagrams
that arrive as content, a server function for turning content into markup
ahead of time, and a CLI for one-off exports.

## Install

```
npm install geekchart
```

`react` is a peer dependency if you use the component. `playwright` is an
**optional** peer dependency: `geekchart/server` renders in this process by
default (no browser at all — see below). Only ask for `engine: 'browser'`
explicitly, or use the CLI (which still drives a real headless Chromium for
every export), and you'll need it installed.

```
npm install playwright   # only for engine: 'browser', or the CLI
npx playwright install chromium
```

## The React component — a diagram edited without a deploy

```tsx
'use client';
import { Geekchart } from 'geekchart';

<Geekchart source={post.diagram} scene="geeks" aspect="16:9" />
```

Mermaid and the layout engine (about a megabyte before compression) are behind
a dynamic `import()` fired the first time a chart mounts, so a page with no
chart on it pays nothing for this package beyond the component itself. Until
that chunk arrives — and on the server, where it never does — it renders a
placeholder sized to the requested `aspect` (or a 1000×560 box if you didn't
pass one), so nothing on the page jumps once the real chart appears. The
component never touches `document` outside its effect, so it's safe inside a
Server Component tree; it just renders the placeholder there and stays that
way until it reaches a browser.

## The server renderer — content sites

For a mermaid fence in a blog post, a docs page, anything rendered ahead of
time or on request rather than edited live in the browser.

```ts
import { renderToHtml } from 'geekchart/server';
import express from 'express';

const app = express();

app.get('/posts/:slug', async (req, res) => {
  const post = await loadPost(req.params.slug);
  const html = await replaceMermaidFences(post.body, (source) =>
    renderToHtml(source, { scene: 'geeks' }),
  );
  res.send(layout(html));
});

async function replaceMermaidFences(markdown: string, render: (s: string) => Promise<string>) {
  const fences = [...markdown.matchAll(/```mermaid\n([\s\S]*?)```/g)];
  let out = markdown;
  for (const [fence, source] of fences) out = out.replace(fence, await render(source));
  return out;
}
```

`renderToHtml` returns a `<div id="gc-…">` holding a scoped `<style>` tag and
the SVG, ready to inline — two charts on one page never collide, because each
gets its own id and its own renamed animation keyframes. `renderToSvg` returns
the pieces separately (`{ svg, css, cycle, summary, repairs, warnings }`) if
you want to place them yourself.

Both render in this process by default (`engine: 'node'`, or leave it unset)
— `@geekchart/core`'s fontkit measurer and a lazy `linkedom` shim in place of
a real browser, so nothing here needs Playwright installed at all until you
ask for `engine: 'browser'`. That option drives the same headless Chromium
session this used exclusively before: opened lazily on first call and reused
for every render after (starting a browser per request would be the slow
part, not the drawing), kept as an escape hatch and for checking the two
engines still agree. Call `closeServer()` when shutting the process down (a
no-op if you never asked for the browser engine). Results are cached in
memory by `sha256(version + source + options)` —
the installed `geekchart` version is folded into the key automatically, so
upgrading the package never serves a render the new code wouldn't have
produced — bounded to 32 MB total rather than a fixed entry count, so a
handful of large, frequently-varied charts can't push it past a predictable
memory budget. Pass your own store (Redis, `diskCache(...)` below, anything
with `get`/`set`) as `{ cache }`, or `{ cache: false }` to skip caching for
one call.

The one page the session keeps open is *not* recycled by default, on
measurement rather than assumption: every render already removes its own
off-screen host element when it finishes, so the page's own DOM does not grow
across renders, and forcing a recycle (closing the page's context, opening a
fresh one, re-injecting the renderer bundle) costs more memory than it saves —
confirmed against `packages/cli/scripts/bench.mjs`'s throughput section,
where recycling every 100 renders raised Chromium's resident memory from
~690 MB to ~1.2 GB instead of lowering it. `setPageRecycleEvery(n)` is there
if your own traffic pattern benefits from it — a renderer change that starts
leaking per-render state, or far higher sustained throughput than this
package's benchmarks cover — but measure before turning it on.

### Caching to disk

`diskCache({ dir, maxBytes? })` is a `RenderCache` backed by one JSON file per
cache key, with an in-memory `ByteBoundedLru` (same 32 MB default, override
with `maxBytes`) in front of it so a hot chart never touches the disk twice in
a row. What's cached is exactly `renderToSvg`'s result, keyed the same way the
in-memory cache is: `sha256(version + source + options)`. It's never
invalidated by time or by touching the files — the key *is* the content, so
there's nothing to go stale — the one thing that has to invalidate it, a
renderer upgrade, already does, because the package version is baked into
every key; old files are just never read again; if that means the words
"cache" and "grows forever" both apply to `dir`, that's accurate, and cleaning
it out on deploy is a decision for your deploy, not this module. Writes go to
a temp file next to the target and `rename` into place, so a reader racing a
writer (another process, a concurrent `warm()` call) never sees a half-written
file.

```ts
import { renderToHtml, diskCache } from 'geekchart/server';
import express from 'express';

const cache = diskCache({ dir: '.geekchart-cache' });
const app = express();

app.get('/posts/:slug', async (req, res) => {
  const post = await loadPost(req.params.slug);
  res.send(await renderToHtml(post.diagram, { cache, scene: 'geeks' }));
});
```

### Warming the cache ahead of time

`warm(sources, options, concurrency = 4)` renders and caches a list of
sources up front — a build step or deploy hook, so the first real visitor
hits a warm cache instead of paying for the render itself. `sources` is an
array of mermaid strings or an `AsyncIterable<string>` (a database cursor, a
line-by-line file read); `options` is whatever `renderToSvg` takes, including
`cache` — pass `{ cache: diskCache({ dir }) }` to warm a persistent cache.
Renders run up to `concurrency` at a time (default 4). It returns
`{ rendered, cached, failed }`: `rendered` is a genuine cache miss that was
drawn, `cached` was already there, `failed` threw (`warm` keeps going and
counts it rather than stopping the batch).

```ts
import { warm, diskCache } from 'geekchart/server';

const cache = diskCache({ dir: '.geekchart-cache' });
const posts = await loadAllPosts();
const report = await warm(posts.map((p) => p.diagram), { cache, scene: 'geeks' });
console.log(report); // { rendered: 41, cached: 3, failed: 0 }
```

## The CLI — zero-JS output

```
npx geekchart post.mmd -o components/CohortFunnel.tsx
npx geekchart post.mmd -o chart.svg
npx geekchart post.mmd -o chart.mp4
```

`.tsx`/`.jsx` bakes the diagram into a component at build time — no
dependencies, no client JavaScript, safe inside a Server Component. `.svg` and
`.html` are self-contained artefacts; `.mp4`/`.gif`/`.webm` render frame by
frame by seeking a paused animation, so two runs of the same chart produce
identical files. See `geekchart --help` for every flag (scene, palette, fonts,
aspect, video settings).

## Which entry to use when

| you have | use |
|---|---|
| content someone edits without a deploy (a live editor, a CMS preview) | the React component |
| content rendered ahead of time or per-request (blog posts, docs, emails) | `geekchart/server` |
| a diagram fixed at build time, and want zero client JavaScript | the CLI, baked to `.tsx` |

## Palette and theming

Every colour is a `--gc-*` CSS custom property with the current scene's value
as its fallback, so a published chart can follow a site's own light/dark
toggle without being re-rendered:

```css
#gc-my-chart { --gc-ink: #17202A; --gc-bg: #FFFFFF; }
```

Or set the palette at render time — eight names: `bg`, `ink`, `quiet`, `path`,
`alt`, `accent`, `edge`, `surface`; anything left out keeps the scene's value.

```ts
renderToSvg(source, { palette: { path: '#1B4FD8', bg: '#FFFFFF' } });
```

```tsx
<Geekchart source={source} scene="geeks" />
```

A light chart is a palette, not a separate scene. The measured light set:

| bg | ink | quiet | edge | surface | path | accent |
|---|---|---|---|---|---|---|
| `#FFFFFF` | `#17202A` | `#5A6672` | `#9AA5B1` | `#EEF2F6` | `#0075E0` | `#0096D6` |

```
geekchart post.mmd -o chart.svg --color-bg "#FFFFFF" --color-ink "#17202A" \
  --color-quiet "#5A6672" --color-edge "#9AA5B1" --color-surface "#EEF2F6" \
  --color-path "#0075E0" --color-accent "#0096D6"
```

## How it's built

Mermaid only parses; ELK only places nodes. Every coordinate, every line, and
the whole animation timeline are drawn by this codebase rather than left as
mermaid's own output — that's what the "on-brand" part of the description
above is doing. `DESIGN.md` in the repository is the full specification this
output is measured against, and `pnpm gate` is the tool that measures it: it
renders every fixture and reports pass/fail against the spec's numeric rules,
not by eye.
