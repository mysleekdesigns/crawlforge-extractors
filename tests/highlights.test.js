/**
 * The query-scoped highlighter both surfaces run on a scrape's markdown
 * (src/highlights.js).
 *
 * The fixtures are written the way turndown renders a page — ATX headings,
 * GFM tables, fenced code, "-" bullets — with answers known in advance.
 * Every fixture test asserts the offset invariant across all units, not
 * only the ones it inspects: a highlight is only quotable if
 * `markdown.slice(offset, offset + length) === text` holds for each one.
 *
 * Run: node --test tests/highlights.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { segmentUnits, rankUnits } from '../src/highlights.js';

function fixture(name) {
  return readFileSync(new URL(`./fixtures/highlights/${name}.md`, import.meta.url), 'utf8');
}

function assertSliceInvariant(markdown, units) {
  assert.ok(units.length > 0, 'no units');
  for (const unit of units) {
    assert.equal(markdown.slice(unit.offset, unit.offset + unit.length), unit.text);
    assert.equal(unit.length, unit.text.length);
    assert.ok(['sentence', 'table_row', 'code_block'].includes(unit.kind), unit.kind);
    assert.ok(unit.heading === null || typeof unit.heading === 'string');
  }
}

describe('pricing page', () => {
  const markdown = fixture('pricing');
  const units = segmentUnits(markdown);

  test('every unit is a verbatim slice of the markdown', () => {
    assertSliceInvariant(markdown, units);
  });

  test('the table header row is a unit and the delimiter row is not', () => {
    const rows = units.filter((unit) => unit.kind === 'table_row');
    assert.equal(rows[0].text, '| Plan | Starter | Growth | Enterprise |');
    assert.equal(rows[0].heading, 'Compare plans');
    assert.equal(rows.length, 6);
    assert.ok(!units.some((unit) => /^\|[\s:|-]*\|$/.test(unit.text)), 'delimiter row leaked');
  });

  test('"enterprise price per month" ranks the unit carrying the enterprise price first', () => {
    const ranked = rankUnits(units, 'enterprise price per month');
    const [top] = ranked;
    assert.match(top.text, /\$499/);
    assert.match(top.text, /enterprise/i);
    assert.equal(top.heading, 'Enterprise');
    // The price row of the plan table is the other carrier of that number.
    const row = ranked.slice(0, 3).find((unit) => unit.kind === 'table_row');
    assert.equal(row?.text, '| Price per month | $29 | $99 | $499 |');
    for (const unit of ranked) {
      assert.equal(markdown.slice(unit.offset, unit.offset + unit.length), unit.text);
      assert.ok(unit.score > 0);
    }
  });

  test('prose prices are sentences under their plan heading', () => {
    const starter = units.filter((unit) => unit.heading === 'Starter').map((unit) => unit.text);
    assert.deepEqual(starter, [
      '$29 per month.',
      'For side projects and prototypes: 10,000 credits, 5 concurrent requests, email support.',
      '10,000 credits every month',
      'Community support',
      'Cancel any time'
    ]);
  });

  test('a decimal inside a sentence and an FAQ in bold do not break the split', () => {
    const growth = units.filter((unit) => unit.heading === 'Growth');
    assert.equal(growth.length, 2);
    assert.match(growth[1].text, /99\.5% uptime SLA\.$/);
    const faq = units.filter((unit) => unit.heading === 'Frequently asked questions').map((unit) => unit.text);
    assert.equal(faq[0], '**What counts as a credit?**');
    assert.equal(faq[1], 'One credit is one page fetched by `scrape`.');
  });
});

describe('docs page', () => {
  const markdown = fixture('docs');
  const units = segmentUnits(markdown);

  test('every unit is a verbatim slice of the markdown', () => {
    assertSliceInvariant(markdown, units);
  });

  test('a query for an API name returns the code block that uses it, fences excluded', () => {
    const [top] = rankUnits(units, 'readBody maxBytes');
    assert.equal(top.kind, 'code_block');
    assert.equal(top.heading, 'Usage');
    assert.equal(
      top.text,
      "import { readBody, BodyTooLargeError } from 'crawlforge-extractors';\n\n" +
        'const html = await readBody(response, { maxBytes: 10 * 1024 * 1024 });'
    );
    assert.equal(markdown.slice(top.offset, top.offset + top.length), top.text);
  });

  test('all three fence styles become one code block each, with the fence lines outside the text', () => {
    const blocks = units.filter((unit) => unit.kind === 'code_block');
    assert.deepEqual(
      blocks.map((block) => [block.heading, block.text]),
      [
        ['Installation', 'npm install crawlforge-extractors'],
        ['Usage', "import { readBody, BodyTooLargeError } from 'crawlforge-extractors';\n\nconst html = await readBody(response, { maxBytes: 10 * 1024 * 1024 });"],
        ['Errors', 'BodyTooLargeError: body of 31457280 bytes exceeds the 10485760-byte cap']
      ]
    );
    assert.ok(!units.some((unit) => /^(```|~~~)/.test(unit.text)), 'a fence line leaked into a unit');
  });

  test('list markers and blockquote markers are stripped by moving the offset', () => {
    const texts = units.map((unit) => unit.text);
    assert.ok(texts.includes("A string decoded with the body's declared charset."));
    assert.ok(texts.includes('Issue the fetch under your own timeout.'));
    assert.ok(texts.includes('Catch the error and report the cap.'));
    assert.ok(texts.includes('Note: pass the `Response` you already issued, not a URL.'));
    assert.ok(!texts.some((text) => /^(?:[-*+]|\d+[.)]|>)\s/.test(text)), 'a marker leaked into a unit');
    const item = units.find((unit) => unit.text.startsWith('Issue the fetch'));
    assert.equal(markdown.slice(item.offset - 3, item.offset), '1. ');
  });

  test('Node.js, e.g., v2.0 and Dr. do not end a sentence', () => {
    const installation = units.filter((unit) => unit.heading === 'Installation' && unit.kind === 'sentence');
    assert.deepEqual(installation.map((unit) => unit.text), [
      'CrawlForge runs on Node.js 18 or later, e.g. the current LTS.',
      'Version v2.0 removed the legacy client.',
      'Dr. Smith wrote the original parser.'
    ]);
  });

  test('headings label the units that follow and are not units themselves', () => {
    assert.equal(units[0].text, 'Last updated 2026-09-01.');
    assert.equal(units[0].heading, null);
    assert.ok(!units.some((unit) => unit.text.startsWith('#')));
    assert.equal(units.find((unit) => unit.text.startsWith('`readBody` decodes')).heading, 'Reading a response body');
    assert.deepEqual(
      units.filter((unit) => unit.heading === 'Errors').map((unit) => unit.kind),
      ['code_block', 'sentence', 'sentence', 'sentence', 'sentence']
    );
    assert.equal(units.at(-1).text, 'Check the URL.');
  });

  test('a link-heavy sentence stays verbatim, links included', () => {
    const linky = units.find((unit) => unit.text.startsWith('See the ['));
    assert.match(linky.text, /\[charset notes\]\(https:\/\/example\.com\/docs\/charsets\)/);
    assert.match(linky.text, /for the details\.$/);
  });
});

describe('CJK and Devanagari', () => {
  const markdown = fixture('cjk');
  const units = segmentUnits(markdown);

  test('every unit is a verbatim slice of the markdown', () => {
    assertSliceInvariant(markdown, units);
  });

  test('each 。！？ or danda ends its own sentence, with no whitespace to split on', () => {
    assert.deepEqual(units.filter((unit) => unit.heading === '价格与方案').map((unit) => unit.text), [
      '专业版每月的价格是 99 美元。',
      '企业版按年计费，包含专属支持！',
      '您可以随时取消吗？',
      '当然可以。'
    ]);
    assert.deepEqual(units.filter((unit) => unit.heading === '料金プラン').map((unit) => unit.text), [
      'プロプランの料金は月額99ドルです。',
      'エンタープライズプランは年額請求となります！',
      'いつでもキャンセルできますか？'
    ]);
    assert.deepEqual(units.filter((unit) => unit.heading === 'मूल्य निर्धारण').map((unit) => unit.text), [
      'प्रो योजना की कीमत 99 डॉलर प्रति माह है।',
      'एंटरप्राइज़ योजना का बिल वार्षिक रूप से आता है।'
    ]);
  });

  test('offsets are JS string indexes, not byte offsets', () => {
    for (const unit of units) assert.equal(unit.offset, markdown.indexOf(unit.text));
    const japanese = units.find((unit) => unit.text.startsWith('プロプラン'));
    assert.notEqual(Buffer.byteLength(markdown.slice(0, japanese.offset)), japanese.offset);
  });

  test('a CJK query ranks the matching sentence first', () => {
    assert.equal(rankUnits(units, '价格')[0].text, '专业版每月的价格是 99 美元。');
    assert.equal(rankUnits(units, '料金')[0].text, 'プロプランの料金は月額99ドルです。');
    assert.equal(rankUnits(units, 'キャンセル')[0].text, 'いつでもキャンセルできますか？');
    assert.equal(rankUnits(units, 'कीमत')[0].text, 'प्रो योजना की कीमत 99 डॉलर प्रति माह है।');
  });
});

describe('segmentUnits edges', () => {
  test('nothing to segment', () => {
    assert.deepEqual(segmentUnits(''), []);
    assert.deepEqual(segmentUnits('   \n\n\t\n'), []);
    assert.deepEqual(segmentUnits(undefined), []);
    assert.deepEqual(segmentUnits(null), []);
  });

  test('Windows line endings keep the offsets and stay inside a joined paragraph', () => {
    const markdown = '# Title\r\n\r\nFirst line of a sentence\r\ncontinues here. Second one.\r\n\r\n| a | b |\r\n| - | - |\r\n| 1 | 2 |\r\n';
    const units = segmentUnits(markdown);
    assertSliceInvariant(markdown, units);
    assert.deepEqual(units.map((unit) => unit.text), [
      'First line of a sentence\r\ncontinues here.',
      'Second one.',
      '| a | b |',
      '| 1 | 2 |'
    ]);
    assert.ok(units.every((unit) => unit.heading === 'Title'));
  });

  test('a fence nobody closed swallows the rest of the document as one code block', () => {
    const markdown = 'Prose first.\n\n```py\nprint("a")\n\nprint("b")\n';
    const units = segmentUnits(markdown);
    assertSliceInvariant(markdown, units);
    assert.deepEqual(units.map((unit) => [unit.kind, unit.text]), [
      ['sentence', 'Prose first.'],
      ['code_block', 'print("a")\n\nprint("b")']
    ]);
  });

  test('an empty fenced block, a one-character line and a horizontal rule produce no unit', () => {
    const markdown = '```\n\n```\n\na\n\n---\n\n* * *\n\n![alt](https://example.com/a.png)\n\n<!-- hidden -->\n';
    assert.deepEqual(segmentUnits(markdown), []);
  });

  test('a closing fence must be at least as long as the opener and use its character', () => {
    const markdown = '````\n```\ninner\n```\n````\n\n~~~\n```\n~~~\n';
    const units = segmentUnits(markdown);
    assertSliceInvariant(markdown, units);
    assert.deepEqual(units.map((unit) => unit.text), ['```\ninner\n```', '```']);
  });

  test('a heading may carry closing hashes; a lone hash is a heading with no text', () => {
    const units = segmentUnits('## Plans ##\n\nRow one.\n\n#\n\nRow two.');
    assert.equal(units[0].heading, 'Plans');
    assert.equal(units[1].heading, null);
  });

  test('? and ! end a sentence even after a word with internal periods', () => {
    assert.deepEqual(segmentUnits('What is Node.js? It is a runtime! Read Dr. Smith, e.g. chapter 2.').map((unit) => unit.text), [
      'What is Node.js?',
      'It is a runtime!',
      'Read Dr. Smith, e.g. chapter 2.'
    ]);
  });

  test('a period inside quotes or brackets keeps them with the sentence', () => {
    const markdown = 'He said "stop." Then (nothing happened.) Done.';
    const units = segmentUnits(markdown);
    assertSliceInvariant(markdown, units);
    assert.deepEqual(units.map((unit) => unit.text), ['He said "stop."', 'Then (nothing happened.)', 'Done.']);
  });

  test('nested blockquote and list markers are all skipped', () => {
    const markdown = '> > - deep item here\n> plain quote line';
    const units = segmentUnits(markdown);
    assertSliceInvariant(markdown, units);
    assert.deepEqual(units.map((unit) => unit.text), ['deep item here', 'plain quote line']);
  });
});

describe('rankUnits', () => {
  const corpus = segmentUnits([
    '# Plans',
    '',
    'Starter costs $29 per month and is billed monthly.',
    'Growth is $99 every month, per workspace.',
    'Enterprise pricing is quoted per organisation.',
    '',
    '## Support',
    '',
    'Email support answers within a day.'
  ].join('\n'));

  test('no query, no units, no match: an empty result', () => {
    assert.deepEqual(rankUnits(corpus, ''), []);
    assert.deepEqual(rankUnits(corpus, '   '), []);
    assert.deepEqual(rankUnits(corpus, '...'), []);
    assert.deepEqual(rankUnits([], 'per month'), []);
    assert.deepEqual(rankUnits(corpus, 'kubernetes'), []);
    assert.deepEqual(rankUnits(undefined, 'per month'), []);
  });

  test('a unit containing the whole phrase beats one with the same terms scattered', () => {
    const [first, second] = rankUnits(corpus, 'per month');
    assert.match(first.text, /\$29 per month/);
    assert.match(second.text, /\$99 every month, per workspace/);
  });

  test('a light stem lets "pricing" find "priced" and "prices"', () => {
    const ranked = rankUnits(corpus, 'pricing');
    assert.equal(ranked.length, 1);
    assert.match(ranked[0].text, /^Enterprise pricing/);
    const units = segmentUnits('Priced at $10.\n\nPrices vary.\n\nThe price is fixed.\n\nA pricey option.');
    assert.equal(rankUnits(units, 'pricing').length, 3);
  });

  test('a heading that shares a query term boosts the units under it', () => {
    const markdown = '# Refunds\n\nWe answer within a day.\n\n# Support\n\nWe answer within a day.';
    const units = segmentUnits(markdown);
    const ranked = rankUnits(units, 'support answer');
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].heading, 'Support');
    assert.ok(ranked[0].offset > ranked[1].offset, 'the later unit won on the heading alone');
    // The heading's term counts at half weight, so the unit under "Support"
    // scores strictly higher than its twin under "Refunds".
    assert.ok(ranked[0].score > ranked[1].score);
  });

  test('ties go to the earlier offset', () => {
    const units = segmentUnits('Same text here.\n\nOther words.\n\nSame text here.');
    const ranked = rankUnits(units, 'same text');
    assert.deepEqual(ranked.map((unit) => unit.offset), [0, 31]);
    assert.equal(ranked[0].score, ranked[1].score);
  });

  test('minScore drops the weak matches; maxUnits caps and is clamped', () => {
    const all = rankUnits(corpus, 'month support');
    assert.equal(all.length, 3);
    const strong = rankUnits(corpus, 'month support', { minScore: all[1].score });
    assert.deepEqual(strong.map((unit) => unit.text), [all[0].text]);
    assert.equal(rankUnits(corpus, 'month support', { maxUnits: 2 }).length, 2);
    assert.equal(rankUnits(corpus, 'month support', { maxUnits: 0 }).length, 1);
    assert.equal(rankUnits(corpus, 'month support', { maxUnits: -4 }).length, 1);
    assert.equal(rankUnits(corpus, 'month support', { maxUnits: 2.9 }).length, 2);
    assert.equal(rankUnits(corpus, 'month support', { maxUnits: 'lots' }).length, 3);
    assert.equal(rankUnits(corpus, 'month support', { minScore: 'x' }).length, 3);
  });

  test('a ranked unit carries every unit field plus a score rounded to 3 decimals', () => {
    for (const unit of rankUnits(corpus, 'month')) {
      assert.deepEqual(Object.keys(unit).sort(), ['heading', 'kind', 'length', 'offset', 'score', 'text']);
      assert.equal(unit.score, Math.round(unit.score * 1000) / 1000);
      assert.ok(unit.score > 0);
    }
  });

  test('the input units are not mutated and the results are new objects', () => {
    const before = JSON.stringify(corpus);
    const frozen = corpus.map((unit) => Object.freeze({ ...unit }));
    Object.freeze(frozen);
    const ranked = rankUnits(frozen, 'per month');
    assert.ok(ranked.length > 0);
    assert.ok(!ranked.some((unit) => frozen.includes(unit)));
    assert.ok(frozen.every((unit) => !('score' in unit)));
    assert.equal(JSON.stringify(corpus), before);
  });
});
