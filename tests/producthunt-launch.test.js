/**
 * Unit tests: the producthunt-launch template.
 *
 * Run: node --test tests/producthunt-launch.test.js
 *
 * Product Hunt folded /posts/* launch pages into /products/* product hubs
 * (observed live 2026-09-01). The rendered DOM changed with the move — the
 * old vote-count/topic selectors returned null on every target — and the RSC
 * flight stream on the new pages is a near-empty shell. The page's real data
 * is the GraphQL Product record in Apollo's streaming-SSR transport pushes,
 * which is what the template reads now. Markup below is condensed from a live
 * chatgpt product-page capture.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TemplateRegistry } from '../src/templates.js';

const registry = new TemplateRegistry();

const PRODUCT_RECORD = `{
  "rehydrate": {
    "_R_1": { "data": undefined, "loading": true },
    "_R_2": {
      "data": {
        "product": {
          "__typename": "Product",
          "id": "526756",
          "slug": "chatgpt",
          "name": "ChatGPT by OpenAI",
          "tagline": "Get answers. Find inspiration. Be more productive.",
          "description": "An LLM to get instant answers.",
          "websiteUrl": "https://openai.com/chatgpt",
          "followersCount": 11496,
          "reviewsCount": 707,
          "reviewsRating": 4.85,
          "categories": [
            { "__typename": "ProductCategory", "id": "126", "name": "LLMs", "slug": "llms" },
            { "__typename": "ProductCategory", "id": "127", "name": "AI Chatbots", "slug": "ai-chatbots" }
          ],
          "latestLaunch": {
            "__typename": "Post",
            "id": "1140101",
            "product": { "__typename": "Product", "id": "526756", "slug": "chatgpt", "websiteUrl": "https://openai.com/chatgpt" }
          }
        }
      }
    }
  }
}`;

const HEAD = `
  <meta property="og:title" content="ChatGPT by OpenAI: Get answers. Find inspiration. Be more productive. | Product Hunt"/>
  <meta property="og:description" content="An LLM to get instant answers, find creative inspiration, and learn something new."/>
  <meta property="og:image" content="https://ph-files.imgix.net/fc5ba01c.png?auto=format"/>
  <meta property="og:url" content="https://www.producthunt.com/products/chatgpt"/>`;

const PAGE = `<!DOCTYPE html><html><head>${HEAD}</head><body>
  <a href="https://openai.com/chatgpt?ref=producthunt" target="_blank" rel="noreferrer noopener ugc" data-test="visit-website-button">Visit website</a>
  <script>(window[Symbol.for("ApolloSSRDataTransport")] ??= []).push(${PRODUCT_RECORD})</script>
</body></html>`;

// The same page with no Apollo transport — the template must degrade to the
// page's meta tags and DOM rather than fabricate.
const PAGE_NO_TRANSPORT = `<!DOCTYPE html><html><head>${HEAD}</head><body>
  <a href="https://openai.com/chatgpt?ref=producthunt" target="_blank" rel="noreferrer noopener ugc" data-test="visit-website-button">Visit website</a>
</body></html>`;

const URL_ = 'https://www.producthunt.com/products/chatgpt';

describe('producthunt-launch', () => {
  test('reads the Product record from the Apollo streaming-SSR transport', async () => {
    const { data } = await registry.run('producthunt-launch', PAGE, URL_);
    assert.equal(data.name, 'ChatGPT by OpenAI', 'clean name, no " | Product Hunt" suffix');
    assert.equal(data.tagline, 'Get answers. Find inspiration. Be more productive.');
    assert.equal(data.description, 'An LLM to get instant answers.');
    assert.equal(data.website, 'https://openai.com/chatgpt');
    assert.deepEqual(data.topics, ['LLMs', 'AI Chatbots']);
    assert.equal(data.followers, 11496);
    assert.equal(data.reviews_count, 707);
    assert.equal(data.reviews_rating, 4.85);
    assert.equal(data.url, 'https://www.producthunt.com/products/chatgpt');
  });

  test('picks the page-level Product record, not a nested stub', async () => {
    // latestLaunch.product is also __typename Product but has no
    // followersCount; the walk must prefer the fuller record.
    const { data } = await registry.run('producthunt-launch', PAGE, URL_);
    assert.equal(data.followers, 11496);
  });

  test('falls back to meta tags and the visit-website button without the transport', async () => {
    const { data } = await registry.run('producthunt-launch', PAGE_NO_TRANSPORT, URL_);
    assert.equal(data.name, 'ChatGPT by OpenAI: Get answers. Find inspiration. Be more productive.',
      'og:title with the site suffix stripped');
    assert.equal(data.website, 'https://openai.com/chatgpt', 'ref=producthunt tracking param removed');
    assert.equal(data.topics, null, 'null = data layer missing, not "no categories"');
    assert.equal(data.followers, null);
  });

  test('detects both /products/ and /posts/ URLs', () => {
    assert.equal(registry.detect('https://www.producthunt.com/products/chatgpt')?.id, 'producthunt-launch');
    assert.equal(registry.detect('https://www.producthunt.com/posts/chatgpt')?.id, 'producthunt-launch');
  });
});
