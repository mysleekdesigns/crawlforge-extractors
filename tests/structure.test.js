/**
 * Unit tests: structural signatures.
 *
 * Run: node --test tests/structure.test.js
 *
 * The depth half of this score used to compare nothing — `hierarchy` was
 * initialised to {} and never written, so its comparison reduced to
 * `0 === 0` and returned a constant 1. That pinned every score at
 * (tagSimilarity + 1) / 2, so no page could ever score below 0.5 however
 * completely its structure had been rebuilt. The "collapsed" cases below are
 * the ones that were unreachable before.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { structureSignature, structuralSimilarity } from '../src/structure.js';

const sig = (html) => structureSignature(cheerio.load(html));

const NESTED = `<html><body>
  <div><div><div><p>a</p><p>b</p><p>c</p></div></div></div>
</body></html>`;

// The same tag vocabulary — html, body, div, p — laid out flat instead.
const FLAT = `<html><body>
  <div></div><div></div><div></div><p>a</p><p>b</p><p>c</p>
</body></html>`;

describe('structureSignature', () => {
  test('collects a sorted, de-duplicated tag vocabulary', () => {
    const { tags } = sig('<html><body><p>a</p><p>b</p><div><span>c</span></div></body></html>');
    // head is in the list because the parser inserts one, exactly as a browser
    // does — both sides of any comparison are parsed the same way.
    assert.deepEqual(tags, ['body', 'div', 'head', 'html', 'p', 'span']);
  });

  test('counts elements by nesting depth', () => {
    // html at depth 1 (the document node is its parent), head and body at 2,
    // the two paragraphs at 3.
    const { depths } = sig('<html><body><p>a</p><p>b</p></body></html>');
    assert.deepEqual(depths, { 1: 1, 2: 2, 3: 2 });
  });

  test('is stable across identical documents', () => {
    assert.deepEqual(sig(NESTED), sig(NESTED));
  });

  test('stays small on a repetitive page', () => {
    const rows = '<tr><td>x</td></tr>'.repeat(500);
    const { tags, depths } = sig(`<html><body><table><tbody>${rows}</tbody></table></body></html>`);
    // 1000 elements reduce to a handful of keys — this is what makes the
    // signature cheap enough to store next to a baseline.
    assert.ok(tags.length < 10, `tags: ${tags.length}`);
    assert.ok(Object.keys(depths).length < 10, `depths: ${Object.keys(depths).length}`);
  });

  test('ignores text and comment nodes', () => {
    const { tags } = sig('<html><body><!-- note -->plain text<p>a</p></body></html>');
    assert.deepEqual(tags, ['body', 'head', 'html', 'p']);
  });
});

describe('structuralSimilarity', () => {
  test('scores an unchanged document 1', () => {
    assert.equal(structuralSimilarity(sig(NESTED), sig(NESTED)), 1);
  });

  test('scores two empty signatures 1', () => {
    assert.equal(structuralSimilarity({ tags: [], depths: {} }, { tags: [], depths: {} }), 1);
  });

  test('scores an empty signature against a real one 0', () => {
    assert.equal(structuralSimilarity({ tags: [], depths: {} }, sig(NESTED)), 0);
  });

  test('returns 0 when either side is missing', () => {
    assert.equal(structuralSimilarity(null, sig(NESTED)), 0);
    assert.equal(structuralSimilarity(sig(NESTED), undefined), 0);
    assert.equal(structuralSimilarity(null, null), 0);
  });

  test('catches a rebuilt layout that kept its tag vocabulary', () => {
    // Same tags on both sides, so the tag half scores 1 and the whole verdict
    // rests on depth. Under the old constant-hierarchy code this was 1.0.
    const score = structuralSimilarity(sig(NESTED), sig(FLAT));
    assert.ok(score < 0.8, `expected a clear drop, got ${score}`);
  });

  test('can now score below 0.5, which the old formula could not', () => {
    // A deep table against a flat div/p page: different vocabulary, different
    // depth profile. The old formula's floor was 0.5 by construction.
    const table = sig('<html><body><table><tr><td><span>x</span></td></tr></table></body></html>');
    const score = structuralSimilarity(table, sig(FLAT));
    assert.ok(score < 0.5, `expected < 0.5, got ${score}`);
  });

  test('stays within 0-1 on duplicate-heavy markup', () => {
    // Repeated tags once inflated the Jaccard numerator past its union and
    // produced impossible scores like 1.05.
    const many = `<html><body>${'<div><p>x</p></div>'.repeat(200)}</body></html>`;
    const score = structuralSimilarity(sig(many), sig(NESTED));
    assert.ok(score >= 0 && score <= 1, `out of range: ${score}`);
  });

  test('a small edit costs only a small amount', () => {
    const before = sig('<html><body><ul><li>a</li><li>b</li><li>c</li></ul></body></html>');
    const after = sig('<html><body><ul><li>a</li><li>b</li><li>c</li><li>d</li></ul></body></html>');
    const score = structuralSimilarity(before, after);
    assert.ok(score > 0.9 && score < 1, `expected a near miss, got ${score}`);
  });

  test('tolerates a signature stored before depths existed', () => {
    // Old REST baselines carry no depth histogram. The score should degrade,
    // not throw.
    const score = structuralSimilarity({ tags: sig(NESTED).tags }, sig(NESTED));
    assert.ok(score >= 0 && score <= 1, `out of range: ${score}`);
  });
});

describe('structureSignature scoped to a subtree', () => {
  test('fingerprints only the requested region', () => {
    const $ = cheerio.load(
      '<html><body><main><ul><li>a</li></ul></main><footer><table><tr><td>x</td></tr></table></footer></body></html>'
    );
    const { tags } = structureSignature($, $('main'));
    assert.deepEqual(tags, ['li', 'ul']);
  });

  test('a change outside the scope leaves the score alone', () => {
    const load = (footer) =>
      cheerio.load(`<html><body><main><ul><li>a</li></ul></main><footer>${footer}</footer></body></html>`);
    const before = load('<p>one</p>');
    const after = load('<table><tr><td>x</td></tr></table><div><span>y</span></div>');

    assert.equal(
      structuralSimilarity(
        structureSignature(before, before('main')),
        structureSignature(after, after('main'))
      ),
      1
    );
  });
});
