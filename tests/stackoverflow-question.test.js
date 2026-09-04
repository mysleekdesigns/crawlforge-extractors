/**
 * Unit tests: the stackoverflow-question template.
 *
 * Run: node --test tests/stackoverflow-question.test.js
 *
 * The template reads the Stack Exchange API rather than the rendered page:
 * stackoverflow.com answers every non-browser fetch (curl, node, a browser
 * User-Agent alike) with a Cloudflare 403, verified 2026-08-30, so the old
 * selector-based extract($) could never see a page. The fixture is a live
 * API response for question 11227809 captured the same day, trimmed to three
 * answers.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TemplateRegistry } from '../src/templates.js';

const registry = new TemplateRegistry();
const template = registry.get('stackoverflow-question');
const fixture = readFileSync(new URL('./fixtures/stackoverflow-question.json', import.meta.url), 'utf8');
const PAGE = 'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster';

describe('stackoverflow-question URL resolution', () => {
  test('rewrites a question page to the API document for the same id', () => {
    const resolved = template.resolveUrl(PAGE);
    assert.match(resolved, /^https:\/\/api\.stackexchange\.com\/2\.3\/questions\/11227809\?site=stackoverflow&filter=/);
  });

  test('matches question pages but not tag listings', () => {
    assert.equal(template.targetPattern.test(PAGE), true);
    assert.equal(template.targetPattern.test('https://stackoverflow.com/questions/11227809'), true);
    assert.equal(template.targetPattern.test('https://stackoverflow.com/questions/tagged/python'), false);
  });
});

describe('stackoverflow-question extraction', () => {
  test('reads the question, decoding the HTML-encoded title', () => {
    const data = template.extractRaw(fixture, PAGE);
    assert.equal(data.question_id, 11227809);
    assert.equal(data.title, 'Why is conditional processing of a sorted array faster than of an unsorted array?');
    assert.match(data.body, /^In this C\+\+ code, sorting the data/);
    assert.equal(data.votes, 27545);
    assert.ok(data.views > 1000000);
    assert.deepEqual(data.tags, ['java', 'c++', 'performance', 'cpu-architecture', 'branch-prediction']);
    assert.equal(data.author, 'GManNickG');
    assert.equal(data.asked, '2012-06-27T13:51:36.000Z');
    assert.equal(data.answered, true);
    assert.equal(data.accepted_answer_id, 11227902);
    assert.equal(data.link, 'https://stackoverflow.com/questions/11227809/why-is-conditional-processing-of-a-sorted-array-faster-than-of-an-unsorted-array');
  });

  test('lists answers accepted-first with plain-text bodies capped at 500 chars', () => {
    const { answers, answer_count } = template.extractRaw(fixture, PAGE);
    assert.equal(answer_count, 25);
    assert.equal(answers.length, 3);
    assert.equal(answers[0].accepted, true);
    assert.equal(answers[0].answer_id, 11227902);
    assert.ok(answers[1].votes >= answers[2].votes);
    for (const a of answers) {
      assert.ok(a.body.length <= 500);
      assert.doesNotMatch(a.body, /<[a-z]/i);
    }
  });

  test('reports an API error instead of returning an empty record', () => {
    const body = JSON.stringify({ error_id: 400, error_name: 'bad_parameter', error_message: 'filter is invalid' });
    assert.throws(() => template.extractRaw(body, PAGE), /Stack Exchange API error 400 \(bad_parameter\): filter is invalid/);
  });

  test('rejects an unknown question and a non-JSON body', () => {
    assert.throws(() => template.extractRaw(JSON.stringify({ items: [] }), PAGE), /returned no items/);
    assert.throws(() => template.extractRaw('<html>403</html>', PAGE), /did not return JSON/);
  });
});

describe('hacker-news-front-page URL matching', () => {
  const hn = registry.get('hacker-news-front-page');
  test('matches the front page with or without a trailing slash', () => {
    assert.equal(hn.targetPattern.test('https://news.ycombinator.com/'), true);
    assert.equal(hn.targetPattern.test('https://news.ycombinator.com'), true);
    assert.equal(hn.targetPattern.test('https://news.ycombinator.com/news'), true);
    assert.equal(hn.targetPattern.test('https://news.ycombinator.com/item?id=1'), false);
  });

  test('matches the other story lists and their pagination (R16)', () => {
    for (const path of ['/newest', '/front', '/best', '/ask', '/show', '/jobs', '/active', '/news?p=2', '/newest?next=1&n=31']) {
      assert.equal(hn.targetPattern.test(`https://news.ycombinator.com${path}`), true, path);
    }
    assert.equal(hn.targetPattern.test('https://news.ycombinator.com/user?id=pg'), false);
    assert.equal(hn.targetPattern.test('https://news.ycombinator.com/from?site=example.com'), false);
  });
});
