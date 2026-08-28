/**
 * Unit tests: TemplateRegistry itself — detection, list connectors, credentials.
 *
 * Run: node --test tests/registry.test.js
 *
 * The targetPattern regexes existed from the start but nothing consumed them:
 * list() echoed them as strings and every caller still had to name a template
 * by hand. detect() makes them load-bearing, which means the ranking between
 * two matching patterns has to be decided rather than left to array order —
 * an Amazon URL containing /products/ matches shopify-product too.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TemplateRegistry, TEMPLATES } from '../src/templates.js';

const registry = new TemplateRegistry();

/**
 * One live URL per shipped template. Written from the real URL shapes, not
 * from the regexes — a case derived from the pattern only proves the pattern
 * matches itself.
 */
const REPRESENTATIVE_URLS = {
  'shopify-product': 'https://www.deathwishcoffee.com/products/2026-death-wish-coffee-mug',
  'shopify-collection': 'https://www.allbirds.com/collections/mens',
  'amazon-product': 'https://www.amazon.com/dp/B08N5WRWNW',
  'linkedin-profile': 'https://www.linkedin.com/in/williamhgates',
  'github-repo': 'https://github.com/nodejs/node',
  'youtube-video': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  tweet: 'https://x.com/jack/status/20',
  'reddit-thread': 'https://www.reddit.com/r/node/comments/abc123/some-title/',
  'hacker-news-front-page': 'https://news.ycombinator.com/news',
  'producthunt-launch': 'https://www.producthunt.com/posts/crawlforge',
  'stackoverflow-question': 'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster',
  'npm-package': 'https://www.npmjs.com/package/crawlforge-extractors',
  // Job boards and government APIs — the same companies and VINs the
  // fixtures were captured from, so these are URLs that answered.
  'greenhouse-jobs': 'https://job-boards.greenhouse.io/stripe',
  'lever-postings': 'https://jobs.lever.co/leverdemo',
  'ashby-jobs': 'https://jobs.ashbyhq.com/ramp',
  'workable-jobs': 'https://apply.workable.com/persado/',
  'recruitee-offers': 'https://channable.recruitee.com/o/senior-engineer',
  'teamtailor-jobs': 'https://career.teamtailor.com/jobs',
  'nhtsa-vin': 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/5UXWX7C5*BA?format=json',
  'npi-provider': 'https://npiregistry.cms.hhs.gov/api/?version=2.1&state=CA&limit=5'
};

describe('TemplateRegistry.detect', () => {
  test('every shipped template is reachable from a representative URL', () => {
    for (const template of TEMPLATES) {
      const url = REPRESENTATIVE_URLS[template.id];
      assert.ok(url, `no representative URL for "${template.id}" — add one when adding a template`);
      assert.equal(registry.detect(url)?.id, template.id, `detect() missed ${url}`);
    }
  });

  test('the URL table covers every template, so a new one cannot skip this test', () => {
    assert.deepEqual(
      Object.keys(REPRESENTATIVE_URLS).sort(),
      TEMPLATES.map(t => t.id).sort()
    );
  });

  test('an unmatched URL returns null rather than a wrong guess', () => {
    assert.equal(registry.detect('https://example.com/about'), null);
    assert.equal(registry.detect('https://en.wikipedia.org/wiki/Web_scraping'), null);
  });

  test('input that is not a URL returns null rather than throwing', () => {
    assert.equal(registry.detect('not a url'), null);
    assert.equal(registry.detect(''), null);
    assert.equal(registry.detect(undefined), null);
  });

  test('a host-anchored pattern beats a path-only one', () => {
    // Both patterns match: amazon-product names the host, shopify-product only
    // knows the /products/ path shape. Without the ranking this returns
    // whichever happens to be first in TEMPLATES.
    const url = 'https://www.amazon.com/Some-Widget/dp/B01/products/thing';
    assert.match(url, registry.get('shopify-product').targetPattern);
    assert.equal(registry.detect(url).id, 'amazon-product');
  });

  test('two path-only patterns tie-break on registration order', () => {
    // A product page reached through a collection matches shopify-product; the
    // collection pattern deliberately stops short of it.
    const url = 'https://shop.example.com/collections/all/products/mug';
    assert.equal(registry.detect(url).id, 'shopify-product');
  });

  test('detection is stateless across repeated calls', () => {
    // A regex carrying /g would advance lastIndex and start returning null on
    // every second call.
    const url = REPRESENTATIVE_URLS['github-repo'];
    assert.equal(registry.detect(url).id, 'github-repo');
    assert.equal(registry.detect(url).id, 'github-repo');
  });
});

describe('TemplateRegistry.list', () => {
  test('mode is derived from extractList, not stored on the template', () => {
    const listed = registry.list();
    assert.equal(listed.find(t => t.id === 'shopify-collection').mode, 'list');
    assert.equal(listed.find(t => t.id === 'shopify-product').mode, 'entity');
    assert.ok(
      TEMPLATES.every(t => !('mode' in t) && !('kind' in t)),
      'mode must stay derived — a stored field would be a second source of truth'
    );
  });

  test('credential fields are absent on templates that need no key', () => {
    for (const entry of registry.list()) {
      assert.ok(!('requires_api_key' in entry), `${entry.id} should not advertise a key`);
      assert.ok(!('credential_ref' in entry), `${entry.id} should not advertise a credential`);
    }
  });

  test('the existing summary fields are unchanged', () => {
    const shopify = registry.list().find(t => t.id === 'shopify-product');
    assert.equal(shopify.name, 'Shopify Product');
    assert.equal(typeof shopify.description, 'string');
    assert.equal(shopify.targetPattern, '/\\/products\\/[^/?#]+/i');
  });
});

// ── Injected fixture templates ───────────────────────────────────────────────
//
// Defined here rather than shipped: a key-based connector we have no key for
// would be a template nobody has run against a live response, and a fixture
// written from the code alone proves nothing.

const CREDENTIAL_TEMPLATE = {
  id: 'fixture-keyed-api',
  name: 'Fixture Keyed API',
  description: 'Stand-in for a key-based API, so the credential contract has a test.',
  targetPattern: /fixture-keyed\.example\/events/i,
  requiresApiKey: true,
  credentialRef: 'FIXTURE_API_KEY',

  listUrl({ apiKey, city } = {}) {
    if (!apiKey) {
      throw new Error(
        'fixture-keyed-api requires an API key. Set FIXTURE_API_KEY and pass it as params.apiKey.'
      );
    }
    if (!city) throw new Error('fixture-keyed-api requires a "city" parameter.');
    return `https://fixture-keyed.example/events?city=${encodeURIComponent(city)}&apikey=${apiKey}`;
  },

  extractList(body) {
    const payload = JSON.parse(body);
    return {
      items: payload.events,
      count: payload.events.length,
      total_available: payload.total
    };
  }
};

const ENTITY_TEMPLATE = {
  id: 'fixture-entity',
  name: 'Fixture Entity',
  description: 'A template with no extractList, to prove runList refuses it.',
  targetPattern: /fixture-entity\.example/i,
  extractRaw: () => ({ ok: true })
};

const fixtures = new TemplateRegistry([CREDENTIAL_TEMPLATE, ENTITY_TEMPLATE]);

describe('injected templates', () => {
  test('the registry uses the set it was given, not the shipped one', () => {
    assert.deepEqual(fixtures.list().map(t => t.id), ['fixture-keyed-api', 'fixture-entity']);
    assert.equal(fixtures.get('shopify-product'), undefined);
    assert.equal(fixtures.detect(REPRESENTATIVE_URLS['shopify-product']), null);
  });

  test('the default registry is unaffected by an injected one', () => {
    assert.equal(registry.get('shopify-product').id, 'shopify-product');
  });

  test('an unknown id names what is actually registered', async () => {
    await assert.rejects(
      () => fixtures.run('shopify-product', '{}', 'https://x.example'),
      /Unknown template: "shopify-product"\. Available: fixture-keyed-api, fixture-entity/
    );
  });
});

describe('API-key connectors', () => {
  test('a missing key names the env var to set, not a bare 401', () => {
    const template = fixtures.get('fixture-keyed-api');
    assert.throws(
      () => template.listUrl({ city: 'Austin' }),
      /FIXTURE_API_KEY/,
      'the error must tell the caller which credential is missing'
    );
    // The registry resolves nothing itself — the consumer reads the env var.
    assert.equal(process.env.FIXTURE_API_KEY, undefined);
  });

  test('list() advertises the requirement so a caller can check before running', () => {
    const entry = fixtures.list().find(t => t.id === 'fixture-keyed-api');
    assert.equal(entry.requires_api_key, true);
    assert.equal(entry.credential_ref, 'FIXTURE_API_KEY');
    assert.equal(entry.mode, 'list');
  });

  test('a supplied key builds the URL', () => {
    assert.equal(
      fixtures.get('fixture-keyed-api').listUrl({ apiKey: 'k123', city: 'Austin' }),
      'https://fixture-keyed.example/events?city=Austin&apikey=k123'
    );
  });

  test('the key is missing before any other parameter is complained about', () => {
    // Otherwise a caller fixes three params and then discovers they need a key.
    assert.throws(() => fixtures.get('fixture-keyed-api').listUrl({}), /FIXTURE_API_KEY/);
  });
});

describe('TemplateRegistry.runList', () => {
  const body = JSON.stringify({ events: [{ id: 1 }, { id: 2 }], total: 480 });

  test('the envelope mirrors run(), carrying the params the caller used', async () => {
    const params = { city: 'Austin' };
    const result = await fixtures.runList('fixture-keyed-api', body, { params });
    assert.equal(result.template, 'fixture-keyed-api');
    assert.equal(result.template_name, 'Fixture Keyed API');
    assert.deepEqual(result.params, params);
    assert.ok(!('url' in result), 'a params-only call reports no URL');
    assert.equal(result.data.count, 2);
    assert.equal(result.data.total_available, 480, 'a declared total larger than the page is kept');
    assert.match(result.extractedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('a URL-driven call carries the URL instead', async () => {
    const url = 'https://fixture-keyed.example/events?city=Austin';
    const result = await fixtures.runList('fixture-keyed-api', body, { url });
    assert.equal(result.url, url);
    assert.ok(!('params' in result));
  });

  test('an entity template is refused rather than returning a broken shape', async () => {
    await assert.rejects(
      () => fixtures.runList('fixture-entity', '{}', { url: 'https://fixture-entity.example' }),
      /returns a single entity, not a list.*Use run\(\) instead/s
    );
  });

  test('an unknown template is refused', async () => {
    await assert.rejects(() => fixtures.runList('nope', '{}', {}), /Unknown template: "nope"/);
  });
});
