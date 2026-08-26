#!/usr/bin/env node
/**
 * Run `node --test <args>` against one shared Chromium instead of the four
 * separate launches `canvas.test.mts`, `edges.test.mts`, `flow.test.mts` and
 * `render.test.mts` used to pay for (one `chromium.launch()` each, in
 * `before()`).
 *
 * This launches a single Chromium *server* and hands its websocket endpoint
 * to the `node --test` child process via `GEEKCHART_TEST_WS_ENDPOINT`.
 * `packages/cli/test/helpers/session.ts` reads that variable and calls
 * `chromium.connect()` instead of `chromium.launch()`. Node's test runner
 * still isolates each test *file* in its own process by default — that is
 * what lets the four files run concurrently — so each one gets its own
 * context and page from its own connection; only the underlying browser
 * binary is shared, which is the expensive part.
 *
 * No `--test-concurrency` is added here: this repo's `pnpm test` spans 12
 * files across 4 packages, and default (uncapped) concurrency measured as
 * fast as or faster than every explicit cap tried (3, 4, 6, 8, 10) — capping
 * below the file count only serialises files that could have run together.
 *
 * Usage: node scripts/shared-browser.mjs <args to pass to `node --test`>
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const server = await chromium.launchServer();
const wsEndpoint = server.wsEndpoint();

const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, GEEKCHART_TEST_WS_ENDPOINT: wsEndpoint },
});

const exitCode = await new Promise((resolve) => {
  child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 1)));
  child.on('error', () => resolve(1));
});

await server.close();
process.exit(exitCode);
