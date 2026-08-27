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

export interface RenderToSvgResult {
  svg: string;
  css: string;
  cycle: number;
  summary: string;
  repairs: RenderRepairNote[];
  warnings: string[];
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
 * rest (summary, repair notes, warnings) is a rounding error next to them. */
function sizeOfResult(value: RenderToSvgResult): number {
  return Buffer.byteLength(value.svg) + Buffer.byteLength(value.css) + 256;
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

function stripCache(options: RenderToSvgOptions): RenderRequest {
  const { cache: _cache, ...rest } = options;
  return rest;
}

/**
 * `renderNode`'s render, in the shape `renderToSvg` returns. `ChartError` is
 * `@geekchart/core`'s, caught here rather than let escape as a type this
 * package's own public API (`GeekchartRenderError`) does not declare a
 * static edge to.
 *
 * `@geekchart/core/node` is reached with a dynamic `import()`, not a static
 * one — see the note at the top of this file for why.
 */
async function renderWithNode(source: string, request: RenderRequest): Promise<RenderToSvgResult> {
  const { renderNode } = await import('../../core/src/node/render.ts');
  try {
    const r = await renderNode(source, request);
    return {
      svg: r.svg,
      css: r.css,
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
  const run = renderWithNode(source, request).then(async (result) => {
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
 * Render to a markup fragment ready to inline: a scoped `<style>` tag plus the
 * SVG, wrapped in one element so `scopeCss`'s `#id` selectors have something to
 * match. Two charts on the same page cannot collide, because each gets its own
 * id and its own renamed keyframes.
 */
export async function renderToHtml(
  source: string,
  options: RenderToSvgOptions = {},
): Promise<string> {
  const result = await renderToSvg(source, options);
  const { scopeCss } = await import('../../core/src/scope.ts');
  const id = `gc-${cacheKey(source, stripCache(options)).slice(0, 12)}`;
  return (
    `<div id="${id}" role="img" aria-label="${result.summary.replace(/"/g, '&quot;')}">` +
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
