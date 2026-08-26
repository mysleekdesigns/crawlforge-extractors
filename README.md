# crawlforge-extractors

Extraction logic shared by the [CrawlForge](https://www.crawlforge.dev) MCP server and REST API:
site-specific scrape templates, response body reading, and structural fingerprinting.

## Why this package exists

The MCP server and the REST API used to carry their own copies of the same
extractors. The copies drifted, and nothing detected it:

- `amazon-product` was repaired against live markup in the MCP server on
  2026-08-25. The REST copy kept returning `rating: null`, `currency: null`,
  `review_count: "(198,647)"` and `brand: "Brand: Amazon"` until 2026-08-26.
- `shopify-product` existed on one side only.

A customer would have found both before we did. One implementation removes the
possibility rather than adding a check for it.

The same reasoning brought in `readBody` and the structure signatures: both
were behaviours one surface had and the other did not, for no reason anyone
had decided.

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

### Reading a response body

`readBody` decodes with the body's real charset and refuses to buffer past a
cap. Decoding everything as UTF-8 mangles the large share of the web still
served as Shift_JIS, GBK or ISO-8859-1, and an uncapped read lets one oversized
response exhaust a serverless function.

```js
import { readBody, BodyTooLargeError } from 'crawlforge-extractors';

try {
  const html = await readBody(response, { maxBytes: 10 * 1024 * 1024 });
} catch (error) {
  if (error instanceof BodyTooLargeError) {
    // error.limit and error.size say what happened.
  }
}
```

It takes a `Response` the caller has already issued, not a URL — SSRF policy,
host throttling and timeouts differ between the two surfaces and stay with them.

### Comparing page structure

```js
import { structureSignature, structuralSimilarity } from 'crawlforge-extractors';

const before = structureSignature(cheerio.load(oldHtml));
const after = structureSignature(cheerio.load(newHtml));
structuralSimilarity(before, after); // 0-1
```

A signature is the page's tag vocabulary plus its element-count-by-depth
histogram — a few dozen keys, small enough to store next to a change-tracking
baseline instead of keeping the whole DOM.

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
