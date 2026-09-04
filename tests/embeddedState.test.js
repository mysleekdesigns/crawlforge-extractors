/**
 * The embedded-state reader (src/embeddedState.js).
 *
 * Run: node --test tests/embeddedState.test.js
 *
 * The fixtures under tests/fixtures/embedded-state/ are condensed from live
 * captures taken on 2026-08-29; each file's own comment records its source URL,
 * the curl that fetched it and exactly what was trimmed.
 *
 * The three sources with a verified live target are covered by those fixtures.
 * __APOLLO_STATE__, __INITIAL_STATE__ and __PRELOADED_STATE__ share one
 * assignment reader with __NUXT__ (proven on the elk.zone capture); the
 * assertions below are name-table checks on that shared reader, not claims
 * about any particular site.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { extractEmbeddedState } from '../src/embeddedState.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), './fixtures/embedded-state');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

const byName = (found, name) => found.find((entry) => entry.name === name);

describe('__NEXT_DATA__ (Ticketmaster)', () => {
  const { data, found, warnings } = extractEmbeddedState(fixture('ticketmaster-next-data.html'));

  test('returns a parsed object, not a string', () => {
    assert.equal(typeof data.next_data, 'object');
    assert.equal(data.next_data.buildId, 'KfC_3GF1zuM-t3vA0Rtwl');
    assert.equal(data.next_data.page, '/major-category');
  });

  test('the event data survives with its exact values', () => {
    const [event] = data.next_data.props.pageProps.eventsJsonLD[0];
    assert.equal(event['@type'], 'MusicEvent');
    assert.equal(event.name, 'Remember When - The Ultimate Tribute to Alan Jackson');
  });

  test('reports the source under its raw variable name and its size', () => {
    assert.deepEqual(byName(found, 'next_data'), {
      name: 'next_data',
      variable: '__NEXT_DATA__',
      bytes: Buffer.byteLength(JSON.stringify(data.next_data))
    });
    assert.deepEqual(warnings, []);
  });

  test('is not also reported as a json_scripts block — that would double it', () => {
    assert.equal(data.json_scripts, undefined);
    assert.equal(found.length, 1);
  });
});

describe('RSC flight stream (Healthgrades)', () => {
  const { data, found, warnings } = extractEmbeddedState(fixture('healthgrades-rsc.html'));
  const rows = data.next_f;

  test('38 push chunks become one stream of 71 parsed rows', () => {
    assert.equal(Object.keys(rows).length, 71);
    assert.match(byName(found, 'next_f').note, /38 RSC flight chunks .* 71 rows/);
    assert.equal(byName(found, 'next_f').variable, 'self.__next_f');
    assert.deepEqual(warnings, []);
  });

  test('a JSON row is an object with the page\'s own values', () => {
    assert.equal(rows['0'].b, 'ZSUDKJ6Jvldk6iBn3J7Fo');
    assert.equal(rows['0'].p, '/hg-provider-search-app');
    assert.deepEqual(rows['0'].c, ['', 'cardiology-directory']);
  });

  test('the metadata row carries the real title and canonical URL', () => {
    const flat = JSON.stringify(rows['9'].metadata);
    assert.match(flat, /20 Best Cardiologists Near Me \| Healthgrades/);
    assert.match(flat, /https:\/\/www\.healthgrades\.com\/cardiology-directory/);
  });

  test('a T row is consumed by byte length across chunk boundaries', () => {
    // Row 19 is declared "19:T7ad," (1,965 bytes) in one chunk and finishes two
    // chunks later. A short read would truncate it; a long read would swallow
    // the row after it.
    assert.equal(typeof rows['19'], 'string');
    assert.equal(Buffer.byteLength(rows['19']), 1965);
  });

  test('the row after a T blob keeps its full id', () => {
    // The blob's declared length includes the row's terminating newline.
    // Skipping one more character reads "14" as "4" and overwrites row 4 —
    // which is a module reference, so the corruption is silent.
    assert.ok('14' in rows, 'row 14 must survive the T blob that precedes it');
    assert.equal(rows['14'][1], 'div');
    assert.match(rows['4'], /^I\[/);
  });

  test('module references are kept as raw strings, not dropped', () => {
    assert.equal(rows['3'], 'I[85341,[],""]');
  });
});

describe('RSC flight stream — many text rows (DoS regression)', () => {
  // A page controls its own flight stream via self.__next_f.push([...]). A
  // stream of many small text ("T") rows used to re-slice the whole remaining
  // stream on every row — O(N^2) — so a ~megabyte of tiny rows could pin a CPU.
  // Each T row's declared length includes its terminating newline, so the rows
  // concatenate directly with no separator.
  const ROW_COUNT = 40000;
  const blob = 'x\n'; // 2 bytes, newline included in the declared length
  const stream = Array.from(
    { length: ROW_COUNT },
    (_, i) => `${i}:T${(2).toString(16)},${blob}`
  ).join('');
  const html = `<!doctype html><html><body><script>self.__next_f.push([1,${JSON.stringify(stream)}])</script></body></html>`;

  const started = Date.now();
  const { data } = extractEmbeddedState(html);
  const elapsedMs = Date.now() - started;

  test('every text row is decoded, and the newline stays inside the blob', () => {
    assert.equal(Object.keys(data.next_f).length, ROW_COUNT);
    assert.equal(data.next_f['0'], blob);
    assert.equal(data.next_f[String(ROW_COUNT - 1)], blob);
  });

  test('parsing stays linear (a re-slice-per-row regression would blow this bound)', () => {
    // The fixed path handles this input in well under 300ms; the O(N^2) version
    // takes many seconds. The 3s ceiling is generous enough not to flake on a
    // loaded machine while still catching a reintroduced full-tail slice.
    assert.ok(elapsedMs < 3000, `parsed ${ROW_COUNT} text rows in ${elapsedMs}ms`);
  });
});

describe('Nuxt (elk.zone)', () => {
  const { data, found, warnings } = extractEmbeddedState(fixture('elk-zone-nuxt.html'));

  test('window.__NUXT__ is reported, and the empty assignment is called out', () => {
    assert.deepEqual(data.nuxt, {});
    assert.equal(byName(found, 'nuxt').variable, '__NUXT__');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /__NUXT__ is present but assigned an empty object/);
  });

  test('the real payload comes back as a json_scripts block, with its id', () => {
    assert.equal(data.json_scripts.length, 1);
    assert.equal(data.json_scripts[0].id, '__NUXT_DATA__');
    assert.equal(data.json_scripts[0].data[0][0], 'ShallowReactive');
  });
});

describe('the shared assignment reader', () => {
  const wrap = (script) => `<html><body><script>${script}</script></body></html>`;

  for (const [variable, name] of [
    ['__APOLLO_STATE__', 'apollo_state'],
    ['__INITIAL_STATE__', 'initial_state'],
    ['__PRELOADED_STATE__', 'preloaded_state'],
    ['__preloadedData', 'preloaded_data']
  ]) {
    test(`${variable} is read into "${name}"`, () => {
      const { data, found } = extractEmbeddedState(wrap(`window.${variable} = {"a":{"b":1}};`));
      assert.deepEqual(data[name], { a: { b: 1 } });
      assert.equal(byName(found, name).variable, variable);
    });
  }

  test('bare undefined values are read as null and counted (nytimes __preloadedData)', () => {
    const { data, found, warnings } = extractEmbeddedState(
      wrap('window.__preloadedData = {"loaderData":{"assets":undefined,"list":[undefined,1],"note":"undefined stays in a string"}};')
    );
    assert.deepEqual(data.preloaded_data, { loaderData: { assets: null, list: [null, 1], note: 'undefined stays in a string' } });
    assert.equal(byName(found, 'preloaded_data').note, '2 bare undefined value(s) read as null');
    assert.equal(warnings.length, 0);
  });

  test('a self. or bare prefix is read the same way', () => {
    assert.deepEqual(extractEmbeddedState(wrap('self.__INITIAL_STATE__={"a":1}')).data.initial_state, { a: 1 });
    assert.deepEqual(extractEmbeddedState(wrap('var __INITIAL_STATE__ = {"a":2}')).data.initial_state, { a: 2 });
  });

  test('a value that is not JSON is reported as unparsed, never guessed at', () => {
    const { data, found, warnings } = extractEmbeddedState(
      wrap('window.__NUXT__=(function(a){return {x:a}}(1))')
    );
    assert.equal(data.nuxt, undefined);
    assert.equal(found.length, 0);
    assert.match(warnings[0], /not a JSON literal/);
  });

  test('braces inside strings do not end the payload early', () => {
    const { data } = extractEmbeddedState(wrap('window.__APOLLO_STATE__={"a":"}}}","b":2}'));
    assert.deepEqual(data.apollo_state, { a: '}}}', b: 2 });
  });

  test('a longer identifier ending in the same name is not matched', () => {
    const { found } = extractEmbeddedState(wrap('window.MY__INITIAL_STATE__={"a":1}'));
    assert.equal(found.length, 0);
  });
});

describe('json script blocks', () => {
  test('an unparseable block is skipped with a warning, not silently', () => {
    const { data, warnings } = extractEmbeddedState(
      '<script type="application/json" id="broken">{oops</script>'
    );
    assert.equal(data.json_scripts, undefined);
    assert.match(warnings[0], /id="broken".*not valid JSON/);
  });

  test('ld+json is left to extract_metadata', () => {
    const { found } = extractEmbeddedState(
      '<script type="application/ld+json">{"@type":"Product"}</script>'
    );
    assert.equal(found.length, 0);
  });

  test('a commented-out script neither counts nor hides the real one', () => {
    const { data, found, warnings } = extractEmbeddedState(
      '<!-- <script type="application/json">not json</script> -->' +
      '<script type="application/json" id="real">{"ok":true}</script>'
    );
    assert.deepEqual(warnings, []);
    assert.equal(found.length, 1);
    assert.deepEqual(data.json_scripts, [{ id: 'real', data: { ok: true } }]);
  });
});

describe('a page with no embedded state', () => {
  test('returns nothing found rather than an empty-looking success', () => {
    const { data, found, warnings } = extractEmbeddedState('<html><body><h1>hi</h1></body></html>');
    assert.deepEqual(data, {});
    assert.deepEqual(found, []);
    assert.deepEqual(warnings, []);
  });
});

describe('Apollo streaming-SSR transport (Product Hunt)', () => {
  // (window[Symbol.for("ApolloSSRDataTransport")] ??= []).push({...}) — the
  // data layer on producthunt.com product pages, whose RSC flight stream is a
  // near-empty shell. The pushed literal is JSON except for bare `undefined`
  // values on still-streaming fields.
  const page = (payload) =>
    `<html><body><script>(window[Symbol.for("ApolloSSRDataTransport")] ??= []).push(${payload})</script></body></html>`;

  test('a push is parsed and reported, with undefined healed to null', () => {
    const { data, found } = extractEmbeddedState(
      page('{"rehydrate":{"_R_1":{"data":undefined,"loading":true},"_R_2":{"data":{"product":{"name":"ChatGPT"}}}}}')
    );
    assert.equal(data.apollo_ssr_transport.length, 1);
    const push = data.apollo_ssr_transport[0];
    assert.equal(push.rehydrate._R_1.data, null, 'streaming placeholder healed to null');
    assert.equal(push.rehydrate._R_2.data.product.name, 'ChatGPT');
    const entry = found.find(f => f.name === 'apollo_ssr_transport');
    assert.match(entry.variable, /ApolloSSRDataTransport/);
    assert.match(entry.note, /1 streaming-SSR push/);
  });

  test('the word undefined inside a string value is never rewritten', () => {
    const { data } = extractEmbeddedState(page('{"a":"result was undefined","b":undefined}'));
    assert.equal(data.apollo_ssr_transport[0].a, 'result was undefined');
    assert.equal(data.apollo_ssr_transport[0].b, null);
  });

  test('multiple pushes arrive in document order', () => {
    const html =
      '<script>(window[Symbol.for("ApolloSSRDataTransport")] ??= []).push({"n":1})</script>' +
      '<script>(window[Symbol.for("ApolloSSRDataTransport")] ??= []).push({"n":2})</script>';
    const { data } = extractEmbeddedState(html);
    assert.deepEqual(data.apollo_ssr_transport.map(p => p.n), [1, 2]);
  });

  test('a push that is not JSON even after healing is skipped, not fatal', () => {
    const html = page('{broken') + page('{"ok":true}');
    const { data } = extractEmbeddedState(html);
    assert.deepEqual(data.apollo_ssr_transport, [{ ok: true }]);
  });
});
