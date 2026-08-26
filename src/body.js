/**
 * Response body reading: decode with the body's real charset, and refuse to
 * buffer more than the caller allows.
 *
 * Both surfaces issue their own requests — SSRF rules, host throttling and
 * auth differ between them — so this takes a Response that has already come
 * back and only reads it.
 */

export const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor(message, { limit, size }) {
    super(message);
    this.name = 'BodyTooLargeError';
    this.limit = limit;
    this.size = size;
  }
}

/**
 * Determine the charset to decode a body with: the Content-Type header first,
 * then a <meta charset> sniff of the opening bytes, defaulting to utf-8.
 *
 * @param {Response} response
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function detectCharset(response, bytes) {
  const contentType = response.headers?.get?.('content-type') || '';
  const headerMatch = /charset=["']?([\w-]+)/i.exec(contentType);
  if (headerMatch) {
    return headerMatch[1].trim().toLowerCase();
  }

  // <meta charset> tags must appear within the first 1024 bytes per the
  // HTML5 spec's prescan algorithm; ASCII-range bytes decode identically
  // under latin1 regardless of the document's real encoding.
  const sniffLength = Math.min(bytes.byteLength, 1024);
  const sniffText = new TextDecoder('latin1').decode(bytes.subarray(0, sniffLength));
  const metaMatch =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniffText) ||
    /<meta[^>]+http-equiv=["']?content-type["']?[^>]*content=["'][^"']*charset=([\w-]+)/i.exec(sniffText);
  if (metaMatch) {
    return metaMatch[1].trim().toLowerCase();
  }

  return 'utf-8';
}

/**
 * Read a response body as text, capped and charset-correct.
 *
 * @param {Response} response
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<string>}
 * @throws {BodyTooLargeError} when the body exceeds `maxBytes`
 */
export async function readBody(response, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;

  // Cheapest rejection first. Servers may omit or lie about Content-Length;
  // the streaming count below is what actually enforces the cap.
  const declared = Number.parseInt(response.headers?.get?.('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyTooLargeError(
      `Response body too large: Content-Length ${declared} exceeds limit of ${maxBytes} bytes`,
      { limit: maxBytes, size: declared }
    );
  }

  // Only the byte-count guard needs a stream. Responses that are already
  // buffered (and test doubles) are read as-is so callers still get their text.
  if (!response.body || typeof response.body.getReader !== 'function') {
    return response.text();
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      reader.cancel();
      throw new BodyTooLargeError(
        `Response body too large: exceeded limit of ${maxBytes} bytes`,
        { limit: maxBytes, size: totalBytes }
      );
    }
    chunks.push(value);
  }

  // Reassemble in a single pass: totalBytes is already known, so this costs one
  // allocation plus one copy per chunk rather than the O(n^2) of regrowing a
  // buffer as each chunk arrives.
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const charset = detectCharset(response, merged);
  try {
    return new TextDecoder(charset).decode(merged);
  } catch {
    // Unrecognized charset label — utf-8 beats discarding the body.
    return new TextDecoder().decode(merged);
  }
}
