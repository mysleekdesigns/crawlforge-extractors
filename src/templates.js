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
 * that owns them.
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

  return raw;
}

/** "4.7 out of 5 stars" → 4.7 */
function amazonRating(value) {
  const match = tidy(value)?.match(/([\d.]+)/);
  return match ? Number.parseFloat(match[1]) : null;
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
    targetPattern: /amazon\.(com|co\.uk|de|fr|jp|ca|com\.au)/i,
    extract($) {
      const bullets = $('#feature-bullets ul li span.a-list-item')
        .map((_, el) => tidy($(el).text()))
        .get()
        .filter(Boolean);
      const images = [attr($, '#landingImage', 'src'), ...listAttr($, '#altImages img', 'src')]
        .map(fullSizeImage)
        .filter(Boolean);

      return {
        title: tidy(text($, '#productTitle')),
        price: text($, '.a-price .a-offscreen') || text($, '#priceblock_ourprice') || text($, '#priceblock_dealprice'),
        // Amazon ships no priceCurrency meta tag — the ISO code is a hidden
        // field on the add-to-cart form.
        currency: attr($, 'input[name*="currencyCode"]', 'value') || attr($, 'meta[itemprop="priceCurrency"]', 'content'),
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
    id: 'linkedin-profile',
    name: 'LinkedIn Profile',
    description: 'Scrape a LinkedIn public profile for name, headline, location, and about section.',
    targetPattern: /linkedin\.com\/in\//i,
    extract($) {
      return {
        name: text($, 'h1') || text($, '.top-card-layout__title'),
        headline: text($, '.top-card-layout__headline') || text($, 'h2'),
        location: text($, '.top-card-layout__first-subline') || text($, '.profile-info-subheader'),
        about: text($, '.core-section-container__content p') || text($, '.summary'),
        connections: text($, '.top-card__connections'),
        current_company: text($, '.top-card-layout__card-inner-full-width .top-card-link'),
        note: 'LinkedIn requires authentication for full profiles. This template works on public profile pages only.'
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
        homepage: about ? about.website || null : attr($, 'a[href][rel="noopener noreferrer"]', 'href'),
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
        channel_url: attr($, 'span[itemprop="author"] link[itemprop="url"]', 'href'),
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
    id: 'tweet',
    name: 'Tweet / X Post',
    description: 'Scrape a tweet/X post for text, author, timestamp, likes, and retweets from the Open Graph / structured data.',
    targetPattern: /(twitter|x)\.com\/[^/]+\/status\//i,
    extract($) {
      return {
        text: attr($, 'meta[property="og:description"]', 'content'),
        author: attr($, 'meta[property="og:title"]', 'content'),
        url: attr($, 'meta[property="og:url"]', 'content') || attr($, 'link[rel="canonical"]', 'href'),
        image: attr($, 'meta[property="og:image"]', 'content'),
        note: 'X.com requires JavaScript rendering for full tweet data. Structured metadata is returned from static HTML.'
      };
    }
  },

  {
    id: 'reddit-thread',
    name: 'Reddit Thread',
    description: 'Scrape a Reddit thread for title, subreddit, score, comment count, author, and top-level comments.',
    targetPattern: /reddit\.com\/r\/[^/]+\/comments\//i,
    extract($) {
      return {
        title: attr($, 'meta[property="og:title"]', 'content') || text($, 'h1'),
        subreddit: text($, 'a[href*="/r/"][class*="subreddit"]') || (($('title').text().match(/r\/([^•]+)/) || [])[1] || '').trim(),
        score: text($, '[data-score]') || attr($, '[itemprop="upvoteCount"]', 'content'),
        author: text($, 'a[href*="/user/"]'),
        posted: attr($, 'time[datetime]', 'datetime'),
        body: text($, 'div[data-click-id="text"] p') || attr($, 'meta[property="og:description"]', 'content'),
        url: attr($, 'meta[property="og:url"]', 'content'),
        flair: text($, '[class*="flair"]')
      };
    }
  },

  {
    id: 'hacker-news-front-page',
    name: 'Hacker News Front Page',
    description: 'Scrape the Hacker News front page for a list of stories with title, URL, score, and comment count.',
    targetPattern: /news\.ycombinator\.com(\/news)?$/i,
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
          url: $titleLink.attr('href'),
          site: $row.find('.sitebit a').text().trim() || null,
          score: $score.text().replace(' points', '').trim() || null,
          author: $subtext.find('.hnuser').text().trim() || null,
          // ".age a" wraps the relative age string ("3 hours ago"); its href is the item permalink.
          posted: $subtext.find('.age a').text().trim() || null,
          // The comments link is also an item?id= link, so exclude the age anchor.
          // Job posts have no comments link at all -> null.
          comments: $subtext.find('a[href*="item"]').not('.age a').last().text().trim() || null
        });
      });
      return { stories: stories.slice(0, 30), scraped_at: new Date().toISOString() };
    }
  },

  {
    id: 'producthunt-launch',
    name: 'Product Hunt Launch',
    description: 'Scrape a Product Hunt product page for name, tagline, vote count, topics, and maker details.',
    targetPattern: /producthunt\.com\/posts\//i,
    extract($) {
      return {
        name: attr($, 'meta[property="og:title"]', 'content'),
        tagline: attr($, 'meta[property="og:description"]', 'content'),
        image: attr($, 'meta[property="og:image"]', 'content'),
        url: attr($, 'meta[property="og:url"]', 'content'),
        votes: text($, '[data-test="vote-button"] span') || text($, 'button[data-vote-button]'),
        topics: list($, 'a[href*="/topics/"]'),
        website: attr($, 'a[data-test="product-link"]', 'href') || attr($, 'a[href][rel="noopener"][target="_blank"]', 'href')
      };
    }
  },

  {
    id: 'stackoverflow-question',
    name: 'Stack Overflow Question',
    description: 'Scrape a Stack Overflow question for title, body, votes, tags, answers, and accepted answer.',
    targetPattern: /stackoverflow\.com\/questions\//i,
    extract($) {
      const answers = [];
      $('.answer').each((_, el) => {
        const $a = $(el);
        answers.push({
          votes: $a.find('[itemprop="upvoteCount"]').attr('content') || $a.find('.js-vote-count').text().trim(),
          accepted: $a.hasClass('accepted-answer'),
          body: $a.find('.s-prose').first().text().trim().slice(0, 500)
        });
      });

      return {
        title: text($, '#question-header h1'),
        body: text($, '.question .s-prose'),
        votes: text($, '.question .js-vote-count') || attr($, '.question [itemprop="upvoteCount"]', 'content'),
        views: text($, '.js-view-count') || attr($, 'meta[name="twitter:data1"]', 'content'),
        tags: list($, '.post-tag'),
        author: text($, '.question .user-details a'),
        asked: attr($, '.question time', 'datetime'),
        answers: answers.slice(0, 5),
        answered: $('div.accepted-answer').length > 0
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
        homepage: release.homepage || doc.homepage || null,
        repository: npmRepositoryUrl(release.repository || doc.repository),
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

    const data = template.extractRaw
      ? template.extractRaw(body, url)
      : template.extract(load(body));

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
      data: template.extractList(body, url),
      extractedAt: new Date().toISOString()
    };
  }
}

export default TemplateRegistry;
