import type { load } from 'cheerio';

/** The parsed-document type cheerio's load() returns. */
export type CheerioDoc = ReturnType<typeof load>;

/** What extractList returns: N entities, plus whatever meta the connector has. */
export interface TemplateList extends Record<string, unknown> {
  items: Record<string, unknown>[];
  /** items.length, unless the payload declares a larger total. */
  count: number;
  /** Present only when the source declares a total beyond this page. */
  total_available?: number;
}

export interface ScrapeTemplate {
  /** Slug callers pass as the `template` parameter. */
  id: string;
  name: string;
  description: string;
  /**
   * URLs this template handles, and what detect() matches on. Absent on a list
   * connector reached by params rather than by URL.
   */
  targetPattern?: RegExp;
  /**
   * Extract from the parsed page. Absent on templates that read a
   * machine-readable endpoint instead — those define extractRaw.
   */
  extract?: ($: CheerioDoc) => Record<string, unknown>;
  /**
   * Rewrite the URL the caller should fetch. shopify-product uses this to read
   * /products/<handle>.json rather than the rendered page.
   */
  resolveUrl?: (url: string) => string;
  /**
   * Parse the fetched body directly, in place of extract(). Throws when the
   * response does not belong to this template — callers should surface that as
   * a bad request, not a server error.
   */
  extractRaw?: (body: string, url: string) => Record<string, unknown>;
  /**
   * Build the URL to fetch from a plain params object. Throws an Error naming
   * the parameter when a required one is missing — including the API key,
   * which arrives as params.apiKey.
   */
  listUrl?: (params?: Record<string, unknown>) => string;
  /**
   * Parse the response into N entities. Defining this is the only thing that
   * makes a template a list connector; there is no `kind` field.
   */
  extractList?: (body: string, url?: string) => TemplateList;
  /** The connector reads a key-based API. */
  requiresApiKey?: true;
  /**
   * Name of the env var the CONSUMER reads for that key. This package never
   * touches process.env; the key is passed in as params.apiKey.
   */
  credentialRef?: string;
  /**
   * Crawl-delay the platform's robots.txt asks for, in seconds. The
   * connector does not fetch, so honouring it is the calling surface's
   * host rate limiter's job.
   */
  crawlDelaySeconds?: number;
}

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  /** targetPattern rendered as a string, or null on a params-only connector. */
  targetPattern: string | null;
  /** Derived from extractList: 'list' returns N entities, 'entity' returns one. */
  mode: 'list' | 'entity';
  /** Present only when the template sets requiresApiKey. */
  requires_api_key?: true;
  /** Present only when the template sets credentialRef. */
  credential_ref?: string;
}

export interface TemplateResult {
  template: string;
  template_name: string;
  url: string;
  /** Present only when resolveUrl pointed the fetch somewhere else. */
  fetchedUrl?: string;
  data: Record<string, unknown>;
  extractedAt: string;
}

export interface TemplateListResult {
  template: string;
  template_name: string;
  /** Whichever of the two the caller reached the endpoint with. */
  url?: string;
  params?: Record<string, unknown>;
  data: TemplateList;
  extractedAt: string;
}

export declare const TEMPLATES: ScrapeTemplate[];

/**
 * Templates withdrawn because there is no compliant way to reach the data,
 * by id: the URL shape each one handled, and why it is gone.
 */
export declare const RETIRED_TEMPLATES: Record<string, { targetPattern: RegExp; reason: string }>;

/**
 * The retired template a caller is reaching for — by id, or by a URL one of
 * them handled — or null.
 */
export declare function retiredTemplate(idOrUrl: string): { id: string; reason: string } | null;

export declare class TemplateRegistry {
  /** @param templates injectable, so a test can register a fixture template. */
  constructor(templates?: ScrapeTemplate[]);
  list(): TemplateSummary[];
  get(id: string): ScrapeTemplate | undefined;
  /**
   * Pick the template that handles a URL, or null when none does. A pattern
   * naming a host outranks one matching only a path shape; remaining ties go to
   * registration order.
   */
  detect(url: string | null | undefined): ScrapeTemplate | null;
  /**
   * Run a template against a fetched body. Templates never fetch: the caller
   * owns SSRF policy, timeouts and billing.
   */
  run(id: string, body: string, url: string, fetchedUrl?: string): Promise<TemplateResult>;
  /**
   * Run a list connector against a fetched body — N entities where run()
   * returns one. Throws when the template defines no extractList.
   */
  runList(
    id: string,
    body: string,
    context?: { url?: string; params?: Record<string, unknown> }
  ): Promise<TemplateListResult>;
}

/** Default cap on a buffered response body: 25 MB. */
export declare const DEFAULT_MAX_BODY_BYTES: number;

/** Thrown by readBody when a response exceeds the cap it was given. */
export declare class BodyTooLargeError extends Error {
  name: 'BodyTooLargeError';
  /** The cap that was exceeded, in bytes. */
  limit: number;
  /** Declared or accumulated size that tripped it, in bytes. */
  size: number;
}

/**
 * Pick the charset to decode a body with: Content-Type, then a <meta charset>
 * sniff of the opening bytes, then utf-8.
 */
export declare function detectCharset(response: Response, bytes: Uint8Array): string;

/**
 * Read a response body as text, capped and decoded with its real charset.
 * Throws BodyTooLargeError past the cap.
 */
export declare function readBody(
  response: Response,
  options?: { maxBytes?: number }
): Promise<string>;

export interface StructureSignature {
  /** Sorted, de-duplicated tag vocabulary. */
  tags: string[];
  /** Element count per nesting depth. */
  depths: Record<string, number>;
}

/**
 * Reduce a parsed document to a signature small enough to store. Pass `root`
 * to fingerprint one subtree instead of the whole document.
 */
export declare function structureSignature(
  $: CheerioDoc,
  root?: ReturnType<CheerioDoc>
): StructureSignature;

/** Compare two signatures, 0-1. */
export declare function structuralSimilarity(
  baseline: Partial<StructureSignature> | null | undefined,
  current: Partial<StructureSignature> | null | undefined
): number;

/** One embedded-state payload a page carries, as reported in `found`. */
export interface EmbeddedStateSource {
  /** Path-safe key this payload is addressed by, e.g. "next_data". */
  name: string;
  /** The raw thing it was read from, e.g. "__NEXT_DATA__", "self.__next_f". */
  variable: string;
  /** Serialized size of this payload alone. */
  bytes: number;
  /** Present when the shape needs explaining (RSC rows, json_scripts blocks). */
  note?: string;
}

export interface EmbeddedStateResult {
  /** Payloads keyed by `name`; empty when the page ships no readable state. */
  data: Record<string, unknown>;
  found: EmbeddedStateSource[];
  /** Sources seen but not parsed, and blocks that were not valid JSON. */
  warnings: string[];
}

/**
 * Find the JSON state a page already ships in its own HTML: __NEXT_DATA__,
 * RSC flight chunks (self.__next_f), __NUXT__, __APOLLO_STATE__,
 * __INITIAL_STATE__, __PRELOADED_STATE__ and <script type="application/json">.
 *
 * Pass the RAW html. A script-stripped document has nothing left to read.
 */
export declare function extractEmbeddedState(rawHtml: string): EmbeddedStateResult;

/** Split a path into its segments. Dotted keys and array indexes only. */
export declare function parseJsonPath(path: string): string[];

/**
 * Resolve a path against a parsed object. Not JSONPath: no wildcards, filters,
 * slices or recursive descent. Throws naming the keys that were available at
 * the point it stopped.
 */
export declare function selectJsonPath(root: unknown, path: string): unknown;

/** One variant as read from a product page's JSON-LD; stock counts and compare-at prices are not in JSON-LD. */
export interface ShopifyJsonLdVariant {
  id: string | null;
  title: string | null;
  price: string | null;
  compare_at_price: null;
  sku: string | null;
  available: boolean | null;
  inventory_quantity: null;
  options: string[];
}

/** The shopify-product record shape, read from schema.org JSON-LD instead of /products/<handle>.json. */
export interface ShopifyJsonLdProduct {
  title: string | null;
  vendor: string | null;
  product_type: string | null;
  handle: string | null;
  product_id: string | null;
  price: string | null;
  compare_at_price: null;
  on_sale: null;
  currency: string | null;
  price_min: string | null;
  price_max: string | null;
  available: boolean | null;
  variants: ShopifyJsonLdVariant[];
  options: string[];
  description: string | null;
  images: string[];
  url: string;
  source: 'json-ld';
}

/**
 * A Shopify product from the product page's own schema.org JSON-LD (Product,
 * ProductGroup with hasVariant, AggregateOffer), for stores that refuse
 * /products/<handle>.json. `url` is the page URL after redirects; a
 * /collections/ URL is named in `reason` as a retired handle.
 */
export declare function shopifyProductFromJsonLd(
  html: string,
  url: string
): { found: true; data: ShopifyJsonLdProduct } | { found: false; reason: string };

export default TemplateRegistry;
