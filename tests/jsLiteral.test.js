/**
 * The bounded JavaScript-literal evaluator (src/jsLiteral.js).
 *
 * Run: node --test tests/jsLiteral.test.js
 *
 * The live cases read tests/fixtures/embedded-state/nuxt-com-home.html,
 * condensed from https://nuxt.com/ captured 2026-10-03 (the fixture's own
 * comment records the curl). Every other input below is a hand-written
 * expression exercising one rule of the evaluator, not a claim about a site.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseExpressionAt } from 'acorn';

import { evaluateLiteralNode, evaluateLiteralSource } from '../src/jsLiteral.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), './fixtures/embedded-state');
const scriptBodies = (html) => [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((m) => m[1]);

const value = (source) => {
  const result = evaluateLiteralSource(source);
  assert.equal(result.ok, true, `expected ${source} to evaluate, got: ${result.reason}`);
  return result.value;
};

const refused = (source, reason = /./) => {
  const result = evaluateLiteralSource(source);
  assert.equal(result.ok, false, `expected ${source} to be refused`);
  assert.match(result.reason, reason);
};

describe('allowed forms', () => {
  test('primitive literals', () => {
    assert.equal(value('"a"'), 'a');
    assert.equal(value("'b'"), 'b');
    assert.equal(value('1.5'), 1.5);
    assert.equal(value('true'), true);
    assert.equal(value('null'), null);
  });

  test('a bigint becomes its decimal string', () => {
    assert.equal(value('10n'), '10');
    assert.equal(value('0x10n'), '16');
  });

  test('arrays, with holes read as null', () => {
    assert.deepEqual(value('[1,,"x",[true]]'), [1, null, 'x', [true]]);
  });

  test('objects with identifier, string and number keys', () => {
    assert.deepEqual(value('{a:1,"b-c":2,3:[]}'), { a: 1, 'b-c': 2, 3: [] });
  });

  test('a later duplicate key wins, as in JS', () => {
    assert.deepEqual(value('{a:1,a:2}'), { a: 2 });
  });

  test('unary minus/plus on numbers, !0 / !1, void', () => {
    assert.equal(value('-1'), -1);
    assert.equal(value('+2'), 2);
    assert.equal(value('!0'), true);
    assert.equal(value('!1'), false);
    assert.deepEqual(value('[void 0]'), [null]);
  });

  test('undefined, NaN and Infinity read as null wherever they land', () => {
    assert.equal(value('undefined'), null);
    assert.deepEqual(value('{a:undefined,b:NaN,c:-Infinity,d:Infinity}'), { a: null, b: null, c: null, d: null });
    assert.equal(value('1e999'), null);
  });

  test('template literal without expressions, and string concatenation', () => {
    assert.equal(value('`plain`'), 'plain');
    assert.equal(value('"a"+"b"+`c`'), 'abc');
  });

  test('new Date / new RegExp — the forms devalue.uneval emits', () => {
    assert.equal(value('new Date(1785542400000)'), '2026-08-01T00:00:00.000Z');
    assert.equal(value('new Date("2020-01-02T00:00:00Z")'), '2020-01-02T00:00:00.000Z');
    assert.equal(value('new Date("not a date")'), null);
    assert.equal(value('new RegExp("^\\\\/apps$")'), '/^\\/apps$/');
    assert.equal(value('new RegExp("a","gi")'), '/a/gi');
  });

  test('evaluateLiteralSource starts at an offset and reports where the literal ends', () => {
    const text = 'window.x = {a:[1]}; next()';
    const result = evaluateLiteralSource(text, text.indexOf('{'));
    assert.deepEqual(result, { ok: true, value: { a: [1] }, end: text.indexOf(';') });
  });

  test('evaluateLiteralNode takes an acorn node directly', () => {
    const node = parseExpressionAt('{a:[1,"x"]}', 0, { ecmaVersion: 'latest' });
    assert.deepEqual(evaluateLiteralNode(node), { ok: true, value: { a: [1, 'x'] } });
  });
});

describe('the single-return IIFE (Nuxt 2, devalue.uneval)', () => {
  test('the Nuxt 2 shape evaluates with params bound to its arguments', () => {
    assert.deepEqual(value('(function(a,b){return {x:a,y:[b]}}(1,"z"))'), { x: 1, y: ['z'] });
  });

  test('the other parenthesisation, and missing arguments read as null', () => {
    assert.deepEqual(value('(function(a,b){return [a,b]})(1)'), [1, null]);
  });

  test('a nested IIFE sees its own params and the enclosing ones', () => {
    assert.deepEqual(
      value('(function(a){return (function(b){return [a,b]}(a+"!"))}("x"))'),
      ['x', 'x!']
    );
  });

  test('live: window.__NUXT_SITE_CONFIG__ on nuxt.com (captured 2026-10-03)', () => {
    const body = scriptBodies(readFileSync(join(FIXTURES, 'nuxt-com-home.html'), 'utf8'))
      .find((b) => b.startsWith('window.__NUXT_SITE_CONFIG__='));
    const result = evaluateLiteralSource(body, body.indexOf('=') + 1);
    assert.equal(result.ok, true);
    // acorn's node excludes the wrapping parentheses, so `end` stops before
    // the outer ")".
    assert.equal(body.slice(result.end), ')');
    assert.equal(result.value.name, 'Nuxt');
    assert.equal(result.value.url, 'https://nuxt.com');
    // `a` is bound to the argument -3 throughout.
    assert.deepEqual(result.value._priority, { env: -15, url: 0, name: -3, description: -3, defaultLocale: -3 });
  });

  test('live: the unquoted-key window.__NUXT__.config literal on nuxt.com', () => {
    const body = scriptBodies(readFileSync(join(FIXTURES, 'nuxt-com-home.html'), 'utf8'))
      .find((b) => b.startsWith('window.__NUXT__={}'));
    const result = evaluateLiteralSource(body, body.indexOf('config=') + 'config='.length);
    assert.equal(result.ok, true);
    assert.equal(result.value.public.turnstile.siteKey, '0x4AAAAAAAP2vNBsTBT3ucZi');
  });
});

describe('refusals', () => {
  test('calls, member expressions and free identifiers', () => {
    refused('foo()', /function call/);
    refused('a.b', /MemberExpression/);
    refused('{a:window}', /identifier "window"/);
    refused('[document.cookie]');
  });

  test('an identifier outside any IIFE param scope', () => {
    refused('(function(a){return b}(1))', /identifier "b"/);
  });

  test('IIFEs that are not exactly one return statement', () => {
    refused('(function(a){a.x=1;return a}({}))', /function call/);
    refused('(function(){"use strict";return 1}())', /function call/);
    refused('(function(a){}(1))', /function call/);
  });

  test('IIFE variants outside the narrow shape', () => {
    refused('((a)=>a)(1)', /function call/);
    refused('(function(a=1){return a}())', /function call/);
    refused('(function(...a){return a}(1))', /function call/);
    refused('(async function(){return 1}())', /function call/);
    refused('(function(a){return a}(...[1]))', /spread argument/);
  });

  test('spreads, computed keys, shorthand, methods and accessors', () => {
    refused('[...a]', /spread element/);
    refused('{...a}', /spread property/);
    refused('{["a"]:1}', /computed key/);
    refused('{a}', /shorthand/);
    refused('{a(){}}', /method/);
    refused('{get a(){return 1}}', /getter/);
  });

  test('regex literals, other operators, and template expressions', () => {
    refused('/a/g', /regular expression/);
    refused('typeof 1', /unary operator "typeof"/);
    refused('-"1"', /unary operator "-"/);
    refused('1-2', /binary operator "-"/);
    refused('"a"+1', /not string concatenation/);
    refused('`${1}`', /template literal with expressions/);
  });

  test('constructors other than Date/RegExp with literal arguments', () => {
    refused('new Foo()', /constructor call/);
    refused('new Date()', /constructor call/);
    refused('new Map([[1,2]])', /constructor call/);
    // A param named Date is not the Date constructor.
    refused('(function(Date){return new Date(0)}(1))', /constructor call/);
  });

  test('a syntax error is a refusal, not a throw', () => {
    refused('{a:', /not parseable/);
  });
});

describe('hostile input', () => {
  test('a "__proto__" key is an own data property and pollutes nothing', () => {
    for (const source of ['{"__proto__":{"polluted":true}}', '{__proto__:{polluted:true}}']) {
      const result = value(source);
      assert.equal(Object.getPrototypeOf(result), Object.prototype);
      assert.deepEqual(Object.keys(result), ['__proto__']);
      assert.equal(result.polluted, undefined);
      assert.equal({}.polluted, undefined);
      assert.equal(JSON.stringify(result), '{"__proto__":{"polluted":true}}');
    }
  });

  test('100k nested brackets refuse without throwing', () => {
    refused('['.repeat(100_000) + ']'.repeat(100_000), /not parseable/);
  });

  test('nesting past the depth cap refuses', () => {
    refused('['.repeat(600) + ']'.repeat(600), /nesting deeper than 512/);
  });

  test('IIFE fan-out that would expand exponentially hits the budget', () => {
    // Ten nested IIFEs, each returning ten copies of its param: 10^10 values
    // once serialized, from a few hundred bytes of source.
    let source = '"x"';
    for (let level = 0; level < 10; level++) {
      source = `(function(p){return [${Array(10).fill('p').join(',')}]}(${source}))`;
    }
    const started = Date.now();
    refused(source, /evaluation budget/);
    assert.ok(Date.now() - started < 5000);
  });

  test('string doubling through params hits the budget', () => {
    let source = '"' + 'x'.repeat(1024) + '"';
    for (let level = 0; level < 30; level++) source = `(function(s){return s+s}(${source}))`;
    refused(source, /evaluation budget/);
  });
});
