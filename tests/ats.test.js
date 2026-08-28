/**
 * Unit tests: the ATS list connectors.
 *
 * Run: node --test tests/ats.test.js
 *
 * Every fixture under tests/fixtures/ats/ is condensed from a live capture
 * taken on 2026-08-28 with `curl -A 'CrawlForge/1.2.4 (+https://crawlforge.dev)'`:
 *
 *   greenhouse-jobs-content.json  boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true  (571 jobs, 4.2 MB)
 *   greenhouse-jobs-summary.json  the same board without content=true                          (571 jobs, 349 KB)
 *   lever-postings.json           api.lever.co/v0/postings/leverdemo?mode=json                 (384 postings, 2.3 MB)
 *   ashby-jobs.json               api.ashbyhq.com/posting-api/job-board/ramp                   (138 jobs, 2.2 MB)
 *   workable-jobs.json            www.workable.com/api/accounts/persado?details=true           (3 jobs, 22 KB)
 *   recruitee-offers.json         channable.recruitee.com/api/offers/                          (14 offers, 372 KB)
 *   teamtailor-jobs.rss           career.teamtailor.com/jobs.rss                               (13 items, 83 KB)
 *
 * Records were selected for the variations that break a parser written from a
 * field list rather than a capture: Greenhouse omits `education`, `departments`
 * and `offices` on some or all records; Lever ships a `categories` bag whose
 * keys are individually absent; Ashby marks a Hybrid job `isRemote: true`;
 * Workable writes an absent city as "" rather than null. Long description
 * bodies are the only thing shortened, and their escaping is untouched.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ATS_TEMPLATES } from '../src/connectors/ats.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ats');
const fixture = name => readFileSync(join(FIXTURES, name), 'utf8');
const connector = id => {
  const found = ATS_TEMPLATES.find(t => t.id === id);
  assert.ok(found, `no connector with id "${id}"`);
  return found;
};

const COMMON_FIELDS = [
  'id', 'title', 'url', 'location', 'department', 'team', 'employment_type',
  'remote', 'published_at', 'updated_at', 'description', 'source'
];

/** The parsed board for each connector, keyed by connector id. */
const BOARDS = {
  'greenhouse-jobs': () => connector('greenhouse-jobs').extractList(
    fixture('greenhouse-jobs-content.json'),
    'https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true'
  ),
  'lever-postings': () => connector('lever-postings').extractList(
    fixture('lever-postings.json'), 'https://api.lever.co/v0/postings/leverdemo?mode=json'
  ),
  'ashby-jobs': () => connector('ashby-jobs').extractList(
    fixture('ashby-jobs.json'), 'https://api.ashbyhq.com/posting-api/job-board/ramp'
  ),
  'workable-jobs': () => connector('workable-jobs').extractList(
    fixture('workable-jobs.json'), 'https://www.workable.com/api/accounts/persado?details=true'
  ),
  'recruitee-offers': () => connector('recruitee-offers').extractList(
    fixture('recruitee-offers.json'), 'https://channable.recruitee.com/api/offers/'
  ),
  'teamtailor-jobs': () => connector('teamtailor-jobs').extractList(
    fixture('teamtailor-jobs.rss'), 'https://career.teamtailor.com/jobs.rss'
  )
};

// ── The contract every connector keeps ───────────────────────────────────────

describe('ATS connectors — shared contract', () => {
  test('there are six of them, with the expected ids', () => {
    assert.deepEqual(ATS_TEMPLATES.map(t => t.id), [
      'greenhouse-jobs', 'lever-postings', 'ashby-jobs',
      'workable-jobs', 'recruitee-offers', 'teamtailor-jobs'
    ]);
  });

  for (const template of ATS_TEMPLATES) {
    describe(template.id, () => {
      test('declares the hooks a list connector needs', () => {
        assert.equal(typeof template.listUrl, 'function');
        assert.equal(typeof template.extractList, 'function');
        assert.equal(typeof template.resolveUrl, 'function');
        // TemplateRegistry.list() calls targetPattern.toString() on every
        // template, so a connector without one takes the whole registry down.
        assert.ok(template.targetPattern instanceof RegExp);
        assert.ok(template.name && template.description);
      });

      test('needs no credentials', () => {
        assert.equal(template.requiresApiKey, undefined);
        assert.equal(template.credentialRef, undefined);
      });

      test('every job carries the whole common shape, and names its source', () => {
        const { items, count } = BOARDS[template.id]();
        assert.ok(items.length > 0);
        assert.equal(count, items.length);
        for (const item of items) {
          for (const field of COMMON_FIELDS) {
            assert.ok(field in item, `${template.id} job is missing "${field}"`);
          }
          assert.equal(item.source, template.id);
          assert.ok(item.id && item.title && item.url);
        }
      });

      test('a field the platform does not carry is null, never invented', () => {
        for (const item of BOARDS[template.id]().items) {
          for (const field of COMMON_FIELDS) {
            const value = item[field];
            assert.ok(
              value === null || typeof value === 'string' || typeof value === 'boolean',
              `${template.id}.${field} should be null, a string or a boolean — got ${typeof value}`
            );
            assert.notEqual(value, '', `${template.id}.${field} is an empty string, not null`);
          }
          assert.ok([true, false, null].includes(item.remote));
        }
      });

      test('listUrl names the missing parameter rather than building a broken URL', () => {
        assert.throws(() => template.listUrl({}), /requires a "company" parameter/);
        assert.throws(() => template.listUrl(), /requires a "company" parameter/);
      });

      test('a response from some other service is rejected, not half-parsed', () => {
        assert.throws(
          () => template.extractList('<!doctype html><html><body>Not Found</body></html>',
            'https://example.com/jobs'),
          /^Error: (Not a|No) /
        );
      });
    });
  }
});

// ── Greenhouse ───────────────────────────────────────────────────────────────

describe('greenhouse-jobs', () => {
  const template = connector('greenhouse-jobs');

  test('listUrl builds the board endpoint, and content=true is opt-in', () => {
    assert.equal(
      template.listUrl({ company: 'stripe' }),
      'https://boards-api.greenhouse.io/v1/boards/stripe/jobs'
    );
    assert.equal(
      template.listUrl({ company: 'stripe', content: true }),
      'https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true'
    );
  });

  test('a board page URL resolves to the API', () => {
    assert.equal(
      template.resolveUrl('https://job-boards.greenhouse.io/stripe'),
      'https://boards-api.greenhouse.io/v1/boards/stripe/jobs'
    );
    assert.equal(
      template.resolveUrl('https://boards.greenhouse.io/stripe/jobs/7532733'),
      'https://boards-api.greenhouse.io/v1/boards/stripe/jobs'
    );
    // Already the API endpoint — left alone.
    const api = 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true';
    assert.equal(template.resolveUrl(api), api);
  });

  test('reads real jobs off the captured board', () => {
    const { items, count, total_available, company } = BOARDS['greenhouse-jobs']();
    assert.equal(count, 3);
    // The capture is 3 of the 571 jobs meta.total declares.
    assert.equal(total_available, 571);
    assert.equal(company, 'Stripe');

    assert.deepEqual(items[0], {
      id: '7532733',
      title: 'Account Executive, AI Sales',
      url: 'https://stripe.com/jobs/search?gh_jid=7532733',
      location: 'San Francisco, CA',
      department: '1175 Enterprise - Account Executives (NA)',
      team: null,
      // Greenhouse publishes neither an employment type nor a remote flag.
      employment_type: null,
      remote: null,
      published_at: '2026-02-03T20:19:01.000Z',
      updated_at: '2026-08-25T21:40:40.000Z',
      description: items[0].description,
      source: 'greenhouse-jobs',
      raw_extra: {
        internal_job_id: '3336216',
        requisition_id: 'See Opening ID',
        offices: ['US']
      }
    });
  });

  test('the description is decoded, not handed back as visible markup', () => {
    // The wire carries "&lt;h2&gt;Who we are&lt;/h2&gt;". A single strip pass
    // finds no tags and returns the markup as text; this is the regression.
    const [job] = BOARDS['greenhouse-jobs']().items;
    assert.ok(job.description.startsWith('Who we are About Stripe'));
    assert.ok(!job.description.includes('<h2>'));
    assert.ok(!job.description.includes('&lt;'));
  });

  test('a job open in two offices keeps both', () => {
    const job = BOARDS['greenhouse-jobs']().items.find(j => j.id === '8041655');
    assert.equal(job.title, 'Product Manager, E-Invoicing');
    assert.equal(job.location, 'Dublin, Ireland');
    assert.deepEqual(job.raw_extra.offices, ['ES-Barcelona', 'Ireland Locations']);
  });

  test('the summary form reports no department rather than guessing one', () => {
    // Without content=true, Greenhouse omits content, departments and offices
    // entirely — the same three jobs, minus the three fields.
    const { items, count } = template.extractList(
      fixture('greenhouse-jobs-summary.json'),
      'https://boards-api.greenhouse.io/v1/boards/stripe/jobs'
    );
    assert.equal(count, 2);
    assert.equal(items[0].id, '7532733');
    assert.equal(items[0].title, 'Account Executive, AI Sales');
    assert.equal(items[0].location, 'San Francisco, CA');
    assert.equal(items[0].description, null);
    assert.equal(items[0].department, null);
    // null, not [] — [] would claim the job has no office.
    assert.equal(items[0].raw_extra.offices, null);
  });

  test('an unknown board token is reported as such', () => {
    assert.throws(
      () => template.extractList('{"status":404,"error":"Job not found"}',
        'https://boards-api.greenhouse.io/v1/boards/nope/jobs'),
      /No Greenhouse job board at .*: Job not found\./
    );
    assert.throws(
      () => template.extractList('<html>oops</html>',
        'https://boards-api.greenhouse.io/v1/boards/nope/jobs'),
      /did not return JSON/
    );
  });
});

// ── Lever ────────────────────────────────────────────────────────────────────

describe('lever-postings', () => {
  const template = connector('lever-postings');

  test('declares the Crawl-delay its robots.txt asks for', () => {
    // api.lever.co/robots.txt: "Allow: / / Crawl-delay: 1". The connector does
    // not fetch, so all it can do is republish the number for the host limiter.
    assert.equal(template.crawlDelaySeconds, 1);
  });

  test('listUrl asks for JSON, and passes the documented paging through', () => {
    assert.equal(
      template.listUrl({ company: 'leverdemo' }),
      'https://api.lever.co/v0/postings/leverdemo?mode=json'
    );
    assert.equal(
      template.listUrl({ company: 'leverdemo', skip: 50, limit: 25 }),
      'https://api.lever.co/v0/postings/leverdemo?mode=json&skip=50&limit=25'
    );
  });

  test('a careers page URL resolves to the API', () => {
    assert.equal(
      template.resolveUrl('https://jobs.lever.co/leverdemo'),
      'https://api.lever.co/v0/postings/leverdemo?mode=json'
    );
    assert.equal(
      template.resolveUrl('https://jobs.lever.co/leverdemo/33538a2f-d27d-4a96-8f05-fa4b0e4d940e'),
      'https://api.lever.co/v0/postings/leverdemo?mode=json'
    );
  });

  test('reads real postings, title from Lever\'s "text" field', () => {
    const { items, count } = BOARDS['lever-postings']();
    assert.equal(count, 5);
    assert.deepEqual(items[0], {
      id: '33538a2f-d27d-4a96-8f05-fa4b0e4d940e',
      title: 'AbelsonTaylor Writer',
      url: 'https://jobs.lever.co/leverdemo/33538a2f-d27d-4a96-8f05-fa4b0e4d940e',
      location: 'Arlington, TX',
      department: 'Customer Success',
      team: 'Professional Services',
      // Lever's own words, not a normalised "full_time".
      employment_type: 'Regular Full Time (Salary)',
      // workplaceType "hybrid" is neither a yes nor a no.
      remote: null,
      // createdAt is epoch milliseconds: 1553186035299.
      published_at: '2019-03-21T16:33:55.299Z',
      updated_at: null,
      description: items[0].description,
      source: 'lever-postings',
      raw_extra: {
        workplace_type: 'hybrid',
        level: null,
        all_locations: ['Arlington, TX'],
        salary_range: null,
        apply_url: 'https://jobs.lever.co/leverdemo/33538a2f-d27d-4a96-8f05-fa4b0e4d940e/apply'
      }
    });
  });

  test('a posting with an empty categories bag reports nulls, not blanks', () => {
    const items = BOARDS['lever-postings']().items;
    // categories: { team: "Sales", allLocations: [] } — location, department
    // and commitment are absent keys, not empty values.
    const sparse = items.find(j => j.id === '79eda854-d6ba-4e73-9eb0-524daefed2d8');
    assert.equal(sparse.location, null);
    assert.equal(sparse.department, null);
    assert.equal(sparse.team, 'Sales');
    assert.equal(sparse.employment_type, null);
    assert.deepEqual(sparse.raw_extra.all_locations, []);

    // categories: { level: "Senior", allLocations: [] } — not even a team.
    const level = items.find(j => j.id === '6d94d2c9-3c9d-415b-b457-281a68d1f6f4');
    assert.equal(level.title, 'Apprentice Electrician');
    assert.equal(level.team, null);
    assert.equal(level.raw_extra.level, 'Senior');
  });

  test('workplaceType decides remote, and "unspecified" is not a no', () => {
    const items = BOARDS['lever-postings']().items;
    const byId = id => items.find(j => j.id === id);
    assert.equal(byId('c559265a-55ec-4f75-ac56-78290081f6e7').remote, true);   // "remote"
    assert.equal(byId('1897fca1-502e-4511-b279-de479e99fbea').remote, null);   // "unspecified"
    assert.equal(byId('33538a2f-d27d-4a96-8f05-fa4b0e4d940e').remote, null);   // "hybrid"
  });

  test('a salary band is kept where Lever publishes one', () => {
    const paid = BOARDS['lever-postings']().items
      .find(j => j.id === 'c559265a-55ec-4f75-ac56-78290081f6e7');
    assert.deepEqual(paid.raw_extra.salary_range,
      { min: 10000, max: 125000, currency: 'USD', interval: 'per-year-salary' });
  });

  test('an unknown company is reported as such', () => {
    assert.throws(
      () => template.extractList('{"ok":false,"error":"Document not found"}',
        'https://api.lever.co/v0/postings/nope?mode=json'),
      /No Lever postings at .*: Document not found\./
    );
  });
});

// ── Ashby ────────────────────────────────────────────────────────────────────

describe('ashby-jobs', () => {
  const template = connector('ashby-jobs');

  test('listUrl builds the posting API endpoint', () => {
    assert.equal(
      template.listUrl({ company: 'ramp' }),
      'https://api.ashbyhq.com/posting-api/job-board/ramp'
    );
  });

  test('a job board URL resolves to the API', () => {
    assert.equal(
      template.resolveUrl('https://jobs.ashbyhq.com/ramp'),
      'https://api.ashbyhq.com/posting-api/job-board/ramp'
    );
  });

  test('reads real jobs off the captured board', () => {
    const { items, count, api_version } = BOARDS['ashby-jobs']();
    assert.equal(count, 4);
    assert.equal(api_version, '1');

    const onsite = items.find(j => j.id === '6a20b3b8-8111-4cbd-be4b-423b60660738');
    assert.deepEqual(onsite, {
      id: '6a20b3b8-8111-4cbd-be4b-423b60660738',
      title: 'Office Coordinator, NYC',
      url: 'https://jobs.ashbyhq.com/ramp/6a20b3b8-8111-4cbd-be4b-423b60660738',
      location: 'New York, NY (HQ)',
      department: 'People & Talent',
      team: 'Workplace',
      employment_type: 'FullTime',
      remote: false,
      published_at: '2026-07-28T18:22:37.155Z',
      updated_at: null,
      description: onsite.description,
      source: 'ashby-jobs',
      raw_extra: {
        workplace_type: 'OnSite',
        secondary_locations: [],
        apply_url: 'https://jobs.ashbyhq.com/ramp/6a20b3b8-8111-4cbd-be4b-423b60660738/application'
      }
    });
  });

  test('a Hybrid job is not reported remote, whatever isRemote says', () => {
    // Ramp's "Security Engineer, Cloud" ships isRemote: true alongside
    // workplaceType "Hybrid", at the New York HQ. Trusting the boolean would
    // put an office job in a remote-jobs list.
    const hybrid = BOARDS['ashby-jobs']().items
      .find(j => j.id === '34413f8d-26bf-4bbc-8ade-eb309a0e2245');
    assert.equal(hybrid.title, 'Security Engineer, Cloud');
    assert.equal(hybrid.raw_extra.workplace_type, 'Hybrid');
    assert.equal(hybrid.remote, null);
    // The capture really does carry isRemote: true for that job.
    assert.equal(JSON.parse(fixture('ashby-jobs.json')).jobs
      .find(j => j.id === '34413f8d-26bf-4bbc-8ade-eb309a0e2245').isRemote, true);
  });

  test('the leading space Ashby leaves on a title is trimmed', () => {
    assert.equal(JSON.parse(fixture('ashby-jobs.json')).jobs
      .find(j => j.id === '34413f8d-26bf-4bbc-8ade-eb309a0e2245').title, ' Security Engineer, Cloud');
    assert.equal(BOARDS['ashby-jobs']().items
      .find(j => j.id === '34413f8d-26bf-4bbc-8ade-eb309a0e2245').title, 'Security Engineer, Cloud');
  });

  test('secondary locations keep their names, not their postal addresses', () => {
    const remote = BOARDS['ashby-jobs']().items
      .find(j => j.id === 'd84bbf19-572a-499c-9c87-0c154ce85caf');
    assert.equal(remote.remote, true);
    assert.deepEqual(remote.raw_extra.secondary_locations, ['San Francisco, CA', 'Remote (US)']);
  });

  test('employment types come through in Ashby\'s own words', () => {
    const intern = BOARDS['ashby-jobs']().items
      .find(j => j.id === '67fadb77-43d8-4449-954b-d4cf2c6d3b8b');
    assert.equal(intern.employment_type, 'Intern');
    assert.equal(intern.team, 'Emerging Talent - SWE');
  });

  test('an unknown board is reported as such', () => {
    assert.throws(
      () => template.extractList('{"apiVersion":"1"}',
        'https://api.ashbyhq.com/posting-api/job-board/nope'),
      /No Ashby job board at .*: no jobs array\./
    );
  });
});

// ── Workable ─────────────────────────────────────────────────────────────────

describe('workable-jobs', () => {
  const template = connector('workable-jobs');

  test('listUrl builds the URL Workable documents, not its redirect target', () => {
    // Workable's own help article gives www.workable.com/api/accounts/<sub>;
    // it 302s to the apply.workable.com widget endpoint.
    assert.equal(
      template.listUrl({ company: 'persado' }),
      'https://www.workable.com/api/accounts/persado'
    );
    assert.equal(
      template.listUrl({ company: 'persado', details: true }),
      'https://www.workable.com/api/accounts/persado?details=true'
    );
  });

  test('a careers page URL resolves to the accounts endpoint', () => {
    assert.equal(
      template.resolveUrl('https://apply.workable.com/persado/'),
      'https://www.workable.com/api/accounts/persado'
    );
    assert.equal(
      template.resolveUrl('https://persado.workable.com/jobs'),
      'https://www.workable.com/api/accounts/persado'
    );
    // A single-job shortlink does not name the account, so it is left alone.
    const single = 'https://apply.workable.com/j/EB98E75C30';
    assert.equal(template.resolveUrl(single), single);
  });

  test('reads real jobs off the captured account', () => {
    const { items, count, company } = BOARDS['workable-jobs']();
    assert.equal(count, 3);
    assert.equal(company, 'Persado');

    assert.deepEqual(items[0], {
      // Workable's public identifier is the shortcode; there is no numeric id.
      id: 'EB98E75C30',
      title: 'Manager, Project Management',
      url: 'https://apply.workable.com/j/EB98E75C30',
      location: 'New York, United States',
      department: 'Campaign Delivery & Onboarding',
      team: null,
      employment_type: 'Full-time',
      remote: true,
      // published_on is a date with no time; it is not widened to midnight.
      published_at: '2026-07-31',
      updated_at: null,
      description: items[0].description,
      source: 'workable-jobs',
      raw_extra: {
        shortcode: 'EB98E75C30',
        code: null,
        function: 'Project Management',
        apply_url: 'https://apply.workable.com/j/EB98E75C30/apply'
      }
    });
  });

  test('an empty city and state drop out of the location instead of padding it', () => {
    // Workable writes an absent city as "" rather than omitting it, so a naive
    // join produces ", , United States".
    const raw = JSON.parse(fixture('workable-jobs.json')).jobs
      .find(j => j.shortcode === 'B9D91A4C0B');
    assert.equal(raw.city, '');
    assert.equal(raw.state, '');
    assert.equal(raw.code, '');

    const job = BOARDS['workable-jobs']().items.find(j => j.id === 'B9D91A4C0B');
    assert.equal(job.location, 'United States');
    // "" is Workable's no-value, and reads as null here.
    assert.equal(job.raw_extra.code, null);
  });

  test('a city that repeats the state is not said twice', () => {
    // city "New York", state "New York", country "United States".
    assert.equal(BOARDS['workable-jobs']().items[0].location, 'New York, United States');
    assert.equal(
      BOARDS['workable-jobs']().items.find(j => j.id === 'D6FB457899').location,
      'Washington, District of Columbia, United States'
    );
  });

  test('an unknown account is reported as such', () => {
    // The endpoint answers an unknown subdomain with the plain text "Not Found".
    assert.throws(
      () => template.extractList('Not Found', 'https://www.workable.com/api/accounts/nope'),
      /Not a Workable account response: .* did not return JSON\./
    );
  });
});

// ── Recruitee ────────────────────────────────────────────────────────────────

describe('recruitee-offers', () => {
  const template = connector('recruitee-offers');

  test('listUrl builds the careers-site offers endpoint', () => {
    assert.equal(
      template.listUrl({ company: 'channable' }),
      'https://channable.recruitee.com/api/offers/'
    );
  });

  test('a Recruitee-hosted careers URL resolves to the API', () => {
    assert.equal(
      template.resolveUrl('https://channable.recruitee.com/o/product-manager-core-ai'),
      'https://channable.recruitee.com/api/offers/'
    );
    // A tenant on its own domain does not name its subdomain anywhere in the
    // URL, so there is nothing to resolve; the caller passes `company`.
    const custom = 'https://jobs.channable.com/o/product-manager-core-ai';
    assert.equal(template.resolveUrl(custom), custom);
  });

  test('reads real offers off the captured careers site', () => {
    const { items, count, company } = BOARDS['recruitee-offers']();
    assert.equal(count, 3);
    assert.equal(company, 'Channable');

    assert.deepEqual(items[0], {
      id: '2723126',
      title: 'Technical Customer Support Benelux - Dutch speaking',
      url: 'https://jobs.channable.com/o/technical-customer-support-benelux-dutch-speaking-1',
      location: 'Utrecht, Utrecht, Netherlands',
      department: 'Support',
      team: null,
      employment_type: 'fulltime_fixed_term',
      // remote: false, hybrid: true, on_site: false → hybrid, which is neither.
      remote: null,
      // Recruitee stamps "2026-08-28 11:47:47 UTC", which Date alone cannot read.
      published_at: '2026-08-28T11:47:47.000Z',
      updated_at: '2026-08-28T12:19:42.000Z',
      description: items[0].description,
      source: 'recruitee-offers',
      raw_extra: {
        workplace_type: 'hybrid',
        slug: 'technical-customer-support-benelux-dutch-speaking-1',
        salary: { max: '2950', min: '2850', period: 'month', currency: 'EUR' },
        tags: [],
        apply_url: 'https://jobs.channable.com/o/technical-customer-support-benelux-dutch-speaking-1/c/new'
      }
    });
  });

  test('the per-job application mailbox is dropped, not mapped', () => {
    // Every Recruitee offer carries mailbox_email — a contact address. It has
    // no place in a job listing, so it does not appear anywhere in the output.
    const raw = JSON.parse(fixture('recruitee-offers.json')).offers[0];
    assert.equal(raw.mailbox_email, 'job.f6wvb@channable.recruitee.com');
    assert.ok(raw.open_questions.length > 0);
    assert.ok(raw.translations.en);

    const serialised = JSON.stringify(BOARDS['recruitee-offers']().items);
    assert.ok(!serialised.includes('mailbox_email'));
    assert.ok(!serialised.includes('@channable.recruitee.com'));
    assert.ok(!serialised.includes('open_questions'));
    assert.ok(!serialised.includes('translations'));
  });

  test('the description is the copy, not the markup', () => {
    const [job] = BOARDS['recruitee-offers']().items;
    assert.ok(job.description.startsWith('Are you passionate about solving complex problems'));
    assert.ok(!job.description.includes('<p>'));
    assert.ok(!job.description.includes('color:#000000'));
  });

  test('an unknown subdomain is reported as such', () => {
    assert.throws(
      () => template.extractList('{"error":"Not Found"}',
        'https://nope.recruitee.com/api/offers/'),
      /No Recruitee careers site at .*: Not Found\./
    );
  });
});

// ── Teamtailor ───────────────────────────────────────────────────────────────

describe('teamtailor-jobs', () => {
  const template = connector('teamtailor-jobs');

  test('listUrl builds the documented feed URL, with its paging parameters', () => {
    assert.equal(
      template.listUrl({ company: 'career' }),
      'https://career.teamtailor.com/jobs.rss'
    );
    assert.equal(
      template.listUrl({ company: 'career', per_page: 250, offset: 100 }),
      'https://career.teamtailor.com/jobs.rss?per_page=250&offset=100'
    );
  });

  test('any careers jobs page resolves to its feed, custom domains included', () => {
    assert.equal(
      template.resolveUrl('https://career.teamtailor.com/jobs'),
      'https://career.teamtailor.com/jobs.rss'
    );
    // Teamtailor documents the feed as "the jobs page with .rss appended",
    // which is why this also works off the tenant's own domain.
    assert.equal(
      template.resolveUrl('https://jobs.example.com/jobs/'),
      'https://jobs.example.com/jobs.rss'
    );
    const feed = 'https://career.teamtailor.com/jobs.rss';
    assert.equal(template.resolveUrl(feed), feed);
  });

  test('reads real jobs off the captured feed', () => {
    const { items, count, company } = BOARDS['teamtailor-jobs']();
    assert.equal(count, 3);
    assert.equal(company, 'Teamtailor');

    assert.deepEqual(items[0], {
      id: '3ce2c88b-cbc6-4ae9-8ecb-000466c69037',
      title: 'Group Financial Controller',
      url: 'https://career.teamtailor.com/jobs/8124573-group-financial-controller',
      location: 'Stockholm',
      department: 'Finance',
      team: null,
      // The feed carries no employment type.
      employment_type: null,
      remote: null,
      // pubDate is RFC 822: "Fri, 24 Jul 2026 13:57:16 +0200".
      published_at: '2026-07-24T11:57:16.000Z',
      updated_at: null,
      description: items[0].description,
      source: 'teamtailor-jobs',
      raw_extra: {
        workplace_type: 'hybrid',
        // <tt:role/> and <tt:division/> are empty elements on this job.
        role: null,
        division: null,
        locations: ['Stockholm']
      }
    });
  });

  test('a job open in two cities lists both', () => {
    const apac = BOARDS['teamtailor-jobs']().items
      .find(j => j.id === '36d9bbe6-6cf5-4c10-b12b-d4bf739777ce');
    assert.equal(apac.title, 'Partnership Manager - APAC');
    assert.equal(apac.location, 'Sydney, Melbourne');
    assert.deepEqual(apac.raw_extra.locations, ['Sydney', 'Melbourne']);
    // remoteStatus "none" is an answer, unlike Lever's "unspecified".
    assert.equal(apac.raw_extra.workplace_type, 'none');
    assert.equal(apac.remote, false);
  });

  test('the description is decoded out of the XML and then stripped', () => {
    const [job] = BOARDS['teamtailor-jobs']().items;
    assert.ok(job.description.startsWith('Join Teamtailor and Help Shape the Future of Work!'));
    assert.ok(!job.description.includes('<h4>'));
    assert.ok(!job.description.includes('&lt;'));
  });

  test('Teamtailor\'s own namespaced fields are kept', () => {
    const support = BOARDS['teamtailor-jobs']().items
      .find(j => j.id === 'f40addc7-d9ec-4535-bf88-3e12a7c96dbd');
    assert.equal(support.department, 'Customer Support');
    assert.equal(support.raw_extra.role, 'Customer Support Agent');
  });

  test('a page that is not the feed is reported as such', () => {
    assert.throws(
      () => template.extractList('<!doctype html><html><body>Jobs</body></html>',
        'https://career.teamtailor.com/jobs'),
      /No Teamtailor job feed at .*: the response is not an RSS feed\./
    );
    assert.throws(
      () => template.extractList('<?xml version="1.0"?><rss version="2.0"><channel>' +
        '<title>Teamtailor</title></channel></rss>',
        'https://career.teamtailor.com/jobs.rss'),
      /No Teamtailor job feed at .*: the feed has no items\./
    );
  });
});

// ── The point of the common shape ────────────────────────────────────────────

describe('two boards union without per-source mapping', () => {
  test('every job from every platform answers the same twelve questions', () => {
    const all = Object.values(BOARDS).flatMap(read => read().items);
    assert.equal(all.length, 21);

    // One shape means one set of keys, whichever platform a job came from.
    const shapes = new Set(all.map(j => COMMON_FIELDS.filter(f => f in j).join(',')));
    assert.equal(shapes.size, 1);

    // …and the source stays attached, so a merged list stays traceable.
    assert.deepEqual([...new Set(all.map(j => j.source))].sort(), [
      'ashby-jobs', 'greenhouse-jobs', 'lever-postings',
      'recruitee-offers', 'teamtailor-jobs', 'workable-jobs'
    ]);

    // Sorting a merged list by date works because every timestamp is ISO 8601.
    const dated = all.filter(j => j.published_at).map(j => j.published_at);
    assert.equal(dated.length, all.length);
    for (const stamp of dated) {
      assert.ok(!Number.isNaN(Date.parse(stamp)), `${stamp} is not a parseable date`);
    }
  });
});
