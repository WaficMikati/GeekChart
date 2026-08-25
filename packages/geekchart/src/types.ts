/**
 * Duplicated from `@geekchart/core` on purpose, not imported.
 *
 * `@geekchart/core` is a private, unpublished workspace package — this
 * package's own `.d.ts` must never reference it by name, or `import type {
 * Aspect } from 'geekchart'` breaks the moment someone actually installs
 * `geekchart` from npm, where `@geekchart/core` does not exist to resolve.
 * Keep these in sync with `packages/core/src/flow.ts` (`Aspect`),
 * `packages/core/src/scene.ts` (`SceneName`, `FontOptions`).
 */

export type SceneName = 'manim' | 'geeks';

export type Aspect = 'auto' | '16:9' | '1:1' | '4:5' | '9:16';

export interface FontOptions {
  /** Node titles, participant names, class and entity names. */
  display?: string;
  /** Captions, edge labels, cardinalities, cluster and frame titles. */
  label?: string;
  /** Class members and entity columns, where alignment carries meaning. */
  mono?: string;
  /** What `inherit` resolves to while the diagram is being measured. */
  measureWith?: string;
}
