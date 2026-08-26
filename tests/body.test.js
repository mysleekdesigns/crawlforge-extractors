/**
 * Unit tests: response body reading.
 *
 * Run: node --test tests/body.test.js
 *
 * The two behaviours here are the reason this module exists. Decoding every
 * body as UTF-8 mangles the large share of the web still served as Shift_JIS,
 * GBK or ISO-8859-1, and reading a body without a cap lets one oversized
 * response exhaust a serverless function's memory.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  readBody,
  detectCharset,
  BodyTooLargeError,
  DEFAULT_MAX_BODY_BYTES
} from '../src/body.js';

/** Build a Response whose body streams in the given chunks. */
function streaming(chunks, headers = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
  return new Response(stream, { headers });
}

const utf8 = (text) => new TextEncoder().encode(text);

/**
 * A header-only Response. Built from a null body on purpose: passing a string
 * makes fetch stamp on `content-type: text/plain;charset=UTF-8`, which the
 * header branch would then answer with, so the sniffing tests below would pass
 * without ever reaching the sniff.
 */
const headersOnly = (headers) => new Response(null, headers ? { headers } : undefined);

describe('detectCharset', () => {
  test('prefers the Content-Type header', () => {
    const response = headersOnly({ 'content-type': 'text/html; charset=Shift_JIS' });
    assert.equal(detectCharset(response, utf8('')), 'shift_jis');
  });

  test('the header wins even when the document disagrees', () => {
    const response = headersOnly({ 'content-type': 'text/html; charset=iso-8859-1' });
    const bytes = utf8('<meta charset="gbk">');
    assert.equal(detectCharset(response, bytes), 'iso-8859-1');
  });

  test('sniffs <meta charset> when the header says nothing', () => {
    const response = headersOnly({ 'content-type': 'text/html' });
    const bytes = utf8('<!doctype html><html><head><meta charset="gbk">');
    assert.equal(detectCharset(response, bytes), 'gbk');
  });

  test('reads the http-equiv form of the meta tag', () => {
    const bytes = utf8('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">');
    assert.equal(detectCharset(headersOnly(), bytes), 'iso-8859-1');
  });

  test('ignores a <meta charset> that appears past the 1024-byte prescan window', () => {
    const bytes = utf8('<!-- ' + 'x'.repeat(1100) + ' --><meta charset="gbk">');
    assert.equal(detectCharset(headersOnly(), bytes), 'utf-8');
  });

  test('defaults to utf-8 with no header and no meta tag', () => {
    assert.equal(detectCharset(headersOnly(), utf8('<html>')), 'utf-8');
  });
});

describe('readBody decoding', () => {
  test('decodes a non-UTF-8 body using its declared charset', async () => {
    // "Ärger" in ISO-8859-1: Ä is a single 0xC4 byte, which is not valid UTF-8.
    const bytes = new Uint8Array([0xc4, 0x72, 0x67, 0x65, 0x72]);
    const response = streaming([bytes], { 'content-type': 'text/html; charset=iso-8859-1' });
    assert.equal(await readBody(response), 'Ärger');
  });

  test('the same bytes read as UTF-8 would have been corrupted', async () => {
    const bytes = new Uint8Array([0xc4, 0x72, 0x67, 0x65, 0x72]);
    assert.notEqual(new TextDecoder().decode(bytes), 'Ärger');
  });

  test('falls back to utf-8 when the charset label is not a real encoding', async () => {
    const response = streaming([utf8('hello')], { 'content-type': 'text/html; charset=not-a-charset' });
    assert.equal(await readBody(response), 'hello');
  });

  test('joins multiple chunks in order', async () => {
    const response = streaming([utf8('one '), utf8('two '), utf8('three')]);
    assert.equal(await readBody(response), 'one two three');
  });

  test('decodes a multi-byte character split across a chunk boundary', async () => {
    // € is E2 82 AC; the stream breaks it in half.
    const response = streaming([new Uint8Array([0xe2, 0x82]), new Uint8Array([0xac])]);
    assert.equal(await readBody(response), '€');
  });

  test('reads a response that has no readable stream', async () => {
    // Test doubles and already-buffered responses have no getReader.
    const fake = { headers: new Headers(), text: async () => 'buffered' };
    assert.equal(await readBody(fake), 'buffered');
  });

  test('returns an empty string for an empty body', async () => {
    assert.equal(await readBody(streaming([])), '');
  });
});

describe('readBody size cap', () => {
  test('rejects on Content-Length without reading the body', async () => {
    // The body is empty, so a reported size of 5000 can only have come from
    // the header check — the streaming counter would have said 0.
    const response = streaming([], { 'content-length': '5000' });

    await assert.rejects(
      () => readBody(response, { maxBytes: 100 }),
      (error) => error instanceof BodyTooLargeError && error.size === 5000 && error.limit === 100
    );
  });

  test('still enforces the cap when Content-Length lies', async () => {
    const response = streaming([utf8('x'.repeat(500))], { 'content-length': '10' });
    await assert.rejects(
      () => readBody(response, { maxBytes: 100 }),
      (error) => error instanceof BodyTooLargeError && error.size > 100
    );
  });

  test('enforces the cap when Content-Length is absent', async () => {
    const response = streaming([utf8('x'.repeat(200))]);
    await assert.rejects(() => readBody(response, { maxBytes: 100 }), BodyTooLargeError);
  });

  test('accepts a body exactly at the cap', async () => {
    const response = streaming([utf8('x'.repeat(100))]);
    assert.equal((await readBody(response, { maxBytes: 100 })).length, 100);
  });

  test('defaults to 25 MB', () => {
    assert.equal(DEFAULT_MAX_BODY_BYTES, 25 * 1024 * 1024);
  });
});
