/**
 * carriers.js — JSON a page ships outside the <script> variables
 * embeddedState.js already reads: Inertia's page object, Shopify's analytics
 * meta and product JSON, and JSON objects parked in data-* attributes.
 *
 * Pure like embeddedState.js: HTML in, parsed values out, one regex pass per
 * carrier and no full cheerio parse of the document. cheerio is used only to
 * decode the HTML entities of a single attribute value, by loading that one
 * attribute as a fragment — that gets the HTML spec's decoding rules (named,
 * numeric, semicolon-less legacy entities) without a hand-rolled table.
 *
 * Input is attacker-controlled: nothing here throws on malformed markup, and a
 * carrier that is present but unreadable is reported as a warning rather than
 * as a value we did not read. Parsed payloads are returned as data; no URL is
 * lifted out of them, so none needs safeHref here.
 */

import { load } from 'cheerio';

// Same assumptions as embeddedState.js: a script body cannot contain a literal
// "</script", and a <script> inside an HTML comment is not one the page runs.
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

// A data-* attribute with a quoted value. The value group consumes the whole
// quoted run, so a "<" or another attribute's text inside a value is never
// re-read as markup. Unquoted values cannot hold a spaced JSON object and are
// not looked at.
const DATA_ATTR_RE = /\s(data-[\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

// The data-* scan also tracks which tag it is inside: a tag opening, or a
// data-* attribute, whichever comes first. One linear pass.
const TAG_OR_DATA_ATTR_RE = /<([a-zA-Z][\w:-]*)|\s(data-[\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

// One attribute in a start tag, for reading a tag's id once a JSON attribute
// on it qualifies. Sticky; the caller walks from the end of the tag name.
const TAG_ATTR_RE = /\s*([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/y;

/** Never report more than this many data-* attribute payloads per page. */
const MAX_JSON_ATTRIBUTES = 50;

/** A data-* value longer than this is not decoded or parsed. */
const MAX_ATTRIBUTE_CHARS = 5 * 1024 * 1024;

/** Never report more than this many Shopify product JSON blocks per page. */
const MAX_PRODUCT_JSON_BLOCKS = 50;

/**
 * Read an HTML attribute out of a raw tag's attribute string. Same reader as
 * embeddedState.js, plus a bare (valueless) attribute reading as ''.
 * @param {string} attrs
 * @param {string} name
 * @returns {string|null}
 */
function attr(attrs, name) {
  const match = attrs.match(
    new RegExp(`(?:^|\\s)${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))|(?=[\\s/]|$))`, 'i')
  );
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? '';
}

/**
 * Decode the HTML entities in one raw attribute value.
 * @param {string} raw the value without its quotes
 * @param {'"'|"'"} quote the quote it was delimited by (so it cannot occur in raw)
 * @returns {string|null}
 */
function decodeAttribute(raw, quote) {
  if (!raw.includes('&')) return raw;
  try {
    return load(`<x a=${quote}${raw}${quote}>`, null, false)('x').attr('a') ?? null;
  } catch {
    return null;
  }
}

/** @returns {unknown} the parsed value, or undefined when it is not JSON */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Scan a balanced {...} literal starting at `start`, skipping string literals
 * so braces inside strings don't end it. (embeddedState.js has the same
 * scanner; it is not exported.)
 * @param {string} text
 * @param {number} start index of the "{"
 * @returns {string|null} the raw literal, or null if it never closes
 */
function readObjectLiteral(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i++;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === '\\') i++;
        i++;
      }
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
    i++;
  }
  return null;
}

/**
 * Is this <script> tag's attribute string Inertia's page carrier,
 * `<script data-page="app" type="application/json">`? Lets a caller keep the
 * block out of a generic JSON-script list, where it would be reported twice.
 * @param {string} attrs raw attribute string of a <script> tag
 * @returns {boolean}
 */
export function isInertiaPageScript(attrs) {
  if (typeof attrs !== 'string') return false;
  return (attr(attrs, 'type') || '').toLowerCase() === 'application/json' && attr(attrs, 'data-page') !== null;
}

/**
 * The Inertia.js page object — `{ component, props, url, version, … }` —
 * from either carrier Inertia renders:
 *   - `<script data-page="app" type="application/json">{…}</script>`: the
 *     inertia-laravel `use_script_element_for_initial_page` option, and the
 *     only form in Inertia 3 (laravel.com and laracasts.com, 2026-10-03);
 *   - `<div id="app" data-page="{&quot;component&quot;…}">`: the classic
 *     attribute (demo.inertiajs.com, 2026-10-03).
 * The script form is read first; the first carrier found wins.
 *
 * @param {string} html raw HTML
 * @returns {{ value: object|null, warnings: string[] }|null} null when the
 *   page has no Inertia carrier; value null (with a warning) when it has one
 *   that is not a JSON object
 */
export function readInertiaPage(html) {
  if (typeof html !== 'string') return null;
  const doc = html.replace(HTML_COMMENT_RE, '');

  SCRIPT_RE.lastIndex = 0;
  let script;
  while ((script = SCRIPT_RE.exec(doc)) !== null) {
    if (!isInertiaPageScript(script[1])) continue;
    const parsed = parseJson(script[2]);
    if (isPlainObject(parsed)) return { value: parsed, warnings: [] };
    return {
      value: null,
      warnings: ['An Inertia <script data-page type="application/json"> block is present but is not a JSON object; not parsed.']
    };
  }

  // The script form also carries data-page (its value is the root element id),
  // so only a value that decodes to "{…" is the page object.
  DATA_ATTR_RE.lastIndex = 0;
  let match;
  while ((match = DATA_ATTR_RE.exec(doc)) !== null) {
    if (match[1].toLowerCase() !== 'data-page') continue;
    const quote = match[2] !== undefined ? '"' : "'";
    const decoded = decodeAttribute(match[2] ?? match[3], quote);
    if (decoded === null || !decoded.trimStart().startsWith('{')) continue;
    const parsed = parseJson(decoded);
    if (isPlainObject(parsed)) return { value: parsed, warnings: [] };
    return {
      value: null,
      warnings: ['An Inertia data-page attribute is present but its value is not a JSON object; not parsed.']
    };
  }

  return null;
}

/**
 * Is this <script> tag's attribute string a Shopify theme's product JSON
 * block — `type="application/json"` with `data-product-json` or an id
 * starting `ProductJson-`? Lets a caller keep those blocks out of a generic
 * JSON-script list, where they would be reported twice.
 * @param {string} attrs raw attribute string of a <script> tag
 * @returns {boolean}
 */
export function isShopifyProductJsonScript(attrs) {
  if (typeof attrs !== 'string') return false;
  if ((attr(attrs, 'type') || '').toLowerCase() !== 'application/json') return false;
  if (attr(attrs, 'data-product-json') !== null) return true;
  return /^ProductJson-/.test(attr(attrs, 'id') || '');
}

// Every storefront captured on 2026-10-03 (allbirds, kith, brooklinen,
// nativecos, kyomowatches, …) fills ShopifyAnalytics.meta from a local:
//   var meta = {"product":{…,"variants":[{"id":…,"price":10500,…}]},"page":{…}};
//   for (var attr in meta) { window.ShopifyAnalytics.meta[attr] = meta[attr]; }
// Prices there are integers in the shop currency's minor unit (10500 = 105.00).
const META_COPY_RE = /ShopifyAnalytics\.meta\[\s*attr\s*\]\s*=\s*meta\[\s*attr\s*\]/;
const META_VAR_RE = /\bvar\s+meta\s*=\s*/g;
// A direct object assignment; `= window.ShopifyAnalytics.meta || {}` is not one.
const META_ASSIGN_RE = /ShopifyAnalytics\.meta\s*=\s*(?=\{)/g;
const META_CURRENCY_RE = /ShopifyAnalytics\.meta\.currency\s*=\s*(["'])([A-Za-z]{3})\1/;

/**
 * Read ShopifyAnalytics.meta. Returns parsed:undefined (and a warning) when
 * an assignment is there but its literal is not JSON.
 * @param {string} doc
 * @returns {{ meta?: object, warning?: string }}
 */
function readShopifyMeta(doc) {
  const literals = [];

  const copy = META_COPY_RE.exec(doc);
  if (copy) {
    // The `var meta = {…}` this loop copies from: the last one before it.
    META_VAR_RE.lastIndex = 0;
    let last = null;
    let match;
    while ((match = META_VAR_RE.exec(doc)) !== null && match.index < copy.index) last = META_VAR_RE.lastIndex;
    if (last !== null) literals.push(readObjectLiteral(doc, last));
  }

  META_ASSIGN_RE.lastIndex = 0;
  const assign = META_ASSIGN_RE.exec(doc);
  if (assign) literals.push(readObjectLiteral(doc, META_ASSIGN_RE.lastIndex));

  if (literals.length === 0) return {};

  const meta = {};
  let unreadable = false;
  for (const literal of literals) {
    const parsed = literal === null ? undefined : parseJson(literal);
    if (isPlainObject(parsed)) Object.assign(meta, parsed);
    else unreadable = true;
  }

  // The currency is a separate statement, and without it a price of 10500
  // means nothing.
  const currency = META_CURRENCY_RE.exec(doc);
  const read = Object.keys(meta).length > 0;
  if (read && currency && meta.currency === undefined) meta.currency = currency[2];

  const result = {};
  if (read) result.meta = meta;
  if (unreadable) {
    result.warning = 'ShopifyAnalytics.meta is assigned a value that is not a JSON literal; not parsed.';
  }
  return result;
}

/**
 * Shopify's own page JSON: the `ShopifyAnalytics.meta` object (product id,
 * variants with prices in minor units, page type) and every theme product
 * JSON block (`<script type="application/json" data-product-json>` or
 * `id="ProductJson-…"`), parsed and returned whole — themes disagree on their
 * shape (Dawn-era themes ship the product; kyomowatches.com ships
 * `{ product, selected_variant_id }`).
 *
 * @param {string} html raw HTML
 * @returns {{ value: { meta?: object, product_json?: object[] }, warnings: string[] }|null}
 *   null when the page carries neither
 */
export function readShopify(html) {
  if (typeof html !== 'string') return null;
  const doc = html.replace(HTML_COMMENT_RE, '');
  const value = {};
  const warnings = [];

  const { meta, warning } = readShopifyMeta(doc);
  if (meta) value.meta = meta;
  if (warning) warnings.push(warning);

  const productJson = [];
  let blocks = 0;
  SCRIPT_RE.lastIndex = 0;
  let script;
  while ((script = SCRIPT_RE.exec(doc)) !== null) {
    if (!isShopifyProductJsonScript(script[1])) continue;
    blocks++;
    if (productJson.length >= MAX_PRODUCT_JSON_BLOCKS) continue;
    const parsed = parseJson(script[2]);
    if (parsed !== null && typeof parsed === 'object') productJson.push(parsed);
    else warnings.push('A Shopify product JSON <script> block is not valid JSON; skipped.');
  }
  if (blocks > MAX_PRODUCT_JSON_BLOCKS) {
    warnings.push(`${blocks} Shopify product JSON blocks found; only the first ${MAX_PRODUCT_JSON_BLOCKS} were read.`);
  }
  if (productJson.length > 0) value.product_json = productJson;

  if (value.meta === undefined && blocks === 0 && warnings.length === 0) return null;
  return { value, warnings };
}

/**
 * The id attribute of the start tag at `tagStart`, walking its attributes.
 * @param {string} doc
 * @param {number} tagStart index of the "<"
 * @param {number} nameLength
 * @returns {string|null}
 */
function tagId(doc, tagStart, nameLength) {
  let i = tagStart + 1 + nameLength;
  while (i < doc.length && doc[i] !== '>') {
    TAG_ATTR_RE.lastIndex = i;
    const match = TAG_ATTR_RE.exec(doc);
    if (!match || TAG_ATTR_RE.lastIndex === i) {
      i++; // a stray "/", quote or "=": step over it
      continue;
    }
    if (match[1].toLowerCase() === 'id') {
      if (match[2] !== undefined) return decodeAttribute(match[2], '"');
      if (match[3] !== undefined) return decodeAttribute(match[3], "'");
      return match[4] ?? '';
    }
    i = TAG_ATTR_RE.lastIndex;
  }
  return null;
}

/**
 * Every data-* attribute whose entity-decoded value is a JSON object of at
 * least `minBytes` UTF-8 bytes — the big product/config objects themes and
 * component libraries park on an element (allbirds.com's
 * data-product-object and data-colorway-variants, 2026-10-03). Arrays,
 * scalars and invalid JSON are skipped; `data-page` is skipped because
 * readInertiaPage owns it. At most 50 are returned.
 *
 * @param {string} html raw HTML
 * @param {{ minBytes?: number }} [options]
 * @returns {Array<{ tag: string, attribute: string, id: string|null, data: object }>}
 */
export function readJsonAttributes(html, { minBytes = 2048 } = {}) {
  if (typeof html !== 'string') return [];
  const doc = html.replace(HTML_COMMENT_RE, '');
  const out = [];
  let tag = null;
  let tagStart = -1;

  TAG_OR_DATA_ATTR_RE.lastIndex = 0;
  let match;
  while (out.length < MAX_JSON_ATTRIBUTES && (match = TAG_OR_DATA_ATTR_RE.exec(doc)) !== null) {
    if (match[1] !== undefined) {
      tag = match[1];
      tagStart = match.index;
      continue;
    }

    const attribute = match[2].toLowerCase();
    const quote = match[3] !== undefined ? '"' : "'";
    const raw = match[3] ?? match[4];
    // Decoding only ever shortens a value, so a raw value under minBytes
    // cannot qualify; check that before doing any work on it.
    if (attribute === 'data-page' || raw.length < minBytes || raw.length > MAX_ATTRIBUTE_CHARS) continue;
    if (!/^\s*\{/.test(raw) || !/\}\s*$/.test(raw)) continue;

    const decoded = decodeAttribute(raw, quote);
    if (decoded === null || Buffer.byteLength(decoded) < minBytes) continue;
    const data = parseJson(decoded);
    if (!isPlainObject(data)) continue;

    out.push({
      tag: tag === null ? null : tag.toLowerCase(),
      attribute,
      id: tag === null ? null : tagId(doc, tagStart, tag.length),
      data
    });
  }
  return out;
}
