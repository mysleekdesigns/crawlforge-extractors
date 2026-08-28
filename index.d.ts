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

export default TemplateRegistry;
