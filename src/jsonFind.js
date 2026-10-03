/**
 * jsonFind.js — find where a key lives in a parsed payload.
 *
 * The companion to jsonPath.js: a caller who knows a field's name but not its
 * position in a multi-megabyte state blob asks for the key, gets back every
 * path that holds it plus a short preview of each value, and then selects the
 * one it wants with `path`. The paths are written in exactly the syntax
 * selectJsonPath reads, so a match round-trips.
 *
 * The payload is page content, so the walk is iterative (depth is free),
 * visits each object once (cycles and shared subtrees cannot loop or fan out),
 * and stops after a fixed number of nodes.
 */

const MAX_NODES = 5_000_000;

const scalarJson = (value) => {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
};

const skipped = (value) => value === undefined || typeof value === 'function' || typeof value === 'symbol';

/**
 * The first `max` characters of JSON.stringify(value), without serializing
 * the rest — the value may be a large subtree.
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function previewJson(value, max) {
  let out = '';
  const frames = [];
  const emit = (item) => {
    if (item === null || typeof item !== 'object') {
      // Each character of a string serializes to at least one, so the first
      // max - out.length characters are enough for the visible prefix.
      out += scalarJson(typeof item === 'string' ? item.slice(0, Math.max(0, max - out.length)) : item);
    } else if (Array.isArray(item)) {
      out += '[';
      frames.push({ value: item, keys: null, next: 0, written: 0 });
    } else {
      out += '{';
      frames.push({ value: item, keys: Object.keys(item), next: 0, written: 0 });
    }
  };

  emit(value);
  while (frames.length > 0 && out.length < max) {
    const frame = frames[frames.length - 1];
    if (frame.keys === null) {
      if (frame.next >= frame.value.length) {
        out += ']';
        frames.pop();
        continue;
      }
      if (frame.next > 0) out += ',';
      const item = frame.value[frame.next++];
      emit(skipped(item) ? null : item);
    } else {
      if (frame.next >= frame.keys.length) {
        out += '}';
        frames.pop();
        continue;
      }
      const key = frame.keys[frame.next++];
      const item = frame.value[key];
      if (skipped(item)) continue;
      if (frame.written++ > 0) out += ',';
      out += `${JSON.stringify(key)}:`;
      emit(item);
    }
  }
  return out.slice(0, max);
}

// A segment selectJsonPath can read back in dot form: "." splits a path and
// "[" opens a bracket, and an empty segment is dropped.
const addressableKey = (key) => key !== '' && !key.includes('.') && !key.includes('[');

/**
 * Every property named `key` (case-insensitively), anywhere under `root`, in
 * document order.
 *
 * `path` is dotted (`next_f.10.1.2.3.providerModel`) and resolves with
 * selectJsonPath. A match whose path runs through a key that syntax cannot
 * spell (one containing "." or "[", or an empty key) is still reported, with
 * `addressable: false`. An object reached twice (a shared or cyclic value) is
 * walked once, at its first path.
 *
 * @param {unknown} root
 * @param {string} key
 * @param {{ limit?: number, previewChars?: number, maxNodes?: number }} [options]
 * @returns {{ matches: Array<{ path: string, preview: string, addressable?: false }>, total: number, truncated: boolean }}
 */
export function findJsonPaths(root, key, { limit = 50, previewChars = 200, maxNodes = MAX_NODES } = {}) {
  const matches = [];
  let total = 0;
  let truncated = false;
  if (typeof key !== 'string' || root === null || typeof root !== 'object') {
    return { matches, total, truncated };
  }

  const wanted = key.toLowerCase();
  const seen = new WeakSet();
  // Each entry is one node; `up` links to its parent entry, so a path is only
  // spelled out for the matches that are reported.
  const stack = [{ value: root, key: null, named: false, up: null, addressable: true }];
  let visited = 0;

  while (stack.length > 0) {
    if (++visited > maxNodes) {
      truncated = true;
      break;
    }
    const entry = stack.pop();

    if (entry.named && entry.key.toLowerCase() === wanted) {
      total++;
      if (matches.length < limit) {
        const segments = [];
        for (let at = entry; at.up !== null; at = at.up) segments.push(at.key);
        const match = { path: segments.reverse().join('.'), preview: previewJson(entry.value, previewChars) };
        if (!entry.addressable) match.addressable = false;
        matches.push(match);
      }
    }

    const { value } = entry;
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const named = !Array.isArray(value);
    const keys = Object.keys(value);
    for (let i = keys.length - 1; i >= 0; i--) {
      stack.push({
        value: value[keys[i]],
        key: keys[i],
        named,
        up: entry,
        addressable: entry.addressable && (!named || addressableKey(keys[i]))
      });
    }
  }

  if (total > matches.length) truncated = true;
  return { matches, total, truncated };
}
