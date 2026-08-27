# Geekchart performance benchmarks

Generated 2026-08-27T23:19:48.457Z · min / median / max over 10 runs, 1 warm-up run discarded (a "cold cache" pass is a single measurement — see §5).

## Machine

- CPU: AMD Ryzen 9 5900HX with Radeon Graphics (16 logical cores)
- RAM: 15 GB
- OS: CachyOS (7.2.0-1-cachyos)
- Node: v24.16.0 · Chromium: 151.0.7922.34

## 1. Render time per chart

Desktop and 4x CPU throttling, via the built renderer (same bundle `gate.mjs` measures against), in ms.

| chart | family | desktop min/median/max | 4x CPU min/median/max |
|---|---|---|---|
| 4geeks-journey | flow | 12.1 / 13.9 / 22.2 | 45.4 / 51.4 / 56.0 |
| architecture | flow | 7.5 / 9.0 / 10.0 | 33.1 / 34.9 / 42.0 |
| blog/bootcamp-worth-it | quadrant | 1.8 / 2.1 / 3.6 | 7.5 / 8.5 / 9.4 |
| blog/first-ai-app | sequence | 3.4 / 3.6 / 4.2 | 14.1 / 14.9 / 17.8 |
| blog/geekforce-timeline | timeline | 2.7 / 3.0 / 4.5 | 11.3 / 13.0 / 14.3 |
| blog/incident-response | flow | 8.4 / 9.1 / 11.3 | 37.8 / 40.7 / 46.7 |
| blog/learn-js-plan | gantt | 2.0 / 2.3 / 3.1 | 9.3 / 9.6 / 11.1 |
| blog/outcomes-2024 | xy | 2.6 / 3.3 / 6.0 | 10.9 / 11.1 / 12.8 |
| blog/platform-layers | flow | 73.7 / 76.7 / 85.4 | 196.1 / 204.8 / 215.7 |
| blog/prompt-anatomy | flow | 5.9 / 6.3 / 6.9 | 27.3 / 29.3 / 30.7 |
| blog/pyenv-resolution | flow | 60.2 / 61.4 / 63.7 | 153.4 / 158.7 / 168.6 |
| blog/python-or-java | flow | 7.6 / 8.0 / 8.6 | 34.0 / 34.6 / 37.7 |
| blog/regex-engine | state | 12.4 / 13.1 / 14.6 | 56.3 / 60.3 / 61.8 |
| blog/rigobot-loop | sequence | 3.4 / 3.9 / 5.2 | 15.0 / 16.1 / 17.4 |
| class | class | 54.1 / 54.7 / 55.5 | 121.9 / 127.5 / 132.3 |
| control-plane | flow | 9.0 / 9.6 / 10.6 | 42.0 / 43.0 / 44.3 |
| er | er | 4.2 / 4.7 / 5.6 | 19.5 / 21.3 / 26.7 |
| flow | flow | 6.5 / 6.8 / 8.3 | 28.2 / 30.3 / 31.0 |
| gantt | gantt | 1.6 / 2.0 / 2.3 | 7.6 / 8.8 / 10.9 |
| gantt-states | gantt | 2.0 / 2.4 / 2.7 | 9.5 / 10.1 / 11.2 |
| gitgraph | gitgraph | 3.9 / 4.5 / 5.2 | 15.6 / 17.1 / 21.6 |
| journey | journey | 2.0 / 2.1 / 2.5 | 8.3 / 9.0 / 10.5 |
| kanban | kanban | 2.8 / 3.0 / 3.1 | 10.1 / 10.7 / 12.9 |
| messy | flow | 4.8 / 5.3 / 5.9 | 22.1 / 23.8 / 26.6 |
| mindmap | mindmap | 2.7 / 2.9 / 3.8 | 11.4 / 12.5 / 15.4 |
| org-chart | flow | 55.8 / 56.4 / 57.8 | 134.8 / 140.9 / 153.3 |
| pie | pie | 1.5 / 1.7 / 2.3 | 6.5 / 7.3 / 7.8 |
| quadrant | quadrant | 2.1 / 2.3 / 2.7 | 7.3 / 9.4 / 10.1 |
| radar | radar | 1.5 / 1.8 / 2.0 | 6.7 / 7.3 / 10.2 |
| sankey | sankey | 3.4 / 3.6 / 4.2 | 13.8 / 16.0 / 18.6 |
| sequence | sequence | 2.4 / 2.7 / 3.1 | 10.5 / 11.4 / 14.1 |
| sequence-rich | sequence | 3.3 / 3.7 / 5.0 | 13.8 / 15.3 / 17.1 |
| state | state | 6.8 / 7.6 / 8.9 | 29.8 / 33.1 / 36.0 |
| subgraphs | flow | 71.4 / 74.6 / 82.6 | 192.5 / 205.3 / 225.9 |
| timeline | timeline | 2.8 / 2.9 / 3.4 | 12.5 / 13.3 / 14.7 |
| treemap | treemap | 1.6 / 1.8 / 2.5 | 6.5 / 7.6 / 9.4 |
| xy | xy | 3.0 / 3.2 / 4.0 | 12.1 / 13.0 / 15.1 |

Per-family median (of per-chart medians), ms:

| family | n | desktop | 4x CPU |
|---|---|---|---|
| flow | 12 | 9.4 | 41.9 |
| quadrant | 2 | 2.2 | 8.9 |
| sequence | 4 | 3.6 | 15.1 |
| timeline | 2 | 2.9 | 13.1 |
| gantt | 3 | 2.3 | 9.6 |
| xy | 2 | 3.2 | 12.1 |
| state | 2 | 10.4 | 46.7 |
| class | 1 | 54.7 | 127.5 |
| er | 1 | 4.7 | 21.3 |
| gitgraph | 1 | 4.5 | 17.1 |
| journey | 1 | 2.1 | 9.0 |
| kanban | 1 | 3.0 | 10.7 |
| mindmap | 1 | 2.9 | 12.5 |
| pie | 1 | 1.7 | 7.3 |
| radar | 1 | 1.8 | 7.3 |
| sankey | 1 | 3.6 | 16.0 |
| treemap | 1 | 1.8 | 7.6 |

## 2. Mermaid baseline

mermaid's own `mermaid.render`, same fixtures, desktop only. Bundle: what a browser fetches eagerly to call it once (esbuild, code-split, only the static-import closure — the same method `packages/geekchart/build.mjs` uses for Geekchart's own lazy chunk): **136.0 kB brotli** (526.6 kB raw, 18 files).

| chart | family | desktop min/median/max |
|---|---|---|
| 4geeks-journey | flow | 26.7 / 29.4 / 33.4 |
| architecture | flow | 20.0 / 21.1 / 23.4 |
| blog/bootcamp-worth-it | quadrant | 1.8 / 2.1 / 3.5 |
| blog/first-ai-app | sequence | 5.2 / 5.9 / 7.4 |
| blog/geekforce-timeline | timeline | 7.5 / 8.0 / 10.2 |
| blog/incident-response | flow | 17.9 / 18.7 / 21.8 |
| blog/learn-js-plan | gantt | 3.2 / 3.8 / 4.2 |
| blog/outcomes-2024 | xy | 3.6 / 4.5 / 4.9 |
| blog/platform-layers | flow | 24.4 / 27.2 / 30.6 |
| blog/prompt-anatomy | flow | 15.5 / 17.2 / 18.0 |
| blog/pyenv-resolution | flow | 19.7 / 21.8 / 22.6 |
| blog/python-or-java | flow | 17.5 / 21.1 / 24.7 |
| blog/regex-engine | state | 38.8 / 39.9 / 42.4 |
| blog/rigobot-loop | sequence | 5.2 / 5.7 / 6.6 |
| class | class | 18.2 / 19.3 / 20.4 |
| control-plane | flow | 28.3 / 29.8 / 30.8 |
| er | er | 22.8 / 24.0 / 25.0 |
| flow | flow | 18.0 / 19.1 / 20.7 |
| gantt | gantt | 3.4 / 3.8 / 5.2 |
| gantt-states | gantt | 3.1 / 3.9 / 8.0 |
| gitgraph | gitgraph | 4.4 / 5.0 / 6.2 |
| journey | journey | 3.3 / 3.7 / 5.9 |
| kanban | kanban | 16.0 / 16.8 / 18.9 |
| mindmap | mindmap | 19.2 / 20.9 / 23.1 |
| org-chart | flow | 18.2 / 19.3 / 22.6 |
| pie | pie | 1.5 / 2.1 / 2.4 |
| quadrant | quadrant | 1.6 / 1.9 / 2.4 |
| radar | radar | 1.9 / 2.3 / 3.7 |
| sankey | sankey | 3.4 / 4.0 / 5.5 |
| sequence | sequence | 3.7 / 4.1 / 5.9 |
| sequence-rich | sequence | 5.5 / 5.7 / 7.2 |
| state | state | 21.4 / 23.1 / 23.8 |
| subgraphs | flow | 20.2 / 21.1 / 23.5 |
| timeline | timeline | 7.7 / 8.4 / 9.5 |
| treemap | treemap | 4.2 / 4.9 / 6.9 |
| xy | xy | 4.4 / 4.8 / 5.4 |

Skipped (mermaid could not render the source as-is): `messy`.

## 3. First-chart experience (Fast 3G + 4x CPU)

A minimal page mounting `<Geekchart source>` from the built `geekchart` package (React + ReactDOM + the component, esbuild-bundled, served brotli-compressed with far-future cache headers). Time from navigation to the chart's `svg.gc-chart` appearing.

| | min | median | max |
|---|---|---|---|
| cold (empty cache) | 8079.6ms | 8166.6ms | 8230.3ms |
| warm (2nd navigation) | 487.0ms | 493.4ms | 507.6ms |

Lighthouse (mobile preset, single run): performance score **0.41**, LCP 6509.7ms, TBT 808.0ms, CLS 0.

## 4. Animation

fps and worst single-frame time over 3s, on the 6 heaviest charts by desktop render time: blog/platform-layers, subgraphs, blog/pyenv-resolution, org-chart, class, 4geeks-journey.

| chart | desktop fps min/median/max | desktop worst frame (ms) | 4x CPU fps min/median/max | 4x CPU worst frame (ms) |
|---|---|---|---|---|
| blog/platform-layers | 60.0 / 60.0 / 60.0 | 16.8 | 60.0 / 60.0 / 60.0 | 16.8 |
| subgraphs | 60.0 / 60.0 / 60.0 | 16.8 | 60.0 / 60.0 / 60.0 | 16.8 |
| blog/pyenv-resolution | 60.0 / 60.0 / 60.0 | 16.8 | 60.0 / 60.0 / 60.0 | 16.8 |
| org-chart | 60.0 / 60.0 / 60.0 | 16.8 | 60.0 / 60.0 / 60.0 | 16.8 |
| class | 60.0 / 60.0 / 60.0 | 16.8 | 58.7 / 60.0 / 60.0 | 66.6 |
| 4geeks-journey | 60.0 / 60.0 / 60.0 | 16.8 | 59.7 / 60.0 / 60.0 | 33.2 |

## 5. Server path (`geekchart/server`)

`renderToHtml`/`renderToSvg`, Node-only — fontkit measures text, no browser, no Playwright.

| | Node engine |
|---|---|
| cold start | 877.3ms (first render, cold module/font load) |
| warm miss (cache disabled) min/median/max | 14.1 / 18.4 / 26.2ms |
| cache hit min/median/max | 0.4 / 0.4 / 0.4ms |
| cold-cache full pass, all 37 fixtures, sequential | 1567.5ms |
| throughput at concurrency 1 (median) | 54.9 r/s |
| throughput at concurrency 4 (median) | 61.3 r/s |
| throughput at concurrency 8 (median) | 68.1 r/s |
| RSS after the throughput run | 591 MB |

Fixtures per pass/throughput run: 37. "min/median/max" over 10 sampled runs after 1 warmup run(s), same as every other section.

## 6. Bundle sizes (`packages/geekchart/dist`, lazy chunk from `.probe/` — mermaid/ELK resolved as a host bundler would)

| entry | raw | brotli |
|---|---|---|
| index.js | 1.0 kB | 0.6 kB |
| server.js | 3.3 kB | 1.5 kB |
| cli.js | 6.9 kB | 2.7 kB |
| **lazy chunk (21 files, fetched on first chart mount)** | **734.4 kB** | **196.8 kB** |
| further lazy (mermaid's own per-diagram-type chunks, 61 files) | 5250.6 kB | 1433.5 kB |

## Notes

- mermaid baseline skipped 1 fixture(s) it cannot render: messy

## Method

- Every number is min/median/max over 10 runs after 1 discarded warm-up, except a cold-cache pass, which cannot be repeated and stay cold.
- "4x CPU" is Chrome DevTools Protocol `Emulation.setCPUThrottlingRate({rate: 4})`.
- "Fast 3G" is `Network.emulateNetworkConditions` at 1.6 Mbps down, 150ms latency.
- Render time is measured inside the page (`performance.now()` around the call), not around the Node round trip, so Playwright IPC overhead is excluded.
- The mermaid baseline and its bundle size use the same "static-import closure from one entry point" method `packages/geekchart/build.mjs` uses for Geekchart's own lazy chunk, so the two numbers are comparable.

