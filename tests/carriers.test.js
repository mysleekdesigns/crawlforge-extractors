/**
 * The JSON carriers reader (src/carriers.js): Inertia's page object, Shopify's
 * analytics meta and product JSON, and JSON objects in data-* attributes.
 *
 * Run: node --test tests/carriers.test.js
 *
 * Fixtures under tests/fixtures/embedded-state/ were captured on 2026-10-03
 * with curl -sL --compressed -A 'Mozilla/5.0 (compatible; CrawlForge/1.0;
 * +https://www.crawlforge.dev)' <url>; each file's leading comment records its
 * URL and exactly what was kept (byte-exact) and dropped:
 *   allbirds-product.html                 www.allbirds.com/products/mens-cruiser-medium-grey
 *   shopify-nativecos-product-json-id.html www.nativecos.com/products/clean-hair-trio
 *   shopify-kyomo-data-product-json.html  kyomowatches.com/products/emerald-gold-with-black-leather
 *   inertia-demo-data-page.html           demo.inertiajs.com/ (-> /login)
 *   inertia-laracasts-script.html         laracasts.com/
 *
 * What the live pages carried: allbirds.com ships its variant prices ONLY in
 * ShopifyAnalytics.meta (`var meta = {...}` copied in by a for-in loop) — no
 * data-product-json or ProductJson-* block; of the 20 storefronts probed that
 * day, only nativecos (ProductJson-*) and kyomowatches (data-product-json)
 * still had a theme product JSON block. No store used a direct
 * `ShopifyAnalytics.meta = {...}` assignment; that form is covered by a
 * synthetic test. Inertia: demo.inertiajs.com uses the classic
 * <div data-page="{&quot;..."> attribute, laracasts.com and laravel.com the
 * <script data-page="app" type="application/json"> element.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  readInertiaPage,
  isInertiaPageScript,
  readShopify,
  isShopifyProductJsonScript,
  readJsonAttributes
} from '../src/carriers.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), './fixtures/embedded-state');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

// A JSON object of at least `bytes` bytes.
const bigObject = (bytes, extra = {}) => ({ ...extra, padding: 'x'.repeat(bytes) });
const entityEncoded = (value) => JSON.stringify(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

describe('readShopify — allbirds.com product page', () => {
  const result = readShopify(fixture('allbirds-product.html'));

  test('the variants and their prices come from ShopifyAnalytics.meta', () => {
    const { product } = result.value.meta;
    assert.equal(product.handle, 'mens-cruiser-medium-grey');
    assert.equal(product.variants.length, 14);
    assert.deepEqual(product.variants[0], {
      id: 41222385270864,
      price: 10500,
      name: "Men's Cruiser - Medium Grey (Blizzard Sole) - 8",
      public_title: '8',
      sku: 'A11599M080'
    });
    assert.ok(product.variants.every((variant) => variant.price === 10500));
  });

  test('the separate currency statement is folded in, so 10500 reads as USD 105.00', () => {
    assert.equal(result.value.meta.currency, 'USD');
    assert.equal(result.value.meta.page.pageType, 'product');
  });

  test('the page has no theme product JSON block, and its other JSON scripts are not one', () => {
    assert.equal(result.value.product_json, undefined);
    assert.deepEqual(result.warnings, []);
  });
});

describe('readShopify — theme product JSON blocks', () => {
  test('id="ProductJson-…" (nativecos.com) is parsed with variants and prices', () => {
    const { value, warnings } = readShopify(fixture('shopify-nativecos-product-json-id.html'));
    assert.deepEqual(warnings, []);
    assert.equal(value.product_json.length, 1);
    const [product] = value.product_json;
    assert.equal(product.handle, 'clean-hair-trio');
    assert.equal(product.variants.length, 3);
    assert.equal(product.variants[0].price, 2800);
    assert.equal(value.meta.product.variants.length, 3);
    assert.equal(value.meta.currency, 'USD');
  });

  test('data-product-json (kyomowatches.com) is returned in the theme\'s own shape', () => {
    const { value, warnings } = readShopify(fixture('shopify-kyomo-data-product-json.html'));
    assert.deepEqual(warnings, []);
    assert.deepEqual(Object.keys(value.product_json[0]), ['product', 'selected_variant_id']);
    assert.equal(value.product_json[0].product.handle, 'emerald-gold-with-black-leather');
    assert.equal(value.meta.product.variants[0].price, 21700);
    assert.equal(value.meta.currency, 'EUR');
  });

  test('a broken product JSON block is a warning, not a throw', () => {
    const html = '<script type="application/json" data-product-json>{"product": </script>';
    const result = readShopify(html);
    assert.deepEqual(result.value, {});
    assert.match(result.warnings[0], /product JSON <script> block is not valid JSON/);
  });
});

describe('readShopify — ShopifyAnalytics.meta forms', () => {
  test('a direct object assignment is read (synthetic: not seen on a live store)', () => {
    const html = '<script>window.ShopifyAnalytics.meta = {"page":{"pageType":"home"}};</script>';
    assert.deepEqual(readShopify(html), { value: { meta: { page: { pageType: 'home' } } }, warnings: [] });
  });

  test('`meta = window.ShopifyAnalytics.meta || {}` alone is not state', () => {
    const html = '<script>window.ShopifyAnalytics.meta = window.ShopifyAnalytics.meta || {};</script>';
    assert.equal(readShopify(html), null);
  });

  test('a `var meta` with no ShopifyAnalytics copy loop is not Shopify\'s', () => {
    assert.equal(readShopify('<script>var meta = {"a":1};</script>'), null);
  });

  test('a JS (non-JSON) meta literal is reported, not dropped silently', () => {
    const html =
      '<script>var meta = {product: {id: 1}};\nfor (var attr in meta) { window.ShopifyAnalytics.meta[attr] = meta[attr]; }</script>';
    const result = readShopify(html);
    assert.deepEqual(result.value, {});
    assert.match(result.warnings[0], /ShopifyAnalytics\.meta .* not a JSON literal/);
  });

  test('an unterminated meta literal does not throw', () => {
    const html = '<script>var meta = {"product":{"id":1;\nfor (var attr in meta) { window.ShopifyAnalytics.meta[attr] = meta[attr]; }';
    assert.equal(readShopify(html).warnings.length, 1);
  });

  test('a page with neither carrier, or no string, is null', () => {
    assert.equal(readShopify('<html><body>hi</body></html>'), null);
    assert.equal(readShopify(undefined), null);
  });
});

describe('isShopifyProductJsonScript', () => {
  test('matches the two theme forms', () => {
    assert.equal(isShopifyProductJsonScript(' type="application/json" data-product-json'), true);
    assert.equal(isShopifyProductJsonScript(' type="application/json" id="ProductJson-template--27654679756974__main"'), true);
    assert.equal(isShopifyProductJsonScript(" id='ProductJson-x' type='application/json'"), true);
  });

  test('rejects other JSON scripts and look-alike attributes', () => {
    assert.equal(isShopifyProductJsonScript(' id="shopify-features" type="application/json"'), false);
    assert.equal(isShopifyProductJsonScript(' type="application/json" data-product-json-extra'), false);
    assert.equal(isShopifyProductJsonScript(' type="text/javascript" data-product-json'), false);
    assert.equal(isShopifyProductJsonScript(' type="application/json" id="MyProductJson-1"'), false);
    assert.equal(isShopifyProductJsonScript(undefined), false);
  });
});

describe('readInertiaPage', () => {
  test('classic <div data-page="{&quot;…"> (demo.inertiajs.com)', () => {
    const { value, warnings } = readInertiaPage(fixture('inertia-demo-data-page.html'));
    assert.deepEqual(warnings, []);
    assert.equal(value.component, 'Auth/Login');
    assert.deepEqual(value.props, { errors: {}, auth: { user: null }, flash: { success: null, error: null } });
    assert.equal(value.url, '/login');
    assert.equal(value.version, 'b00b9c1be26a6c28d7b36b0a5820a8a3');
  });

  test('<script data-page="app" type="application/json"> (laracasts.com)', () => {
    const { value, warnings } = readInertiaPage(fixture('inertia-laracasts-script.html'));
    assert.deepEqual(warnings, []);
    assert.equal(value.component, 'Home/Home');
    assert.equal(value.url, '/');
    assert.equal(value.version, 'b5182fe9bd9e9f99485a64a40c47f205');
    assert.equal(value.props.featuredSeries.length, 30);
    assert.equal(value.props.featuredSeries[0].title, 'Customizing Filament For User-Facing Apps');
    assert.equal(value.props.instructors.length, 35);
  });

  test('isInertiaPageScript recognises only the script carrier', () => {
    assert.equal(isInertiaPageScript(' data-page="app" type="application/json"'), true);
    assert.equal(isInertiaPageScript(' type="application/json" id="x"'), false);
    assert.equal(isInertiaPageScript(' data-page="app"'), false);
  });

  test('a page without Inertia, or with only a data-page root id, is null', () => {
    assert.equal(readInertiaPage(fixture('allbirds-product.html')), null);
    assert.equal(readInertiaPage('<div id="app" data-page="app"></div>'), null);
    assert.equal(readInertiaPage(null), null);
  });

  test('a commented-out carrier is ignored', () => {
    assert.equal(readInertiaPage('<!-- <div data-page="{&quot;component&quot;:&quot;X&quot;}"></div> -->'), null);
  });

  test('broken JSON is a warning with a null value, in either form', () => {
    const attrForm = readInertiaPage('<div id="app" data-page="{&quot;component&quot;:"></div>');
    assert.equal(attrForm.value, null);
    assert.match(attrForm.warnings[0], /data-page attribute .* not a JSON object/);

    const scriptForm = readInertiaPage('<script data-page="app" type="application/json">{"component":</script>');
    assert.equal(scriptForm.value, null);
    assert.match(scriptForm.warnings[0], /<script data-page/);
  });

  test('an unterminated data-page attribute does not throw', () => {
    assert.equal(readInertiaPage('<div data-page="{&quot;component&quot;:1' + 'x'.repeat(10000)), null);
  });
});

describe('readJsonAttributes', () => {
  test('allbirds.com: the two JSON objects over 2 KB on the product element', () => {
    const found = readJsonAttributes(fixture('allbirds-product.html'));
    assert.deepEqual(
      found.map(({ tag, attribute, id }) => ({ tag, attribute, id })),
      [
        { tag: 'div', attribute: 'data-product-object', id: null },
        { tag: 'div', attribute: 'data-colorway-variants', id: null }
      ]
    );
    // Single-quoted raw JSON with a leading newline.
    const product = found[0].data;
    assert.equal(product.handle, 'mens-cruiser-medium-grey');
    assert.equal(product.price, 10500);
    assert.equal(product.sizes['8'].sku, 'A11599M080');
    // &quot;-encoded JSON.
    assert.ok(Array.isArray(found[1].data['mens-cruiser-verdant-green']));
    assert.equal(found[1].data['mens-cruiser-verdant-green'][0].title, '8');
  });

  test('allbirds.com: arrays and small objects are not reported even under a low threshold', () => {
    const found = readJsonAttributes(fixture('allbirds-product.html'), { minBytes: 2 });
    const names = found.map((entry) => entry.attribute);
    // data-product-tags (an 882-byte array) and data-gallery-lifestyle-images ('[]')
    assert.ok(!names.includes('data-product-tags'));
    assert.ok(!names.includes('data-gallery-lifestyle-images'));
    // the small data-shopify-remote-tracking object qualifies only at this threshold
    assert.ok(names.includes('data-shopify-remote-tracking'));
  });

  test('skips data-page — readInertiaPage owns it', () => {
    assert.deepEqual(readJsonAttributes(fixture('inertia-demo-data-page.html'), { minBytes: 2 }), []);
    const html = `<div id="app" data-page="${entityEncoded(bigObject(3000, { component: 'X' }))}"></div>`;
    assert.deepEqual(readJsonAttributes(html), []);
  });

  test('reads the tag\'s id wherever it sits in the tag, entity-decoded', () => {
    const value = entityEncoded(bigObject(3000, { a: '<b> & "c"' }));
    const html =
      `<section class="x" data-config="${value}" hidden id="hero&amp;main">` +
      `<span id='first' data-state='${JSON.stringify(bigObject(2500))}'></span></section>`;
    const found = readJsonAttributes(html);
    assert.equal(found.length, 2);
    assert.deepEqual(
      { tag: found[0].tag, attribute: found[0].attribute, id: found[0].id },
      { tag: 'section', attribute: 'data-config', id: 'hero&main' }
    );
    assert.equal(found[0].data.a, '<b> & "c"');
    assert.equal(found[1].id, 'first');
  });

  test('ignores values under 2 KB, arrays, and invalid JSON', () => {
    const html =
      `<div data-small="${entityEncoded({ a: 1 })}"></div>` +
      `<div data-list="${entityEncoded([bigObject(3000)])}"></div>` +
      `<div data-broken='{"a": ${'1'.repeat(3000)},}'></div>` +
      `<div data-text="${'{'.repeat(1) + 'y'.repeat(3000) + '}'}"></div>`;
    assert.deepEqual(readJsonAttributes(html), []);
  });

  test('caps the result at 50 without throwing', () => {
    const one = `<i data-x='${JSON.stringify(bigObject(2100))}'></i>`;
    assert.equal(readJsonAttributes(one.repeat(60)).length, 50);
  });

  test('hostile input: unterminated attribute, huge attribute, no string', () => {
    assert.deepEqual(readJsonAttributes(`<div data-x='{"a":"${'z'.repeat(5000)}`), []);
    const huge = `<div data-x='${JSON.stringify(bigObject(6 * 1024 * 1024))}'></div>`;
    assert.deepEqual(readJsonAttributes(huge), []);
    const large = `<div data-x='${JSON.stringify(bigObject(1024 * 1024))}'></div>`;
    assert.equal(readJsonAttributes(large).length, 1);
    assert.deepEqual(readJsonAttributes(undefined), []);
  });

  test('stays linear on a page of unclosed quotes and tag openers', () => {
    const html = '<a data-x="{'.repeat(50000) + "<b data-y='{".repeat(50000);
    const start = Date.now();
    assert.deepEqual(readJsonAttributes(html), []);
    assert.equal(readInertiaPage(html), null);
    assert.equal(readShopify(html), null);
    assert.ok(Date.now() - start < 2000, `took ${Date.now() - start} ms`);
  });
});
