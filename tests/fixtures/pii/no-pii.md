# CrawlForge pricing and release notes

Last updated 2026-09-05. Previous revisions: 2026-08-31, 2026/07/14, 14.02.2026,
and the original announcement on 2025-11-03.

## Plans

| Plan       | Monthly    | Yearly      | Credits   | Overage        |
|------------|------------|-------------|-----------|----------------|
| Free       | $0.00      | $0.00       | 1,000     | n/a            |
| Starter    | $19.00     | $190.00     | 25,000    | $9.00 / 1,000  |
| Pro        | $99.00     | $990.00     | 250,000   | $9.00 / 1,000  |
| Scale      | $1,234.56  | $12,345.60  | 5,000,000 | $7.50 / 1,000  |

European formatting on the EU price sheet: 1 234,56 EUR and 12 345,60 EUR, with
a floor of 2 499,00 EUR for the annual commitment.

## Versions

The MCP server is at 5.9.0 (previously 5.8.0, 5.6.11, 5.6.9, 5.6.1 and 4.2.2).
The shared extractor package is 1.8.0. Node 18.20.4 and Node 22.11.0 are both
supported; npm 10.8.2 ships with the first of those. Semver ranges in the
lockfile read ^1.8.0 and >=18.17.1 <19.0.0.

## Identifiers

Reservation ids look like res_0194f2a8c31d47b0 and checkout sessions like
cs_live_a1b2c3d4e5f6g7h8i9. A usage-log row carries request_id
7f3a91c2-4b8e-4d1a-9f66-2c0e5b7a8d31 and a Stripe price id such as
price_1QRstUvWxYz0123456789Abc. Webhook deliveries are numbered 1757116800000
and 1757203200000 in epoch milliseconds.

Print catalogue: ISBN 978-0-13-235088-4, ISBN 0-13-235088-2, and the ISSN
0317-8471. The SKU grid runs SKU-4029-1187, SKU-4029-1188 and SKU-4029-1189.

## Endpoints

See https://www.crawlforge.dev/docs/v1/tools/scrape and the archived copy at
https://cdn.example.com/assets/20260905123045/bundle.9f2c41e8.js. Batch results
live under /api/v1/batches/9876543210987654321/results and the mirror at
http://192.168.1.10:8888/status. IPv4 ranges 10.0.0.0/8 and 172.16.0.0/12 are
never routed.

## Counters

Requests handled last quarter: 4 021 118 and 9 887 213. Rows scanned: 1 2 3 4 5
6 7 8 9 10 11 12 13 14 15. Latency percentiles in ms: 41.2, 88.7, 213.4, 902.6.
Uptime 99.98%. Coordinates for the datacentre: 37.7749, -122.4194.

Ticket numbers 100-200-3000 and 012-345-6789 are internal and never public.
