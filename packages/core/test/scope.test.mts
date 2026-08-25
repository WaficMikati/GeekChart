import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeCss } from '../src/scope.ts';

/**
 * Guards for confining one chart's stylesheet.
 *
 * This is what lets a page hold more than one chart, and every way it fails is
 * silent: the page still renders, the animations still run, they just run to the
 * wrong definition.
 */

/** Every name a stylesheet declares an animation under. */
const declared = (css: string) => [...css.matchAll(/@keyframes\s+([A-Za-z_][\w-]*)/g)].map((m) => m[1]!);

describe('scopeCss', () => {
  test('renames whatever the sheet declares, whatever it is called', () => {
    // This used to match a hardcoded `gc-t*`/`gc-s*` pattern. When the
    // timeline/gantt/journey renderer arrived using `gc-c*`, its animations were
    // left unrenamed and all three of its charts shared one set again.
    const css = `
      .a{animation:gc-t0 1s}   @keyframes gc-t0{0%{opacity:0}}
      .b{animation:gc-c3 1s}   @keyframes gc-c3{0%{opacity:0}}
      .c{animation:whatever 1s}@keyframes whatever{0%{opacity:0}}`;
    const out = scopeCss(css, 'k1');
    for (const name of ['gc-t0', 'gc-c3', 'whatever']) {
      assert.ok(out.includes(`${name}-k1`), `${name} was not renamed`);
      assert.equal(
        (out.match(new RegExp(`\\b${name}-k1\\b`, 'g')) ?? []).length,
        2,
        `${name}: the declaration and the reference must agree`,
      );
    }
  });

  test('two charts on one page share no animation name', () => {
    const css = `.a{animation:gc-c0 1s}@keyframes gc-c0{0%{opacity:0}}`;
    const first = new Set(declared(scopeCss(css, 'one')));
    const second = new Set(declared(scopeCss(css, 'two')));
    assert.equal(first.size, 1);
    for (const name of first) assert.ok(!second.has(name), `${name} is shared`);
  });

  test('a shorter name does not eat a longer one', () => {
    const css = `@keyframes gc-c1{0%{opacity:0}} @keyframes gc-c11{0%{opacity:1}}`;
    const out = scopeCss(css, 'k1');
    assert.ok(out.includes('gc-c11-k1'), 'gc-c11 must survive intact');
    assert.ok(!/-k1-k1/.test(out), 'nothing may be renamed twice');
    assert.equal(new Set(declared(out)).size, 2);
  });

  test('keyframe offsets are left alone and selectors are confined', () => {
    // Prefixing `0%` produces a stylesheet that parses cleanly and animates
    // nothing at all.
    const out = scopeCss(`.x{color:red}@keyframes k{0%{opacity:0}100%{opacity:1}}`, 'k1');
    assert.ok(out.includes('0%{opacity:0}'), 'offsets must not be touched');
    assert.ok(!/#k1 0%/.test(out));
    assert.ok(out.includes('#k1 .x'), 'ordinary selectors are confined');
  });

  test('comments are dropped rather than prefixed', () => {
    const out = scopeCss(`/* one, two */ .x{color:red}`, 'k1');
    assert.ok(!out.includes('/*'), 'generated output carries no commentary');
    assert.ok(out.includes('#k1 .x'));
  });
});
