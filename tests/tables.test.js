/**
 * gridTables (src/tables.js) and absoluteUrls (src/urls.js) — what extract_text
 * and scrape run before Turndown on both surfaces. The fixture and cases came
 * with the code from the MCP server's R24 3.12 suite
 * (tests/unit/r24p3-text-tables.test.js): the main table of
 * https://en.wikipedia.org/wiki/List_of_tallest_buildings (2026-10-03), cut
 * to three rows.
 *
 * Run: node --test tests/tables.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { gridTables, absoluteUrls } from '../index.js';

const PAGE_URL = 'https://en.wikipedia.org/wiki/List_of_tallest_buildings';

const TABLE = `<table class="wikitable sortable"><tbody>
<tr><th rowspan="2"></th><th rowspan="2">Name</th><th colspan="2">Height</th><th rowspan="2">Floors</th><th rowspan="2">Image</th><th rowspan="2">Country</th></tr>
<tr><th>m</th><th>ft</th></tr>
<tr><td>1</td><td><b><a href="/wiki/Burj_Khalifa">Burj Khalifa</a></b></td><td>828</td><td>2,717</td><td><div class="center">163<br>(+ 2 below ground)</div></td>
<td><a href="/wiki/File:Burj_Khalifa.jpg"><img src="//upload.wikimedia.org/wikipedia/en/thumb/9/93/Burj_Khalifa.jpg/120px-Burj_Khalifa.jpg" alt=""></a></td><td rowspan="2">United Arab Emirates</td></tr>
<tr><td>2</td><td>Marina 101</td><td>425</td><td>1,394</td><td>101</td><td></td></tr>
<tr><td colspan="7">Under construction</td></tr>
</tbody></table>`;

/** Each row of the first table as its cells' text. */
function rows($) {
  return $('table').first().find('tr').toArray()
    .map((tr) => $(tr).children('th, td').toArray().map((cell) => $(cell).text().trim()));
}

describe('gridTables', () => {
  test('one header row; the header and every row have the same number of columns', () => {
    const $ = load(TABLE);
    gridTables($);
    const r = rows($);
    assert.equal(r.length, 4);
    assert.deepEqual([...new Set(r.map((row) => row.length))], [7]);
    assert.deepEqual(r[0], ['', 'Name', 'Height m', 'Height ft', 'Floors', 'Image', 'Country']);
    assert.equal($('thead tr').length, 1);
    assert.equal($('thead th').length, 7);
    assert.ok(!r.some((row) => row.join('|') === 'm|ft'), 'the sub-header is not a row of its own');
  });

  test("a cell's line breaks stay inside the cell; a rowspan repeats; a colspan fills its first column", () => {
    const $ = load(TABLE);
    gridTables($);
    const r = rows($);
    assert.equal(r.find((row) => row[0] === '1')[4], '163 (+ 2 below ground)');
    assert.equal(r.find((row) => row[0] === '2')[6], 'United Arab Emirates');
    assert.deepEqual(r.find((row) => row[0] === 'Under construction'), ['Under construction', '', '', '', '', '', '']);
    assert.equal($('td div, td br').length, 0, 'no block element or <br> is left inside a cell');
  });

  test('a caption is kept', () => {
    const $ = load('<table><caption>Tallest</caption><tr><th>a</th></tr><tr><td>1</td></tr></table>');
    gridTables($);
    assert.equal($('table > caption').text(), 'Tallest');
  });

  test('a table with no header row is left as it is', () => {
    const html = '<table class="t"><tr><td>a</td><td colspan="2">b</td></tr><tr><td>c</td><td>d</td><td>e</td></tr></table>';
    const $ = load(html);
    const before = $.html();
    gridTables($);
    assert.equal($.html(), before);
  });

  test('a nested table and the table around it are left as they are', () => {
    const $ = load('<table><tr><th>x</th></tr><tr><td><table><tr><th>y</th></tr><tr><td>1</td></tr></table></td></tr></table>');
    const before = $.html();
    gridTables($);
    assert.equal($.html(), before);
  });
});

describe('absoluteUrls', () => {
  test('protocol-relative images and root-relative links resolve against the page', () => {
    const $ = load(TABLE);
    absoluteUrls($, PAGE_URL);
    assert.equal($('img').attr('src'), 'https://upload.wikimedia.org/wikipedia/en/thumb/9/93/Burj_Khalifa.jpg/120px-Burj_Khalifa.jpg');
    assert.equal($('a').first().attr('href'), 'https://en.wikipedia.org/wiki/Burj_Khalifa');
  });

  test('<base href> is the base; #anchor links stay as written', () => {
    const $ = load('<head><base href="/docs/"></head><body><a href="#top">t</a><a href="page">p</a><img src="i.png"></body>');
    absoluteUrls($, 'https://example.com/a/b');
    assert.equal($('a').eq(0).attr('href'), '#top');
    assert.equal($('a').eq(1).attr('href'), 'https://example.com/docs/page');
    assert.equal($('img').attr('src'), 'https://example.com/docs/i.png');
  });

  test('a page URL that does not parse leaves relative values as written', () => {
    const $ = load('<a href="/x">x</a>');
    absoluteUrls($, 'not a url');
    assert.equal($('a').attr('href'), '/x');
  });
});
