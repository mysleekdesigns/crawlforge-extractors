/**
 * Key discovery for extract_embedded_state's `find` parameter
 * (src/jsonFind.js). Every reported path must read back through
 * selectJsonPath — the tests check that for each match.
 *
 * Run: node --test tests/jsonFind.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { findJsonPaths } from '../src/jsonFind.js';
import { selectJsonPath } from '../src/jsonPath.js';
import { extractEmbeddedState } from '../src/embeddedState.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), './fixtures/embedded-state');

const assertRoundTrips = (root, result) => {
  for (const match of result.matches) {
    if (match.addressable === false) continue;
    const value = selectJsonPath(root, match.path);
    assert.equal(match.preview, JSON.stringify(value).slice(0, 200), match.path);
  }
};

describe('findJsonPaths', () => {
  const root = {
    page: {
      Specialty: 'Cardiology',
      providers: [
        { name: 'A', specialty: { code: 'PS127', label: 'Cardiology' } },
        { name: 'B', specialty: 'Electrophysiology' }
      ]
    },
    specialty: null
  };

  test('finds every key case-insensitively, in document order, and each path round-trips', () => {
    const result = findJsonPaths(root, 'specialty');
    assert.deepEqual(result.matches.map((m) => m.path), [
      'page.Specialty',
      'page.providers.0.specialty',
      'page.providers.1.specialty',
      'specialty'
    ]);
    assert.equal(result.total, 4);
    assert.equal(result.truncated, false);
    assertRoundTrips(root, result);
  });

  test('a match nested inside a match is reported after it', () => {
    const nested = { a: { tag: { tag: 1 } } };
    assert.deepEqual(findJsonPaths(nested, 'tag').matches.map((m) => m.path), ['a.tag', 'a.tag.tag']);
  });

  test('array indexes are not keys', () => {
    assert.equal(findJsonPaths({ list: ['x', 'y'] }, '0').total, 0);
  });

  test('preview is the first previewChars characters of the value\'s JSON', () => {
    const values = {
      long: 'é'.repeat(500),
      tree: { a: [1, 'two', null, true, { deep: 'x'.repeat(300) }], b: undefined, c: 3 },
      list: [undefined, 1.5, -0, 'q"uote'],
      emoji: '😀'.repeat(150),
      empty: {}
    };
    for (const [name, value] of Object.entries(values)) {
      const { matches } = findJsonPaths({ [name]: value }, name);
      assert.equal(matches[0].preview, JSON.stringify(value).slice(0, 200), name);
    }
    const short = findJsonPaths({ k: { a: 'abcdef' } }, 'k', { previewChars: 7 });
    assert.equal(short.matches[0].preview, '{"a":"a');
  });

  test('keys the path syntax cannot spell are reported with addressable: false', () => {
    const odd = { 'a.b': { id: 1 }, 'x[0]': { id: 2 }, '': { id: 3 }, 'c]': { id: 4 }, ok: { id: 5 } };
    const result = findJsonPaths(odd, 'id');
    assert.deepEqual(
      result.matches.map((m) => [m.path, m.addressable]),
      [['a.b.id', false], ['x[0].id', false], ['.id', false], ['c].id', undefined], ['ok.id', undefined]]
    );
    assertRoundTrips(odd, result);

    const direct = findJsonPaths({ 'odd.key': 1 }, 'odd.key');
    assert.equal(direct.matches[0].addressable, false);
  });

  test('limit caps the matches; total keeps counting; truncated says so', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ id: i }));
    const result = findJsonPaths(many, 'id');
    assert.equal(result.matches.length, 50);
    assert.equal(result.total, 120);
    assert.equal(result.truncated, true);
    assert.equal(result.matches[49].path, '49.id');
    assertRoundTrips(many, result);

    const three = findJsonPaths(many, 'id', { limit: 3 });
    assert.deepEqual(three.matches.map((m) => m.path), ['0.id', '1.id', '2.id']);
  });

  test('stops at maxNodes and reports truncation', () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const result = findJsonPaths(many, 'id', { maxNodes: 100 });
    assert.equal(result.truncated, true);
    assert.ok(result.total < 1000);
  });

  test('cyclic input does not loop; its preview is bounded', () => {
    const a = { name: 'a' };
    a.self = a;
    a.list = [a];
    const result = findJsonPaths({ root: a }, 'self');
    assert.deepEqual(result.matches.map((m) => m.path), ['root.self']);
    assert.ok(result.matches[0].preview.length <= 200);
    assert.ok(result.matches[0].preview.startsWith('{"name":"a","self":{"name":"a"'));
  });

  test('a shared subtree is walked once, at its first path', () => {
    const shared = { price: 10 };
    const result = findJsonPaths({ a: shared, b: shared }, 'price');
    assert.deepEqual(result.matches.map((m) => m.path), ['a.price']);
  });

  test('a 100k-deep payload is walked without overflowing', () => {
    let deep = { needle: 'found' };
    for (let i = 0; i < 100000; i++) deep = { n: deep };
    const result = findJsonPaths(deep, 'needle');
    assert.equal(result.total, 1);
    assert.equal(result.matches[0].preview, '"found"');
    assert.equal(result.matches[0].path.split('.').length, 100001);
  });

  test('a non-object root or a non-string key finds nothing', () => {
    assert.deepEqual(findJsonPaths('text', 'a'), { matches: [], total: 0, truncated: false });
    assert.deepEqual(findJsonPaths(null, 'a'), { matches: [], total: 0, truncated: false });
    assert.deepEqual(findJsonPaths({ a: 1 }, undefined), { matches: [], total: 0, truncated: false });
  });
});

describe('findJsonPaths on Healthgrades (plan 4.4 verify)', () => {
  const { data } = extractEmbeddedState(readFileSync(join(FIXTURES, 'healthgrades-rsc.html'), 'utf8'));

  test('find "specialty" returns paths that path: then resolves in one more call', () => {
    const result = findJsonPaths(data, 'specialty');
    assert.ok(result.total >= 1);
    assert.equal(result.matches[0].path, 'next_f.33.2.3.children.3.children.0.0.3.specialty');
    assert.equal(selectJsonPath(data, result.matches[0].path), 'Cardiology');
    assert.ok(result.matches.every((m) => m.addressable === undefined));
    assertRoundTrips(data, result);
  });
});
