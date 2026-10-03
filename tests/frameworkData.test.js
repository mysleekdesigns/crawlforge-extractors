/**
 * Nuxt 3 devalue payloads and SvelteKit boot-script data (src/frameworkData.js).
 *
 * Run: node --test tests/frameworkData.test.js
 *
 * Live fixtures, captured 2026-10-03 (each file's own comment records the
 * curl and what was trimmed):
 *   - nuxt-com-home.html   https://nuxt.com/       (__NUXT_DATA__: Reactive,
 *                                                   ShallowReactive, Set)
 *   - svelte-dev-home.html https://svelte.dev/      (kit.start data, 2 nodes)
 *   - svelte-dev-blog.html https://svelte.dev/blog  (kit.start data, posts)
 *
 * The other payloads are built by hand or with devalue's own stringify to
 * exercise one decoder rule each; they are not claims about any site.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stringify } from 'devalue';

import { decodeNuxtData, readSvelteKitData } from '../src/frameworkData.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), './fixtures/embedded-state');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

const nuxtDataBlock = (html) =>
  JSON.parse(html.match(/<script[^>]*\bid="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)[1]);

describe('decodeNuxtData — nuxt.com (live)', () => {
  const parsed = nuxtDataBlock(fixture('nuxt-com-home.html'));
  const before = JSON.stringify(parsed);
  const { value, warnings } = decodeNuxtData(parsed);

  test('the raw block is index arrays; decoded, state is objects with real values', () => {
    // Raw: state is the index 1, and entry 1 is ["Reactive", 2].
    assert.equal(parsed[0].state, 1);
    assert.deepEqual(parsed[1], ['Reactive', 2]);

    assert.equal(typeof value.state, 'object');
    assert.equal(Array.isArray(value.state), false);
    assert.equal(value.state['$sstats'].repo, 'nuxt/nuxt');
    assert.equal(value.state['$sstats'].stars, 60913);
    assert.equal(value.state['$ssite-config'].name, 'Nuxt');
    assert.deepEqual(value.state['$scolor-mode'], { preference: 'dark', value: 'dark', unknown: true, forced: false });
  });

  test('Set reads as an array, devalue undefined as null, top-level fields intact', () => {
    assert.deepEqual(value.once, []);
    assert.equal(value._errors.chats, null);
    assert.equal(value.serverRendered, true);
    assert.equal(value.path, '/');
    assert.equal(value.prerenderedAt, 1790975763504);
    assert.deepEqual(warnings, []);
  });

  test('the caller\'s parsed block is not mutated, so the raw block can still be reported', () => {
    assert.equal(JSON.stringify(parsed), before);
  });
});

describe('decodeNuxtData — revivers', () => {
  test('Ref, ShallowRef, Reactive and ShallowReactive are their values', () => {
    const { value, warnings } = decodeNuxtData([
      { a: 1, b: 2, c: 3, d: 4 }, ['Ref', 5], ['ShallowRef', 5], ['Reactive', 6], ['ShallowReactive', 6], 'x', { k: 5 }
    ]);
    assert.deepEqual(value, { a: 'x', b: 'x', c: { k: 'x' }, d: { k: 'x' } });
    assert.deepEqual(warnings, []);
  });

  test('EmptyRef / EmptyShallowRef follow Nuxt: "_" → undefined, "0n" → 0, else JSON or the string', () => {
    const { value } = decodeNuxtData([
      { a: 1, b: 3, c: 5, d: 7 },
      ['EmptyRef', 2], '_',
      ['EmptyShallowRef', 4], '0n',
      ['EmptyRef', 6], '{"n":1}',
      ['EmptyShallowRef', 8], 'not json'
    ]);
    assert.deepEqual(value, { a: null, b: 0, c: { n: 1 }, d: 'not json' });
  });

  test('NuxtError is a plain object', () => {
    const { value } = decodeNuxtData([{ error: 1 }, ['NuxtError', 2], { statusCode: 3, message: 4 }, 404, 'Page not found']);
    assert.deepEqual(value, { error: { statusCode: 404, message: 'Page not found' } });
  });

  test('an unknown type decodes as its value with one warning naming it', () => {
    const { value, warnings } = decodeNuxtData([{ a: 1, b: 3 }, ['Island', 2], 'x', ['Island', 4], 'y']);
    assert.deepEqual(value, { a: 'x', b: 'y' });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\(Island\)/);
  });
});

describe('decodeNuxtData — JSON-safe conversion', () => {
  test('devalue built-ins become JSON values', () => {
    const payload = JSON.parse(stringify({
      m: new Map([['k', 'v']]),
      pairs: new Map([[1, 'a']]),
      s: new Set([1, 2]),
      d: new Date(0),
      r: /a/g,
      b: 10n,
      u: new URL('https://x.test/'),
      t: new Uint8Array([1, 2]),
      n: Object.assign(Object.create(null), { k: 1 }),
      boxed: Object(5),
      special: [undefined, NaN, Infinity, -0]
    }));
    const { value, warnings } = decodeNuxtData(payload);
    assert.deepEqual(value, {
      m: { k: 'v' },
      pairs: [[1, 'a']],
      s: [1, 2],
      d: '1970-01-01T00:00:00.000Z',
      r: '/a/g',
      b: '10',
      u: 'https://x.test/',
      t: [1, 2],
      n: { k: 1 },
      boxed: 5,
      special: [null, null, null, -0]
    });
    assert.deepEqual(warnings, []);
  });

  test('a cycle becomes { $ref } to the first occurrence\'s path', () => {
    const { value } = decodeNuxtData([{ state: 1 }, { self: 1, list: 2 }, [1]]);
    assert.deepEqual(value, { state: { self: { $ref: 'state' }, list: [{ $ref: 'state' }] } });
    assert.doesNotThrow(() => JSON.stringify(value));
  });

  test('a shared, non-cyclic object is written out at each use', () => {
    const { value } = decodeNuxtData([{ a: 1, b: 1 }, { n: 2 }, 7]);
    assert.deepEqual(value, { a: { n: 7 }, b: { n: 7 } });
  });

  test('exponential sharing is bounded: later repeats become $ref', () => {
    // Entry i is [i+1, i+1]: 2^40 leaves if every repeat were written out.
    const payload = [];
    for (let i = 0; i < 40; i++) payload.push([i + 1, i + 1]);
    payload.push('leaf');
    const started = Date.now();
    const { value, warnings } = decodeNuxtData(payload);
    assert.ok(Date.now() - started < 10_000);
    assert.ok(Array.isArray(value));
    assert.match(warnings.join(' '), /output budget/);
    assert.match(JSON.stringify(value), /\$ref/);
  });

  test('a branch nested past the depth cap is cut to null with a warning', () => {
    const payload = [];
    for (let i = 0; i < 1000; i++) payload.push([i + 1]);
    payload.push('bottom');
    const { value, warnings } = decodeNuxtData(payload);
    assert.ok(Array.isArray(value));
    assert.doesNotMatch(JSON.stringify(value), /bottom/);
    assert.match(warnings[0], /deeper than 512 levels/);
  });

  test('a sparse array with a huge declared length does not hang', () => {
    const { value, warnings } = decodeNuxtData([{ sparse: 1 }, [-7, 4294967295, 3, 2], 1]);
    assert.deepEqual(value, { sparse: { 3: 1 } });
    assert.match(warnings[0], /sparse array of declared length 4294967295/);
  });

  test('a "__proto__" key in a decoded Map stays an own data property', () => {
    const { value } = decodeNuxtData([{ m: 1 }, ['Map', 2, 3], '__proto__', { polluted: 4 }, true]);
    assert.equal(Object.getPrototypeOf(value.m), Object.prototype);
    assert.deepEqual(Object.keys(value.m), ['__proto__']);
    assert.equal({}.polluted, undefined);
  });
});

describe('decodeNuxtData — hostile input never throws', () => {
  const cases = {
    'not an array': { state: 1 },
    'empty array': [],
    'out-of-range index': [{ a: 99 }],
    'a __proto__ object key': JSON.parse('[{"__proto__":1},2]'),
    'a self-reviving reviver': [['Reactive', 0]],
    'an invalid BigInt': [{ b: 1 }, ['BigInt', 'nope']],
    'an ArrayBuffer that is not base64': [{ t: 1 }, ['Uint8Array', 2], ['ArrayBuffer', 5]]
  };
  for (const [name, payload] of Object.entries(cases)) {
    test(name, () => {
      const result = decodeNuxtData(payload);
      assert.equal(result.value, null);
      assert.equal(result.warnings.length, 1);
    });
  }

  test('a 200k-long reference chain returns a warning, not a stack overflow', () => {
    const payload = [];
    for (let i = 0; i < 200_000; i++) payload.push([i + 1]);
    payload.push(1);
    const result = decodeNuxtData(payload);
    assert.ok(result.warnings.length >= 1);
  });
});

describe('readSvelteKitData — svelte.dev (live)', () => {
  test('home: both route nodes, with layout data evaluated', () => {
    const result = readSvelteKitData(fixture('svelte-dev-home.html'));
    assert.notEqual(result, null);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.value.length, 2);
    const [layout, page] = result.value;
    assert.equal(layout.type, 'data');
    assert.equal(layout.data.nav_links[0].title, 'Docs');
    assert.ok(layout.data.nav_links.length > 0);
    // devalue.uneval's new Date(…) reads as an ISO string.
    assert.equal(layout.data.banner.start, '2026-08-01T00:00:00.000Z');
    assert.equal(page, null);
  });

  test('blog: the page node carries the post list', () => {
    const result = readSvelteKitData(fixture('svelte-dev-blog.html'));
    assert.deepEqual(result.warnings, []);
    const posts = result.value[1].data.posts;
    assert.ok(posts.length > 0);
    assert.equal(posts.at(-1).slug, 'blog/frameworks-without-the-framework');
    assert.equal(posts.at(-1).metadata.author, 'Rich Harris');
  });

  test('a page without a SvelteKit boot script returns null', () => {
    assert.equal(readSvelteKitData(fixture('nuxt-com-home.html')), null);
    assert.equal(readSvelteKitData('<html><script>kit.start(a, b, { data: [1] })</script></html>'), null);
  });
});

describe('readSvelteKitData — shapes and refusals', () => {
  const boot = (start) => `<script>
    __sveltekit_abc123 = { base: "" };
    const element = document.currentScript.parentElement;
    ${start}
  </script>`;

  test('the Promise.all([...]).then(([kit, app]) => …) form (SvelteKit source, not a capture)', () => {
    const result = readSvelteKitData(boot(
      'Promise.all([import("a.js"), import("b.js")]).then(([kit, app]) => { kit.start(app, element, { node_ids: [0, 2], data: [null, {type:"data",data:{n:1}}], form: null, error: null }); });'
    ));
    assert.deepEqual(result, { value: [null, { type: 'data', data: { n: 1 } }], warnings: [] });
  });

  test('a refused entry is null with a warning naming its index; the rest survive', () => {
    const result = readSvelteKitData(boot(
      'kit.start(app, element, { data: [{type:"data",data:{a:1}}, {type:"data",data:fetchIt()}] });'
    ));
    assert.deepEqual(result.value, [{ type: 'data', data: { a: 1 } }, null]);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /data\[1\].*function call/);
  });

  test('data that is not an array literal is evaluated whole', () => {
    const result = readSvelteKitData(boot('kit.start(app, element, { data: (function(a){return [a,a]}({x:1})) });'));
    assert.deepEqual(result.value, [{ x: 1 }, { x: 1 }]);
  });

  test('a boot script with no locatable kit.start data says so', () => {
    const result = readSvelteKitData(boot('kit.start(app, element);'));
    assert.equal(result.value, null);
    assert.match(result.warnings[0], /could not be located/);
  });

  test('a commented-out boot script is ignored', () => {
    assert.equal(readSvelteKitData(`<!-- ${boot('kit.start(app, element, { data: [1] });')} -->`), null);
  });
});
