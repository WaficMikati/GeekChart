import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Memoize a render call across every test file in the run, not just within
 * one: `flow.test.mts` alone mounts `gitgraph.mmd` with the same default
 * options nine times, and `canvas.test.mts`/`edges.test.mts` render several
 * of the same fixtures too. Each of the four Playwright test files is its
 * own OS process (Node's default test isolation), so an in-memory cache
 * cannot cross files — this one is a small JSON file per (fixture, options)
 * pair on disk, which any of the sibling processes can hit.
 *
 * Keyed on the renderer bundle's own mtime, so a rebuild after a drawing-code
 * change can never serve a result the new code would draw differently — a
 * stale cache would fail silently otherwise, exactly the kind of thing this
 * codebase measures rather than trusts by eye.
 */

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, '..', '..', 'dist', 'renderer.js');
const cacheDir = join(here, '..', '..', '..', '..', 'node_modules', '.cache', 'geekchart-test-render');

const bundleStamp = existsSync(bundle) ? String(statSync(bundle).mtimeMs) : 'no-bundle';

function keyFor(kind: string, source: string, options: unknown): string {
  return createHash('sha1')
    .update(bundleStamp)
    .update(' ')
    .update(kind)
    .update(' ')
    .update(JSON.stringify(options ?? {}))
    .update(' ')
    .update(source)
    .digest('hex');
}

const memory = new Map<string, unknown>();

/**
 * `kind` namespaces the two functions under test (`renderAny` vs. the legacy
 * `render`) so an `AnyRequest` and a `RenderRequest` that happened to
 * serialise identically never collide.
 */
export async function cachedRender<T>(
  kind: string,
  source: string,
  options: unknown,
  compute: () => Promise<T>,
): Promise<T> {
  const key = keyFor(kind, source, options);
  const inMemory = memory.get(key);
  if (inMemory !== undefined) return inMemory as T;

  const file = join(cacheDir, `${key}.json`);
  if (existsSync(file)) {
    const value = JSON.parse(readFileSync(file, 'utf8')) as T;
    memory.set(key, value);
    return value;
  }

  const value = await compute();
  memory.set(key, value);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, JSON.stringify(value));
  return value;
}
