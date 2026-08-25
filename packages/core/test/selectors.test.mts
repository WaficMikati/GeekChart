import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAttributeSelectors } from '../src/theme.ts';

test('rewrites class selectors, including inside at-rules', () => {
  const css = '.node rect { fill: red }\n@media (min-width: 10px) { .edgeLabel rect { fill: blue } }';
  const out = toAttributeSelectors(css);
  assert.ok(out.includes('[class~="node"] rect'));
  assert.ok(out.includes('[class~="edgeLabel"] rect'), 'at-rule bodies are rewritten too');
  assert.ok(!/(^|[^"])\.node/.test(out));
});

test('leaves declaration values untouched', () => {
  const out = toAttributeSelectors('.gc-node { font-size: .82em; animation-duration: .5s; opacity: .96 }');
  assert.ok(out.includes('font-size: .82em'));
  assert.ok(out.includes('animation-duration: .5s'));
  assert.ok(out.includes('opacity: .96'));
});

test('keeps keyframe selectors intact', () => {
  const out = toAttributeSelectors('@keyframes gc-draw { from { stroke-dashoffset: 5px } to { stroke-dashoffset: 0 } }');
  assert.ok(out.includes('from {'));
  assert.ok(out.includes('to {'));
});
