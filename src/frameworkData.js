/**
 * frameworkData.js — decode the framework payloads a JSON parse cannot read.
 *
 * Nuxt 3 ships its state as a devalue `stringify` payload in
 * <script type="application/json" id="__NUXT_DATA__" data-nuxt-data="…">: a
 * flat array where every value is an index into the array, with Vue
 * reactivity wrappers tagged as ["Reactive", i], ["ShallowRef", i], …. Parsed
 * as plain JSON it is a list of numbers; decoded, it is the page's state.
 *
 * SvelteKit ships its load() data inline in the boot script as devalue
 * `uneval` output — a JavaScript literal, read here with jsLiteral.js.
 *
 * Both readers return JSON-safe trees and never throw: anything they cannot
 * decode comes back as a warning.
 */

import { unflatten } from 'devalue';
import { parseExpressionAt } from 'acorn';

import { evaluateLiteralNode } from './jsLiteral.js';

// Nuxt's EmptyRef/EmptyShallowRef payload: '_' is undefined, '0n' is a zero
// bigint, anything else is JSON (Nuxt reads it with destr, a forgiving
// JSON.parse that falls back to the string).
function reviveEmptyRef(data) {
  if (data === '_') return undefined;
  if (data === '0n') return 0;
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

const identity = (data) => data;

/**
 * The revivers Nuxt 3 registers (app/plugins/revive-payload.client), minus
 * Vue: a ref or reactive wrapper is just its value once it is data. Only
 * Reactive, ShallowReactive and the devalue built-in Set were seen live on
 * nuxt.com (2026-10-03); the rest follow Nuxt's source.
 */
const NUXT_REVIVERS = {
  NuxtError: identity,
  EmptyShallowRef: reviveEmptyRef,
  EmptyRef: reviveEmptyRef,
  ShallowRef: identity,
  ShallowReactive: identity,
  Ref: identity,
  Reactive: identity
};

// Type tags devalue 6 decodes itself. Any other tag throws "Unknown type" in
// unflatten, so it gets an identity reviver and a warning instead.
const DEVALUE_BUILTIN_TYPES = new Set([
  'Date', 'Set', 'Map', 'RegExp', 'Object', 'BigInt', 'null',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Float16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'DataView', 'ArrayBuffer',
  'URL', 'URLSearchParams', 'Temporal.Duration', 'Temporal.Instant',
  'Temporal.PlainDate', 'Temporal.PlainTime', 'Temporal.PlainDateTime',
  'Temporal.PlainMonthDay', 'Temporal.PlainYearMonth', 'Temporal.ZonedDateTime'
]);

// Construction overrides that build JSON-safe leaves directly: no Date, URL,
// Temporal or RegExp object is ever constructed from page input, and
// Temporal — absent from Node — cannot fail the decode.
const PARSE_OPERATIONS = {
  fromPrimitive: (value) => {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value === undefined ? null : value;
  },
  fromISOString: (iso) => (typeof iso === 'string' ? iso : null),
  fromStringValue: (tag, text) => (typeof text === 'string' ? text : null),
  fromRegExpInfo: (source, flags) => `/${source}/${flags ?? ''}`,
  box: (value) => value
};

// The JSON-safe conversion is a recursive walk. Real Nuxt state is a few
// dozen levels deep; past this, a branch is cut and reported.
const MAX_DEPTH = 512;
// Output cost: one unit per value plus one per 16 characters of string. The
// devalue format shares every repeated value by index, so a small payload can
// reference one large object or string a million times; written out, that
// would expand without bound. Past this cost a repeated object is written as
// a $ref and anything else as null.
const MAX_OUTPUT_COST = 5_000_000;
const CHARS_PER_COST_UNIT = 16;

/** Append a key to a jsonPath.js-style path ("state.items[0]"). */
const childPath = (path, key) =>
  typeof key === 'number' ? `${path}[${key}]` : path === '' ? key : `${path}.${key}`;

/** Copy entries onto a fresh object as own data properties ("__proto__" too). */
function dataObject(entries) {
  const out = {};
  for (const [key, value] of entries) {
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * Turn a decoded devalue graph into a JSON-safe tree.
 *
 * Map → plain object when every key is a string, else an array of [key,
 * value] pairs; Set → array; typed arrays and ArrayBuffer → arrays of numbers;
 * undefined / NaN / ±Infinity → null; bigint → string.
 *
 * Cycles cannot be represented in JSON, so a value reached again while it is
 * still being written (an ancestor of itself) becomes { $ref: "<path>" },
 * where <path> is its first occurrence in jsonPath.js syntax ("" is the
 * root). A shared object reached a second time from elsewhere is written out
 * again — until MAX_OUTPUT_COST is spent, after which it too is a $ref.
 *
 * @param {unknown} root
 * @param {string[]} warnings
 * @returns {unknown}
 */
function toJsonSafe(root, warnings) {
  const firstPath = new Map();
  const onStack = new Set();
  let cost = 0;
  let depthCut = false;
  let overBudget = false;

  function convert(value, path, depth) {
    cost += typeof value === 'string' ? 1 + Math.floor(value.length / CHARS_PER_COST_UNIT) : 1;
    if (value === undefined || value === null) return null;
    const isObject = typeof value === 'object';
    if (isObject && onStack.has(value)) return { $ref: firstPath.get(value) };
    if (cost > MAX_OUTPUT_COST) {
      overBudget = true;
      return isObject && firstPath.has(value) ? { $ref: firstPath.get(value) } : null;
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') return value.toString();
    if (!isObject) return typeof value === 'string' || typeof value === 'boolean' ? value : null;
    if (depth > MAX_DEPTH) {
      depthCut = true;
      return null;
    }
    if (!firstPath.has(value)) firstPath.set(value, path);

    onStack.add(value);
    const next = depth + 1;
    let out;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const view = value instanceof ArrayBuffer || value instanceof DataView
        ? new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer,
          value.byteOffset ?? 0, value.byteLength)
        : value;
      out = Array.from(view, (n) => (typeof n === 'bigint' ? n.toString() : n));
      cost += out.length;
    } else if (value instanceof Set) {
      out = [];
      for (const item of value) out.push(convert(item, childPath(path, out.length), next));
    } else if (value instanceof Map) {
      const entries = [...value];
      out = entries.every(([key]) => typeof key === 'string')
        ? dataObject(entries.map(([key, item]) => [key, convert(item, childPath(path, key), next)]))
        : entries.map(([key, item], i) => [
          convert(key, childPath(childPath(path, i), 0), next),
          convert(item, childPath(childPath(path, i), 1), next)
        ]);
    } else if (Array.isArray(value) && value.length > MAX_OUTPUT_COST) {
      // A sparse array can declare a length of 2^32-1 around two entries;
      // walking every slot would hang, so only populated indices are kept.
      warnings.push(`A sparse array of declared length ${value.length} at "${path}" was read as an object of its populated indices.`);
      out = dataObject(Object.keys(value).map((key) => [key, convert(value[key], childPath(path, key), next)]));
    } else if (Array.isArray(value)) {
      out = new Array(value.length);
      for (let i = 0; i < value.length; i++) out[i] = convert(value[i], childPath(path, i), next);
    } else {
      // Plain or null-prototype object.
      out = dataObject(Object.keys(value).map((key) => [key, convert(value[key], childPath(path, key), next)]));
    }
    onStack.delete(value);
    return out;
  }

  const result = convert(root, '', 0);
  if (depthCut) warnings.push(`Branches nested deeper than ${MAX_DEPTH} levels were cut and read as null.`);
  if (overBudget) {
    warnings.push(`The decoded payload passed its output budget (${MAX_OUTPUT_COST} units); past it, repeated objects are written as { $ref } and other values as null.`);
  }
  return result;
}

/**
 * Decode a parsed __NUXT_DATA__ block (Nuxt 3/4, devalue `stringify` format).
 *
 * @param {unknown} parsed the block's JSON.parse output
 * @returns {{ value: unknown, warnings: string[] }} value is null when the
 *   payload cannot be decoded; the reason is in warnings
 */
export function decodeNuxtData(parsed) {
  const warnings = [];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { value: null, warnings: ['__NUXT_DATA__ is not a devalue payload (expected a non-empty array); not decoded.'] };
  }

  const revivers = { ...NUXT_REVIVERS };
  const unknown = new Set();
  for (const entry of parsed) {
    if (Array.isArray(entry) && typeof entry[0] === 'string'
      && !DEVALUE_BUILTIN_TYPES.has(entry[0]) && !Object.hasOwn(revivers, entry[0])) {
      unknown.add(entry[0]);
    }
  }
  for (const type of unknown) revivers[type] = identity;
  if (unknown.size > 0) {
    warnings.push(`__NUXT_DATA__ uses reviver type(s) this reader does not know (${[...unknown].join(', ')}); each was read as its plain value.`);
  }

  let decoded;
  try {
    // A copy: unflatten appends to the array it is given when a custom
    // reviver wraps a non-index payload, and the caller may still report the
    // raw block.
    decoded = unflatten(parsed.slice(), revivers, { operations: PARSE_OPERATIONS });
  } catch (error) {
    // Malformed indexes, a __proto__ key, a stack overflow on a pathological
    // chain — all hostile-input failures, all reported rather than thrown.
    warnings.push(`__NUXT_DATA__ could not be decoded: ${error instanceof Error ? error.message : String(error)}.`);
    return { value: null, warnings };
  }

  try {
    return { value: toJsonSafe(decoded, warnings), warnings };
  } catch (error) {
    warnings.push(`__NUXT_DATA__ decoded but could not be converted to JSON: ${error instanceof Error ? error.message : String(error)}.`);
    return { value: null, warnings };
  }
}

const SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const SVELTEKIT_GLOBAL_RE = /\b__sveltekit_[a-z0-9]+\s*=\s*\{/i;
const KIT_START_RE = /\bkit\s*\.\s*start\s*\(/g;

/**
 * Find the `data` property of the options object in
 * `kit.start(app, element, { node_ids, data, form, error })`.
 * @param {string} body the boot script's text
 * @returns {object|null} the acorn node of the data value
 */
function findStartData(body) {
  KIT_START_RE.lastIndex = 0;
  let match;
  while ((match = KIT_START_RE.exec(body)) !== null) {
    let call;
    try {
      call = parseExpressionAt(body, match.index, { ecmaVersion: 'latest' });
    } catch {
      continue;
    }
    const options = call.type === 'CallExpression' ? call.arguments[2] : null;
    if (!options || options.type !== 'ObjectExpression') continue;
    const prop = options.properties.find((p) => p.type === 'Property' && !p.computed
      && (p.key.type === 'Identifier' ? p.key.name : p.key.value) === 'data');
    if (prop) return prop.value;
  }
  return null;
}

/**
 * Read SvelteKit's hydration data out of its inline boot script:
 *
 *   __sveltekit_8abmph = { base: …, version: "…" };
 *   const element = document.currentScript.parentElement;
 *   import("…/start.js").then(async (kit) => {
 *     kit.init(__sveltekit_8abmph);
 *     const app = await import("…/app.js");
 *     kit.start(app, element, { node_ids: [0, 5], data: [ … ], form: null, error: null });
 *   });
 *
 * (svelte.dev, 2026-10-03; older SvelteKit uses Promise.all([...]).then(
 * ([kit, app]) => kit.start(…)), which reads the same.) Only `data` is
 * evaluated — the other arguments are identifiers. Each data entry is one
 * route node's load() output; an entry the literal evaluator refuses is null,
 * with a warning naming its index.
 *
 * @param {string} html raw HTML
 * @returns {{ value: unknown, warnings: string[] } | null} null when the page
 *   has no SvelteKit boot script
 */
export function readSvelteKitData(html) {
  const source = html.replace(HTML_COMMENT_RE, '');
  SCRIPT_RE.lastIndex = 0;
  let script;
  while ((script = SCRIPT_RE.exec(source)) !== null) {
    const body = script[1];
    if (!SVELTEKIT_GLOBAL_RE.test(body)) continue;

    const warnings = [];
    const data = findStartData(body);
    if (data === null) {
      return { value: null, warnings: ['A SvelteKit boot script is present but its kit.start(…) data could not be located.'] };
    }

    // One budget across entries, so a page cannot multiply the evaluator's
    // cap by splitting its payload into many entries.
    const budget = { cost: 0 };
    if (data.type !== 'ArrayExpression') {
      const result = evaluateLiteralNode(data, budget);
      if (!result.ok) warnings.push(`SvelteKit data was not evaluated (${result.reason}).`);
      return { value: result.ok ? result.value : null, warnings };
    }

    const value = data.elements.map((element, i) => {
      if (element === null) return null;
      const result = evaluateLiteralNode(element, budget);
      if (result.ok) return result.value;
      warnings.push(`SvelteKit data[${i}] was not evaluated (${result.reason}); read as null.`);
      return null;
    });
    return { value, warnings };
  }
  return null;
}
