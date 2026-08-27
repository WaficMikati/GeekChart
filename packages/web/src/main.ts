import {
  ChartError,
  drawnType,
  render,
  scenes,
  type Aspect,
  type FontOptions,
  type RenderResult,
  type SceneName,
} from '@geekchart/core';
import { examples } from './examples.js';

/**
 * Paste on the left, chart on the right.
 *
 * The preview is the deliverable, not a proxy for it: the same renderer produces
 * what is shown here, the file you download, and the frames a video is captured
 * from. There is no second code path to drift.
 */

interface State {
  source: string;
  scene: SceneName;
  motion: boolean;
  aspect: Aspect;
  fonts: 'embedded' | 'inherit';
  palette: Record<string, string>;
}

/** The colours worth putting a picker on. The rest are reachable from the API. */
const SWATCHES: { key: string; label: string }[] = [
  { key: 'path', label: 'Primary' },
  { key: 'alt', label: 'Alternate' },
  { key: 'accent', label: 'Accent' },
  { key: 'bg', label: 'Ground' },
];

/**
 * Two font choices, because they answer different questions.
 *
 * `embedded` is right for a chart that is the whole artefact — a page, a video,
 * a still. `inherit` is right for one going into somewhere else, where matching
 * the surrounding text beats bringing its own.
 */
const FONT_MODES: { value: State['fonts']; label: string; hint: string }[] = [
  { value: 'embedded', label: 'Own', hint: 'The chart brings its own typefaces' },
  { value: 'inherit', label: 'Inherit', hint: 'Take the typefaces of the page it lands in' },
];

/** The posting frames, in the order a marketing team reaches for them. */
const ASPECTS: { value: Aspect; label: string; hint: string }[] = [
  { value: 'auto', label: 'Fit', hint: 'The diagram\u2019s own bounds' },
  { value: '16:9', label: '16:9', hint: 'Slides, YouTube, X' },
  { value: '1:1', label: '1:1', hint: 'Feed post' },
  { value: '4:5', label: '4:5', hint: 'Instagram portrait' },
  { value: '9:16', label: '9:16', hint: 'Stories, Reels, TikTok' },
];

const STORAGE_KEY = 'geekchart:state:v2';

const defaults: State = {
  source: examples[0]!.source,
  scene: 'geeks',
  motion: true,
  aspect: 'auto',
  fonts: 'embedded',
  palette: {},
};

/** A shared link wins over stored state, so a pasted URL always shows its chart. */
function loadState(): State {
  const state = { ...defaults };
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) Object.assign(state, JSON.parse(stored) as Partial<State>);
  } catch {
    /* corrupt storage should never stop the app opening */
  }
  const hash = location.hash.slice(1);
  if (hash) {
    try {
      state.source = decodeURIComponent(escape(atob(hash.replace(/-/g, '+').replace(/_/g, '/'))));
    } catch {
      /* not one of our links */
    }
  }
  return state;
}

const shareLink = (source: string) =>
  `${location.origin}${location.pathname}#${btoa(unescape(encodeURIComponent(source)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')}`;

const state = loadState();

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="shell">
    <header class="bar">
      <div class="brand">Geek<span>chart</span></div>

      <div class="field"><label for="example">Example</label>
        <select id="example">
          <option value="">Custom</option>
          ${examples.map((e, i) => `<option value="${i}">${e.name}</option>`).join('')}
        </select>
      </div>

      <div class="field"><label for="scene">Scene</label>
        <select id="scene">
          ${(Object.keys(scenes) as SceneName[])
            .map((k) => `<option value="${k}" title="${scenes[k].description}">${scenes[k].label}</option>`)
            .join('')}
        </select>
      </div>

      <div class="field"><label for="aspect">Frame</label>
        <select id="aspect">
          ${ASPECTS.map((a) => `<option value="${a.value}" title="${a.hint}">${a.label}</option>`).join('')}
        </select>
      </div>

      <div class="field"><label for="fonts">Fonts</label>
        <select id="fonts">
          ${FONT_MODES.map((f) => `<option value="${f.value}" title="${f.hint}">${f.label}</option>`).join('')}
        </select>
      </div>

      <div class="field swatches">
        ${SWATCHES.map((c) => `<label title="${c.label}"><span>${c.label}</span>` +
          `<input type="color" data-color="${c.key}"></label>`).join('')}
        <button id="reset-palette" type="button" title="Back to the scene's own colours">Reset</button>
      </div>

      <div class="field">
        <label for="motion"><input id="motion" type="checkbox"> Motion</label>
      </div>

      <div class="spacer"></div>
      <button id="replay" type="button">Replay</button>
      <button id="copy-link" type="button">Copy link</button>
      <button id="save-svg" type="button">SVG</button>
      <button id="save-html" class="primary" type="button">Download HTML</button>
    </header>

    <div class="panes">
      <div class="editor">
        <textarea id="source" spellcheck="false" autocapitalize="off" autocorrect="off"
          placeholder="Paste a mermaid chart here"></textarea>
        <div class="status" id="status"></div>
      </div>
      <div class="preview" id="preview">
        <div class="stage" id="stage"></div>
        <div class="cli" id="cli"></div>
      </div>
    </div>
  </div>
`;

const el = {
  source: document.querySelector<HTMLTextAreaElement>('#source')!,
  example: document.querySelector<HTMLSelectElement>('#example')!,
  scene: document.querySelector<HTMLSelectElement>('#scene')!,
  aspect: document.querySelector<HTMLSelectElement>('#aspect')!,
  fonts: document.querySelector<HTMLSelectElement>('#fonts')!,
  swatches: [...document.querySelectorAll<HTMLInputElement>('input[data-color]')],
  resetPalette: document.querySelector<HTMLButtonElement>('#reset-palette')!,
  motion: document.querySelector<HTMLInputElement>('#motion')!,
  status: document.querySelector<HTMLDivElement>('#status')!,
  preview: document.querySelector<HTMLDivElement>('#preview')!,
  stage: document.querySelector<HTMLDivElement>('#stage')!,
  cli: document.querySelector<HTMLDivElement>('#cli')!,
  style: document.querySelector<HTMLStyleElement>('#chart-style')!,
};

/** The last render that succeeded. A failing keystroke never blanks the preview. */
let lastGood: RenderResult | null = null;

function syncControls(): void {
  el.source.value = state.source;
  el.scene.value = state.scene;
  el.aspect.value = state.aspect;
  el.fonts.value = state.fonts;
  for (const input of el.swatches) {
    const key = input.dataset.color!;
    input.value = state.palette[key] ?? (scenes[state.scene] as unknown as Record<string, string>)[key] ?? '#000000';
  }
  el.motion.checked = state.motion;
  const index = examples.findIndex((e) => e.source === state.source);
  el.example.value = index === -1 ? '' : String(index);
  el.preview.style.background = scenes[state.scene].bg;
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private browsing — not worth interrupting the user over */
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showStatus(result: RenderResult | null, error: ChartError | null): void {
  const parts: string[] = [];
  if (error) {
    const where = error.detail.line ? ` on line ${error.detail.line}` : '';
    parts.push(
      `<div class="err">Could not draw this${where}` +
        `${lastGood ? '<span class="stale">showing last good render</span>' : ''}` +
        `<code>${escapeHtml(error.detail.message)}` +
        `${error.detail.excerpt ? `\n\n${error.detail.line}: ${escapeHtml(error.detail.excerpt)}` : ''}</code></div>`,
    );
  }
  const shown = result ?? lastGood;
  if (shown?.repairs.length) {
    parts.push(
      `<div><span class="fixed">Cleaned up ${shown.repairs.length} thing${shown.repairs.length === 1 ? '' : 's'} in the paste:</span>` +
        `<ul>${shown.repairs.map((r) => `<li>${escapeHtml(r.message)}</li>`).join('')}</ul></div>`,
    );
  }
  if (shown?.warnings.length) {
    parts.push(
      `<div><span class="fixed">Worth knowing:</span><ul>` +
        `${shown.warnings.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul></div>`,
    );
  }
  if (!error && result) {
    const engine = result.path === 'flow' ? 'drawn' : 'mermaid';
    const motion = result.cycle > 0 ? ` · ${result.cycle.toFixed(1)}s loop` : ' · static';
    parts.push(
      `<div class="ok">${result.diagram} · ${result.nodes} nodes · ${result.edges} edges` +
        `${motion} · ${engine}</div>`,
    );
  }
  el.status.innerHTML = parts.join('');
}

/** Re-inserting the SVG restarts every CSS animation on it. */
function replay(): void {
  const svg = el.stage.querySelector('svg');
  if (!svg) return;
  const next = svg.nextSibling;
  svg.remove();
  void document.body.offsetWidth;
  el.stage.insertBefore(svg, next);
}

let token = 0;

async function draw(): Promise<void> {
  const mine = ++token;
  try {
    const result = await render(state.source, {
      scene: state.scene,
      motion: state.motion,
      aspect: state.aspect,
      // No measurement stack: the preview lays out in the very document it is
      // shown in, so an inherited font is measured and drawn as the same font.
      ...(state.fonts === 'inherit' ? { fonts: 'inherit' as const } : {}),
      ...(Object.keys(state.palette).length ? { palette: state.palette } : {}),
      height: Math.max(240, el.preview.clientHeight - 120),
    });
    if (mine !== token) return; // a newer keystroke already won
    lastGood = result;
    el.style.textContent = result.css;
    el.stage.innerHTML = result.svg;
    showStatus(result, null);
  } catch (err) {
    if (mine !== token) return;
    showStatus(null, err instanceof ChartError ? err : new ChartError({ message: String(err) }));
  }
  el.cli.textContent =
    `geekchart chart.mmd --scene ${state.scene}` +
    `${state.aspect === 'auto' ? '' : ` --aspect ${state.aspect}`}` +
    `${state.fonts === 'inherit' ? ' --fonts inherit' : ''}` +
    `${state.motion ? '' : ' --no-motion'} -o chart.svg`;
}

let timer: number | undefined;
function scheduleDraw(): void {
  persist();
  clearTimeout(timer);
  timer = setTimeout(() => void draw(), 220) as unknown as number;
}

function download(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function flash(button: HTMLButtonElement, text: string): void {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => (button.textContent = original), 1400);
}

el.source.addEventListener('input', () => {
  state.source = el.source.value;
  el.example.value = '';
  scheduleDraw();
});
el.example.addEventListener('change', () => {
  const index = Number(el.example.value);
  if (!el.example.value || Number.isNaN(index)) return;
  state.source = examples[index]!.source;
  el.source.value = state.source;
  scheduleDraw();
});
for (const input of el.swatches) {
  input.addEventListener('input', () => {
    state.palette[input.dataset.color!] = input.value;
    scheduleDraw();
  });
}
el.resetPalette.addEventListener('click', () => {
  state.palette = {};
  syncControls();
  scheduleDraw();
});
el.fonts.addEventListener('change', () => {
  state.fonts = el.fonts.value as State['fonts'];
  scheduleDraw();
});
el.aspect.addEventListener('change', () => {
  state.aspect = el.aspect.value as Aspect;
  scheduleDraw();
});
el.scene.addEventListener('change', () => {
  state.scene = el.scene.value as SceneName;
  syncControls();
  scheduleDraw();
});
el.motion.addEventListener('change', () => {
  state.motion = el.motion.checked;
  scheduleDraw();
});

document.querySelector<HTMLButtonElement>('#replay')!.addEventListener('click', replay);
document.querySelector<HTMLButtonElement>('#save-html')!.addEventListener('click', () => {
  if (lastGood) download('chart.html', lastGood.html, 'text/html');
});
document.querySelector<HTMLButtonElement>('#save-svg')!.addEventListener('click', () => {
  if (lastGood) download('chart.svg', lastGood.svgFile, 'image/svg+xml');
});
document.querySelector<HTMLButtonElement>('#copy-link')!.addEventListener('click', (event) => {
  const link = shareLink(state.source);
  history.replaceState(null, '', link);
  void navigator.clipboard.writeText(link);
  flash(event.currentTarget as HTMLButtonElement, 'Copied');
});
el.stage.addEventListener('click', replay);

// Nudge the user when a diagram type still goes through the older renderer.
el.source.addEventListener('blur', () => {
  if (drawnType(state.source) === null && lastGood?.path === 'legacy') {
    el.cli.textContent =
      'Flowchart, state, class, ER and sequence diagrams are drawn by geekchart. ' +
      'This type still uses mermaid\u2019s renderer.';
  }
});

syncControls();
void draw();
