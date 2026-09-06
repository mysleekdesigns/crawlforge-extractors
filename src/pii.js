/**
 * pii.js — redact the personal data a scraped page carries, before that text
 * reaches a model, a log line or a customer's context window.
 *
 * A scrape returns whatever the page holds, and pages hold support-inbox
 * addresses, staff phone lists, a checkout form's card number and — in an
 * error page or a leaked config block — an API key. The MCP server already
 * scrubbed the last of those out of its own logs (`secretMask.js`
 * `redactSecretsFromString`); nothing scrubbed the page text it hands back.
 * That heuristic moves here so both surfaces run one implementation, and it
 * arrives with three more entity classes beside it.
 *
 * Everything in this module is pure regex over a string: no network, no
 * model, no cheerio, deterministic. That is the point. A model-backed pass
 * for PERSON and LOCATION exists on the calling side, is opt-in, and is
 * priced separately; this module never invokes it. If a caller asks for
 * PERSON or LOCATION here they are ignored in silence — `MODEL_ONLY_ENTITIES`
 * is exported so the caller can route them, and so the two surfaces read one
 * declaration of which entities a regex cannot decide.
 *
 * ## Precision over recall, deliberately
 *
 * This runs over arbitrary page text that a customer paid to scrape. A false
 * positive silently destroys real content — a redacted price is worse than an
 * un-redacted phone number, because the customer can see the second one and
 * cannot recover the first. Every detector here is therefore built to be
 * conservative and to fail by *not* matching:
 *
 * - a bare run of digits is never a phone number. A phone must carry a `+`
 *   country code or a real separator-bearing NANP shape;
 * - a card number must pass **Luhn**, and an IBAN must pass **mod-97**. Both
 *   checks exist to reject the coincidence, not to validate the account;
 * - a candidate that a check rejects is dropped, not retried shorter. Missing
 *   one number is the cheap failure.
 *
 * What it deliberately does NOT catch, so nobody reports these as bugs:
 *
 * - **PERSON, LOCATION** — model-only, by definition. No regex knows that
 *   "Paris Hilton" is not a hotel in France.
 * - **7-digit local phone numbers** (`555-1234`) — indistinguishable from a
 *   part number, a date range or a score at scale.
 * - **non-NANP domestic phone numbers written without a `+`** (`020 7123
 *   4567`, `0912-345-678`) — a leading 0 area code is the shape of far too
 *   many identifiers. Written in E.164 (`+44 20 7123 4567`) they are caught.
 * - **lowercase IBANs** — IBANs are printed uppercase; accepting lowercase
 *   would make every long word a candidate.
 * - **national ID numbers, passport numbers, dates of birth, addresses,
 *   licence plates** — all of them are locale-specific digit runs with no
 *   check digit worth trusting.
 * - **secrets with no label** — a bare `sk-live-...` in prose is not matched.
 *   The SECRET heuristic needs `Bearer `, or an `api_key` / `x-api-key` /
 *   `password` / `secret` / `token` label followed by `:` or `=`.
 * - **markdown escapes other than `\\_` and a line-leading `\\-`** — see the
 *   next section. Those two are the only escaped characters that land inside
 *   a token this module has to match through; the rest (`\\*`, `` \\` ``,
 *   `\\[`, `\\]`) are not legal in an address or a label in the first place,
 *   so admitting them would widen the false-positive surface for nothing.
 *
 * ## Markdown escaping
 *
 * `scrape` returns markdown by default, and turndown escapes the characters
 * markdown gives meaning to: `\\`, `*`, `` ` ``, `[`, `]` and `_` anywhere in
 * a text node, and `-`, `+ `, `=`, `#`, `>` and `~~~` only at the start of a
 * line. So `simon_lacey@example.com` reaches this module written
 * `simon\\_lacey@example.com`, and the naive pattern matches only from the
 * `_` onwards.
 *
 * That is worse than a miss. `simon\\<EMAIL>` reports `count: 1` — a
 * successful redaction — while the given name is still sitting in the text.
 * A redaction report that overstates what it redacted is the one failure this
 * feature cannot have; a clean miss at least says `count: 0`. So the EMAIL
 * local part and the `api_key` label tolerate the escape, and an escaped run
 * matches as ONE span: `simon\\_lacey@example.com` becomes `<EMAIL>` entire.
 *
 * The escape is tolerated, never removed. Nothing here unescapes and
 * re-escapes the text — the caller's string comes back with spans replaced
 * and every character outside a span byte-identical.
 *
 * The other detectors were checked against turndown's own escape table and
 * need no tolerance, which a round-trip test pins: PHONE and FINANCIAL use
 * space, `.` and `-` as separators, and `-` is escaped only as the first
 * character of a line, where a phone or card number begins with a digit, `+`
 * or `(`. IBANs are letters, digits and spaces. `Bearer`, `x-api-key`,
 * `password`, `secret` and `token` contain nothing escapable — only
 * `api_key` does. And secret *values* never needed it: `\\S+` already matches
 * a backslash, so `token=sk\\_live\\_abc` was always redacted whole. Code
 * blocks are not escaped at all — turndown indents them instead.
 *
 * ## Detector order
 *
 * All detectors run over the ORIGINAL string and contribute spans; the string
 * is rebuilt once at the end. Spans are accepted in this order, and a span
 * that overlaps an already-accepted one is dropped — so nothing is counted or
 * replaced twice, and a card number claimed by FINANCIAL can never afterwards
 * be re-read as a PHONE:
 *
 *   1. SECRET      — a labelled credential wins over whatever its value looks
 *                    like (`password: ops@example.com` is a SECRET, not an
 *                    EMAIL).
 *   2. EMAIL       — before the numeric detectors, so digits inside an address
 *                    are not mistaken for an account number.
 *   3. FINANCIAL   — cards and IBANs before PHONE, so `4242 4242 4242 4242`
 *                    can never be read as a phone number.
 *   4. PHONE       — the least specific shape, so it goes last.
 *
 * Within PHONE the E.164 patterns run before the NANP one, so `+1 555 123
 * 4567` is one match and not a NANP match with a stray `+1` in front.
 *
 * ## The SECRET invariant
 *
 * SECRET keeps its label and replaces only the value — `Bearer <SECRET>`,
 * `api_key=<SECRET>` — in every replace style, including `remove` (which
 * leaves `Bearer `). That is not cosmetic: the MCP server's `maskError`
 * depends on the label surviving so an error message still says *which*
 * credential the request carried. Every other entity replaces the whole match.
 */

/** The entity classes this module decides with a regex. */
export const REGEX_ENTITIES = Object.freeze(['EMAIL', 'PHONE', 'FINANCIAL', 'SECRET']);

/**
 * The entity classes a regex cannot decide. `redactPii` ignores these; a
 * caller that offers them routes them to its own model pass.
 */
export const MODEL_ONLY_ENTITIES = Object.freeze(['PERSON', 'LOCATION']);

/** The replace style used when the caller does not choose one. */
export const DEFAULT_REPLACE_STYLE = 'tag';

/** The `mask` style's replacement — the same constant secretMask.js uses. */
const MASK = '[REDACTED]';

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

// A standard local@domain with a real TLD. The TLD floor of two letters is
// what keeps "user@localhost" and "@handle" out.
//
// The local part also admits the pair \_ (and \-), which is how turndown
// writes an underscore, or a line-leading hyphen, in markdown — see the
// markdown-escaping section of the header. It is the PAIR, not a bare
// backslash in the character class: the escape can only appear where the
// character it escapes was already legal, so the local part still cannot run
// across a space or any other boundary. The domain needs no such tolerance —
// turndown escapes nothing that is legal in one.
const EMAIL =
  /(?:[A-Za-z0-9._%+-]|\\[_-])+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}\b/g;

// E.164 written as one run: +15551234567. The digit count is checked in code
// (ITU allows at most 15), not in the quantifier, so the rule is readable.
const PHONE_E164_RUN = /(?<![\w+])\+\d{8,15}(?!\w)/g;

// E.164 written in groups: +44 20 7123 4567, +1 (555) 123-4567, +1-555-123-4567.
// Every group after the country code must be introduced by a separator or be
// parenthesised, which is what stops "+1" swallowing the number beside it.
const PHONE_E164_GROUPED = /(?<![\w+])\+\d{1,3}(?:[ .-]?\(\d{1,4}\)|[ .-]\d{1,4}){1,5}(?!\w)/g;

// NANP with separators, parenthesised: (555) 123-4567, 1 (555) 123-4567.
const PHONE_NANP_PARENS = /(?<![\w.,-])(?:1[ .-]?)?\([2-9]\d{2}\)[ .]?\d{3}[ .-]\d{4}(?![\w-])/g;

// NANP with separators, plain: 555-123-4567, 555.123.4567, 555 123 4567,
// 1-555-123-4567. Three things carry the precision here. The [2-9] on the area
// code is a real NANP rule and rejects 012/123/100 and the other
// counting-sequence lookalikes (the exchange code cannot take the same rule:
// 555-123-4567, the number every document uses, has 123 there). The
// backreference makes the separator the same character throughout, which is
// how a real number is written and how "1,234.567 8901" is not. And the
// leading (?<![\w.,-]) keeps this out of ISBNs, dates, versions, grouped money
// and hyphenated identifiers while the trailing (?![\w-]) keeps it out of
// longer digit runs.
const PHONE_NANP_PLAIN = /(?<![\w.,-])(?:1[ .-])?[2-9]\d{2}([ .-])\d{3}\1\d{4}(?![\w-])/g;

// A payment card: 13-19 digits, either contiguous or in consistent groups of
// 2-6 separated by one repeated space or hyphen (\1 is the backreference that
// enforces "the same separator throughout"). Groups of at least two digits
// are what stops a table row of single digits reading as an account number.
// Luhn does the rest. The lookarounds keep it out of decimals.
const CARD = /(?<![\w-])(?<!\d\.)(?:\d{13,19}|\d{2,6}(?:([ -])\d{2,6})(?:\1\d{2,6})*)(?![\w-])(?!\.\d)/g;

// An IBAN: country code, two check digits, then the account part either
// contiguous or in the conventional groups of four. mod-97 gates it.
const IBAN = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4})+(?: [A-Z0-9]{1,3})?)(?![A-Za-z0-9])/g;

// The secret heuristics, ported verbatim from the MCP server's
// secretMask.js redactSecretsFromString, in its original order. Group 1 is
// the label and is preserved; the span replaced is everything after it.
const SECRET_PATTERNS = [
  /(Bearer\s+)\S+/gi,
  /(api(?:\\?[_-])?key\s*[:=]\s*)\S+/gi,
  /(x-api-key\s*[:=]\s*)\S+/gi,
  /(password\s*[:=]\s*)\S+/gi,
  /(secret\s*[:=]\s*)\S+/gi,
  /(token\s*[:=]\s*)\S+/gi
];

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Luhn. 13-19 digits, and never a run of one repeated digit — 0000000000000000
 * satisfies Luhn and is a placeholder, not a card.
 * @param {string} candidate
 * @returns {boolean}
 */
function luhnOk(candidate) {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1*$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * ISO 13616 mod-97: move the first four characters to the end, map A-Z to
 * 10-35, and the remainder of the resulting number modulo 97 must be 1.
 * Computed digit by digit so no value ever leaves the safe integer range.
 * @param {string} candidate
 * @returns {boolean}
 */
function ibanOk(candidate) {
  const compact = candidate.replace(/ /g, '');
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= 'A' ? ch.charCodeAt(0) - 55 : ch.charCodeAt(0) - 48;
    if (value < 0 || value > 35) return false;
    remainder = (remainder * (value > 9 ? 100 : 10) + value) % 97;
  }
  return remainder === 1;
}

/** E.164 allows 8-15 digits in total, country code included. */
function e164Ok(candidate) {
  const digits = candidate.replace(/\D/g, '').length;
  return digits >= 8 && digits <= 15;
}

// ---------------------------------------------------------------------------
// Detectors, in the order their spans are accepted
// ---------------------------------------------------------------------------

const DETECTORS = [
  { entity: 'SECRET', patterns: SECRET_PATTERNS.map(re => ({ re, keepsLabel: true })) },
  { entity: 'EMAIL', patterns: [{ re: EMAIL }] },
  { entity: 'FINANCIAL', patterns: [{ re: CARD, check: luhnOk }, { re: IBAN, check: ibanOk }] },
  {
    entity: 'PHONE',
    patterns: [
      { re: PHONE_E164_RUN, check: e164Ok },
      { re: PHONE_E164_GROUPED, check: e164Ok },
      { re: PHONE_NANP_PARENS },
      { re: PHONE_NANP_PLAIN }
    ]
  }
];

/**
 * Every span the enabled detectors claim, in detector order, with overlaps
 * resolved in favour of whichever detector ran first. Returned sorted by
 * start so the caller can rebuild the string in one pass.
 * @param {string} text
 * @param {Set<string>} entities
 * @returns {Array<{ start: number, end: number, entity: string }>}
 */
function collectSpans(text, entities) {
  const accepted = [];
  for (const detector of DETECTORS) {
    if (!entities.has(detector.entity)) continue;
    for (const { re, check, keepsLabel } of detector.patterns) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        if (match[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        const end = match.index + match[0].length;
        const start = keepsLabel ? match.index + match[1].length : match.index;
        if (start >= end) continue;
        if (check && !check(text.slice(start, end))) continue;
        if (accepted.some(span => start < span.end && span.start < end)) continue;
        accepted.push({ start, end, entity: detector.entity });
      }
    }
  }
  return accepted.sort((a, b) => a.start - b.start);
}

/**
 * @param {string} entity
 * @param {'tag'|'mask'|'remove'} style
 * @returns {string}
 */
function replacementFor(entity, style) {
  if (style === 'mask') return MASK;
  if (style === 'remove') return '';
  return `<${entity}>`;
}

/**
 * Redact the entities this module can decide with a regex.
 *
 * `entities` narrows the run to its intersection with REGEX_ENTITIES. A name
 * this module does not handle — PERSON and LOCATION included — is dropped in
 * silence, and a selection that leaves nothing behind redacts nothing: a
 * caller asking only for PERSON wants its own model pass, not everything.
 * Anything that is not a non-empty array means all of REGEX_ENTITIES, because
 * a missing selection should fail towards more redaction, not less.
 *
 * `replaceStyle` is 'tag' (`<EMAIL>`), 'mask' (`[REDACTED]`) or 'remove' (the
 * empty string); anything else is treated as 'tag'. SECRET keeps its label in
 * every style — see the module header.
 *
 * Never throws. A non-string `text` comes back untouched with a zero count.
 *
 * @param {string} text
 * @param {{ entities?: string[], replaceStyle?: 'tag'|'mask'|'remove' }} [options]
 * @returns {{ text: string, redaction: { entities: Record<string, number>, count: number } }}
 */
export function redactPii(text, { entities, replaceStyle } = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text, redaction: { entities: {}, count: 0 } };
  }

  const requested = Array.isArray(entities) && entities.length > 0
    ? entities.filter(name => typeof name === 'string').map(name => name.toUpperCase())
    : REGEX_ENTITIES;
  const wanted = new Set(requested.filter(name => REGEX_ENTITIES.includes(name)));
  if (wanted.size === 0) return { text, redaction: { entities: {}, count: 0 } };

  const spans = collectSpans(text, wanted);
  if (spans.length === 0) return { text, redaction: { entities: {}, count: 0 } };

  const style = replaceStyle === 'mask' || replaceStyle === 'remove' ? replaceStyle : DEFAULT_REPLACE_STYLE;
  const counts = {};
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + replacementFor(span.entity, style);
    counts[span.entity] = (counts[span.entity] || 0) + 1;
    cursor = span.end;
  }
  out += text.slice(cursor);

  return { text: out, redaction: { entities: counts, count: spans.length } };
}
