/**
 * TemplateRegistry — pre-built scraping templates for popular sites.
 *
 * Shared by the CrawlForge MCP server and the REST API. Edit here only —
 * neither consumer keeps a copy.
 *
 * Each template is a self-contained object with:
 *   id            — unique slug used as the `template` parameter
 *   name          — human-readable name
 *   description   — when to use this template
 *   targetPattern — regex matching URLs this template handles
 *   selectors     — CSS selectors mapping field names to DOM locations
 *   postProcess   — optional function(raw: Object) → Object for cleanup
 *
 * Templates do NOT make network calls. The caller fetches the page and passes
 * the body in; that keeps SSRF policy, timeouts and billing with the surface
 * that owns them. resolveUrl/listUrl rewrite or build the target, so the caller
 * must apply its SSRF policy to the URL they RETURN (and to every redirect the
 * fetch follows), not just to the URL the caller started with.
 *
 * Two optional hooks let a template read a machine-readable endpoint instead of
 * scraping the rendered page, without taking the fetch into its own hands:
 *   resolveUrl(url)      — rewrite the URL the tool should fetch
 *   extractRaw(body,url) — parse the response itself, instead of extract($)
 *
 * Two more turn a template into a *list connector*, returning N entities from
 * one call rather than one entity from one page:
 *   listUrl(params)       — build the URL to fetch from a plain params object.
 *                           Throws naming the parameter when a required one is
 *                           missing.
 *   extractList(body,url) — parse the response into { items, count, … }.
 * Defining extractList is the only signal that a template is a list connector;
 * there is no `kind` field. A list connector may also define
 * resolveUrl/targetPattern, so a caller can pass a URL instead of params.
 *
 * A connector against a key-based API declares it:
 *   requiresApiKey: true
 *   credentialRef: 'SOME_ENV_VAR'  — the env var the CONSUMER reads
 * The registry stays pure and never touches process.env. The key arrives as
 * params.apiKey, and listUrl throws naming credentialRef when it is absent.
 */

import { load } from 'cheerio';

// Connector families live in their own files — the job-board and government-API
// sets each carry their own helpers and fixtures, and keeping them here would
// have made one file the whole package.
import { ATS_TEMPLATES } from './connectors/ats.js';
import { GOV_TEMPLATES } from './connectors/gov.js';
import { extractApolloTransport } from './embeddedState.js';
import { safeHref } from './urls.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function text($, sel) {
  return $(sel).first().text().trim() || null;
}

function attr($, sel, attribute) {
  return $(sel).first().attr(attribute) || null;
}

function list($, sel) {
  return $(sel).map((_, el) => $(el).text().trim()).get().filter(Boolean);
}

function listAttr($, sel, attribute) {
  return $(sel).map((_, el) => $(el).attr(attribute)).get().filter(Boolean);
}

/** A URL a caller supplied is not guaranteed to be one. Returns null instead of throwing. */
function safeUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// ── Shopify helpers ──────────────────────────────────────────────────────────

/** Shopify writes an absent compare-at price as "" rather than omitting it. */
function money(value) {
  return value === '' || value === null || value === undefined ? null : String(value);
}

/**
 * A compare-at price of 0 means "unset", not "was free" — Allbirds ships
 * "0.00" where Death Wish ships "". Both render as no sale badge, so both read
 * as null here. Only compare-at prices are zero-normalised: a `price` of 0.00
 * is a genuinely free product.
 */
function compareAtPrice(value) {
  const raw = money(value);
  return raw !== null && Number.parseFloat(raw) === 0 ? null : raw;
}

/**
 * Whether a variant can be bought.
 *
 * The product JSON endpoint does not carry the storefront's `available` flag,
 * so it is derived: an untracked variant is always sellable, a variant whose
 * policy allows overselling is always sellable, and otherwise it comes down to
 * stock on hand. Returns null when the payload does not say — better than
 * guessing "in stock" for something sold out.
 */
function variantAvailable(variant) {
  if (typeof variant.available === 'boolean') return variant.available;
  if (!variant.inventory_management) return true;
  if (variant.inventory_policy === 'continue') return true;
  return typeof variant.inventory_quantity === 'number' ? variant.inventory_quantity > 0 : null;
}

/** Shopify returns tags as an array on some stores and a comma-joined string on others. */
function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string') return tags.split(',').map(t => t.trim()).filter(Boolean);
  return [];
}

/** body_html is a rendered HTML fragment; callers want the copy, not the markup. */
/** Stack Exchange timestamps are epoch seconds. */
function epochToIso(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null;
}

/**
 * Stack Exchange API filter created once via /2.3/filters/create with
 * include=question.body;question.answers;answer.body;question.accepted_answer_id
 * on base=default (filters are permanent and shareable per the API docs).
 * The default base keeps the response wrapper (.items, .quota_remaining) and
 * the standard question/answer fields; the includes add the bodies and the
 * nested answers so one request carries the whole thread.
 */
const STACKEXCHANGE_FILTER = '!20aKG._8Oscv*6djs8Pgm';

/**
 * The community Reddit archive reddit-thread reads. reddit.com answers every
 * non-browser client with a 403 (IP/TLS-reputation based, stealth browsers
 * included) and its robots.txt disallows everything; the archive's robots.txt
 * allows all agents and its /api/posts/ids answers keyless.
 */
const ARCTIC_SHIFT_BASE = 'https://arctic-shift.photon-reddit.com';

/** The base36 post id in a reddit.com post URL, or null when there is none. */
function redditPostId(url) {
  return /\/comments\/([a-z0-9]+)/i.exec(url)?.[1] ?? null;
}

function htmlToText(html) {
  if (!html) return null;
  const text = load(`<div>${html}</div>`)('div').text().replace(/\s+/g, ' ').trim();
  return text || null;
}

/**
 * One product, from either Shopify endpoint.
 *
 * /products/<handle>.json and /collections/<handle>/products.json serve the
 * same product object with two differences, both handled here rather than by
 * two copies of this mapping that would drift:
 *   - the collection endpoint carries a real `available` boolean per variant
 *     and no inventory counts; the product endpoint is the reverse, which is
 *     what variantAvailable() already reconciles.
 *   - neither endpoint is guaranteed to carry price_currency (the collection
 *     endpoint never does, verified 2026-08-28 against deathwishcoffee.com and
 *     allbirds.com), so currency is null rather than assumed.
 */
function shopifyProductEntity(product) {
  const variants = (product.variants || []).map(v => ({
    id: v.id,
    title: v.title,
    price: money(v.price),
    compare_at_price: compareAtPrice(v.compare_at_price),
    sku: v.sku || null,
    available: variantAvailable(v),
    inventory_quantity: typeof v.inventory_quantity === 'number' ? v.inventory_quantity : null,
    options: [v.option1, v.option2, v.option3].filter(Boolean)
  }));

  const prices = variants.map(v => Number.parseFloat(v.price)).filter(Number.isFinite);
  const first = variants[0] || {};
  const availability = variants.map(v => v.available);

  return {
    title: product.title || null,
    vendor: product.vendor || null,
    product_type: product.product_type || null,
    handle: product.handle || null,
    product_id: product.id ?? null,

    // Headline price is the first variant's, matching what the product page
    // shows before a selection is made.
    price: first.price ?? null,
    compare_at_price: first.compare_at_price ?? null,
    // A compare-at price above the price is what renders as a sale badge.
    on_sale: first.compare_at_price !== null && first.compare_at_price !== undefined
      ? Number.parseFloat(first.compare_at_price) > Number.parseFloat(first.price)
      : false,
    currency: product.variants?.[0]?.price_currency || null,
    price_min: prices.length ? String(Math.min(...prices).toFixed(2)) : null,
    price_max: prices.length ? String(Math.max(...prices).toFixed(2)) : null,

    available: availability.some(a => a === true) ? true
      : availability.every(a => a === false) ? false
      : null,
    variants,
    options: (product.options || []).map(o => o.name),

    description: htmlToText(product.body_html),
    tags: normalizeTags(product.tags),
    images: (product.images || []).map(i => i.src),
    published_at: product.published_at || null,
    updated_at: product.updated_at || null
  };
}

// ── Amazon helpers ───────────────────────────────────────────────────────────

/** Amazon's server-side templates leave runs of whitespace and newlines inline. */
function tidy(value) {
  const cleaned = String(value ?? '').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

/**
 * The byline slot holds three different things: "Brand: Amazon" on a
 * first-party device, "Visit the Apple Store" on a branded storefront, and
 * "by Jonathan Haidt (Author) Format: Hardcover" on a book. Each states the
 * same fact wrapped in different chrome.
 */
function npmLicense(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  // Very old packages use { type, url } or an array of them.
  if (Array.isArray(value)) return value.map(npmLicense).filter(Boolean).join(', ') || null;
  return value.type || null;
}

function npmRepositoryUrl(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw) return null;
  // Registry URLs come as git+ssh://git@host/o/r.git, git+https://…, git://…
  // or a bare "owner/repo" shorthand. Normalise to a browsable https URL.
  let url = raw.replace(/^git\+/, '').replace(/\.git$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}`;
  url = url.replace(/^git@([^:]+):/, 'https://$1/');
  url = url.replace(/^(?:git|ssh):\/\/(?:git@)?/, 'https://');
  url = url.replace(/^https:\/\/git@/, 'https://');
  return url;
}

function npmBugsUrl(bugs) {
  if (!bugs) return null;
  if (typeof bugs === 'string') return bugs;
  return bugs.url || bugs.email || null;
}

function amazonByline($) {
  const contributor = tidy($('#bylineInfo .contributorNameID').first().text());
  const raw = tidy($('#bylineInfo').first().text());
  if (!raw) return null;

  const branded = raw.match(/^Brand:\s*(.+)$/i) || raw.match(/^Visit the (.+?) Store$/i);
  if (branded) return tidy(branded[1]);

  // Books: the contributor link is the name on its own; the surrounding text
  // continues into "(Author) Format: Hardcover".
  if (/^by\s/i.test(raw)) return contributor || tidy(raw.replace(/^by\s+/i, '').split('(')[0]);

  // Every other marketplace phrases the book byline in its own language —
  // "Engelska utgåvan av George Orwell (Författare)", "Wydanie: Angielski
  // George Orwell (Autor)", "Édition en Anglais de George Orwell (Auteur)" —
  // and none starts with "by", so the chrome came back whole on amazon.se,
  // .pl, .com.be and .com.tr (R17, 2026-09-04). The author's own link
  // carries the bare name on every marketplace.
  const authorLink = tidy($('#bylineInfo .author a, #bylineInfo a.contributorNameID').first().text());
  if (authorLink && /\(/.test(raw)) return authorLink;

  // "Marke: Sony", "Marca: Sony", "Marque : Sony" — a localised brand label.
  const labelled = raw.match(/^[\p{L}\s]{2,20}?\s?:\s*(.+)$/u);
  if (labelled && !/\(/.test(raw)) return tidy(labelled[1]);

  return raw;
}

/**
 * The visible price. Amazon renders it twice: an offscreen string for screen
 * readers and a whole/decimal/fraction triplet for the eye — and a product
 * page carries dozens of such blocks that are not this product's price at
 * all. Reading the first `.a-price` on the page returned, on amazon.de/.it/
 * .co.jp book pages served without a buy box, the price of the first item in
 * the "similar products" carousel ("52,13USD" for a book listed from 30,57
 * USD), and on amazon.nl/.co.uk/.com.au it returned null because the buy
 * box's offscreen span is a blank " " (all observed 2026-09-04). So the block
 * is chosen by where it sits: the buy box first (Amazon's own priceToPay
 * class, or the corePrice/apex containers), then any block outside the
 * regions that always show OTHER products (carousels, bundles, the comparison
 * table, the other-sellers link) or a struck-through list price, then the
 * legacy priceblock ids, and last the selected format swatch — a book without
 * a buy box shows "ab 30,57 USD" / "da 42,16 €" there, and the qualifier is
 * kept because that is a from-price, not the price.
 *
 * Within a block: the offscreen string when it is there; when it is blank,
 * the triplet is rebuilt as symbol + whole + separator + fraction, with the
 * symbol on the side the markup puts it ("€44,85", "39.24£" never occurs but
 * "32,89€" does). On amazon.com.au the a-price-decimal span can be EMPTY, so
 * the offscreen string reads "$1105" for A$11.05 — whole "11" + fraction "05"
 * with no separator, a price 100× too high that every downstream guard
 * accepts. When the offscreen digits are exactly whole+fraction and nothing
 * separates the fraction, the separator is put back: "." unless the
 * marketplace writes its decimals with a comma.
 */
const AMAZON_OTHER_PRODUCT_PRICE =
  '[id^="sims-"], [id^="sp_"], .a-carousel, [data-a-carousel-options], #HLCXComparisonTable, ' +
  '#olpLinkWidget_feature_div, #dynamic-aod-ingress-box, [id*="sponsored"], [class*="fbt"], ' +
  '#twister-plus-tool-tip, #twisterPlusPriceSubtotalWWDesktop_feature_div, .a-text-price';
const AMAZON_BUY_BOX_PRICE =
  '.priceToPay, .apexPriceToPay, #corePrice_feature_div *, #corePriceDisplay_desktop_feature_div *, ' +
  '#apex_desktop *, #corePrice_desktop *';

function amazonDecimalSeparator($) {
  const host = (attr($, 'link[rel="canonical"]', 'href') || '').match(/^https?:\/\/([^/]+)/)?.[1] || '';
  return /\.(de|fr|es|it|nl|se|pl|com\.br|com\.tr|com\.be)$/.test(host) ? ',' : '.';
}

function amazonBlockPrice($, block, separator) {
  const $block = $(block);
  const offscreen = tidy($block.find('.a-offscreen').first().text());
  const whole = ($block.find('.a-price-whole').first().text() || '').replace(/\D/g, '');
  const fraction = ($block.find('.a-price-fraction').first().text() || '').replace(/\D/g, '');
  if (offscreen) {
    if (!whole || !fraction) return offscreen;
    if (offscreen.replace(/\D/g, '') !== whole + fraction) return offscreen;
    if (new RegExp(`[.,]${fraction}(?!\\d)`).test(offscreen)) return offscreen;
    return offscreen.replace(new RegExp(`(\\d)(${fraction})(?!\\d)`), `$1${separator}$2`);
  }
  if (!whole) return null;
  const amount = fraction ? `${whole}${separator}${fraction}` : whole;
  const symbol = tidy($block.find('.a-price-symbol').first().text()) || '';
  const symbolFirst = $block.find('.a-price-symbol, .a-price-whole').first().hasClass('a-price-symbol');
  return symbolFirst ? `${symbol}${amount}` : `${amount}${symbol}`;
}

function amazonPrice($) {
  const separator = amazonDecimalSeparator($);
  const own = $('.a-price').filter((_, el) => $(el).closest(AMAZON_OTHER_PRODUCT_PRICE).length === 0);
  for (const pool of [own.filter(AMAZON_BUY_BOX_PRICE), own]) {
    for (const block of pool.toArray()) {
      const price = amazonBlockPrice($, block, separator);
      if (price) return price;
    }
  }
  return (
    text($, '#priceblock_ourprice') ||
    text($, '#priceblock_dealprice') ||
    tidy(text($, '#tmmSwatches .swatchElement.selected .slot-price'))
  );
}

/**
 * ISO 4217 code for an Amazon price string. The add-to-cart form's hidden
 * currencyCode input is absent on pages Amazon serves without a buy box
 * (amazon.de and amazon.in book pages, R14 2026-09-03), so the code is read
 * off the price itself: an explicit code ("52,02USD"), else the symbol. A
 * bare "$" belongs to several marketplaces, told apart by the canonical host.
 */
function amazonCurrency($, price) {
  if (!price) return null;
  const code = price.match(/(USD|EUR|GBP|INR|JPY|CAD|AUD|MXN|BRL|SGD|AED|SAR|EGP|PLN|TRY|SEK)(?![A-Z])/);
  if (code) return code[1];
  if (price.includes('₹')) return 'INR';
  if (price.includes('€')) return 'EUR';
  if (price.includes('£')) return 'GBP';
  if (price.includes('¥') || price.includes('￥')) return 'JPY';
  if (price.includes('R$')) return 'BRL';
  if (price.includes('zł')) return 'PLN';
  // amazon.com.tr writes "460,67TL" (R17, 2026-09-04); the lira sign is rarer.
  if (price.includes('₺') || /(?<![A-Za-z])TL(?![A-Za-z])/.test(price)) return 'TRY';
  // Arabic-script marketplaces: dirham, Egyptian pound, riyal.
  if (/د\.?إ/.test(price)) return 'AED';
  if (/ج\.?م/.test(price)) return 'EGP';
  if (/ر\.?س|﷼/.test(price)) return 'SAR';
  const host = (attr($, 'link[rel="canonical"]', 'href') || '').match(/^https?:\/\/([^/]+)/)?.[1] || '';
  // "114,30kr" on amazon.se — the only Amazon marketplace priced in kronor.
  if (/(?<![A-Za-z])kr(?![A-Za-z])/i.test(price)) return /\.se$/.test(host) ? 'SEK' : null;
  if (price.includes('$')) {
    if (/\.ca$/.test(host)) return 'CAD';
    if (/\.com\.au$/.test(host)) return 'AUD';
    if (/\.com\.mx$/.test(host)) return 'MXN';
    if (/\.sg$/.test(host)) return 'SGD';
    return 'USD';
  }
  return null;
}

function hnAbsoluteUrl(href) {
  if (!href) return href;
  try {
    return new URL(href, 'https://news.ycombinator.com/').href;
  } catch {
    return href;
  }
}

function hnCommentCount(label) {
  const value = (label || '').trim();
  if (!value) return null;
  if (/^discuss$/i.test(value)) return '0';
  const match = value.match(/^(\d+)\s*comments?$/i);
  return match ? match[1] : value;
}

/**
 * "4.7 out of 5 stars" → 4.7. The first number is not the rating everywhere:
 * amazon.nl writes "4,8 van 5 sterren" (a comma decimal, read as 4) and
 * amazon.co.jp "5つ星のうち4.7" (the scale comes first, read as 5) — both
 * plausible wrong numbers, observed 2026-09-04. Every number is read, comma
 * decimals included, and when one of two is the 5-star scale the other one is
 * the rating.
 */
function amazonRating(value) {
  const numbers = (tidy(value)?.match(/\d+(?:[.,]\d+)?/g) || [])
    .map((n) => Number.parseFloat(n.replace(',', '.')));
  if (numbers.length === 0) return null;
  if (numbers.length === 1) return numbers[0];
  return numbers.find((n) => n !== 5) ?? 5;
}

/** Both "(198,594)" and "198,594 global ratings" mean 198594. */
function amazonCount(value) {
  const digits = tidy(value)?.replace(/[^\d]/g, '');
  return digits ? Number.parseInt(digits, 10) : null;
}

/**
 * Amazon serves every size of an image from one object, with the size encoded
 * in the filename: ..._AC_SR40,60_.jpg is the 40x60 thumbnail of ....jpg.
 * Dropping the token yields the original (verified 2026-08-25: the thumbnail
 * is 1KB, the same URL without the token is 16KB).
 */
function fullSizeImage(src) {
  if (!src) return null;
  // The alt-image strip is padded with a transparent spacer gif, and the page
  // chrome is served from the shared /x-locale/common/ sprite directory.
  if (/transparent-pixel|\/x-locale\/common\//.test(src)) return null;
  return src.replace(/\._[^/]*_\.(jpe?g|png|gif)$/i, ".$1");
}

// ── YouTube helpers ──────────────────────────────────────────────────────────

/**
 * Views and likes are both userInteractionCount; only the sibling
 * interactionType tells them apart, and YouTube emits the LikeAction counter
 * first — so reading the attribute directly returns likes where views are
 * meant. There is no interactionCount attribute on the page at all.
 */
function youtubeInteractionCount($, action) {
  const counter = $('[itemprop="interactionStatistic"]')
    .filter((_, el) => ($(el).find('[itemprop="interactionType"]').attr('content') || '').split('/').pop() === action)
    .first();
  const count = counter.find('[itemprop="userInteractionCount"]').attr('content');
  return count ? Number.parseInt(count, 10) : null;
}

// ── GitHub helpers ───────────────────────────────────────────────────────────

/**
 * The logged-out repo page is GitHub's React code view: the About sidebar
 * (homepage link, license, topics, counts) is not rendered as HTML — it ships
 * as JSON inside <script data-target="react-app.embeddedData">, and the DOM
 * around it is skeleton placeholders. Parse that payload; the CSS selectors
 * stay as fallbacks for older server-rendered layouts.
 */
function githubSidebarAbout($) {
  for (const el of $('script[data-target="react-app.embeddedData"]').toArray()) {
    try {
      const about = JSON.parse($(el).text())?.payload?.sidebarAbout;
      if (about) return about;
    } catch {
      // a different embedded payload — keep looking
    }
  }
  return null;
}

/**
 * The payload's license is { spdxId: "MIT", name: "MIT License" }. The SPDX
 * id is the short name callers want, but a repo with a non-standard licence
 * ships spdxId "NOASSERTION", where the display name is all there is.
 */
function githubLicense(license) {
  if (!license) return null;
  const spdx = license.spdxId;
  return (spdx && spdx !== 'NOASSERTION' ? spdx : license.name) || null;
}

/**
 * og:description is never just the About text. GitHub appends "Contribute to
 * owner/repo development by creating an account on GitHub." to it, and that
 * sentence is the *whole* value on a repo with no description at all. Strip
 * it; whatever remains is the description, and nothing remaining means the
 * repo has none.
 */
function githubOgDescription($) {
  const og = attr($, 'meta[property="og:description"]', 'content') || '';
  return tidy(og.replace(/\s*Contribute to \S+ development by creating an account on GitHub\.?/, ''));
}

/**
 * Repo tab counters stamp the exact number in title= ("5,102") and an
 * abbreviated text ("5.1k"); a counter with nothing to show stamps
 * title="Not available", so the title is only trusted when it has a digit.
 */
function githubCounter($, sel) {
  const exact = attr($, sel, 'title');
  return /\d/.test(exact || '') ? exact : text($, sel);
}

// ── Template definitions ─────────────────────────────────────────────────────

export const TEMPLATES = [
  {
    id: 'shopify-product',
    name: 'Shopify Product',
    description:
      'Read a Shopify product from the store\'s own /products/<handle>.json endpoint: exact price, ' +
      'compare-at price, per-variant stock, options and images. Works on any Shopify storefront, ' +
      'including custom domains. No HTML parsing and no LLM, so prices cannot be misread or invented.',
    // Shopify runs on millions of custom domains, so the product URL shape is
    // the only reliable signal. Non-Shopify sites using /products/ URLs are
    // rejected by extractRaw rather than silently returning nonsense.
    targetPattern: /\/products\/[^/?#]+/i,

    /** Point the fetch at the JSON endpoint for the same product. */
    resolveUrl(url) {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/^(.*\/products\/[^/]+?)(?:\.json)?\/?$/i);
      if (!match) return url;
      parsed.pathname = `${match[1]}.json`;
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    },

    extractRaw(body, url) {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new Error(
          `Not a Shopify product endpoint: ${url} did not return JSON. ` +
          'This template only works on Shopify storefronts.'
        );
      }

      const product = payload?.product;
      if (!product || !Array.isArray(product.variants)) {
        throw new Error(
          `Not a Shopify product endpoint: ${url} returned JSON without a product. ` +
          'This template only works on Shopify storefronts.'
        );
      }

      return shopifyProductEntity(product);
    }
  },

  {
    id: 'shopify-collection',
    name: 'Shopify Collection',
    description:
      'List every product in a Shopify collection from the store\'s own ' +
      '/collections/<handle>/products.json endpoint: exact price, compare-at price and stock for ' +
      'each product, in one call. Same authoritative source as shopify-product, so a collection ' +
      'and a product page cannot disagree. Pass a collection URL, or the store and collection ' +
      'handle as params. Shopify serves 30 products per page by default and 250 at most, so a ' +
      'large collection needs paging.',
    // Same reasoning as shopify-product: Shopify runs on millions of custom
    // domains, so the URL shape is the only signal. Bounded so it does not also
    // claim /collections/<handle>/products/<handle>, which is a product page.
    targetPattern: /\/collections\/[^/?#]+(?:\/products\.json)?\/?(?:[?#]|$)/i,

    /** Point the fetch at the collection's product listing. */
    resolveUrl(url) {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/^(.*\/collections\/[^/]+?)(?:\/products(?:\.json)?)?\/?$/i);
      if (!match) return url;
      parsed.pathname = `${match[1]}/products.json`;
      // Keep only the two paging params the endpoint understands. sort_by and
      // filter.* are storefront-rendering concerns the JSON endpoint ignores,
      // and several stores disallow those URLs in robots.txt.
      const paging = new URLSearchParams();
      for (const key of ['limit', 'page']) {
        if (parsed.searchParams.has(key)) paging.set(key, parsed.searchParams.get(key));
      }
      parsed.search = paging.toString();
      parsed.hash = '';
      return parsed.toString();
    },

    /**
     * Build the listing URL from params instead of a URL.
     * @param {{ store: string, collection: string, limit?: number, page?: number }} params
     */
    listUrl(params = {}) {
      const { store, collection, limit, page } = params;
      if (!store) {
        throw new Error(
          'shopify-collection requires a "store" parameter: the storefront domain, ' +
          'e.g. "www.allbirds.com".'
        );
      }
      if (!collection) {
        throw new Error(
          'shopify-collection requires a "collection" parameter: the collection handle, ' +
          'e.g. "mens" from https://www.allbirds.com/collections/mens.'
        );
      }

      const origin = /^https?:\/\//i.test(store) ? store : `https://${store}`;
      const url = new URL(`/collections/${encodeURIComponent(collection)}/products.json`, origin);

      if (limit !== undefined) {
        const value = Number(limit);
        // Shopify caps the endpoint at 250 and silently truncates past it —
        // saying so beats returning 250 rows to a caller who asked for 1000.
        if (!Number.isInteger(value) || value < 1 || value > 250) {
          throw new Error(`shopify-collection "limit" must be an integer from 1 to 250, got ${limit}.`);
        }
        url.searchParams.set('limit', String(value));
      }
      if (page !== undefined) {
        const value = Number(page);
        if (!Number.isInteger(value) || value < 1) {
          throw new Error(`shopify-collection "page" must be an integer of 1 or more, got ${page}.`);
        }
        url.searchParams.set('page', String(value));
      }

      return url.toString();
    },

    extractList(body, url) {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new Error(
          `Not a Shopify collection endpoint: ${url} did not return JSON. ` +
          'This template only works on Shopify storefronts.'
        );
      }

      if (!payload || !Array.isArray(payload.products)) {
        throw new Error(
          `Not a Shopify collection endpoint: ${url} returned JSON without a products array. ` +
          'This template only works on Shopify storefronts.'
        );
      }

      // An unknown collection handle and a page past the end both answer 200
      // with {"products":[]}, so an empty list is a real answer, not an error.
      const parsed = safeUrl(url);
      const requested = Number.parseInt(parsed?.searchParams.get('limit') ?? '', 10);
      // The store default when no limit is sent, confirmed 2026-08-28.
      const limit = Number.isInteger(requested) ? requested : 30;
      const page = Number.parseInt(parsed?.searchParams.get('page') ?? '', 10) || 1;

      return {
        collection: parsed?.pathname.match(/\/collections\/([^/]+)/i)?.[1] ?? null,
        items: payload.products.map(product => ({
          ...shopifyProductEntity(product),
          // A list is only useful if each row is addressable.
          url: parsed && product.handle
            ? new URL(`/products/${product.handle}`, parsed.origin).toString()
            : null
        })),
        count: payload.products.length,
        page,
        limit,
        // The endpoint publishes no total, so a full page is the only "there
        // may be more" signal there is.
        has_more: payload.products.length === limit
      };
    }
  },

  {
    id: 'amazon-product',
    name: 'Amazon Product',
    description: 'Scrape an Amazon product page for title, price, rating, reviews, ASIN, and description.',
    // Every marketplace the extractor handles. "jp" alone never matched
    // amazon.co.jp, and .es/.in/.it worked by explicit id while template:"auto"
    // refused them (R15, 2026-09-04).
    targetPattern: /amazon\.(com|co\.uk|co\.jp|de|fr|es|it|nl|se|pl|ca|in|sg|ae|sa|eg|com\.au|com\.br|com\.mx|com\.be|com\.tr)/i,
    extract($) {
      // Amazon serves its robot check as HTTP 200: a "Continue shopping" page
      // whose only form posts to /errors/validateCaptcha. Every selector below
      // misses on it, which used to come back as a silent all-null record
      // (amazon.es, observed 2026-09-01) — name the block instead.
      if ($('form[action*="validateCaptcha"]').length > 0) {
        throw new Error(
          'Amazon answered with a captcha interstitial (an HTTP 200 robot check), not the product page. ' +
          'The product data is not in this response — retry later or from a different IP.'
        );
      }
      const bullets = $('#feature-bullets ul li span.a-list-item')
        .map((_, el) => tidy($(el).text()))
        .get()
        .filter(Boolean);
      const images = [attr($, '#landingImage', 'src'), ...listAttr($, '#altImages img', 'src')]
        .map(fullSizeImage)
        .filter(Boolean);

      const price = amazonPrice($);

      return {
        title: tidy(text($, '#productTitle')),
        price,
        // Amazon ships no priceCurrency meta tag — the ISO code is a hidden
        // field on the add-to-cart form, and off the price where there is none.
        currency:
          attr($, 'input[name*="currencyCode"]', 'value') ||
          attr($, 'meta[itemprop="priceCurrency"]', 'content') ||
          amazonCurrency($, price),
        rating: amazonRating(attr($, '#acrPopover', 'title') || text($, '#averageCustomerReviews .a-icon-alt')),
        review_count: amazonCount(text($, '#acrCustomerReviewText') || text($, '[data-hook="total-review-count"]')),
        asin: text($, 'input#ASIN') || attr($, 'input[name="ASIN"]', 'value'),
        brand: amazonByline($),
        // Device pages leave #productDescription empty and put the copy in the
        // bullet list; books use neither and have their own container.
        description:
          tidy(text($, '#productDescription')) ||
          (bullets.length ? bullets.join(' ') : null) ||
          tidy(text($, '#bookDescription_feature_div .a-expander-content')) ||
          tidy(text($, '#feature-bullets')),
        images: [...new Set(images)].slice(0, 8),
        availability: tidy(text($, '#availability span')),
        // Only category pages (books, media) carry breadcrumbs; device pages
        // genuinely have none, so [] here is a fact about the page.
        category_breadcrumb: list($, '#wayfinding-breadcrumbs_feature_div a')
      };
    }
  },

  {
    id: 'github-repo',
    name: 'GitHub Repository',
    description: 'Scrape a GitHub repository page for stars, forks, description, language, topics, and README summary.',
    targetPattern: /github\.com\/[^/]+\/[^/]+\/?$/i,
    extract($) {
      const about = githubSidebarAbout($);
      return {
        name: text($, 'strong[itemprop="name"] a') || text($, '.repository-content h1'),
        // Like homepage: when the sidebar payload is present it is
        // authoritative, so a repo that set no description reports null
        // rather than GitHub's "Contribute to ..." boilerplate.
        description: about
          ? tidy(about.description)
          : tidy(text($, 'p.f4.my-3')) || githubOgDescription($),
        stars: text($, '#repo-stars-counter-star') || text($, '[aria-label*="stargazers"]'),
        forks: text($, '#repo-network-counter') || text($, '[aria-label*="forks"]'),
        // React (logged-out) layout has no watchers aria-label; the count is
        // the <strong> right after the single octicon-eye.
        watchers: text($, '.octicon-eye + strong') || text($, '[aria-label*="watchers"]'),
        // Language and the last-push date appear nowhere in the logged-out
        // page (verified 2026-08-26 across five User-Agents, embedded JSON
        // included): the client fetches them after load from header-gated
        // JSON endpoints (/_sidebar, /latest-commit). The selectors below
        // only fire on older server-rendered layouts; otherwise these two
        // stay null rather than guessing.
        language: text($, 'span[itemprop="programmingLanguage"]') || text($, '.d-inline-flex[class*="language"]'),
        topics: list($, 'a.topic-tag, a[href^="/topics/"]'),
        // Never the repo's LICENSE *file* link — its text is the filename,
        // not the licence name.
        license: githubLicense(about?.repo?.license) || text($, '.octicon-law ~ span'),
        last_updated: attr($, 'relative-time', 'datetime'),
        // When the sidebar payload is present it is authoritative: an empty
        // website means "no homepage", not "go scrape some external link".
        homepage: safeHref(about ? about.website : attr($, 'a[href][rel="noopener noreferrer"]', 'href')),
        open_issues: githubCounter($, '#issues-repo-tab-count') || text($, '.Counter[aria-label*="issue"]')
      };
    }
  },

  {
    id: 'youtube-video',
    name: 'YouTube Video',
    description: 'Scrape a YouTube video page for title, channel, views, likes, publish date, and description.',
    targetPattern: /youtube\.com\/watch/i,
    extract($) {
      return {
        title: attr($, 'meta[name="title"]', 'content') || attr($, 'meta[property="og:title"]', 'content'),
        channel: attr($, 'link[itemprop="name"]', 'content') || text($, '#channel-name'),
        channel_url: safeHref(attr($, 'span[itemprop="author"] link[itemprop="url"]', 'href')),
        views: youtubeInteractionCount($, 'WatchAction'),
        likes: youtubeInteractionCount($, 'LikeAction'),
        published: attr($, 'meta[itemprop="uploadDate"]', 'content') || attr($, 'meta[itemprop="datePublished"]', 'content'),
        description: attr($, 'meta[property="og:description"]', 'content'),
        thumbnail: attr($, 'meta[property="og:image"]', 'content'),
        duration: attr($, 'meta[itemprop="duration"]', 'content'),
        video_id: (() => {
          try {
            return new URL($('link[rel="canonical"]').attr('href') || 'https://youtube.com').searchParams.get('v');
          } catch {
            return null;
          }
        })()
      };
    }
  },

  {
    id: 'reddit-thread',
    name: 'Reddit Thread',
    description: 'Read a Reddit post — title, subreddit, author, score, upvote ratio, comment count, body and flair — from the Arctic Shift archive, since reddit.com blocks plain fetchers. For the comment tree, pass the returned id to the reddit_search tool in thread mode.',
    targetPattern: /reddit\.com\/(?:r\/[^/]+\/)?comments\/[a-z0-9]+/i,

    resolveUrl(url) {
      const id = redditPostId(url);
      if (!id) return url;
      return `${ARCTIC_SHIFT_BASE}/api/posts/ids?ids=${id}`;
    },

    extractRaw(body, url) {
      let doc;
      try {
        doc = JSON.parse(body);
      } catch {
        throw new Error(
          `Not an Arctic Shift document: ${url} did not return JSON. ` +
          'This template reads the Arctic Shift archive, not reddit.com.'
        );
      }
      // The archive reports a bad request as {data:null, error:"..."}; a post
      // it has never captured is an empty data list.
      if (doc && doc.error) {
        throw new Error(`Arctic Shift error: ${doc.error}`);
      }
      const post = Array.isArray(doc?.data) ? doc.data[0] : null;
      if (!post) {
        throw new Error(`No Reddit post at ${url}: the Arctic Shift archive has no record of it.`);
      }

      return {
        id: post.id ?? null,
        title: post.title ?? null,
        subreddit: post.subreddit ?? null,
        author: post.author ?? null,
        score: typeof post.score === 'number' ? post.score : null,
        upvote_ratio: typeof post.upvote_ratio === 'number' ? post.upvote_ratio : null,
        num_comments: typeof post.num_comments === 'number' ? post.num_comments : null,
        posted: epochToIso(post.created_utc),
        // "[removed]" and "[deleted]" come back as written: that is what the
        // archive holds, and a caller can tell it from an empty post.
        body: post.selftext || null,
        // A link post carries its external URL here; a self post carries its
        // own permalink, which `url` already reports.
        link_url: post.is_self ? null : safeHref(post.url),
        url: post.permalink ? `https://www.reddit.com${post.permalink}` : null,
        flair: post.link_flair_text ?? null,
        over_18: Boolean(post.over_18),
        removed: post.removed_by_category ?? post._meta?.removal_type ?? null,
        note: 'Read from the Arctic Shift archive, not reddit.com. Scores and comment counts of content less than ~36h old may read 0/1. For the comment tree call reddit_search with mode:"thread" and this id.'
      };
    }
  },

  {
    id: 'hacker-news-front-page',
    name: 'Hacker News Front Page',
    description: 'Scrape the Hacker News front page for a list of stories with title, URL, score, and comment count.',
    // The same story table serves /newest, /front, /best, /ask, /show, /jobs
    // and /active, and every one of them pages with ?p=N.
    targetPattern: /news\.ycombinator\.com(?:\/(?:news|newest|front|best|ask|show|jobs|active))?\/?(?:[?#].*)?$/i,
    extract($) {
      const stories = [];
      $('tr.athing').each((_, el) => {
        const $row = $(el);
        // The metadata row (".subtext") is the sibling row immediately after tr.athing.
        const $subtext = $row.next('tr').find('.subtext');
        const $score = $subtext.find('.score');
        const $titleLink = $row.find('.titleline > a');
        stories.push({
          id: $row.attr('id'),
          title: $titleLink.text().trim(),
          // Text posts (Ask HN, Show HN without a link) carry a relative
          // "item?id=…" href; resolve it so every story url is absolute.
          url: safeHref(hnAbsoluteUrl($titleLink.attr('href'))),
          site: $row.find('.sitebit a').text().trim() || null,
          // "1 point" on a fresh story and "3 points" on the rest — strip both.
          score: $score.text().replace(/\s*points?$/, '').trim() || null,
          author: $subtext.find('.hnuser').text().trim() || null,
          // ".age a" wraps the relative age string ("3 hours ago"); its href is the item permalink.
          posted: $subtext.find('.age a').text().trim() || null,
          // The comments link is also an item?id= link, so exclude the age anchor.
          // "1053 comments", "1 comment" or "discuss" (none yet) become one
          // shape, a bare count, like score above. Job posts have no comments
          // link at all -> null.
          comments: hnCommentCount($subtext.find('a[href*="item"]').not('.age a').last().text())
        });
      });
      return { stories: stories.slice(0, 30), scraped_at: new Date().toISOString() };
    }
  },

  {
    id: 'producthunt-launch',
    name: 'Product Hunt Launch',
    description:
      'Scrape a Product Hunt product page for name, tagline, description, categories, website, ' +
      'and follower/review counts. Product Hunt folded /posts/* launch pages into /products/* ' +
      'product hubs, which carry no product-level vote count — followers and reviews are the ' +
      "page's engagement numbers now.",
    targetPattern: /producthunt\.com\/(posts|products)\//i,
    extractRaw(body, url) {
      // The RSC flight stream on these pages is a near-empty shell; the data
      // the UI renders from — the GraphQL Product record — rides in Apollo's
      // streaming-SSR transport pushes instead.
      const products = [];
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (node.__typename === 'Product') products.push(node);
        for (const value of Object.values(node)) walk(value);
      };
      for (const push of extractApolloTransport(body)) walk(push);
      // The transport carries several Product objects (latestLaunch.product,
      // forum subjects); the page's own is the one with the page-level fields.
      const product =
        products.find(p => 'followersCount' in p) || products.find(p => 'websiteUrl' in p) || null;

      const $ = load(body);
      const metaName = attr($, 'meta[property="og:title"]', 'content');
      const categories = Array.isArray(product?.categories)
        ? product.categories.map(c => c?.name).filter(Boolean)
        : null;
      // The DOM fallback's href carries PH's ?ref=producthunt tracking param.
      const domWebsite = (attr($, 'a[data-test="visit-website-button"]', 'href') || '')
        .replace(/([?&])ref=producthunt(?=&|$)/, '$1')
        .replace(/[?&]$/, '') || null;

      return {
        name: product?.name || (metaName ? metaName.replace(/\s*\|\s*Product Hunt\s*$/i, '') : null),
        tagline: product?.tagline || attr($, 'meta[property="og:description"]', 'content'),
        description: product?.description ?? null,
        image: attr($, 'meta[property="og:image"]', 'content'),
        url: safeHref(attr($, 'meta[property="og:url"]', 'content')) || url,
        website: safeHref(product?.websiteUrl || domWebsite),
        // null = the data layer was missing, [] = present with no categories.
        topics: categories,
        followers: product?.followersCount ?? null,
        reviews_count: product?.reviewsCount ?? null,
        reviews_rating: product?.reviewsRating ?? null
      };
    }
  },

  {
    id: 'stackoverflow-question',
    name: 'Stack Overflow Question',
    description:
      'Read a Stack Overflow question from the Stack Exchange API rather than the rendered page: ' +
      'title, body, score, views, tags, owner, and the answers with their scores and which one ' +
      'was accepted. stackoverflow.com answers every non-browser fetch with a Cloudflare 403, so ' +
      'the page itself yields nothing; the API is keyless (300 requests per day per IP).',
    targetPattern: /stackoverflow\.com\/questions\/\d+/i,

    /** Point the fetch at the API document for the same question. */
    resolveUrl(url) {
      const match = new URL(url).pathname.match(/\/questions\/(\d+)/);
      if (!match) return url;
      return `https://api.stackexchange.com/2.3/questions/${match[1]}` +
        `?site=stackoverflow&filter=${STACKEXCHANGE_FILTER}`;
    },

    extractRaw(body, url) {
      let doc;
      try {
        doc = JSON.parse(body);
      } catch {
        throw new Error(
          `Not a Stack Exchange API document: ${url} did not return JSON. ` +
          'This template reads the Stack Exchange API.'
        );
      }

      // The API reports its own failures (bad filter, throttled, no such site)
      // as a 400 with error_* fields; a missing question is an empty items list.
      if (doc && doc.error_id) {
        throw new Error(
          `Stack Exchange API error ${doc.error_id} (${doc.error_name || 'unknown'}): ${doc.error_message || 'no message'}.`
        );
      }
      const question = Array.isArray(doc?.items) ? doc.items[0] : null;
      if (!question) {
        throw new Error(`No Stack Overflow question at ${url}: the API returned no items.`);
      }

      // Accepted answer first, then by score — the order the site shows.
      const answers = (question.answers || [])
        .slice()
        .sort((a, b) => (Number(Boolean(b.is_accepted)) - Number(Boolean(a.is_accepted))) || ((b.score ?? 0) - (a.score ?? 0)));

      return {
        question_id: question.question_id ?? null,
        // Titles and display names come HTML-encoded (&quot;, &#39;).
        title: htmlToText(question.title),
        body: htmlToText(question.body),
        votes: question.score ?? null,
        views: question.view_count ?? null,
        tags: question.tags || [],
        author: htmlToText(question.owner?.display_name),
        author_reputation: question.owner?.reputation ?? null,
        asked: epochToIso(question.creation_date),
        last_activity: epochToIso(question.last_activity_date),
        link: question.link || null,
        answered: Boolean(question.is_answered),
        accepted_answer_id: question.accepted_answer_id ?? null,
        answer_count: question.answer_count ?? answers.length,
        answers: answers.slice(0, 5).map(a => ({
          answer_id: a.answer_id ?? null,
          votes: a.score ?? null,
          accepted: Boolean(a.is_accepted),
          author: htmlToText(a.owner?.display_name),
          posted: epochToIso(a.creation_date),
          body: (htmlToText(a.body) || '').slice(0, 500) || null
        })),
        quota_remaining: doc.quota_remaining ?? null
      };
    }
  },

  {
    id: 'npm-package',
    name: 'npm Package',
    description:
      'Read a package from the npm registry API rather than the rendered npmjs.com page: exact ' +
      'latest version, license, repository, homepage, maintainers, dependencies and any ' +
      'deprecation notice. npmjs.com blocks plain HTTP fetches, and its markup carries no stable ' +
      'hooks, so the page itself yields almost nothing. Weekly download counts are not included — ' +
      'they live on a separate api.npmjs.org endpoint.',
    targetPattern: /npmjs\.com\/package\/|registry\.npmjs\.org\//i,

    /** Point the fetch at the registry document for the same package. */
    resolveUrl(url) {
      const parsed = new URL(url);
      if (parsed.hostname === 'registry.npmjs.org') return url;
      // /package/<name>, /package/@scope/<name>, either optionally followed by
      // /v/<version> or /access etc.
      const match = parsed.pathname.match(/\/package\/((?:@[^/]+\/)?[^/]+)/i);
      if (!match) return url;
      return `https://registry.npmjs.org/${match[1]}`;
    },

    extractRaw(body, url) {
      let doc;
      try {
        doc = JSON.parse(body);
      } catch {
        throw new Error(
          `Not an npm registry document: ${url} did not return JSON. ` +
          'This template reads the npm registry API.'
        );
      }

      // The registry answers an unknown package with {"error":"Not found"}.
      if (!doc || typeof doc.name !== 'string') {
        const reason = typeof doc?.error === 'string' ? doc.error : 'no package document';
        throw new Error(`No npm package at ${url}: ${reason}.`);
      }

      const latest = doc['dist-tags']?.latest || null;
      const release = (latest && doc.versions?.[latest]) || {};
      const deps = release.dependencies || {};

      return {
        name: doc.name,
        version: latest,
        description: release.description || doc.description || null,
        license: npmLicense(release.license ?? doc.license),
        homepage: safeHref(release.homepage || doc.homepage),
        repository: safeHref(npmRepositoryUrl(release.repository || doc.repository)),
        bugs: npmBugsUrl(release.bugs || doc.bugs),
        keywords: release.keywords || doc.keywords || [],
        maintainers: (doc.maintainers || [])
          .map(m => (typeof m === 'string' ? m : m?.name))
          .filter(Boolean),
        dependencies: deps,
        dependency_count: Object.keys(deps).length,
        // A string when the publisher deprecated it, false otherwise — npm
        // keeps serving deprecated packages, so this is the only signal.
        deprecated: typeof release.deprecated === 'string' ? release.deprecated : false,
        published: (latest && doc.time?.[latest]) || null,
        last_modified: doc.time?.modified || null,
        install_command: `npm install ${doc.name}`
      };
    }
  }
,

  ...ATS_TEMPLATES,
  ...GOV_TEMPLATES
];

/**
 * Templates withdrawn because there is no compliant way to reach the data.
 * They are kept here by id, so a caller naming one gets the reason rather
 * than "unknown template", and by pattern, so `auto` can say the same for a
 * URL they would have matched. Verified against each site's robots.txt on
 * 2026-08-30.
 */
export const RETIRED_TEMPLATES = {
  'linkedin-profile': {
    targetPattern: /linkedin\.com\/in\//i,
    reason: 'linkedin.com/robots.txt disallows every path for all agents except LinkedIn\'s own crawler, and profile pages sit behind an authentication wall, so there is no compliant way to read a profile.'
  },
  tweet: {
    targetPattern: /(twitter|x)\.com\/[^/]+\/status\//i,
    reason: 'x.com/robots.txt disallows every path for generic agents, and the keyless embed endpoints (cdn.syndication.twimg.com, publish.x.com/oembed) are disallowed by their own robots.txt, so a tweet cannot be read without X API credentials.'
  }
};

/**
 * The retired template a caller is reaching for — by id, or by a URL one of
 * them handled — as { id, reason }, or null.
 */
export function retiredTemplate(idOrUrl) {
  if (typeof idOrUrl !== 'string') return null;
  if (RETIRED_TEMPLATES[idOrUrl]) return { id: idOrUrl, reason: RETIRED_TEMPLATES[idOrUrl].reason };
  for (const [id, entry] of Object.entries(RETIRED_TEMPLATES)) {
    if (entry.targetPattern.test(idOrUrl)) return { id, reason: entry.reason };
  }
  return null;
}

// ── Registry ─────────────────────────────────────────────────────────────────

/**
 * Whether a pattern is anchored to a particular host.
 *
 * Decided by swapping the host out and re-testing: /amazon\.(com|…)/ stops
 * matching, shopify-product's /\/products\/[^/?#]+/ keeps matching. Reading the
 * regex source for a dotted domain instead would misread any pattern that
 * mentions a file — shopify-collection's own /\/products\.json/ has a dot in it
 * and names no host at all.
 */
function isHostAnchored(pattern, url) {
  const probe = safeUrl(url);
  if (!probe) return false;
  probe.hostname = 'invalid-host';
  return !pattern.test(probe.toString());
}

export class TemplateRegistry {
  /**
   * @param {object[]} [templates] — the template set, injectable so a test can
   *   register a fixture without shipping it.
   */
  constructor(templates = TEMPLATES) {
    this._order = templates;
    this._templates = new Map(templates.map(t => [t.id, t]));
  }

  /**
   * List all registered templates. `mode`, `requires_api_key` and
   * `credential_ref` are derived from the template, never stored on it.
   */
  list() {
    return this._order.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      // A params-only connector may have no URL shape to advertise.
      targetPattern: t.targetPattern ? t.targetPattern.toString() : null,
      // extractList is the only signal that a template returns N entities.
      mode: t.extractList ? 'list' : 'entity',
      ...(t.requiresApiKey ? { requires_api_key: true } : {}),
      ...(t.credentialRef ? { credential_ref: t.credentialRef } : {})
    }));
  }

  /**
   * Pick the template that handles a URL, or null when none does.
   *
   * Deterministic: a template whose pattern names a host outranks one that only
   * matches a path shape, so amazon-product wins an Amazon URL that happens to
   * contain /products/. Remaining ties go to registration order.
   *
   * @param {string} url
   * @returns {object|null}
   */
  detect(url) {
    if (typeof url !== 'string' || !url) return null;

    const matches = this._order.filter(t => t.targetPattern?.test(url));
    if (matches.length < 2) return matches[0] ?? null;

    const hostAnchored = matches.filter(t => isHostAnchored(t.targetPattern, url));
    return (hostAnchored.length ? hostAnchored : matches)[0];
  }

  /**
   * Look up a template by ID.
   * @param {string} id
   * @returns {object|undefined}
   */
  get(id) {
    return this._templates.get(id);
  }

  /**
   * Run a template against a fetched response body.
   * @param {string} id     — template ID
   * @param {string} body   — response body (HTML, or JSON for extractRaw templates)
   * @param {string} url    — original URL (for context)
   * @param {string} [fetchedUrl] — URL actually fetched, when resolveUrl rewrote it
   * @returns {{ template: string, url: string, data: object, extractedAt: string }}
   */
  async run(id, body, url, fetchedUrl = url) {
    const template = this.get(id);
    if (!template) {
      throw new Error(`Unknown template: "${id}". Available: ${this._order.map(t => t.id).join(', ')}`);
    }

    // The mirror of runList()'s guard. Without it a list connector reaches
    // template.extract, which it does not define, and the caller gets
    // "template.extract is not a function" instead of being told which method
    // to call.
    if (!template.extractRaw && !template.extract) {
      throw new Error(
        `Template "${id}" returns a list, not a single entity. Use runList() instead.`
      );
    }

    const data = template.extractRaw
      ? template.extractRaw(body, url)
      : template.extract(load(body));

    // A record with literally every field empty is not a page with no data —
    // it is a page the template's selectors all missed: an interstitial
    // (captcha, consent wall, bot check) served as HTTP 200, or a layout
    // change. Reporting it as success is how amazon.es's captcha page came
    // back as a clean all-null product (2026-09-01). Fail loudly instead.
    const values = data && typeof data === 'object' && !Array.isArray(data) ? Object.values(data) : [];
    const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
    if (values.length > 0 && values.every(isEmpty)) {
      throw new Error(
        `Template "${id}" matched the page but extracted no data — every field came back empty. ` +
        'The server likely answered with an interstitial (captcha, consent or bot wall) or the site changed ' +
        'its layout. This is an extraction failure, not a page with nothing on it.'
      );
    }

    return {
      template: id,
      template_name: template.name,
      url,
      ...(fetchedUrl !== url ? { fetchedUrl } : {}),
      data,
      extractedAt: new Date().toISOString()
    };
  }

  /**
   * Run a list connector against a fetched response body — N entities from one
   * call, where run() returns one. Same envelope, plus whichever of the URL and
   * the params the caller reached the endpoint with.
   *
   * @param {string} id
   * @param {string} body
   * @param {{ url?: string, params?: object }} [context]
   * @returns {{ template: string, template_name: string, url?: string, params?: object,
   *            data: { items: object[], count: number }, extractedAt: string }}
   */
  async runList(id, body, { url, params } = {}) {
    const template = this.get(id);
    if (!template) {
      throw new Error(`Unknown template: "${id}". Available: ${this._order.map(t => t.id).join(', ')}`);
    }
    if (!template.extractList) {
      const lists = this._order.filter(t => t.extractList).map(t => t.id).join(', ');
      throw new Error(
        `Template "${id}" returns a single entity, not a list. Use run() instead. ` +
        `List connectors: ${lists || 'none registered'}.`
      );
    }

    return {
      template: id,
      template_name: template.name,
      ...(url !== undefined ? { url } : {}),
      ...(params !== undefined ? { params } : {}),
      // params ride along for connectors whose upstream API has no query
      // switch for an option (Ashby's descriptions opt-in trims at extract
      // time; Greenhouse/Workable put theirs in the URL instead).
      data: template.extractList(body, url, params),
      extractedAt: new Date().toISOString()
    };
  }
}

export default TemplateRegistry;
