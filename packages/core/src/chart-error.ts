import type { ParseError } from './types.ts';

/**
 * Thrown for a diagram that cannot be drawn — carries the detail a caller
 * shows a user (a line number, an excerpt) rather than mermaid's raw message.
 *
 * Its own file so both `chart.ts` and `render.ts` can throw it without
 * `chart.ts` picking up a static edge to `render.ts`'s whole mermaid-render
 * stack just to reach a five-line class.
 */
export class ChartError extends Error {
  readonly detail: ParseError;
  constructor(detail: ParseError) {
    super(detail.message);
    this.name = 'ChartError';
    this.detail = detail;
  }
}
