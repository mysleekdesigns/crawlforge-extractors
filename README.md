# crawlforge-extractors

Extraction logic shared by the [CrawlForge](https://www.crawlforge.dev) MCP server and REST API:
site-specific scrape templates, response body reading, structural fingerprinting, and
embedded-state extraction.

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

### Picking a template from a URL

```js
registry.detect('https://www.allbirds.com/collections/mens'); // → shopify-collection
registry.detect('https://example.com/about');                 // → null
```

`detect()` matches on the `targetPattern` each template already carried.
Ranking is deterministic: a pattern that names a host outranks one that only
matches a path shape, so `amazon-product` wins an Amazon URL that happens to
contain `/products/`, which `shopify-product` also matches. Remaining ties go
to registration order.

### List connectors

A template that defines `extractList` returns N entities from one call instead
of one entity from one page. `listUrl(params)` builds the request from a plain
object, and `runList()` mirrors `run()`'s envelope:

```js
const template = registry.get('shopify-collection');

// By params…
const url = template.listUrl({ store: 'www.allbirds.com', collection: 'mens', limit: 250 });
// …or from a collection URL the user already has.
const alsoUrl = template.resolveUrl('https://www.allbirds.com/collections/mens');

const body = await (await fetch(url)).text();
const { data } = await registry.runList('shopify-collection', body, { url });
data.items; // one entity per product, same field shape as shopify-product
data.count; // items.length, unless the source declares a larger total_available
```

`registry.list()` reports `mode: 'list'` or `'entity'` per template, derived
from the presence of `extractList` — there is no stored `kind` field.

### Templates that need an API key

A connector against a key-based API declares `requiresApiKey: true` and
`credentialRef: 'SOME_ENV_VAR'`, surfaced by `list()` as `requires_api_key` and
`credential_ref`. This package never reads `process.env`: the consumer resolves
the variable and passes the key in as `params.apiKey`, and `listUrl` throws an
error naming the variable when it is missing — an actionable message beats a
401 passed through from someone else's API.

`new TemplateRegistry(templates)` takes an alternative template set, which is
how the credential path is tested without shipping a connector nobody has a key
for.

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

### Reading a page's embedded state

`extractEmbeddedState` returns the JSON a page already ships in its own HTML —
`__NEXT_DATA__`, RSC flight chunks (`self.__next_f`), `__NUXT__`,
`__APOLLO_STATE__`, `__INITIAL_STATE__`, `__PRELOADED_STATE__` and
`<script type="application/json">` blocks. No LLM is involved, so the values are
the site's own and cannot be fabricated.

```js
import { extractEmbeddedState, selectJsonPath } from 'crawlforge-extractors';

const { data, found, warnings } = extractEmbeddedState(rawHtml);
// found -> [{ name: 'next_data', variable: '__NEXT_DATA__', bytes: 439333 }]

selectJsonPath(data, 'next_data.props.pageProps.events.0.name');
```

Pass the **raw** HTML. Every source lives in a `<script>` tag, so a document
whose scripts have been stripped has nothing left to read.

Payloads are never truncated — a half-serialized object is worse than a big
one. `selectJsonPath` is how a caller asks for less: dotted keys and array
indexes only, no wildcards, filters or recursive descent. A path that does not
resolve throws naming the keys that *were* available at the point it stopped,
so a typo comes back fixable rather than empty.

A source that is present but is not JSON — Nuxt 2's IIFE wrapper, Nuxt 3's
unquoted-key object literal — is reported in `warnings` unparsed. Nothing here
calls `eval`.

## Templates

**Pages and products.** `shopify-product` · `shopify-collection` ·
`amazon-product` · `linkedin-profile` · `github-repo` · `youtube-video` ·
`tweet` · `reddit-thread` · `hacker-news-front-page` · `producthunt-launch` ·
`stackoverflow-question` · `npm-package`

**Job boards** (`src/connectors/ats.js`). `greenhouse-jobs` ·
`lever-postings` · `ashby-jobs` · `workable-jobs` · `recruitee-offers` ·
`teamtailor-jobs`

**Government APIs** (`src/connectors/gov.js`). `nhtsa-vin` · `npi-provider`

`shopify-collection` is a list connector: it reads a store's own
`/collections/<handle>/products.json` and returns every product in the
collection with the same authoritative price, compare-at price and stock that
`shopify-product` returns for one, so the two cannot disagree. Pass a
collection URL or `{ store, collection }`. Shopify serves 30 products per page
by default and 250 at most, so a large collection needs `page`.

The job-board connectors read each platform's own documented public postings
API, so a board's jobs come back exact rather than parsed out of a rendered
page. All six normalise onto one job shape — `id`, `title`, `url`, `location`,
`department`, `team`, `employment_type`, `remote`, `published_at`,
`updated_at`, `description`, `source` — so two platforms union without
per-source mapping, and a field the platform does not carry is `null` rather
than guessed. Pass a board URL or `{ company }`. Greenhouse defaults to
summary records; `content: true` adds the full HTML descriptions and takes a
large board past 4 MB. `lever-postings` declares `crawlDelaySeconds: 1`,
which `api.lever.co/robots.txt` asks for and the calling surface's host rate
limiter is expected to honour.

`stackoverflow-question` reads the Stack Exchange API rather than the rendered
page: stackoverflow.com answers every non-browser fetch (curl, node, and a
browser User-Agent alike) with a Cloudflare 403, so the old selector extractor
never saw a document. The API is keyless — 300 requests per day per IP — and
one request carries the question, its owner and every answer; the template
returns the accepted answer first, then by score, with bodies as plain text.

`nhtsa-vin` decodes a VIN through the NHTSA vPIC API — the ~154 returned
fields are curated into a named vehicle shape with the API's empty-string
"not applicable" normalised to `null`, the full set kept under `raw`, and the
API's own `ErrorCode`/`ErrorText` surfaced as `decode_errors` rather than
swallowed, because a partial decode is a real answer. `npi-provider` reads the
CMS NPI Registry — a public professional registry — and passes its records
through as published. Neither needs a key.

`reddit-thread` is registered here but reddit.com blocks plain fetchers; the
REST API steers those callers to its `reddit_search` tool instead.

`smartrecruiters-postings` is deliberately **not** shipped: SmartRecruiters
documents the endpoint publicly, but `api.smartrecruiters.com/robots.txt`
disallows everything for every agent except `LinkedInBot`. Reaching it would
mean overriding robots.txt on every call, which is not a connector's decision
to make for its caller.

## Tests

```bash
npm test
```

Fixtures are captured from live pages, not written to match the selectors —
that inversion is what let the original break go unnoticed.

## License

MIT
