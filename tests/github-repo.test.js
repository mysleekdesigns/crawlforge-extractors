/**
 * Unit tests: the github-repo template.
 *
 * Regression (2026-08-26): against the live logged-out repo page the template
 * returned homepage:null, open_issues:null and license:"LICENSE" (the file
 * link's text — a filename, not a licence name). GitHub's React code view no
 * longer renders the About sidebar as HTML: homepage and licence ship as JSON
 * inside <script data-target="react-app.embeddedData">, and the open-issues
 * count lives on the #issues-repo-tab-count tab counter. Language and the
 * last-push date appear nowhere in the served page (the client fetches them
 * post-load from header-gated JSON endpoints), so those two stay null there
 * by design; the classic-layout selectors for them are kept as fallbacks.
 *
 * Markup below is condensed from a live capture of github.com/expressjs/express
 * (69.4k stars, 105 open issues, MIT licence, homepage expressjs.com).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TemplateRegistry } from '../src/templates.js';

const registry = new TemplateRegistry();

const run = async (html) =>
  (await registry.run('github-repo', `<html><body>${html}</body></html>`, 'https://github.com/expressjs/express')).data;

const embedded = (sidebarAbout) =>
  `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({ payload: { sidebarAbout } })}</script>`;

// Condensed from the live payload — only the fields the template reads.
const ABOUT = {
  description: 'Fast, unopinionated, minimalist web framework for node.',
  website: 'https://expressjs.com',
  topics: [{ name: 'express' }, { name: 'javascript' }],
  stargazerCount: 69394,
  forksCount: 24836,
  repo: { license: { spdxId: 'MIT', name: 'MIT License' } }
};

const ISSUES_COUNTER =
  '<span id="issues-repo-tab-count" data-pjax-replace="" data-turbo-replace="" title="105" data-view-component="true" class="Counter">105</span>';

// The file-tree row link whose text used to be returned as the "license".
const LICENSE_FILE_LINK = '<a href="/expressjs/express/blob/master/LICENSE">LICENSE</a>';

// The overview-files nav item — the only place the licence NAME is in the HTML.
const LICENSE_NAV = '<a href="#LICENSE"><svg class="octicon octicon-law"></svg><span>MIT license</span></a>';

const LIVE = embedded(ABOUT) + ISSUES_COUNTER + LICENSE_FILE_LINK + LICENSE_NAV;

describe('github-repo sidebar facts from the embedded JSON', () => {
  test('license is the SPDX id, never the LICENSE file link text', async () => {
    assert.equal((await run(LIVE)).license, 'MIT');
  });

  test('homepage comes from the About payload website', async () => {
    assert.equal((await run(LIVE)).homepage, 'https://expressjs.com');
  });

  test('a repo without a website reports null, not some other external link', async () => {
    const html = embedded({ ...ABOUT, website: '' }) +
      '<a href="https://opencollective.com/express" rel="noopener noreferrer">sponsor</a>';
    assert.equal((await run(html)).homepage, null);
  });

  test('a non-standard licence falls back from NOASSERTION to the display name', async () => {
    const html = embedded({ ...ABOUT, repo: { license: { spdxId: 'NOASSERTION', name: 'View license' } } });
    assert.equal((await run(html)).license, 'View license');
  });

  test('a repo with no licence reports null', async () => {
    assert.equal((await run(embedded({ ...ABOUT, repo: {} }))).license, null);
  });

  test('malformed embedded JSON is skipped without throwing', async () => {
    const html = '<script type="application/json" data-target="react-app.embeddedData">{oops</script>' + LICENSE_NAV;
    assert.equal((await run(html)).license, 'MIT license');
  });
});

describe('github-repo open issues from the tab counter', () => {
  test('the issues tab counter is read', async () => {
    assert.equal((await run(LIVE)).open_issues, '105');
  });

  test('the exact title count wins over the abbreviated text', async () => {
    const html = '<span id="issues-repo-tab-count" title="5,102" class="Counter">5.1k</span>';
    assert.equal((await run(html)).open_issues, '5,102');
  });

  test('a "Not available" title is not mistaken for a count', async () => {
    const html = '<span id="issues-repo-tab-count" title="Not available" class="Counter"></span>';
    assert.equal((await run(html)).open_issues, null);
  });
});

describe('github-repo fallbacks and honest nulls', () => {
  test('without the embedded JSON, licence falls back to the octicon-law nav span', async () => {
    assert.equal((await run(LICENSE_NAV)).license, 'MIT license');
  });

  test('classic-layout language and relative-time still extract', async () => {
    const html = '<span itemprop="programmingLanguage">JavaScript</span>' +
      '<relative-time datetime="2026-08-22T20:59:54Z">2 days ago</relative-time>';
    const data = await run(html);
    assert.equal(data.language, 'JavaScript');
    assert.equal(data.last_updated, '2026-08-22T20:59:54Z');
  });

  test('the current layout carries neither language nor last-push date — both stay null', async () => {
    const data = await run(LIVE);
    assert.equal(data.language, null);
    assert.equal(data.last_updated, null);
  });
});
