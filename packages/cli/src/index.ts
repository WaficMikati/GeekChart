import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { AnyRequest } from './browser.ts';

/**
 * Same string as `@geekchart/core`'s `SYSTEM_STACK` (`scene.ts`), duplicated
 * rather than imported: `@geekchart/core` also carries mermaid and elkjs, and
 * this file is Node-side CLI code bundled into `geekchart`'s published
 * `dist/cli.js` — a static import of even one constant from the barrel would
 * pull that whole graph in a second time. See `packages/geekchart/src/server.ts`
 * for the same trade-off made the same way.
 */
const SYSTEM_STACK =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const USAGE = `
geekchart — turn a mermaid chart into gorgeous animated diagrams

  geekchart <input.mmd> -o <output>        (- reads stdin)

The output extension picks the format, all drawn with the Node engine
(fontkit measures text, no browser needed):
  .svg    portable vector, animated with embedded CSS
  .html   self-contained page; animates with no JavaScript, fonts embedded
  .tsx .jsx         React component; no dependencies, no client JavaScript

Options
  -o, --out <file>       output path            (default: alongside the input)
      --scene <name>     geeks | manim          (default: geeks)
      --no-motion        draw the finished frame with no animation
      --speed <n>        stretch or hurry the whole build by one multiplier —
                         0.5 plays at half speed, 2 at double, 1 is the
                         designed timing (default). Clamped to 0.25-4; order,
                         easing and lag ratios never change
      --width <px>       frame width            (default: 1400)
      --height <px>      frame height           (default: 800)
      --aspect <ratio>   auto | 16:9 | 1:1 | 4:5 | 9:16   (default: auto)
                         pads the diagram into a fixed posting frame
      --display <px>     the width, in CSS px, this chart will actually be
                         shown at (DESIGN 1.1) — the canvas never exceeds it;
                         leaf fans stack, chains fold and, past that, whole
                         rows wrap before anything scales down to fit
      --display <desktop>,<phone>
                         two widths, one render each — .html output only.
                         Both <svg>s ship in one page with a 640px media
                         query that shows one and hides the other

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
      --quiet            only print the output path

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
        speed: { type: 'string' },
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
        display: { type: 'string' },
        quiet: { type: 'boolean', default: false },
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

  const width = number('width', values.width!, 200, 4000);
  const height = number('height', values.height!, 150, 4000);

  // DESIGN 8.6: a bad value ("abc") is a usage error, but an out-of-range one
  // (5, -1) is not — it clamps, the same as it would for any other caller of
  // `@geekchart/core`'s `applySpeed`, so a CLI invocation and a library call
  // with the same number always draw the same chart.
  const speed = ((): number | undefined => {
    if (values.speed === undefined) return undefined;
    const n = Number(values.speed);
    if (!Number.isFinite(n)) fail(`--speed must be a number, got "${values.speed}"`);
    return n;
  })();

  // DESIGN 1.1: a single width renders once, same as any other option; two
  // (comma-separated) render one variant each — see the dual-render branch
  // near the bottom of this function for where the object form is used.
  const display: number | { desktop: number; phone: number } | undefined = (() => {
    const raw = values.display;
    if (!raw) return undefined;
    if (!raw.includes(',')) return number('display', raw, 200, 2000);
    const [d, p, ...rest] = raw.split(',');
    if (rest.length || !d || !p) {
      fail(`--display <desktop>,<phone> takes exactly two widths, got "${raw}"`);
    }
    return {
      desktop: number('display', d, 200, 2000),
      phone: number('display', p, 200, 2000),
    };
  })();

  const output = resolve(
    values.out ?? (input === '-' ? 'chart.html' : input.replace(/\.[^.]+$/, '') + '.html'),
  );
  const format = extname(output).slice(1).toLowerCase();
  const known = ['html', 'svg', 'tsx', 'jsx'];
  if (!known.includes(format)) {
    fail(`do not know how to write "${format}" files. Try one of: ${known.join(', ')}`);
  }
  if (display && typeof display === 'object' && format !== 'html') {
    fail(
      `--display <desktop>,<phone> only writes two variants into one page, and only .html holds a page — got .${format}. Render each width separately for .${format}, or write .html.`,
    );
  }

  const log = (line: string) => {
    if (!values.quiet) process.stderr.write(line + '\n');
  };

  const isReact = format === 'tsx' || format === 'jsx';

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

  const renderOptions = {
    scene: values.scene as 'manim' | 'geeks',
    aspect: values.aspect as 'auto' | '16:9' | '1:1' | '4:5' | '9:16',
    ...(fonts ? { fonts } : {}),
    ...(palette ? { palette } : {}),
    // A still frame has nothing to animate, so motion is skipped for it.
    motion: !values['no-motion'] && format !== 'svg',
    width,
    height,
    ...(typeof display === 'number' ? { display } : {}),
    ...(speed !== undefined ? { speed } : {}),
  };

  // `renderNode`'s thrown `ChartError` is mapped to the same `{ ok: false,
  // error }` shape every reader below expects. Shared by the single render
  // below and, for `--display <desktop>,<phone>`, by each of the two.
  const { renderNode } = await import('../../core/src/node/render.ts');
  type NodeReply = Awaited<ReturnType<typeof renderNode>>;
  async function renderAndLog(opts: typeof renderOptions): Promise<NodeReply> {
    const outcome = await (async () => {
      try {
        return { ok: true as const, ...(await renderNode(source, opts)) };
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
    })();
    if (!outcome.ok) {
      const where = outcome.error.line ? ` on line ${outcome.error.line}` : '';
      process.stderr.write(
        `\ngeekchart: could not draw this chart${where}\n\n  ${outcome.error.message.replace(/\n/g, '\n  ')}\n`,
      );
      if (outcome.error.excerpt)
        process.stderr.write(`\n  ${outcome.error.line}: ${outcome.error.excerpt}\n`);
      process.stderr.write('\n');
      process.exit(2);
    }
    for (const note of outcome.repairs) log(`  fixed: ${note.message}`);
    for (const warning of outcome.warnings) {
      process.stderr.write(`\ngeekchart: ${warning}\n\n`);
    }
    const pipeline = outcome.path === 'flow' ? 'drawn' : 'mermaid';
    log(
      `  ${outcome.diagram} · ${outcome.nodes} nodes · ${outcome.edges} edges · ` +
        `${outcome.cycle > 0 ? `${outcome.cycle.toFixed(1)}s loop` : 'static'} · ${pipeline}`,
    );
    return outcome;
  }

  // DESIGN 1.1: two widths render independently and land in one page — see
  // the usage text above for the exact markup. Only `.html` reaches here
  // (checked above, next to where `display` is parsed); every other format
  // takes the ordinary single-render path below.
  if (display && typeof display === 'object') {
    const [desktop, phone] = await Promise.all([
      renderAndLog({ ...renderOptions, display: display.desktop }),
      renderAndLog({ ...renderOptions, display: display.phone }),
    ]);
    const stampVariant = (svg: string, variant: 'desktop' | 'phone') =>
      svg.replace(/^<svg /, `<svg data-gc-variant="${variant}" `);
    const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chart</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 40px 24px; }
[data-gc-variant="desktop"] { display: block; }
[data-gc-variant="phone"] { display: none; }
@media (max-width: 640px) {
  [data-gc-variant="desktop"] { display: none; }
  [data-gc-variant="phone"] { display: block; }
}
${desktop.css}
${phone.css}
</style></head>
<body>${stampVariant(desktop.svg, 'desktop')}${stampVariant(phone.svg, 'phone')}</body></html>`;
    writeFileSync(output, page);
    process.stdout.write(output + '\n');
    return;
  }

  const reply = await renderAndLog(renderOptions);

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
    // plain string templating with no DOM in reach.
    const { reactComponent, componentName } = await import('../../core/src/react.ts');
    const component = reactComponent({ ...bakeInput, name: componentName(bakeInput.fileName) });
    writeFileSync(output, component);
  } else if (format === 'html') {
    writeFileSync(output, reply.html);
  } else if (format === 'svg') {
    writeFileSync(output, reply.svgFile);
  }

  process.stdout.write(output + '\n');
}
