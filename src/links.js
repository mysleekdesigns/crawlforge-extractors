/**
 * The link records extract_links returns on both surfaces.
 *
 * The MCP server and the REST route used to read links their own way: one
 * compared origins, the other hostnames; one honoured `<base href>`, the other
 * did not; one dropped `javascript:` links, the other counted them as
 * external; neither normalised before deduping. The same URL gave different
 * counts. Both now read links here.
 */

import { safeHref } from './urls.js';

/**
 * Non-web schemes whose href is kept on a `type: "other"` record. Neither
 * runs anything when followed, which is what `safeHref` guards against; every
 * other scheme (`javascript:`, `data:`, `vbscript:`, …) keeps its record with
 * `href` and `original_href` null.
 */
const KEPT_OTHER_SCHEMES = new Set(['mailto:', 'tel:']);

/**
 * The URL a link is deduplicated under: no fragment, no trailing slash on a
 * non-root path. The record keeps the href as written on the page.
 * @param {URL} url
 * @returns {string}
 */
function dedupeKey(url) {
  const key = new URL(url.href);
  key.hash = '';
  if (key.pathname.length > 1 && key.pathname.endsWith('/')) key.pathname = key.pathname.slice(0, -1);
  return key.href;
}

/**
 * @param {string|undefined} value
 * @returns {URL|null}
 */
function parseUrl(value) {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Every `<a href>` in the document as a record, in document order.
 *
 * - `type`: `internal` (same hostname as the page), `external`, `anchor` (an
 *   href that is only a `#fragment`, left as written), `other` (any non-web
 *   scheme: `mailto:`, `tel:`, `javascript:`, …) or `relative` (a relative
 *   href with no page or base URL to resolve it against).
 * - The resolution base is `baseUrl` when given, else the document's
 *   `<base href>` resolved against `pageUrl`, else `pageUrl`. Internal versus
 *   external is judged against `pageUrl`'s host (`baseUrl`'s when there is no
 *   page URL).
 * - Deduplicated (unless `dedupe: false`) on the URL without its fragment and
 *   without a trailing slash; the first occurrence is kept.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {{ pageUrl?: string, baseUrl?: string, includeAnchors?: boolean, dedupe?: boolean }} [options]
 * @returns {{ href: string|null, text: string, type: 'internal'|'external'|'anchor'|'other'|'relative',
 *   domain: string|null, rel: string|null, original_href: string|null, title?: string }[]}
 */
export function extractLinkRecords($, { pageUrl, baseUrl, includeAnchors = false, dedupe = true } = {}) {
  const page = parseUrl(pageUrl);
  let base = parseUrl(baseUrl);
  if (!base) {
    const baseHref = $('base[href]').first().attr('href');
    let docBase = null;
    if (baseHref) {
      try {
        docBase = new URL(baseHref, page ?? undefined);
      } catch {
        // An invalid <base href> is ignored, as a browser does.
      }
    }
    base = docBase || page;
  }
  const host = (page || base)?.hostname ?? null;

  const records = [];
  const seen = new Set();

  $('a[href]').each((_, element) => {
    const $el = $(element);
    const raw = ($el.attr('href') || '').trim();
    if (!raw) return;

    const text = $el.text().replace(/\s+/g, ' ').trim();
    const rel = $el.attr('rel')?.trim() || null;
    const title = $el.attr('title')?.trim();

    let record;
    let key;
    if (raw.startsWith('#')) {
      if (!includeAnchors) return;
      record = { href: raw, text, type: 'anchor', domain: null, rel, original_href: raw };
      key = `anchor:${raw}`;
    } else {
      let url;
      try {
        url = base ? new URL(raw, base) : new URL(raw);
      } catch {
        // No base to resolve against: a relative href stays as written.
        if (base || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return;
        record = { href: raw, text, type: 'relative', domain: null, rel, original_href: raw };
        key = `relative:${raw}`;
      }
      if (url && (url.protocol === 'http:' || url.protocol === 'https:')) {
        record = {
          href: url.href,
          text,
          type: url.hostname === host ? 'internal' : 'external',
          domain: url.hostname,
          rel,
          original_href: safeHref(raw)
        };
        key = dedupeKey(url);
      } else if (url) {
        const kept = KEPT_OTHER_SCHEMES.has(url.protocol);
        record = {
          href: kept ? url.href : null,
          text,
          type: 'other',
          domain: null,
          rel,
          original_href: kept ? raw : null
        };
        key = `other:${url.href}`;
      }
    }

    if (dedupe) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    if (title) record.title = title;
    records.push(record);
  });

  return records;
}
