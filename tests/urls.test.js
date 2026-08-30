/**
 * URL scheme filtering for untrusted extracted URLs (src/urls.js).
 *
 * These values reach a React href and LLM clients, so a javascript:/data: URL
 * from a scraped page is an XSS / prompt-injection vector. safeHref keeps http(s)
 * and scheme-less values and drops everything else.
 *
 * Run: node --test tests/urls.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { safeHref } from '../src/urls.js';

// Whitespace / control characters built from char codes so this source stays
// plain ASCII (no literal control bytes, no escape sequences to mangle).
const SP = String.fromCharCode(32);
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const NUL = String.fromCharCode(0);

describe('safeHref', () => {
  test('keeps http and https absolute URLs unchanged', () => {
    assert.equal(safeHref('https://example.com/x?y=1#z'), 'https://example.com/x?y=1#z');
    assert.equal(safeHref('http://a.b/c'), 'http://a.b/c');
    assert.equal(safeHref('HTTPS://Example.com'), 'HTTPS://Example.com');
  });

  test('keeps scheme-less values (relative and protocol-relative) — nothing to abuse', () => {
    assert.equal(safeHref('/products/handle'), '/products/handle');
    assert.equal(safeHref('//cdn.example.com/a.js'), '//cdn.example.com/a.js');
    assert.equal(safeHref('?q=1'), '?q=1');
    assert.equal(safeHref('#section'), '#section');
  });

  test('drops javascript:, data: and other non-http schemes', () => {
    assert.equal(safeHref('javascript:alert(1)'), null);
    assert.equal(safeHref('JavaScript:alert(1)'), null);
    assert.equal(safeHref('data:text/html,<script>alert(1)</script>'), null);
    assert.equal(safeHref('vbscript:msgbox(1)'), null);
    assert.equal(safeHref('file:///etc/passwd'), null);
    assert.equal(safeHref('mailto:a@b.com'), null);
    assert.equal(safeHref('tel:+15550000'), null);
  });

  test('is not fooled by surrounding or embedded whitespace/control chars', () => {
    assert.equal(safeHref(SP + SP + 'javascript:alert(1)' + SP + SP), null);
    assert.equal(safeHref('java' + TAB + 'script:alert(1)'), null);
    assert.equal(safeHref('java' + LF + 'script:alert(1)'), null);
    assert.equal(safeHref(SP + 'javascript:alert(1)'), null);
    assert.equal(safeHref(NUL + 'javascript:alert(1)'), null);
  });

  test('returns null for empty and non-string input', () => {
    assert.equal(safeHref(''), null);
    assert.equal(safeHref(SP + SP + SP), null);
    assert.equal(safeHref(null), null);
    assert.equal(safeHref(undefined), null);
    assert.equal(safeHref(42), null);
    assert.equal(safeHref({}), null);
  });
});
