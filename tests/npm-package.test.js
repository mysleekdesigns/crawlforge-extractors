/**
 * Unit tests: the npm-package template.
 *
 * Run: node --test tests/npm-package.test.js
 *
 * The template reads the npm registry API rather than the rendered npmjs.com
 * page. Scraping the page returned almost nothing: npmjs.com answers plain
 * HTTP fetches with 403, and where a body did come back the class-name hooks
 * the old selectors relied on produced a null version, null downloads and a
 * "repository" pointing at the stargazers link.
 *
 * Payload shapes below are condensed from live registry documents captured
 * 2026-08-26, including the legacy repository and license spellings that old
 * packages still carry.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TemplateRegistry } from '../src/templates.js';

const registry = new TemplateRegistry();
const template = registry.get('npm-package');

const doc = (over = {}) => ({
  name: 'crawlforge-mcp-server',
  'dist-tags': { latest: '5.2.2' },
  maintainers: [{ name: 'slacey75', email: 'x@example.com' }],
  time: {
    modified: '2026-08-26T15:23:01.705Z',
    '5.2.2': '2026-08-26T15:23:01.521Z'
  },
  versions: {
    '5.2.2': {
      description: 'CrawlForge MCP Server',
      license: 'MIT',
      homepage: 'https://crawlforge.dev',
      repository: { type: 'git', url: 'git+https://github.com/mysleekdesigns/crawlforge-mcp.git' },
      bugs: { url: 'https://github.com/mysleekdesigns/crawlforge-mcp/issues' },
      keywords: ['mcp', 'scraping'],
      dependencies: { cheerio: '^1.0.0', zod: '^3.0.0' }
    }
  },
  ...over
});

describe('npm-package URL resolution', () => {
  test('rewrites a package page to its registry document', () => {
    assert.equal(
      template.resolveUrl('https://www.npmjs.com/package/crawlforge-mcp-server'),
      'https://registry.npmjs.org/crawlforge-mcp-server'
    );
  });

  test('keeps the scope on a scoped package', () => {
    assert.equal(
      template.resolveUrl('https://www.npmjs.com/package/@modelcontextprotocol/sdk'),
      'https://registry.npmjs.org/@modelcontextprotocol/sdk'
    );
  });

  test('drops a /v/<version> suffix', () => {
    assert.equal(
      template.resolveUrl('https://www.npmjs.com/package/react/v/18.0.0'),
      'https://registry.npmjs.org/react'
    );
  });

  test('leaves a registry URL alone', () => {
    assert.equal(
      template.resolveUrl('https://registry.npmjs.org/react'),
      'https://registry.npmjs.org/react'
    );
  });
});

describe('npm-package extraction', () => {
  test('reads the latest version rather than returning null', () => {
    const data = template.extractRaw(JSON.stringify(doc()), 'https://registry.npmjs.org/x');
    assert.equal(data.version, '5.2.2');
    assert.equal(data.name, 'crawlforge-mcp-server');
    assert.equal(data.license, 'MIT');
    assert.equal(data.published, '2026-08-26T15:23:01.521Z');
  });

  test('normalises a git+https repository URL to a browsable one', () => {
    const data = template.extractRaw(JSON.stringify(doc()), 'https://registry.npmjs.org/x');
    assert.equal(data.repository, 'https://github.com/mysleekdesigns/crawlforge-mcp');
  });

  test('normalises the git+ssh spelling old packages carry', () => {
    const body = JSON.stringify(doc({
      versions: {
        '5.2.2': { repository: { url: 'git+ssh://git@github.com/stevemao/left-pad.git' } }
      }
    }));
    const data = template.extractRaw(body, 'https://registry.npmjs.org/x');
    assert.equal(data.repository, 'https://github.com/stevemao/left-pad');
  });

  test('expands the bare owner/repo shorthand', () => {
    const body = JSON.stringify(doc({
      versions: { '5.2.2': { repository: 'sindresorhus/got' } }
    }));
    assert.equal(
      template.extractRaw(body, 'https://registry.npmjs.org/x').repository,
      'https://github.com/sindresorhus/got'
    );
  });

  test('reads the legacy { type, url } license object', () => {
    const body = JSON.stringify(doc({
      versions: { '5.2.2': { license: { type: 'WTFPL', url: 'http://example.com' } } }
    }));
    assert.equal(template.extractRaw(body, 'https://registry.npmjs.org/x').license, 'WTFPL');
  });

  test('reports a deprecation notice, which npm keeps serving packages through', () => {
    const body = JSON.stringify(doc({
      versions: { '5.2.2': { deprecated: 'use String.prototype.padStart instead' } }
    }));
    const data = template.extractRaw(body, 'https://registry.npmjs.org/x');
    assert.equal(data.deprecated, 'use String.prototype.padStart instead');
  });

  test('reports deprecated:false for a live package', () => {
    assert.equal(template.extractRaw(JSON.stringify(doc()), 'https://registry.npmjs.org/x').deprecated, false);
  });

  test('returns dependencies and their count', () => {
    const data = template.extractRaw(JSON.stringify(doc()), 'https://registry.npmjs.org/x');
    assert.equal(data.dependency_count, 2);
    assert.equal(data.dependencies.cheerio, '^1.0.0');
  });

  test('flattens maintainers to usernames', () => {
    const data = template.extractRaw(JSON.stringify(doc()), 'https://registry.npmjs.org/x');
    assert.deepEqual(data.maintainers, ['slacey75']);
  });

  test('throws on the registry\'s not-found document rather than returning empty fields', () => {
    assert.throws(
      () => template.extractRaw('{"error":"Not found"}', 'https://registry.npmjs.org/nope'),
      /No npm package at .*Not found/
    );
  });

  test('throws when the response is not JSON', () => {
    assert.throws(
      () => template.extractRaw('<!doctype html><html>403</html>', 'https://registry.npmjs.org/x'),
      /did not return JSON/
    );
  });
});

describe('npm-package registration', () => {
  test('is listed by the registry', () => {
    const listed = registry.list().find(t => t.id === 'npm-package');
    assert.ok(listed);
    assert.match(listed.description, /registry API/);
  });
});
