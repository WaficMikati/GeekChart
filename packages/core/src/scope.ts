/**
 * Make one chart's stylesheet safe to put beside another's.
 *
 * Every chart we emit uses the same class names — `gc-node`, `gc-edge`, `gc-msg`
 * — and numbers its keyframes from zero. That is fine for a page holding one
 * diagram and wrong for anything else: the second chart's `gc-t0` silently
 * replaces the first's, and both animate to whichever definition parsed last.
 *
 * Scoping is what makes a chart embeddable — in a gallery, in a React component,
 * anywhere a page might hold two of them.
 */

/**
 * Rename every animation this stylesheet declares.
 *
 * The names are read from the sheet's own `@keyframes` rules rather than matched
 * against a pattern. A pattern goes stale the moment a new renderer picks a new
 * prefix — which is exactly what happened: this matched `gc-t*` and `gc-s*`, then
 * the timeline/gantt/journey renderer arrived using `gc-c*` and all three of its
 * charts silently shared one set of animations again. Reading the declarations
 * cannot drift, because a name that is not declared here needs no renaming.
 *
 * One pass over an alternation, longest name first, so `gc-c1` cannot eat part of
 * `gc-c11` and nothing already rewritten is visited twice.
 */
function renameFrames(css: string, id: string): string {
  const declared = [
    ...new Set([...css.matchAll(/@keyframes\s+([A-Za-z_][\w-]*)/g)].map((m) => m[1]!)),
  ];
  if (!declared.length) return css;
  const escaped = declared
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return css.replace(new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'g'), (hit) => `${hit}-${id}`);
}

/**
 * Drop comments before anything else looks at the text.
 *
 * The stylesheet this codebase generates is heavily commented, and those
 * comments are for whoever reads the source, not for whoever ships the chart —
 * they were 40% of an emitted React component. They also confuse every step
 * below: a comma inside a comment reads as a selector separator, and a brace
 * inside one would end a block early.
 */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Split a stylesheet into top-level `prelude { body }` blocks. */
function blocks(css: string): { prelude: string; body: string }[] {
  const out: { prelude: string; body: string }[] = [];
  let depth = 0;
  let start = 0;
  let preludeEnd = -1;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      if (depth === 0) preludeEnd = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        out.push({ prelude: css.slice(start, preludeEnd), body: css.slice(preludeEnd + 1, i) });
        start = i + 1;
      }
    }
  }
  return out;
}

/** Comment-aware selector split: a comma inside `:is(...)` is not a separator. */
function selectors(prelude: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of prelude) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

/**
 * Confine a chart's stylesheet to one root element.
 *
 * `@keyframes` bodies are copied through untouched — their `0%` and `100%` are
 * offsets, not selectors, and prefixing them produces a stylesheet that parses
 * but animates nothing. Other at-rules are recursed into, so a rule inside
 * `@media (prefers-reduced-motion: no-preference)` is scoped like any other.
 */
export function scopeCss(css: string, id: string, root = `#${id}`): string {
  return confine(renameFrames(stripComments(css), id), root);
}

/**
 * Prefix every selector, once.
 *
 * Kept separate from the rename so recursion cannot apply the rename twice — a
 * rule nested inside `@media` would otherwise come out as `gc-t0-id-id` and
 * match no keyframes at all.
 */
function confine(css: string, root: string): string {
  return blocks(css)
    .map(({ prelude, body }) => {
      const head = prelude.trim();
      // `0%` and `100%` are offsets, not selectors; prefixing them produces a
      // stylesheet that parses cleanly and animates nothing.
      if (/^@keyframes/i.test(head)) return `${head}{${body}}`;
      if (head.startsWith('@')) return `${head}{${confine(body, root)}}`;
      const list = selectors(head)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (s.startsWith(root) ? s : `${root} ${s}`))
        .join(',');
      return `${list}{${body}}`;
    })
    .join('\n');
}
