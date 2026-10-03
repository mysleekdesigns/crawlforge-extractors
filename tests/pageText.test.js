/**
 * flattenText (src/pageText.js) — the block-aware text both extract_text
 * surfaces return. The first five cases came with the code from the MCP
 * server's flattenBodyText regression suite (2026-08-20: a Hacker-News-style
 * page welded "1.Story title329 points" onto one line).
 *
 * Run: node --test tests/pageText.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { flattenText } from '../src/pageText.js';

const HN_LIKE_HTML = `<html><body><table>
  <tr class="athing"><td><span class="rank">1.</span></td>
    <td><span class="titleline"><a href="https://a.example">First story title</a></span></td></tr>
  <tr><td class="subtext"><span class="score">329 points</span> by alice</td></tr>
  <tr class="athing"><td><span class="rank">2.</span></td>
    <td><span class="titleline"><a href="https://b.example">Second story title</a></span></td></tr>
  <tr><td class="subtext"><span class="score">715 points</span> by bob</td></tr>
</table></body></html>`;

test('block elements become separate lines instead of welding together', () => {
  const lines = flattenText(load(HN_LIKE_HTML)).split('\n');
  assert.equal(lines[0], '1. First story title');
  assert.equal(lines[1], '329 points by alice');
  assert.equal(lines[2], '2. Second story title');
  assert.equal(lines[3], '715 points by bob');
});

test('<h1>Hi</h1><p>there</p> reads "Hi\\nthere", not "Hithere" (plan E3)', () => {
  assert.equal(flattenText(load('<h1>Hi</h1><p>there</p>')), 'Hi\nthere');
});

test('table cells in one row are space-separated, not welded', () => {
  assert.equal(flattenText(load('<body><table><tr><td>Cell A</td><td>Cell B</td></tr></table></body>')), 'Cell A Cell B');
});

test('br, list items and paragraphs produce line breaks; blank runs collapse', () => {
  const text = flattenText(load(
    '<body><p>Para one</p>\n\n  <p>line a<br>line b</p><ul><li>item 1</li><li>item 2</li></ul></body>'
  ));
  assert.equal(text, 'Para one\nline a\nline b\nitem 1\nitem 2');
});

test('horizontal whitespace (tabs, NBSP) collapses to single spaces within a line', () => {
  assert.equal(flattenText(load('<body><p>a\t\tb&nbsp;&nbsp;c</p></body>')), 'a b c');
});

test("the caller's $ tree is not mutated", () => {
  const $ = load('<body><div id="x">one</div><div id="y">two</div></body>');
  const before = $.html();
  flattenText($);
  assert.equal($.html(), before);
});

test('a root reads only the matched elements, a line break between them', () => {
  const $ = load('<body><p>skip</p><article><h2>A</h2><p>one</p></article><article><p>two</p></article></body>');
  assert.equal(flattenText($, $('article')), 'A\none\ntwo');
});

test('inline elements stay on their line', () => {
  assert.equal(flattenText(load('<p>a <b>bold</b> <a href="/x">link</a>.</p>')), 'a bold link.');
});

test('definition lists, figures, landmarks and captions are blocks too', () => {
  assert.equal(flattenText(load('<dl><dt>Term</dt><dd>Def</dd></dl>')), 'Term\nDef');
  assert.equal(
    flattenText(load('<figure><img src="a.png"><figcaption>Cap</figcaption></figure><main>Main</main><aside>Side</aside>')),
    'Cap\nMain\nSide'
  );
  assert.equal(flattenText(load('<table><caption>T</caption><tr><td>a</td></tr></table>')), 'T\na');
});

test('inline text before a block starts its own line (R24 3.1: "July 2023If you collected")', () => {
  // What Readability makes of paulgraham.com/greatwork.html's "July 2023<br><br>If you…".
  assert.equal(
    flattenText(load('<div><font>July 2023<p>If you collected lists.</p><p>The following recipe.</p></font></div>')),
    'July 2023\nIf you collected lists.\nThe following recipe.'
  );
  assert.equal(flattenText(load('<form><label>Name</label><div>Thanks</div></form>')), 'Name\nThanks');
});
