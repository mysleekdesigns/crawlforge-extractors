/**
 * Unit tests: the hacker-news-front-page template.
 *
 * Run: node --test tests/hacker-news-front-page.test.js
 *
 * Regression (R14, 2026-09-03): on /newest a fresh story's subtext reads
 * "1 point", not "1 points". The score field stripped only the plural, so the
 * same list carried "1 point" beside "3" — one field, two shapes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TemplateRegistry } from '../src/templates.js';

const registry = new TemplateRegistry();

const row = (id, title, score, comments) => `
  <tr class="athing" id="${id}">
    <td class="title"><span class="titleline"><a href="https://example.test/${id}">${title}</a>
      <span class="sitebit comhead"><a href="from?site=example.test">example.test</a></span></span></td>
  </tr>
  <tr><td class="subtext">
    <span class="score" id="score_${id}">${score}</span> by <a class="hnuser">someone</a>
    <span class="age"><a href="item?id=${id}">5 minutes ago</a></span> |
    <a href="item?id=${id}">${comments}</a>
  </td></tr>`;

const run = async (html) =>
  (await registry.run('hacker-news-front-page', `<html><body><table>${html}</table></body></html>`, 'https://news.ycombinator.com/newest')).data;

describe('hacker-news-front-page — score normalisation', () => {
  test('"1 point" and "3 points" both become bare numbers', async () => {
    const data = await run(row('1', 'Fresh story', '1 point', 'discuss') + row('2', 'Older story', '3 points', '2 comments'));
    assert.equal(data.stories.length, 2);
    assert.equal(data.stories[0].score, '1');
    assert.equal(data.stories[1].score, '3');
    assert.equal(data.stories[0].comments, 'discuss');
    assert.equal(data.stories[1].comments, '2 comments');
  });

  test('a story with no score element (job post) reports null', async () => {
    const data = await run(row('3', 'Hiring', '', ''));
    assert.equal(data.stories[0].score, null);
  });
});
