/**
 * Block-aware text flattening, shared by extract_text on both surfaces.
 *
 * Cheerio's .text() joins adjacent elements with no separator: `<h1>Hi</h1>
 * <p>there</p>` reads "Hithere", and table rows and list items weld together
 * ("1.Story title329 points"). The REST route returned exactly that while the
 * MCP server's copy kept one line per block; this is the MCP copy
 * (`flattenBodyText` in its `_fetchAndParse.js`), moved here so the two
 * surfaces return the same text.
 */

/** Elements whose end is a line break. */
const BLOCK_SELECTOR =
  'p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre, table, ul, ol, dl, dt, dd, section, article, ' +
  'header, footer, main, nav, aside, figure, figcaption, form, fieldset, caption';

// Block boundaries are marked with a U+E000 private-use sentinel so the HTML
// source's own insignificant newlines can be collapsed to spaces first, and
// only the sentinels become line breaks. (NUL won't survive: .after() and
// .replaceWith() parse their argument as HTML and the parser strips NUL;
// U+E000 passes through and never occurs in real page text.)
const SENTINEL = '\uE000';

/**
 * Flatten elements to text, one line per block element. Table cells on a row
 * are joined by a space. Works on a detached clone, so the caller's tree is
 * untouched. Callers remove `<script>`/`<style>` first: their text is read
 * like any other.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {import('cheerio').Cheerio<any>} [root] the elements to read; default `<body>`.
 *   Several matched elements are each read, a line break between them.
 * @returns {string}
 */
export function flattenText($, root = $('body')) {
  const $root = root.clone();
  $root.find('br').replaceWith(SENTINEL);
  $root.find('td, th').after(' ');
  $root.find(BLOCK_SELECTOR).after(SENTINEL);
  return $root
    .toArray()
    .map((el) => $(el).text())
    .join(SENTINEL)
    .replace(/\s+/g, ' ')
    .replace(/ ?(?:\uE000 ?)+/g, '\n')
    .trim();
}
