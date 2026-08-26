import { parseWith } from './graph.ts';
import { makeMeasurer } from './layout.ts';
import { Track } from './motion.ts';
import { fitCanvas, frameTransform, type Scene } from './scene.ts';
import { WAVE_LAG } from './tokens.ts';

/**
 * Timeline, gantt and journey — the three diagrams that are really one shape.
 *
 * Each is a list of sections holding an ordered list of items positioned along a
 * shared axis, and mermaid reports all three that way: `getSections()` plus
 * `getTasks()`. What differs is only what an item *is* — a period holding
 * events, a bar spanning two dates, or a point at a height — so the scaffolding
 * (title, section bands, axis, motion) is written once and the item drawing
 * three times.
 *
 * They are also the three types whose axis carries meaning, which is why they
 * could never have gone through the graph pipeline: position here is data, not
 * the output of a layout search.
 */

export type ChronicleKind = 'timeline' | 'gantt' | 'journey';

interface Item {
  id: string;
  label: string;
  /** Normalised 0..1 along the axis. */
  start: number;
  /** Set when the item spans a range rather than sitting at a point. */
  end?: number;
  /** Extra lines: a timeline period's events. */
  detail?: string[];
  /** A journey score, 1..5. */
  value?: number;
  people?: string[];
  milestone?: boolean;
  state?: 'done' | 'active' | 'crit';
}

interface Lane {
  name: string;
  items: Item[];
}

export interface Chronicle {
  kind: ChronicleKind;
  title?: string;
  lanes: Lane[];
  /** Axis labels, already positioned. */
  ticks: { at: number; label: string }[];
  actors?: string[];
}

interface RawTask {
  section?: string;
  /** Gantt states are boolean flags on the task, not entries in `classes`. */
  done?: boolean;
  active?: boolean;
  crit?: boolean;
  task?: string;
  id?: string;
  events?: string[];
  score?: number;
  people?: string[];
  classes?: string[];
  milestone?: boolean;
  startTime?: string | Date;
  endTime?: string | Date;
}

const clean = (t: unknown) => String(t ?? '').trim();
const time = (v: string | Date | undefined): number =>
  v instanceof Date ? v.getTime() : v ? new Date(v).getTime() : Number.NaN;

/**
 * Format a date the way the source asked.
 *
 * Only the handful of strftime fields a gantt axis actually uses. Pulling in a
 * date library to cover the rest would cost more than every other part of this
 * renderer put together.
 */
function formatDate(ms: number, pattern: string): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return pattern.replace(/%[a-zA-Z]/g, (token) => {
    switch (token) {
      case '%Y':
        return String(d.getFullYear());
      case '%y':
        return pad(d.getFullYear() % 100);
      case '%m':
        return pad(d.getMonth() + 1);
      case '%b':
        return months[d.getMonth()]!;
      case '%d':
        return pad(d.getDate());
      case '%e':
        return String(d.getDate());
      case '%H':
        return pad(d.getHours());
      case '%M':
        return pad(d.getMinutes());
      default:
        return token;
    }
  });
}

/** Round a span to a tick step that lands on whole days, weeks or months. */
function dateTicks(from: number, to: number, pattern: string): { at: number; label: string }[] {
  const DAY = 86400000;
  const span = Math.max(to - from, DAY);
  const steps = [DAY, 2 * DAY, 7 * DAY, 14 * DAY, 28 * DAY, 91 * DAY, 182 * DAY, 365 * DAY];
  const step = steps.find((s) => span / s <= 7) ?? steps[steps.length - 1]!;
  const out: { at: number; label: string }[] = [];
  const start = Math.ceil(from / step) * step;
  for (let t = start; t <= to; t += step) {
    out.push({ at: (t - from) / span, label: formatDate(t, pattern) });
  }
  // A span shorter than one step gets its own ends rather than no axis at all.
  if (out.length < 2) {
    return [
      { at: 0, label: formatDate(from, pattern) },
      { at: 1, label: formatDate(to, pattern) },
    ];
  }
  return out;
}

export async function toChronicle(source: string, kind: ChronicleKind): Promise<Chronicle> {
  const db = await parseWith(source);
  const sections = ((db.getSections?.() as string[]) ?? []).map(clean);
  const tasks = ((db.getTasks?.() as RawTask[]) ?? []).filter(Boolean);
  if (!tasks.length) throw new Error(`Nothing to draw — this ${kind} has no entries.`);

  // Timeline accepts a `title` line and then drops it: its parser routes the
  // value to a shared common database that `getCommonDb()` does not hand back.
  // Reading it from the source is a one-line regex and cannot go stale.
  const title =
    clean(db.getDiagramTitle?.()) ||
    clean(/^[ \t]*title[ \t]+(.+)$/m.exec(source.split(/^[ \t]*section\b/m)[0] ?? '')?.[1]);
  const lanes: Lane[] = (sections.length ? sections : ['']).map((name) => ({ name, items: [] }));
  const laneOf = (name: string) => lanes.find((l) => l.name === clean(name)) ?? lanes[0]!;

  let ticks: { at: number; label: string }[] = [];

  if (kind === 'gantt') {
    const starts = tasks.map((t) => time(t.startTime)).filter(Number.isFinite);
    const ends = tasks.map((t) => time(t.endTime)).filter(Number.isFinite);
    const from = Math.min(...starts);
    const to = Math.max(...ends);
    const span = Math.max(to - from, 1);
    const pattern = clean(db.getAxisFormat?.()) || '%b %e';
    ticks = dateTicks(from, to, pattern);
    tasks.forEach((t, i) => {
      const s = time(t.startTime);
      const e = time(t.endTime);
      const classes = (t.classes ?? []).map(String);
      // `crit` first: a critical task that is also done should still read as
      // critical, which is the whole reason for marking it.
      const state = t.crit ? 'crit' : t.active ? 'active' : t.done ? 'done' : undefined;
      laneOf(t.section ?? '').items.push({
        id: clean(t.id) || `task-${i}`,
        label: clean(t.task),
        start: (s - from) / span,
        end: (e - from) / span,
        milestone: t.milestone === true || classes.includes('milestone'),
        ...(state ? { state } : {}),
      });
    });
  } else {
    // Timeline periods and journey steps are both ordinal: the order is the
    // axis, and the gaps between them mean nothing.
    const last = Math.max(tasks.length - 1, 1);
    tasks.forEach((t, i) => {
      const at = tasks.length === 1 ? 0.5 : i / last;
      laneOf(t.section ?? '').items.push({
        id: `step-${i}`,
        label: clean(t.task),
        start: at,
        ...(t.events?.length ? { detail: t.events.map(clean).filter(Boolean) } : {}),
        ...(typeof t.score === 'number' && t.score > 0 ? { value: t.score } : {}),
        ...(t.people?.length ? { people: t.people.map(clean) } : {}),
      });
    });
  }

  const actors = ((db.getActors?.() as string[]) ?? []).map(clean).filter(Boolean);
  return {
    kind,
    ...(title ? { title } : {}),
    lanes: lanes.filter((l) => l.items.length),
    ticks,
    ...(actors.length ? { actors } : {}),
  };
}

/* ------------------------------------------------------------------ drawing */

const SVGNS = 'http://www.w3.org/2000/svg';
const esc = (t: string) =>
  t.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const round = (n: number) => Number(n.toFixed(2));

/**
 * Shorten a label to fit its slot, rather than widening the slot. DESIGN 2.2.
 *
 * Timeline and journey items sit at fixed, evenly spaced points along a fixed-
 * width axis — the slot between neighbours does not grow with the label, so a
 * period or event whose text is wider than its own slot is truncated with an
 * ellipsis instead of overlapping the item next to it.
 */
function fitLabel(text: string, maxW: number, font: string, size: number, width: Measure): string {
  if (width(text, font, size) <= maxW) return text;
  let cut = text;
  while (cut.length > 1 && width(`${cut}…`, font, size) > maxW) cut = cut.slice(0, -1);
  return `${cut}…`;
}

export interface ChronicleDrawing {
  svg: string;
  css: string;
  cycle: number;
  summary: string;
  /** How many things were drawn, for the CLI's one-line report. */
  lanes: number;
  items: number;
}

/** One drawn thing plus when it should arrive. */
/**
 * Time at which the scene's ease (cubic-bezier(0.61, 0, 0.39, 1)) has covered
 * `fraction` of the distance. The travelling dot is eased, so a period at 50%
 * of the axis is reached well after 50% of the travel time — a dot timed
 * linearly would appear before the runner got there. Solved by bisection on
 * the Bézier's y, then read back as x (the time axis).
 */
function easedTimeFor(fraction: number): number {
  const v = Math.min(1, Math.max(0, fraction));
  const x1 = 0.61,
    y1 = 0,
    x2 = 0.39,
    y2 = 1;
  const bx = (t: number) => 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t ** 2 * x2 + t ** 3;
  const by = (t: number) => 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t ** 2 * y2 + t ** 3;
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (by(mid) < v) lo = mid;
    else hi = mid;
  }
  return bx((lo + hi) / 2);
}

interface Beat {
  id: string;
  markup: string;
  /** Where along the axis this beat sits, 0..1 — a timeline times its items
   *  off this (when the travelling dot passes them) instead of off their
   *  index. */
  at?: number;
}

export function drawChronicle(
  chronicle: Chronicle,
  scene: Scene,
  measureWith?: string,
): ChronicleDrawing {
  const measurer = makeMeasurer(measureWith);
  const width = (t: string, font: string, size: number, tracking?: string) =>
    measurer.measure(t, font, size, tracking);

  // The canvas owns the margin; nothing here picks its own. DESIGN 1.3.
  const pad = scene.canvas.margin;
  const titleH = chronicle.title ? scene.type.title * 1.9 : 0;
  const items = chronicle.lanes.flatMap((l) => l.items);

  const parts: string[] = [];
  const beats: Beat[] = [];
  const bands: string[] = [];

  const built =
    chronicle.kind === 'gantt'
      ? gantt(chronicle, scene, width, pad, titleH, parts, beats, bands)
      : chronicle.kind === 'timeline'
        ? timeline(chronicle, scene, width, pad, titleH, parts, beats, bands)
        : journey(chronicle, scene, width, pad, titleH, parts, beats, bands);

  measurer.done();

  const title = chronicle.title
    ? `<text class="gc-chron-title" x="${round(built.width / 2)}" y="${round(pad + scene.type.title)}">${esc(chronicle.title)}</text>`
    : '';

  const frame = fitCanvas({ x: 0, y: 0, width: built.width, height: built.height }, scene.canvas);
  const svg =
    `<svg class="gc-chart" viewBox="0 0 ${frame.width} ${frame.height}" ` +
    `width="${frame.width}" height="${frame.height}" role="img" xmlns="${SVGNS}">` +
    `<g class="gc-frame" transform="${frameTransform(frame)}">` +
    bands.join('') +
    parts.join('') +
    beats.map((b) => b.markup).join('') +
    title +
    `</g></svg>`;

  const timeline_ = animate(
    chronicle,
    beats,
    bands.length,
    Boolean(chronicle.title),
    Boolean(built.legend),
    scene,
  );

  const noun = { gantt: 'Gantt chart', timeline: 'Timeline', journey: 'User journey' }[
    chronicle.kind
  ];
  const summary =
    `${noun}${chronicle.title ? `: ${chronicle.title}` : ''}. ` +
    `${chronicle.lanes.length} section${chronicle.lanes.length === 1 ? '' : 's'}, ` +
    `${items.length} entr${items.length === 1 ? 'y' : 'ies'}.`;

  return {
    svg,
    css: timeline_.css,
    cycle: timeline_.cycle,
    summary,
    lanes: chronicle.lanes.length,
    items: items.length,
  };
}

type Measure = (t: string, font: string, size: number, tracking?: string) => number;

/**
 * A gantt chart: one row per task, bars on a date axis.
 *
 * The section name lives in a left gutter beside its rows rather than on a row
 * of its own, so the bars all start at the same x and the eye can read down the
 * plot without stepping over headings.
 */
function gantt(
  c: Chronicle,
  scene: Scene,
  width: Measure,
  pad: number,
  titleH: number,
  parts: string[],
  beats: Beat[],
  bands: string[],
): { width: number; height: number; legend?: boolean } {
  const gutter = Math.max(
    90,
    ...c.lanes.map((l) => width(l.name, scene.titleFont, scene.type.name) + 28),
  );
  // The date axis is given every unit the canvas has left rather than the width
  // the longest label happens to want. DESIGN 1.1 and 7.4: the plot is the chart,
  // so it is the thing that fills the stage.
  const x0 = pad + gutter;
  const plot = Math.max(scene.plotWidth, scene.canvas.width - x0 - pad - 12);
  const axisY = pad + titleH + scene.type.label + 10;
  const top = axisY + 14;
  const all = c.lanes.flatMap((l) => l.items);
  const rows = all.length;
  const at = (v: number) => x0 + v * plot;

  // A legend only earns its row when colour or shape is doing work (7.2): a
  // plain gantt with no states or milestones has nothing to explain.
  const legendItems: { key: 'done' | 'active' | 'crit' | 'milestone'; label: string }[] = [];
  (['done', 'active', 'crit'] as const).forEach((s) => {
    if (all.some((i) => i.state === s))
      legendItems.push({
        key: s,
        label: s === 'crit' ? 'Critical' : s === 'active' ? 'Active' : 'Done',
      });
  });
  if (all.some((i) => i.milestone)) legendItems.push({ key: 'milestone', label: 'Milestone' });
  const legendH = legendItems.length ? scene.type.label * 3 : 0;

  const height = top + rows * scene.rowHeight + legendH + pad;

  const rowsBottom = top + rows * scene.rowHeight;
  for (const tick of c.ticks) {
    parts.push(
      `<text class="gc-chron-tick" x="${round(at(tick.at))}" y="${round(axisY)}">${esc(tick.label)}</text>` +
        `<path class="gc-chron-grid" d="M${round(at(tick.at))},${round(top)} V${round(rowsBottom)}"/>`,
    );
  }

  // A bar's right edge is otherwise its end date and nothing else — but a
  // label that never fits inside its own bar is worse than a bar slightly
  // wider than its dates, so a bar too narrow for its own name is widened to
  // fit it. The start still sits exactly on its date; only the end gives.
  // Worked out for every item first, so the lane band behind it (and the
  // chart's own width) can be sized to whatever actually got drawn, not just
  // what the dates alone would have needed.
  const bw = new Map<string, number>();
  let maxRight = x0 + plot;
  for (const item of all) {
    const bx = at(item.start);
    const w = item.milestone
      ? Math.max(6, at(item.end ?? item.start) - bx)
      : Math.max(
          6,
          at(item.end ?? item.start) - bx,
          width(item.label, scene.titleFont, scene.type.name) + 24,
        );
    bw.set(item.id, w);
    maxRight = Math.max(maxRight, bx + w);
  }
  const laneRight = Math.max(gutter + plot + 12, maxRight - pad + 12);

  let row = 0;
  c.lanes.forEach((lane, li) => {
    const y = top + row * scene.rowHeight;
    const h = lane.items.length * scene.rowHeight;
    bands.push(
      `<g class="gc-chron-band" data-id="band-${li}">` +
        `<rect class="gc-chron-band-box" x="${round(pad)}" y="${round(y)}" width="${round(laneRight)}" height="${round(h)}" rx="8"/>` +
        `<text class="gc-chron-lane" x="${round(pad + 14)}" y="${round(y + h / 2 + scene.type.name * 0.36)}">${esc(lane.name)}</text>` +
        `</g>`,
    );
    for (const item of lane.items) {
      const iy = top + row * scene.rowHeight + (scene.rowHeight - scene.barHeight) / 2;
      const bx = at(item.start);
      const w = bw.get(item.id)!;
      const labelW = width(item.label, scene.titleFont, scene.type.name);
      const state = item.state ? ` gc-state-${item.state}` : '';
      // Inside its own bar always, now that every bar is guaranteed wide
      // enough — a milestone still has nothing to hold a label inside, so it
      // keeps the old rule: label to the right, unless that would run the
      // chart off its own edge, in which case the label flips to the left.
      const inside = !item.milestone;
      const overflows = !inside && bx + w + 12 + labelW > x0 + plot;
      const shape = item.milestone
        ? `<path class="gc-chron-bar gc-milestone${state}" data-id="${esc(item.id)}" d="M${round(bx)},${round(iy)} l${round(scene.barHeight / 2)},${round(scene.barHeight / 2)} l${round(-scene.barHeight / 2)},${round(scene.barHeight / 2)} l${round(-scene.barHeight / 2)},${round(-scene.barHeight / 2)} Z"/>`
        : `<rect class="gc-chron-bar${state}" data-id="${esc(item.id)}" x="${round(bx)}" y="${round(iy)}" width="${round(w)}" height="${scene.barHeight}" rx="6"/>`;
      beats.push({
        id: item.id,
        markup:
          `<g class="gc-chron-item" data-id="${esc(item.id)}">` +
          shape +
          `<text class="gc-chron-label${inside ? ' gc-on-bar' : ''}${overflows ? ' gc-before' : ''}" ` +
          `x="${round(inside ? bx + 12 : overflows ? bx - 12 : bx + w + 12)}" ` +
          `y="${round(iy + scene.barHeight / 2 + scene.type.name * 0.36)}">${esc(item.label)}</text>` +
          `</g>`,
      });
      row++;
    }
  });

  if (legendItems.length) {
    parts.push(ganttLegend(legendItems, scene, width, x0, height - pad - 4));
  }

  return { width: maxRight + pad + 12, height, legend: legendItems.length > 0 };
}

/**
 * The bottom row explaining what a bar's colour or a diamond's shape means.
 *
 * DESIGN 7.2: swatches plus 8-mono-caps labels, one row, left-aligned — here at
 * `x0`, the same x the date grid and every bar start from, so the legend reads
 * as part of the same grid rather than a caption glued under it.
 */
function ganttLegend(
  items: { key: 'done' | 'active' | 'crit' | 'milestone'; label: string }[],
  scene: Scene,
  width: Measure,
  x0: number,
  y: number,
): string {
  const gap = 20;
  const swatchCy = y - scene.type.label * 0.9 + 4;
  let x = x0;
  const chips = items.map((it) => {
    const swatch =
      it.key === 'milestone'
        ? `<path class="gc-chron-bar gc-milestone gc-legend-swatch" d="M${round(x + 4)},${round(swatchCy - 4)} L${round(x + 8)},${round(swatchCy)} L${round(x + 4)},${round(swatchCy + 4)} L${round(x)},${round(swatchCy)} Z"/>`
        : `<rect class="gc-chron-bar gc-state-${it.key}" x="${round(x)}" y="${round(swatchCy - 4)}" width="8" height="8" rx="2"/>`;
    const label = `<text class="gc-chron-legend-label" x="${round(x + 14)}" y="${round(y)}">${esc(it.label)}</text>`;
    x += width(it.label, scene.rowFont, scene.type.label, scene.type.labelTracking) + 18 + gap;
    return swatch + label;
  });
  return `<g class="gc-chron-legend">${chips.join('')}</g>`;
}

/**
 * A timeline: periods on a horizontal axis, their events hanging below.
 *
 * Sections become bands spanning the periods they contain, which is the only
 * part of the picture that says where one phase ends and the next begins.
 */
function timeline(
  c: Chronicle,
  scene: Scene,
  width: Measure,
  pad: number,
  titleH: number,
  parts: string[],
  beats: Beat[],
  bands: string[],
): { width: number; height: number; legend?: boolean } {
  const all = c.lanes.flatMap((l) => l.items);
  const cardW =
    Math.max(
      140,
      ...all.flatMap((i) => [
        width(i.label, scene.titleFont, scene.type.name),
        ...(i.detail ?? []).map((d) => width(d, scene.rowFont, scene.type.caption)),
      ]),
    ) + 28;
  // Periods are spread across the whole canvas rather than packed at their own
  // minimum width, which is what left the timeline a strip on an empty stage.
  const plot = Math.max(scene.plotWidth, scene.canvas.width - pad * 2 - cardW);
  const x0 = pad + cardW / 2;
  const bandY = pad + titleH;
  const bandH = scene.type.name * 2.4;
  const axisY = bandY + bandH + 34;
  const deepest = Math.max(...all.map((i) => (i.detail ?? []).length));
  const height = axisY + 40 + scene.type.name * 1.4 + deepest * (scene.rowStep + 12) + pad;
  const at = (v: number) => x0 + v * plot;
  // A band reaches half a slot past the periods at either end. Reaching half a
  // *card* past them, as it used to, is wider than the slot itself once the
  // periods are spread across the canvas — and two neighbouring bands then
  // overlap, which says two sections share a week.
  const reach = Math.min(cardW, all.length > 1 ? plot / (all.length - 1) : cardW) / 2 - 4;

  parts.push(
    `<path class="gc-chron-axis" d="M${round(pad)},${round(axisY)} H${round(x0 + plot + cardW / 2)}"/>`,
  );
  // One dot travels left to right and leaves a dot behind at each period as it
  // passes, rather than every dot popping in on its own — DESIGN 5.4: colour
  // (and the one thing moving) carries motion, not decoration.
  // The runner rides the *whole drawn axis*: it fades in from the line's start,
  // deposits each period as it passes, and fades out at the line's absolute end
  // (only after the last period). Periods are timed as fractions of this path.
  const axisEnd = x0 + plot + cardW / 2;
  const axisLen = axisEnd - pad;
  parts.push(
    `<circle class="gc-chron-lead" r="6" style="offset-path:path('M${round(pad)},${round(axisY)} H${round(axisEnd)}')"/>`,
  );

  c.lanes.forEach((lane, li) => {
    const from = at(Math.min(...lane.items.map((i) => i.start))) - reach;
    const to = at(Math.max(...lane.items.map((i) => i.start))) + reach;
    bands.push(
      `<g class="gc-chron-band" data-id="band-${li}">` +
        `<rect class="gc-chron-band-box" x="${round(from)}" y="${round(bandY)}" width="${round(to - from)}" height="${round(bandH)}" rx="8"/>` +
        `<text class="gc-chron-lane" x="${round((from + to) / 2)}" y="${round(bandY + bandH / 2 + scene.type.name * 0.36)}" text-anchor="middle">${esc(lane.name)}</text>` +
        `</g>`,
    );
  });

  // Each item owns one slot on the axis, centred on its dot. Its label and
  // event rows sit inside that slot — widening it would run text into the
  // neighbouring item, so a label too wide for its own slot is shortened
  // instead (DESIGN 2.2). `2 * reach` is the same safe half-width the section
  // bands already use to avoid overlapping each other.
  const slotW = 2 * reach - 8;
  for (const item of all) {
    const x = at(item.start);
    const rows = (item.detail ?? []).map((text, i) => {
      const y = axisY + 40 + scene.type.name * 1.4 + i * (scene.rowStep + 12);
      // No card behind the name. DESIGN 10.5: the dot and the column already
      // group these, so the box adds nothing — and once the periods are spread
      // across the full canvas the boxes are wider than their own slot and
      // overlap their neighbours, which is a box costing legibility for decor.
      const fitted = fitLabel(text, slotW, scene.rowFont, scene.type.caption, width);
      return `<text class="gc-chron-event" x="${round(x)}" y="${round(y + scene.rowStep * 0.72)}">${esc(fitted)}</text>`;
    });
    const label = fitLabel(item.label, slotW, scene.titleFont, scene.type.name, width);
    beats.push({
      id: item.id,
      at: (at(item.start) - pad) / axisLen,
      markup:
        `<g class="gc-chron-item" data-id="${esc(item.id)}">` +
        `<circle class="gc-chron-dot" cx="${round(x)}" cy="${round(axisY)}" r="6"/>` +
        `<text class="gc-chron-period" x="${round(x)}" y="${round(axisY + 34)}">${esc(label)}</text>` +
        rows.join('') +
        `</g>`,
    });
  }

  return { width: x0 + plot + cardW / 2 + pad, height };
}

/**
 * A user journey: satisfaction as a height, step by step.
 *
 * Mermaid draws these as a row of equal boxes with a number in each, which
 * throws away the one thing the notation records — that the score rises and
 * falls. Plotting it makes the shape of the week readable at a glance.
 */
function journey(
  c: Chronicle,
  scene: Scene,
  width: Measure,
  pad: number,
  titleH: number,
  parts: string[],
  beats: Beat[],
  bands: string[],
): { width: number; height: number; legend?: boolean } {
  const all = c.lanes.flatMap((l) => l.items);
  const cardW =
    Math.max(
      120,
      ...all.flatMap((i) => [
        width(i.label, scene.titleFont, scene.type.name),
        width((i.people ?? []).join(' · '), scene.rowFont, scene.type.caption),
      ]),
    ) + 26;
  // The score-axis gutter, sized to what the "1".."5" ticks actually need
  // rather than a guessed constant — DESIGN 7.3: a guess that runs wider than
  // the label leaves dead space fitCanvas has no way to see, which reads as
  // the whole block sitting off-centre once it's centred on that overstated
  // width.
  const tickGap = 12; // clearance between a tick label and the grid line
  const tickW = Math.max(
    ...[1, 2, 3, 4, 5].map((s) =>
      width(String(s), scene.rowFont, scene.type.label, scene.type.labelTracking),
    ),
  );
  const axisGutter = tickW + tickGap + 6;
  const plot = Math.max(scene.plotWidth, scene.canvas.width - pad * 2 - axisGutter - cardW);
  const x0 = pad + axisGutter + cardW / 2;
  const bandY = pad + titleH;
  const bandH = scene.type.name * 2.4;
  const plotTop = bandY + bandH + 26;
  const plotH = 288;
  const height = plotTop + plotH + scene.type.name * 1.6 + scene.type.caption * 2.6 + pad;
  const at = (v: number) => x0 + v * plot;
  // Journeys are scored 1..5; the axis is fixed so two charts can be compared.
  const y = (score: number) => plotTop + plotH - ((score - 1) / 4) * plotH;

  for (let s = 1; s <= 5; s++) {
    parts.push(
      `<path class="gc-chron-grid" d="M${round(pad + tickW + tickGap)},${round(y(s))} H${round(x0 + plot + cardW / 2)}"/>` +
        `<text class="gc-chron-tick gc-anchor-end" x="${round(pad + tickW)}" y="${round(y(s) + 4)}" text-anchor="end">${s}</text>`,
    );
  }

  // Every section's tag is the same kind of pill, sized to its own name and
  // centred on the mean position of its own entries — not stretched to span
  // from its first entry to its last. A section spanning two steps otherwise
  // draws a box roughly twice the width of a section with one, which reads as
  // "this phase matters twice as much" rather than "this phase happens to
  // hold two entries" (DESIGN 2.3: siblings in a row share a size).
  const tagW = Math.max(
    ...c.lanes.map((lane) => width(lane.name, scene.titleFont, scene.type.name) + 32),
    cardW * 0.7,
  );
  c.lanes.forEach((lane, li) => {
    const meanX = lane.items.reduce((s, i) => s + at(i.start), 0) / lane.items.length;
    const from = meanX - tagW / 2;
    const to = meanX + tagW / 2;
    bands.push(
      `<g class="gc-chron-band" data-id="band-${li}">` +
        `<rect class="gc-chron-band-box" x="${round(from)}" y="${round(bandY)}" width="${round(to - from)}" height="${round(bandH)}" rx="8"/>` +
        `<text class="gc-chron-lane" x="${round(meanX)}" y="${round(bandY + bandH / 2 + scene.type.name * 0.36)}" text-anchor="middle">${esc(lane.name)}</text>` +
        `</g>`,
    );
  });

  const pts = all.map((i) => ({ x: at(i.start), y: y(i.value ?? 3) }));
  const line = pts.map((p, n) => `${n === 0 ? 'M' : 'L'}${round(p.x)},${round(p.y)}`).join(' ');
  parts.push(`<path class="gc-chron-line" pathLength="1" d="${line}"/>`);
  // Where along the drawn line each step sits (fraction of the polyline's
  // length): the line draws on with pathLength 1, so a step appears exactly as
  // the line's head touches it, not on an index cadence.
  const cumulative: number[] = [0];
  for (let n = 1; n < pts.length; n++)
    cumulative.push(
      cumulative[n - 1]! + Math.hypot(pts[n]!.x - pts[n - 1]!.x, pts[n]!.y - pts[n - 1]!.y),
    );
  const lineLength = cumulative[cumulative.length - 1] || 1;

  // Steps sit at fixed, evenly spaced points along a fixed-width axis, same as
  // a timeline's periods (DESIGN 2.2): a label wider than its own slot is
  // shortened rather than left to run into the step beside it.
  const journeySlot = (all.length > 1 ? plot / (all.length - 1) : plot) - 8;
  for (const item of all) {
    const x = at(item.start);
    const py = y(item.value ?? 3);
    const label = fitLabel(item.label, journeySlot, scene.titleFont, scene.type.name, width);
    const people = item.people?.length
      ? fitLabel(item.people.join(' · '), journeySlot, scene.rowFont, scene.type.caption, width)
      : '';
    beats.push({
      id: item.id,
      at: cumulative[all.indexOf(item)]! / lineLength,
      markup:
        `<g class="gc-chron-item" data-id="${esc(item.id)}">` +
        `<circle class="gc-chron-dot" cx="${round(x)}" cy="${round(py)}" r="7"/>` +
        `<text class="gc-chron-period" x="${round(x)}" y="${round(plotTop + plotH + scene.type.name * 1.5)}">${esc(label)}</text>` +
        (people
          ? `<text class="gc-chron-people" x="${round(x)}" y="${round(plotTop + plotH + scene.type.name * 1.5 + scene.type.caption + 8)}">${esc(people)}</text>`
          : '') +
        `</g>`,
    });
  }

  return { width: x0 + plot + cardW / 2 + pad, height };
}

/**
 * Everything arrives along the axis, in order.
 *
 * The same reasoning as a sequence diagram: the order is the content. A gantt
 * chart whose bars appeared all at once would say nothing about what follows
 * what, which is the only reason to draw one.
 */
function animate(
  c: Chronicle,
  beats: Beat[],
  bandCount: number,
  hasTitle: boolean,
  hasLegend: boolean,
  scene: Scene,
): { css: string; cycle: number } {
  const m = scene.motion;
  const tracks = new Map<string, Track>();
  const track = (selector: string) => {
    const found = tracks.get(selector);
    if (found) return found;
    const made = new Track();
    tracks.set(selector, made);
    return made;
  };

  const lead = 0.25;
  const scaffold = lead + m.build;
  const step = Math.min(m.lag * 0.8, 2.6 / Math.max(beats.length, 1) + 0.16);
  const last = scaffold + 0.2 + Math.max(beats.length - 1, 0) * step + m.build;
  const cycle = last + m.hold;

  const fade = (selector: string, from: number, over = m.build * 0.8) => {
    const t = track(selector);
    t.at(0, { opacity: '0' });
    t.at(from, { opacity: '0' });
    t.at(from + over, { opacity: '1' });
    t.at(cycle, { opacity: '1' });
  };

  if (hasTitle) fade('.gc-chron-title', lead, m.build * 0.7);
  // The axis, its gridlines and its tick labels were drawn straight into the
  // scaffold and never animated, so they were on screen from the first frame —
  // before the title, before anything they were meant to be measuring. They are
  // the frame the chart is read against, so they arrive first, but they do
  // arrive.
  fade('.gc-chron-grid', lead + 0.08);
  fade('.gc-chron-axis', lead + 0.08);
  fade('.gc-chron-tick', lead + 0.14);
  if (hasLegend) fade('.gc-chron-legend', scaffold);
  for (let i = 0; i < bandCount; i++) {
    const band = track(`.gc-chron-band[data-id="band-${i}"]`);
    band.at(0, { opacity: '0' });
    band.at(lead + i * 0.09, { opacity: '0' });
    band.at(lead + i * 0.09 + m.build * 0.8, { opacity: '1' });
    band.at(cycle, { opacity: '1' });
  }
  // The journey's connecting line is the one thing that draws rather than fades:
  // it is a path, and watching it climb and fall is the point of the chart.
  if (c.kind === 'journey') {
    const line = track('.gc-chron-line');
    line.at(0, { 'stroke-dashoffset': '1', opacity: '0' });
    line.at(scaffold, { 'stroke-dashoffset': '1', opacity: '0' });
    line.at(scaffold + 0.02, { opacity: '1' });
    line.at(last, { 'stroke-dashoffset': '0' });
    line.at(cycle, { 'stroke-dashoffset': '0', opacity: '1' });
  }

  // A timeline times its periods off where the one travelling dot actually is,
  // not off their index — otherwise a lead dot sweeping the axis at a steady
  // rate would desync from periods popping in at a fixed cadence regardless of
  // how they happen to be spaced. Gantt and journey have no lead dot (their
  // own bar-grow and line-draw already carry the motion, DESIGN 5.4) and keep
  // the even, index-paced cadence.
  const travelStart = scaffold + 0.2;
  const travelEnd = last;
  if (c.kind === 'timeline') {
    const span = travelEnd - travelStart;
    // Fade in over the first 8% of the line; hold; fade out only after the last
    // period has been passed, reaching 0 exactly at the line's end.
    const lastPass = travelStart + Math.max(0, ...beats.map((b) => easedTimeFor(b.at ?? 0))) * span;
    const fadeOutFrom = Math.max(lastPass + 0.05, travelEnd - 0.35);
    const lead2 = track('.gc-chron-lead');
    lead2.at(0, { opacity: '0', 'offset-distance': '0%' });
    lead2.at(travelStart, { opacity: '0', 'offset-distance': '0%' });
    lead2.at(travelStart + span * 0.08, { opacity: '1' });
    lead2.at(fadeOutFrom, { opacity: '1' });
    lead2.at(travelEnd, { opacity: '0', 'offset-distance': '100%' });
    lead2.at(cycle, { opacity: '0', 'offset-distance': '0%' });
  }

  beats.forEach((beat, i) => {
    const portion = beats.length > 1 ? i / (beats.length - 1) : 0;
    const lineStart = scaffold + 0.02,
      lineEnd = last;
    const start =
      c.kind === 'timeline'
        ? travelStart + easedTimeFor(beat.at ?? portion) * (travelEnd - travelStart)
        : c.kind === 'journey'
          ? lineStart + easedTimeFor(beat.at ?? portion) * (lineEnd - lineStart)
          : scaffold + 0.2 + i * step;
    if (c.kind === 'journey') {
      // A step appears as the line's head touches it: a smooth, quick rise from
      // nothing (r 0→7, 0.2s) right where the line is, with its label fading in
      // just after. Nothing floats up from below (DESIGN 10.4).
      const dot = track(`.gc-chron-item[data-id="${beat.id}"] .gc-chron-dot`);
      dot.at(0, { r: '0', opacity: '0' });
      dot.at(start - 0.01, { r: '0', opacity: '0' });
      dot.at(start + 0.04, { opacity: '1' });
      dot.at(start + 0.2, { r: '7', opacity: '1' });
      dot.at(cycle, { r: '7', opacity: '1' });
      const text = track(`.gc-chron-item[data-id="${beat.id}"] text`);
      text.at(0, { opacity: '0' });
      text.at(start + 0.05, { opacity: '0' });
      text.at(start + 0.05 + m.build * 0.7, { opacity: '1' });
      text.at(cycle, { opacity: '1' });
    } else if (c.kind === 'timeline') {
      // The travelling dot *deposits* the stationary one as it passes: the dot
      // snaps to full size at the pass (r 0→6 with the press easing, 0.15s), and
      // only the text below it fades in afterwards — never the dot fading on
      // its own beside the runner (DESIGN 10.4).
      const dot = track(`.gc-chron-item[data-id="${beat.id}"] .gc-chron-dot`);
      dot.at(0, { r: '0', opacity: '0' });
      dot.at(start - 0.01, { r: '0', opacity: '0' });
      dot.at(start, { opacity: '1' });
      dot.at(start + WAVE_LAG, { r: '6', opacity: '1' });
      dot.at(cycle, { r: '6', opacity: '1' });
      const text = track(
        `.gc-chron-item[data-id="${beat.id}"] text, .gc-chron-item[data-id="${beat.id}"] rect`,
      );
      text.at(0, { opacity: '0', transform: 'translateY(6px)' });
      text.at(start + 0.05, { opacity: '0', transform: 'translateY(6px)' });
      text.at(start + 0.05 + m.build, { opacity: '1', transform: 'translateY(0)' });
      text.at(cycle, { opacity: '1', transform: 'translateY(0)' });
    } else {
      const item = track(`.gc-chron-item[data-id="${beat.id}"]`);
      item.at(0, { opacity: '0', transform: 'translateY(6px)' });
      item.at(start, { opacity: '0', transform: 'translateY(6px)' });
      item.at(start + m.build, { opacity: '1', transform: 'translateY(0)' });
      item.at(cycle, { opacity: '1', transform: 'translateY(0)' });
    }
  });

  const rules: string[] = [];
  const frames: string[] = [];
  let index = 0;
  for (const [selector, value] of tracks) {
    if (value.empty) continue;
    const name = `gc-c${index++}`;
    rules.push(`${selector}{animation:${name} ${cycle.toFixed(2)}s ${m.ease} infinite}`);
    frames.push(`@keyframes ${name}{${value.frames(cycle)}}`);
  }

  return {
    cycle,
    css: `
@media (prefers-reduced-motion: no-preference) {
.gc-chron-item, .gc-chron-item text, .gc-chron-item rect { transform-box: fill-box; transform-origin: center; }
.gc-chron-line { stroke-dasharray: 1; }
${rules.join('\n')}
${frames.join('\n')}
}
`,
  };
}

/** The stylesheet for all three. */
export function chronicleCss(scene: Scene): string {
  return `
.gc-chron-title { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.titleFont};
  font-weight: ${scene.type.titleWeight}; font-size: ${scene.type.title}px;
  letter-spacing: ${scene.type.titleTracking}; text-anchor: middle; }
.gc-chron-band-box { fill: var(--gc-surface, ${scene.surface}); }
.gc-chron-lane { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.titleFont};
  font-weight: ${scene.type.nameWeight}; font-size: ${scene.type.name}px; }
.gc-chron-grid { fill: none; stroke: var(--gc-edge, ${scene.edge}); stroke-width: ${scene.dividerStroke}px;
  opacity: .28; }
.gc-chron-axis { fill: none; stroke: var(--gc-edge, ${scene.edge}); stroke-width: ${scene.edgeStroke}px;
  opacity: .6; }
.gc-chron-tick { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.rowFont};
  font-size: ${scene.type.label}px; letter-spacing: ${scene.type.labelTracking};
  text-anchor: middle; text-transform: uppercase; }
/* A class beats a presentation attribute in the cascade regardless of
   specificity, so the score-axis tick's text-anchor="end" needs this to
   actually take effect over the rule above (DESIGN 7.3). */
.gc-anchor-end { text-anchor: end; }
.gc-chron-legend-label { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.rowFont};
  font-size: ${scene.type.label}px; letter-spacing: ${scene.type.labelTracking};
  text-transform: uppercase; }

.gc-chron-bar { fill: var(--gc-path, ${scene.path}); }
.gc-chron-bar.gc-milestone { fill: var(--gc-accent, ${scene.accent}); }
.gc-chron-bar.gc-state-done { fill: var(--gc-quiet, ${scene.quiet}); opacity: .8; }
.gc-chron-bar.gc-state-active { fill: var(--gc-accent, ${scene.accent}); }
.gc-chron-bar.gc-state-crit { fill: var(--gc-alt, ${scene.alt}); }
.gc-chron-label { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.titleFont};
  font-weight: ${scene.type.nameWeight}; font-size: ${scene.type.name}px; }
/* A label sitting on its own bar has to read against the bar, not the ground —
   ink rather than the ground colour (DESIGN 5.5's gate only ever measures a
   label against the stage it sits on, so a label coloured to match the ground
   reads as invisible to it even where the bar makes it perfectly legible; ink
   is the same choice already made for a title on a filled panel tile, 4.2). */
.gc-chron-label.gc-on-bar { fill: var(--gc-ink, ${scene.ink}); }
.gc-chron-label.gc-before { text-anchor: end; }

.gc-chron-dot { fill: var(--gc-path, ${scene.path}); }
/* The one dot that travels the axis, leaving a .gc-chron-dot behind at each
   period it passes. Hidden at rest — DESIGN 5.4's motion, never a decoration
   left sitting at the animation's starting point. */
.gc-chron-lead { fill: var(--gc-accent, ${scene.accent}); opacity: 0; offset-rotate: 0deg; }
.gc-chron-line { fill: none; stroke: var(--gc-path, ${scene.path});
  stroke-width: ${scene.edgeStroke}px; stroke-linejoin: round; stroke-linecap: round; }
.gc-chron-period { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.titleFont};
  font-weight: ${scene.type.nameWeight}; font-size: ${scene.type.name}px; text-anchor: middle; }
.gc-chron-people { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.rowFont};
  font-size: ${scene.type.caption}px; text-anchor: middle; }
.gc-chron-card { fill: var(--gc-surface, ${scene.surface}); }
.gc-chron-event { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.rowFont};
  font-size: ${scene.type.caption}px; text-anchor: middle; opacity: .88; }
`;
}
