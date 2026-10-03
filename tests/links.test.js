/**
 * extractLinkRecords (src/links.js) — the link records both extract_links
 * surfaces return (plan E3: one shape, the same count for the same page).
 *
 * Run: node --test tests/links.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { extractLinkRecords } from '../src/links.js';

const PAGE = 'https://example.com/docs/page';

function links(html, options = { pageUrl: PAGE }) {
  return extractLinkRecords(load(html), options);
}

describe('extractLinkRecords', () => {
  test('one record shape: href, text, type, domain, rel, original_href', () => {
    const [record] = links('<a href="/about" rel="nofollow">  About\n us </a>');
    assert.deepEqual(record, {
      href: 'https://example.com/about',
      text: 'About us',
      type: 'internal',
      domain: 'example.com',
      rel: 'nofollow',
      original_href: '/about'
    });
  });

  test('internal is the same hostname; another host is external', () => {
    const records = links('<a href="http://example.com/x">a</a><a href="https://other.org/">b</a><a href="//cdn.example.com/y">c</a>');
    assert.deepEqual(records.map((r) => r.type), ['internal', 'external', 'external']);
    assert.equal(records[2].href, 'https://cdn.example.com/y');
  });

  test('mailto:, tel: and javascript: are type "other"; only mailto/tel keep their href', () => {
    const records = links(
      '<a href="mailto:hi@example.com">Mail</a><a href="tel:+15551234">Call</a>' +
      '<a href="javascript:void(0)">Cookie Settings</a><a href="java\tscript:alert(1)">x</a><a href="data:text/html,hi">d</a>'
    );
    assert.deepEqual(records.map((r) => r.type), ['other', 'other', 'other', 'other', 'other']);
    assert.equal(records[0].href, 'mailto:hi@example.com');
    assert.equal(records[1].href, 'tel:+15551234');
    // javascript: (disguised by a tab or not) and data: keep their record with nothing runnable in it
    for (const record of records.slice(2)) {
      assert.equal(record.href, null);
      assert.equal(record.original_href, null);
    }
    assert.equal(records.every((r) => r.domain === null), true);
  });

  test('dedupes on the URL without fragment or trailing slash, keeping the first', () => {
    const records = links('<a href="/a/">1</a><a href="/a">2</a><a href="/a#top">3</a><a href="/b?q=1">4</a><a href="/b?q=2">5</a>');
    assert.deepEqual(records.map((r) => r.text), ['1', '4', '5']);
    assert.equal(records[0].href, 'https://example.com/a/');
  });

  test('dedupe: false keeps every link', () => {
    assert.equal(links('<a href="/a">1</a><a href="/a">2</a>', { pageUrl: PAGE, dedupe: false }).length, 2);
  });

  test('#fragment-only hrefs are skipped unless includeAnchors', () => {
    assert.equal(links('<a href="#top">Top</a>').length, 0);
    const [record] = links('<a href="#top">Top</a>', { pageUrl: PAGE, includeAnchors: true });
    assert.equal(record.type, 'anchor');
    assert.equal(record.href, '#top');
  });

  test('<base href> is the resolution base; baseUrl wins over it', () => {
    const html = '<head><base href="/assets/"></head><body><a href="img.png">i</a></body>';
    assert.equal(links(html)[0].href, 'https://example.com/assets/img.png');
    assert.equal(links(html, { pageUrl: PAGE, baseUrl: 'https://mirror.net/' })[0].href, 'https://mirror.net/img.png');
  });

  test('internal/external is judged by the page host even under <base href> elsewhere', () => {
    const [record] = links('<base href="https://cdn.example.net/"><a href="x">x</a>');
    assert.equal(record.href, 'https://cdn.example.net/x');
    assert.equal(record.type, 'external');
  });

  test('no page and no base: a relative href stays as written, type "relative"', () => {
    const records = extractLinkRecords(load('<a href="/x">x</a><a href="https://a.com/">a</a>'));
    assert.deepEqual(records.map((r) => [r.type, r.href]), [['relative', '/x'], ['external', 'https://a.com/']]);
  });

  test('no page URL: baseUrl decides the host', () => {
    const [record] = extractLinkRecords(load('<a href="/x">x</a>'), { baseUrl: 'https://example.com/' });
    assert.equal(record.type, 'internal');
  });

  test('title is carried when present; empty href is skipped', () => {
    const records = links('<a href="">empty</a><a href="/t" title="Tip">t</a>');
    assert.equal(records.length, 1);
    assert.equal(records[0].title, 'Tip');
  });
});
