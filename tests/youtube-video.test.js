/**
 * Unit tests: the youtube-video template.
 *
 * Regression (2026-08-26): against a live watch page the template returned
 * null for views and had no likes field at all, though its own description
 * promises both. It read meta[itemprop="interactionCount"], an attribute that
 * appears nowhere on a YouTube page — the counts are userInteractionCount,
 * one InteractionCounter block per statistic, distinguished only by a sibling
 * interactionType. LikeAction is emitted first, so the obvious fix (reading
 * userInteractionCount directly) silently returns likes as views.
 *
 * Markup below is condensed from a live capture of watch?v=_EYvOGlR2dw,
 * which had 5,546 views and 224 likes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TemplateRegistry } from '../src/templates.js';

const registry = new TemplateRegistry();

const run = async (html) =>
  (await registry.run('youtube-video', `<html><body>${html}</body></html>`, 'https://www.youtube.com/watch?v=_EYvOGlR2dw')).data;

const counter = (action, count) =>
  `<div itemprop="interactionStatistic" itemscope itemtype="https://schema.org/InteractionCounter">
     <meta itemprop="interactionType" content="https://schema.org/${action}">
     <meta itemprop="userInteractionCount" content="${count}">
   </div>`;

const LIVE = counter('LikeAction', '224') + counter('WatchAction', '5546');

describe('youtube-video interaction counts', () => {
  test('views come from the WatchAction counter, not the first one on the page', async () => {
    assert.equal((await run(LIVE)).views, 5546);
  });

  test('likes come from the LikeAction counter', async () => {
    assert.equal((await run(LIVE)).likes, 224);
  });

  test('the counters are numbers, not the raw attribute strings', async () => {
    const { views, likes } = await run(LIVE);
    assert.equal(typeof views, 'number');
    assert.equal(typeof likes, 'number');
  });

  test('a video with likes hidden still reports views', async () => {
    const { views, likes } = await run(counter('WatchAction', '5546'));
    assert.equal(views, 5546);
    assert.equal(likes, null);
  });

  test('zero views is zero, not null', async () => {
    assert.equal((await run(counter('WatchAction', '0'))).views, 0);
  });

  test('a page with no counters leaves both null rather than throwing', async () => {
    const { views, likes } = await run('<meta name="title" content="Some video">');
    assert.equal(views, null);
    assert.equal(likes, null);
  });
});

describe('youtube-video core fields', () => {
  const PAGE = `
    <meta name="title" content="How I Find Low-Competition Keywords That Actually Convert">
    <link rel="canonical" href="https://www.youtube.com/watch?v=_EYvOGlR2dw">
    <span itemprop="author" itemscope itemtype="http://schema.org/Person">
      <link itemprop="name" content="Edward Sturm">
      <link itemprop="url" href="http://www.youtube.com/@buildinpublic">
    </span>
    <meta itemprop="duration" content="PT12M7S">
    <meta itemprop="uploadDate" content="2026-02-23T08:32:57-08:00">
    ${LIVE}`;

  test('the whole page yields every advertised field', async () => {
    const data = await run(PAGE);
    assert.equal(data.title, 'How I Find Low-Competition Keywords That Actually Convert');
    assert.equal(data.channel, 'Edward Sturm');
    assert.equal(data.channel_url, 'http://www.youtube.com/@buildinpublic');
    assert.equal(data.views, 5546);
    assert.equal(data.likes, 224);
    assert.equal(data.published, '2026-02-23T08:32:57-08:00');
    assert.equal(data.duration, 'PT12M7S');
    assert.equal(data.video_id, '_EYvOGlR2dw');
  });
});
