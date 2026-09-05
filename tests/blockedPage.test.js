/**
 * The blocked-page verdict both surfaces run on a fetched document
 * (src/blockedPage.js).
 *
 * Every vendor fixture is a wall served with HTTP 200 — the case that read
 * as a successful scrape for three regression rounds. Title and text are
 * derived from the HTML with cheerio the way a caller would derive them.
 *
 * Run: node --test tests/blockedPage.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from 'cheerio';

import { detectChallengePage, documentVerdict, SOFT_ERROR_MAX_CHARS } from '../src/blockedPage.js';

function page(name, url = 'https://example.com/') {
  const html = readFileSync(new URL(`./fixtures/blocked/${name}.html`, import.meta.url), 'utf8');
  const $ = load(html);
  $('script, style, noscript').remove();
  return {
    url,
    status: 200,
    title: $('title').first().text().trim(),
    text: $('body').text().replace(/\s+/g, ' ').trim(),
    html
  };
}

const PROSE = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(120);

describe('detectChallengePage — one fixture per vendor, all served with HTTP 200', () => {
  for (const [vendor, evidence] of [
    ['cloudflare', /title "Just a moment\.\.\."/],
    ['amazon', /validateCaptcha form/],
    ['datadome', /DataDome captcha frame on a \d+-character page/],
    ['perimeterx', /PerimeterX \/ HUMAN challenge element/],
    ['akamai', /title "Access Denied"/],
    ['vercel', /title "Vercel Security Checkpoint"/]
  ]) {
    test(`${vendor}`, () => {
      const hit = detectChallengePage(page(vendor));
      assert.equal(hit?.vendor, vendor);
      assert.match(hit.evidence, evidence);
    });
  }

  test('the title alone is enough — a navigation probe has no body text to offer', () => {
    assert.equal(detectChallengePage({ title: 'Just a moment...', html: '', text: '' })?.vendor, 'cloudflare');
  });

  test('an Amazon robot check is an amazon block whatever its length', () => {
    const html = '<form method="get" action="/errors/validateCaptcha"><input name="field-keywords"></form>' + '<p>x</p>'.repeat(2000);
    assert.equal(detectChallengePage({ title: 'Amazon.de', html, text: 'x '.repeat(3000) })?.vendor, 'amazon');
  });

  test('a real page that merely embeds a Turnstile widget is not a block', () => {
    const html = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script><article>' + PROSE + '</article>';
    assert.equal(detectChallengePage({ title: 'Sign in — Example', html, text: PROSE }), null);
  });

  test('an ordinary page is null', () => {
    assert.equal(detectChallengePage({ title: 'Web form', html: '<h1>Web form</h1>', text: 'Web form Text input' }), null);
  });
});

describe('documentVerdict', () => {
  test('a challenge page is blocked, with the vendor and the status, and the fetcher is named', () => {
    const v = documentVerdict(page('cloudflare', 'https://www.producthunt.com/'));
    assert.equal(v.success, false);
    assert.equal(v.status, 200);
    assert.equal(v.blocked?.vendor, 'cloudflare');
    assert.match(v.error, /^cloudflare served a challenge page instead of the content \(title "Just a moment\.\.\."\); the stealth browser did not pass it\.$/);

    const plain = documentVerdict(page('cloudflare'), { fetcher: 'a plain fetch' });
    assert.match(plain.error, /; a plain fetch did not pass it\.$/);
  });

  test('every vendor fixture fails the verdict with its vendor', () => {
    for (const vendor of ['cloudflare', 'amazon', 'datadome', 'perimeterx', 'akamai', 'vercel']) {
      const v = documentVerdict(page(vendor));
      assert.equal(v.success, false, vendor);
      assert.equal(v.blocked?.vendor, vendor);
    }
  });

  test('an HTTP error page names the status and keeps the title', () => {
    const v = documentVerdict({ url: 'https://www.lufthansa.com/x', status: 404, title: 'Page not found', text: 'The page you requested could not be found.' });
    assert.equal(v.success, false);
    assert.equal(v.status, 404);
    assert.match(v.error, /^HTTP 404: https:\/\/www\.lufthansa\.com\/x answered with an error page titled "Page not found"/);
    assert.match(v.error, /does not exist/);
    assert.equal(v.blocked, undefined);
    assert.match(v.error, /not the resource; the content returned is that page\. The site says/);

    const dropped = documentVerdict(
      { url: 'https://www.lufthansa.com/x', status: 404, title: 'Page not found', text: 'The page you requested could not be found.' },
      { fetcher: 'a plain fetch', contentReturned: false }
    );
    assert.match(dropped.error, /not the resource\. The site says/);
    assert.doesNotMatch(dropped.error, /content returned/);
  });

  test('a short document with an error title is a soft block even on HTTP 200', () => {
    const v = documentVerdict(page('soft-error', 'https://www.homedepot.com/p/x'));
    assert.equal(v.success, false);
    assert.equal(v.status, 200);
    assert.match(v.error, /rendered an error page titled "Error Page" \(\d+ characters of text\)/);
    assert.match(v.error, /longer wait_for/);
    const plain = documentVerdict(page('soft-error'), { fetcher: 'a plain fetch', rendered: false });
    assert.match(plain.error, /only a browser renders it\.$/);
    assert.doesNotMatch(plain.error, /wait_for/);
    for (const title of ['Something went wrong', 'Oops! We hit a snag', '404 – Page Not Found', 'Forbidden']) {
      const short = documentVerdict({ url: 'https://example.com/', status: 200, title, text: 'Please try again later.' });
      assert.equal(short.success, false, title);
    }
  });

  test('a long article whose title happens to be an error word is a page', () => {
    assert.ok(PROSE.length > SOFT_ERROR_MAX_CHARS);
    assert.deepEqual(documentVerdict({ url: 'https://example.com/post', status: 200, title: 'Error', text: PROSE }), { success: true, status: 200 });
  });

  test('an empty shell: a browser reports the wait it gave, a plain fetch gets the advice for a page it cannot render', () => {
    const shell = page('empty-shell', 'https://app.example.com/');
    assert.equal(shell.title, '');
    assert.equal(shell.text, '');

    assert.match(documentVerdict(shell).error, /after 0ms of extra wait/);
    const browser = documentVerdict(shell, { waitedMs: 6000 });
    assert.equal(browser.success, false);
    assert.match(browser.error, /^The stealth browser reached https:\/\/app\.example\.com\/ but the document rendered no title and no text after 6000ms of extra wait \(\d+ bytes of HTML\)\. A JavaScript-rendered page needs a longer wait_for/);

    const plain = documentVerdict(shell, { fetcher: 'a plain fetch', rendered: false });
    assert.equal(plain.success, false);
    assert.match(plain.error, /^A plain fetch reached https:\/\/app\.example\.com\/ but the document has no title and no text \(\d+ bytes of HTML\)\. The page is rendered by JavaScript or the server sent an empty shell; only a browser renders it\.$/);
    assert.doesNotMatch(plain.error, /wait_for/);

    assert.deepEqual(documentVerdict(shell, { allowEmpty: true }), { success: true, status: 200 });
  });

  test('a real page is a success, with or without a status', () => {
    assert.deepEqual(documentVerdict({ url: 'https://www.cars.com/', status: 200, title: '2026 Toyota Camry', text: PROSE }), { success: true, status: 200 });
    assert.deepEqual(documentVerdict({ url: 'https://www.cars.com/', title: '2026 Toyota Camry', text: PROSE }), { success: true, status: null });
  });
});
