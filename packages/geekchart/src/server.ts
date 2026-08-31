import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read once at module load, from `package.json` next to `src/` (running
 * straight from source, e.g. under `node --test`) or next to `dist/` (the
 * built, published package) — both sit one directory below this file's own
 * directory, so the same relative path resolves either way.
 */
const PACKAGE_VERSION: string = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0';
  } catch {
    return '0';
  }
})();

/**
 * `@geekchart/core`'s `scope.ts` and `node/render.ts` are reached only
 * through a dynamic `import()`, never a static one — not for laziness
 * (they're needed on every render), but because a *static* import of a
 * local file adds it to this package's TypeScript program, and
 * `declaration: true` then emits a mirrored `.d.ts` for it under `dist/` —
 * pulling a private, unpublished package's internal module layout into what
 * this package ships. A dynamic import used only for its value, inside a
 * function body, does not.
 */

/**
 * The renderer's options — the same shape as `@geekchart/cli`'s internal
 * `AnyRequest`, duplicated here on purpose rather than imported. That type
 * belongs to a private package with no declared public API; if this file
 * re-exported it structurally (`extends AnyRequest`), generating this
 * package's own `.d.ts` would need to also emit a declaration file for
 * `browser.ts` — and for every file *it* imports types from — pulling
 * `@geekchart/cli`'s internal module layout into this package's published
 * types. Duplication here is the price of a clean, self-contained API.
 */
export interface RenderRequest {
  scene?: 'manim' | 'geeks';
  motion?: boolean;
  width?: number;
  height?: number;
  aspect?: 'auto' | '16:9' | '1:1' | '4:5' | '9:16';
  fonts?: 'inherit' | { display?: string; label?: string; mono?: string; measureWith?: string };
  palette?: {
    bg?: string;
    ink?: string;
    quiet?: string;
    path?: string;
    alt?: string;
    accent?: string;
    edge?: string;
    surface?: string;
  };
  /**
   * DESIGN 8.4: `'loop'` repeats the build forever (the old default).
   * `'once'` plays it once and holds the finished frame. `'in-view'`
   * (the default) is the same single pass, held paused until a host calls
   * `geekchart/observe`'s `playInView()` and the chart is scrolled 40% into
   * view — a page that never calls it shows a paused chart to anyone whose
   * OS is not also asking for reduced motion. Ship to a page with no
   * JavaScript at all? Pass `'once'`.
   */
  play?: 'loop' | 'once' | 'in-view';
  /**
   * The width in CSS px the chart will be shown at — a blog column, a card.
   * The canvas never exceeds it (DESIGN 1.1): when the natural layout is
   * wider, leaf fans stack under their parent (1.5) and long chains fold
   * (1.2) before anything is scaled — and, past that, siblings still too
   * wide for the display wrap into more rows (1.6) — so 13-unit names stay
   * 13px on screen. Stamped on the svg as `data-display`. Default 1000
   * (boards 1200).
   *
   * A caller serving both a desktop and a phone layout of the same chart —
   * this file's own doc example is one — passes `{ desktop, phone }`
   * instead of a single number. Each width gets its own render, obeying
   * DESIGN 1.1's rules independently (a server rendering more than one
   * display width is exactly what that rule anticipates); `renderToSvg`
   * returns both under `variants`, and `renderToHtml` emits both `<svg>`s
   * with a media query that shows one and hides the other, switching at
   * 640px. See `renderToHtml`'s own doc comment for the exact markup.
   */
  display?: number | { desktop: number; phone: number };
  /**
   * DESIGN 8.6: stretch or hurry the whole build by one multiplier — `0.5`
   * plays at half speed, `2` at double, `1` (the default) is the designed
   * timing. Clamped to 0.25–4; nothing else about the motion changes (order,
   * easing and lag ratios all stay put). The svg carries `data-gc-speed`
   * whenever this is not 1. If `duration` is also given, `duration` wins and
   * this is ignored.
   */
  speed?: number;
  /**
   * DESIGN 8.6: the writer-facing form of `speed` — how many seconds the
   * build should take, rather than a multiplier. The chart's own natural
   * length is only known after a render, so `@geekchart/core`'s `render()`
   * renders once to learn it, derives the 8.6 multiplier (same 0.25–4
   * clamp), and renders again at that speed. Wins over `speed` when both are
   * given.
   */
  duration?: number;
}

/**
 * Node-side rendering, and only that — there is no browser path here.
 *
 * `@geekchart/core/node`'s `renderNode` measures text with fontkit reading
 * the embedded font files directly and installs a `linkedom` shim only for
 * mermaid's own parser, which still wants a `document`. No browser, no
 * Playwright, nothing to install: an app using `geekchart/server` never
 * needs Playwright at all. (Playwright stays in this repo as a *dev*
 * dependency, used by `packages/cli`'s review gallery, design gate, parity
 * test and benchmarks — none of that ships in the published package.)
 */

export interface RenderCache {
  get(key: string): RenderToSvgResult | undefined | Promise<RenderToSvgResult | undefined>;
  set(key: string, value: RenderToSvgResult): void | Promise<void>;
}

export interface RenderRepairNote {
  rule: string;
  message: string;
  count: number;
}

export interface RenderToSvgOptions extends RenderRequest {
  /**
   * Plug in your own store (Redis, `diskCache(...)`, an LRU keyed
   * differently — whatever the app already has). `false` skips caching
   * entirely. Left unset, an in-memory LRU shared across calls in this
   * process, bounded by `DEFAULT_CACHE_MAX_BYTES` (32 MB) rather than by
   * entry count.
   */
  cache?: RenderCache | false;
}

/** One rendered width, out of a `{ desktop, phone }` request — see
 *  `RenderToSvgResult.variants`. */
export interface RenderVariant {
  svg: string;
  css: string;
}

export interface RenderToSvgResult {
  /** The desktop variant's SVG when `display` was `{ desktop, phone }`;
   *  otherwise the only render there is. Kept at the top level (rather than
   *  only under `variants`) so a caller that never asked for two widths
   *  reads exactly the shape it always has. */
  svg: string;
  css: string;
  cycle: number;
  summary: string;
  repairs: RenderRepairNote[];
  warnings: string[];
  /** Present only when `display` was the `{ desktop, phone }` object form:
   *  both variants, individually addressable. `svg`/`css` above always equal
   *  `variants.desktop`. */
  variants?: { desktop: RenderVariant; phone: RenderVariant };
}

export class GeekchartRenderError extends Error {
  readonly line?: number;
  readonly excerpt?: string;
  constructor(detail: { message: string; line?: number; excerpt?: string }) {
    super(detail.message);
    this.name = 'GeekchartRenderError';
    this.line = detail.line;
    this.excerpt = detail.excerpt;
  }
}

/**
 * An LRU bounded by total bytes rather than entry count.
 *
 * A count-bounded cache treats a three-node diagram's markup the same as
 * `blog/platform-layers`'s (the heaviest fixture, ~40 KB of SVG + CSS), so a
 * workload with a few large, frequently-varied charts (different palettes,
 * widths, per-tenant options — anything that multiplies the cache key) fills
 * every slot with the biggest results it has seen and never accounts for how
 * much memory that actually is. Bounding by bytes caps the cache at a memory
 * budget regardless of what shape the results are.
 *
 * `Map` preserves insertion order, so re-inserting on every hit keeps the
 * least-recently-used entry first without a second data structure.
 */
export class ByteBoundedLru<V> {
  private readonly maxBytes: number;
  private readonly sizeOf: (value: V) => number;
  private readonly store = new Map<string, V>();
  private bytes = 0;
  constructor(maxBytes: number, sizeOf: (value: V) => number) {
    this.maxBytes = maxBytes;
    this.sizeOf = sizeOf;
  }
  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (hit === undefined) return undefined;
    this.store.delete(key);
    this.store.set(key, hit);
    return hit;
  }
  set(key: string, value: V): void {
    const existing = this.store.get(key);
    if (existing !== undefined) {
      this.bytes -= this.sizeOf(existing);
      this.store.delete(key);
    }
    this.store.set(key, value);
    this.bytes += this.sizeOf(value);
    // Never evict the entry we just inserted, even if it alone exceeds the
    // budget — a cache that always empties itself is not a cache.
    while (this.bytes > this.maxBytes && this.store.size > 1) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestValue = this.store.get(oldestKey) as V;
      this.store.delete(oldestKey);
      this.bytes -= this.sizeOf(oldestValue);
    }
  }
}

/** Default budget for the in-memory LRU — the one this module keeps for you,
 * and the one `diskCache` puts in front of its files. */
export const DEFAULT_CACHE_MAX_BYTES = 32 * 1024 * 1024; // 32 MB

/** The SVG and CSS strings dominate a result's size by a wide margin; the
 * rest (summary, repair notes, warnings) is a rounding error next to them.
 * `variants.phone` is counted too — `svg`/`css` above already equal
 * `variants.desktop`, so counting only the top level would silently miss
 * the second render's bytes for a `{ desktop, phone }` request. */
function sizeOfResult(value: RenderToSvgResult): number {
  return (
    Buffer.byteLength(value.svg) +
    Buffer.byteLength(value.css) +
    (value.variants ? Buffer.byteLength(value.variants.phone.svg) + Buffer.byteLength(value.variants.phone.css) : 0) +
    256
  );
}

/** Deterministic regardless of key order, so equivalent option objects hash
 * the same whichever order their fields were written in. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

/**
 * `sha256(version + source + options)`. The package version is folded in
 * automatically — a renderer upgrade (a drawing fix, a new animation) bumps
 * the version, and every cache (this process's default one, a disk cache, a
 * caller's own store) keys around it instead of serving a stale render next
 * to charts drawn by the new code. Nothing else about the key is treated as
 * invalidating: the same source and options at the same renderer version
 * always hash the same, and a cache entry never expires on its own.
 */
function cacheKey(source: string, options: RenderRequest): string {
  return createHash('sha256')
    .update(PACKAGE_VERSION)
    .update(' ')
    .update(source)
    .update(' ')
    .update(stableStringify(options))
    .digest('hex');
}

const defaultCache = new ByteBoundedLru<RenderToSvgResult>(DEFAULT_CACHE_MAX_BYTES, sizeOfResult);

const inflightByKey = new Map<string, Promise<unknown>>();

/**
 * DESIGN 8.6's clamp, duplicated rather than imported: a static import of
 * even one value from `@geekchart/core` here would pull mermaid and elkjs
 * into this package's `dist/server.js` a second time (see this file's own
 * top-of-file note on why `@geekchart/core` is only ever reached with a
 * dynamic `import()`), and `stripCache` below has to run synchronously,
 * before any render — and any dynamic import — has started. Kept in sync
 * with `animate.ts`'s `clampSpeed`.
 */
function clampSpeed(speed: number | undefined): number {
  if (speed === undefined || !Number.isFinite(speed)) return 1;
  return Math.min(4, Math.max(0.25, speed));
}

/**
 * Drop the `cache` field and normalize `play`'s default and `speed`'s clamp,
 * so two calls that differ only in "did not say `play`"/`speed` vs. saying
 * the value that means the same thing (`'in-view'`, `1`, or an out-of-range
 * number that clamps to what another call already named) hash to the same
 * cache key — and so an out-of-range `speed` is never cached under its own,
 * never-reused key.
 *
 * DESIGN 8.6: `duration` wins over `speed` when both are given (`@geekchart/
 * core`'s `render()` ignores `speed` in that case) — dropping `speed`
 * entirely from the key here, rather than just leaving it for `render()` to
 * ignore, means two calls that only differ in a `speed` that will not be
 * honoured still share one cache entry instead of rendering twice.
 */
function stripCache(options: RenderToSvgOptions): RenderRequest {
  const { cache: _cache, play, speed, duration, ...rest } = options;
  return duration !== undefined
    ? { ...rest, play: play ?? 'in-view', duration }
    : { ...rest, play: play ?? 'in-view', speed: clampSpeed(speed) };
}

/** `RenderRequest` with `display` narrowed to what `@geekchart/core` itself
 *  accepts — one width. `renderVariants`, below, is the only thing that
 *  ever sees the `{ desktop, phone }` object form; by the time a request
 *  reaches `renderWithNode` it has always been split into one render each. */
type SingleWidthRequest = Omit<RenderRequest, 'display'> & { display?: number };

/**
 * `renderNode`'s render, in the shape `renderToSvg` returns. `ChartError` is
 * `@geekchart/core`'s, caught here rather than let escape as a type this
 * package's own public API (`GeekchartRenderError`) does not declare a
 * static edge to.
 *
 * `@geekchart/core/node` is reached with a dynamic `import()`, not a static
 * one — see the note at the top of this file for why.
 */
async function renderWithNode(
  source: string,
  request: SingleWidthRequest,
): Promise<RenderToSvgResult> {
  const { renderNode } = await import('../../core/src/node/render.ts');
  try {
    const r = await renderNode(source, request);
    // DESIGN 8.4: charts no longer loop by default. `renderNode` draws every
    // native family through `flow.ts`, which has no `play` option of its own
    // (see `animate.ts`'s `applyPlayMode` for why) — applied here, once, on
    // the finished result instead.
    const { applyPlayMode } = await import('../../core/src/animate.ts');
    const play = request.play ?? 'in-view';
    const played = applyPlayMode({ svg: r.svg, css: r.css }, play);
    return {
      svg: played.svg,
      css: played.css,
      cycle: r.cycle,
      summary: r.summary,
      repairs: r.repairs,
      warnings: r.warnings,
    };
  } catch (err) {
    const { ChartError } = await import('../../core/src/chart-error.ts');
    if (err instanceof ChartError) throw new GeekchartRenderError(err.detail);
    throw new GeekchartRenderError({ message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * DESIGN 1.1: "a server may render a chart for more than one display width;
 * each variant obeys the rules at its own width." A plain number (or no
 * `display` at all) renders once, same as always; the `{ desktop, phone }`
 * object form renders both, independently — each is its own call into
 * `renderWithNode`, so a 358px phone column and a 1000px desktop column
 * pack, wrap and scale on their own terms (DESIGN 1.5/1.6 for one do not
 * have to also fit the other).
 */
async function renderVariants(source: string, request: RenderRequest): Promise<RenderToSvgResult> {
  if (request.display && typeof request.display === 'object') {
    const { desktop, phone } = request.display;
    const [d, p] = await Promise.all([
      renderWithNode(source, { ...request, display: desktop }),
      renderWithNode(source, { ...request, display: phone }),
    ]);
    return {
      svg: d.svg,
      css: d.css,
      cycle: d.cycle,
      summary: d.summary,
      repairs: d.repairs,
      warnings: [...d.warnings, ...p.warnings],
      variants: { desktop: { svg: d.svg, css: d.css }, phone: { svg: p.svg, css: p.css } },
    };
  }
  return renderWithNode(source, request as SingleWidthRequest);
}

/** Render mermaid source to an animated SVG. Results are cached by
 * `sha256(version + source + options)`, so a page rendering the same chart on
 * every request pays for the render once. */
export async function renderToSvg(
  source: string,
  options: RenderToSvgOptions = {},
): Promise<RenderToSvgResult> {
  const request = stripCache(options);
  const cache = options.cache === false ? undefined : (options.cache ?? defaultCache);
  const key = cache ? cacheKey(source, request) : '';

  if (cache) {
    const hit = await cache.get(key);
    if (hit) return hit;
  }

  // Each render is independent, in-process work — there is no shared page to
  // serialise through. Still deduplicated by key: two callers asking for the
  // same chart at once share one render.
  const inflight = inflightByKey.get(key || source);
  if (inflight) return inflight as Promise<RenderToSvgResult>;
  const run = renderVariants(source, request).then(async (result) => {
    if (cache) await cache.set(key, result);
    return result;
  });
  if (key) inflightByKey.set(key, run);
  try {
    return await run;
  } finally {
    if (key) inflightByKey.delete(key);
  }
}

/**
 * Wraps a rendered `<svg>` in its variant's own element. The variant marker
 * has to sit *above* the svg, not on it: every rule of the variant's
 * stylesheet is scoped as a descendant of `[data-gc-variant]`, and that
 * includes DESIGN 8.4's "stay paused until scrolled to" rule, whose subject
 * is the svg itself (`[data-gc-play="in-view"]`). Stamped on the svg, that
 * rule asked for an svg *inside* the svg and never matched — both variants
 * played on page load, and the reader reached a finished chart.
 * `geekchart/observe` still finds the svg by `data-gc-play`; a hidden
 * wrapper never intersects, so the hidden variant never starts.
 */
function wrapVariant(svg: string, variant: 'desktop' | 'phone'): string {
  return `<div data-gc-variant="${variant}">${svg}</div>`;
}

/**
 * Render to a markup fragment ready to inline: a scoped `<style>` tag plus the
 * SVG, wrapped in one element so `scopeCss`'s `#id` selectors have something to
 * match. Two charts on the same page cannot collide, because each gets its own
 * id and its own renamed keyframes.
 *
 * A `{ desktop, phone }` `display` (DESIGN 1.1) emits both `<svg>`s instead
 * of one, each in a `data-gc-variant` wrapper, plus a media query — under 640px
 * CSS px the phone one shows and the desktop one hides; at 640px and above,
 * the reverse:
 *
 * ```html
 * <div id="gc-…">
 *   <style>
 *     #gc-… [data-gc-variant="desktop"] { display: block; }
 *     #gc-… [data-gc-variant="phone"]   { display: none; }
 *     @media (max-width: 640px) {
 *       #gc-… [data-gc-variant="desktop"] { display: none; }
 *       #gc-… [data-gc-variant="phone"]   { display: block; }
 *     }
 *     …
 *   </style>
 *   <div data-gc-variant="desktop"><svg …>…</svg></div>
 *   <div data-gc-variant="phone"><svg …>…</svg></div>
 * </div>
 * ```
 *
 * Each variant's CSS is scoped under its own `data-gc-variant` selector with
 * its own renamed `@keyframes` (a distinct id per variant, not the shared
 * wrapper id) — the two SVGs are different geometry from different renders,
 * so a name collision between their keyframes would leave one variant
 * playing the other's motion.
 */
export async function renderToHtml(
  source: string,
  options: RenderToSvgOptions = {},
): Promise<string> {
  const result = await renderToSvg(source, options);
  const { scopeCss } = await import('../../core/src/scope.ts');
  const id = `gc-${cacheKey(source, stripCache(options)).slice(0, 12)}`;
  const label = result.summary.replace(/"/g, '&quot;');

  if (result.variants) {
    const { desktop, phone } = result.variants;
    const desktopSel = `#${id} [data-gc-variant="desktop"]`;
    const phoneSel = `#${id} [data-gc-variant="phone"]`;
    const mediaQuery =
      `${desktopSel}{display:block}${phoneSel}{display:none}` +
      `@media (max-width:640px){${desktopSel}{display:none}${phoneSel}{display:block}}`;
    return (
      `<div id="${id}" role="img" aria-label="${label}">` +
      `<style>${mediaQuery}` +
      `${scopeCss(desktop.css, `${id}-d`, desktopSel)}` +
      `${scopeCss(phone.css, `${id}-p`, phoneSel)}</style>` +
      `${wrapVariant(desktop.svg, 'desktop')}${wrapVariant(phone.svg, 'phone')}` +
      `</div>`
    );
  }

  return (
    `<div id="${id}" role="img" aria-label="${label}">` +
    `<style>${scopeCss(result.css, id)}</style>${result.svg}</div>`
  );
}

// ---------------------------------------------------------------- disk cache

export interface DiskCacheOptions {
  /** Directory to store one JSON file per cache key in. Created if missing. */
  dir: string;
  /** Budget for the in-memory layer in front of the files, in bytes.
   * Default `DEFAULT_CACHE_MAX_BYTES` (32 MB). The files on disk are
   * unbounded — a disk is cheap and the whole point of this cache is to
   * survive a process restart, so nothing here evicts them for you. */
  maxBytes?: number;
}

/**
 * A `RenderCache` backed by one JSON file per key, with an in-memory
 * `ByteBoundedLru` in front so a hot chart never touches the disk twice in a
 * row.
 *
 * **What's cached:** exactly what `renderToSvg` returns — `{ svg, css,
 * cycle, summary, repairs, warnings }` — under the same
 * `sha256(version + source + options)` key `renderToSvg` always uses (see
 * `cacheKey` above). Two apps pointed at the same `dir` with the same
 * `geekchart` version share hits.
 *
 * **When it's invalidated:** never, by design — the key *is* the content, so
 * there is nothing to go stale. The one thing that must invalidate it is a
 * renderer upgrade (a drawing or animation fix changes what the same source
 * should produce), and that is handled automatically: the installed
 * `geekchart` package's own version is folded into every key, so upgrading
 * the package starts writing under a new set of keys and old files are
 * simply never read again. Nothing here deletes the orphaned files —
 * clearing `dir` on upgrade is a deploy-time decision, not this module's.
 *
 * **Atomicity:** each write goes to a temp file beside the target
 * (`<key>.json.<pid>.<random>.tmp`) and is `rename`d into place, so a reader
 * racing a writer — another process, or a concurrent `warm()` worker — never
 * observes a half-written file; `rename` within one directory is atomic on
 * every platform Node runs this on.
 *
 * ```ts
 * import { renderToHtml, diskCache } from 'geekchart/server';
 * import express from 'express';
 *
 * const cache = diskCache({ dir: '.geekchart-cache' });
 * const app = express();
 * app.get('/posts/:slug', async (req, res) => {
 *   const post = await loadPost(req.params.slug);
 *   res.send(await renderToHtml(post.diagram, { cache }));
 * });
 * ```
 */
export function diskCache(options: DiskCacheOptions): RenderCache {
  const { dir, maxBytes = DEFAULT_CACHE_MAX_BYTES } = options;
  const memory = new ByteBoundedLru<RenderToSvgResult>(maxBytes, sizeOfResult);
  const ready = mkdir(dir, { recursive: true });

  function fileFor(key: string): string {
    return join(dir, `${key}.json`);
  }

  return {
    async get(key: string): Promise<RenderToSvgResult | undefined> {
      const hit = memory.get(key);
      if (hit) return hit;
      await ready;
      try {
        const raw = await readFile(fileFor(key), 'utf8');
        const value = JSON.parse(raw) as RenderToSvgResult;
        memory.set(key, value);
        return value;
      } catch {
        return undefined;
      }
    },
    async set(key: string, value: RenderToSvgResult): Promise<void> {
      memory.set(key, value);
      await ready;
      const file = fileFor(key);
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, JSON.stringify(value));
      await rename(tmp, file);
    },
  };
}

// --------------------------------------------------------------------- warm

export interface WarmResult {
  /** Actually rendered (a cache miss when `warm` looked, or caching off). */
  rendered: number;
  /** Already in the cache when `warm` looked — no render needed. */
  cached: number;
  /** Threw. `warm` does not stop for these; it keeps going and counts them. */
  failed: number;
}

async function* toAsyncIterable(sources: string[] | AsyncIterable<string>): AsyncIterable<string> {
  if (Array.isArray(sources)) {
    for (const s of sources) yield s;
  } else {
    yield* sources;
  }
}

/**
 * Render and cache a list of sources ahead of time — a build step or a
 * deploy hook that wants the first real visitor to hit a warm cache instead
 * of paying for a render on the request path.
 *
 * Takes the same `options` (including `cache`) `renderToSvg` does, so pass
 * `{ cache: diskCache({ dir }) }` to warm a persistent cache. Runs up to
 * `concurrency` renders at once (default 4).
 */
export async function warm(
  sources: string[] | AsyncIterable<string>,
  options: RenderToSvgOptions = {},
  concurrency = 4,
): Promise<WarmResult> {
  const cache = options.cache === false ? undefined : (options.cache ?? defaultCache);
  const request = stripCache(options);
  const iterator = toAsyncIterable(sources)[Symbol.asyncIterator]();
  let rendered = 0;
  let cached = 0;
  let failed = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const { value: source, done } = await iterator.next();
      if (done) return;
      try {
        const alreadyCached = cache ? Boolean(await cache.get(cacheKey(source, request))) : false;
        await renderToSvg(source, options);
        if (alreadyCached) cached++;
        else rendered++;
      } catch {
        failed++;
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, worker);
  await Promise.all(workers);
  return { rendered, cached, failed };
}
