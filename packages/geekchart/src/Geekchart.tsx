'use client';

import type { Aspect, FontOptions, SceneName } from './types.ts';
import { useEffect, useId, useRef, useState, type CSSProperties, type JSX } from 'react';

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
  aspect,
  fonts = 'inherit',
  className,
  label,
  fallback = null,
  onError,
}: GeekchartProps): JSX.Element {
  // `useId` is stable across server and client, but its value contains colons,
  // which are not valid in a CSS identifier.
  const raw = useId();
  const id = `gc-${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  // Kept in a ref so a stale render cannot overwrite a newer one when two
  // sources are edited in quick succession.
  const token = useRef(0);

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
        const { render, scopeCss } = await import('@geekchart/core');
        const result = await render(source, { scene, motion, aspect, fonts });
        if (cancelled || mine !== token.current) return;
        setDrawn({
          markup: `<style>${scopeCss(result.css, id)}</style>${result.svg}`,
          summary: result.summary,
        });
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
    // `onError` is deliberately not a dependency: an inline callback would
    // otherwise re-run the whole render on every parent render.
  }, [source, scene, motion, aspect, fonts, id]);

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
      id={id}
      className={className}
      role="img"
      aria-label={label ?? drawn.summary}
      dangerouslySetInnerHTML={{ __html: drawn.markup }}
    />
  );
}

export default Geekchart;
