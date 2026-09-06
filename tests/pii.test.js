/**
 * The regex PII redaction both surfaces run on extracted text (src/pii.js).
 *
 * Two things are being defended here. The first is that every entity class is
 * actually caught in all three replace styles. The second matters more: the
 * false-positive fixture is a realistic page of prices, dates, versions, IDs,
 * ISBNs and URL digit runs, and it must redact to exactly zero — a redaction
 * that eats a price silently destroys content the customer paid to scrape and
 * cannot get back.
 *
 * The SECRET tests assert byte-for-byte parity with the chain this ported
 * from, the MCP server's secretMask.js redactSecretsFromString, because
 * maskError depends on the label surviving the value.
 *
 * Run: node --test tests/pii.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  redactPii,
  REGEX_ENTITIES,
  MODEL_ONLY_ENTITIES,
  DEFAULT_REPLACE_STYLE
} from '../src/pii.js';

const MASK = '[REDACTED]';

// The chain in crawlforge-mcp-server/src/utils/secretMask.js as it stood when
// this module took it over. Copied verbatim; the parity test below is what
// says the move changed nothing.
function redactSecretsFromString(str) {
  return str
    .replace(/(Bearer\s+)\S+/gi, `$1${MASK}`)
    .replace(/(api[_-]?key\s*[:=]\s*)\S+/gi, `$1${MASK}`)
    .replace(/(x-api-key\s*[:=]\s*)\S+/gi, `$1${MASK}`)
    .replace(/(password\s*[:=]\s*)\S+/gi, `$1${MASK}`)
    .replace(/(secret\s*[:=]\s*)\S+/gi, `$1${MASK}`)
    .replace(/(token\s*[:=]\s*)\S+/gi, `$1${MASK}`);
}

describe('the exported declarations', () => {
  test('REGEX_ENTITIES is the frozen list of what a regex decides', () => {
    assert.deepEqual(REGEX_ENTITIES, ['EMAIL', 'PHONE', 'FINANCIAL', 'SECRET']);
    assert.ok(Object.isFrozen(REGEX_ENTITIES));
  });

  test('MODEL_ONLY_ENTITIES is the frozen list of what needs a model', () => {
    assert.deepEqual(MODEL_ONLY_ENTITIES, ['PERSON', 'LOCATION']);
    assert.ok(Object.isFrozen(MODEL_ONLY_ENTITIES));
  });

  test('the default replace style is tag', () => {
    assert.equal(DEFAULT_REPLACE_STYLE, 'tag');
  });

  test('the two lists do not overlap — one declaration of who handles what', () => {
    for (const entity of MODEL_ONLY_ENTITIES) assert.ok(!REGEX_ENTITIES.includes(entity));
  });
});

describe('every entity class, in every replace style', () => {
  const SAMPLES = [
    ['EMAIL', 'write to ops@example.com today', 'write to §today'],
    ['PHONE', 'call (555) 123-4567 today', 'call §today'],
    ['FINANCIAL', 'card 4242 4242 4242 4242 today', 'card §today'],
    ['SECRET', 'Bearer sk-live-9f2c41e8 today', 'Bearer §today']
  ];

  for (const [entity, input, shape] of SAMPLES) {
    test(`${entity} — tag`, () => {
      const { text, redaction } = redactPii(input);
      assert.equal(text, shape.replace('§', `<${entity}> `));
      assert.deepEqual(redaction, { entities: { [entity]: 1 }, count: 1 });
    });

    test(`${entity} — mask`, () => {
      const { text, redaction } = redactPii(input, { replaceStyle: 'mask' });
      assert.equal(text, shape.replace('§', `${MASK} `));
      assert.equal(redaction.count, 1);
    });

    test(`${entity} — remove`, () => {
      const { text, redaction } = redactPii(input, { replaceStyle: 'remove' });
      assert.equal(text, shape.replace('§', ' '));
      assert.equal(redaction.count, 1);
    });
  }

  test('an unrecognised style is treated as the default, never thrown', () => {
    assert.equal(redactPii('ops@example.com', { replaceStyle: 'obliterate' }).text, '<EMAIL>');
  });
});

describe('the count map', () => {
  const MIXED = [
    'Support: ops@example.com or sales@example.co.uk',
    'Phone: +44 20 7123 4567',
    'Card on file: 4242-4242-4242-4242',
    'Header: Bearer sk-live-9f2c41e8'
  ].join('\n');

  test('counts every replacement, per type', () => {
    const { redaction } = redactPii(MIXED);
    assert.deepEqual(redaction.entities, { EMAIL: 2, PHONE: 1, FINANCIAL: 1, SECRET: 1 });
    assert.equal(redaction.count, 5);
  });

  test('count is the sum of the per-type entries', () => {
    const { redaction } = redactPii(MIXED);
    const sum = Object.values(redaction.entities).reduce((a, b) => a + b, 0);
    assert.equal(sum, redaction.count);
  });

  test('a type with no hits is omitted, not reported as zero', () => {
    const { redaction } = redactPii('write to ops@example.com');
    assert.deepEqual(redaction.entities, { EMAIL: 1 });
    assert.ok(!('PHONE' in redaction.entities));
  });

  test('clean text reports an empty map and leaves the string identical', () => {
    const clean = 'CrawlForge 5.9.0 costs $19.00 a month as of 2026-09-05.';
    const { text, redaction } = redactPii(clean);
    assert.equal(text, clean);
    assert.deepEqual(redaction, { entities: {}, count: 0 });
  });
});

describe('narrowing with entities', () => {
  const TEXT = 'ops@example.com or (555) 123-4567';

  test('EMAIL only — the phone in the same text survives', () => {
    const { text, redaction } = redactPii(TEXT, { entities: ['EMAIL'] });
    assert.equal(text, '<EMAIL> or (555) 123-4567');
    assert.deepEqual(redaction, { entities: { EMAIL: 1 }, count: 1 });
  });

  test('PHONE only — the address survives', () => {
    const { text } = redactPii(TEXT, { entities: ['PHONE'] });
    assert.equal(text, 'ops@example.com or <PHONE>');
  });

  test('names are matched case-insensitively, so a lowercase list still redacts', () => {
    assert.equal(redactPii(TEXT, { entities: ['email'] }).redaction.count, 1);
  });

  test('a missing or empty selection means all of REGEX_ENTITIES', () => {
    for (const entities of [undefined, [], 'EMAIL', null]) {
      assert.equal(redactPii(TEXT, { entities }).redaction.count, 2, String(entities));
    }
  });

  test('PERSON and LOCATION are ignored in silence — the caller routes them to a model', () => {
    for (const entity of MODEL_ONLY_ENTITIES) {
      const { text, redaction } = redactPii(TEXT, { entities: [entity] });
      assert.equal(text, TEXT);
      assert.deepEqual(redaction, { entities: {}, count: 0 });
    }
  });

  test('a model-only name beside a regex one narrows to the regex one', () => {
    const { redaction } = redactPii(TEXT, { entities: ['PERSON', 'EMAIL'] });
    assert.deepEqual(redaction, { entities: { EMAIL: 1 }, count: 1 });
  });

  test('a name nobody handles redacts nothing rather than everything', () => {
    assert.deepEqual(redactPii(TEXT, { entities: ['NONSENSE'] }).redaction, { entities: {}, count: 0 });
  });
});

describe('EMAIL', () => {
  for (const address of [
    'ops@example.com',
    'first.last+tag@sub.example.co.uk',
    'a_b-c%d@example-host.io',
    'billing@example.museum'
  ]) {
    test(`redacts ${address}`, () => {
      assert.equal(redactPii(`x ${address} y`).text, 'x <EMAIL> y');
    });
  }

  test('a trailing full stop stays outside the redaction', () => {
    assert.equal(redactPii('Mail ops@example.com.').text, 'Mail <EMAIL>.');
  });

  for (const notAnAddress of ['@handle', 'user@localhost', 'a@b', 'name at example dot com']) {
    test(`leaves ${JSON.stringify(notAnAddress)} alone`, () => {
      assert.equal(redactPii(`x ${notAnAddress} y`).redaction.count, 0);
    });
  }
});

describe('PHONE — a run of digits is not a phone number', () => {
  for (const number of [
    '+15551234567',
    '+1 555 123 4567',
    '+1 (555) 123-4567',
    '+1-555-123-4567',
    '+44 20 7123 4567',
    '+86 138 0013 8000',
    '(555) 123-4567',
    '555-123-4567',
    '555.123.4567',
    '555 123 4567',
    '1-555-123-4567'
  ]) {
    test(`redacts ${number}`, () => {
      const { text, redaction } = redactPii(`Call ${number} now`);
      assert.equal(text, 'Call <PHONE> now', number);
      assert.deepEqual(redaction, { entities: { PHONE: 1 }, count: 1 });
    });
  }

  for (const [label, sample] of [
    ['a price', 'Total: $1,234.56 including tax'],
    ['grouped money', 'Revenue was 1 234 567,89 EUR last year'],
    ['an ISO date', 'Published 2026-09-05 and revised 2026-09-06'],
    ['a US date', 'Signed 12/31/2024 in the morning'],
    ['a version', 'Upgrade from 5.6.11 to 5.9.0 today'],
    ['an ISBN', 'ISBN 978-0-13-235088-4 is out of print'],
    ['a digit run in a URL', 'https://example.com/orders/98765432109876/receipt'],
    ['an opaque id', 'reservation res_0194f2a8c31d47b0 expired'],
    ['an epoch timestamp', 'delivered at 1757116800000 ms'],
    ['an IP address', 'origin 192.168.1.10 refused the connection'],
    ['a NANP-invalid area code', 'ticket 100-200-3000 and ticket 012-345-6789'],
    ['a seven-digit local number', 'extension 555-1234 on the old switchboard'],
    ['mixed separators', 'part 555-123 4567 in the catalogue']
  ]) {
    test(`leaves ${label} alone`, () => {
      assert.deepEqual(redactPii(sample).redaction, { entities: {}, count: 0 }, sample);
    });
  }
});

describe('FINANCIAL — Luhn and mod-97 are what keep this honest', () => {
  for (const [scheme, card] of [
    ['Visa', '4242 4242 4242 4242'],
    ['Visa, contiguous', '4242424242424242'],
    ['Visa, hyphenated', '4242-4242-4242-4242'],
    ['Mastercard', '5555 5555 5555 4444'],
    ['Amex, 15 digits in 4-6-5', '3782 822463 10005'],
    ['13 digits', '4222222222222']
  ]) {
    test(`redacts a ${scheme} number`, () => {
      const { text, redaction } = redactPii(`Card ${card} on file`);
      assert.equal(text, 'Card <FINANCIAL> on file', card);
      assert.equal(redaction.count, 1);
    });
  }

  test('a same-length number that fails Luhn is not a card', () => {
    assert.equal(redactPii('Card 4242 4242 4242 4241 on file').redaction.count, 0);
    assert.equal(redactPii('Card 4242424242424241 on file').redaction.count, 0);
  });

  test('a repeated-digit placeholder passes Luhn but is still not a card', () => {
    assert.equal(redactPii('Card 0000 0000 0000 0000 on file').redaction.count, 0);
  });

  for (const iban of [
    'GB29 NWBK 6016 1331 9268 19',
    'GB29NWBK60161331926819',
    'DE89 3704 0044 0532 0130 00',
    'FR1420041010050500013M02606'
  ]) {
    test(`redacts the IBAN ${iban}`, () => {
      const { text, redaction } = redactPii(`IBAN ${iban} please`);
      assert.equal(text, 'IBAN <FINANCIAL> please', iban);
      assert.equal(redaction.count, 1);
    });
  }

  test('an IBAN one digit off fails mod-97 and is left alone', () => {
    assert.equal(redactPii('IBAN GB29 NWBK 6016 1331 9268 18 please').redaction.count, 0);
    assert.equal(redactPii('IBAN GB29NWBK60161331926818 please').redaction.count, 0);
  });

  test('an uppercase run that is not an IBAN is left alone', () => {
    assert.equal(redactPii('See FY2026 REVENUE REPORT Q1 TOTALS').redaction.count, 0);
  });
});

describe('SECRET — the label survives, the value does not', () => {
  test('the label is preserved in every style', () => {
    assert.equal(redactPii('Bearer sk-live-abc', { replaceStyle: 'tag' }).text, 'Bearer <SECRET>');
    assert.equal(redactPii('Bearer sk-live-abc', { replaceStyle: 'mask' }).text, `Bearer ${MASK}`);
    assert.equal(redactPii('Bearer sk-live-abc', { replaceStyle: 'remove' }).text, 'Bearer ');
  });

  for (const [label, sample, expected] of [
    ['Bearer', 'Authorization: Bearer sk-live-9f2c', 'Authorization: Bearer <SECRET>'],
    ['api_key=', 'GET /scrape?api_key=cf_live_abc', 'GET /scrape?api_key=<SECRET>'],
    ['api-key:', 'api-key: cf_live_abc', 'api-key: <SECRET>'],
    ['x-api-key:', 'x-api-key: cf_live_abc', 'x-api-key: <SECRET>'],
    ['password=', 'password=hunter2 rejected', 'password=<SECRET> rejected'],
    ['secret:', 'client_secret: shhh here', 'client_secret: <SECRET> here'],
    ['token=', 'token=eyJhbGciOi.J9 expired', 'token=<SECRET> expired']
  ]) {
    test(`${label} keeps its label and replaces only the value`, () => {
      assert.equal(redactPii(sample).text, expected);
    });
  }

  test('an unlabelled key-shaped string is deliberately not matched', () => {
    assert.equal(redactPii('the string sk-live-9f2c41e8abc appears in the log').redaction.count, 0);
  });

  test('the word secret in prose is not a secret', () => {
    assert.equal(redactPii('nothing secret about 5.9.0 here').redaction.count, 0);
  });

  describe('byte-for-byte parity with the secretMask.js chain it moved from', () => {
    for (const sample of [
      'Authorization: Bearer sk-live-9f2c41e8abc failed with 401',
      'GET /v1/tools/scrape?api_key=cf_live_abc123 returned 403',
      'headers: { x-api-key: cf_live_zzz, accept: application/json }',
      'connect failed: password=hunter2 for user ops',
      'client_secret: shhh-do-not-log and token=eyJhbGciOi.J9.abc',
      'api_key=token=abc',
      'password:secret=abc',
      'nothing secret about 5.9.0 here',
      'Error: request to https://api.example.com failed, Bearer   spaced-token'
    ]) {
      test(JSON.stringify(sample.slice(0, 48)), () => {
        const mine = redactPii(sample, { entities: ['SECRET'], replaceStyle: 'mask' }).text;
        assert.equal(mine, redactSecretsFromString(sample));
      });
    }
  });
});

describe('detector order — nothing is replaced or counted twice', () => {
  test('a card number is FINANCIAL, never PHONE', () => {
    const { text, redaction } = redactPii('Card 4242 4242 4242 4242 on file');
    assert.equal(text, 'Card <FINANCIAL> on file');
    assert.deepEqual(redaction.entities, { FINANCIAL: 1 });
    assert.ok(!('PHONE' in redaction.entities));
  });

  test('digits inside an address stay part of the EMAIL', () => {
    const { text, redaction } = redactPii('mail 4242424242424242@example.com now');
    assert.equal(text, 'mail <EMAIL> now');
    assert.deepEqual(redaction.entities, { EMAIL: 1 });
  });

  test('a labelled credential wins over what its value looks like', () => {
    const { text, redaction } = redactPii('password: ops@example.com');
    assert.equal(text, 'password: <SECRET>');
    assert.deepEqual(redaction.entities, { SECRET: 1 });
  });

  test('an E.164 number is one PHONE, not a NANP match with a stray prefix', () => {
    const { text, redaction } = redactPii('Call +1 (555) 123-4567 now');
    assert.equal(text, 'Call <PHONE> now');
    assert.equal(redaction.count, 1);
  });

  test('the same address twice is two replacements', () => {
    const { text, redaction } = redactPii('ops@example.com and ops@example.com');
    assert.equal(text, '<EMAIL> and <EMAIL>');
    assert.deepEqual(redaction, { entities: { EMAIL: 2 }, count: 2 });
  });
});

describe('the false-positive fixture — a real page of numbers redacts to zero', () => {
  const page = readFileSync(new URL('./fixtures/pii/no-pii.md', import.meta.url), 'utf8');

  test('nothing is redacted', () => {
    const { text, redaction } = redactPii(page);
    assert.deepEqual(redaction, { entities: {}, count: 0 });
    assert.equal(text, page);
  });

  test('nothing is redacted in any style, for any single entity', () => {
    for (const replaceStyle of ['tag', 'mask', 'remove']) {
      for (const entities of [undefined, ...REGEX_ENTITIES.map(e => [e])]) {
        assert.equal(redactPii(page, { entities, replaceStyle }).text, page);
      }
    }
  });

  test('one real address dropped into that page is the only thing caught', () => {
    const { text, redaction } = redactPii(`${page}\nQuestions: ops@example.com`);
    assert.deepEqual(redaction, { entities: { EMAIL: 1 }, count: 1 });
    assert.ok(text.endsWith('Questions: <EMAIL>'));
  });
});

describe('bad input never throws', () => {
  for (const value of [null, undefined, 42, true, {}, [], Symbol('x')]) {
    test(`${String(value)} comes back unchanged with a zero count`, () => {
      const result = redactPii(value);
      assert.equal(result.text, value);
      assert.deepEqual(result.redaction, { entities: {}, count: 0 });
    });
  }

  test('an empty string is unchanged', () => {
    assert.deepEqual(redactPii(''), { text: '', redaction: { entities: {}, count: 0 } });
  });

  test('no options at all is the same as the defaults', () => {
    const input = 'ops@example.com';
    assert.deepEqual(
      redactPii(input),
      redactPii(input, { entities: REGEX_ENTITIES, replaceStyle: DEFAULT_REPLACE_STYLE })
    );
  });
});

describe('purity', () => {
  test('the same input gives the same result every time', () => {
    const input = 'ops@example.com, +44 20 7123 4567, 4242 4242 4242 4242, Bearer abc';
    const first = redactPii(input);
    for (let i = 0; i < 5; i++) assert.deepEqual(redactPii(input), first);
  });

  test('the input string is not mutated and the untouched text is byte-identical', () => {
    const input = 'before ops@example.com after';
    redactPii(input);
    assert.equal(input, 'before ops@example.com after');
    assert.equal(redactPii(input).text, 'before <EMAIL> after');
  });
});

describe('markdown escaping — scrape returns markdown, and turndown escapes it', () => {
  // turndown's own escape table (lib/turndown.cjs.js markdownEscapes): the
  // first group is escaped anywhere in a text node, the hyphen only as the
  // first character of a line. Applying it here rather than depending on
  // turndown keeps this package's "no dependencies but cheerio" invariant.
  const escapeLikeTurndown = md =>
    md.replace(/[\\*`[\]_]/g, c => `\\${c}`).replace(/^-/gm, '\\-');

  describe('the defects this fixes', () => {
    test('an escaped api_key label is still a SECRET — it used to be a clean miss', () => {
      const { text, redaction } = redactPii('Header sent api\\_key: sk-live-abcdef123456');
      assert.equal(text, 'Header sent api\\_key: <SECRET>');
      assert.deepEqual(redaction, { entities: { SECRET: 1 }, count: 1 });
    });

    test('an escaped address is ONE span — it used to be reported redacted while the name survived', () => {
      const { text, redaction } = redactPii('Contact simon\\_lacey@example.com');
      assert.equal(text, 'Contact <EMAIL>');
      assert.ok(!text.includes('simon'), 'the given name must not survive a count of 1');
      assert.deepEqual(redaction, { entities: { EMAIL: 1 }, count: 1 });
    });

    test('two escaped underscores are still one span', () => {
      const { text, redaction } = redactPii('a\\_b\\_c@example.com');
      assert.equal(text, '<EMAIL>');
      assert.deepEqual(redaction, { entities: { EMAIL: 1 }, count: 1 });
    });

    test('a line-leading hyphen is escaped too, and was the same mangle', () => {
      assert.equal(redactPii('\\-support@example.com').text, '<EMAIL>');
    });

    test('the count never describes a partial replacement', () => {
      for (const address of ['simon\\_lacey@example.com', 'a\\_b\\_c@example.com', '\\-support@example.com']) {
        const { text, redaction } = redactPii(address);
        assert.equal(text, '<EMAIL>', address);
        assert.equal(redaction.count, 1, address);
      }
    });
  });

  describe('what the fix must not have changed', () => {
    for (const [label, sample, expected] of [
      ['x-api-key', 'x-api-key: sk-live-abcdef123456', 'x-api-key: <SECRET>'],
      ['password', 'password=hunter2 rejected', 'password=<SECRET> rejected'],
      ['secret', 'client_secret: shhh here', 'client_secret: <SECRET> here'],
      ['escaped secret label', 'client\\_secret: shhh here', 'client\\_secret: <SECRET> here'],
      ['token', 'token=eyJhbGciOi.J9 expired', 'token=<SECRET> expired'],
      ['Bearer', 'Authorization: Bearer sk-live-9f2c', 'Authorization: Bearer <SECRET>'],
      ['an escaped secret value', 'token=sk\\_live\\_abc\\_def', 'token=<SECRET>'],
      ['a dotted local part', 'first.last@example.com', '<EMAIL>'],
      ['a plus local part', 'first+tag@example.com', '<EMAIL>'],
      ['a hyphen local part', 'first-last@example.com', '<EMAIL>'],
      ['an unescaped underscore', 'simon_lacey@example.com', '<EMAIL>']
    ]) {
      test(`${label} behaves exactly as before`, () => {
        assert.equal(redactPii(sample).text, expected);
      });
    }

    test('code blocks are not escaped by turndown and were never affected', () => {
      assert.equal(redactPii('    simon_lacey@example.com').text, '    <EMAIL>');
    });
  });

  describe('PHONE, FINANCIAL and IBAN need no tolerance — proven, not assumed', () => {
    for (const [label, sample] of [
      ['a NANP number', '555-123-4567'],
      ['a parenthesised number', '(555) 123-4567'],
      ['an E.164 number', '+44 20 7123 4567'],
      ['a hyphenated card', '4242-4242-4242-4242'],
      ['a spaced card', '4242 4242 4242 4242'],
      ['an IBAN', 'GB29 NWBK 6016 1331 9268 19']
    ]) {
      test(`${label} survives escaping unchanged`, () => {
        // Nothing in these shapes is escapable, so the escaped form IS the
        // plain form — that is the claim being pinned.
        assert.equal(escapeLikeTurndown(sample), sample);
        assert.equal(redactPii(sample).redaction.count, 1);
      });
    }
  });

  describe('tolerating the escape did not widen the false-positive surface', () => {
    test('the no-PII fixture still redacts to zero once escaped', () => {
      const page = readFileSync(new URL('./fixtures/pii/no-pii.md', import.meta.url), 'utf8');
      const escaped = escapeLikeTurndown(page);
      assert.ok(escaped.includes('res\\_0194f2a8c31d47b0'), 'the fixture must actually contain escapes');
      assert.notEqual(escaped, page);
      const { text, redaction } = redactPii(escaped);
      assert.deepEqual(redaction, { entities: {}, count: 0 });
      assert.equal(text, escaped);
    });

    test('a backslash is admitted only as a pair, so an address cannot run across a space', () => {
      const { text, redaction } = redactPii('see \\_ and ops@example.com');
      assert.equal(text, 'see \\_ and <EMAIL>');
      assert.deepEqual(redaction, { entities: { EMAIL: 1 }, count: 1 });
    });

    test('an escaped word that is not an address is left alone', () => {
      assert.equal(redactPii('the file a\\_b\\_c has no address in it').redaction.count, 0);
    });

    test('a lone backslash before anything else is not part of a local part', () => {
      assert.equal(redactPii('path C:\\temp then ops@example.com').text, 'path C:\\temp then <EMAIL>');
    });
  });

  test('the escape tolerance is a deliberate divergence from the chain this ported from', () => {
    // Strictly MORE redaction, never less: the old chain missed the escaped
    // label entirely. The agent rewiring maskError needs to know parity holds
    // on unescaped input and improves on escaped input.
    const escaped = 'sent api\\_key: sk-live-abcdef123456';
    assert.equal(redactSecretsFromString(escaped), escaped, 'the old chain missed this');
    assert.equal(
      redactPii(escaped, { entities: ['SECRET'], replaceStyle: 'mask' }).text,
      `sent api\\_key: ${MASK}`
    );
  });
});
