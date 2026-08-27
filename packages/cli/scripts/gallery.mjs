/**
 * Build the review gallery: every fixture, in one self-contained page.
 *
 * This is a working tool rather than a showcase. It exists so a chart can be
 * looked at on its own, at size, with the source that produced it next to it —
 * which is the only way to say "the sankey's labels are wrong" and have both
 * ends of the conversation looking at the same thing.
 *
 * Regenerate it whenever the renderer changes:
 *   pnpm gallery                 # browser engine, writes gallery.html
 *   pnpm gallery --engine=node   # renderNode(), writes gallery-node.html
 *   pnpm gallery some/path.html  # either engine, explicit output path
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeCss } from '../../core/src/scope.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const fixturesRoot = join(repo, 'fixtures');
const argv = process.argv.slice(2);
const engine = argv.find((a) => a.startsWith('--engine='))?.slice('--engine='.length) === 'node' ? 'node' : 'browser';
const explicitOut = argv.find((a) => !a.startsWith('--'));
const fixturesBlog = join(fixturesRoot, 'blog');

/**
 * The running order.
 *
 * Two sections. "Examples" is what a real 4geeks blog post would embed — the
 * pitch for the tool. "Catalog" is one fixture per chart type mermaid knows,
 * grouped by what the renderer does with them (not alphabetically): the point
 * of that grouping is that everything in a group shares a pipeline, so a
 * fault in one is usually a fault in its neighbours. Within a section, groups
 * are grouped by what the renderer does with them.
 */
const GROUPS = [
  {
    section: 'Examples',
    name: 'Graphs',
    dir: fixturesBlog,
    note: 'a flow or a conversation, drawn from a real article',
    items: [
      ['incident-response', 'Incident response', 'flowchart'],
      ['first-ai-app', 'First AI app', 'sequenceDiagram'],
      ['rigobot-loop', 'Rigobot mentor', 'sequenceDiagram'],
      ['python-or-java', 'Python or Java?', 'flowchart'],
      ['regex-engine', 'Regex engine', 'stateDiagram-v2'],
    ],
  },
  {
    section: 'Examples',
    name: 'Panels',
    dir: fixturesBlog,
    note: 'a subgraph drawn as a container — the composition family',
    items: [
      ['prompt-anatomy', 'Prompt anatomy', 'flowchart + subgraph'],
      ['platform-layers', 'Platform layers', 'flowchart + subgraph'],
      ['pyenv-resolution', 'pyenv resolution', 'flowchart + subgraph'],
    ],
  },
  {
    section: 'Examples',
    name: 'On an axis',
    dir: fixturesBlog,
    note: 'position is data, not the output of a layout search',
    items: [
      ['geekforce-timeline', 'GeekFORCE timeline', 'timeline'],
      ['learn-js-plan', 'Learning JS', 'gantt'],
    ],
  },
  {
    section: 'Examples',
    name: 'Charts',
    dir: fixturesBlog,
    note: 'marks encode quantities, so charting rules apply',
    items: [
      ['outcomes-2024', '2024 outcomes', 'xychart-beta'],
      ['bootcamp-worth-it', 'Bootcamp, worth it?', 'quadrantChart'],
    ],
  },
  {
    section: 'Catalog',
    name: 'Graphs',
    dir: fixturesRoot,
    note: 'mermaid parses, ELK places, we draw',
    items: [
      ['flow', 'Flowchart', 'flowchart'],
      ['subgraphs', 'Subgraphs', 'flowchart'],
      ['4geeks-journey', 'Learner journey', 'flowchart'],
      ['state', 'State', 'stateDiagram-v2'],
      ['class', 'Class', 'classDiagram'],
      ['er', 'Entity relationship', 'erDiagram'],
      ['sequence', 'Sequence', 'sequenceDiagram'],
      ['sequence-rich', 'Sequence, with frames', 'sequenceDiagram'],
    ],
  },
  {
    section: 'Catalog',
    name: 'Panels',
    dir: fixturesRoot,
    note: 'a subgraph drawn as a container — the composition family',
    items: [
      ['control-plane', 'Control plane', 'flowchart + subgraph'],
      ['architecture', 'Layered architecture', 'flowchart + subgraph'],
      ['org-chart', 'Org chart', 'flowchart'],
    ],
  },
  {
    section: 'Catalog',
    name: 'On an axis',
    dir: fixturesRoot,
    note: 'position is data, not the output of a layout search',
    items: [
      ['timeline', 'Timeline', 'timeline'],
      ['gantt', 'Gantt', 'gantt'],
      ['gantt-states', 'Gantt, with states', 'gantt'],
      ['journey', 'User journey', 'journey'],
    ],
  },
  {
    section: 'Catalog',
    name: 'Charts',
    dir: fixturesRoot,
    note: 'marks encode quantities, so charting rules apply',
    items: [
      ['xy', 'Bar and line', 'xychart-beta'],
      ['radar', 'Radar', 'radar-beta'],
      ['quadrant', 'Quadrant', 'quadrantChart'],
    ],
  },
  {
    section: 'Catalog',
    name: 'Boards',
    dir: fixturesRoot,
    note: 'a flow, an area, a board — sharing only their chrome',
    items: [
      ['sankey', 'Sankey', 'sankey-beta'],
      ['treemap', 'Treemap', 'treemap-beta'],
      ['kanban', 'Kanban', 'kanban'],
    ],
  },
  {
    section: 'Catalog',
    name: 'Radial',
    dir: fixturesRoot,
    note: 'everything placed relative to one centre or one lane, not a row-and-column layout',
    items: [
      ['pie', 'Pie', 'pie'],
      ['mindmap', 'Mindmap', 'mindmap'],
      ['gitgraph', 'Git graph', 'gitGraph'],
    ],
  },
  {
    section: 'Catalog',
    name: 'Bad input',
    dir: fixturesRoot,
    note: 'what happens when the paste is broken — the repair step, demonstrated',
    items: [['messy', 'Damaged paste, repaired', 'flowchart']],
  },
];

const esc = (t) =>
  String(t).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

// Each group is keyed by section+name, since "Graphs", "Panels" etc. appear
// once per section (Examples and Catalog draw from different fixture dirs but
// share the same pipeline families).
for (const group of GROUPS) group.key = `${group.section}·${group.name}`;

// `renderOne`/`closeEngine` hide which engine drew the chart from everything
// below this point — the rest of the file (page markup, gate.mjs reading it
// back) does not care whether an entry's `svg` came from a headless browser
// or `renderNode()`.
let renderOne;
let closeEngine = async () => {};
if (engine === 'node') {
  const { renderNode } = await import('../../core/src/node/render.ts');
  const { ChartError } = await import('../../core/src/chart-error.ts');
  renderOne = async (source, options) => {
    try {
      const r = await renderNode(source, options);
      return { ok: true, ...r };
    } catch (err) {
      if (err instanceof ChartError) return { ok: false, error: err.detail };
      return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
    }
  };
} else {
  const { openSession, renderAny } = await import('../src/browser.ts');
  const session = await openSession(1);
  renderOne = (source, options) => renderAny(session.page, source, options);
  closeEngine = () => session.close();
}

const entries = [];
try {
  for (const group of GROUPS) {
    for (const [file, title, keyword] of group.items) {
      const source = readFileSync(join(group.dir, `${file}.mmd`), 'utf8');
      const reply = await renderOne(source, { width: 1180 });
      if (!reply.ok) {
        process.stderr.write(`  ${file}: ${reply.error.message}\n`);
        continue;
      }
      entries.push({
        id: file,
        group: group.key,
        title,
        keyword,
        source: source.trim(),
        svg: reply.svg,
        css: scopeCss(reply.css, `gc-${file}`),
        cycle: reply.cycle,
        summary: reply.summary,
        drawn: reply.path === 'flow',
        nodes: reply.nodes,
        edges: reply.edges,
        repairs: reply.repairs.map((r) => r.message),
        warnings: reply.warnings,
      });
      process.stderr.write(`  ${title.padEnd(24)} ${reply.diagram} · ${reply.cycle.toFixed(1)}s\n`);
    }
  }
} finally {
  await closeEngine();
}

const missing = [fixturesRoot, fixturesBlog]
  .flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.mmd'))
      .map((f) => join(dir, f.replace(/\.mmd$/, ''))),
  )
  .map((p) => p.split('/').pop())
  .filter((id) => !entries.some((e) => e.id === id));
if (missing.length) process.stderr.write(`  not in any group: ${missing.join(', ')}\n`);

let lastSection = '';
const nav = GROUPS.map((group) => {
  const items = entries.filter((e) => e.group === group.key);
  if (!items.length) return '';
  const heading =
    group.section !== lastSection ? `<h2 class="nav-section">${esc(group.section)}</h2>` : '';
  lastSection = group.section;
  return (
    heading +
    `<section class="nav-group"><h3>${esc(group.name)}</h3>` +
    `<p>${esc(group.note)}</p><ul>` +
    items
      .map(
        (e) =>
          `<li><a href="#${e.id}" data-go="${e.id}">${esc(e.title)}` +
          `${e.drawn ? '' : '<span class="tag">mermaid</span>'}</a></li>`,
      )
      .join('') +
    `</ul></section>`
  );
}).join('');

const panels = entries
  .map(
    (e) => `
  <article class="chart" id="${e.id}" hidden>
    <header class="chart-head">
      <div>
        <p class="kw">${esc(e.keyword)}${e.drawn ? '' : ' · mermaid renderer'}</p>
        <h2>${esc(e.title)}</h2>
      </div>
      <div class="facts">
        <span>${e.nodes} / ${e.edges}</span>
        <span>${e.cycle > 0 ? `${e.cycle.toFixed(1)}s loop` : 'static'}</span>
      </div>
    </header>
    ${e.repairs.length ? repairPanel(e) : ''}
    ${e.warnings.length ? `<p class="flag warn">${e.warnings.map(esc).join(' ')}</p>` : ''}
    <div class="stage" id="stage-gc-${e.id}"><div class="mount" id="gc-${e.id}">${e.svg}</div></div>
    <div class="meta">
      <details><summary>Source</summary><pre>${esc(e.source)}</pre></details>
      <p class="alt">${esc(e.summary)}</p>
    </div>
  </article>`,
  )
  .join('');

/**
 * The repair demo needs to say what it is: a paste as people actually paste it
 * (a code fence, arrows mangled by a word processor, brackets in labels) on the
 * left, what the repair step changed on the right, and the chart it still got.
 */
function markDamage(source) {
  return esc(source)
    .replace(/^(\s*```.*)$/gm, '<mark title="markdown code fence">$1</mark>')
    .replace(/(—|–|&gt;?—|—&gt;)/g, '<mark title="dash where an arrow should be">$1</mark>')
    .replace(/(\[[^\]]*\([^)]*\)[^\]]*\])/g, '<mark title="brackets inside a label">$1</mark>');
}
function repairPanel(e) {
  return `
    <section class="repair">
      <p class="repair-lede">This chart was pasted <em>broken</em> — the way a real paste from a doc or a chat often is. Geekchart repairs what it can before drawing, and says what it changed.</p>
      <div class="repair-cols">
        <div><h3>What was pasted</h3><pre class="repair-src">${markDamage(e.source)}</pre></div>
        <div><h3>What was fixed</h3><ul class="repair-list">${e.repairs.map((r) => `<li>${esc(r)}</li>`).join('')}</ul><p class="repair-hint">Highlighted on the left: the parts mermaid would have choked on.</p></div>
      </div>
    </section>`;
}

const chartCss = entries.map((e) => e.css).join('\n');

// A bare <meta charset> is hoisted into the head by the parser, so the file
// reads correctly opened straight off disk as well as published. A full
// doctype/head/body wrapper is not written: the publisher supplies its own.
const page = `<meta charset="utf-8">
<title>Geekchart Review Gallery</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
  :root {
    --page:#0B121A; --card:#131C26; --line:#26313D; --fg:#F2F5F8; --dim:#8794A3;
    --brand:#0084FF; --warn:#FFB718; --good:#3FBF7F;
    --stage:#17202A;
  }
  /* Dark is the default: no gating selector, so it also covers a browser with
     no colour-scheme preference at all. DESIGN 5.5's seven chart variables,
     the same ones the light blocks below override on .mount. */
  .mount {
    --gc-bg:#17202A; --gc-ink:#FFFFFF; --gc-quiet:#8794A3; --gc-edge:#6B7889;
    --gc-surface:#232F3C; --gc-path:#0084FF; --gc-accent:#00ABE9;
  }
  :root[data-theme="light"] {
    --page:#EEF2F6; --card:#FFFFFF; --line:#DAE1E8; --fg:#17202A; --dim:#5A6672;
    --brand:#0075E0; --warn:#B4700A; --good:#1F8A5B;
    --stage:#FFFFFF;
  }
  /* The chart palette is toggled on its own (Chart: dark/light button), independent
     of the page theme. data-chart on body wins over the system preference below. */
  body[data-chart="light"] .mount, body[data-chart="light"] .stage {
    --gc-bg:#FFFFFF; --gc-ink:#17202A; --gc-quiet:#5A6672; --gc-edge:#9AA5B1;
    --gc-surface:#EEF2F6; --gc-path:#0075E0; --gc-accent:#0096D6; --stage:#FFFFFF;
  }
  body[data-chart="dark"] .mount, body[data-chart="dark"] .stage {
    --gc-bg:#17202A; --gc-ink:#FFFFFF; --gc-quiet:#8794A3; --gc-edge:#6B7889;
    --gc-surface:#232F3C; --gc-path:#0084FF; --gc-accent:#00ABE9; --stage:#17202A;
  }
  :root[data-theme="light"] .mount {
    --gc-bg:#FFFFFF; --gc-ink:#17202A; --gc-quiet:#5A6672; --gc-edge:#9AA5B1;
    --gc-surface:#EEF2F6; --gc-path:#0075E0; --gc-accent:#0096D6;
  }
  @media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {
    --page:#EEF2F6; --card:#FFFFFF; --line:#DAE1E8; --fg:#17202A; --dim:#5A6672;
    --brand:#0075E0; --warn:#B4700A; --good:#1F8A5B;
    --stage:#FFFFFF;
  } }
  @media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) .mount {
    --gc-bg:#FFFFFF; --gc-ink:#17202A; --gc-quiet:#5A6672; --gc-edge:#9AA5B1;
    --gc-surface:#EEF2F6; --gc-path:#0075E0; --gc-accent:#0096D6;
  } }
  * { box-sizing: border-box; }
  /* Scrollbars, as slim as each engine allows.
     WebKit lets a track be any width, so it gets 7px. Firefox has only the
     keyword "thin", and setting scrollbar-width in Chrome *replaces* the WebKit
     pseudo-elements with its own wider bar — so the standard properties are
     fenced behind a feature query that only Firefox fails, and each engine ends
     up with the narrowest bar it can actually draw. */
  ::-webkit-scrollbar { width: 7px; height: 7px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--dim) 38%, transparent); border-radius: 99px; }
  ::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--dim) 70%, transparent); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
  @supports not selector(::-webkit-scrollbar) {
    * { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--dim) 38%, transparent) transparent; }
  }

  html, body { margin:0; background:var(--page) !important; color:var(--fg) !important;
    font-family:Archivo, ui-sans-serif, system-ui, sans-serif; line-height:1.55;
    -webkit-font-smoothing:antialiased; }
  .shell { display:grid; grid-template-columns:260px 1fr; min-height:100vh; }
  @media (max-width:56rem) { .shell { grid-template-columns:1fr; } }

  aside { border-right:1px solid var(--line); padding:1.4rem 1.1rem 3rem;
    position:sticky; top:0; max-height:100vh; overflow-y:auto; background:var(--card); }
  #menu { display:none; }
  @media (max-width:56rem) {
    #menu { display:inline-block; }
    aside { position:fixed; inset:0 auto 0 0; width:min(80vw,300px); z-index:20; transform:translateX(-100%);
      transition:transform .25s cubic-bezier(0.61,0,0.39,1); box-shadow:none; max-height:none; }
    body.nav-open aside { transform:none; box-shadow:0 0 0 100vmax rgba(0,0,0,.45); }
    @media (prefers-reduced-motion: reduce) { aside { transition:none; } }
  }
  .brand { font-weight:700; font-size:1.05rem; letter-spacing:-.01em; margin:0 0 .15rem; }
  .brand span { color:var(--brand); }
  .count { color:var(--dim); font-size:.76rem; font-family:'JetBrains Mono',monospace;
    margin:0 0 1.3rem; }
  .nav-section { margin:1.6rem 0 .5rem; padding-top:1rem; border-top:1px solid var(--line);
    font-size:.68rem; letter-spacing:.16em; text-transform:uppercase; color:var(--fg); }
  .nav-section:first-child { margin-top:0; padding-top:0; border-top:none; }
  .nav-group { margin-bottom:1.25rem; }
  .nav-group h3 { margin:0; font-size:.72rem; letter-spacing:.14em; text-transform:uppercase;
    color:var(--brand); font-family:'JetBrains Mono',monospace; }
  .nav-group p { margin:.2rem 0 .5rem; color:var(--dim); font-size:.74rem; line-height:1.4; }
  .nav-group ul { list-style:none; margin:0; padding:0; display:grid; gap:1px; }
  .nav-group a { display:flex; align-items:center; gap:.4rem; padding:.34rem .5rem;
    border-radius:6px; color:var(--fg); text-decoration:none; font-size:.88rem; }
  .nav-group a:hover { background:color-mix(in srgb, var(--brand) 14%, transparent); }
  .nav-group a.on { background:var(--brand); color:#fff; }
  .tag { margin-left:auto; font-size:.6rem; letter-spacing:.08em; text-transform:uppercase;
    color:var(--warn); border:1px solid currentColor; border-radius:3px; padding:0 .25rem; }
  .nav-group a.on .tag { color:#fff; }

  main { padding:1.6rem clamp(1rem,3vw,2.2rem) 5rem; min-width:0; }
  .chart-head { display:flex; align-items:flex-start; gap:1rem; flex-wrap:wrap;
    margin-bottom:.9rem; }
  .kw { margin:0; font-family:'JetBrains Mono',monospace; font-size:.74rem;
    letter-spacing:.1em; color:var(--brand); }
  h2 { margin:.1rem 0 0; font-size:1.7rem; font-weight:700; letter-spacing:-.02em; }
  .facts { margin-left:auto; display:flex; gap:.9rem; color:var(--dim);
    font-family:'JetBrains Mono',monospace; font-size:.76rem; padding-top:.5rem; }

  .stage { background:var(--stage); border:1px solid var(--line); border-radius:12px;
    padding:clamp(.8rem,2vw,1.6rem); overflow:auto; }
  .stage .mount { display:flex; justify-content:center; }
  .stage svg { display:block; width:100%; max-width:1000px; height:auto; }
  body.still .stage svg *, body.still .stage svg { animation:none !important; }

  .bar { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap;
    margin:0 0 1rem; padding:.6rem .7rem; background:var(--card);
    border:1px solid var(--line); border-radius:10px; position:sticky; top:.6rem; z-index:5; }
  button { font:inherit; font-size:.8rem; padding:.32rem .7rem; border-radius:7px;
    border:1px solid var(--line); background:transparent; color:var(--fg); cursor:pointer; }
  button:hover { border-color:var(--brand); }
  button.on { background:var(--brand); border-color:var(--brand); color:#fff; }
  .swatches { display:flex; gap:5px; align-items:center; margin-left:auto; }
  .swatches label { line-height:0; }
  .swatches input { inline-size:22px; block-size:22px; padding:0; cursor:pointer;
    border:1px solid var(--line); border-radius:5px; background:none; }
  .swatches input::-webkit-color-swatch { border:none; border-radius:4px; }
  .swatches input::-webkit-color-swatch-wrapper { padding:1px; }

  .meta { margin-top:1rem; display:grid; gap:.7rem; }
  details { background:var(--card); border:1px solid var(--line); border-radius:9px;
    padding:.6rem .9rem; }
  summary { cursor:pointer; font-size:.85rem; color:var(--dim); }
  pre { margin:.7rem 0 0; overflow-x:auto; font-family:'JetBrains Mono',monospace;
    font-size:.78rem; line-height:1.6; color:var(--fg); }
  .alt { margin:0; color:var(--dim); font-size:.83rem; }
  .repair { margin:0 0 1rem; padding:.9rem 1rem; background:var(--card); border:1px solid var(--line); border-radius:10px; }
  .repair-lede { margin:0 0 .8rem; font-size:.9rem; max-width:70ch; }
  .repair-lede em { color:var(--warn); font-style:normal; font-weight:600; }
  .repair-cols { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
  @media (max-width:56rem) { .repair-cols { grid-template-columns:1fr; } }
  .repair h3 { margin:0 0 .4rem; font-size:.7rem; letter-spacing:.14em; text-transform:uppercase; color:var(--brand); font-family:'JetBrains Mono',monospace; }
  .repair-src { margin:0; font-family:'JetBrains Mono',monospace; font-size:.78rem; line-height:1.6; white-space:pre-wrap; }
  .repair-src mark { background:color-mix(in srgb, var(--warn) 22%, transparent); color:inherit; border-radius:3px; padding:0 .15em; }
  .repair-list { margin:0; padding-left:1.1rem; font-size:.86rem; color:var(--good); }
  .repair-list li { margin:.15rem 0; }
  .repair-hint { margin:.6rem 0 0; color:var(--dim); font-size:.78rem; }
  .flag { margin:0 0 .8rem; padding:.5rem .8rem; border-radius:8px; font-size:.84rem;
    border:1px solid currentColor; }
  .flag.fixed { color:var(--good); }
  .flag.warn { color:var(--warn); }
  kbd { font-family:'JetBrains Mono',monospace; font-size:.7rem; border:1px solid var(--line);
    border-radius:4px; padding:0 .3rem; color:var(--dim); }
</style>
<style id="chart-styles">${chartCss}</style>

<div class="shell">
  <aside>
    <p class="brand">Geek<span>chart</span></p>
    <p class="count">${entries.length} charts · ${entries.filter((e) => e.drawn).length} drawn</p>
    ${nav}
  </aside>
  <main>
    <div class="bar">
      <button id="menu" type="button" aria-label="Charts menu">☰ Charts</button>
      <button id="replay" type="button">Replay</button>
      <button id="motion" type="button" class="on">Motion</button>
      <button id="theme" type="button">Chart: dark</button>
      <span class="swatches">
        <label title="Ground"><input type="color" data-var="--gc-bg" value="#17202a"></label>
        <label title="Surface"><input type="color" data-var="--gc-surface" value="#232f3c"></label>
        <label title="Ink"><input type="color" data-var="--gc-ink" value="#ffffff"></label>
        <label title="Primary"><input type="color" data-var="--gc-path" value="#0084ff"></label>
        <label title="Alternate"><input type="color" data-var="--gc-alt" value="#ffb718"></label>
        <button id="reset" type="button">Reset</button>
      </span>
    </div>
    ${panels}
  </main>
</div>

<script>
  const charts = [...document.querySelectorAll('.chart')];
  const links = [...document.querySelectorAll('[data-go]')];

  function show(id) {
    const found = charts.find((c) => c.id === id) ?? charts[0];
    for (const c of charts) c.hidden = c !== found;
    for (const a of links) a.classList.toggle('on', a.dataset.go === found.id);
    document.title = found.querySelector('h2').textContent + ' - Geekchart';
    paint();
  }

  // Re-inserting the SVG is what restarts every CSS animation on it.
  function replay() {
    const svg = charts.find((c) => !c.hidden)?.querySelector('svg');
    if (!svg) return;
    const parent = svg.parentNode, next = svg.nextSibling;
    svg.remove();
    void document.body.offsetWidth;
    parent.insertBefore(svg, next);
  }

  // Every colour the renderer emits is a custom property with the scene value as
  // its fallback, so these repaint a pre-rendered chart with no re-render at all.
  const pickers = [...document.querySelectorAll('input[data-var]')];
  function paint() {
    for (const mount of document.querySelectorAll('.mount')) {
      for (const input of pickers) {
        if (input.dataset.touched) mount.style.setProperty(input.dataset.var, input.value);
        else mount.style.removeProperty(input.dataset.var);
      }
    }
    const bg = pickers.find((i) => i.dataset.var === '--gc-bg');
    for (const stage of document.querySelectorAll('.stage')) {
      stage.style.background = bg.dataset.touched ? bg.value : '';
    }
  }
  for (const input of pickers) {
    input.addEventListener('input', () => { input.dataset.touched = '1'; paint(); });
  }
  document.getElementById('reset').addEventListener('click', () => {
    for (const input of pickers) delete input.dataset.touched;
    paint();
  });

  document.getElementById('replay').addEventListener('click', replay);
  document.getElementById('motion').addEventListener('click', (e) => {
    document.body.classList.toggle('still');
    e.currentTarget.classList.toggle('on', !document.body.classList.contains('still'));
    if (!document.body.classList.contains('still')) replay();
  });
  const themeBtn = document.getElementById('theme');
  const chartDark = () => (document.body.dataset.chart || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  const paintTheme = () => { themeBtn.textContent = 'Chart: ' + (chartDark() ? 'dark' : 'light'); };
  try { const saved = localStorage.getItem('gc-chart-theme'); if (saved) document.body.dataset.chart = saved; } catch {}
  themeBtn.addEventListener('click', () => {
    document.body.dataset.chart = chartDark() ? 'light' : 'dark';
    try { localStorage.setItem('gc-chart-theme', document.body.dataset.chart); } catch {}
    paintTheme(); paint(); replay();
  });
  paintTheme();

  // Sidebar: a drawer below 56rem, toggled by the menu button; closes after a pick.
  const menu = document.getElementById('menu');
  menu.addEventListener('click', () => document.body.classList.toggle('nav-open'));
  for (const a of links) a.addEventListener('click', () => document.body.classList.remove('nav-open'));

  for (const a of links) {
    a.addEventListener('click', (e) => { e.preventDefault(); location.hash = a.dataset.go; });
  }
  addEventListener('hashchange', () => show(location.hash.slice(1)));

  // Arrow keys walk the list, which is how a review actually gets done.
  addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, summary')) return;
    if (e.key === 'r') return replay();
    const step = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = charts.findIndex((c) => !c.hidden);
    location.hash = charts[(at + step + charts.length) % charts.length].id;
  });

  show(location.hash.slice(1));
</script>
`;

const out = explicitOut ?? join(repo, engine === 'node' ? 'gallery-node.html' : 'gallery.html');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);
process.stderr.write(
  `\nwrote ${out} (${engine} engine) — ${(page.length / 1024).toFixed(0)} kB, ${entries.length} charts\n`,
);
