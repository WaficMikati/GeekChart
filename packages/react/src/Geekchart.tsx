'use client';

import type { Aspect, FontOptions, SceneName } from '@geekchart/core';
import { useEffect, useId, useRef, useState, type JSX } from 'react';

/**
 * A chart from mermaid source, at runtime.
 *
 * Use this where the diagram comes from content — a CMS field, a markdown post,
 * something a person edits without a deploy. For a diagram that is fixed, bake
 * it instead (`geekchart chart.mmd -o Chart.tsx`): the baked component has no
 * dependencies, needs no client JavaScript and renders inside a Server
 * Component, where this one pulls mermaid and ELK into the bundle and must run
 * in the browser.
 *
 * It has to run in the browser because layout is measured from real text: the
 * renderer puts the label in the document, asks how wide it came out, and sizes
 * the box around it. There is no way to do that without a DOM.
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
  /** Shown while the first render is in flight. */
  fallback?: JSX.Element | null;
  /** Called instead of throwing when the source cannot be drawn. */
  onError?: (error: Error) => void;
}

interface Drawn {
  markup: string;
  summary: string;
}

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, scene, motion, aspect, fonts, id]);

  if (!drawn) return <div className={className}>{fallback}</div>;

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
