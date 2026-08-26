import { parseWith } from './graph.ts';
import { makeMeasurer } from './layout.ts';
import { Track } from './motion.ts';
import { fitCanvas, frameTransform, type Scene } from './scene.ts';

/**
 * Quadrant, radar and xy — the diagrams that are actually charts.
 *
 * These four gallery patterns (quadrant, radar, bar, line) differ from every
 * other type here: their marks encode *quantities*, so they answer to charting
 * rules rather than diagram ones. A categorical colour set assigned in fixed
 * order, a legend whenever there are two or more series, recessive grid and
 * axes, and marks that stay thin.
 *
 * They share the chrome — title, plot frame, legend, motion — and differ only in
 * how a series is drawn, which is why they are one module.
 */

export type PlotKind = 'quadrant' | 'radar' | 'xy';

interface Point {
  x: number;
  y: number;
  label?: string;
}

interface Series {
  label: string;
  type: 'bar' | 'line' | 'points';
  points: Point[];
}

export interface Plot {
  kind: PlotKind;
  title?: string;
  series: Series[];
  /** xy: the band categories and axis titles. */
  categories?: string[];
  xTitle?: string;
  yTitle?: string;
  yMin?: number;
  yMax?: number;
  /** radar: one label per spoke, and the scale. */
  axes?: string[];
  max?: number;
  ticks?: number;
  /** quadrant: the four corner names and the four axis ends. */
  quadrants?: string[];
  axisEnds?: { xLeft: string; xRight: string; yBottom: string; yTop: string };
}

const clean = (t: unknown) => String(t ?? '').trim();

interface RawAxis {
  label?: string;
  name?: string;
}
interface RawCurve {
  label?: string;
  name?: string;
  entries?: number[];
}
interface RawXY {
  title?: string;
  xAxis?: { categories?: string[]; title?: string };
  yAxis?: { title?: string; min?: number; max?: number };
  plots?: { type?: string; data?: [string, number][] }[];
}

/**
 * Read a quadrant chart from its source rather than from its database.
 *
 * `getQuadrantData()` hands back pixel coordinates on mermaid's own 500×500
 * canvas — it ignores `setWidth`, so there is no reliable scale to divide by —
 * and it reorders the points. The source states the positions directly as
 * fractions, which is both exact and what the author actually wrote. Mermaid is
 * still asked to parse first, so a syntax error is reported the usual way.
 */
function readQuadrant(source: string): Plot {
  const line = (re: RegExp) => re.exec(source)?.slice(1).map(clean);
  const axis = line(/^[ \t]*x-axis[ \t]+(.+?)(?:[ \t]*-->[ \t]*(.+))?$/m) ?? [];
  const yAxis = line(/^[ \t]*y-axis[ \t]+(.+?)(?:[ \t]*-->[ \t]*(.+))?$/m) ?? [];
  const quadrants = [1, 2, 3, 4].map(
    (n) => line(new RegExp(`^[ \\t]*quadrant-${n}[ \\t]+(.+)$`, 'm'))?.[0] ?? '',
  );
  const points: Point[] = [];
  for (const [, label, x, y] of source.matchAll(
    /^[ \t]*([^:\n]+?)[ \t]*:[ \t]*\[[ \t]*([\d.]+)[ \t]*,[ \t]*([\d.]+)[ \t]*\]/gm,
  )) {
    points.push({ label: clean(label), x: Number(x), y: Number(y) });
  }
  return {
    kind: 'quadrant',
    ...(clean(line(/^[ \t]*title[ \t]+(.+)$/m)?.[0])
      ? { title: clean(line(/^[ \t]*title[ \t]+(.+)$/m)![0]) }
      : {}),
    series: [{ label: '', type: 'points', points }],
    quadrants,
    axisEnds: {
      xLeft: axis[0] ?? '',
      xRight: axis[1] ?? '',
      yBottom: yAxis[0] ?? '',
      yTop: yAxis[1] ?? '',
    },
  };
}

export async function toPlot(source: string, kind: PlotKind): Promise<Plot> {
  const db = await parseWith(source);
  const title = clean(db.getDiagramTitle?.());

  if (kind === 'quadrant') {
    const plot = readQuadrant(source);
    if (!plot.series[0]!.points.length) throw new Error('Nothing to plot — no points were given.');
    return title ? { ...plot, title } : plot;
  }

  if (kind === 'radar') {
    const axes = ((db.getAxes?.() as RawAxis[]) ?? []).map((a) => clean(a.label || a.name));
    const curves = ((db.getCurves?.() as RawCurve[]) ?? []).map((c) => ({
      label: clean(c.label || c.name),
      type: 'line' as const,
      points: (c.entries ?? []).map((v, i) => ({ x: i, y: v })),
    }));
    if (!axes.length || !curves.length)
      throw new Error('Nothing to plot — this radar has no axes or curves.');
    const options = (db.getOptions?.() ?? {}) as { max?: number; ticks?: number };
    return {
      kind,
      ...(title ? { title } : {}),
      axes,
      series: curves,
      max: options.max ?? Math.max(...curves.flatMap((c) => c.points.map((p) => p.y)), 1),
      ticks: options.ticks ?? 4,
    };
  }

  const data = (db.getXYChartData?.() ?? {}) as RawXY;
  const categories = (data.xAxis?.categories ?? []).map(clean);
  // `bar "Placed" [...]` parses, and then the name is dropped: the plot objects
  // carry only a type and the numbers. Reading the names from the source is the
  // difference between a legend that says "Placed" and one that says "Series 2".
  const names = [...source.matchAll(/^[ \t]*(?:bar|line)[ \t]+"([^"]*)"/gm)].map((m) =>
    clean(m[1]),
  );
  const series: Series[] = (data.plots ?? []).map((p, i) => ({
    label: names[i] || clean(data.yAxis?.title) || `Series ${i + 1}`,
    type: p.type === 'bar' ? 'bar' : 'line',
    points: (p.data ?? []).map(([cat, value], n) => ({
      x: categories.indexOf(clean(cat)) >= 0 ? categories.indexOf(clean(cat)) : n,
      y: Number(value),
    })),
  }));
  if (!series.length) throw new Error('Nothing to plot — this chart has no series.');
  const values = series.flatMap((s) => s.points.map((p) => p.y));
  return {
    kind,
    ...(title || data.title ? { title: title || clean(data.title) } : {}),
    categories,
    series,
    ...(clean(data.xAxis?.title) ? { xTitle: clean(data.xAxis?.title) } : {}),
    ...(clean(data.yAxis?.title) ? { yTitle: clean(data.yAxis?.title) } : {}),
    yMin: data.yAxis?.min ?? Math.min(0, ...values),
    yMax: data.yAxis?.max ?? Math.max(...values, 1),
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

export interface PlotDrawing {
  svg: string;
  css: string;
  cycle: number;
  summary: string;
  series: number;
  points: number;
}

type Measure = (t: string, font: string, size: number, tracking?: string) => number;

/**
 * One drawn thing, plus how many dots ride along its line.
 *
 * The count is needed because each dot lands as the line sweeps past it, so the
 * timeline has to know how many there are before it can space them.
 */
interface Mark {
  id: string;
  markup: string;
  dots?: number;
  /** Quadrant only: the offset from the plot's centre to this point; the dot flies
   *  in from the centre along it (DESIGN 5.4) with a soft trail behind. */
  fly?: { dx: number; dy: number };
}

/**
 * A bar with a rounded top and a square foot.
 *
 * Rounding every corner detaches the bar from the baseline it is measured
 * against, and a bar's whole job is that its foot sits on zero. Only the end
 * carrying the data gets the radius.
 */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  const base = y + h;
  return (
    `M${round(x)},${round(base)} V${round(y + r)} ` +
    `A${r},${r} 0 0 1 ${round(x + r)},${round(y)} ` +
    `H${round(x + w - r)} A${r},${r} 0 0 1 ${round(x + w)},${round(y + r)} ` +
    `V${round(base)} Z`
  );
}

/** Nice round tick values covering a range, without a scale library. */
function niceTicks(min: number, max: number, count = 5): number[] {
  const span = Math.max(max - min, 1e-9);
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 0.001; v += step) {
    out.push(Number(v.toFixed(6)));
  }
  return out;
}

export function drawPlot(plot: Plot, scene: Scene, measureWith?: string): PlotDrawing {
  const measurer = makeMeasurer(measureWith);
  const width: Measure = (t, font, size, tracking) => measurer.measure(t, font, size, tracking);

  // The canvas owns the margin. DESIGN 1.3.
  const pad = scene.canvas.margin;
  const titleH = plot.title ? scene.type.title * 1.9 : 0;
  // A legend is not optional above one series: colour alone must never be the
  // only thing telling two series apart.
  const legendH = plot.series.length > 1 ? scene.type.label * 3 : 0;

  const parts: string[] = [];
  const marks: Mark[] = [];

  const built =
    plot.kind === 'xy'
      ? xy(plot, scene, width, pad, titleH, legendH, parts, marks)
      : plot.kind === 'radar'
        ? radar(plot, scene, width, pad, titleH, legendH, parts, marks)
        : quadrant(plot, scene, width, pad, titleH, parts, marks);

  const legend = legendH ? legendRow(plot, scene, width, built.left, built.height - pad - 4) : '';
  measurer.done();

  const title = plot.title
    ? `<text class="gc-plot-title" x="${round(built.width / 2)}" y="${round(pad + scene.type.title)}">${esc(plot.title)}</text>`
    : '';

  const frame = fitCanvas({ x: 0, y: 0, width: built.width, height: built.height }, scene.canvas);
  const svg =
    `<svg class="gc-chart" viewBox="0 0 ${frame.width} ${frame.height}" ` +
    `width="${frame.width}" height="${frame.height}" role="img" xmlns="${SVGNS}">` +
    `<g class="gc-frame" transform="${frameTransform(frame)}">` +
    parts.join('') +
    marks.map((m) => m.markup).join('') +
    legend +
    title +
    `</g></svg>`;

  const motion = animate(marks, plot, Boolean(plot.title), Boolean(legendH), scene);
  const points = plot.series.reduce((n, s) => n + s.points.length, 0);
  const noun = { quadrant: 'Quadrant chart', radar: 'Radar chart', xy: 'Chart' }[plot.kind];

  return {
    svg,
    css: motion.css,
    cycle: motion.cycle,
    summary:
      `${noun}${plot.title ? `: ${plot.title}` : ''}. ` +
      `${plot.series.length} series, ${points} point${points === 1 ? '' : 's'}.`,
    series: plot.series.length,
    points,
  };
}

/** Swatch plus name, one row, left-aligned at the plot's own x. DESIGN 7.2. */
function legendRow(plot: Plot, scene: Scene, width: Measure, x0: number, y: number): string {
  const gap = 22;
  const items = plot.series.map((s, i) => ({
    label: s.label,
    w: width(s.label, scene.rowFont, scene.type.label, scene.type.labelTracking) + 20,
    i,
  }));
  let x = x0;
  return (
    `<g class="gc-plot-legend">` +
    items
      .map((it) => {
        const at = x;
        x += it.w + gap;
        return (
          `<rect class="gc-swatch gc-series-${it.i}" x="${round(at)}" y="${round(y - scene.type.label * 0.9)}" width="8" height="8" rx="2"/>` +
          `<text class="gc-plot-legend-label" x="${round(at + 14)}" y="${round(y)}">${esc(it.label)}</text>`
        );
      })
      .join('') +
    `</g>`
  );
}

/** Bars and lines on a band x-axis. */
function xy(
  plot: Plot,
  scene: Scene,
  width: Measure,
  pad: number,
  titleH: number,
  legendH: number,
  parts: string[],
  marks: Mark[],
): { width: number; height: number; left: number } {
  const cats = plot.categories ?? [];
  const ticks = niceTicks(plot.yMin ?? 0, plot.yMax ?? 1);
  // 10 is the same clearance the tick label sits back from the grid (`left -
  // 10` below), so with a genuinely right-anchored tick (DESIGN 7.3's
  // gc-anchor-end) its own left edge lands flush on `pad`, matching the plot's
  // flush right edge instead of leaving a one-sided gap fitCanvas can't see.
  const gutter =
    Math.max(...ticks.map((t) => width(String(t), scene.rowFont, scene.type.label))) + 10;
  const left = pad + gutter;
  // The plot takes exactly what the canvas has left, never more: a floor here
  // could push the drawing past canvas.width, which would force fitCanvas to
  // shrink the whole frame — including the 22px title — to fit. DESIGN 3.
  const plotW = scene.canvas.width - left - pad;
  const top = pad + titleH + 10 + (plot.yTitle ? scene.type.label + 12 : 0);
  const plotH = 340;
  const bottom = top + plotH;
  const height =
    bottom + scene.type.label * 3 + (plot.xTitle ? scene.type.label + 12 : 0) + legendH + pad;
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const y = (v: number) => bottom - ((v - lo) / Math.max(hi - lo, 1e-9)) * plotH;
  const band = plotW / Math.max(cats.length, 1);
  const cx = (i: number) => left + band * (i + 0.5);

  for (const t of ticks) {
    parts.push(
      `<path class="gc-plot-grid" d="M${round(left)},${round(y(t))} H${round(left + plotW)}"/>` +
        `<text class="gc-plot-tick gc-anchor-end" x="${round(left - 10)}" y="${round(y(t) + scene.type.label * 0.36)}" text-anchor="end">${esc(String(t))}</text>`,
    );
  }
  cats.forEach((c, i) => {
    parts.push(
      `<text class="gc-plot-tick" x="${round(cx(i))}" y="${round(bottom + scene.type.label + 12)}">${esc(c)}</text>`,
    );
  });
  if (plot.yTitle) {
    // Horizontal, not rotated: DESIGN 3.4 permits one vertical axis label, but
    // a title that sits above its axis needs no rotation at all — one fewer
    // rotated run than the rule allows.
    parts.push(
      `<text class="gc-plot-axis-title gc-anchor-start" x="${round(left)}" y="${round(top - 14)}" text-anchor="start">${esc(plot.yTitle)}</text>`,
    );
  }
  if (plot.xTitle) {
    parts.push(
      `<text class="gc-plot-axis-title" x="${round(left + plotW / 2)}" y="${round(bottom + scene.type.label * 4)}">${esc(plot.xTitle)}</text>`,
    );
  }

  const bars = plot.series.filter((s) => s.type === 'bar');
  plot.series.forEach((s, si) => {
    if (s.type === 'bar') {
      const slot = bars.indexOf(s);
      // A 2px gap between neighbouring fills, so two bars never fuse into one.
      const bw = Math.max(4, (band * 0.52) / bars.length - 2);
      s.points.forEach((p, pi) => {
        const bx = cx(p.x) - (bars.length * (bw + 2) - 2) / 2 + slot * (bw + 2);
        marks.push({
          id: `s${si}-${pi}`,
          markup:
            `<path class="gc-plot-bar gc-series-${si}" data-id="s${si}-${pi}" ` +
            `d="${barPath(bx, y(p.y), bw, Math.max(1, y(lo) - y(p.y)))}"/>`,
        });
      });
    } else {
      const d = s.points
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${round(cx(p.x))},${round(y(p.y))}`)
        .join(' ');
      marks.push({
        id: `s${si}`,
        dots: s.points.length,
        markup:
          `<path class="gc-plot-line gc-series-${si}" data-id="s${si}" pathLength="1" d="${d}"/>` +
          s.points
            .map(
              (p, pi) =>
                `<circle class="gc-plot-dot gc-series-${si}" data-id="s${si}-d${pi}" ` +
                `cx="${round(cx(p.x))}" cy="${round(y(p.y))}" r="4.5"/>`,
            )
            .join(''),
      });
    }
  });

  return { width: left + plotW + pad, height, left };
}

/** A radar: one spoke per axis, one closed path per curve. */
function radar(
  plot: Plot,
  scene: Scene,
  width: Measure,
  pad: number,
  titleH: number,
  legendH: number,
  parts: string[],
  marks: Mark[],
): { width: number; height: number; left: number } {
  const axes = plot.axes ?? [];
  const spokeAngle = (i: number) => (i / axes.length) * Math.PI * 2 - Math.PI / 2;
  // .gc-plot-tick renders in caps (DESIGN); measuring the label as typed
  // under-sizes it, since capitals run wider than the mixed-case source.
  const labelWidths = axes.map((a) =>
    width(a.toUpperCase(), scene.rowFont, scene.type.label, scene.type.labelTracking),
  );
  // A spoke label sits out at 1.13x the radius (`out` below), so what a side
  // needs past the circle is that overshoot plus the label's own width, not
  // just the widest label's width — the widest label can easily be the one
  // closest to vertical, whose spoke barely reaches past the circle at all.
  // This depends on the radius, which depends on this, so it settles over a
  // few passes rather than in one (DESIGN 7.3).
  const reach = (rad: number): { left: number; right: number } => {
    let left = 0;
    let right = 0;
    axes.forEach((_, i) => {
      const c = Math.cos(spokeAngle(i));
      // Distance from the circle's own rim (`rad`) to where this label sits
      // (`rad*1.13`) and ends (+ its own width, in the direction it's
      // anchored away from centre).
      const over = Math.abs(c) * rad * 1.13 - rad;
      const w = labelWidths[i]!;
      if (c > 0.05) right = Math.max(right, over + w);
      else if (c < -0.05) left = Math.max(left, over + w);
      else {
        left = Math.max(left, over + w / 2);
        right = Math.max(right, over + w / 2);
      }
    });
    return { left, right };
  };
  let leftLabelW = 40;
  let rightLabelW = 40;
  let radius = 230;
  for (let pass = 0; pass < 3; pass++) {
    // As big as the canvas allows, capped so a radar does not become a circle
    // the full height of a 1.4 stage. DESIGN 1.1 and 1.4.
    radius = Math.min(230, (scene.canvas.width - pad * 2 - leftLabelW - rightLabelW - 32) / 2);
    const r = reach(radius);
    leftLabelW = Math.max(40, r.left);
    rightLabelW = Math.max(40, r.right);
  }
  const cxp = pad + leftLabelW + radius + 16;
  const cyp = pad + titleH + radius + 22;
  const height = cyp + radius + scene.type.label * 2 + legendH + pad;
  const max = plot.max ?? 100;
  const rings = plot.ticks ?? 4;
  // Start at twelve o'clock and go clockwise, which is how these are read.
  const angle = spokeAngle;
  const at = (i: number, v: number) => ({
    x: cxp + Math.cos(angle(i)) * radius * (v / max),
    y: cyp + Math.sin(angle(i)) * radius * (v / max),
  });

  for (let r = 1; r <= rings; r++) {
    const ring = axes.map((_, i) => at(i, (max * r) / rings));
    parts.push(
      `<path class="gc-plot-grid" d="${ring.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)},${round(p.y)}`).join(' ')} Z"/>`,
    );
  }
  axes.forEach((label, i) => {
    const tip = at(i, max);
    const out = at(i, max * 1.13);
    const anchor = out.x > cxp + 4 ? 'start' : out.x < cxp - 4 ? 'end' : 'middle';
    parts.push(
      `<path class="gc-plot-spoke" d="M${round(cxp)},${round(cyp)} L${round(tip.x)},${round(tip.y)}"/>` +
        `<text class="gc-plot-tick gc-plot-spoke-label gc-anchor-${anchor}" x="${round(out.x)}" y="${round(out.y + scene.type.label * 0.36)}" ` +
        `text-anchor="${anchor}">${esc(label)}</text>`,
    );
  });

  plot.series.forEach((s, si) => {
    const ring = s.points.map((p, i) => at(i, p.y));
    const d =
      ring.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)},${round(p.y)}`).join(' ') + ' Z';
    marks.push({
      id: `s${si}`,
      dots: ring.length,
      markup:
        `<path class="gc-plot-area gc-series-${si}" data-id="s${si}" d="${d}"/>` +
        `<path class="gc-plot-line gc-series-${si}" data-id="s${si}" pathLength="1" d="${d}"/>` +
        ring
          .map(
            (p, pi) =>
              `<circle class="gc-plot-dot gc-series-${si}" data-id="s${si}-d${pi}" ` +
              `cx="${round(p.x)}" cy="${round(p.y)}" r="4"/>`,
          )
          .join(''),
    });
  });

  // The legend (drawn from `left`) has to start where the circle's own left
  // edge actually settles — `pad + 16`, the same clearance reserved on the
  // right in `width` above — not flush against `pad` itself, or it becomes
  // the block's real left edge and throws off the centring the gutters above
  // were sized for.
  return { width: cxp + radius + rightLabelW + 16 + pad, height, left: pad + 16 };
}

/** Four named regions and a scatter of labelled points. */
function quadrant(
  plot: Plot,
  scene: Scene,
  width: Measure,
  pad: number,
  titleH: number,
  parts: string[],
  marks: Mark[],
): { width: number; height: number; left: number } {
  const ends = plot.axisEnds ?? { xLeft: '', xRight: '', yBottom: '', yTop: '' };
  // Every label along the panel — xLeft/xRight, the corner names — sits flush
  // on the panel's own edge (anchored so it grows inward, DESIGN 7.3's
  // gc-anchor-start/-end), so nothing needs headroom outside the panel on
  // either side. A left-only gutter here reserved room none of them used and
  // left the panel — and everything centred on it — sitting off to the right.
  const left = pad;
  // A square plot as wide as the canvas allows, the same margin on both sides.
  const side = Math.min(560, scene.canvas.width - left - pad);
  // yTop, if set, is a horizontal line above the panel rather than a second
  // rotated run beside it -- DESIGN 3.4 allows one vertical axis label per
  // chart, and this chart spends none of it.
  const topGap = ends.yTop ? scene.type.label + 12 : 0;
  const top = pad + titleH + 8 + topGap;
  // Two rows below the panel: the x-axis ends, then yBottom, centred under them.
  const row1 = top + side + scene.type.label + 14;
  const row2 = ends.yBottom ? row1 + scene.type.label + 10 : row1;
  const height = row2 + scene.type.label + pad;
  const at = (x: number, y: number) => ({ x: left + x * side, y: top + (1 - y) * side });

  // One panel and a hairline cross, not four tinted quarters. DESIGN 10.5:
  // removing the tints loses nothing -- the axes already say where each region
  // is -- and it stops every point label that crosses a midline from reading as
  // text sitting on the edge of a box.
  const half = side / 2;
  parts.push(
    `<rect class="gc-plot-quad" x="${round(left)}" y="${round(top)}" ` +
      `width="${round(side)}" height="${round(side)}" rx="${scene.panelRadius}"/>`,
  );
  // Region names go in each quadrant's *outer* corner rather than its centre,
  // 8 in from the border on both axes (baselines set by cap height, DESIGN
  // 10.3). The centre is where the axes cross and where labelled points
  // cluster, and a region name sitting under a point label makes both
  // unreadable -- which is exactly what happened to "Drop" and "Job boards".
  // `capTop` pushes the top pair's baseline down by a cap height so the glyph
  // itself, not the baseline, sits 8 in from the top border; `capBottom` does
  // the same from the bottom border, pulling the baseline up by a descender's
  // worth so a 'p' or 'y' doesn't reach past the 8-unit margin either. Without
  // it the bottom pair sat on `half - 8` -- the axis crossing, not the corner
  // -- which is the centre this comment says to avoid.
  const capTop = 8 + scene.type.name * 0.72;
  const capBottom = side - 8 - scene.type.name * 0.24;
  const corners: {
    dx: number;
    dy: number;
    label: string;
    ax: number;
    ay: number;
    anchor: string;
  }[] = [
    { dx: half, dy: 0, label: plot.quadrants?.[0] ?? '', ax: side - 8, ay: capTop, anchor: 'end' },
    { dx: 0, dy: 0, label: plot.quadrants?.[1] ?? '', ax: 8, ay: capTop, anchor: 'start' },
    { dx: 0, dy: half, label: plot.quadrants?.[2] ?? '', ax: 8, ay: capBottom, anchor: 'start' },
    {
      dx: half,
      dy: half,
      label: plot.quadrants?.[3] ?? '',
      ax: side - 8,
      ay: capBottom,
      anchor: 'end',
    },
  ];
  for (const q of corners) {
    if (!q.label) continue;
    parts.push(
      `<text class="gc-plot-quad-label" x="${round(left + q.ax)}" y="${round(top + q.ay)}" text-anchor="${q.anchor}">${esc(q.label)}</text>`,
    );
  }

  parts.push(
    `<path class="gc-plot-axis" d="M${round(left + half)},${round(top)} V${round(top + side)} ` +
      `M${round(left)},${round(top + half)} H${round(left + side)}"/>`,
  );
  if (ends.yTop) {
    parts.push(
      `<text class="gc-plot-tick" x="${round(left + half)}" y="${round(top - topGap + scene.type.label)}" ` +
        `text-anchor="middle">${esc(ends.yTop)}</text>`,
    );
  }
  parts.push(
    `<text class="gc-plot-tick gc-anchor-start" x="${round(left)}" y="${round(row1)}" text-anchor="start">${esc(ends.xLeft)}</text>` +
      `<text class="gc-plot-tick gc-anchor-end" x="${round(left + side)}" y="${round(row1)}" text-anchor="end">${esc(ends.xRight)}</text>` +
      (ends.yBottom
        ? `<text class="gc-plot-tick" x="${round(left + half)}" y="${round(row2)}" text-anchor="middle">${esc(ends.yBottom)}</text>`
        : ''),
  );

  // One series, so every point is direct-labelled and no legend is needed.
  plot.series[0]!.points.forEach((p, i) => {
    const at_ = at(p.x, p.y);
    const label = p.label ?? '';
    let labelMarkup = '';
    if (label) {
      // The label turns inward, so a point near the right edge is labelled to
      // its left. Nothing then reaches past the panel, which is DESIGN 7.5.
      const right = p.x < 0.5;
      const tw = width(label, scene.rowFont, scene.type.caption);
      // Knockout plate: a rect the ground colour behind the label, 6 padding
      // either side (the same padding an edge-label plate uses, DESIGN 6.5),
      // clamped so it never crosses into the border.
      const boxW = tw + 12;
      const boxH = scene.type.caption * 2;
      let boxX = right ? at_.x + 6 : at_.x - 12 - tw - 6;
      let boxY = at_.y - boxH / 2;
      boxX = Math.min(Math.max(boxX, left + 4), left + side - boxW - 4);
      boxY = Math.min(Math.max(boxY, top + 4), top + side - boxH - 4);
      const tx = right ? boxX + 6 : boxX + boxW - 6;
      const ty = boxY + boxH / 2 + scene.type.caption * 0.36;
      labelMarkup =
        `<rect class="gc-plate" x="${round(boxX)}" y="${round(boxY)}" width="${round(boxW)}" height="${round(boxH)}" rx="3"/>` +
        `<text class="gc-plot-point-label" x="${round(tx)}" y="${round(ty)}" ` +
        `text-anchor="${right ? 'start' : 'end'}">${esc(label)}</text>`;
    }
    const centre = { x: left + side / 2, y: top + side / 2 };
    marks.push({
      id: `p${i}`,
      fly: { dx: centre.x - at_.x, dy: centre.y - at_.y },
      markup:
        `<g class="gc-plot-point" data-id="p${i}">` +
        `<circle class="gc-plot-trail gc-series-0" data-id="p${i}-t2" cx="${round(at_.x)}" cy="${round(at_.y)}" r="4"/>` +
        `<circle class="gc-plot-trail gc-series-0" data-id="p${i}-t1" cx="${round(at_.x)}" cy="${round(at_.y)}" r="4"/>` +
        `<circle class="gc-plot-dot gc-series-0" data-id="p${i}" cx="${round(at_.x)}" cy="${round(at_.y)}" r="4"/>` +
        `<circle class="gc-plot-ripple gc-series-0" data-id="p${i}-r" cx="${round(at_.x)}" cy="${round(at_.y)}" r="4"/>` +
        (labelMarkup ? `<g class="gc-plot-point-tag" data-id="p${i}">${labelMarkup}</g>` : '') +
        `</g>`,
    });
  });

  return { width: left + side + pad, height, left };
}

/** Chrome first, then the marks in order. */
function animate(
  marks: Mark[],
  plot: Plot,
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
  const step = Math.min(0.16, 2.4 / Math.max(marks.length, 1));
  const last = scaffold + 0.15 + Math.max(marks.length - 1, 0) * step + m.build;
  const cycle = last + m.hold;

  const fade = (selector: string, from: number, over = m.build * 0.8) => {
    const t = track(selector);
    t.at(0, { opacity: '0' });
    t.at(from, { opacity: '0' });
    t.at(from + over, { opacity: '1' });
    t.at(cycle, { opacity: '1' });
  };

  if (hasTitle) fade('.gc-plot-title', lead);
  if (hasLegend) fade('.gc-plot-legend', scaffold);
  fade('.gc-plot-grid', lead + 0.1);
  fade('.gc-plot-spoke, .gc-plot-axis, .gc-plot-tick, .gc-plot-axis-title', lead + 0.16);
  if (plot.kind === 'quadrant') fade('.gc-plot-quad, .gc-plot-quad-label', lead + 0.2);

  marks.forEach((mark, i) => {
    const start = scaffold + 0.15 + i * step;
    // A bar grows from its baseline; anything else arrives in place. A bar that
    // faded in would say nothing about magnitude, which is the only thing a bar
    // is for.
    const bar = track(`.gc-plot-bar[data-id="${mark.id}"]`);
    bar.at(0, { transform: 'scaleY(0)', opacity: '0' });
    bar.at(start, { transform: 'scaleY(0)', opacity: '0' });
    bar.at(start + 0.02, { opacity: '1' });
    bar.at(start + m.build, { transform: 'scaleY(1)' });
    bar.at(cycle, { transform: 'scaleY(1)', opacity: '1' });

    const line = track(`.gc-plot-line[data-id="${mark.id}"]`);
    line.at(0, { 'stroke-dashoffset': '1', opacity: '0' });
    line.at(start, { 'stroke-dashoffset': '1', opacity: '0' });
    line.at(start + 0.02, { opacity: '1' });
    line.at(start + m.build * 2, { 'stroke-dashoffset': '0' });
    line.at(cycle, { 'stroke-dashoffset': '0', opacity: '1' });

    fade(`.gc-plot-area[data-id="${mark.id}"]`, start + m.build);

    // A quadrant/scatter point gets plotted, not faded: the dot pops to size
    // first (DESIGN 5.4 — motion is what colour is for), then its label reads
    // in a beat later, once the point that names it has actually landed.
    const dot = track(`.gc-plot-dot[data-id="${mark.id}"]`);
    if (mark.fly) {
      // The point flies out from the plot's centre to where it belongs, with two
      // ghosts lagging behind it as a soft trail that dissolves on arrival.
      const from = `translate(${round(mark.fly.dx)}px, ${round(mark.fly.dy)}px) scale(0.6)`;
      const flight = m.build * 0.9;
      dot.at(0, { transform: from, opacity: '0' });
      dot.at(start, { transform: from, opacity: '0' });
      dot.at(start + 0.03, { opacity: '1' });
      dot.at(start + flight, {
        transform: 'translate(0, 0) scale(1.15)',
        'animation-timing-function': 'cubic-bezier(.22,1.2,.36,1)',
      });
      dot.at(start + flight + 0.12, { transform: 'translate(0, 0) scale(1)' });
      dot.at(cycle, { transform: 'translate(0, 0) scale(1)', opacity: '1' });
      // A soft, quick ripple where the point lands: a hairline ring swelling
      // from the dot (r 4→14) and fading over 0.4s, starting as it stops.
      const ripple = track(`.gc-plot-ripple[data-id="${mark.id}-r"]`);
      ripple.at(0, { transform: 'scale(1)', opacity: '0' });
      ripple.at(start + flight - 0.02, { transform: 'scale(1)', opacity: '0' });
      ripple.at(start + flight, { opacity: '0.6' });
      ripple.at(start + flight + 0.4, { transform: 'scale(3.5)', opacity: '0' });
      ripple.at(cycle, { transform: 'scale(3.5)', opacity: '0' });
      [
        ['t1', 0.06, 0.35],
        ['t2', 0.12, 0.18],
      ].forEach(([suffix, lag, peak]) => {
        const ghost = track(`.gc-plot-trail[data-id="${mark.id}-${suffix}"]`);
        ghost.at(0, { transform: from, opacity: '0' });
        ghost.at(start + (lag as number), { transform: from, opacity: '0' });
        ghost.at(start + (lag as number) + 0.03, { opacity: String(peak) });
        ghost.at(start + flight * 0.8 + (lag as number), { opacity: String(peak) });
        ghost.at(start + flight + (lag as number), {
          transform: 'translate(0, 0) scale(0.8)',
          opacity: '0',
        });
        ghost.at(cycle, { transform: 'translate(0, 0) scale(0.8)', opacity: '0' });
      });
    } else {
      dot.at(0, { transform: 'scale(0)', opacity: '0' });
      dot.at(start, { transform: 'scale(0)', opacity: '0' });
      dot.at(start + 0.02, { opacity: '1' });
      dot.at(start + m.build * 0.6, {
        transform: 'scale(1.25)',
        'animation-timing-function': 'cubic-bezier(.22,1.2,.36,1)',
      });
      dot.at(start + m.build * 0.85, { transform: 'scale(1)' });
      dot.at(cycle, { transform: 'scale(1)', opacity: '1' });
    }

    fade(`.gc-plot-point-tag[data-id="${mark.id}"]`, start + m.build * 0.7);

    // Each dot lands as the line sweeps past it. They had no `data-id` at all,
    // so the selector aiming at them matched nothing and they sat at full
    // opacity from the first frame — visible before the chart they belong to.
    const draw = m.build * 2;
    for (let dot = 0; dot < (mark.dots ?? 0); dot++) {
      const along = mark.dots! > 1 ? dot / (mark.dots! - 1) : 0;
      fade(`.gc-plot-dot[data-id="${mark.id}-d${dot}"]`, start + along * draw, m.build * 0.35);
    }
  });

  const rules: string[] = [];
  const frames: string[] = [];
  let index = 0;
  for (const [selector, value] of tracks) {
    if (value.empty) continue;
    const name = `gc-p${index++}`;
    rules.push(`${selector}{animation:${name} ${cycle.toFixed(2)}s ${m.ease} infinite}`);
    frames.push(`@keyframes ${name}{${value.frames(cycle)}}`);
  }

  return {
    cycle,
    css: `
@media (prefers-reduced-motion: no-preference) {
/* A bar grows from the baseline it is measured against, not from its middle. */
.gc-plot-bar { transform-box: fill-box; transform-origin: bottom; }
.gc-plot-line { stroke-dasharray: 1; }
/* A quadrant/scatter point pops into place rather than fading in already at
   its full size — DESIGN 5.4: motion is what colour is for. */
.gc-plot-dot { transform-box: fill-box; transform-origin: center; }
${rules.join('\n')}
${frames.join('\n')}
}
`,
  };
}

/** The stylesheet for all three. */
export function plotCss(scene: Scene): string {
  const series = scene.series
    .map((colour, i) => `.gc-series-${i} { --gc-mark: var(--gc-series-${i + 1}, ${colour}); }`)
    .join('\n');
  return `
.gc-plot-title { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.titleFont};
  font-weight: ${scene.type.titleWeight}; font-size: ${scene.type.title}px;
  letter-spacing: ${scene.type.titleTracking}; text-anchor: middle; }
${series}
/* Every mark reads its colour from one custom property, so a host can restyle a
   whole series by setting --gc-series-N without knowing which marks exist. */
.gc-plot-bar, .gc-plot-dot, .gc-swatch { fill: var(--gc-mark); }
.gc-plot-line { fill: none; stroke: var(--gc-mark); stroke-width: ${scene.edgeStroke}px;
  stroke-linejoin: round; stroke-linecap: round; }
.gc-plot-area { fill: var(--gc-mark); fill-opacity: .14; stroke: none; }
/* A 2px ring in the surface colour keeps overlapping marks legible. */
.gc-plot-dot { stroke: var(--gc-bg, ${scene.bg}); stroke-width: 2px; }

.gc-plot-grid { fill: none; stroke: var(--gc-edge, ${scene.edge}); stroke-width: .8px; opacity: .26; }
.gc-plot-spoke { fill: none; stroke: var(--gc-edge, ${scene.edge}); stroke-width: .8px; opacity: .3; }
.gc-plot-axis { fill: none; stroke: var(--gc-edge, ${scene.edge}); stroke-width: 1.2px; opacity: .55; }
.gc-plot-tick { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.rowFont};
  font-size: ${scene.type.label}px; letter-spacing: ${scene.type.labelTracking};
  text-anchor: middle; text-transform: uppercase; }
.gc-plot-spoke-label { fill: var(--gc-ink, ${scene.ink}); }
.gc-plot-axis-title { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.rowFont};
  font-size: ${scene.type.label}px; letter-spacing: ${scene.type.labelTracking};
  text-anchor: middle; text-transform: uppercase; }
/* A class beats a presentation attribute in the cascade regardless of
   specificity, so a label that needs to hang off one side of its x rather than
   straddle it (a y-axis value, an axis title flush to the plot) has to say so
   in a class, not the text-anchor attribute alone (DESIGN 7.3). */
.gc-anchor-start { text-anchor: start; }
.gc-anchor-end { text-anchor: end; }
.gc-anchor-middle { text-anchor: middle; }

.gc-plot-quad { fill: var(--gc-surface, ${scene.surface}); }
.gc-plate { fill: var(--gc-bg, ${scene.bg}); }
.gc-plot-quad-label { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.titleFont};
  font-weight: ${scene.type.nameWeight}; font-size: ${scene.type.name}px;
  letter-spacing: .04em; }
.gc-plot-trail { opacity: 0; transform-box: fill-box; transform-origin: center; }
.gc-plot-ripple { opacity: 0; fill: none; stroke: var(--gc-accent, ${scene.accent}); stroke-width: 1px; transform-box: fill-box; transform-origin: center; }
.gc-plot-point-label { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.rowFont};
  font-size: ${scene.type.caption}px; }
.gc-plot-legend-label { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.rowFont};
  font-size: ${scene.type.label}px; letter-spacing: ${scene.type.labelTracking};
  text-transform: uppercase; }
`;
}
