import type { RepairNote, RepairResult } from './types.ts';

/**
 * Deterministic clean-up of pasted mermaid.
 *
 * Every rule is a pure string transform that reports what it touched, so the UI
 * can show "we changed 3 things" and the user can disagree. Nothing here guesses
 * at intent: a rule only fires on damage that has exactly one sensible reading
 * (a stray code fence, a smart quote, an em dash where an arrow belongs).
 *
 * Order matters. Fences and invisible characters come off first so later rules
 * see the real text.
 */

type Rule = {
  id: string;
  describe: (n: number) => string;
  apply: (src: string) => { out: string; count: number };
};

/** Simple regex rule: count the matches, replace them all. */
function sub(
  id: string,
  pattern: RegExp,
  replacement: string | ((match: string) => string),
  describe: (n: number) => string,
): Rule {
  return {
    id,
    describe,
    apply: (src) => {
      const count = src.match(pattern)?.length ?? 0;
      if (!count) return { out: src, count };
      const out =
        typeof replacement === 'string'
          ? src.replace(pattern, replacement)
          : src.replace(pattern, replacement);
      return { out, count };
    },
  };
}

/** Diagram keywords mermaid 11 understands, longest first so `stateDiagram-v2` wins. */
export const DIAGRAM_KEYWORDS = [
  'architecture-beta',
  'requirementDiagram',
  'quadrantChart',
  'stateDiagram-v2',
  'sequenceDiagram',
  'classDiagram-v2',
  'C4Deployment',
  'stateDiagram',
  'classDiagram',
  'xychart-beta',
  'sankey-beta',
  'packet-beta',
  'radar-beta',
  'block-beta',
  'treemap-beta',
  'C4Container',
  'C4Component',
  'C4Context',
  'C4Dynamic',
  'erDiagram',
  'gitGraph',
  'flowchart',
  'timeline',
  'mindmap',
  'journey',
  'kanban',
  'zenuml',
  'gantt',
  'graph',
  'pie',
] as const;

const headerPattern = new RegExp(`^\\s*(${DIAGRAM_KEYWORDS.join('|')})\\b`);

/**
 * Shapes whose label delimiters are themselves brackets: `A[(db)]`, `A[/skew/]`.
 * Quoting their contents would silently change the shape, so they are skipped.
 */
const SHAPE_DELIMITED = [/^\(.*\)$/s, /^\/.*\/$/s, /^\\.*\\$/s, /^\/.*\\$/s, /^\\.*\/$/s];

/**
 * Strips a wrapping ```mermaid fence and any stray fence lines left inside the
 * body (e.g. two pasted snippets stitched together). Tracks opened/closed/stray
 * separately so the flag text says exactly what happened — a bare "removed a
 * fence" is a lie if only the opening half matched and the closing ``` was left
 * behind to render as a bogus node.
 */
function codeFenceRule(): Rule {
  let opened = 0;
  let closed = 0;
  let stray = 0;
  return {
    id: 'code-fence',
    describe: () => {
      const parts: string[] = [];
      if (opened && closed) parts.push('removed the wrapping markdown code fence');
      else if (opened) parts.push('removed an opening markdown code fence (no closing fence found)');
      else if (closed) parts.push('removed a stray closing markdown code fence');
      if (stray) {
        parts.push(
          `removed ${stray} stray code fence line${stray === 1 ? '' : 's'} left inside the diagram`,
        );
      }
      return parts.join('; ');
    },
    apply: (src) => {
      opened = 0;
      closed = 0;
      stray = 0;
      let out = src.replace(/^\s*```+[ \t]*(?:mermaid|mmd)?[ \t]*\r?\n/i, () => (opened++, ''));
      out = out.replace(/\r?\n[ \t]*```+[ \t]*\s*$/, () => (closed++, ''));
      // Safety net: any further standalone fence line left in the body would
      // otherwise surface as a bogus node whose label is the fence itself.
      out = out.replace(/^[ \t]*```+[ \t]*(?:mermaid|mmd)?[ \t]*$\r?\n?/gim, () => (stray++, ''));
      return { out, count: opened + closed + stray };
    },
  };
}

const rules: Rule[] = [
  codeFenceRule(),
  sub('bom', /\uFEFF/g, '', (n) => `stripped ${n} byte-order mark${n === 1 ? '' : 's'}`),
  sub(
    'zero-width',
    /[\u200B-\u200D\u2060]/g,
    '',
    (n) => `stripped ${n} invisible character${n === 1 ? '' : 's'}`,
  ),
  sub(
    'nbsp',
    /[\u00A0\u202F\u2007]/g,
    ' ',
    (n) => `replaced ${n} non-breaking space${n === 1 ? '' : 's'} with a normal space`,
  ),
  sub('crlf', /\r\n/g, '\n', (n) => `normalised ${n} Windows line ending${n === 1 ? '' : 's'}`),
  sub(
    'smart-double-quote',
    /[“”„‟]/g,
    '"',
    (n) => `straightened ${n} curly double quote${n === 1 ? '' : 's'}`,
  ),
  sub(
    'smart-single-quote',
    /[‘’‚‛]/g,
    "'",
    (n) => `straightened ${n} curly single quote${n === 1 ? '' : 's'}`,
  ),
  sub(
    'dash-arrow',
    /[–—−]{1,2}>/g,
    '-->',
    (n) => `turned ${n} em/en dash${n === 1 ? '' : 'es'} back into an arrow`,
  ),
  sub(
    'unicode-arrow',
    /[→⟶⇒⟹]/g,
    '-->',
    (n) => `replaced ${n} unicode arrow${n === 1 ? '' : 's'} with -->`,
  ),
  sub(
    'dash-only',
    /(?<=[\w\])}"])[–—−]{2,}(?=[\s\w[({"])/g,
    '---',
    (n) => `replaced ${n} em dash link${n === 1 ? '' : 's'} with ---`,
  ),
  sub(
    'br-tag',
    /<br\s*>/gi,
    '<br/>',
    (n) => `closed ${n} <br> tag${n === 1 ? '' : 's'}`,
  ),
  sub(
    'leading-tabs',
    /^\t+/gm,
    (m: string) => '  '.repeat(m.length),
    (n) => `converted leading tabs on ${n} line${n === 1 ? '' : 's'} to spaces`,
  ),
  {
    id: 'quote-parens',
    describe: (n) =>
      `quoted ${n} label${n === 1 ? '' : 's'} containing brackets, which mermaid would otherwise read as syntax`,
    apply: (src) => {
      let count = 0;
      // Square-bracket and brace labels only. Doubled forms ([[x]], {{x}}) never
      // match because the inner bracket is excluded from the character class.
      const out = src.replace(
        /(^|[^[{])([[{])([^[\]{}"'\n]*)([\]}])/g,
        (whole, before: string, open: string, label: string, close: string) => {
          const balanced = (open === '[' && close === ']') || (open === '{' && close === '}');
          if (!balanced) return whole;
          if (!/[()]/.test(label)) return whole;
          if (SHAPE_DELIMITED.some((p) => p.test(label))) return whole;
          count++;
          return `${before}${open}"${label}"${close}`;
        },
      );
      return { out, count };
    },
  },
  {
    id: 'missing-header',
    describe: () => 'added a `flowchart TD` header, since the snippet did not declare a diagram type',
    apply: (src) => {
      // Front-matter and %%{init}%% directives may legally precede the header.
      const body = src
        .replace(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
        .replace(/^(\s*%%\{[\s\S]*?\}%%\s*\n)+/, '')
        .replace(/^(\s*%%[^\n]*\n)+/, '');
      if (!body.trim() || headerPattern.test(body)) return { out: src, count: 0 };
      const insertAt = src.length - body.length;
      return {
        out: src.slice(0, insertAt) + 'flowchart TD\n' + src.slice(insertAt),
        count: 1,
      };
    },
  },
  {
    id: 'trim',
    describe: () => 'trimmed blank lines from the ends',
    apply: (src) => {
      const out = src.replace(/^\s*\n+/, '').replace(/\s+$/, '\n');
      return { out, count: out === src ? 0 : 1 };
    },
  },
];

export function repair(input: string): RepairResult {
  let source = input;
  const notes: RepairNote[] = [];
  for (const rule of rules) {
    const { out, count } = rule.apply(source);
    if (count > 0 && out !== source) {
      notes.push({ rule: rule.id, message: rule.describe(count), count });
      source = out;
    }
  }
  return { source, notes };
}
