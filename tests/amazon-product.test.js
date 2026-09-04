/**
 * Unit tests: the amazon-product template.
 *
 * Run: node --test tests/unit/amazonProductTemplate.test.js
 *
 * Regression (2026-08-25): against three live product pages the template
 * returned null for currency, rating, images and breadcrumbs, and returned
 * "Brand: Amazon" / "(198,594)" verbatim. The selectors it used — a
 * priceCurrency meta tag, #acrPopover .a-size-base, img.a-thumbnail-image —
 * do not exist on any current Amazon page; the fixtures had been written to
 * match the selectors rather than the site.
 *
 * Markup below is condensed from live captures (a first-party device, a
 * branded storefront and a book), which between them cover the three shapes
 * Amazon's byline, description and breadcrumb slots take.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TemplateRegistry } from '../src/templates.js';

const registry = new TemplateRegistry();

const run = async (html) =>
  (await registry.run('amazon-product', `<html><body>${html}</body></html>`, 'https://www.amazon.com/dp/B000000000')).data;

describe('amazon-product byline', () => {
  test('a first-party device drops the "Brand:" label', async () => {
    assert.equal((await run('<a id="bylineInfo">Brand: Amazon</a>')).brand, 'Amazon');
  });

  test('a branded storefront drops the "Visit the ... Store" wrapper', async () => {
    assert.equal((await run('<a id="bylineInfo">Visit the Apple Store</a>')).brand, 'Apple');
  });

  test('a book byline yields the author, not the surrounding chrome', async () => {
    const html = `<div id="bylineInfo">by
        <span class="author"><a class="contributorNameID">Jonathan Haidt</a></span>
        (Author) Format: Hardcover</div>`;
    assert.equal((await run(html)).brand, 'Jonathan Haidt');
  });

  test('a book byline with no contributor link still loses the chrome', async () => {
    assert.equal((await run('<div id="bylineInfo">by Ursula K. Le Guin (Author)</div>')).brand, 'Ursula K. Le Guin');
  });

  test('an unrecognised byline is passed through rather than dropped', async () => {
    assert.equal((await run('<a id="bylineInfo">Acme Industries</a>')).brand, 'Acme Industries');
  });

  test('no byline is null', async () => {
    assert.equal((await run('<span id="productTitle">Thing</span>')).brand, null);
  });
});

describe('amazon-product rating and review count', () => {
  test('the rating comes off the popover title as a number', async () => {
    assert.equal((await run('<span id="acrPopover" title="4.7 out of 5 stars"></span>')).rating, 4.7);
  });

  test('the star icon is the fallback when the popover carries no title', async () => {
    const html = '<div id="averageCustomerReviews"><span class="a-icon-alt">4.6 out of 5 stars</span></div>';
    assert.equal((await run(html)).rating, 4.6);
  });

  test('a parenthesised review count becomes a number', async () => {
    // Live pages render "(198,594)" — previously returned verbatim.
    assert.equal((await run('<span id="acrCustomerReviewText">(198,594)</span>')).review_count, 198594);
  });

  test('the "N global ratings" wording parses to the same number', async () => {
    const html = '<span data-hook="total-review-count">198,594 global ratings</span>';
    assert.equal((await run(html)).review_count, 198594);
  });

  test('an unrated product reports null, not zero', async () => {
    const data = await run('<span id="productTitle">Thing</span>');
    assert.equal(data.rating, null);
    assert.equal(data.review_count, null);
  });
});

describe('amazon-product price', () => {
  const triplet = (offscreen, whole, fraction, decimal = '') =>
    `<span class="a-price"><span class="a-offscreen">${offscreen}</span>` +
    `<span class="a-price-symbol">$</span><span class="a-price-whole">${whole}` +
    `<span class="a-price-decimal">${decimal}</span></span>` +
    `<span class="a-price-fraction">${fraction}</span></span>`;

  test('amazon.com.au: an empty decimal span no longer yields a price 100× too high', async () => {
    // Live 2026-09-04: /dp/0141036141 rendered the offscreen string "$1105"
    // for A$11.05 — whole "11", fraction "05", decimal span empty.
    assert.equal((await run(triplet('$1105', '11', '05'))).price, '$11.05');
    assert.equal((await run(triplet('$799', '7', '99'))).price, '$7.99');
  });

  test('a well-formed offscreen price is passed through untouched', async () => {
    assert.equal((await run(triplet('$1,105.00', '1,105', '00', '.'))).price, '$1,105.00');
    assert.equal((await run(triplet('$105.05', '105', '05', '.'))).price, '$105.05');
    assert.equal((await run('<span class="a-price"><span class="a-offscreen">52,02USD</span></span>')).price, '52,02USD');
  });

  test('a comma marketplace gets its comma back', async () => {
    const html = '<link rel="canonical" href="https://www.amazon.de/dp/B000000000">' + triplet('4599 €', '45', '99');
    assert.equal((await run(html)).price, '45,99 €');
  });
});

describe('amazon-product currency', () => {
  test('the ISO code comes off the add-to-cart form', async () => {
    // Amazon ships no priceCurrency meta tag on any current page.
    const html = '<input type="hidden" name="items[0.base][customerVisiblePrice][currencyCode]" value="USD">';
    assert.equal((await run(html)).currency, 'USD');
  });

  test('a schema.org meta tag is still honoured where present', async () => {
    assert.equal((await run('<meta itemprop="priceCurrency" content="GBP">')).currency, 'GBP');
  });

  test('with no form and no meta tag, the code is read off the price', async () => {
    // amazon.de and amazon.in book pages (R14, 2026-09-03) render no buy-box
    // form; the price is what carries the currency.
    const price = (p) => `<span class="a-price"><span class="a-offscreen">${p}</span></span>`;
    assert.equal((await run(price('52,02USD'))).currency, 'USD');
    assert.equal((await run(price('₹1,950.00'))).currency, 'INR');
    assert.equal((await run(price('45,99 €'))).currency, 'EUR');
    assert.equal((await run(price('£31.99'))).currency, 'GBP');
  });

  test('a bare "$" is the marketplace dollar, told by the canonical host', async () => {
    const page = (host) =>
      `<link rel="canonical" href="https://${host}/dp/B000000000">` +
      '<span class="a-price"><span class="a-offscreen">$12.99</span></span>';
    assert.equal((await run(page('www.amazon.ca'))).currency, 'CAD');
    assert.equal((await run(page('www.amazon.com.au'))).currency, 'AUD');
    assert.equal((await run(page('www.amazon.com'))).currency, 'USD');
  });

  test('no price, no currency', async () => {
    assert.equal((await run('<span id="productTitle">x</span>')).currency, null);
  });
});

describe('amazon-product images', () => {
  const MAIN = 'https://m.media-amazon.com/images/I/61J2sQtBYDL._AC_SY300_SX300_QL70_.jpg';
  const THUMB = 'https://m.media-amazon.com/images/I/31vkCUuIWCL._AC_SR40,60_.jpg';
  const PIXEL = 'https://images-na.ssl-images-amazon.com/images/G/01/x-locale/common/transparent-pixel._V192234675_.gif';

  test('thumbnails are upsized to the original by dropping the size token', async () => {
    // Verified live 2026-08-25: the tokened URL is a 1KB thumbnail, the same
    // URL without it is the 16KB original.
    const data = await run(`<img id="landingImage" src="${MAIN}"><div id="altImages"><img src="${THUMB}"></div>`);
    assert.deepEqual(data.images, [
      'https://m.media-amazon.com/images/I/61J2sQtBYDL.jpg',
      'https://m.media-amazon.com/images/I/31vkCUuIWCL.jpg'
    ]);
  });

  test('the spacer gif padding the thumbnail strip is not an image', async () => {
    const data = await run(`<div id="altImages"><img src="${THUMB}"><img src="${PIXEL}"></div>`);
    assert.equal(data.images.length, 1);
  });

  test('the main image is not repeated when it also appears as a thumbnail', async () => {
    const data = await run(`<img id="landingImage" src="${MAIN}"><div id="altImages"><img src="${MAIN}"></div>`);
    assert.deepEqual(data.images, ['https://m.media-amazon.com/images/I/61J2sQtBYDL.jpg']);
  });

  test('a product with no gallery reports an empty list', async () => {
    assert.deepEqual((await run('<span id="productTitle">Thing</span>')).images, []);
  });
});

describe('amazon-product description', () => {
  test('feature bullets are joined without the surrounding markup chrome', async () => {
    const html = `<div id="feature-bullets"><ul>
      <li><span class="a-list-item">First   point.</span></li>
      <li><span class="a-list-item">Second point.</span></li>
    </ul><a href="#">› See more product details</a></div>`;
    assert.equal((await run(html)).description, 'First point. Second point.');
  });

  test('a book falls back to its own description container', async () => {
    // Books have neither #productDescription nor feature bullets.
    const html = '<div id="bookDescription_feature_div"><div class="a-expander-content"><p>A book\nabout books.</p></div></div>';
    assert.equal((await run(html)).description, 'A book about books.');
  });

  test('an explicit product description wins over the bullets', async () => {
    const html = `<div id="productDescription"><p>The full write-up.</p></div>
      <div id="feature-bullets"><ul><li><span class="a-list-item">A bullet.</span></li></ul></div>`;
    assert.equal((await run(html)).description, 'The full write-up.');
  });
});

describe('amazon-product page facts', () => {
  test('whitespace Amazon leaves in the title is collapsed', async () => {
    const data = await run('<span id="productTitle">\n   Echo Dot   (newest\n model)\n  </span>');
    assert.equal(data.title, 'Echo Dot (newest model)');
  });

  test('the availability blurb is not polluted by the JSON blob beside it', async () => {
    // #availability also contains an inline script on live pages.
    const html = '<div id="availability"><span>In Stock</span><script>{"asin":"B09B8V1LZ3"}</script></div>';
    assert.equal((await run(html)).availability, 'In Stock');
  });

  test('breadcrumbs are read where the page has them', async () => {
    const html = '<div id="wayfinding-breadcrumbs_feature_div"><a>Books</a><a>Parenting</a></div>';
    assert.deepEqual((await run(html)).category_breadcrumb, ['Books', 'Parenting']);
  });

  test('a device page with no breadcrumbs reports an empty list', async () => {
    // Not a defect: device pages genuinely ship no breadcrumb trail.
    assert.deepEqual((await run('<span id="productTitle">Echo Dot</span>')).category_breadcrumb, []);
  });
});

describe('amazon-product interstitial and empty-record guards', () => {
  // amazon.es answered an HTTP 200 "Seguir comprando" robot check whose only
  // form posts to /errors/validateCaptcha; the template returned success with
  // every field null (observed live 2026-09-01).
  test('a captcha interstitial fails loudly instead of returning an all-null record', async () => {
    const interstitial = `
      <h4>Escribe los caracteres que ves en la imagen</h4>
      <form method="get" action="/errors/validateCaptcha" name="">
        <input type="hidden" name="amzn" value="x"><input type="text" name="field-keywords">
      </form>
      <!-- api-services-support@amazon.com -->`;
    await assert.rejects(() => run(interstitial), /captcha interstitial/);
  });

  test('an unrecognised page with no product markup fails loudly, not all-null', async () => {
    await assert.rejects(
      () => run('<div><p>Something went wrong.</p></div>'),
      /extracted no data — every field came back empty/
    );
  });
});

// Round 16 (2026-09-04): rating and price on the pages that are not amazon.com.
describe('amazon-product rating on comma-decimal and Japanese marketplaces', () => {
  const popover = (title) => `<span id="acrPopover" title="${title}"></span>`;

  test('a comma decimal is a decimal, not the integer part', async () => {
    // Live 2026-09-04: every one of these read as 4.
    assert.equal((await run(popover('4,8 van 5 sterren'))).rating, 4.8);
    assert.equal((await run(popover('4,8 su 5 stelle'))).rating, 4.8);
    assert.equal((await run(popover('4,8 von 5 Sternen'))).rating, 4.8);
  });

  test('amazon.co.jp states the scale first', async () => {
    // Live 2026-09-04: "5つ星のうち4.7" read as 5 — the scale, not the rating.
    assert.equal((await run(popover('5つ星のうち4.7'))).rating, 4.7);
  });

  test('a perfect score is still 5', async () => {
    assert.equal((await run(popover('5.0 out of 5 stars'))).rating, 5);
    assert.equal((await run(popover('5 out of 5 stars'))).rating, 5);
  });
});

describe('amazon-product price comes from the buy box, never from another product', () => {
  const block = (cls, offscreen, symbol, whole, fraction, { symbolLast = false, decimal = '.' } = {}) => {
    const sym = `<span class="a-price-symbol">${symbol}</span>`;
    const digits =
      `<span class="a-price-whole">${whole}<span class="a-price-decimal">${decimal}</span></span>` +
      `<span class="a-price-fraction">${fraction}</span>`;
    return `<span class="${cls}"><span class="a-offscreen">${offscreen}</span>` +
      (symbolLast ? digits + sym : sym + digits) + '</span>';
  };
  const carousel = (...prices) =>
    `<div id="sims-simsContainer_feature_div_0">${prices.map((p) => block('a-price', p, '$', p.slice(1, -3), p.slice(-2))).join('')}</div>`;
  const swatch = (label) =>
    `<div id="tmmSwatches"><span class="swatchElement selected"><span class="slot-price"><span>${label}</span></span></span></div>`;

  test('a blank offscreen span in the buy box is rebuilt from the visible digits', async () => {
    // Live 2026-09-04: amazon.co.uk and amazon.com.au buy boxes carry
    // <span class="a-offscreen"> </span>; both pages returned price: null.
    const buyBox = `<div id="corePriceDisplay_desktop_feature_div">${block('a-price priceToPay', ' ', '£', '39', '24')}</div>`;
    assert.equal((await run(buyBox)).price, '£39.24');
  });

  test('the rebuilt price keeps the marketplace separator and symbol side', async () => {
    const nl = '<link rel="canonical" href="https://www.amazon.nl/dp/B000000000">' +
      block('a-price priceToPay', ' ', '€', '44', '85', { decimal: ',' });
    assert.equal((await run(nl)).price, '€44,85');
    const it = '<link rel="canonical" href="https://www.amazon.it/dp/B000000000">' +
      block('a-price priceToPay', ' ', '€', '32', '89', { decimal: ',', symbolLast: true });
    assert.equal((await run(it)).price, '32,89€');
  });

  test('the buy box wins over an earlier struck-through list price and later carousels', async () => {
    const html =
      block('a-price a-text-price', '£47.99', '£', '47', '99') +
      `<div id="corePriceDisplay_desktop_feature_div">${block('a-price priceToPay', '£39.24', '£', '39', '24')}</div>` +
      carousel('$31.45', '$34.53');
    assert.equal((await run(html)).price, '£39.24');
  });

  test('with no buy box, a carousel price is never the product price', async () => {
    // Live 2026-09-04: amazon.de/.it/.co.jp book pages without a buy box
    // returned the first "similar products" price as the book's price.
    const html = carousel('$52.13', '$41.71') + swatch('ab 30,57 USD');
    const data = await run(html);
    assert.equal(data.price, 'ab 30,57 USD');
    assert.equal(data.currency, 'USD');
    assert.equal((await run('<span id="productTitle">Book</span>' + carousel('$52.13'))).price, null);
  });

  test('empty range placeholders in the buy box fall through to the swatch', async () => {
    // Live 2026-09-04: amazon.ca renders priceToPayRangeMin/Max with no text.
    const html =
      '<div id="corePrice_feature_div"><span class="a-price priceToPayRangeMin"><span class="a-offscreen"></span></span></div>' +
      swatch('from $46.88');
    assert.equal((await run(html)).price, 'from $46.88');
  });
});
