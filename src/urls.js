/**
 * URL scheme filtering for values that come from scraped page content or a
 * third-party payload — both untrusted.
 *
 * Such a URL flows into two places that will act on it: a React `href` (React
 * does not sanitise href attributes) and an LLM client that may follow links.
 * A `javascript:` or `data:` value there becomes a live XSS vector or an
 * actionable prompt-injection URL. safeHref keeps only what is safe to hand on.
 */

// ASCII control characters (codepoints 0-31 and 127). A browser ignores these
// inside a URL, so they can disguise a scheme, e.g. "java\tscript:alert(1)".
// Built from char codes so the source stays plain ASCII (no literal controls).
const CONTROL_CHARS = (() => {
  let chars = '';
  for (let c = 0; c <= 31; c++) chars += String.fromCharCode(c);
  chars += String.fromCharCode(127);
  return new RegExp('[' + chars + ']', 'g');
})();

/**
 * Return the URL unchanged when it is an http(s) absolute URL or a scheme-less
 * value (a relative path or a protocol-relative `//host` URL — neither carries a
 * scheme to abuse), and null for everything else, including `javascript:`,
 * `data:`, `vbscript:`, `file:`, `mailto:` and `tel:`.
 *
 * Control characters are stripped before the scheme is read, so a value like
 * `java\nscript:alert(1)` — which a browser would execute after ignoring the
 * newline — cannot masquerade as scheme-less and slip through.
 *
 * @param {unknown} url
 * @returns {string|null}
 */
export function safeHref(url) {
  if (typeof url !== 'string') return null;
  const cleaned = url.replace(CONTROL_CHARS, '').trim();
  if (!cleaned) return null;
  // A leading scheme is a letter followed by letters/digits/+/-/. and a colon.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(cleaned)) return cleaned; // relative / protocol-relative
  return /^https?:\/\//i.test(cleaned) ? cleaned : null; // absolute: http(s) only
}
