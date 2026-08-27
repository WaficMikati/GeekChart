import { parseWith, splitLabel } from './graph.ts';
import { resolveMeasurer, type Measurer } from './layout.ts';
import { Track } from './motion.ts';
import { tipPath } from './tips.ts';
import type { EdgeTip } from './graph.ts';
import { fitCanvas, frameTransform, type Scene } from './scene.ts';
import type { Point } from './geometry.ts';
import { GRID } from './tokens.ts';

/**
 * Sequence diagrams.
 *
 * The only drawn type that does not go through ELK, because a sequence diagram
 * is not a graph that needs placing — it is a timetable. Participants own fixed
 * columns and every event has a known row, so the layout is arithmetic. Handing
 * it to a layered graph engine would invent freedom the notation does not have.
 *
 * The motion is different too, and deliberately so. A flowchart builds by
 * structure and then walks its spine; a conversation has to replay in the order
 * it happened, which is the only reading of it that means anything.
 */

/** Mermaid's `LINETYPE`, confirmed against the parser rather than assumed. */
const LINE = {
  SOLID: 0,
  DOTTED: 1,
  NOTE: 2,
  SOLID_CROSS: 3,
  DOTTED_CROSS: 4,
  SOLID_OPEN: 5,
  DOTTED_OPEN: 6,
  LOOP_START: 10,
  LOOP_END: 11,
  ALT_START: 12,
  ALT_ELSE: 13,
  ALT_END: 14,
  OPT_START: 15,
  OPT_END: 16,
  ACTIVE_START: 17,
  ACTIVE_END: 18,
  PAR_START: 19,
  PAR_AND: 20,
  PAR_END: 21,
  RECT_START: 22,
  RECT_END: 23,
  SOLID_POINT: 24,
  DOTTED_POINT: 25,
  CRITICAL_START: 27,
  CRITICAL_OPTION: 28,
  CRITICAL_END: 29,
  BREAK_START: 30,
  BREAK_END: 31,
} as const;

/** Mermaid's `PLACEMENT` for notes. */
const PLACE = { LEFT: 0, RIGHT: 1, OVER: 2 } as const;

/** Which frames open a block, and what to call it when the author did not. */
const OPENS: Record<number, string> = {
  [LINE.LOOP_START]: 'loop',
  [LINE.ALT_START]: 'alt',
  [LINE.OPT_START]: 'opt',
  [LINE.PAR_START]: 'par',
  [LINE.CRITICAL_START]: 'critical',
  [LINE.BREAK_START]: 'break',
  [LINE.RECT_START]: '',
};
const CLOSES = new Set<number>([
  LINE.LOOP_END,
  LINE.ALT_END,
  LINE.OPT_END,
  LINE.PAR_END,
  LINE.CRITICAL_END,
  LINE.BREAK_END,
  LINE.RECT_END,
]);
const DIVIDES: Record<number, string> = {
  [LINE.ALT_ELSE]: 'else',
  [LINE.PAR_AND]: 'and',
  [LINE.CRITICAL_OPTION]: 'option',
};

const DOTTED = new Set<number>([
  LINE.DOTTED,
  LINE.DOTTED_CROSS,
  LINE.DOTTED_OPEN,
  LINE.DOTTED_POINT,
]);

function tipFor(type: number): EdgeTip {
  if (type === LINE.SOLID_CROSS || type === LINE.DOTTED_CROSS) return 'cross';
  if (type === LINE.SOLID_POINT || type === LINE.DOTTED_POINT) return 'open';
  // `->` and `-->` are lines without a head; mermaid draws no marker at all.
  if (type === LINE.SOLID_OPEN || type === LINE.DOTTED_OPEN) return 'none';
  return 'arrow';
}

interface RawMessage {
  id?: string;
  from?: string;
  to?: string;
  message?: string;
  type: number;
  placement?: number;
  activate?: boolean;
}

interface Participant {
  key: string;
  title: string;
  caption?: string;
  /** Centre of the lane. */
  x: number;
  width: number;
  height: number;
  actor: boolean;
}

/** One drawn event, in the order it happens. Motion replays this list. */
interface Beat {
  id: string;
  /** Everything the beat draws, already positioned. */
  markup: string;
  /**
   * The stretch the line covers, so it can be wiped on in the direction it
   * travels.
   *
   * A message is revealed by a moving clip rather than by the dash-offset trick
   * the flowchart outlines use, because a dotted reply needs `stroke-dasharray`
   * for its dots and an element only has one of those — setting it to draw the
   * line on silently turned every dotted message solid.
   */
  span?: { axis: 'x' | 'y'; from: number; to: number };
}

const SVGNS = 'http://www.w3.org/2000/svg';
const esc = (t: string) =>
  t.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const round = (n: number) => Number(n.toFixed(2));
const at = (p: Point) => `${round(p.x)},${round(p.y)}`;

/**
 * Wrap a message label to at most two lines. A wide lane chart (5+ actors,
 * DESIGN 1.1's hugging width) would otherwise size its lanes to whatever
 * one-line message happens to be longest, dragging the whole canvas past
 * 1000 and shrinking type back down through `fitCanvas`'s last-resort scale.
 * Breaking only at spaces keeps a word intact; a single token past the hard
 * limit is truncated with an ellipsis rather than left to size the lane.
 */
// Measured against this file's actor-box floor (160, DESIGN 2.2) and the mono
// label font (~8.3 raw units/char), an unwrapped line has to give up its
// width well before 22-26 characters or one line — wrapped multi-word or a
// single unsplittable token — reopens the exact shrink this wrap exists to
// prevent: at 5 lanes, boxW + 46 alone already claims 206 of the ~210 a lane
// can spend and still leave the canvas at 1000-or-under, unscaled.
const WRAP_TARGET_CHARS = 18;
const WRAP_TOKEN_MAX = 18;
const WRAP_MAX_LINES = 2;
// A browser's <text> bounding box for an 11-unit label runs taller than the
// glyphs themselves (ascent+descent, ~1.4x the font size) — 14 put the two
// lines' boxes 1+ unit into each other, failing DESIGN 6.5's "plates never
// overlap". 16 clears it with margin.
const LABEL_LINE_STEP = 16;
function wrapMessageLabel(
  text: string,
  target = WRAP_TARGET_CHARS,
  tokenMax = Math.min(target, WRAP_TOKEN_MAX),
): string[] {
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > tokenMax ? `${w.slice(0, tokenMax - 1)}…` : w));
  const lines: string[] = [];
  let current = '';
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    const next = current ? `${current} ${word}` : word;
    if (next.length <= target || !current) {
      current = next;
      i++;
    } else {
      lines.push(current);
      current = '';
      if (lines.length === WRAP_MAX_LINES) break;
    }
  }
  if (current) lines.push(current);
  // Whatever didn't fit in two lines is dropped, not spilled into a third —
  // mark the loss on the line that absorbed the cut rather than pretend
  // nothing was lost.
  if (i < words.length && lines.length === WRAP_MAX_LINES) {
    const last = lines[WRAP_MAX_LINES - 1]!.replace(/…$/, '');
    lines[WRAP_MAX_LINES - 1] = `${last}…`;
  }
  return lines;
}

export interface SequenceDrawing {
  svg: string;
  width: number;
  height: number;
  participants: string[];
  /** Display names, for the accessible description. */
  labels: string[];
  beats: string[];
  messages: number;
}

export interface SequenceResult {
  drawing: SequenceDrawing;
  css: string;
  cycle: number;
}

export async function drawSequence(
  source: string,
  scene: Scene,
  measureWith?: string | Measurer,
): Promise<SequenceResult> {
  const db = await parseWith(source);
  if (typeof db.getActorKeys !== 'function') {
    throw new Error('This is not a sequence diagram.');
  }
  const keys = (db.getActorKeys!() as string[]) ?? [];
  const messages = ((db.getMessages?.() as RawMessage[]) ?? []).filter(Boolean);
  if (keys.length === 0) throw new Error('Nothing to draw — the diagram has no participants.');

  const measurer = resolveMeasurer(measureWith);
  const textWidth = (t: string, font: string, size: number, tracking?: string) =>
    measurer.measure(t, font, size, tracking);

  // --- columns ------------------------------------------------------------
  // A participant's description may carry a caption on a second line (`as
  // Name<br/>role`), the same syntax splitLabel already reads for every other
  // node — an actor head is the same object as a node elsewhere. DESIGN 3.2.
  const labels = new Map<string, { title: string; caption?: string; actor: boolean }>();
  for (const key of keys) {
    const record = (db.getActor?.(key) ?? {}) as { description?: string; type?: string };
    const { title, caption } = splitLabel(String(record.description ?? key));
    labels.set(key, { title, caption, actor: String(record.type ?? 'participant') === 'actor' });
  }
  // Chart-wide, not per-actor: one row of actors is one box height, the same
  // reasoning layout.ts uses for ordinary nodes (DESIGN 2.3 forbids mixing
  // 56s and 48s in a row).
  const twoTier = keys.some((k) => Boolean(labels.get(k)!.caption));

  const grid8 = (v: number) => Math.ceil(v / GRID) * GRID;
  // Five or more lifelines cannot share 904 units at 160 wide; DESIGN 2.2's
  // 120×48 compact box exists for exactly this, with a tighter label wrap.
  const compact = keys.length > 4;
  const wrapTarget = compact ? 16 : WRAP_TARGET_CHARS;
  const boxW = grid8(
    Math.max(
      compact ? 120 : scene.laneWidth,
      ...keys.map((k) => {
        const l = labels.get(k)!;
        const title = textWidth(l.title, scene.titleFont, scene.type.name);
        const caption = l.caption
          ? textWidth(l.caption, scene.captionFont, scene.type.caption, scene.captionTracking)
          : 0;
        return Math.max(title, caption) + scene.padX * 2;
      }),
    ),
  );
  // 160×56 two-tier when any actor carries a caption, 160×48 when none does —
  // never a name centred in the taller box. DESIGN 3.2.
  const boxH = twoTier ? 56 : 48;

  // A lane has to hold the widest thing that crosses it, or every label overlaps
  // the column beside it. Measuring is the only way to know.
  // Lane width is driven by the widest *wrapped* line, not the raw message —
  // wrapping happens before lane sizing, or a lane sized for the whole
  // message would fit the wrap that was never drawn.
  const widestMessage = messages.reduce((most, m) => {
    if (m.type === LINE.NOTE || !m.message) return most;
    const lineWidth = wrapMessageLabel(m.message, wrapTarget).reduce(
      (w, line) =>
        Math.max(
          w,
          textWidth(line, scene.edgeLabelFont, scene.type.label, scene.type.labelTracking),
        ),
      0,
    );
    return Math.max(most, lineWidth);
  }, 0);
  // Columns divide *most* of the canvas between them, not the whole of it —
  // filling all 904 content units for as few as two lifelines is the "too
  // much space between elements" a short exchange doesn't need. DESIGN 1.2's
  // floor is 35% coverage, not 100%; leaving a quarter of the fill on the
  // table still clears that with room to spare and reads tighter for it.
  const pad = scene.canvas.margin;
  // Lanes are sized by content — the widest message between two lifelines —
  // not by the canvas: the canvas hugs the result (DESIGN 1.1).
  const lane = grid8(Math.max(boxW + 46, widestMessage + 56, scene.laneWidth));
  const participants: Participant[] = keys.map((key, i) => ({
    key,
    title: labels.get(key)!.title,
    caption: labels.get(key)!.caption,
    actor: labels.get(key)!.actor,
    x: pad + boxW / 2 + i * lane,
    width: boxW,
    height: boxH,
  }));
  const column = new Map(participants.map((p) => [p.key, p]));
  const xOf = (key: string | undefined) => column.get(String(key))?.x ?? pad + boxW / 2;

  // Known from the columns alone, so it can be used while laying out rows —
  // notes, self-messages and frames all need to know where the canvas edge
  // is to avoid running past it.
  const width = pad * 2 + boxW + (participants.length - 1) * lane;
  // What the drawing actually reaches, tracked as markup is produced. Starts
  // at the lifelines' own span; frames, notes and plates widen it as they're
  // drawn, so `fitCanvas` gets the real extent instead of an assumed content
  // box that a frame's tab or a left-placed note can run past (DESIGN 7.5).
  let extMinX = pad;
  let extMaxX = width - pad;

  // --- rows ---------------------------------------------------------------
  const top = pad + boxH;
  let cursor = top + 38;

  interface OpenFrame {
    kind: string;
    label: string;
    top: number;
    dividers: { y: number; label: string }[];
  }
  const stack: OpenFrame[] = [];
  const frames: (OpenFrame & { bottom: number })[] = [];
  interface OpenBar {
    key: string;
    top: number;
  }
  const bars: OpenBar[] = [];
  const activations: { key: string; top: number; bottom: number; depth: number }[] = [];
  const beats: Beat[] = [];

  const headLength = scene.edgeStroke * scene.arrowLength;
  const headWidth = scene.edgeStroke * scene.arrowWidth;
  const tipLen = scene.edgeStroke * scene.tipLength;

  /** How far the activation bars push a line out from the lifeline. */
  const barHalf = 5;

  /**
   * Where a message's label goes, given the segment it belongs to.
   *
   * The midpoint is the obvious answer and is wrong whenever a message passes
   * over a third participant: the label lands on that column's lifeline and its
   * activation bar, and a word with a bar through it is a word you have to guess
   * at. Sliding along the message keeps the label unambiguously attached to it
   * — moving it sideways would not — so the search walks out from the middle and
   * takes the first position clear of every column. DESIGN 6.5.
   */
  const labelX = (x1: number, x2: number, w: number): number => {
    const mid = (x1 + x2) / 2;
    const lo = Math.min(x1, x2) + w / 2;
    const hi = Math.max(x1, x2) - w / 2;
    if (hi <= lo) return mid;
    const clear = (cx: number) =>
      participants.every((p) => Math.abs(p.x - cx) > w / 2 + barHalf + 6);
    if (clear(mid)) return mid;
    const step = Math.max(4, (hi - lo) / 24);
    for (let d = step; d <= (hi - lo) / 2 + step; d += step) {
      for (const cx of [mid - d, mid + d]) {
        if (cx >= lo && cx <= hi && clear(cx)) return cx;
      }
    }
    return mid;
  };
  const depthAt = (key: string) => bars.filter((b) => b.key === key).length;

  for (const [index, message] of messages.entries()) {
    const type = message.type;

    if (type in OPENS) {
      stack.push({
        kind: OPENS[type]!,
        label: String(message.message ?? ''),
        top: cursor - 16,
        dividers: [],
      });
      cursor += 34;
      continue;
    }
    if (CLOSES.has(type)) {
      const frame = stack.pop();
      if (frame) frames.push({ ...frame, bottom: cursor + 6 });
      cursor += 22;
      continue;
    }
    if (type in DIVIDES) {
      const frame = stack[stack.length - 1];
      if (frame) frame.dividers.push({ y: cursor - 12, label: String(message.message ?? '') });
      cursor += 30;
      continue;
    }
    if (type === LINE.ACTIVE_START) {
      bars.push({ key: String(message.from), top: cursor - 14 });
      continue;
    }
    if (type === LINE.ACTIVE_END) {
      const i = [...bars].reverse().findIndex((b) => b.key === String(message.from));
      if (i >= 0) {
        const real = bars.length - 1 - i;
        const bar = bars.splice(real, 1)[0]!;
        activations.push({ key: bar.key, top: bar.top, bottom: cursor - 14, depth: 0 });
      }
      continue;
    }

    if (type === LINE.NOTE) {
      const text = String(message.message ?? '');
      const w = textWidth(text, scene.rowFont, scene.type.caption) + scene.padX * 2;
      const h = scene.type.caption * 3.2;
      const from = xOf(message.from);
      const to = xOf(message.to);
      let x = from - w / 2;
      if (message.placement === PLACE.LEFT) x = from - boxW / 2 - w - 14;
      else if (message.placement === PLACE.RIGHT) x = from + boxW / 2 + 14;
      else if (message.placement === PLACE.OVER) {
        const mid = (from + to) / 2;
        const span = Math.max(w, Math.abs(to - from) + boxW * 0.6);
        x = mid - span / 2;
        extMinX = Math.min(extMinX, x);
        extMaxX = Math.max(extMaxX, x + span);
        beats.push({
          id: `beat-${index}`,
          markup:
            `<g class="gc-note" data-id="beat-${index}">` +
            `<rect class="gc-note-box" x="${round(x)}" y="${round(cursor - h / 2)}" width="${round(span)}" height="${round(h)}" rx="4"/>` +
            `<text class="gc-note-text" x="${round(mid)}" y="${round(cursor + scene.type.caption * 0.36)}">${esc(text)}</text>` +
            `</g>`,
        });
        cursor += h + 22;
        continue;
      }
      // A left/right note hangs off the box, past the lifelines' own span —
      // fold it into the measured extent (DESIGN 7.5).
      extMinX = Math.min(extMinX, x);
      extMaxX = Math.max(extMaxX, x + w);
      beats.push({
        id: `beat-${index}`,
        markup:
          `<g class="gc-note" data-id="beat-${index}">` +
          `<rect class="gc-note-box" x="${round(x)}" y="${round(cursor - h / 2)}" width="${round(w)}" height="${round(h)}" rx="4"/>` +
          `<text class="gc-note-text" x="${round(x + w / 2)}" y="${round(cursor + scene.type.caption * 0.36)}">${esc(text)}</text>` +
          `</g>`,
      });
      cursor += h + 22;
      continue;
    }

    // --- an ordinary message ---------------------------------------------
    const fromKey = String(message.from);
    const toKey = String(message.to);
    const text = String(message.message ?? '');
    const dotted = DOTTED.has(type);
    const tip = tipFor(type);
    const stroke = dotted ? ' gc-stroke-dotted' : '';
    const id = `beat-${index}`;

    if (fromKey === toKey) {
      // A message to oneself: a lobe off the right of the lifeline, since there
      // is no second column to travel to.
      const x = xOf(fromKey) + barHalf * (depthAt(fromKey) + 1);
      const drop = 30;
      const reach = 52;
      const d =
        `M${at({ x, y: cursor })} C${at({ x: x + reach, y: cursor })} ` +
        `${at({ x: x + reach, y: cursor + drop })} ${at({ x: x + 2, y: cursor + drop })}`;
      const marks = tipPath(
        { x: x + 2, y: cursor + drop },
        { x: -1, y: 0 },
        tip,
        tip === 'arrow' ? headLength : tipLen,
        tip === 'arrow' ? headWidth : tipLen * 0.85,
      );
      // Left-anchored beside the lobe rather than centred, so the plate has to
      // match that anchor: its left edge sits 6 short of the text, DESIGN 6.5.
      const tx = x + reach + 14;
      const ty = cursor + drop / 2;
      const lines = wrapMessageLabel(text, wrapTarget);
      const lineW = lines.reduce(
        (w, line) =>
          Math.max(
            w,
            textWidth(line, scene.edgeLabelFont, scene.type.label, scene.type.labelTracking),
          ),
        0,
      );
      const plateW = text ? lineW + 12 : 0;
      const wrapped = lines.length > 1;
      const plateH = wrapped ? scene.type.label * 2 + LABEL_LINE_STEP : scene.type.label * 2;
      const labelMarkup = lines
        .map((line, li) => {
          const ly = ty + scene.type.label * 0.36 + (li - (lines.length - 1) / 2) * LABEL_LINE_STEP;
          return `<text class="gc-msg-label gc-msg-self" data-id="${id}" x="${round(tx)}" y="${round(ly)}">${esc(line)}</text>`;
        })
        .join('');
      // A self-message's plate hangs off to the right of its lifeline — the
      // widest, most easily clipped shape a chart draws (DESIGN 7.5).
      extMaxX = Math.max(extMaxX, text ? tx - 6 + plateW : x + reach);
      beats.push({
        id,
        span: { axis: 'y', from: cursor, to: cursor + drop },
        markup:
          `<path class="gc-msg${stroke}" data-id="${id}" d="${d}"/>` +
          // DESIGN 8.5: the plate sits below the arrowhead in stacking order —
          // drawn before it, never after.
          (text
            ? `<rect class="gc-plate" data-id="${id}" x="${round(tx - 6)}" y="${round(ty - plateH / 2)}" ` +
              `width="${round(plateW)}" height="${round(plateH)}" rx="3"/>`
            : '') +
          (marks.fill ? `<path class="gc-arrow" data-id="${id}" d="${marks.fill}"/>` : '') +
          (marks.line
            ? `<path class="gc-arrow gc-tip-line" data-id="${id}" d="${marks.line}"/>`
            : '') +
          labelMarkup,
      });
      cursor += drop + 44 + (wrapped ? LABEL_LINE_STEP : 0);
      continue;
    }

    const dir = xOf(toKey) > xOf(fromKey) ? 1 : -1;
    const x1 = xOf(fromKey) + dir * barHalf * depthAt(fromKey);
    const x2 = xOf(toKey) - dir * (barHalf * depthAt(toKey) + 2);
    const d = `M${at({ x: x1, y: cursor })} L${at({ x: x2, y: cursor })}`;
    const marks = tipPath(
      { x: x2, y: cursor },
      { x: dir, y: 0 },
      tip,
      tip === 'arrow' ? headLength : tipLen,
      tip === 'arrow' ? headWidth : tipLen * 0.85,
    );
    const lines = wrapMessageLabel(text);
    const lineW = lines.reduce(
      (w, line) =>
        Math.max(
          w,
          textWidth(line, scene.edgeLabelFont, scene.type.label, scene.type.labelTracking),
        ),
      0,
    );
    // DESIGN 6.5: the label sits on a knockout plate centred on the segment's
    // midpoint — `labelX` already keeps that midpoint clear of every column.
    const lx = labelX(x1, x2, lineW);
    const plateW = text ? lineW + 12 : 0;
    const wrapped = lines.length > 1;
    const plateH = wrapped ? scene.type.label * 2 + LABEL_LINE_STEP : scene.type.label * 2;
    const labelMarkup = lines
      .map((line, li) => {
        const ly =
          cursor + scene.type.label * 0.36 + (li - (lines.length - 1) / 2) * LABEL_LINE_STEP;
        return `<text class="gc-msg-label" data-id="${id}" x="${round(lx)}" y="${round(ly)}">${esc(line)}</text>`;
      })
      .join('');
    // A plate normally stays inside the lane it was sized for, but track it
    // anyway — the columns nearest the edge are where a rounding slip would
    // clip (DESIGN 7.5).
    if (text) {
      extMinX = Math.min(extMinX, lx - plateW / 2);
      extMaxX = Math.max(extMaxX, lx + plateW / 2);
    }
    beats.push({
      id,
      span: { axis: 'x', from: x1, to: x2 },
      markup:
        `<path class="gc-msg${stroke}" data-id="${id}" d="${d}"/>` +
        // DESIGN 8.5: the plate sits below the arrowhead in stacking order —
        // drawn before it, never after, so a head is never covered.
        (text
          ? `<rect class="gc-plate" data-id="${id}" x="${round(lx - plateW / 2)}" y="${round(cursor - plateH / 2)}" ` +
            `width="${round(plateW)}" height="${round(plateH)}" rx="3"/>`
          : '') +
        (marks.fill ? `<path class="gc-arrow" data-id="${id}" d="${marks.fill}"/>` : '') +
        (marks.line
          ? `<path class="gc-arrow gc-tip-line" data-id="${id}" d="${marks.line}"/>`
          : '') +
        labelMarkup,
    });
    cursor += scene.laneStep - 12 + (wrapped ? LABEL_LINE_STEP : 0);
  }

  measurer.done();

  // Anything still open when the source ends still has to be drawn.
  const bottom = cursor + 16;
  for (const frame of stack) frames.push({ ...frame, bottom });
  for (const bar of bars) activations.push({ key: bar.key, top: bar.top, bottom, depth: 0 });

  // A frame box (and its kind/tab) always runs 12 past the lifelines' own
  // span on both sides — see `x`/`w` below — so its overhang has to be folded
  // into the measured extent whenever a chart has at least one alt/loop/opt.
  if (frames.length > 0) {
    extMinX = Math.min(extMinX, pad - 12);
    extMaxX = Math.max(extMaxX, width - pad + 12);
  }

  // --- assemble -----------------------------------------------------------
  const height = bottom + pad;

  const frameMarkup = frames
    .map((frame, i) => {
      const x = pad - 12;
      const w = width - (pad - 12) * 2;
      const tabW = Math.max(46, frame.kind.length * 9 + 20);
      const title = frame.label ? `${frame.kind} ${frame.label}`.trim() : frame.kind;
      return (
        `<g class="gc-frame" data-id="frame-${i}">` +
        `<rect class="gc-frame-box" x="${round(x)}" y="${round(frame.top)}" ` +
        `width="${round(w)}" height="${round(frame.bottom - frame.top)}" rx="4"/>` +
        (frame.kind
          ? `<path class="gc-frame-tab" d="M${round(x)},${round(frame.top)} h${round(tabW)} ` +
            `l10,16 v6 h${round(-tabW - 10)} Z"/>` +
            `<text class="gc-frame-kind" x="${round(x + 9)}" y="${round(frame.top + 15)}">${esc(frame.kind)}</text>`
          : '') +
        (title && frame.label
          ? `<text class="gc-frame-label" x="${round(x + tabW + 22)}" y="${round(frame.top + 15)}">${esc(frame.label)}</text>`
          : '') +
        frame.dividers
          .map(
            (divider) =>
              `<path class="gc-frame-split" d="M${round(x)},${round(divider.y)} h${round(w)}"/>` +
              `<text class="gc-frame-label" x="${round(x + 12)}" y="${round(divider.y + 17)}">${esc(divider.label)}</text>`,
          )
          .join('') +
        `</g>`
      );
    })
    .join('');

  const lifelines = participants
    .map(
      (p) =>
        `<path class="gc-lifeline" data-id="${esc(p.key)}" d="M${round(p.x)},${round(top)} V${round(bottom)}"/>`,
    )
    .join('');

  const heads = participants
    .map((p) => {
      // Baselines set by cap height, not the em box, exactly as draw.ts's
      // centredLabel does for every other node: name at cy-4, caption at
      // cy+12 in the 56-high box; name at cy+4 in the 48-high box. DESIGN 10.2/10.3.
      const cy = pad + p.height / 2;
      const nameY = p.caption ? cy - 4 : cy + 4;
      return (
        `<g class="gc-actor" data-id="${esc(p.key)}">` +
        `<rect class="gc-actor-box" x="${round(p.x - p.width / 2)}" y="${round(pad)}" ` +
        `width="${round(p.width)}" height="${round(p.height)}" rx="${scene.radius}"/>` +
        `<text class="gc-actor-name" x="${round(p.x)}" y="${round(nameY)}">${esc(p.title)}</text>` +
        (p.caption
          ? `<text class="gc-caption" x="${round(p.x)}" y="${round(cy + 12)}">${esc(p.caption)}</text>`
          : '') +
        `</g>`
      );
    })
    .join('');

  const barsMarkup = activations
    .map(
      (a, i) =>
        `<rect class="gc-active" data-id="active-${i}" x="${round(xOf(a.key) - barHalf)}" ` +
        `y="${round(a.top)}" width="${round(barHalf * 2)}" height="${round(Math.max(12, a.bottom - a.top))}" rx="2"/>`,
    )
    .join('');

  // The drawing already carries its own margins; hand fitCanvas the extent
  // actually measured (DESIGN 7.5) rather than the nominal content box —
  // a frame, a left/right note or a self-message plate can run past it.
  const frame = fitCanvas(
    // Padded on every side: fitCanvas expects the 48 margins to be included.
    { x: extMinX - pad, y: 0, width: extMaxX - extMinX + pad * 2, height },
    scene.canvas,
  );
  const svg =
    `<svg class="gc-chart" viewBox="0 0 ${frame.width} ${frame.height}" ` +
    `width="${frame.width}" height="${frame.height}" role="img" xmlns="${SVGNS}">` +
    `<g class="gc-frame" transform="${frameTransform(frame)}">` +
    // Activation bars sit below the arrowheads: a head is never covered.
    // DESIGN 8.5.
    frameMarkup +
    lifelines +
    barsMarkup +
    heads +
    beats.map((b) => b.markup).join('') +
    `</g></svg>`;

  const timeline = animateSequence(participants, frames.length, activations.length, beats, scene, {
    view: { width: frame.width, height: frame.height },
    offset: { x: frame.dx, y: frame.dy },
    top,
    bottom,
  });

  return {
    drawing: {
      svg,
      width,
      height,
      participants: participants.map((p) => p.key),
      labels: participants.map((p) => p.title),
      beats: beats.map((b) => b.id),
      messages: beats.filter((b) => b.span).length,
    },
    css: timeline.css,
    cycle: timeline.cycle,
  };
}

/**
 * Replay the conversation in order.
 *
 * Unlike a flowchart, there is no spine to walk afterwards: the order *is* the
 * content. Participants arrive, their lifelines drop, and then each beat lands
 * on its own turn — which is also why this cannot reuse the flowchart timeline,
 * where every edge starts as soon as the box it leaves exists.
 */
function animateSequence(
  participants: Participant[],
  frames: number,
  activeBars: number,
  beats: Beat[],
  scene: Scene,
  frame: {
    view: { width: number; height: number };
    offset: { x: number; y: number };
    top: number;
    bottom: number;
  },
): { css: string; cycle: number } {
  // Insets are given in user units against the viewport, not as percentages of
  // the element. A straight line's bounding box is zero in one dimension, so a
  // percentage inset against it collapses to nothing and the line never appears.
  //
  // `view` is the viewBox `fitCanvas` settled on, not the drawing's content
  // box. An `inset(...) view-box` is anchored at the *element's* own origin and
  // sized from the viewBox, so the ancestor `frameTransform` translate stays
  // out of the arithmetic but the viewBox's grid-snapped size does not: measure
  // against the content box and the difference between the two is left showing
  // at rest, which breaks DESIGN 10.4.
  const wipe = (axis: 'x' | 'y', at: number): string => {
    const { width, height } = frame.view;
    return axis === 'x'
      ? `inset(0 ${round(width - at)}px 0 0) view-box`
      : `inset(0 0 ${round(height - at)}px 0) view-box`;
  };
  const wipeBack = (at: number): string => `inset(0 0 0 ${round(at)}px) view-box`;
  const m = scene.motion;
  const lead = 0.25;
  const tracks = new Map<string, Track>();
  const track = (selector: string): Track => {
    const found = tracks.get(selector);
    if (found) return found;
    const made = new Track();
    tracks.set(selector, made);
    return made;
  };

  const headEnd = lead + (participants.length - 1) * m.lag * 0.5 + m.build;
  const lineEnd = headEnd + m.build * 0.9;
  // Beats run faster than a flowchart's build: a conversation with a dozen turns
  // would otherwise outlast anyone's patience with the loop.
  const step = m.lag * 0.86;
  const beatAt = beats.map((_, i) => lineEnd + 0.25 + i * step);
  const last = beatAt.length ? beatAt[beatAt.length - 1]! + m.build : lineEnd;
  const cycle = last + m.hold;

  participants.forEach((p, i) => {
    const start = lead + i * m.lag * 0.5;
    const box = track(`.gc-actor[data-id="${p.key}"]`);
    box.at(0, { opacity: '0', transform: 'translateY(-10px)' });
    box.at(start, { opacity: '0', transform: 'translateY(-10px)' });
    box.at(start + m.build, { opacity: '1', transform: 'translateY(0)' });
    box.at(cycle, { opacity: '1', transform: 'translateY(0)' });

    // The lifeline is revealed rather than stroked on: it is dashed, and a dash
    // pattern cannot coexist with the dash-offset trick the outlines use.
    const line = track(`.gc-lifeline[data-id="${p.key}"]`);
    // Closed 2 units above the line's start: the round cap would otherwise show
    // as a dot at frame zero (measured, DESIGN 10.4).
    line.at(0, { 'clip-path': wipe('y', frame.top - 2) });
    line.at(headEnd, { 'clip-path': wipe('y', frame.top - 2) });
    line.at(lineEnd, { 'clip-path': wipe('y', frame.bottom) });
    line.at(cycle, { 'clip-path': wipe('y', frame.bottom) });
  });

  for (let i = 0; i < frames; i++) {
    const frame = track(`.gc-frame[data-id="frame-${i}"]`);
    frame.at(0, { opacity: '0' });
    frame.at(lineEnd, { opacity: '0' });
    frame.at(lineEnd + m.build, { opacity: '1' });
    frame.at(cycle, { opacity: '1' });
  }

  for (let i = 0; i < activeBars; i++) {
    const bar = track(`.gc-active[data-id="active-${i}"]`);
    bar.at(0, { opacity: '0' });
    bar.at(lineEnd, { opacity: '0' });
    bar.at(lineEnd + m.build, { opacity: '1' });
    bar.at(cycle, { opacity: '1' });
  }

  beats.forEach((beat, i) => {
    const start = beatAt[i]!;
    if (beat.span) {
      const { axis, from, to } = beat.span;
      // A message travelling right to left is wiped on from its own right edge,
      // so the line always grows away from the participant that sent it.
      const backwards = axis === 'x' && to < from;
      // A round cap overhangs the line's own endpoint by half a stroke, so both
      // ends of the wipe are moved past it: closed, or the half-disc sits there
      // for the whole delay (DESIGN 10.4); open, or the finished line loses the
      // cap it is drawn with.
      const cap = scene.edgeStroke / 2;
      // The closed clip gets 2 units of slack beyond the cap: the frame's sub-unit
      // translate otherwise leaves a sliver of the self-message lobe at frame zero.
      const shut = backwards ? wipeBack(from + cap + 2) : wipe(axis, from - cap - 2);
      const open = backwards ? wipeBack(to - cap) : wipe(axis, to + cap);
      const line = track(`.gc-msg[data-id="${beat.id}"]`);
      line.at(0, { 'clip-path': shut });
      line.at(start, { 'clip-path': shut });
      line.at(start + m.build * 0.7, { 'clip-path': open });
      line.at(cycle, { 'clip-path': open });

      const tip = track(`.gc-arrow[data-id="${beat.id}"]`);
      tip.at(0, { opacity: '0' });
      tip.at(start + m.build * 0.6, { opacity: '0' });
      tip.at(start + m.build * 0.8, { opacity: '1' });
      tip.at(cycle, { opacity: '1' });

      const plate = track(`.gc-plate[data-id="${beat.id}"]`);
      plate.at(0, { opacity: '0' });
      plate.at(start + m.build * 0.3, { opacity: '0' });
      plate.at(start + m.build * 0.9, { opacity: '1' });
      plate.at(cycle, { opacity: '1' });

      const label = track(`.gc-msg-label[data-id="${beat.id}"]`);
      label.at(0, { opacity: '0' });
      label.at(start + m.build * 0.3, { opacity: '0' });
      label.at(start + m.build * 0.9, { opacity: '1' });
      label.at(cycle, { opacity: '1' });
    } else {
      const note = track(`.gc-note[data-id="${beat.id}"]`);
      note.at(0, { opacity: '0' });
      note.at(start, { opacity: '0' });
      note.at(start + m.build * 0.8, { opacity: '1' });
      note.at(cycle, { opacity: '1' });
    }
  });

  const rules: string[] = [];
  const frameCss: string[] = [];
  let index = 0;
  for (const [selector, value] of tracks) {
    if (value.empty) continue;
    const name = `gc-s${index++}`;
    rules.push(`${selector}{animation:${name} ${cycle.toFixed(2)}s ${m.ease} infinite}`);
    frameCss.push(`@keyframes ${name}{${value.frames(cycle)}}`);
  }

  const css = `
@media (prefers-reduced-motion: no-preference) {
.gc-actor { transform-box: fill-box; transform-origin: center; }
${rules.join('\n')}
${frameCss.join('\n')}
}
`;
  return { css, cycle };
}

/** The sequence-specific half of the stylesheet. */
export function sequenceCss(scene: Scene): string {
  return `
.gc-actor-box { fill: var(--gc-hue, var(--gc-path, ${scene.path})); fill-opacity: .1;
  stroke: var(--gc-path, ${scene.path}); stroke-width: ${scene.nodeStroke}px; }
.gc-actor-name { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.titleFont};
  font-weight: ${scene.type.nameWeight}; font-size: ${scene.type.name}px; text-anchor: middle; }

/* The lifeline is scaffolding, not content: it has to be visible enough to
   follow a column down and quiet enough never to compete with a message.
   DESIGN 6.6/table: 0.8 hairline, dashed, 50% opacity. */
.gc-lifeline { fill: none; stroke: var(--gc-quiet, ${scene.quiet}); stroke-width: ${scene.dividerStroke}px;
  stroke-dasharray: 3 7; opacity: .5; }
.gc-active { fill: var(--gc-path, ${scene.path}); fill-opacity: .28; stroke: var(--gc-path, ${scene.path});
  stroke-width: 1px; }

.gc-msg { fill: none; stroke: var(--gc-edge, ${scene.edge}); stroke-width: ${scene.edgeStroke}px;
  stroke-linecap: round; }
/* DESIGN 6.6: a return/async message is dashed 5 4, not the fine 1.5 6 dotted
   the shared rule gives a flowchart's "channel" edge — this overrides it by
   specificity (two classes beat one) rather than editing the shared rule,
   which flowcharts still want at 1.5 6. Arrowheads reuse the shared
   gc-arrow / gc-tip-line classes so a head reads the same everywhere. */
.gc-msg.gc-stroke-dotted { stroke-dasharray: 5 4; }
.gc-msg-label { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.edgeLabelFont};
  font-size: ${scene.type.label}px; letter-spacing: ${scene.type.labelTracking};
  text-anchor: middle; text-transform: uppercase; opacity: .9; }
/* A self-message's label sits beside its lobe rather than over it, so it anchors
   from the left. The attribute alone cannot say this: a stylesheet rule beats a
   presentation attribute, so the middle anchor above would win. */
.gc-msg-self { text-anchor: start; }

/* A block frame is an annotation on the conversation, so it sits behind
   everything and stays in the neutral ink. */
.gc-frame-box { fill: none; stroke: var(--gc-quiet, ${scene.quiet}); stroke-width: ${scene.clusterStroke}px; opacity: .45; }
.gc-frame-tab { fill: var(--gc-quiet, ${scene.quiet}); opacity: .18; }
.gc-frame-split { fill: none; stroke: var(--gc-quiet, ${scene.quiet}); stroke-width: ${scene.dividerStroke}px;
  stroke-dasharray: 4 5; opacity: .45; }
.gc-frame-kind { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.rowFont};
  font-size: ${scene.type.label}px; letter-spacing: ${scene.type.labelTracking};
  text-transform: uppercase; opacity: .8; }
.gc-frame-label { fill: var(--gc-quiet, ${scene.quiet}); font-family: ${scene.rowFont};
  font-size: ${scene.type.label}px; letter-spacing: ${scene.type.labelTracking}; }

/* One depth cue, an outline — no fill — the same treatment as a frame box.
   DESIGN 4.2: a note is an annotation, not a coloured tile. */
.gc-note-box { fill: none; stroke: var(--gc-quiet, ${scene.quiet}); stroke-width: ${scene.clusterStroke}px; opacity: .45; }
.gc-note-text { fill: var(--gc-ink, ${scene.ink}); font-family: ${scene.rowFont};
  font-size: ${scene.type.caption}px; text-anchor: middle; }
`;
}
