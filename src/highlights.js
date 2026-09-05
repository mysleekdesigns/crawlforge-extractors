/**
 * highlights.js — the units of a scraped page that answer a query, verbatim.
 *
 * A caller asking "what does the enterprise plan cost" does not want the
 * whole markdown of a pricing page in its context window, and it does not
 * want a model's paraphrase of it either — the first is expensive, the
 * second can be wrong. This module is the extractive middle: cut the
 * markdown a scrape already returned into units (sentences, table rows,
 * fenced code blocks), score each against the query with BM25, and hand
 * back the top few exactly as they appear on the page, with character
 * offsets into that same string so the caller can quote with a locator.
 * Both surfaces run it, so a highlight is the same highlight over MCP and
 * REST.
 *
 * Everything here is a pure function over the markdown string. Offsets are
 * JS string indexes, and the invariant every unit keeps is
 * `markdown.slice(offset, offset + length) === text`. Trimming moves the
 * offsets; nothing rewrites the text.
 *
 * The sentence splitter ports the MCP server's sentenceUtils.js rules: the
 * CJK / fullwidth / Devanagari terminators split on a zero-width boundary
 * and are never judged by the ASCII checks; an ASCII `.` followed by
 * whitespace does not split after an abbreviation (Dr., etc.), a word with
 * internal periods (Node.js, e.g.), a decimal (3.14) or a single-letter
 * initial. The one departure from the server: those four checks only guard
 * `.`, because "What is Node.js? It is a runtime." is two sentences.
 */

const CJK_TERMINATORS = '。．！？；।॥';
const ASCII_TERMINATORS = '.!?';
// Closing punctuation a terminator may carry with it: "…end."), 'so.', and
// the emphasis markers of a bold FAQ question — "**Can I cancel?** Yes."
const CLOSERS = '"\')\\]”’»*_';

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'ave', 'blvd',
  'vs', 'etc', 'inc', 'ltd', 'corp', 'dept', 'univ', 'assn',
  'approx', 'appt', 'apt', 'est', 'min', 'max',
  'govt', 'lib', 'misc', 'natl', 'intl',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
  'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
  'fig', 'eq', 'ref', 'vol', 'no', 'pp', 'ed', 'rev',
  'e', 'i' // e.g. and i.e.
]);

const MIN_UNIT_CHARS = 2;

const FENCE = /^(`{3,}|~{3,})/;
const FENCE_CLOSER = /^(?:`+|~+)$/;
const HEADING = /^#{1,6}(?:\s+(.*?))?\s*#*\s*$/;
const TABLE_DELIMITER = /^\|?[\s:|-]*-[\s:|-]*\|?$/;
const HORIZONTAL_RULE = /^(?:-\s*){3,}$|^(?:\*\s*){3,}$|^(?:_\s*){3,}$/;
const HTML_COMMENT_LINE = /^<!--[\s\S]*-->$/;
const IMAGE_ONLY_LINE = /^!\[[^\]]*\]\([^)]*\)$/;
const BLOCKQUOTE_MARKER = /^>\s?/;
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])\s+/;

function isSpace(ch) {
  return /\s/.test(ch);
}

/** Move [start, end) inward past whitespace at both ends. */
function trimRange(markdown, start, end) {
  while (start < end && isSpace(markdown[start])) start++;
  while (end > start && isSpace(markdown[end - 1])) end--;
  return [start, end];
}

function hasEnoughText(text) {
  let count = 0;
  for (const ch of text) {
    if (!isSpace(ch) && ++count >= MIN_UNIT_CHARS) return true;
  }
  return false;
}

/**
 * Cut the markdown a scrape returned into the units a query can be scored
 * against. Headings are not units — they label the units that follow.
 *
 * @param {string} markdown
 * @returns {Array<{ text: string, kind: 'sentence' | 'table_row' | 'code_block', offset: number, length: number, heading: string | null }>}
 */
export function segmentUnits(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return [];

  const units = [];
  let heading = null;

  function push(kind, start, end) {
    [start, end] = trimRange(markdown, start, end);
    const text = markdown.slice(start, end);
    if (!hasEnoughText(text)) return;
    units.push({ text, kind, offset: start, length: end - start, heading });
  }

  // A paragraph is a contiguous range: consecutive prose lines, the first
  // one's list or quote marker already skipped. Line breaks inside it are
  // whitespace, so a sentence may carry a "\n" verbatim.
  let paragraphStart = -1;
  let paragraphEnd = -1;
  function flushParagraph() {
    if (paragraphStart >= 0) splitSentences(markdown, paragraphStart, paragraphEnd, push);
    paragraphStart = -1;
  }

  let fence = null; // { marker, contentStart }

  const length = markdown.length;
  let lineStart = 0;
  while (lineStart <= length) {
    let lineEnd = markdown.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = length;
    const [s, e] = trimRange(markdown, lineStart, lineEnd);
    const line = markdown.slice(s, e);
    let match;

    if (fence) {
      if (line[0] === fence.marker[0] && line.length >= fence.marker.length && FENCE_CLOSER.test(line)) {
        push('code_block', fence.contentStart, Math.max(fence.contentStart, lineStart));
        fence = null;
      }
    } else if (line === '') {
      flushParagraph();
    } else if ((match = FENCE.exec(line))) {
      flushParagraph();
      fence = { marker: match[1], contentStart: Math.min(lineEnd + 1, length) };
    } else if ((match = HEADING.exec(line))) {
      flushParagraph();
      heading = (match[1] || '').trim() || null;
    } else if (line[0] === '|') {
      flushParagraph();
      if (!TABLE_DELIMITER.test(line)) push('table_row', s, e);
    } else if (HORIZONTAL_RULE.test(line) || HTML_COMMENT_LINE.test(line) || IMAGE_ONLY_LINE.test(line)) {
      flushParagraph();
    } else {
      let start = s;
      let marked = false;
      while ((match = BLOCKQUOTE_MARKER.exec(markdown.slice(start, e)))) {
        start += match[0].length;
        marked = true;
      }
      if ((match = LIST_MARKER.exec(markdown.slice(start, e)))) {
        start += match[0].length;
        marked = true;
      }
      // A marker starts its own paragraph: two list items are two units,
      // and "- " never lands inside a sentence's text.
      if (marked) flushParagraph();
      if (paragraphStart < 0) paragraphStart = start;
      paragraphEnd = e;
    }

    lineStart = lineEnd + 1;
  }

  // A fence nobody closed: the rest of the document is that block.
  if (fence) push('code_block', fence.contentStart, length);
  flushParagraph();

  return units;
}

/**
 * Split the paragraph at [start, end) into sentences, calling `emit` with
 * each one's range. Whitespace between sentences belongs to neither.
 */
function splitSentences(markdown, start, end, emit) {
  let sentenceStart = start;
  let i = start;
  while (i < end) {
    const ch = markdown[i];
    if (CJK_TERMINATORS.includes(ch)) {
      // Unambiguous, and CJK text puts no whitespace after them.
      emit('sentence', sentenceStart, i + 1);
      sentenceStart = i + 1;
      i++;
      continue;
    }
    if (!ASCII_TERMINATORS.includes(ch)) {
      i++;
      continue;
    }
    // Consume the run: "?!", "...", then any closing quote or bracket.
    let j = i;
    while (j < end && ASCII_TERMINATORS.includes(markdown[j])) j++;
    while (j < end && CLOSERS.includes(markdown[j])) j++;
    if (j < end && !isSpace(markdown[j])) {
      // "Node.js", "3.14", "e.g." — a period glued to the next word.
      i = j;
      continue;
    }
    if (ch === '.' && isFalseStop(markdown, sentenceStart, i)) {
      i = j;
      continue;
    }
    emit('sentence', sentenceStart, j);
    sentenceStart = j;
    i = j;
  }
  if (sentenceStart < end) emit('sentence', sentenceStart, end);
}

/**
 * Whether the period at `dot` ends an abbreviation, a word with internal
 * periods, a decimal or a single-letter initial — the server's four checks,
 * applied to the whitespace-delimited word before the period.
 */
function isFalseStop(markdown, from, dot) {
  let wordStart = dot;
  while (wordStart > from && !isSpace(markdown[wordStart - 1])) wordStart--;
  const word = markdown.slice(wordStart, dot);
  if (word === '') return false;
  if (ABBREVIATIONS.has(word.toLowerCase().replace(/[^a-z]/g, ''))) return true;
  if (/\w\.\w/.test(word)) return true;
  if (/\d\.\d/.test(word)) return true;
  return /^[A-Z]$/.test(word);
}

// Letters and digits of the scripts that put no spaces between words (Han,
// Hiragana, Katakana, Hangul) form one kind of run; every other letter,
// digit or combining mark forms the other — marks, because a Devanagari
// vowel sign is a mark, and without them "कीमत" is two fragments.
// Script_Extensions keeps "ー" and "々" with their runs; the letter/number
// class keeps "、" and "。" out of them.
const CJK_CHAR = '[\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Hangul}]';
const TOKEN = new RegExp(`(?:(?=${CJK_CHAR})[\\p{L}\\p{N}])+|(?:(?!${CJK_CHAR})[\\p{L}\\p{N}\\p{M}])+`, 'gu');
const CJK_START = new RegExp(`^${CJK_CHAR}`, 'u');
const SUFFIXES = ['ing', 'ed', 'es', 's'];

/**
 * Lowercase word tokens. A CJK run becomes character bigrams so a query in
 * one of those scripts can match without a segmenter; a light suffix strip
 * puts "pricing", "prices" and "price" on one stem ("pric").
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  const tokens = [];
  for (const [run] of text.toLowerCase().matchAll(TOKEN)) {
    if (CJK_START.test(run)) {
      const chars = Array.from(run);
      if (chars.length === 1) tokens.push(run);
      for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1]);
    } else {
      tokens.push(stem(run));
    }
  }
  return tokens;
}

function stem(token) {
  if (token.length <= 4) return token;
  for (const suffix of SUFFIXES) {
    if (token.endsWith(suffix)) {
      token = token.slice(0, -suffix.length);
      break;
    }
  }
  return token.length > 4 && token.endsWith('e') ? token.slice(0, -1) : token;
}

const K1 = 1.2;
const B = 0.75;
const PHRASE_BOOST = 1.5;
// A unit inherits the terms of the heading it sits under, at half the weight
// of a term in its own text: on a card-style pricing page the plan name is
// the heading and "$83/month" is the unit, and without the heading the price
// line shares nothing with "professional plan price per month". Heading
// terms count toward a unit's term frequency only — not toward document
// frequency, or the plan name would look common and lose its weight.
const HEADING_WEIGHT = 0.5;
// BM25's length normalisation rewards short documents, and a page's shortest
// units are its buttons: "Choose Professional" outranked every price line on
// a live pricing page. A unit is scored as if it had at least this many
// tokens, so a two-word call to action carries no length advantage.
const MIN_DOC_LENGTH = 4;

/**
 * The units that answer a query, best first: BM25 over the units as the
 * corpus, with each unit inheriting its heading's terms at half weight, and a
 * phrase boost when a unit contains the whole query. The input units are not
 * touched; every returned unit is a new object.
 *
 * @template {{ text: string, heading?: string | null, offset: number }} U
 * @param {U[]} units
 * @param {string} query
 * @param {{ maxUnits?: number, minScore?: number }} [options]
 * @returns {Array<U & { score: number }>}
 */
export function rankUnits(units, query, { maxUnits = 10, minScore = 0 } = {}) {
  if (!Array.isArray(units) || units.length === 0 || typeof query !== 'string') return [];
  const phrase = query.trim().toLowerCase();
  if (phrase === '') return [];
  const terms = [...new Set(tokenize(phrase))];
  if (terms.length === 0) return [];

  const limit = Number.isFinite(maxUnits) ? Math.max(1, Math.floor(maxUnits)) : 10;
  const floor = Number.isFinite(minScore) ? minScore : 0;

  const docs = units.map((unit) => {
    const counts = new Map();
    const tokens = tokenize(String(unit.text ?? ''));
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    const own = new Set(counts.keys());
    let length = tokens.length;
    if (unit.heading) {
      for (const token of new Set(tokenize(String(unit.heading)))) {
        if (own.has(token)) continue;
        counts.set(token, HEADING_WEIGHT);
        length += HEADING_WEIGHT;
      }
    }
    return { counts, own, length: Math.max(length, MIN_DOC_LENGTH) };
  });
  const n = docs.length;
  const avgdl = docs.reduce((sum, doc) => sum + doc.length, 0) / n || 1;
  const idf = new Map(terms.map((term) => {
    const df = docs.reduce((count, doc) => count + (doc.own.has(term) ? 1 : 0), 0);
    return [term, Math.log(1 + (n - df + 0.5) / (df + 0.5))];
  }));

  const ranked = [];
  units.forEach((unit, index) => {
    const doc = docs[index];
    let score = 0;
    for (const term of terms) {
      const tf = doc.counts.get(term);
      if (!tf) continue;
      score += idf.get(term) * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * doc.length / avgdl));
    }
    if (score === 0) return;
    if (String(unit.text).toLowerCase().includes(phrase)) score *= PHRASE_BOOST;
    // Round before the threshold, so a score handed back as minScore means
    // what the caller saw.
    score = Math.round(score * 1000) / 1000;
    if (score > floor) ranked.push({ ...unit, score });
  });

  ranked.sort((a, b) => b.score - a.score || a.offset - b.offset);
  return ranked.slice(0, limit);
}
