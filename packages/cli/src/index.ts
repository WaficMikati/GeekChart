import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { bakeReact, openSession, renderAny, type AnyRequest } from './browser.ts';
import { captureStill, captureVideo } from './capture.ts';

/**
 * Same string as `@geekchart/core`'s `SYSTEM_STACK` (`scene.ts`), duplicated
 * rather than imported: `@geekchart/core` also carries mermaid and elkjs, and
 * this file is Node-side CLI code bundled into `geekchart`'s published
 * `dist/cli.js` — a static import of even one constant from the barrel would
 * pull that whole graph in a second time, next to the copy already shipped in
 * `dist/renderer.js`. See `packages/geekchart/src/browser.ts` for the same
 * trade-off made the same way.
 */
const SYSTEM_STACK =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const USAGE = `
geekchart — turn a mermaid chart into gorgeous animated diagrams

  geekchart <input.mmd> -o <output>        (- reads stdin)

The output extension picks the format:
  .html   self-contained page; animates with no JavaScript, fonts embedded
  .svg    portable vector
  .png    still of the finished diagram
  .mp4 .gif .webm   video, rendered frame by frame
  .tsx .jsx         React component; no dependencies, no client JavaScript

Options
  -o, --out <file>       output path            (default: alongside the input)
      --scene <name>     geeks | manim          (default: geeks)
      --no-motion        draw the finished frame with no animation
      --width <px>       frame width            (default: 1400)
      --height <px>      frame height           (default: 800)
      --aspect <ratio>   auto | 16:9 | 1:1 | 4:5 | 9:16   (default: auto)
                         pads the diagram into a fixed posting frame

Colour
      --palette <json>   {"path":"#0084FF","alt":"#FFB718"} — override any of the
                         seven colours; anything left out keeps the scene's value
      --color-<name> <hex>     bg ink quiet path alt accent edge surface
                         e.g. --color-path "#FF3366" --color-bg "#0B0F14"

Fonts
      --fonts <spec>     embedded | inherit | "<css font stack>"
                         inherit hands every role to the page the chart lands in.
                         React output inherits by default; every other format
                         uses the embedded faces, being self-contained.
      --font-display <stack>   titles and names
      --font-label <stack>     captions, edge labels, cardinalities
      --font-mono <stack>      class members and entity columns
      --measure-with <stack>   what "inherit" is measured against — set this to
                         the font stack of the page the chart will live in, or
                         its boxes will be sized for the wrong text
      --fps <n>          video frame rate       (default: 30)
      --scale <n>        pixel density          (default: 2)
      --lead <s>         still seconds before   (default: 0)
      --hold <s>         still seconds after    (default: 0)
      --quiet            only print the output path

      --engine <name>    node | browser
                         .tsx/.jsx/.svg draw with the Node engine by default —
                         fontkit measures text, no Playwright needed. .html,
                         .png and video still draw and capture in a real
                         headless browser; .png/.mp4/.gif/.webm always do,
                         since capturing a frame needs one regardless of how
                         the chart was measured. Pass --engine=browser on a
                         .tsx/.jsx/.svg export to use the old path instead —
                         useful for checking the two engines still agree.

Fourteen types are drawn by geekchart's own renderer: flowchart, state, class,
ER, sequence, timeline, gantt, journey, quadrant, radar, xy, sankey, treemap and
kanban. Pie, mindmap and gitgraph still go through mermaid's, and ignore --scene.
`;

const SCENES = ['manim', 'geeks'];
const ASPECTS = ['auto', '16:9', '1:1', '4:5', '9:16'];

function fail(message: string): never {
  process.stderr.write(`\ngeekchart: ${message}\n`);
  process.exit(1);
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    fail('could not read stdin');
  }
}

export async function main(argv: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: 'string', short: 'o' },
        scene: { type: 'string', default: 'geeks' },
        // node's parseArgs has no negation support, so the flag the help
        // advertises has to be declared under its literal name.
        'no-motion': { type: 'boolean', default: false },
        aspect: { type: 'string', default: 'auto' },
        palette: { type: 'string' },
        'color-bg': { type: 'string' },
        'color-ink': { type: 'string' },
        'color-quiet': { type: 'string' },
        'color-path': { type: 'string' },
        'color-alt': { type: 'string' },
        'color-accent': { type: 'string' },
        'color-edge': { type: 'string' },
        'color-surface': { type: 'string' },
        fonts: { type: 'string' },
        'font-display': { type: 'string' },
        'font-label': { type: 'string' },
        'font-mono': { type: 'string' },
        'measure-with': { type: 'string' },
        width: { type: 'string', default: '1400' },
        height: { type: 'string', default: '800' },
        fps: { type: 'string', default: '30' },
        scale: { type: 'string', default: '2' },
        lead: { type: 'string', default: '0' },
        hold: { type: 'string', default: '0' },
        quiet: { type: 'boolean', default: false },
        engine: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    process.exit(positionals.length === 0 && !values.help ? 1 : 0);
  }

  const input = positionals[0]!;
  const source = input === '-' ? readStdin() : readFileSync(resolve(input), 'utf8');

  if (!ASPECTS.includes(values.aspect!)) {
    fail(`--aspect must be one of ${ASPECTS.join(', ')}, got "${values.aspect}"`);
  }

  if (!SCENES.includes(values.scene!)) {
    fail(`--scene must be one of ${SCENES.join(', ')}, got "${values.scene}"`);
  }

  const number = (name: string, raw: string, min: number, max: number): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      fail(`--${name} must be a number between ${min} and ${max}, got "${raw}"`);
    }
    return n;
  };

  const fps = number('fps', values.fps!, 1, 120);
  const scale = number('scale', values.scale!, 1, 4);
  const width = number('width', values.width!, 200, 4000);
  const height = number('height', values.height!, 150, 4000);
  const lead = number('lead', values.lead!, 0, 30);
  const hold = number('hold', values.hold!, 0, 30);

  const output = resolve(
    values.out ?? (input === '-' ? 'chart.html' : input.replace(/\.[^.]+$/, '') + '.html'),
  );
  const format = extname(output).slice(1).toLowerCase();
  const known = ['html', 'svg', 'png', 'mp4', 'gif', 'webm', 'tsx', 'jsx'];
  if (!known.includes(format)) {
    fail(`do not know how to write "${format}" files. Try one of: ${known.join(', ')}`);
  }

  const log = (line: string) => {
    if (!values.quiet) process.stderr.write(line + '\n');
  };

  const isVideo = format === 'mp4' || format === 'gif' || format === 'webm';
  const isReact = format === 'tsx' || format === 'jsx';

  /**
   * Which engine draws the chart.
   *
   * `.tsx`/`.jsx`/`.svg` need nothing beyond the SVG/CSS strings `render()`
   * hands back, so they draw with the Node engine (fontkit measures text, no
   * browser) by default. `.html`, `.png` and video still default to the
   * browser: `.html` because its default output has always been the
   * browser-measured one and nothing forces a change, `.png`/video because
   * capturing a frame needs a real browser regardless of which engine drew
   * the SVG — there is no Node-side screenshot or video encoder here.
   * `--engine` overrides the default for every format except the captured
   * ones, where `node` is rejected outright rather than silently ignored.
   */
  if (values.engine && values.engine !== 'node' && values.engine !== 'browser') {
    fail(`--engine must be "node" or "browser", got "${values.engine}"`);
  }
  const captured = isVideo || format === 'png';
  if (values.engine === 'node' && captured) {
    fail(
      `--engine=node cannot produce .${format} — capturing a frame still needs a real browser ` +
        `regardless of which engine drew the chart. Drop --engine, or pass --engine=browser.`,
    );
  }
  const engine: 'node' | 'browser' =
    (values.engine as 'node' | 'browser' | undefined) ??
    (captured || format === 'html' ? 'browser' : 'node');
  const needsSession = engine === 'browser' || captured;

  /**
   * Turn the font flags into an override, if any were given.
   *
   * A React component defaults to inheriting because it renders inside someone
   * else's page, where matching the surrounding text is almost always right and
   * shipping a typeface almost always is not. Every other format is a
   * self-contained artefact we control completely, so it keeps the real faces.
   */
  /**
   * Colour overrides, from JSON or from individual flags.
   *
   * Individual flags win over the JSON blob, so a saved palette can be reused
   * and then tweaked on one axis without editing it.
   */
  const palette = ((): AnyRequest['palette'] => {
    const NAMES = ['bg', 'ink', 'quiet', 'path', 'alt', 'accent', 'edge', 'surface'] as const;
    let base: Record<string, unknown> = {};
    if (values.palette) {
      try {
        base = JSON.parse(values.palette) as Record<string, unknown>;
      } catch {
        fail(`--palette must be JSON, got ${values.palette}`);
      }
      const unknown = Object.keys(base).filter((k) => !NAMES.includes(k as never));
      if (unknown.length) {
        fail(`--palette has no colour named ${unknown.join(', ')}. Try: ${NAMES.join(', ')}`);
      }
    }
    for (const name of NAMES) {
      const flag = values[`color-${name}`];
      if (flag) base[name] = flag;
    }
    for (const [name, value] of Object.entries(base)) {
      if (typeof value !== 'string' || !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
        fail(`--color-${name} must be a hex colour like "#0084FF", got ${JSON.stringify(value)}`);
      }
    }
    return Object.keys(base).length ? (base as AnyRequest['palette']) : undefined;
  })();

  const fonts = ((): AnyRequest['fonts'] => {
    const all = values.fonts;
    const spread = all && all !== 'embedded' ? (all === 'inherit' ? 'inherit' : all) : undefined;
    // Only these three choose a typeface. `--measure-with` says what `inherit`
    // should be measured against, which is a different question — passing it
    // alone used to be read as "use the embedded faces", the opposite of what it
    // asks for.
    const roles = {
      ...(spread ? { display: spread, label: spread, mono: spread } : {}),
      ...(values['font-display'] ? { display: values['font-display'] } : {}),
      ...(values['font-label'] ? { label: values['font-label'] } : {}),
      ...(values['font-mono'] ? { mono: values['font-mono'] } : {}),
    };
    const chose = Object.keys(roles).length > 0;
    if (!chose && !(isReact && all !== 'embedded')) return undefined;
    const spec = chose ? roles : { display: 'inherit', label: 'inherit', mono: 'inherit' };
    if (!Object.values(spec).includes('inherit')) return spec;
    // The CLI is the one caller that measures in one document and displays in
    // another, so it is the one that has to name a stack. Left unset, an
    // inherited chart would be measured against this blank page's default serif
    // and then shown in whatever the destination uses.
    return { ...spec, measureWith: values['measure-with'] ?? SYSTEM_STACK };
  })();
  const session = needsSession ? await openSession(isVideo || format === 'png' ? scale : 1) : undefined;
  try {
    const renderOptions = {
      scene: values.scene as 'manim' | 'geeks',
      aspect: values.aspect as 'auto' | '16:9' | '1:1' | '4:5' | '9:16',
      ...(fonts ? { fonts } : {}),
      ...(palette ? { palette } : {}),
      // A still frame has nothing to animate, so motion is skipped for it.
      motion: !values['no-motion'] && format !== 'png' && format !== 'svg',
      width,
      height,
    };
    // `renderNode`'s thrown `ChartError` is mapped to the same `{ ok: false,
    // error }` shape `renderAny` returns, so everything below this — error
    // reporting, repairs, warnings — reads one shape regardless of engine.
    const reply =
      engine === 'node'
        ? await (async () => {
            const { renderNode } = await import('../../core/src/node/render.ts');
            try {
              return { ok: true as const, ...(await renderNode(source, renderOptions)) };
            } catch (err) {
              const { ChartError } = await import('../../core/src/chart-error.ts');
              return {
                ok: false as const,
                error:
                  err instanceof ChartError
                    ? err.detail
                    : { message: err instanceof Error ? err.message : String(err) },
              };
            }
          })()
        : await renderAny(session!.page, source, renderOptions);

    if (!reply.ok) {
      const where = reply.error.line ? ` on line ${reply.error.line}` : '';
      process.stderr.write(
        `\ngeekchart: could not draw this chart${where}\n\n  ${reply.error.message.replace(/\n/g, '\n  ')}\n`,
      );
      if (reply.error.excerpt)
        process.stderr.write(`\n  ${reply.error.line}: ${reply.error.excerpt}\n`);
      process.stderr.write('\n');
      process.exit(2);
    }

    for (const note of reply.repairs) log(`  fixed: ${note.message}`);
    for (const warning of reply.warnings) {
      process.stderr.write(`\ngeekchart: ${warning}\n\n`);
    }
    const pipeline = reply.path === 'flow' ? 'drawn' : 'mermaid';
    log(
      `  ${reply.diagram} · ${reply.nodes} nodes · ${reply.edges} edges · ` +
        `${reply.cycle > 0 ? `${reply.cycle.toFixed(1)}s loop` : 'static'} · ${pipeline} · ${engine} engine`,
    );

    if (isReact) {
      const bakeInput = {
        fileName: output,
        svg: reply.svg,
        css: reply.css,
        summary: reply.summary,
        source: input === '-' ? undefined : input,
        meta:
          `${reply.diagram} · ${reply.nodes} nodes · ${reply.edges} edges · ` +
          `${reply.cycle > 0 ? `${reply.cycle.toFixed(1)}s loop` : 'static'}`,
        javascript: format === 'jsx',
        inherited: fonts === 'inherit' || Object.values(fonts ?? {}).includes('inherit'),
        measuredWith: fonts && fonts !== 'inherit' ? fonts.measureWith : undefined,
      };
      // `reactComponent`/`componentName` (`@geekchart/core`'s `react.ts`) are
      // plain string templating with no DOM in reach — `bakeReact` only
      // exists to call them from inside the browser bundle, which the Node
      // engine has no reason to load a page for at all.
      const component =
        engine === 'node'
          ? await import('../../core/src/react.ts').then(({ reactComponent, componentName }) =>
              reactComponent({ ...bakeInput, name: componentName(bakeInput.fileName) }),
            )
          : await bakeReact(session!.page, bakeInput);
      writeFileSync(output, component);
    } else if (format === 'html') {
      writeFileSync(output, reply.html);
    } else if (format === 'svg') {
      writeFileSync(output, reply.svgFile);
    } else if (format === 'png') {
      await captureStill(
        session!.page,
        { html: reply.html, runtime: reply.cycle, fps, scale, hold, lead },
        output,
      );
    } else {
      if (reply.cycle <= 0) fail('nothing to capture — motion is off, so use .png or .svg');
      const result = await captureVideo(
        session!.page,
        { html: reply.html, runtime: reply.cycle, fps, scale, hold, lead },
        output,
        format as 'mp4' | 'gif' | 'webm',
      );
      log(`  ${result.frames} frames · ${result.seconds.toFixed(1)}s at ${fps}fps`);
    }
  } finally {
    await session?.close();
  }

  process.stdout.write(output + '\n');
}
