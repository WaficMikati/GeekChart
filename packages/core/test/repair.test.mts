import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repair } from '../src/repair.ts';

const rules = (input: string) => repair(input).notes.map((n) => n.rule);

test('strips a markdown code fence', () => {
  const { source, notes } = repair('```mermaid\nflowchart TD\n  A --> B\n```');
  assert.equal(source.trim(), 'flowchart TD\n  A --> B');
  assert.ok(notes.some((n) => n.rule === 'code-fence'));
});

test('turns pasted em dashes back into arrows', () => {
  const { source } = repair('flowchart TD\n  A —> B\n  B –> C');
  assert.ok(source.includes('A --> B'));
  assert.ok(source.includes('B --> C'));
});

test('quotes labels containing brackets', () => {
  const { source } = repair('flowchart TD\n  A[Start (fast)] --> B{Is it (ok)?}');
  assert.ok(source.includes('A["Start (fast)"]'));
  assert.ok(source.includes('B{"Is it (ok)?"}'));
});

test('leaves bracket-delimited shapes alone', () => {
  const input = 'flowchart LR\n  A[(Users DB)] --> B([Round])\n  C[/Skew/] --> D[[Sub]]\n';
  const { source, notes } = repair(input);
  assert.equal(source.trim(), input.trim());
  assert.ok(!notes.some((n) => n.rule === 'quote-parens'));
});

test('adds a header only when one is missing', () => {
  assert.ok(repair('A --> B').source.startsWith('flowchart TD'));
  assert.ok(!rules('flowchart LR\n  A --> B').includes('missing-header'));
  assert.ok(!rules('sequenceDiagram\n  A->>B: hi').includes('missing-header'));
  assert.ok(!rules('stateDiagram-v2\n  [*] --> A').includes('missing-header'));
});

test('keeps front matter and init directives above the header', () => {
  const withDirective = '%%{init: {"theme":"base"}}%%\nflowchart LR\n  A --> B';
  assert.ok(!rules(withDirective).includes('missing-header'));
  const withFrontMatter = '---\ntitle: Hi\n---\nflowchart LR\n  A --> B';
  assert.ok(!rules(withFrontMatter).includes('missing-header'));
});

test('straightens smart quotes and removes invisible characters', () => {
  const { source } = repair('flowchart TD\n  A[“Quoted”]​ --> B');
  assert.ok(source.includes('"Quoted"'));
  assert.ok(!/​/.test(source));
});

test('is idempotent', () => {
  const once = repair('```mermaid\nA[x (y)] —> B\n```').source;
  assert.equal(repair(once).source, once);
});

test('reports every change it makes', () => {
  const { notes } = repair('```mermaid\nA[Do (this)] —> B\n```');
  assert.ok(notes.length >= 3);
  for (const note of notes) {
    assert.ok(note.message.length > 0, 'each note explains itself');
    assert.ok(note.count > 0);
  }
});
