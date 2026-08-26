import type { load } from 'cheerio';

/** The parsed-document type cheerio's load() returns. */
export type CheerioDoc = ReturnType<typeof load>;

export interface ScrapeTemplate {
  /** Slug callers pass as the `template` parameter. */
  id: string;
  name: string;
  description: string;
  /** URLs this template handles. */
  targetPattern: RegExp;
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
}

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  /** targetPattern rendered as a string, for JSON responses. */
  targetPattern: string;
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

export declare const TEMPLATES: ScrapeTemplate[];

export declare class TemplateRegistry {
  list(): TemplateSummary[];
  get(id: string): ScrapeTemplate | undefined;
  /**
   * Run a template against a fetched body. Templates never fetch: the caller
   * owns SSRF policy, timeouts and billing.
   */
  run(id: string, body: string, url: string, fetchedUrl?: string): Promise<TemplateResult>;
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
