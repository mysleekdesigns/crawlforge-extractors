/**
 * flight.js — React Server Components ("flight") streams: split the stream into
 * rows, resolve the references between rows, and index the rows that carry data.
 *
 * Pure: strings and parsed JSON in, plain objects out. Every walk below is
 * iterative and every output is bounded, because the stream is page content —
 * an attacker can make it arbitrarily deep, long, or self-referential.
 */

/**
 * Split a concatenated RSC flight stream into its rows.
 *
 * The stream is a sequence of `<hexId>:<payload>\n` rows. Four payload shapes
 * matter:
 *   - `T<hexByteLength>,` — a length-prefixed text blob. The length is in
 *     UTF-8 BYTES and INCLUDES the row's terminating newline, so the cursor
 *     advances exactly that many bytes and no further. (Advancing one extra
 *     character for a newline silently eats the first hex digit of the next
 *     row id, turning row "14" into row "4" and overwriting an unrelated row —
 *     verified against the live Healthgrades capture, where it produced seven
 *     colliding ids.)
 *   - `I[...]` / `HL[...]` — module and hint references. Not JSON; kept as the
 *     raw string so the caller can still see which components a page loads.
 *   - `E{...}` — a server error row; parsed to `{ $error: <parsed> }`.
 *   - anything else — JSON, parsed.
 *
 * @param {string} stream
 * @returns {Record<string, unknown>} row id -> value
 */
export function parseFlightRows(stream) {
  const rows = {};
  let cursor = 0;

  while (cursor < stream.length) {
    const newline = stream.indexOf('\n', cursor);
    const lineEnd = newline === -1 ? stream.length : newline;
    const header = stream.slice(cursor, lineEnd).match(/^([0-9a-f]+):/i);
    if (!header) {
      // Not a row start: a chunk boundary landed mid-row, or the stream was
      // truncated. Resync on the next line rather than giving up.
      cursor = lineEnd + 1;
      continue;
    }

    const id = header[1];
    const payloadStart = cursor + header[0].length;
    const payload = stream.slice(payloadStart, lineEnd);

    const textRow = payload.match(/^T([0-9a-f]+),/i);
    if (textRow) {
      const blobStart = payloadStart + textRow[0].length;
      const byteLen = parseInt(textRow[1], 16);
      // Decode only up to byteLen bytes. Slicing the whole remaining stream on
      // every text row makes this O(N) per row -> O(N^2) for an
      // attacker-controlled stream of many small text rows. byteLen bytes span
      // at most byteLen characters, so bounding the slice to that many chars
      // keeps the work linear and yields the identical decoded blob.
      const text = Buffer.from(stream.slice(blobStart, blobStart + byteLen), 'utf8')
        .subarray(0, byteLen)
        .toString('utf8');
      rows[id] = text;
      cursor = blobStart + text.length;
      continue;
    }

    if (payload[0] === 'E') {
      try {
        rows[id] = { $error: JSON.parse(payload.slice(1)) };
      } catch {
        rows[id] = payload;
      }
      cursor = lineEnd + 1;
      continue;
    }

    try {
      rows[id] = JSON.parse(payload);
    } catch {
      rows[id] = payload;
    }
    cursor = lineEnd + 1;
  }

  return rows;
}

// A model reference: `$<hex>` (outlined model), `$@<hex>` (promise), either
// with an optional `:prop:prop…` property path into the referenced value.
// Row ids are lowercase hex (React writes them with toString(16)); the
// uppercase and non-hex tags — `$L` lazy, `$S` symbol, `$D` date, `$F` server
// reference, `$n` bigint, `$u`ndefined, … — never match.
const REF_RE = /^\$@?([0-9a-f]+)((?::[^:]*)*)$/;

// React writes an element as ["$", type, key, props] and addresses its parts
// by the element object's field names. A path walking the raw tuple maps them.
const ELEMENT_FIELDS = { type: 1, key: 2, props: 3 };

const isElement = (value) => Array.isArray(value) && value.length >= 4 && value[0] === '$';

const IN_PROGRESS = -1;

const scalarBytes = (value) => {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  return Buffer.byteLength(json ?? 'null');
};

/**
 * The UTF-8 size of a value's JSON serialization, computed without
 * serializing it. `memo` caches every container's size, so a value whose
 * subtrees are shared (as resolved rows are) costs one visit per distinct
 * container — never the size of its expansion. Iterative, so depth is free; a
 * cycle counts as 4 bytes instead of looping.
 *
 * @param {unknown} root
 * @param {WeakMap<object, number>} memo
 * @returns {number}
 */
function serializedSize(root, memo) {
  if (root === null || typeof root !== 'object') return scalarBytes(root);
  const stack = [root];
  while (stack.length > 0) {
    const node = stack[stack.length - 1];
    const state = memo.get(node);
    if (state === undefined) {
      memo.set(node, IN_PROGRESS);
      for (const key of Object.keys(node)) {
        const child = node[key];
        if (child !== null && typeof child === 'object' && memo.get(child) === undefined) stack.push(child);
      }
      continue;
    }
    stack.pop();
    if (state !== IN_PROGRESS) continue;

    const keys = Object.keys(node);
    const isArray = Array.isArray(node);
    let size = 2 + Math.max(0, keys.length - 1);
    for (const key of keys) {
      const child = node[key];
      if (!isArray) size += Buffer.byteLength(JSON.stringify(key)) + 1;
      if (child !== null && typeof child === 'object') {
        const childSize = memo.get(child);
        size += childSize === IN_PROGRESS ? 4 : childSize;
      } else {
        size += scalarBytes(child);
      }
    }
    memo.set(node, size);
  }
  return memo.get(root);
}

// Own-property write; `dst.__proto__ = v` would set the prototype instead.
const setOwn = (dst, key, value) => {
  if (key === '__proto__') {
    Object.defineProperty(dst, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    dst[key] = value;
  }
};

/**
 * Resolve the model references between flight rows.
 *
 * A string `$<hex>`, `$@<hex>` or `$<hex>:<prop>:…` is replaced by the
 * referenced row's resolved value (or the property it names); `$$…` inside a
 * row is the escaped literal `$…`. Every other `$` token — `$L` lazy
 * components, `$S`, `$undefined`, the element marker `"$"` — is left as is.
 * A reference to an unknown row, or a property path that does not resolve,
 * stays the original string.
 *
 * React deduplicates an object it has already written in the same row as a
 * path reference to its first occurrence (`$10:1:2:props:providerModel` inside
 * row 10). The row is copied in document order, so that first occurrence is
 * complete by the time the reference is read, and it resolves against the
 * copy. A reference to something still being built — a row reachable from
 * itself, or a container that encloses the reference — becomes
 * `{ $ref: "<id>" }`.
 *
 * Inlined values are shared, not copied, so memory stays linear — but their
 * serialization is not. `budgetBytes` caps the bytes inlining may add to the
 * serialized output (default: the serialized size of `rows`, so resolution at
 * most doubles the payload); a reference that would exceed it stays a string
 * and counts in `overBudget`. That is what keeps a `row n = [$n-1, $n-1]`
 * chain from expanding to 2^n.
 *
 * A top-level string row (an `I`/`HL`/`T` row, or a JSON string row) is only
 * resolved when the whole string is a reference — `e:"$9:metadata"` — and is
 * never unescaped, since text rows carry no escaping.
 *
 * @param {Record<string, unknown>} rows row id -> value, from parseFlightRows
 * @param {{ budgetBytes?: number }} [options]
 * @returns {{ rows: Record<string, unknown>, resolved: number, cycles: number, overBudget: number }}
 */
export function resolveFlightRows(rows, { budgetBytes } = {}) {
  const out = {};
  const stats = { resolved: 0, cycles: 0, overBudget: 0 };
  if (rows === null || typeof rows !== 'object') return { rows: out, ...stats };

  const ids = Object.keys(rows);
  const sizes = new WeakMap();
  let budget = typeof budgetBytes === 'number' && budgetBytes >= 0 ? budgetBytes : serializedSize(rows, sizes);

  const ON_STACK = 1;
  const DONE = 2;
  const state = new Map();

  const refTarget = (string) => {
    const match = REF_RE.exec(string);
    return match && Object.hasOwn(rows, match[1]) ? match : null;
  };

  // The other rows a row references, in document order, deduplicated.
  const dependencies = (id) => {
    const value = rows[id];
    const found = new Set();
    const note = (string) => {
      const match = string[0] === '$' ? refTarget(string) : null;
      if (match && match[1] !== id) found.add(match[1]);
    };
    if (typeof value === 'string') note(value);
    if (value === null || typeof value !== 'object') return [...found];
    const seen = new WeakSet([value]);
    const stack = [value];
    while (stack.length > 0) {
      const node = stack.pop();
      for (const key of Object.keys(node)) {
        const child = node[key];
        if (typeof child === 'string') {
          note(child);
        } else if (child !== null && typeof child === 'object' && !seen.has(child)) {
          seen.add(child);
          stack.push(child);
        }
      }
    }
    return [...found];
  };

  /**
   * @param {string} string
   * @param {{ id: string, root: object, open: Set<object> } | null} row the
   *   row being copied, when the string sits inside one
   */
  const resolveString = (string, row) => {
    if (string[0] !== '$') return string;
    if (row && string[1] === '$') return string.slice(1);
    const match = refTarget(string);
    if (!match) return string;
    const id = match[1];
    // A string row is markup, not model data: a `T` text blob (Healthgrades
    // inlines two of ~340 KB each through dangerouslySetInnerHTML), an `I`/`HL`
    // module reference or `$Sreact.fragment`. Inlining them spent the whole
    // budget before any data reference was reached, so they stay references.
    if (typeof rows[id] === 'string') return string;

    let value;
    if (row && id === row.id) {
      value = row.root;
    } else if (state.get(id) === DONE) {
      value = out[id];
    } else {
      // Every dependency finishes before its dependant, so a target that is
      // not done yet is an ancestor on the DFS stack: a cycle.
      stats.cycles++;
      return { $ref: id };
    }

    if (match[2]) {
      for (const prop of match[2].slice(1).split(':')) {
        const key = isElement(value) && Object.hasOwn(ELEMENT_FIELDS, prop) ? ELEMENT_FIELDS[prop] : prop;
        if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return string;
        value = value[key];
      }
    }
    if (row && row.open.has(value)) {
      stats.cycles++;
      return { $ref: id };
    }

    const added = serializedSize(value, sizes) - Buffer.byteLength(JSON.stringify(string));
    if (added > budget) {
      stats.overBudget++;
      return string;
    }
    if (added > 0) budget -= added;
    stats.resolved++;
    return value;
  };

  // Copy a row in document order (pre-order), resolving references as they
  // are met. `open` holds the containers whose subtree is not finished yet; a
  // reference landing on one of them would enclose itself.
  const resolveRow = (id) => {
    const raw = rows[id];
    if (typeof raw === 'string') return resolveString(raw, null);
    if (raw === null || typeof raw !== 'object') return raw;

    const root = Array.isArray(raw) ? [] : {};
    const row = { id, root, open: new Set([root]) };
    const copies = new Map([[raw, root]]);
    const stack = [{ close: root }];
    const pushChildren = (src, dst) => {
      const keys = Object.keys(src);
      for (let i = keys.length - 1; i >= 0; i--) stack.push({ src: src[keys[i]], dst, key: keys[i] });
    };
    pushChildren(raw, root);

    while (stack.length > 0) {
      const entry = stack.pop();
      if (entry.close) {
        row.open.delete(entry.close);
        continue;
      }
      const { src, dst, key } = entry;
      if (typeof src === 'string') {
        setOwn(dst, key, resolveString(src, row));
      } else if (src !== null && typeof src === 'object') {
        let copy = copies.get(src);
        if (copy === undefined) {
          copy = Array.isArray(src) ? [] : {};
          copies.set(src, copy);
          row.open.add(copy);
          stack.push({ close: copy });
          pushChildren(src, copy);
        } else if (row.open.has(copy)) {
          // Only a cyclic in-memory input gets here; JSON never does.
          stats.cycles++;
          copy = { $ref: id };
        }
        setOwn(dst, key, copy);
      } else {
        setOwn(dst, key, src);
      }
    }
    return root;
  };

  // Keep the input's key order in the output.
  for (const id of ids) setOwn(out, id, undefined);

  // Iterative post-order DFS over the reference graph: a row is resolved once
  // every row it references is, so a 100k-long chain needs no call stack.
  for (const start of ids) {
    if (state.has(start)) continue;
    state.set(start, ON_STACK);
    const stack = [{ id: start, deps: dependencies(start), next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.next < frame.deps.length) {
        const dep = frame.deps[frame.next++];
        if (!state.has(dep)) {
          state.set(dep, ON_STACK);
          stack.push({ id: dep, deps: dependencies(dep), next: 0 });
        }
        continue;
      }
      stack.pop();
      setOwn(out, frame.id, resolveRow(frame.id));
      state.set(frame.id, DONE);
    }
  }

  return { rows: out, ...stats };
}

/**
 * Index the rows that carry data rather than markup: object or array rows that
 * are not a React element tree (`["$", type, key, props]`) nor a list of
 * element children, ranked by serialized size. String rows (`I`/`HL`/`T`) are
 * not data rows. An index, not a copy — a caller reads a row with the path
 * `next_f.<id>`.
 *
 * An array counts as element children when every item is an element or a
 * primitive (a `$L` lazy reference, a text node, `false`, `null`) and at least
 * one item is an element — the shape of a fragment's children.
 *
 * @param {Record<string, unknown>} rows
 * @returns {Array<{ id: string, bytes: number, keys: string[] | null, length: number | null }>}
 */
export function flightDataRows(rows) {
  const out = [];
  if (rows === null || typeof rows !== 'object') return out;
  const sizes = new WeakMap();

  const isChildren = (array) => {
    let elements = 0;
    for (const item of array) {
      if (isElement(item)) elements++;
      else if (item !== null && typeof item === 'object') return false;
    }
    return elements > 0;
  };

  for (const id of Object.keys(rows)) {
    const value = rows[id];
    if (value === null || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      if (isElement(value) || isChildren(value)) continue;
      out.push({ id, bytes: serializedSize(value, sizes), keys: null, length: value.length });
    } else {
      out.push({ id, bytes: serializedSize(value, sizes), keys: Object.keys(value).slice(0, 20), length: null });
    }
  }

  return out.sort((a, b) => b.bytes - a.bytes);
}
