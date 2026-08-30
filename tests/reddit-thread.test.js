/**
 * Unit tests: the reddit-thread template, and the retired-template map.
 *
 * Run: node --test tests/reddit-thread.test.js
 *
 * reddit-thread reads the Arctic Shift archive rather than reddit.com, which
 * 403s every non-browser client and disallows everything in robots.txt. The
 * fixture is a live /api/posts/ids record captured 2026-08-30, trimmed to the
 * fields the template reads plus a few it must ignore.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TemplateRegistry, TEMPLATES, RETIRED_TEMPLATES, retiredTemplate } from '../src/templates.js';

const registry = new TemplateRegistry();
const template = registry.get('reddit-thread');
const fixture = readFileSync(new URL('./fixtures/reddit-thread.json', import.meta.url), 'utf8');
const PAGE = 'https://www.reddit.com/r/node/comments/1w2lsvx/i_built_volten_a_zerodependency_typescriptnative/';

describe('reddit-thread URL resolution', () => {
  test('rewrites a post page to the archive record for the same id', () => {
    assert.equal(
      template.resolveUrl(PAGE),
      'https://arctic-shift.photon-reddit.com/api/posts/ids?ids=1w2lsvx'
    );
  });

  test('matches post URLs with and without the subreddit segment, not subreddit listings', () => {
    assert.equal(template.targetPattern.test(PAGE), true);
    assert.equal(template.targetPattern.test('https://www.reddit.com/comments/1w2lsvx'), true);
    assert.equal(template.targetPattern.test('https://old.reddit.com/r/node/comments/1w2lsvx/'), true);
    assert.equal(template.targetPattern.test('https://www.reddit.com/r/node/'), false);
    assert.equal(registry.detect(PAGE)?.id, 'reddit-thread');
  });

  test('a reddit.com URL that names no post is left alone rather than guessed at', () => {
    assert.equal(template.resolveUrl('https://www.reddit.com/r/node/'), 'https://www.reddit.com/r/node/');
  });
});

describe('reddit-thread extraction', () => {
  test('reads the post record into the documented shape', () => {
    const data = template.extractRaw(fixture, PAGE);
    assert.equal(data.id, '1w2lsvx');
    assert.equal(data.title, 'I built Volten: A zero-dependency, TypeScript-native HTTP framework for Node.js');
    assert.equal(data.subreddit, 'node');
    assert.equal(data.author, 'voltenjs');
    assert.equal(data.score, 1);
    assert.equal(data.upvote_ratio, 1);
    assert.equal(data.num_comments, 0);
    assert.equal(data.posted, '2026-08-30T16:16:55.000Z');
    assert.equal(data.url, PAGE);
    assert.equal(data.link_url, null, 'a self post has no external link');
    assert.equal(data.flair, null);
    assert.equal(data.over_18, false);
    assert.match(data.note, /reddit_search/);
  });

  test('reports the archive\'s removal state and the placeholder body as written', () => {
    const data = template.extractRaw(fixture, PAGE);
    assert.equal(data.body, '[removed]');
    assert.equal(data.removed, 'moderator');
  });

  test('a link post reports its external URL and no body', () => {
    const doc = JSON.parse(fixture);
    Object.assign(doc.data[0], { is_self: false, selftext: '', url: 'https://example.com/article', removed_by_category: null });
    const data = template.extractRaw(JSON.stringify(doc), PAGE);
    assert.equal(data.link_url, 'https://example.com/article');
    assert.equal(data.body, null);
    assert.equal(data.removed, null);
  });

  test('a non-JSON body names the archive rather than reporting empty fields', () => {
    assert.throws(() => template.extractRaw('<html>reddit</html>', PAGE), /Arctic Shift/);
  });

  test('an archive error and an unknown post are distinct failures', () => {
    assert.throws(
      () => template.extractRaw(JSON.stringify({ data: null, error: "'ids' must be base36" }), PAGE),
      /Arctic Shift error: 'ids' must be base36/
    );
    assert.throws(() => template.extractRaw(JSON.stringify({ data: [] }), PAGE), /no record of it/);
  });

  test('runs through the registry, reporting the archive URL it read', async () => {
    const result = await registry.run('reddit-thread', fixture, PAGE, template.resolveUrl(PAGE));
    assert.equal(result.template, 'reddit-thread');
    assert.equal(result.fetchedUrl, 'https://arctic-shift.photon-reddit.com/api/posts/ids?ids=1w2lsvx');
    assert.equal(result.data.id, '1w2lsvx');
  });
});

describe('retired templates', () => {
  test('linkedin-profile and tweet are retired, not shipped, and each names its reason', () => {
    const shipped = new Set(TEMPLATES.map(t => t.id));
    for (const id of ['linkedin-profile', 'tweet']) {
      assert.equal(shipped.has(id), false, `${id} still ships`);
      assert.ok(RETIRED_TEMPLATES[id], `${id} is not in RETIRED_TEMPLATES`);
      assert.match(RETIRED_TEMPLATES[id].reason, /robots\.txt/);
    }
  });

  test('retiredTemplate answers by id and by a URL the template handled', () => {
    assert.equal(retiredTemplate('tweet').id, 'tweet');
    assert.equal(retiredTemplate('https://x.com/jack/status/20').id, 'tweet');
    assert.equal(retiredTemplate('https://twitter.com/jack/status/20').id, 'tweet');
    assert.equal(retiredTemplate('https://www.linkedin.com/in/williamhgates').id, 'linkedin-profile');
    assert.equal(retiredTemplate('github-repo'), null);
    assert.equal(retiredTemplate('https://github.com/nodejs/node'), null);
    assert.equal(retiredTemplate(undefined), null);
  });

  test('a retired id and a shipped id never collide, so "retired" and "unknown" stay distinct', () => {
    const shipped = new Set(TEMPLATES.map(t => t.id));
    for (const id of Object.keys(RETIRED_TEMPLATES)) assert.equal(shipped.has(id), false);
  });
});
