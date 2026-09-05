import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRuntimeGeometry } from '../src/layout/runtime-checks.ts';
import { renderNode } from '../src/node/render.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

describe('checkRuntimeGeometry — synthetic geometry', () => {
  test('clean geometry: no warnings', () => {
    const boxes = [
      { id: 'A', x: 0, y: 0, width: 100, height: 40 },
      { id: 'B', x: 0, y: 100, width: 100, height: 40 },
    ];
    const edges = [
      {
        id: 'e1',
        from: 'A',
        to: 'B',
        points: [
          { x: 50, y: 40 },
          { x: 50, y: 100 },
        ],
        endSide: 'top',
      },
    ];
    assert.deepEqual(checkRuntimeGeometry(boxes, edges), []);
  });

  test('an edge run closer than 16 to a node it does not connect', () => {
    const boxes = [
      { id: 'A', x: 0, y: 0, width: 100, height: 40 },
      { id: 'B', x: 0, y: 100, width: 100, height: 40 },
      // Sits right beside the straight A->B run, well under 16 clear.
      { id: 'C', x: 55, y: 50, width: 40, height: 40 },
    ];
    const edges = [
      {
        id: 'e1',
        from: 'A',
        to: 'B',
        points: [
          { x: 50, y: 40 },
          { x: 50, y: 100 },
        ],
        endSide: 'top',
      },
    ];
    const warnings = checkRuntimeGeometry(boxes, edges);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /^6\.1-runtime/);
    assert.match(warnings[0]!, /\bC\b/);
  });

  test('a foreign node exactly 16 clear is not a violation', () => {
    const boxes = [
      { id: 'A', x: 0, y: 0, width: 100, height: 40 },
      { id: 'B', x: 0, y: 100, width: 100, height: 40 },
      { id: 'C', x: 66, y: 50, width: 40, height: 40 }, // 16 clear of x=50
    ];
    const edges = [
      {
        id: 'e1',
        from: 'A',
        to: 'B',
        points: [
          { x: 50, y: 40 },
          { x: 50, y: 100 },
        ],
        endSide: 'top',
      },
    ];
    assert.deepEqual(checkRuntimeGeometry(boxes, edges), []);
  });

  test('a panel box is exempt for an edge between its own members', () => {
    const boxes = [
      { id: 'A', x: 10, y: 10, width: 40, height: 20 },
      { id: 'B', x: 10, y: 60, width: 40, height: 20 },
      { id: 'Panel', x: 0, y: 0, width: 100, height: 100, members: ['A', 'B'] },
    ];
    const edges = [
      {
        id: 'e1',
        from: 'A',
        to: 'B',
        points: [
          { x: 30, y: 30 },
          { x: 30, y: 60 },
        ],
        endSide: 'top',
      },
    ];
    assert.deepEqual(checkRuntimeGeometry(boxes, edges), []);
  });

  test('an edge that departs off its source outline', () => {
    const boxes = [
      { id: 'A', x: 0, y: 0, width: 100, height: 40 },
      { id: 'B', x: 0, y: 100, width: 100, height: 40 },
    ];
    const edges = [
      {
        id: 'e1',
        from: 'A',
        to: 'B',
        // Starts 40 units below A's own bottom face — nowhere near its outline.
        points: [
          { x: 50, y: 80 },
          { x: 50, y: 100 },
        ],
        endSide: 'top',
      },
    ];
    const warnings = checkRuntimeGeometry(boxes, edges);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /^6\.2-runtime/);
  });

  test('two distinct arrival points on one node side: more than one arrowhead', () => {
    const boxes = [
      { id: 'A', x: 0, y: 0, width: 40, height: 40 },
      { id: 'B', x: 100, y: 0, width: 40, height: 40 },
      { id: 'T', x: 50, y: 100, width: 100, height: 40 },
    ];
    const edges = [
      {
        id: 'e1',
        from: 'A',
        to: 'T',
        points: [
          { x: 20, y: 40 },
          { x: 20, y: 90 },
          { x: 70, y: 90 },
          { x: 70, y: 100 },
        ],
        endSide: 'top',
      },
      {
        id: 'e2',
        from: 'B',
        to: 'T',
        points: [
          { x: 120, y: 40 },
          { x: 120, y: 90 },
          { x: 130, y: 90 },
          { x: 130, y: 100 },
        ],
        endSide: 'top',
      },
    ];
    const warnings = checkRuntimeGeometry(boxes, edges);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /^6\.3-runtime/);
  });

  test('a merged fan-in trunk sharing one exact arrival point is not a violation', () => {
    const boxes = [
      { id: 'A', x: 0, y: 0, width: 40, height: 40 },
      { id: 'B', x: 100, y: 0, width: 40, height: 40 },
      { id: 'T', x: 50, y: 100, width: 100, height: 40 },
    ];
    const edges = [
      {
        id: 'e1',
        from: 'A',
        to: 'T',
        points: [
          { x: 20, y: 40 },
          { x: 20, y: 90 },
          { x: 100, y: 90 },
          { x: 100, y: 100 },
        ],
        endSide: 'top',
      },
      {
        id: 'e2',
        from: 'B',
        to: 'T',
        points: [
          { x: 120, y: 40 },
          { x: 120, y: 90 },
          { x: 100, y: 90 },
          { x: 100, y: 100 },
        ],
        endSide: 'top',
      },
    ];
    assert.deepEqual(checkRuntimeGeometry(boxes, edges), []);
  });
});

// DESIGN's own ruling: the channel engine and the safe layout both verify
// their routes before committing, so a runtime violation on either is an
// engine bug — this is the check that no such bug exists in the catalog.
describe('render-time geometry, every fixture', () => {
  const fixtureDirs = [join(repoRoot, 'fixtures'), join(repoRoot, 'fixtures', 'blog')];
  const files = fixtureDirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.mmd'))
      .map((f) => join(dir, f)),
  );

  for (const file of files) {
    test(`${file.split('/').pop()} has no runtime-geometry warnings`, async () => {
      const source = readFileSync(file, 'utf8');
      const reply = await renderNode(source);
      const runtime = reply.warnings.filter((w) => w.includes('-runtime'));
      assert.deepEqual(runtime, [], runtime.join(' | '));
    });
  }
});
