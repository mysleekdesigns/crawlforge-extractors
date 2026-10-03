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

import { detectChallengePage, documentVerdict, SOFT_ERROR_MAX_CHARS, ERROR_TEXT_MAX_CHARS } from '../src/blockedPage.js';

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
    ['vercel', /title "Vercel Security Checkpoint"/],
    ['aws-waf', /AWS WAF challenge interstitial on a \d+-character page/],
    ['f5', /title "Request Rejected"/]
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

  test('a page that loads the AWS WAF SDK without the injected payload is not a block', () => {
    const html = '<title>Checkout</title><script src="https://abc.us-east-1.token.awswaf.com/abc/def/challenge.js"></script><p>Your basket</p>';
    assert.equal(detectChallengePage({ title: 'Checkout', html, text: 'Your basket' }), null);
  });

  test('a long page is never judged by the AWS WAF marker', () => {
    const html = '<script>window.gokuProps = {}</script><article>' + PROSE + '</article>';
    assert.equal(detectChallengePage({ title: 'Home', html, text: PROSE }), null);
  });

  test('an F5 page whose title was customised is still named by its sentence', () => {
    const html = '<title>Acme</title><body>The requested URL was rejected. Please consult with your administrator.<br><br>Your support ID is: 1</body>';
    const hit = detectChallengePage({ title: 'Acme', html, text: 'The requested URL was rejected. Please consult with your administrator. Your support ID is: 1' });
    assert.equal(hit?.vendor, 'f5');
    assert.match(hit.evidence, /F5 "Request Rejected" blocking page on a \d+-character page/);
  });

  test('an article that quotes the F5 sentence is not a block', () => {
    const quote = 'The requested URL was rejected. Please consult with your administrator. ';
    const text = quote + PROSE;
    assert.equal(detectChallengePage({ title: 'Why does my F5 say Request Rejected?', html: `<p>${text}</p>`, text }), null);
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
    for (const vendor of ['cloudflare', 'amazon', 'datadome', 'perimeterx', 'akamai', 'vercel', 'aws-waf', 'f5']) {
      const v = documentVerdict(page(vendor));
      assert.equal(v.success, false, vendor);
      assert.equal(v.blocked?.vendor, vendor);
    }
  });

  test("walmart's HTTP 444 F5 page is blocked by f5 and keeps its status", () => {
    const v = documentVerdict({ ...page('f5', 'https://www.walmart.com/ip/5689919121'), status: 444 }, { fetcher: 'a plain fetch' });
    assert.equal(v.success, false);
    assert.equal(v.status, 444);
    assert.deepEqual(v.blocked, { vendor: 'f5', evidence: 'title "Request Rejected"' });
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

  test('a short app error message under a normal title is a soft block (quora.com, 2026-09-26)', () => {
    const quora = {
      url: 'https://www.quora.com/What-is-the-best-way-to-learn-programming',
      status: 200,
      title: 'What is the best way to learn programming? - Quora',
      text: 'Something went wrong. Wait a moment and try again.Try again'
    };
    const plain = documentVerdict(quora, { fetcher: 'a plain fetch', rendered: false });
    assert.equal(plain.success, false);
    assert.equal(plain.status, 200);
    assert.match(plain.error, /rendered an application error message \("Something went wrong\. Wait a moment/);
    assert.match(plain.error, /under the title "What is the best way to learn programming\? - Quora"/);
    assert.match(plain.error, /only a browser renders it\.$/);
    assert.match(documentVerdict(quora).error, /longer wait_for/);

    for (const text of [
      'Application error: a client-side exception has occurred (see the browser console for more information).',
      'Oops! Please reload the page.',
      '  An unexpected error has occurred.\n Try again  '
    ]) {
      assert.equal(documentVerdict({ url: 'https://example.com/', status: 200, title: 'Example', text }).success, false, text);
    }
  });

  test('a page that starts with an error phrase but carries real text is a page', () => {
    const longer = 'Something went wrong with my build, and here is how I fixed it. '.repeat(4);
    assert.ok(longer.length >= ERROR_TEXT_MAX_CHARS);
    assert.deepEqual(documentVerdict({ url: 'https://example.com/post', status: 200, title: 'Fixing builds', text: longer }), { success: true, status: 200 });
    // The phrase has to open the text; a short page that mentions it later is a page.
    assert.deepEqual(documentVerdict({ url: 'https://example.com/', status: 200, title: 'Status', text: 'All systems normal. Nothing went wrong today.' }), { success: true, status: 200 });
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
