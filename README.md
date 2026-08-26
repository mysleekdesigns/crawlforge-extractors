# crawlforge-extractors

Site-specific extraction logic shared by the [CrawlForge](https://www.crawlforge.dev) MCP server and REST API.

## Why this package exists

The MCP server and the REST API used to carry their own copies of the same
extractors. The copies drifted, and nothing detected it:

- `amazon-product` was repaired against live markup in the MCP server on
  2026-08-25. The REST copy kept returning `rating: null`, `currency: null`,
  `review_count: "(198,647)"` and `brand: "Brand: Amazon"` until 2026-08-26.
- `shopify-product` existed on one side only.

A customer would have found both before we did. One implementation removes the
possibility rather than adding a check for it.

## Scope

Only pure, dependency-light logic belongs here: parse a body, return fields.
Fetching, billing, auth, caching and browser work stay with whichever surface
is calling — which is also what keeps this package installable in a Vercel
function without pulling a browser stack behind it.

## Usage

```js
import { TemplateRegistry } from 'crawlforge-extractors';

const registry = new TemplateRegistry();

// Templates never fetch. The caller does, under its own SSRF and timeout policy.
const template = registry.get('shopify-product');
const url = 'https://shop.example.com/products/some-handle';
const fetchUrl = template.resolveUrl ? template.resolveUrl(url) : url;

const body = await (await fetch(fetchUrl)).text();
const result = await registry.run('shopify-product', body, url, fetchUrl);
```

`run()` dispatches to `extractRaw(body, url)` when a template defines one, and
to `extract($)` with a cheerio document otherwise.

A template that rejects a response as not its own throws — surface that to the
caller as a bad request, not a server error.

## Templates

`shopify-product` · `amazon-product` · `linkedin-profile` · `github-repo` ·
`youtube-video` · `tweet` · `reddit-thread` · `hacker-news-front-page` ·
`producthunt-launch` · `stackoverflow-question` · `npm-package`

`reddit-thread` is registered here but reddit.com blocks plain fetchers; the
REST API steers those callers to its `reddit_search` tool instead.

## Tests

```bash
npm test
```

Fixtures are captured from live pages, not written to match the selectors —
that inversion is what let the original break go unnoticed.

## License

MIT
