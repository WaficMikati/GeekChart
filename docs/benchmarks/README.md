# Geekchart performance benchmarks

Generated 2026-08-27T19:25:00.058Z · min / median / max over 10 runs, 1 warm-up run discarded (a "cold cache" pass is a single measurement — see §5).

## Machine

- CPU: AMD Ryzen 9 5900HX with Radeon Graphics (16 logical cores)
- RAM: 15 GB
- OS: CachyOS (7.2.0-1-cachyos)
- Node: v24.16.0 · Chromium: 151.0.7922.34

## 1. Render time per chart

Desktop and 4x CPU throttling, via the built renderer (same bundle `gate.mjs` measures against), in ms.

| chart | family | desktop min/median/max | 4x CPU min/median/max |
|---|---|---|---|
| 4geeks-journey | flow | 13.3 / 15.8 / 25.2 | 48.2 / 51.3 / 59.9 |
| architecture | flow | 7.6 / 8.6 / 11.1 | 34.2 / 37.5 / 42.4 |
| blog/bootcamp-worth-it | quadrant | 1.9 / 2.3 / 3.3 | 8.3 / 8.9 / 10.1 |
| blog/first-ai-app | sequence | 3.1 / 3.7 / 4.7 | 14.1 / 15.7 / 24.2 |
| blog/geekforce-timeline | timeline | 3.1 / 3.4 / 3.7 | 12.3 / 13.7 / 14.7 |
| blog/incident-response | flow | 8.6 / 9.7 / 10.5 | 39.8 / 42.2 / 44.9 |
| blog/learn-js-plan | gantt | 2.1 / 2.5 / 5.6 | 9.0 / 10.3 / 13.0 |
| blog/outcomes-2024 | xy | 2.6 / 2.9 / 3.8 | 11.5 / 12.5 / 13.5 |
| blog/platform-layers | flow | 74.4 / 81.9 / 86.0 | 212.0 / 222.6 / 252.0 |
| blog/prompt-anatomy | flow | 6.2 / 6.8 / 7.9 | 28.6 / 30.5 / 32.0 |
| blog/pyenv-resolution | flow | 60.2 / 63.3 / 65.0 | 153.9 / 168.1 / 187.8 |
| blog/python-or-java | flow | 7.5 / 8.3 / 9.9 | 33.7 / 36.4 / 39.3 |
| blog/regex-engine | state | 12.8 / 14.1 / 20.0 | 59.1 / 60.7 / 65.6 |
| blog/rigobot-loop | sequence | 3.3 / 4.1 / 5.3 | 15.0 / 17.4 / 20.8 |
| class | class | 54.9 / 56.4 / 58.4 | 132.2 / 136.0 / 142.1 |
| control-plane | flow | 8.8 / 10.0 / 11.8 | 44.3 / 45.8 / 48.6 |
| er | er | 4.8 / 5.4 / 6.1 | 20.5 / 22.6 / 24.9 |
| flow | flow | 6.3 / 7.1 / 8.6 | 28.6 / 30.7 / 34.0 |
| gantt | gantt | 1.7 / 2.1 / 2.8 | 8.0 / 8.6 / 10.6 |
| gantt-states | gantt | 2.2 / 2.4 / 3.2 | 10.3 / 11.1 / 11.9 |
| gitgraph | gitgraph | 3.9 / 4.5 / 5.2 | 16.8 / 17.9 / 20.7 |
| journey | journey | 1.8 / 2.2 / 2.8 | 8.3 / 9.0 / 11.4 |
| kanban | kanban | 2.6 / 3.0 / 3.4 | 10.4 / 11.2 / 12.8 |
| messy | flow | 4.8 / 5.6 / 7.3 | 22.6 / 27.7 / 30.6 |
| mindmap | mindmap | 2.7 / 2.9 / 3.9 | 11.1 / 12.5 / 14.2 |
| org-chart | flow | 56.7 / 58.0 / 59.4 | 142.5 / 146.6 / 193.2 |
| pie | pie | 1.5 / 2.0 / 2.7 | 7.0 / 8.4 / 10.5 |
| quadrant | quadrant | 1.8 / 2.2 / 3.5 | 7.9 / 10.1 / 13.5 |
| radar | radar | 1.5 / 1.7 / 2.5 | 6.5 / 8.1 / 10.7 |
| sankey | sankey | 3.3 / 3.8 / 4.7 | 14.6 / 15.8 / 19.9 |
| sequence | sequence | 2.5 / 2.8 / 3.3 | 10.8 / 11.5 / 13.0 |
| sequence-rich | sequence | 3.3 / 3.8 / 4.9 | 14.9 / 16.0 / 17.1 |
| state | state | 6.9 / 7.6 / 8.9 | 30.9 / 32.4 / 35.3 |
| subgraphs | flow | 73.5 / 77.6 / 87.0 | 209.2 / 217.4 / 225.3 |
| timeline | timeline | 2.9 / 3.3 / 4.1 | 12.9 / 16.2 / 19.3 |
| treemap | treemap | 1.6 / 2.0 / 3.6 | 6.7 / 8.3 / 11.6 |
| xy | xy | 3.0 / 3.1 / 4.1 | 12.4 / 14.4 / 17.7 |

Per-family median (of per-chart medians), ms:

| family | n | desktop | 4x CPU |
|---|---|---|---|
| flow | 12 | 9.8 | 44.0 |
| quadrant | 2 | 2.2 | 9.5 |
| sequence | 4 | 3.7 | 15.8 |
| timeline | 2 | 3.3 | 14.9 |
| gantt | 3 | 2.4 | 10.3 |
| xy | 2 | 3.0 | 13.5 |
| state | 2 | 10.9 | 46.5 |
| class | 1 | 56.4 | 136.0 |
| er | 1 | 5.4 | 22.6 |
| gitgraph | 1 | 4.5 | 17.9 |
| journey | 1 | 2.2 | 9.0 |
| kanban | 1 | 3.0 | 11.2 |
| mindmap | 1 | 2.9 | 12.5 |
| pie | 1 | 2.0 | 8.4 |
| radar | 1 | 1.7 | 8.1 |
| sankey | 1 | 3.8 | 15.8 |
| treemap | 1 | 2.0 | 8.3 |

## 2. Mermaid baseline

mermaid's own `mermaid.render`, same fixtures, desktop only. Bundle: what a browser fetches eagerly to call it once (esbuild, code-split, only the static-import closure — the same method `packages/geekchart/build.mjs` uses for Geekchart's own lazy chunk): **136.0 kB brotli** (526.6 kB raw, 18 files).

| chart | family | desktop min/median/max |
|---|---|---|
| 4geeks-journey | flow | 30.9 / 33.0 / 43.8 |
| architecture | flow | 22.4 / 23.5 / 24.5 |
| blog/bootcamp-worth-it | quadrant | 1.8 / 2.3 / 3.6 |
| blog/first-ai-app | sequence | 5.4 / 6.1 / 8.5 |
| blog/geekforce-timeline | timeline | 7.5 / 9.7 / 14.3 |
| blog/incident-response | flow | 19.3 / 20.9 / 21.8 |
| blog/learn-js-plan | gantt | 3.3 / 3.8 / 6.5 |
| blog/outcomes-2024 | xy | 3.8 / 4.5 / 5.9 |
| blog/platform-layers | flow | 26.1 / 28.3 / 38.4 |
| blog/prompt-anatomy | flow | 16.5 / 18.7 / 23.9 |
| blog/pyenv-resolution | flow | 21.0 / 24.1 / 25.8 |
| blog/python-or-java | flow | 19.6 / 24.6 / 35.4 |
| blog/regex-engine | state | 41.1 / 43.3 / 45.2 |
| blog/rigobot-loop | sequence | 5.3 / 6.5 / 8.1 |
| class | class | 19.1 / 20.0 / 21.6 |
| control-plane | flow | 31.1 / 33.1 / 34.1 |
| er | er | 23.2 / 24.6 / 26.2 |
| flow | flow | 18.6 / 19.8 / 21.9 |
| gantt | gantt | 3.3 / 3.7 / 5.1 |
| gantt-states | gantt | 3.9 / 4.3 / 6.0 |
| gitgraph | gitgraph | 5.1 / 5.8 / 10.2 |
| journey | journey | 3.1 / 4.1 / 5.4 |
| kanban | kanban | 15.5 / 17.5 / 19.6 |
| mindmap | mindmap | 20.4 / 23.0 / 24.5 |
| org-chart | flow | 18.6 / 19.9 / 22.0 |
| pie | pie | 1.7 / 2.1 / 3.6 |
| quadrant | quadrant | 1.5 / 2.0 / 3.9 |
| radar | radar | 2.0 / 2.6 / 3.4 |
| sankey | sankey | 3.4 / 3.9 / 5.2 |
| sequence | sequence | 3.7 / 4.3 / 5.4 |
| sequence-rich | sequence | 5.2 / 6.3 / 8.0 |
| state | state | 21.9 / 24.4 / 27.1 |
| subgraphs | flow | 20.8 / 22.7 / 25.0 |
| timeline | timeline | 7.7 / 8.6 / 9.6 |
| treemap | treemap | 4.3 / 4.9 / 6.5 |
| xy | xy | 4.4 / 5.1 / 7.4 |

Skipped (mermaid could not render the source as-is): `messy`.

## 3. First-chart experience (Fast 3G + 4x CPU)

A minimal page mounting `<Geekchart source>` from the built `geekchart` package (React + ReactDOM + the component, esbuild-bundled, served brotli-compressed with far-future cache headers). Time from navigation to the chart's `svg.gc-chart` appearing.

| | min | median | max |
|---|---|---|---|
| cold (empty cache) | 8202.1ms | 8305.0ms | 8720.9ms |
| warm (2nd navigation) | 514.2ms | 537.2ms | 548.7ms |

Lighthouse (mobile preset, single run): performance score **0.39**, LCP 6618.9ms, TBT 902.0ms, CLS 0.

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

Both engines behind the same `renderToHtml`/`renderToSvg` API — `engine: 'node'` (the default: fontkit measures text, no browser) and `engine: 'browser'` (the shared headless Chromium session, kept for parity checks). Same measurements, run back to back in this same process.

| | Node engine | Browser engine |
|---|---|---|
| cold start | 468.3ms (first render, cold module/font load) | 1896.8ms (browser launch + first render) |
| warm miss (cache disabled) min/median/max | 13.0 / 15.2 / 20.4ms | 22.5 / 23.6 / 25.6ms |
| cache hit min/median/max | 0.4 / 0.4 / 0.4ms | 0.4 / 0.4 / 0.4ms |
| cold-cache full pass, all 37 fixtures, sequential | 1024.8ms | 1090.8ms |
| throughput at concurrency 1 (median) | 59.6 r/s | 45.3 r/s |
| throughput at concurrency 4 (median) | 67.2 r/s | 46.6 r/s |
| throughput at concurrency 8 (median) | 70.9 r/s | 46.7 r/s |
| RSS after the throughput run | Node 653 MB | Node 657 MB, Chromium 728 MB |

Fixtures per pass/throughput run: 37. "min/median/max" over 10 sampled runs after 1 warmup run(s), same as every other section.

## 6. Bundle sizes (`packages/geekchart/dist`)

| entry | raw | brotli |
|---|---|---|
| index.js | 1.0 kB | 0.6 kB |
| server.js | 4.1 kB | 1.8 kB |
| cli.js | 12.5 kB | 4.6 kB |
| **lazy chunk (20 files, fetched on first chart mount)** | **733.9 kB** | **196.5 kB** |
| further lazy (mermaid's own per-diagram-type chunks, 154 files) | 18409.3 kB | 4787.7 kB |

## Notes

- mermaid baseline skipped 1 fixture(s) it cannot render: messy

## Method

- Every number is min/median/max over 10 runs after 1 discarded warm-up, except a cold-cache pass, which cannot be repeated and stay cold.
- "4x CPU" is Chrome DevTools Protocol `Emulation.setCPUThrottlingRate({rate: 4})`.
- "Fast 3G" is `Network.emulateNetworkConditions` at 1.6 Mbps down, 150ms latency.
- Render time is measured inside the page (`performance.now()` around the call), not around the Node round trip, so Playwright IPC overhead is excluded.
- The mermaid baseline and its bundle size use the same "static-import closure from one entry point" method `packages/geekchart/build.mjs` uses for Geekchart's own lazy chunk, so the two numbers are comparable.

