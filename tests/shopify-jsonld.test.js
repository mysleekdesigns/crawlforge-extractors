/**
 * Unit tests: shopifyProductFromJsonLd (src/shopifyJsonLd.js).
 *
 * Run: node --test tests/shopify-jsonld.test.js
 *
 * tests/fixtures/shopify/gymshark-productgroup.json is the ProductGroup block
 * from https://www.gymshark.com/products/gymshark-arrival-5-shorts-black-ss22,
 * captured 2026-09-04 with the CrawlForge UA, condensed to two of its seven
 * size variants with review, aggregateRating and additionalProperty removed
 * and the descriptions cut short. The store answers /products/<handle>.json
 * with 403, which is why this reader exists.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { shopifyProductFromJsonLd } from '../src/shopifyJsonLd.js';
import { shopifyProductFromJsonLd as fromIndex } from '../index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), './fixtures/shopify');
const GYMSHARK = readFileSync(join(FIXTURES, 'gymshark-productgroup.json'), 'utf8');

const page = (...blocks) =>
  `<html><head><title>Store</title>${blocks
    .map((b) => `<script type="application/ld+json">${typeof b === 'string' ? b : JSON.stringify(b)}</script>`)
    .join('')}</head><body><h1>Product</h1></body></html>`;

const WEBPAGE = { '@context': 'https://schema.org', '@type': 'WebPage', name: 'A page' };

describe('ProductGroup with one Product per size (gymshark capture)', () => {
  const out = shopifyProductFromJsonLd(page(WEBPAGE, GYMSHARK), 'https://www.gymshark.com/products/gymshark-arrival-5-shorts-black-ss22');

  test('is found and reported as json-ld', () => {
    assert.equal(out.found, true);
    assert.equal(out.data.source, 'json-ld');
  });

  test('group-level fields, with entities decoded', () => {
    const d = out.data;
    assert.equal(d.title, 'Arrival 5" Shorts');
    assert.equal(d.vendor, 'Gymshark | We Do Gym');
    assert.equal(d.product_type, 'shorts');
    assert.equal(d.handle, 'gymshark-arrival-5-shorts-black-ss22');
    assert.equal(d.product_id, '6804846346442');
    assert.deepEqual(d.options, ['size']);
    assert.equal(d.url, 'https://www.gymshark.com/products/gymshark-arrival-5-shorts-black-ss22');
    assert.deepEqual(d.images, ['https://cdn.shopify.com/s/files/1/0156/6146/files/images-Arrival5ShortsBlackA2A1M_BBBB_1826_A_Edit.jpg?v=1750084637']);
  });

  test('price and availability come from the variants', () => {
    const d = out.data;
    assert.equal(d.price, '26.00');
    assert.equal(d.price_min, '26.00');
    assert.equal(d.price_max, '26.00');
    assert.equal(d.currency, 'USD');
    assert.equal(d.available, true);
    assert.equal(d.compare_at_price, null);
    assert.equal(d.on_sale, null);
  });

  test('each size is a variant keyed by mpn, with no stock count', () => {
    assert.deepEqual(out.data.variants.map((v) => [v.id, v.sku, v.price, v.available, v.options, v.inventory_quantity]), [
      ['A2A1M-BBBB-XS', 'A2A1M-BBBB', '26.00', true, ['xs'], null],
      ['A2A1M-BBBB-S', 'A2A1M-BBBB', '26.00', true, ['s'], null]
    ]);
  });

  test('is exported from the package entry point', () => {
    assert.equal(fromIndex, shopifyProductFromJsonLd);
  });
});

describe('a plain Product with offers', () => {
  const product = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Crest Hoodie',
    brand: { '@type': 'Brand', name: 'Acme' },
    sku: 'B1A2',
    description: '  A heavyweight\n hoodie. ',
    image: ['https://cdn.example/1.jpg', { '@type': 'ImageObject', url: 'https://cdn.example/2.jpg' }, 'javascript:alert(1)'],
    offers: [
      { '@type': 'Offer', price: '50.00', priceCurrency: 'GBP', availability: 'https://schema.org/InStock', sku: 'B1A2-S', name: 'S' },
      { '@type': 'Offer', price: 55, priceCurrency: 'GBP', availability: 'https://schema.org/OutOfStock', sku: 'B1A2-M', name: 'M' }
    ]
  };

  test('offers become variants; a malformed block beside it is skipped', () => {
    const out = shopifyProductFromJsonLd(page(WEBPAGE, '{not json', product), 'https://store.example/products/crest-hoodie?variant=1');
    assert.equal(out.found, true);
    const d = out.data;
    assert.equal(d.title, 'Crest Hoodie');
    assert.equal(d.vendor, 'Acme');
    assert.equal(d.handle, 'crest-hoodie');
    assert.equal(d.product_id, 'B1A2');
    assert.equal(d.price, '50.00');
    assert.equal(d.price_max, '55.00');
    assert.equal(d.currency, 'GBP');
    assert.equal(d.available, true);
    assert.deepEqual(d.variants.map((v) => [v.title, v.price, v.available]), [['S', '50.00', true], ['M', '55.00', false]]);
    assert.equal(d.description, 'A heavyweight hoodie.');
    assert.deepEqual(d.images, ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg'], 'a javascript: image URL is dropped');
    assert.equal(d.url, 'https://store.example/products/crest-hoodie?variant=1', 'no url in the JSON-LD: the page URL stands');
  });

  test('an AggregateOffer inside @graph', () => {
    const graph = { '@context': 'https://schema.org', '@graph': [WEBPAGE, {
      '@type': ['Product'], name: 'Watch', brand: 'Omega',
      offers: { '@type': 'AggregateOffer', lowPrice: '1,299.00', highPrice: '1,499.00', priceCurrency: 'USD', availability: 'InStock' }
    }] };
    const out = shopifyProductFromJsonLd(page(graph), 'https://store.example/products/watch');
    assert.equal(out.found, true);
    assert.equal(out.data.vendor, 'Omega');
    assert.equal(out.data.price, '1299.00');
    assert.equal(out.data.price_max, '1499.00');
    assert.equal(out.data.available, true);
  });
});

describe('pages without a product', () => {
  test('a collection page names the retired handle', () => {
    const out = shopifyProductFromJsonLd(page(WEBPAGE), 'https://store.example/collections/all');
    assert.equal(out.found, false);
    assert.match(out.reason, /no schema\.org Product JSON-LD/);
    assert.match(out.reason, /redirected to a collection page/);
  });

  test('any other page says only that nothing was found', () => {
    const out = shopifyProductFromJsonLd('<html><body>nothing</body></html>', 'https://store.example/products/x');
    assert.equal(out.found, false);
    assert.doesNotMatch(out.reason, /collection/);
  });

  test('empty input', () => {
    assert.equal(shopifyProductFromJsonLd('', 'https://store.example/products/x').found, false);
  });
});
