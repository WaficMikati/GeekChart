import { chromium, type Browser, type Page } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, '..', 'dist', 'renderer.js');

export interface RenderRequest {
  theme: 'light' | 'dark';
  style: 'blueprint' | 'surface' | 'press';
  animation: { preset: string; stagger: number; duration: number; delay: number };
  width: number;
  panel: boolean;
  title?: string;
  subtitle?: string;
  webFonts?: boolean;
  interactive?: boolean;
}

export type RenderReply =
  | {
      ok: true;
      svg: string;
      svgDocument: string;
      html: string;
      runtime: number;
      repairs: { rule: string; message: string; count: number }[];
      diagram: string;
      parts: number;
    }
  | { ok: false; error: { message: string; line?: number; excerpt?: string } };

export interface AnyRequest {
  scene?: 'manim' | 'geeks';
  motion?: boolean;
  width?: number;
  height?: number;
  /** DESIGN 1.1/1.5: the width, in CSS px, this chart will actually be shown at. */
  display?: number;
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

export type AnyReply =
  | {
      ok: true;
      path: 'flow' | 'legacy';
      svg: string;
      css: string;
      svgFile: string;
      html: string;
      repairs: { rule: string; message: string; count: number }[];
      cycle: number;
      diagram: string;
      nodes: number;
      edges: number;
      summary: string;
      warnings: string[];
    }
  | { ok: false; error: { message: string; line?: number; excerpt?: string } };

export interface Session {
  page: Page;
  browser: Browser;
  close(): Promise<void>;
}

/**
 * A fresh context + page on `browser`, with the renderer bundle already
 * injected. Factored out of `openSession` so a long-running session can be
 * recycled onto a new page without relaunching Chromium — see `recyclePage`.
 *
 * `reducedMotion: 'no-preference'` is deliberate: the exported animation hides
 * itself behind that media query for accessibility, and the capture is the one
 * context where we must override the preference to see it.
 */
async function launchPage(
  browser: Browser,
  deviceScaleFactor: number,
  reducedMotion: 'no-preference' | 'reduce',
): Promise<Page> {
  const context = await browser.newContext({ deviceScaleFactor, reducedMotion });
  const page = await context.newPage();
  await page.goto('about:blank');
  await page.addScriptTag({ path: bundle });
  return page;
}

export async function openSession(
  deviceScaleFactor = 1,
  reducedMotion: 'no-preference' | 'reduce' = 'no-preference',
): Promise<Session> {
  if (!existsSync(bundle)) {
    throw new Error(`Renderer bundle missing. Run \`pnpm --filter @geekchart/cli build\` first.`);
  }
  const browser = await chromium.launch();
  const page = await launchPage(browser, deviceScaleFactor, reducedMotion);
  return {
    page,
    browser,
    close: async () => {
      await page.context().close();
      await browser.close();
    },
  };
}

/**
 * Replace a long-lived session's page with a fresh one on the same browser.
 *
 * A page that renders hundreds of charts in a row accumulates DOM nodes,
 * decoded font glyphs and compositor layers even when every render tidies up
 * its own markup (each `renderChart`/`renderFlow` call removes its own host
 * element) — none of that is *our* markup, it's Chromium's own bookkeeping
 * for a page that has been alive a long time. Recycling discards it for the
 * cost of one new context, far cheaper than relaunching the browser.
 *
 * Closes the *context* the old page belongs to, not just the page: closing
 * only the page leaves its (now pageless) context around forever, which is a
 * slower version of the same leak. The new page is created before the old one
 * closes, so a server serialising renders through this never has a moment
 * with no page to hand out.
 */
export async function recyclePage(
  browser: Browser,
  page: Page,
  deviceScaleFactor = 1,
  reducedMotion: 'no-preference' | 'reduce' = 'no-preference',
): Promise<Page> {
  const fresh = await launchPage(browser, deviceScaleFactor, reducedMotion);
  await page.context().close();
  return fresh;
}

/**
 * Call the renderer inside the page.
 *
 * `window.geekchartRender` is declared by the browser bundle, which sits in a
 * different TypeScript program — hence the cast, rather than a second global
 * declaration that would conflict with the real one.
 */
export async function render(
  page: Page,
  source: string,
  options: RenderRequest,
): Promise<RenderReply> {
  return page.evaluate(
    ([src, opts]) =>
      (
        window as unknown as {
          geekchartRender: (s: string, o: unknown) => Promise<unknown>;
        }
      ).geekchartRender(src as string, opts),
    [source, options] as const,
  ) as Promise<RenderReply>;
}

/**
 * The unified path: flowcharts are drawn by our own renderer, every other
 * diagram type falls back to mermaid's with the older restyling layer.
 */
export async function renderAny(
  page: Page,
  source: string,
  options: AnyRequest,
): Promise<AnyReply> {
  return page.evaluate(
    ([src, opts]) =>
      (
        window as unknown as { geekchartAny: (s: string, o: unknown) => Promise<unknown> }
      ).geekchartAny(src as string, opts),
    [source, options] as const,
  ) as Promise<AnyReply>;
}

/**
 * Bake an already-rendered chart into a React component.
 *
 * Runs in the page rather than in node because the emitter lives in core, which
 * the CLI only ever loads inside the browser — the same rule that keeps the
 * preview and the video from drifting applies here too.
 */
export async function bakeReact(
  page: Page,
  input: {
    fileName: string;
    svg: string;
    css: string;
    summary: string;
    source?: string;
    meta?: string;
    javascript?: boolean;
    inherited?: boolean;
    measuredWith?: string;
  },
): Promise<string> {
  return page.evaluate(
    (arg) => (window as unknown as { geekchartReact: (i: unknown) => string }).geekchartReact(arg),
    input,
  );
}
