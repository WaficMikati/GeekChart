import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';

/**
 * Guards for the React export.
 *
 * A generated component is the one artefact nobody reviews: it is 20 kB of
 * machine output that either mounts or does not. These assertions mount it in a
 * real React tree in a real browser and measure what came out, because every way
 * this can break — a scoping collision, an unclosed attribute, an animation that
 * never starts — produces a component that still compiles.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const cli = join(repo, 'packages', 'cli', 'bin', 'geekchart.mjs');

let browser: Browser;
let page: Page;
let work: string;

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'gc-react-'));

  // Two different charts, so a scoping collision has something to collide with.
  for (const [fixture, name] of [['flow', 'Funnel'], ['state', 'Lifecycle']] as const) {
    execFileSync('node', [cli, join(repo, 'fixtures', `${fixture}.mmd`), '-o', join(work, `${name}.tsx`), '--quiet'], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  }

  // A third, baked to inherit and measured against the stack the host page
  // below actually uses — the case a component shipped into someone's site is in.
  execFileSync(
    'node',
    [cli, join(repo, 'fixtures', 'class.mmd'), '-o', join(work, 'Inherited.tsx'),
     '--measure-with', 'Georgia, serif', '--quiet'],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );

  writeFileSync(
    join(work, 'app.tsx'),
    `import { createRoot } from 'react-dom/client';
     import { Funnel } from './Funnel.tsx';
     import { Lifecycle } from './Lifecycle.tsx';
     import { Inherited } from './Inherited.tsx';
     import { GeekchartFonts } from '${join(here, '..', 'src', 'fonts.tsx')}';
     import { Geekchart } from '${join(here, '..', 'src', 'Geekchart.tsx')}';

     function App() {
       return (
         <>
           <GeekchartFonts />
           <Funnel className="baked" />
           <Lifecycle className="baked" />
           <Geekchart className="live" source={'flowchart LR\\n  A[Paste] --> B[Chart]'} />
           <div style={{ fontFamily: 'Georgia, serif' }}><Inherited className="inherited" /></div>
         </>
       );
     }
     createRoot(document.getElementById('root')!).render(<App />);`,
  );

  const bundle = await build({
    entryPoints: [join(work, 'app.tsx')],
    outfile: join(work, 'app.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    platform: 'browser',
    target: 'es2022',
    // The app is assembled outside the repo, exactly as a consumer's would be,
    // so resolution has to be told where React lives rather than walking up
    // from a directory that has no node_modules above it.
    absWorkingDir: join(here, '..'),
    nodePaths: [join(here, '..', 'node_modules'), join(repo, 'node_modules')],
    logLevel: 'error',
  });
  assert.equal(bundle.errors.length, 0);

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ path: join(work, 'app.js') });
  await page.waitForFunction(() => document.querySelectorAll('svg').length >= 4, null, { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  assert.deepEqual(errors, [], 'the page threw while mounting');
});

after(async () => {
  await browser?.close();
});

describe('baked components', () => {
  test('mount, size themselves and animate', async () => {
    const found = await page.$$eval('.baked', (nodes) =>
      nodes.map((n) => {
        const svg = n.querySelector('svg') as SVGSVGElement | null;
        const r = svg?.getBoundingClientRect();
        return {
          id: n.id,
          label: n.getAttribute('aria-label') ?? '',
          role: n.getAttribute('role'),
          width: Math.round(r?.width ?? 0),
          height: Math.round(r?.height ?? 0),
          animations: svg ? svg.getAnimations({ subtree: true }).length : 0,
        };
      }),
    );
    assert.equal(found.length, 2);
    for (const chart of found) {
      assert.ok(chart.width > 50 && chart.height > 50, `${chart.id} rendered at ${chart.width}x${chart.height}`);
      assert.equal(chart.role, 'img');
      // An SVG with no accessible name is announced as nothing at all.
      assert.ok(chart.label.length > 20, `${chart.id} has no usable description: "${chart.label}"`);
      assert.ok(chart.animations > 5, `${chart.id} is not animating`);
    }
    assert.notEqual(found[0]!.id, found[1]!.id, 'each component owns its own scope');
  });

  test('two charts on one page do not share an animation name', async () => {
    // Every chart names its keyframes from zero, so without scoping the second
    // component's gc-t0 silently replaces the first's and both animate to
    // whichever stylesheet parsed last.
    const shared = await page.evaluate(() => {
      const owners = new Map<string, Set<string>>();
      for (const root of document.querySelectorAll('.baked, .live')) {
        const svg = root.querySelector('svg');
        if (!svg) continue;
        for (const a of svg.getAnimations({ subtree: true })) {
          const name = (a as CSSAnimation).animationName;
          if (!owners.has(name)) owners.set(name, new Set());
          owners.get(name)!.add(root.id);
        }
      }
      return [...owners].filter(([, ids]) => ids.size > 1).map(([name]) => name);
    });
    assert.deepEqual(shared, []);
  });

  test('one chart’s styles do not reach another', async () => {
    // The scoped stylesheet has to be inert outside its own root, or the first
    // chart on a page restyles every one after it.
    const leaked = await page.evaluate(() => {
      const roots = [...document.querySelectorAll('.baked')];
      return roots.map((root) => {
        const outline = root.querySelector('.gc-outline');
        return outline ? getComputedStyle(outline).strokeWidth : 'missing';
      });
    });
    for (const w of leaked) assert.match(w, /^\d/, `an outline lost its stroke: ${w}`);
  });
});

describe('inherited fonts', () => {
  test('the component names no typeface and takes the page’s', async () => {
    const seen = await page.$eval('.inherited', (n) => {
      const title = n.querySelector('.gc-title');
      return {
        css: n.querySelector('style')?.textContent ?? '',
        resolved: title ? getComputedStyle(title).fontFamily : '',
      };
    });
    assert.match(seen.css, /font-family: *inherit/);
    assert.ok(!/Source Serif|JetBrains/.test(seen.css), 'no typeface may be named');
    assert.match(seen.resolved, /Georgia/, 'the chart did not pick up the page’s font');
  });

  test('every label still fits the box drawn for it', async () => {
    // The whole risk of inheriting: geometry is baked at build time from
    // measured text, so a chart measured in one font and shown in another has
    // boxes that do not fit. Measured against this page's own stack, they must.
    const tight = await page.$eval('.inherited', (root) => {
      const out: { text: string; overflow: number }[] = [];
      for (const node of root.querySelectorAll('.gc-node')) {
        const outline = node.querySelector('.gc-outline') as SVGGraphicsElement | null;
        if (!outline) continue;
        const box = outline.getBBox();
        for (const text of node.querySelectorAll('text')) {
          const t = (text as SVGGraphicsElement).getBBox();
          const overflow = Math.max(
            box.x - t.x,
            t.x + t.width - (box.x + box.width),
            box.y - t.y,
            t.y + t.height - (box.y + box.height),
          );
          out.push({ text: text.textContent ?? '', overflow: Number(overflow.toFixed(2)) });
        }
      }
      return out;
    });
    assert.ok(tight.length >= 6, `expected labels to check, found ${tight.length}`);
    for (const label of tight) {
      assert.ok(label.overflow < 0, `"${label.text}" overflows its box by ${label.overflow}px`);
    }
  });
});

describe('the live component', () => {
  test('renders from mermaid source and names itself', async () => {
    const live = await page.$eval('.live', (n) => {
      const svg = n.querySelector('svg') as SVGSVGElement | null;
      const r = svg?.getBoundingClientRect();
      return {
        label: n.getAttribute('aria-label') ?? '',
        width: Math.round(r?.width ?? 0),
        height: Math.round(r?.height ?? 0),
      };
    });
    assert.ok(live.width > 50 && live.height > 20, `live chart rendered at ${live.width}x${live.height}`);
    assert.match(live.label, /Paste/, 'the description names what is in the diagram');
  });
});

describe('the fonts module', () => {
  test('registers the faces the layout was measured in', async () => {
    const families = await page.evaluate(() => {
      const seen = new Set<string>();
      document.fonts.forEach((f) => seen.add(f.family.replace(/["']/g, '')));
      return [...seen];
    });
    for (const wanted of ['Archivo', 'Source Serif 4', 'JetBrains Mono']) {
      assert.ok(families.includes(wanted), `${wanted} was not registered; have ${families.join(', ')}`);
    }
  });
});
