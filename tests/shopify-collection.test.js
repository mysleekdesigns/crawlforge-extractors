/**
 * Unit tests: the shopify-collection template.
 *
 * Run: node --test tests/shopify-collection.test.js
 *
 * The list counterpart to shopify-product: the same authoritative endpoint,
 * /collections/<handle>/products.json, returning every product in a collection
 * rather than one. Same reason for existing — Shopify's Dawn theme ships every
 * price badge unconditionally and hides them in CSS, so a collection page
 * scraped from the DOM reports sale badges and "Sold out" that are not there.
 *
 * Fixtures are condensed from live captures taken 2026-08-28 with
 * `curl -A 'CrawlForge/1.2.4 (+https://crawlforge.dev)'`:
 *   deathwishcoffee.com/collections/all  — a sale product and a nearly-sold-out
 *                                          apparel product
 *   allbirds.com/collections/mens        — a second store, to make payload
 *                                          variance real rather than assumed
 * Only bulk was removed (extra products, images, variants). Every field and
 * value below is as the stores served it. The collection endpoint differs from
 * the product endpoint in two ways that both fixtures confirm: it carries a
 * real per-variant `available` boolean and no inventory counts, and it carries
 * no price_currency at all.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TemplateRegistry } from '../src/templates.js';

const registry = new TemplateRegistry();
const template = registry.get('shopify-collection');

const fixture = name =>
  readFileSync(new URL(`./fixtures/shopify/${name}.json`, import.meta.url), 'utf8');

const DEATH_WISH = fixture('deathwishcoffee-collection');
const ALLBIRDS = fixture('allbirds-collection');

const DEATH_WISH_URL = 'https://www.deathwishcoffee.com/collections/all/products.json';
// The live capture asked for limit=3; the fixture keeps 2 of them, so the URL
// says 2 — a page has to agree with the request that produced it for has_more
// to mean anything.
const ALLBIRDS_URL = 'https://www.allbirds.com/collections/mens/products.json?limit=2';

const run = (body, url = DEATH_WISH_URL) => template.extractList(body, url);

describe('shopify-collection URL resolution', () => {
  test('a collection page URL becomes the JSON listing', () => {
    assert.equal(
      template.resolveUrl('https://www.allbirds.com/collections/mens'),
      'https://www.allbirds.com/collections/mens/products.json'
    );
    assert.equal(
      template.resolveUrl('https://www.allbirds.com/collections/mens/'),
      'https://www.allbirds.com/collections/mens/products.json'
    );
  });

  test('a locale-prefixed path still resolves', () => {
    assert.equal(
      template.resolveUrl('https://shop.example.com/en-ca/collections/sale'),
      'https://shop.example.com/en-ca/collections/sale/products.json'
    );
  });

  test('an already-.json URL is not doubled', () => {
    assert.equal(
      template.resolveUrl('https://shop.example.com/collections/mens/products.json'),
      'https://shop.example.com/collections/mens/products.json'
    );
  });

  test('paging params survive and storefront params do not', () => {
    // sort_by and filter.* only mean something to the rendered page, and
    // several stores — allbirds among them — disallow those URLs in robots.txt.
    assert.equal(
      template.resolveUrl('https://shop.example.com/collections/mens?sort_by=price-desc&limit=50&page=2'),
      'https://shop.example.com/collections/mens/products.json?limit=50&page=2'
    );
  });

  test('a URL with no collection in it is left alone', () => {
    const url = 'https://shop.example.com/pages/about';
    assert.equal(template.resolveUrl(url), url);
  });
});

describe('shopify-collection listUrl', () => {
  test('store and collection build the endpoint', () => {
    assert.equal(
      template.listUrl({ store: 'www.allbirds.com', collection: 'mens' }),
      'https://www.allbirds.com/collections/mens/products.json'
    );
  });

  test('a store given with a scheme is accepted as-is', () => {
    assert.equal(
      template.listUrl({ store: 'https://www.deathwishcoffee.com', collection: 'all' }),
      'https://www.deathwishcoffee.com/collections/all/products.json'
    );
  });

  test('limit and page are passed through', () => {
    assert.equal(
      template.listUrl({ store: 'shop.example.com', collection: 'sale', limit: 250, page: 3 }),
      'https://shop.example.com/collections/sale/products.json?limit=250&page=3'
    );
  });

  test('a missing parameter is named', () => {
    assert.throws(() => template.listUrl({ collection: 'mens' }), /"store" parameter/);
    assert.throws(() => template.listUrl({ store: 'shop.example.com' }), /"collection" parameter/);
    assert.throws(() => template.listUrl(), /"store" parameter/);
  });

  test('a limit past Shopify\'s cap is refused, not silently truncated', () => {
    // The endpoint answers limit=1000 with at most 250 rows and says nothing.
    assert.throws(() => template.listUrl({ store: 's.example', collection: 'c', limit: 1000 }), /1 to 250/);
    assert.throws(() => template.listUrl({ store: 's.example', collection: 'c', limit: 0 }), /1 to 250/);
    assert.throws(() => template.listUrl({ store: 's.example', collection: 'c', page: 0 }), /1 or more/);
  });
});

describe('shopify-collection extraction', () => {
  test('a real collection comes back whole', () => {
    const data = run(DEATH_WISH);
    assert.equal(data.count, 2);
    assert.equal(data.count, data.items.length);
    assert.equal(data.collection, 'all');
    assert.deepEqual(data.items.map(p => p.handle), [
      '2026-death-wish-coffee-mug',
      'all-american-tank'
    ]);
  });

  test('every item carries the fields shopify-product returns for one', () => {
    for (const item of run(DEATH_WISH).items) {
      for (const field of ['title', 'vendor', 'product_type', 'handle', 'product_id', 'price',
        'compare_at_price', 'on_sale', 'price_min', 'price_max', 'available', 'variants',
        'options', 'description', 'tags', 'images', 'published_at', 'updated_at']) {
        assert.ok(field in item, `${item.handle} is missing ${field}`);
      }
    }
  });

  test('price and compare-at come straight from the store', () => {
    const [mug] = run(DEATH_WISH).items;
    assert.equal(mug.price, '34.20');
    assert.equal(mug.compare_at_price, '38.00');
    assert.equal(mug.on_sale, true);
  });

  test('a product with no compare-at price is not put on sale', () => {
    const tank = run(DEATH_WISH).items[1];
    assert.equal(tank.compare_at_price, null);
    assert.equal(tank.on_sale, false);
  });

  test('stock comes from the endpoint\'s own flag, not a badge in the markup', () => {
    // Five of six sizes of this tank were sold out when it was captured.
    const tank = run(DEATH_WISH).items[1];
    assert.deepEqual(
      tank.variants.map(v => [v.title, v.available]),
      [['S', false], ['M', false], ['L', false], ['XL', false], ['2XL', true], ['3XL', false]]
    );
    assert.equal(tank.available, true, 'one sellable size makes the product available');
  });

  test('a fully sold-out product reports false', () => {
    const soldOut = run(ALLBIRDS, ALLBIRDS_URL).items[1];
    assert.ok(soldOut.variants.every(v => v.available === false));
    assert.equal(soldOut.available, false);
  });

  test('currency is null rather than assumed — the endpoint does not send it', () => {
    for (const item of run(DEATH_WISH).items) assert.equal(item.currency, null);
  });

  test('inventory counts are null — the collection endpoint omits them', () => {
    // variantAvailable falls back to the `available` boolean here, which is why
    // stock is still correct without a count.
    const tank = run(DEATH_WISH).items[1];
    assert.ok(tank.variants.every(v => v.inventory_quantity === null));
  });

  test('multi-variant pricing reports a range', () => {
    const shoe = run(ALLBIRDS, ALLBIRDS_URL).items[0];
    assert.equal(shoe.variants.length, 3);
    assert.equal(shoe.price_min, '140.00');
    assert.equal(shoe.price_max, '140.00');
    assert.deepEqual(shoe.options, ['Size']);
  });

  test('descriptions are copy, not markup', () => {
    const [mug] = run(DEATH_WISH).items;
    assert.ok(!mug.description.includes('<'), 'body_html must be flattened');
    assert.match(mug.description, /^Mugs up to 2026\./);
  });

  test('each item is addressable', () => {
    const data = run(ALLBIRDS, ALLBIRDS_URL);
    assert.equal(data.items[0].url, 'https://www.allbirds.com/products/mens-dasher-nz-anthracite');
  });

  test('a second store parses identically — the shape is not one store\'s quirk', () => {
    const data = run(ALLBIRDS, ALLBIRDS_URL);
    assert.equal(data.collection, 'mens');
    assert.equal(data.count, 2);
    assert.ok(data.items.every(p => p.title && p.price && p.vendor === 'Allbirds'));
    assert.equal(data.items[0].tags.length, 16, 'namespaced Allbirds tags survive normalisation');
  });
});

describe('shopify-collection paging', () => {
  test('the requested limit is reported back, defaulting to the store default', () => {
    assert.equal(run(DEATH_WISH).limit, 30, 'Shopify serves 30 when no limit is sent');
    assert.equal(run(ALLBIRDS, ALLBIRDS_URL).limit, 2);
    assert.equal(run(DEATH_WISH).page, 1);
    assert.equal(run(DEATH_WISH, `${DEATH_WISH_URL}?page=4`).page, 4);
  });

  test('a full page is the only "there may be more" signal the endpoint gives', () => {
    // There is no total in the payload, so a short page is definitely the end
    // and a full one only might not be.
    assert.equal(run(ALLBIRDS, ALLBIRDS_URL).has_more, true, '2 items for a limit of 2');
    assert.equal(run(DEATH_WISH).has_more, false, '2 items for a limit of 30');
  });

  test('total_available is absent — this endpoint declares no total', () => {
    assert.ok(!('total_available' in run(DEATH_WISH)));
  });

  test('an empty collection is an answer, not an error', () => {
    // An unknown handle and a page past the end both answer 200 {"products":[]}.
    const data = run('{"products":[]}');
    assert.equal(data.count, 0);
    assert.deepEqual(data.items, []);
    assert.equal(data.has_more, false);
  });
});

describe('shopify-collection rejection', () => {
  test('a non-Shopify response fails clearly instead of returning nothing', () => {
    assert.throws(() => run('<html><body>not json</body></html>'), /Not a Shopify collection endpoint/);
    assert.throws(() => run(JSON.stringify({ items: [] })), /Not a Shopify collection endpoint/);
    assert.throws(() => run(JSON.stringify({ product: {} })), /Not a Shopify collection endpoint/);
  });
});

describe('shopify-collection registration', () => {
  test('it is registered as a list connector', () => {
    const listed = registry.list().find(t => t.id === 'shopify-collection');
    assert.ok(listed, 'template must be discoverable via list()');
    assert.equal(listed.mode, 'list');
  });

  test('detect() picks it for a collection URL and not for a product URL', () => {
    assert.equal(registry.detect('https://www.allbirds.com/collections/mens').id, 'shopify-collection');
    assert.equal(
      registry.detect('https://www.allbirds.com/collections/mens/products/dasher').id,
      'shopify-product'
    );
  });

  test('runList() dispatches to extractList and reports the URL', async () => {
    const result = await registry.runList('shopify-collection', ALLBIRDS, { url: ALLBIRDS_URL });
    assert.equal(result.template, 'shopify-collection');
    assert.equal(result.template_name, 'Shopify Collection');
    assert.equal(result.url, ALLBIRDS_URL);
    assert.equal(result.data.count, 2);
  });

  test('run() refuses it, naming the method to call instead', async () => {
    // It used to reject with "template.extract is not a function", which names
    // nothing the caller can act on. runList() has always guarded this way.
    await assert.rejects(
      () => registry.run('shopify-collection', ALLBIRDS, ALLBIRDS_URL),
      /returns a list, not a single entity\. Use runList\(\) instead/
    );
  });
});
