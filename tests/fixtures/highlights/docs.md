Last updated 2026-09-01.

# Reading a response body

`readBody` decodes a response with its real charset and refuses to buffer past a cap. See the [charset notes](https://example.com/docs/charsets), the [limits page](https://example.com/docs/limits) and the [changelog](https://example.com/changelog) for the details.

## Installation

```
npm install crawlforge-extractors
```

CrawlForge runs on Node.js 18 or later, e.g. the current LTS. Version v2.0 removed the legacy client. Dr. Smith wrote the original parser.

## Usage

```js
import { readBody, BodyTooLargeError } from 'crawlforge-extractors';

const html = await readBody(response, { maxBytes: 10 * 1024 * 1024 });
```

> Note: pass the `Response` you already issued, not a URL. SSRF policy stays with the caller.

What you get back:

- A string decoded with the body's declared charset.
- `BodyTooLargeError` past the cap, with `limit` and `size` set.
- Nothing else — no retries, no network.

1. Issue the fetch under your own timeout.
2. Hand the response to the reader.
3. Catch the error and report the cap.

## Errors

~~~
BodyTooLargeError: body of 31457280 bytes exceeds the 10485760-byte cap
~~~

Was the cap too small? Raise `maxBytes`. Was the body unexpected? Check the URL.
