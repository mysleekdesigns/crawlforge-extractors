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

export default TemplateRegistry;
