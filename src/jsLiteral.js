/**
 * jsLiteral.js — read a JavaScript literal without running it.
 *
 * Some pages ship their state as a JS expression rather than JSON: unquoted
 * keys, `void 0`, `!0`, and the IIFE wrapper that Nuxt 2 and devalue.uneval
 * (SvelteKit) emit to share repeated values:
 *
 *   window.__NUXT__=(function(a,b){return {x:a,y:[b]}}(1,"z"))
 *
 * This is static evaluation over an acorn AST. No code executes: there is no
 * eval, no vm, no Function, and no property or global lookup. The IIFE form is
 * read by binding each parameter name to its argument's literal value — a
 * name → literal environment — and evaluating the single `return` expression
 * against it. An identifier resolves only to a bound parameter (or the
 * literal names undefined/NaN/Infinity); everything else is refused.
 *
 * Allowed, and nothing more:
 *   - string/number/boolean/null literals; a bigint becomes its decimal string
 *   - arrays (holes read as null) and objects with plain, non-computed keys
 *   - unary - and + on numbers, !0 / !1, and void <literal> (undefined)
 *   - template literals with no ${} expressions
 *   - string + string
 *   - (function(a,b){return <expr>}(<args>)) with simple identifier params
 *   - new Date(<number|string>) and new RegExp(<string>[, <string>]), the
 *     two constructors devalue.uneval emits for SvelteKit load data
 *     (svelte.dev, 2026-10-03). Read as an ISO string and a "/src/flags"
 *     string — the same JSON-safe forms frameworkData.js gives them.
 *
 * Output is JSON-safe: undefined, NaN and ±Infinity become null wherever they
 * land in an array or object, and at the top level.
 *
 * The source is attacker-controlled, so the walk is bounded: nesting depth is
 * capped, and a cost budget caps total work. A reference to an IIFE parameter
 * is charged the full cost of its argument, because that is what the reader
 * receives once the result is serialized — `(function(a){return [a,a,a]}(…))`
 * nested a few levels deep would otherwise expand exponentially.
 */

import { parseExpressionAt } from 'acorn';

const MAX_DEPTH = 512;

// One unit per AST node, plus one per 16 characters of every string produced.
// Generous for real pages (a 20 MB state blob costs ~2.5M), and it bounds the
// output an IIFE can amplify a small source into.
const MAX_COST = 5_000_000;
const CHARS_PER_COST_UNIT = 16;

class Refusal extends Error {}

/**
 * @param {{ cost: number }} budget
 * @param {number} units
 */
function charge(budget, units) {
  budget.cost += units;
  if (budget.cost > MAX_COST) {
    throw new Refusal(`the literal exceeds the evaluation budget of ${MAX_COST} units`);
  }
}

/** @param {{ cost: number }} budget @param {string} text */
function chargeString(budget, text) {
  charge(budget, Math.ceil(text.length / CHARS_PER_COST_UNIT));
  return text;
}

/** undefined, NaN and ±Infinity are not JSON; store them as null. */
function jsonSafe(value) {
  if (value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

/**
 * Look a name up in the IIFE parameter scope chain.
 * @param {{ vars: Map<string, { value: unknown, cost: number }>, parent: object|null }|null} scope
 * @param {string} name
 */
function lookup(scope, name) {
  for (let s = scope; s !== null; s = s.parent) {
    if (s.vars.has(name)) return s.vars.get(name);
  }
  return undefined;
}

/**
 * The narrow IIFE shape: a plain function expression, simple identifier
 * params, a body that is exactly one `return <expr>`.
 * @param {any} callee
 */
function isLiteralIife(callee) {
  return callee.type === 'FunctionExpression'
    && !callee.async
    && !callee.generator
    && callee.params.every((param) => param.type === 'Identifier')
    && callee.body.body.length === 1
    && callee.body.body[0].type === 'ReturnStatement'
    && callee.body.body[0].argument !== null;
}

/**
 * Evaluate one node. Values are raw JS here (undefined, NaN allowed) so that
 * `-Infinity` and `void 0` compose; containers store them JSON-safe.
 * @returns {unknown}
 */
function evaluate(node, scope, depth, budget) {
  if (depth > MAX_DEPTH) throw new Refusal(`nesting deeper than ${MAX_DEPTH} levels`);
  charge(budget, 1);

  switch (node.type) {
    case 'Literal': {
      if (node.regex) throw new Refusal('a regular expression literal');
      if (typeof node.value === 'bigint') return node.value.toString();
      if (typeof node.value === 'string') return chargeString(budget, node.value);
      return node.value;
    }

    case 'ArrayExpression':
      return node.elements.map((element) => {
        if (element === null) return null;
        if (element.type === 'SpreadElement') throw new Refusal('a spread element');
        return jsonSafe(evaluate(element, scope, depth + 1, budget));
      });

    case 'ObjectExpression': {
      const object = {};
      for (const prop of node.properties) {
        if (prop.type !== 'Property') throw new Refusal('a spread property');
        if (prop.computed) throw new Refusal('a computed key');
        if (prop.kind !== 'init' || prop.method) throw new Refusal('a method, getter or setter');
        if (prop.shorthand) throw new Refusal(`a shorthand property "${prop.key.name}"`);
        const key = prop.key.type === 'Identifier' ? prop.key.name : String(prop.key.value);
        // defineProperty, not assignment: a "__proto__" key becomes an own
        // data property instead of replacing the object's prototype. (In JS
        // the literal would set the prototype; as data it is safer kept as a
        // plain key.)
        Object.defineProperty(object, key, {
          value: jsonSafe(evaluate(prop.value, scope, depth + 1, budget)),
          enumerable: true,
          writable: true,
          configurable: true
        });
      }
      return object;
    }

    case 'UnaryExpression': {
      const value = evaluate(node.argument, scope, depth + 1, budget);
      if (node.operator === 'void') return undefined;
      if ((node.operator === '-' || node.operator === '+') && typeof value === 'number') {
        return node.operator === '-' ? -value : value;
      }
      if (node.operator === '!' && (typeof value === 'number' || typeof value === 'boolean')) {
        return !value;
      }
      throw new Refusal(`the unary operator "${node.operator}" on a ${typeof value}`);
    }

    case 'Identifier': {
      const binding = lookup(scope, node.name);
      if (binding !== undefined) {
        charge(budget, binding.cost);
        return binding.value;
      }
      if (node.name === 'undefined') return undefined;
      if (node.name === 'NaN') return NaN;
      if (node.name === 'Infinity') return Infinity;
      throw new Refusal(`the identifier "${node.name}"`);
    }

    case 'TemplateLiteral': {
      const cooked = node.expressions.length === 0 ? node.quasis[0].value.cooked : null;
      if (typeof cooked !== 'string') throw new Refusal('a template literal with expressions');
      return chargeString(budget, cooked);
    }

    case 'BinaryExpression': {
      if (node.operator !== '+') throw new Refusal(`the binary operator "${node.operator}"`);
      const left = evaluate(node.left, scope, depth + 1, budget);
      const right = evaluate(node.right, scope, depth + 1, budget);
      if (typeof left !== 'string' || typeof right !== 'string') {
        throw new Refusal('a "+" that is not string concatenation');
      }
      return chargeString(budget, left + right);
    }

    case 'NewExpression': {
      const name = node.callee.type === 'Identifier' ? node.callee.name : null;
      if ((name === 'Date' || name === 'RegExp') && lookup(scope, name) === undefined) {
        const args = node.arguments.map((arg) => {
          if (arg.type === 'SpreadElement') throw new Refusal('a spread argument');
          return evaluate(arg, scope, depth + 1, budget);
        });
        if (name === 'Date' && args.length === 1
          && (typeof args[0] === 'number' || typeof args[0] === 'string')) {
          const date = new Date(args[0]);
          return Number.isNaN(date.getTime()) ? null : date.toISOString();
        }
        if (name === 'RegExp' && args.length >= 1 && args.length <= 2
          && args.every((arg) => typeof arg === 'string')) {
          return chargeString(budget, `/${args[0]}/${args[1] ?? ''}`);
        }
      }
      throw new Refusal('a constructor call');
    }

    case 'CallExpression': {
      if (node.optional || !isLiteralIife(node.callee)) throw new Refusal('a function call');
      // Arguments are evaluated in the caller's scope; each records what it
      // cost so every later reference to it is charged the same.
      const args = node.arguments.map((arg) => {
        if (arg.type === 'SpreadElement') throw new Refusal('a spread argument');
        const before = budget.cost;
        const value = evaluate(arg, scope, depth + 1, budget);
        return { value, cost: budget.cost - before };
      });
      const vars = new Map();
      node.callee.params.forEach((param, i) => {
        vars.set(param.name, args[i] ?? { value: undefined, cost: 0 });
      });
      return evaluate(node.callee.body.body[0].argument, { vars, parent: scope }, depth + 1, budget);
    }

    default:
      throw new Refusal(`a ${node.type}`);
  }
}

/**
 * Statically evaluate an acorn ESTree expression node made only of literals.
 *
 * @param {object} node an acorn expression node
 * @param {{ cost: number }} [budget] pass one object to several calls to make
 *   them share one cost cap (readSvelteKitData evaluates entry by entry)
 * @returns {{ ok: true, value: unknown } | { ok: false, reason: string }}
 */
export function evaluateLiteralNode(node, budget = { cost: 0 }) {
  try {
    return { ok: true, value: jsonSafe(evaluate(node, null, 0, budget)) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: `not a literal: ${error.message}` };
    // A stack overflow before MAX_DEPTH (a small stack) is still a refusal.
    return { ok: false, reason: `not evaluated: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Parse the expression that starts at `start` in `text` and evaluate it.
 *
 * @param {string} text
 * @param {number} [start]
 * @returns {{ ok: true, value: unknown, end: number } | { ok: false, reason: string }}
 */
export function evaluateLiteralSource(text, start = 0) {
  let node;
  try {
    node = parseExpressionAt(text, start, { ecmaVersion: 'latest' });
  } catch (error) {
    // acorn reports pathological nesting as a SyntaxError ("Not enough stack
    // space"); a RangeError is possible too. Either way: refuse, never throw.
    return { ok: false, reason: `not parseable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = evaluateLiteralNode(node);
  return result.ok ? { ok: true, value: result.value, end: node.end } : result;
}
