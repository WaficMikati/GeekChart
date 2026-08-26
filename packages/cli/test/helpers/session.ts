import { after } from 'node:test';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSession, type Session } from '../../src/browser.ts';

/**
 * One Chromium session per test file, opened the first time a test asks for
 * it and closed once, after every test in the file has run.
 *
 * `canvas.test.mts`, `edges.test.mts`, `flow.test.mts` and `render.test.mts`
 * each used to call `openSession()` in their own `before()`, which calls
 * `chromium.launch()` — four full browser launches for one `pnpm test` run,
 * one per file. `packages/cli/scripts/shared-browser.mjs` launches Chromium
 * once for the whole run and passes its websocket endpoint down in
 * `GEEKCHART_TEST_WS_ENDPOINT`; when that is set, this connects to the
 * shared instance instead of launching a new one. Each file still gets its
 * own context and page — nothing here is shared *across* files, only the
 * one underlying browser process is. Run a single test file directly,
 * outside that wrapper, and this falls back to `openSession()`'s own
 * `chromium.launch()`, so the file still works alone.
 *
 * `after()` is registered unconditionally, at module load, so it is a
 * root-level hook for the file regardless of whether any test ends up
 * calling `getSession()` — registering it lazily, only once a session is
 * actually opened, attaches it to whichever hook happens to be running at
 * that moment instead of the file as a whole (verified: it fires right after
 * that hook, not after the last test). The laziness that matters — never
 * paying for a browser a file's tests don't use — lives in `sessions`
 * staying empty until the first `getSession()` call.
 */

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, '..', '..', 'dist', 'renderer.js');

const sessions = new Map<string, Promise<Session>>();

after(async () => {
  const opened = [...sessions.values()];
  sessions.clear();
  for (const promise of opened) {
    const session = await promise;
    await session.close();
  }
});

async function connectToSharedBrowser(
  endpoint: string,
  deviceScaleFactor: number,
  reducedMotion: 'no-preference' | 'reduce',
): Promise<Session> {
  if (!existsSync(bundle)) {
    throw new Error(`Renderer bundle missing. Run \`pnpm --filter @geekchart/cli build\` first.`);
  }
  const browser = await chromium.connect(endpoint);
  const context = await browser.newContext({ deviceScaleFactor, reducedMotion });
  const page = await context.newPage();
  await page.goto('about:blank');
  await page.addScriptTag({ path: bundle });
  return {
    page,
    browser,
    // `browser.close()` on a browser obtained via `connect()` (rather than
    // `launch()`) only ends this client's connection to the shared server —
    // it does not touch the server or any other file's session.
    close: async () => {
      await page.context().close();
      await browser.close();
    },
  };
}

/**
 * Get (opening it on first call) this file's session for a given
 * `(deviceScaleFactor, reducedMotion)` pair. Most files only ever need the
 * default pair; a file that also needs a `reduce`d-motion page (see
 * `flow.test.mts`'s reduced-motion test) gets a second, independent session
 * under its own key, opened only if that test actually runs.
 */
export function getSession(
  deviceScaleFactor = 1,
  reducedMotion: 'no-preference' | 'reduce' = 'no-preference',
): Promise<Session> {
  const key = `${deviceScaleFactor}:${reducedMotion}`;
  let promise = sessions.get(key);
  if (!promise) {
    const endpoint = process.env.GEEKCHART_TEST_WS_ENDPOINT;
    promise = endpoint
      ? connectToSharedBrowser(endpoint, deviceScaleFactor, reducedMotion)
      : openSession(deviceScaleFactor, reducedMotion);
    sessions.set(key, promise);
  }
  return promise;
}
