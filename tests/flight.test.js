/**
 * RSC flight streams (src/flight.js): row parsing, reference resolution and
 * the data-row index.
 *
 * Run: node --test tests/flight.test.js
 *
 * The Healthgrades fixture is the live capture described in its own header
 * comment (tests/fixtures/embedded-state/healthgrades-rsc.html). The in-row
 * path references (`$10:1:2:props:providerModel` inside row 10) are the shape
 * a live Healthgrades provider page uses (captured 2026-10-03); the synthetic
 * rows below reproduce that shape.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseFlightRows, resolveFlightRows, flightDataRows } from '../src/flight.js';
import { extractEmbeddedState } from '../src/embeddedState.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), './fixtures/embedded-state');
const html = readFileSync(join(FIXTURES, 'healthgrades-rsc.html'), 'utf8');

// The same concatenation embeddedState.js performs on self.__next_f pushes.
const flightStream = (page) => {
  const re = /self\.__next_f\.push\(\s*\[\s*1\s*,\s*("(?:[^"\\]|\\.)*")/g;
  let stream = '';
  let match;
  while ((match = re.exec(page)) !== null) stream += JSON.parse(match[1]);
  return stream;
};

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

describe('parseFlightRows (Healthgrades)', () => {
  const rows = parseFlightRows(flightStream(html));

  test('extractEmbeddedState reports these rows, references resolved', () => {
    assert.equal(Object.keys(rows).length, 71);
    assert.deepEqual(resolveFlightRows(rows).rows, extractEmbeddedState(html).data.next_f);
  });

  test('a JSON row is parsed', () => {
    assert.equal(rows['0'].b, 'ZSUDKJ6Jvldk6iBn3J7Fo');
    assert.deepEqual(rows['0'].c, ['', 'cardiology-directory']);
  });

  test('a T row is consumed by UTF-8 byte length across chunk boundaries', () => {
    assert.equal(typeof rows['19'], 'string');
    assert.equal(Buffer.byteLength(rows['19']), 1965);
  });

  test('the row after a T blob keeps its full id', () => {
    assert.ok('14' in rows);
    assert.equal(rows['14'][1], 'div');
    assert.match(rows['4'], /^I\[/);
  });

  test('module references stay raw strings', () => {
    assert.equal(rows['3'], 'I[85341,[],""]');
  });
});

describe('parseFlightRows (row shapes)', () => {
  test('an E row parses to { $error }', () => {
    const rows = parseFlightRows('1:E{"digest":"123","message":"boom"}\n2:{"a":1}\n');
    assert.deepEqual(rows['1'], { $error: { digest: '123', message: 'boom' } });
    assert.deepEqual(rows['2'], { a: 1 });
  });

  test('an E row that is not JSON stays the raw payload', () => {
    assert.equal(parseFlightRows('1:E{oops\n')['1'], 'E{oops');
  });

  test('HL and I rows stay raw strings', () => {
    const rows = parseFlightRows('1:HL["/a.css","style"]\n2:I[1,[],""]\n');
    assert.equal(rows['1'], 'HL["/a.css","style"]');
    assert.equal(rows['2'], 'I[1,[],""]');
  });

  test('a line that is not a row start is skipped and parsing resyncs', () => {
    const rows = parseFlightRows('garbage\n1:[1]\n');
    assert.deepEqual(rows, { 1: [1] });
  });

  test('many text rows parse in linear time', () => {
    const count = 40000;
    const stream = Array.from({ length: count }, (_, i) => `${i.toString(16)}:T2,x\n`).join('');
    const started = Date.now();
    const rows = parseFlightRows(stream);
    assert.equal(Object.keys(rows).length, count);
    assert.equal(rows['0'], 'x\n');
    assert.ok(Date.now() - started < 3000);
  });
});

describe('resolveFlightRows', () => {
  test('a $<hex> reference is replaced by the referenced row', () => {
    const { rows, resolved } = resolveFlightRows({ 1: { price: 9 }, 2: { item: '$1' } });
    assert.deepEqual(rows['2'], { item: { price: 9 } });
    assert.equal(resolved, 1);
  });

  test('a $@<hex> promise reference is replaced the same way', () => {
    const { rows } = resolveFlightRows({ a: [1, 2], b: { data: '$@a' } });
    assert.deepEqual(rows.b, { data: [1, 2] });
  });

  test('a property path walks into the referenced row', () => {
    const { rows } = resolveFlightRows({ 1: { a: { b: [10, 20] } }, 2: ['$1:a:b:1', '$1:a'] });
    assert.deepEqual(rows['2'], [20, { b: [10, 20] }]);
  });

  test('a property path names an element tuple\'s fields as React does', () => {
    const { rows } = resolveFlightRows({
      5: ['$', 'div', 'k', { pageData: { id: 7 } }],
      6: ['$5:props:pageData', '$5:type', '$5:key']
    });
    assert.deepEqual(rows['6'], [{ id: 7 }, 'div', 'k']);
  });

  test('a path that does not resolve stays the original string', () => {
    const { rows, resolved } = resolveFlightRows({ 1: { a: 1 }, 2: ['$1:missing', '$1:a:deeper'] });
    assert.deepEqual(rows['2'], ['$1:missing', '$1:a:deeper']);
    assert.equal(resolved, 0);
  });

  test('a reference to an unknown row stays the original string', () => {
    const { rows } = resolveFlightRows({ 1: ['$ff', '$@ff'] });
    assert.deepEqual(rows['1'], ['$ff', '$@ff']);
  });

  test('a reference to an I or T string row stays a reference (markup, not data)', () => {
    const rows = parseFlightRows('1:I[1,[],"X"]\n2:T3,abc3:["$1","$2"]\n');
    const { rows: out, resolved } = resolveFlightRows(rows);
    assert.deepEqual(out['3'], ['$1', '$2']);
    assert.equal(resolved, 0);
  });

  test('$$ is unescaped to a literal $', () => {
    const { rows } = resolveFlightRows({ 1: { price: '$$12.99', note: '$$1' } });
    assert.deepEqual(rows['1'], { price: '$12.99', note: '$1' });
  });

  test('other $ tokens and the element marker are left untouched', () => {
    const tokens = ['$', '$L1', '$S', '$Sreact.fragment', '$F1', '$Q1', '$W1', '$D2024-01-01', '$n12', '$u',
      '$undefined', '$B1', '$E', '$Z', '$I', '$-0', '$NaN', '$K1', '$T1', '$i'];
    const { rows, resolved } = resolveFlightRows({ 1: { x: 1 }, 2: tokens, 3: ['$', '$L1', null, {}] });
    assert.deepEqual(rows['2'], tokens);
    assert.deepEqual(rows['3'], ['$', '$L1', null, {}]);
    assert.equal(resolved, 0);
  });

  test('a top-level string row that is a reference resolves (Healthgrades row e)', () => {
    const raw = parseFlightRows(flightStream(html));
    assert.equal(raw.e, '$9:metadata');
    const { rows } = resolveFlightRows(raw);
    assert.deepEqual(rows.e, raw['9'].metadata);
  });

  test('a top-level string row is never unescaped', () => {
    assert.equal(resolveFlightRows({ 1: '$$x' }).rows['1'], '$$x');
  });

  test('an in-row path reference resolves to the earlier part of the same row', () => {
    // React dedupes an object it already wrote in this row as a path to it.
    const { rows, resolved, cycles } = resolveFlightRows({
      10: [{ model: { name: 'Dr. A' } }, { again: '$10:0:model' }]
    });
    assert.deepEqual(rows['10'], [{ model: { name: 'Dr. A' } }, { again: { name: 'Dr. A' } }]);
    assert.equal(resolved, 1);
    assert.equal(cycles, 0);
  });

  test('an in-row reference to its own enclosing container is a cycle', () => {
    const { rows, cycles } = resolveFlightRows({ 4: { a: { self: '$4:a' }, b: '$4' } });
    assert.deepEqual(rows['4'], { a: { self: { $ref: '4' } }, b: { $ref: '4' } });
    assert.equal(cycles, 2);
  });

  test('rows that reference each other become { $ref } where they recur', () => {
    const { rows, cycles } = resolveFlightRows({ 1: { next: '$2' }, 2: { next: '$1' } });
    assert.deepEqual(rows['1'], { next: { next: { $ref: '1' } } });
    assert.deepEqual(rows['2'], { next: { $ref: '1' } });
    assert.equal(cycles, 1);
    assert.doesNotThrow(() => JSON.stringify(rows));
  });

  test('a row that references itself directly is a cycle', () => {
    assert.deepEqual(resolveFlightRows({ 7: { self: '$7' } }).rows['7'], { self: { $ref: '7' } });
  });

  test('a doubling chain stays within the budget instead of going exponential', () => {
    // row n = [$n-1, $n-1]: unbounded resolution would serialize 2^60 leaves.
    const input = { 0: ['x'.repeat(100)] };
    for (let n = 1; n <= 60; n++) input[n.toString(16)] = [`$${(n - 1).toString(16)}`, `$${(n - 1).toString(16)}`];
    const started = Date.now();
    const { rows, overBudget, resolved } = resolveFlightRows(input);
    assert.ok(Date.now() - started < 1000);
    assert.ok(overBudget > 0);
    assert.ok(resolved > 0);
    assert.ok(bytes(rows) <= 2 * bytes(input), `${bytes(rows)} > 2 x ${bytes(input)}`);
  });

  test('an explicit budget is honoured: Infinity inlines everything, 0 inlines nothing that grows', () => {
    const input = { 0: ['leaf'], 1: ['$0', '$0'], 2: ['$1', '$1'] };
    const all = resolveFlightRows(input, { budgetBytes: Infinity });
    assert.deepEqual(all.rows['2'], [[['leaf'], ['leaf']], [['leaf'], ['leaf']]]);
    assert.equal(all.overBudget, 0);

    const none = resolveFlightRows(input, { budgetBytes: 0 });
    assert.deepEqual(none.rows['2'], ['$1', '$1']);
    assert.equal(none.resolved, 0);
    assert.equal(none.overBudget, 4);
  });

  test('a 100k-long reference chain needs no call stack', () => {
    const input = { 0: { end: true } };
    for (let n = 1; n < 100000; n++) input[n.toString(16)] = { prev: `$${(n - 1).toString(16)}` };
    const { rows } = resolveFlightRows(input, { budgetBytes: Infinity });
    assert.equal(rows[(99999).toString(16)].prev.prev.prev !== undefined, true);
  });

  test('a 100k-deep row resolves without overflowing', () => {
    let deep = '$1';
    for (let i = 0; i < 100000; i++) deep = [deep];
    const { rows, resolved } = resolveFlightRows({ 1: { ok: true }, 2: deep });
    let node = rows['2'];
    while (Array.isArray(node)) node = node[0];
    assert.deepEqual(node, { ok: true });
    assert.equal(resolved, 1);
  });

  test('the input rows are not modified, and a __proto__ key stays an own key', () => {
    const input = JSON.parse('{"1":{"a":"$2","__proto__":{"x":1}},"2":{"b":2}}');
    const snapshot = JSON.stringify(input);
    const { rows } = resolveFlightRows(input);
    assert.equal(JSON.stringify(input), snapshot);
    assert.ok(Object.hasOwn(rows['1'], '__proto__'));
    assert.equal(Object.getPrototypeOf(rows['1']), Object.prototype);
    assert.deepEqual(rows['1'].a, { b: 2 });
  });

  test('keeps the input\'s row order', () => {
    const { rows } = resolveFlightRows({ b: '$a', a: [1], 1: [2] });
    assert.deepEqual(Object.keys(rows), ['1', 'b', 'a']);
  });

  test('non-object input returns an empty result', () => {
    assert.deepEqual(resolveFlightRows(null), { rows: {}, resolved: 0, cycles: 0, overBudget: 0 });
  });

  test('Healthgrades fixture: every reachable reference resolves within budget', () => {
    const raw = parseFlightRows(flightStream(html));
    const { rows, resolved, cycles, overBudget } = resolveFlightRows(raw);
    // 3, not 11: the other 8 point at string rows (T text, I modules,
    // $Sreact.fragment), which stay references.
    assert.deepEqual({ resolved, cycles, overBudget }, { resolved: 3, cycles: 0, overBudget: 0 });
    assert.ok(bytes(rows) <= 2 * bytes(raw));
    // Row 5, the target of its "$5:0:0:props:…" references, was trimmed from
    // the capture, so those stay strings.
    assert.match(JSON.stringify(rows), /"\$5:0:0:props:children:props:pageData:adTargets"/);
  });
});

describe('flightDataRows', () => {
  const element = (type) => ['$', type, null, { children: 'x' }];

  test('ranks object and array rows by size, skipping markup and strings', () => {
    const rows = {
      1: 'I[1,[],""]',
      2: element('div'),
      3: [element('a'), element('b')],
      4: ['$L5', element('main'), false, null],
      5: { small: 1 },
      6: [{ sku: 'A1', price: 10 }, { sku: 'B2', price: 20 }],
      7: null,
      8: 42
    };
    const index = flightDataRows(rows);
    assert.deepEqual(index.map((row) => row.id), ['6', '5']);
    assert.deepEqual(index[0], { id: '6', bytes: bytes(rows['6']), keys: null, length: 2 });
    assert.deepEqual(index[1], { id: '5', bytes: bytes(rows['5']), keys: ['small'], length: null });
  });

  test('lists at most 20 first-level keys', () => {
    const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    assert.equal(flightDataRows({ 1: wide })[0].keys.length, 20);
  });

  test('an empty array and an array of plain values are data', () => {
    assert.deepEqual(flightDataRows({ 1: [], 2: ['a', 'b'] }).map((row) => row.id).sort(), ['1', '2']);
  });

  test('bytes are the serialized size even when subtrees are shared', () => {
    const { rows } = resolveFlightRows({ 1: { v: 'x'.repeat(50) }, 2: { a: '$1', b: '$1' } }, { budgetBytes: Infinity });
    const entry = flightDataRows(rows).find((row) => row.id === '2');
    assert.equal(entry.bytes, bytes(rows['2']));
  });

  test('Healthgrades fixture: the router state and the metadata row', () => {
    const index = flightDataRows(parseFlightRows(flightStream(html)));
    assert.deepEqual(index.map((row) => row.id), ['0', '9']);
    assert.deepEqual(index[1].keys, ['metadata', 'error', 'digest']);
  });

  test('non-object input returns an empty index', () => {
    assert.deepEqual(flightDataRows(undefined), []);
  });
});
