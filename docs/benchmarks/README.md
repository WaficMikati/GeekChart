# Geekchart performance benchmarks

Generated 2026-08-25T18:59:20.067Z · min / median / max over 10 runs, 1 warm-up run discarded (a "cold cache" pass is a single measurement — see §5).

## Machine

- CPU: AMD Ryzen 9 5900HX with Radeon Graphics (16 logical cores)
- RAM: 15 GB
- OS: CachyOS (7.1.8-1-cachyos)
- Node: v24.16.0 · Chromium: 151.0.7922.34

## 1. Render time per chart

Desktop and 4x CPU throttling, via the built renderer (same bundle `gate.mjs` measures against), in ms.

| chart | family | desktop min/median/max | 4x CPU min/median/max |
|---|---|---|---|
| 4geeks-journey | flow | 10.1 / 11.8 / 17.5 | 38.0 / 39.8 / 48.2 |
| architecture | flow | 6.5 / 7.3 / 8.0 | 27.0 / 28.6 / 30.2 |
| blog/bootcamp-worth-it | quadrant | 1.3 / 1.6 / 2.4 | 5.3 / 6.1 / 7.6 |
| blog/first-ai-app | sequence | 2.2 / 2.5 / 3.4 | 9.2 / 10.0 / 11.4 |
| blog/geekforce-timeline | timeline | 2.0 / 2.2 / 2.7 | 8.0 / 8.5 / 9.4 |
| blog/incident-response | flow | 7.4 / 7.8 / 9.0 | 31.0 / 32.3 / 34.8 |
| blog/learn-js-plan | gantt | 1.5 / 1.7 / 2.2 | 5.9 / 6.9 / 8.1 |
| blog/outcomes-2024 | xy | 1.8 / 1.9 / 2.9 | 7.1 / 7.7 / 9.9 |
| blog/platform-layers | flow | 61.6 / 65.8 / 75.6 | 139.9 / 148.2 / 169.3 |
| blog/prompt-anatomy | flow | 4.8 / 5.4 / 5.9 | 22.3 / 23.5 / 29.2 |
| blog/pyenv-resolution | flow | 52.3 / 52.9 / 55.0 | 114.1 / 116.4 / 119.8 |
| blog/python-or-java | flow | 6.0 / 6.6 / 7.1 | 26.8 / 28.5 / 31.0 |
| blog/regex-engine | state | 10.1 / 10.5 / 13.1 | 42.2 / 44.7 / 45.9 |
| blog/rigobot-loop | sequence | 2.6 / 2.8 / 3.4 | 10.7 / 11.6 / 12.3 |
| class | class | 47.9 / 48.5 / 49.9 | 96.4 / 99.0 / 113.6 |
| control-plane | flow | 8.1 / 8.8 / 11.6 | 35.8 / 36.8 / 67.6 |
| er | er | 4.0 / 4.2 / 5.0 | 17.5 / 18.5 / 19.8 |
| flow | flow | 5.9 / 6.0 / 6.2 | 23.8 / 25.4 / 26.7 |
| gantt | gantt | 1.2 / 1.4 / 1.7 | 4.9 / 5.9 / 7.2 |
| gantt-states | gantt | 1.5 / 1.7 / 2.2 | 6.4 / 7.2 / 7.9 |
| gitgraph | gitgraph | 2.8 / 3.2 / 3.6 | 10.9 / 12.3 / 13.1 |
| journey | journey | 1.2 / 1.4 / 2.2 | 5.5 / 5.5 / 7.9 |
| kanban | kanban | 1.7 / 2.0 / 2.3 | 6.6 / 7.4 / 8.1 |
| messy | flow | 4.2 / 4.6 / 6.7 | 17.4 / 18.2 / 20.1 |
| mindmap | mindmap | 1.8 / 2.2 / 2.4 | 7.9 / 8.3 / 9.2 |
| org-chart | flow | 49.9 / 50.4 / 52.8 | 103.0 / 104.8 / 123.2 |
| pie | pie | 1.0 / 1.2 / 1.7 | 4.0 / 5.0 / 6.4 |
| quadrant | quadrant | 1.2 / 1.4 / 1.5 | 5.2 / 5.9 / 6.6 |
| radar | radar | 1.1 / 1.1 / 1.3 | 4.7 / 5.3 / 6.3 |
| sankey | sankey | 2.3 / 2.6 / 2.9 | 9.4 / 10.2 / 10.8 |
| sequence | sequence | 1.6 / 1.7 / 2.4 | 7.2 / 7.8 / 8.8 |
| sequence-rich | sequence | 2.2 / 2.5 / 3.2 | 9.9 / 11.0 / 11.9 |
| state | state | 5.6 / 5.8 / 6.5 | 23.7 / 25.5 / 26.4 |
| subgraphs | flow | 61.5 / 64.0 / 68.0 | 147.9 / 152.1 / 156.6 |
| timeline | timeline | 1.9 / 2.1 / 2.5 | 8.5 / 9.1 / 10.6 |
| treemap | treemap | 1.2 / 1.3 / 1.6 | 4.7 / 5.8 / 6.6 |
| xy | xy | 1.9 / 2.3 / 2.5 | 8.9 / 9.5 / 11.2 |

Per-family median (of per-chart medians), ms:

| family | n | desktop | 4x CPU |
|---|---|---|---|
| flow | 12 | 8.3 | 34.6 |
| quadrant | 2 | 1.5 | 6.0 |
| sequence | 4 | 2.5 | 10.5 |
| timeline | 2 | 2.1 | 8.8 |
| gantt | 3 | 1.7 | 6.9 |
| xy | 2 | 2.1 | 8.6 |
| state | 2 | 8.2 | 35.1 |
| class | 1 | 48.5 | 99.0 |
| er | 1 | 4.2 | 18.5 |
| gitgraph | 1 | 3.2 | 12.3 |
| journey | 1 | 1.4 | 5.5 |
| kanban | 1 | 2.0 | 7.4 |
| mindmap | 1 | 2.2 | 8.3 |
| pie | 1 | 1.2 | 5.0 |
| radar | 1 | 1.1 | 5.3 |
| sankey | 1 | 2.6 | 10.2 |
| treemap | 1 | 1.3 | 5.8 |

## 2. Mermaid baseline

mermaid's own `mermaid.render`, same fixtures, desktop only. Bundle: what a browser fetches eagerly to call it once (esbuild, code-split, only the static-import closure — the same method `packages/geekchart/build.mjs` uses for Geekchart's own lazy chunk): **135.9 kB brotli** (526.6 kB raw, 18 files).

| chart | family | desktop min/median/max |
|---|---|---|
| 4geeks-journey | flow | 20.5 / 22.7 / 26.1 |
| architecture | flow | 14.4 / 16.0 / 17.2 |
| blog/bootcamp-worth-it | quadrant | 1.3 / 1.4 / 2.1 |
| blog/first-ai-app | sequence | 3.8 / 4.2 / 4.8 |
| blog/geekforce-timeline | timeline | 5.4 / 6.2 / 10.7 |
| blog/incident-response | flow | 13.3 / 14.5 / 16.2 |
| blog/learn-js-plan | gantt | 2.4 / 2.5 / 3.9 |
| blog/outcomes-2024 | xy | 2.8 / 3.0 / 4.2 |
| blog/platform-layers | flow | 17.4 / 18.5 / 22.2 |
| blog/prompt-anatomy | flow | 11.5 / 12.4 / 13.6 |
| blog/pyenv-resolution | flow | 14.7 / 15.7 / 16.8 |
| blog/python-or-java | flow | 13.9 / 15.8 / 18.3 |
| blog/regex-engine | state | 28.7 / 30.5 / 32.3 |
| blog/rigobot-loop | sequence | 3.8 / 4.0 / 4.6 |
| class | class | 13.4 / 14.5 / 16.5 |
| control-plane | flow | 21.4 / 22.5 / 24.1 |
| er | er | 16.1 / 17.2 / 18.3 |
| flow | flow | 13.5 / 14.3 / 21.0 |
| gantt | gantt | 2.3 / 2.5 / 4.6 |
| gantt-states | gantt | 2.3 / 2.4 / 2.8 |
| gitgraph | gitgraph | 3.0 / 3.5 / 4.1 |
| journey | journey | 2.1 / 2.4 / 3.3 |
| kanban | kanban | 11.2 / 12.8 / 13.8 |
| mindmap | mindmap | 14.2 / 15.7 / 18.4 |
| org-chart | flow | 13.7 / 14.7 / 15.1 |
| pie | pie | 1.1 / 1.4 / 1.7 |
| quadrant | quadrant | 1.2 / 1.3 / 1.8 |
| radar | radar | 1.4 / 1.6 / 1.9 |
| sankey | sankey | 2.4 / 2.8 / 3.9 |
| sequence | sequence | 2.5 / 2.8 / 3.7 |
| sequence-rich | sequence | 3.8 / 4.1 / 5.1 |
| state | state | 16.1 / 17.1 / 19.2 |
| subgraphs | flow | 15.0 / 15.9 / 23.6 |
| timeline | timeline | 5.5 / 6.0 / 6.5 |
| treemap | treemap | 2.8 / 3.0 / 3.5 |
| xy | xy | 3.0 / 3.3 / 4.7 |

Skipped (mermaid could not render the source as-is): `messy`.

## 3. First-chart experience (Fast 3G + 4x CPU)

A minimal page mounting `<Geekchart source>` from the built `geekchart` package (React + ReactDOM + the component, esbuild-bundled, served brotli-compressed with far-future cache headers). Time from navigation to the chart's `svg.gc-chart` appearing.

| | min | median | max |
|---|---|---|---|
| cold (empty cache) | 7051.1ms | 7076.2ms | 7278.3ms |
| warm (2nd navigation) | 351.8ms | 357.5ms | 408.3ms |

Lighthouse (mobile preset, single run): performance score **0.47**, LCP 6453.7ms, TBT 589.0ms, CLS 0.

## 4. Animation

fps and worst single-frame time over 3s, on the 6 heaviest charts by desktop render time: blog/platform-layers, subgraphs, blog/pyenv-resolution, org-chart, class, 4geeks-journey.

| chart | desktop fps min/median/max | desktop worst frame (ms) | 4x CPU fps min/median/max | 4x CPU worst frame (ms) |
|---|---|---|---|---|
| blog/platform-layers | 60.0 / 60.0 / 60.0 | 16.8 | 60.0 / 60.0 / 60.0 | 16.8 |
| subgraphs | 60.0 / 60.0 / 60.0 | 16.8 | 60.0 / 60.0 / 60.0 | 16.8 |
| blog/pyenv-resolution | 60.0 / 60.0 / 60.0 | 16.8 | 60.0 / 60.0 / 60.0 | 16.8 |
| org-chart | 60.0 / 60.0 / 60.0 | 16.8 | 60.0 / 60.0 / 60.0 | 16.8 |
| class | 60.0 / 60.0 / 60.0 | 16.8 | 60.0 / 60.0 / 60.0 | 16.8 |
| 4geeks-journey | 60.0 / 60.0 / 60.0 | 16.8 | 60.0 / 60.0 / 60.0 | 16.8 |

## 5. Server path (`geekchart/server`)

Browser start + first render (cache disabled): 1598.9ms.

| | min | median | max |
|---|---|---|---|
| warm miss (cache disabled) | 17.9ms | 18.7ms | 20.4ms |
| cache hit | 0.3ms | 0.3ms | 0.6ms |

Cold-cache full pass, all 37 fixtures, sequential, fresh cache: **920.2ms** (single measurement — repeating it would no longer be cold).

Throughput, 37 fixtures per run, `Promise.all` batches (renders/second):

| concurrency | min | median | max |
|---|---|---|---|
| 1 | 53.3 | 55.2 | 57.0 |
| 4 | 69.8 | 72.0 | 73.4 |
| 8 | 68.9 | 74.7 | 83.5 |

RSS after the throughput run: Node 447 MB, Chromium (all processes) 683 MB.

## 6. Bundle sizes (`packages/geekchart/dist`)

| entry | raw | brotli |
|---|---|---|
| index.js | 1.0 kB | 0.6 kB |
| server.js | 3.8 kB | 1.7 kB |
| cli.js | 2695.1 kB | 590.9 kB |
| **lazy chunk (20 files, fetched on first chart mount)** | **731.6 kB** | **195.9 kB** |
| further lazy (mermaid's own per-diagram-type chunks, 62 files) | 11363.4 kB | 2922.8 kB |

## Notes

- mermaid baseline skipped 1 fixture(s) it cannot render: messy
- While building this report, one out of several spot-checks of concurrent renderToHtml() calls returned identical output for genuinely different sources — a rare race, not reproduced in two follow-up isolated tests. A dedicated repro against the exact section-5 scenario (all 37 fixtures, batches of 4 and 8, output diffed against a sequential reference) found zero mismatches, so the throughput numbers above are trustworthy — but the rare case observed elsewhere suggests renderToHtml on a shared browser session is not fully hardened for concurrent use and deserves a closer look.

## Method

- Every number is min/median/max over 10 runs after 1 discarded warm-up, except a cold-cache pass, which cannot be repeated and stay cold.
- "4x CPU" is Chrome DevTools Protocol `Emulation.setCPUThrottlingRate({rate: 4})`.
- "Fast 3G" is `Network.emulateNetworkConditions` at 1.6 Mbps down, 150ms latency.
- Render time is measured inside the page (`performance.now()` around the call), not around the Node round trip, so Playwright IPC overhead is excluded.
- The mermaid baseline and its bundle size use the same "static-import closure from one entry point" method `packages/geekchart/build.mjs` uses for Geekchart's own lazy chunk, so the two numbers are comparable.

