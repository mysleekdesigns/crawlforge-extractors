/**
 * Data tables as a plain grid, ready for a markdown converter, shared by
 * extract_text and scrape on both surfaces.
 *
 * A GFM pipe table is one header row over rows of the same width, each cell on
 * one line. HTML tables are not: Wikipedia's "Height" over "m" and "ft" is a
 * two-row header, a rowspan leaves later rows a cell short, and a <div> in a
 * cell breaks its row in two (R24 3.12). This is the MCP server's copy
 * (`gridTables` in its extractText.js), moved here so the REST routes make the
 * same tables.
 */

/** The cell's span, a whole number from 1 to max. */
function span(cell, attr, max) {
  const n = parseInt(cell.attribs?.[attr], 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : 1;
}

// Block elements inside a cell; each line break they make splits a markdown table row.
const CELL_BLOCKS = 'p, div, ul, ol, li, dl, dt, dd, h1, h2, h3, h4, h5, h6, blockquote, pre, figure, figcaption, center';

/** A cell's content on one line: <br> and block elements become spaces and spans. */
function inlineCellHtml($, cell) {
  const $cell = $(cell).clone();
  $cell.find('br').replaceWith(' ');
  $cell.find(CELL_BLOCKS).each((_, el) => {
    el.name = 'span';
    $(el).after(' ');
  });
  return $cell.html().trim();
}

/**
 * Rewrite each data table (one with a header row) as a plain grid: one header
 * row in a <thead>, every row as wide as the widest, each cell on one line.
 * Stacked header cells over a column are joined by a space ("Height m"); a
 * rowspan cell repeats on each row it covers, a colspan cell fills its first
 * column and leaves the rest empty. Tables with no header row (layout tables)
 * and nested tables are left as they are. Edits the document in place.
 *
 * @param {import('cheerio').CheerioAPI} $
 */
export function gridTables($) {
  $('table').each((_, table) => {
    const $table = $(table);
    if ($table.find('table').length > 0 || $table.parents('table').length > 0) return;
    const rows = $table.find('tr').toArray();
    if (rows.length === 0) return;

    // grid[r][c] = { cell, copy: 'row' | 'col' | undefined }
    const grid = rows.map(() => []);
    rows.forEach((row, r) => {
      let c = 0;
      for (const cell of $(row).children('th, td').toArray()) {
        while (grid[r][c]) c++;
        const colspan = span(cell, 'colspan', 1000);
        const rowspan = span(cell, 'rowspan', rows.length - r);
        for (let i = 0; i < rowspan; i++) {
          for (let j = 0; j < colspan; j++) {
            grid[r + i][c + j] = { cell, copy: j > 0 ? 'col' : i > 0 ? 'row' : undefined };
          }
        }
        c += colspan;
      }
    });

    const width = Math.max(...grid.map((row) => row.length));
    const isHeaderRow = (row) => row.length > 0 && row.some((slot) => slot?.cell.name === 'th') &&
      row.every((slot) => !slot || slot.cell.name === 'th' || $(slot.cell).text().trim() === '');
    let headerRows = 0;
    while (headerRows < grid.length - 1 && isHeaderRow(grid[headerRows])) headerRows++;
    if (headerRows === 0) return;

    const header = [];
    for (let c = 0; c < width; c++) {
      const cells = [...new Set(grid.slice(0, headerRows).map((row) => row[c]?.cell).filter(Boolean))];
      header.push(`<th>${cells.map((cell) => inlineCellHtml($, cell)).filter(Boolean).join(' ')}</th>`);
    }
    const body = grid.slice(headerRows).map((row) => {
      const cells = [];
      for (let c = 0; c < width; c++) {
        const slot = row[c];
        cells.push(`<td>${slot && slot.copy !== 'col' ? inlineCellHtml($, slot.cell) : ''}</td>`);
      }
      return `<tr>${cells.join('')}</tr>`;
    });
    const caption = $table.children('caption').first();
    $table.replaceWith(
      `<table>${caption.length ? $.html(caption) : ''}<thead><tr>${header.join('')}</tr></thead>` +
      `<tbody>${body.join('')}</tbody></table>`
    );
  });
}
