/**
 * crawlforge-extractors — the extraction logic the CrawlForge MCP server and
 * the REST API both run.
 *
 * It exists because they used to each carry their own copy. The copies drifted:
 * amazon-product was repaired against live markup in the MCP server on
 * 2026-08-25 and the REST copy kept returning null ratings, null currency and
 * "Brand: Amazon" until 2026-08-26, and shopify-product existed on one side
 * only. Nothing detected either gap — a customer would have.
 *
 * Only logic that is pure and dependency-light belongs here: parse a body,
 * return fields. Fetching, billing, auth, caching and browser work stay with
 * whichever surface is calling — which is why readBody takes a Response the
 * caller has already issued rather than a URL.
 */

export { TemplateRegistry, TEMPLATES, RETIRED_TEMPLATES, retiredTemplate } from './src/templates.js';
export { TemplateRegistry as default } from './src/templates.js';

export {
  readBody,
  detectCharset,
  BodyTooLargeError,
  DEFAULT_MAX_BODY_BYTES
} from './src/body.js';

export { structureSignature, structuralSimilarity } from './src/structure.js';

export { extractEmbeddedState } from './src/embeddedState.js';

export { parseJsonPath, selectJsonPath } from './src/jsonPath.js';

export { shopifyProductFromJsonLd } from './src/shopifyJsonLd.js';
