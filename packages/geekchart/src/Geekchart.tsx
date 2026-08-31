'use client';

import type { Aspect, FontOptions, SceneName } from './types.ts';
import { useEffect, useId, useRef, useState, type CSSProperties, type JSX } from 'react';
import { playInView } from './observe.ts';

/**
 * A chart from mermaid source, at runtime.
 *
 * Use this where the diagram comes from content — a CMS field, a markdown post,
 * something a person edits without a deploy. It has to run in the browser
 * because layout is measured from real text: the renderer puts the label in the
 * document, asks how wide it came out, and sizes the box around it. There is no
 * way to do that without a DOM.
 *
 * The parser and layout engine (mermaid, ELK, the drawing code — roughly a
 * megabyte before compression) are behind a dynamic `import()` fired from
 * `useEffect`, so they land in a chunk fetched the first time a chart mounts
 * rather than in the entry bundle of every page that imports this module. That
 * import never runs during server rendering, because effects never run there —
 * which is also what keeps this component SSR-safe: nothing above touches
 * `document` or `window` at module load or during render, only inside the
 * effect.
 */

export interface GeekchartProps {
  /** Mermaid source. Damaged pastes are repaired before parsing. */
  source: string;
  /** Palette and type. Defaults to `manim`. */
  scene?: SceneName;
  /** Set false to draw the finished diagram with no animation. */
  motion?: boolean;
  /**
   * DESIGN 8.4: `'loop'` repeats the build forever. `'once'` plays it once
   * and holds the finished frame. `'in-view'` (the default) is the same
   * single pass, held paused until this component's own root is scrolled
   * 40% into view — see `geekchart/observe`'s `playInView`, which this
   * component calls on itself.
   */
  play?: 'loop' | 'once' | 'in-view';
  /**
   * DESIGN 8.6: stretch or hurry the whole build by one multiplier — `0.5`
   * plays at half speed, `2` at double, `1` (the default) is the designed
   * timing. Clamped to 0.25–4; order, easing and lag ratios never change. If
   * `duration` is also given, `duration` wins and this is ignored.
   */
  speed?: number;
  /**
   * DESIGN 8.6: play the build in about this many seconds instead of naming
   * a multiplier — `render()` derives the 8.6 speed from the chart's own
   * natural cycle (same 0.25–4 clamp). Wins over `speed` when both are given.
   */
  duration?: number;
  /** Pad the diagram into a fixed frame instead of its own bounds. */
  aspect?: Aspect;
  /**
   * Which typefaces to draw in. Defaults to inheriting from the page, which
   * costs no font bytes and matches the text around it.
   *
   * Measurement is not a problem here the way it is for a baked component: this
   * one lays out in the very page it will be shown in, so an inherited font is
   * measured and displayed as the same font by construction.
   */
  fonts?: FontOptions | 'inherit';
  /** Placed on the wrapper, so the page can size and position the chart. */
  className?: string;
  /** Overrides what a screen reader announces. */
  label?: string;
  /**
   * Shown inside the placeholder while the parser chunk loads and the first
   * render is in flight — including during server rendering, where the chart
   * never draws at all.
   */
  fallback?: JSX.Element | null;
  /** Called instead of throwing when the source cannot be drawn. */
  onError?: (error: Error) => void;
  /**
   * The width in CSS px the chart will be shown at (DESIGN 1.1): the layout
   * packs to fit it, and at 480 or less the render reports DESIGN 1.7's
   * "about N screens tall" warning. Default: the renderer's 1000 ceiling.
   */
  display?: number;
  /**
   * Called once each render finishes, with what the renderer reported:
   * the accessible summary, the animation's length in seconds, and any
   * warnings (DESIGN 1.7's phone height, a measurement-font mismatch).
   * An editor shows these to the writer; a page ignores them.
   */
  onRender?: (info: { summary: string; cycle: number; warnings: string[] }) => void;
}

interface Drawn {
  markup: string;
  summary: string;
}

/** Padded-frame ratios, duplicated from `@geekchart/core` rather than imported
 * — a value import would defeat the point of lazy-loading the parser chunk. */
const ASPECT_RATIOS: Record<Exclude<Aspect, 'auto'>, number> = {
  '16:9': 16 / 9,
  '1:1': 1,
  '4:5': 4 / 5,
  '9:16': 9 / 16,
};

/** The drawn canvas is 1000 wide before an explicit `aspect` pads it. */
const DEFAULT_RATIO = 1000 / 560;

export function Geekchart({
  source,
  scene = 'manim',
  motion = true,
  play = 'in-view',
  speed,
  duration,
  aspect,
  fonts = 'inherit',
  className,
  label,
  fallback = null,
  onError,
  display,
  onRender,
}: GeekchartProps): JSX.Element {
  // `useId` is stable across server and client, but its value contains colons,
  // which are not valid in a CSS identifier.
  const raw = useId();
  const id = `gc-${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  // Kept in a ref so a stale render cannot overwrite a newer one when two
  // sources are edited in quick succession.
  const token = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mine = ++token.current;
    let cancelled = false;
    void (async () => {
      try {
        // Imported here rather than at the top of the file so mermaid and ELK
        // land in their own chunk, fetched the first time a live chart mounts.
        // A static import would put roughly a megabyte of parser and layout
        // engine into the entry bundle of every page that imports anything from
        // this package.
        const { render, scopeCss, applyPlayMode } = await import('@geekchart/core');
        const result = await render(source, { scene, motion, speed, duration, aspect, fonts, display });
        if (cancelled || mine !== token.current) return;
        // DESIGN 8.4: `render()` always draws a looping build (see
        // `@geekchart/core`'s `animate.ts` for why that can't default to
        // anything else internally); applied here, once, on the result.
        const played = applyPlayMode({ svg: result.svg, css: result.css }, play);
        setDrawn({
          markup: `<style>${scopeCss(played.css, id)}</style>${played.svg}`,
          summary: result.summary,
        });
        onRender?.({ summary: result.summary, cycle: result.cycle, warnings: result.warnings ?? [] });
      } catch (err) {
        if (cancelled || mine !== token.current) return;
        const error = err instanceof Error ? err : new Error(String(err));
        if (onError) onError(error);
        else throw error;
      }
    })();
    return () => {
      cancelled = true;
    };
    // `onError`/`onRender` are deliberately not dependencies: an inline
    // callback would otherwise re-run the whole render on every parent render.
  }, [source, scene, motion, play, speed, duration, aspect, fonts, display, id]);

  // DESIGN 8.4: `play: 'in-view'` ships paused (see `applyPlayMode` above) —
  // this is the one call that ever unpauses it. Runs again whenever a new
  // chart replaces the markup, since a fresh `<svg>` starts paused too.
  useEffect(() => {
    if (!drawn || play !== 'in-view' || !rootRef.current) return;
    return playInView(rootRef.current);
  }, [drawn, play]);

  if (!drawn) {
    // Reserves the chart's footprint before the parser chunk has even arrived,
    // so nothing above or below it jumps once the real SVG replaces this. A
    // requested `aspect` pads the eventual diagram into that exact ratio; left
    // at `auto`, the ratio is only ever a guess, so it uses the canvas most
    // charts come out close to.
    const ratio = aspect && aspect !== 'auto' ? ASPECT_RATIOS[aspect] : DEFAULT_RATIO;
    const style: CSSProperties = { aspectRatio: String(ratio) };
    return (
      <div className={className} style={style}>
        {fallback}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      id={id}
      className={className}
      role="img"
      aria-label={label ?? drawn.summary}
      dangerouslySetInnerHTML={{ __html: drawn.markup }}
    />
  );
}

export default Geekchart;
