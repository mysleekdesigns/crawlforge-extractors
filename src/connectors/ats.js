/**
 * ATS list connectors — read a company's whole job board from the ATS
 * platform's own public API, in one request.
 *
 * These are list templates: `extractList(body, url)` returns N entities rather
 * than the one entity `extract`/`extractRaw` return. Like every template here
 * they make no network calls — `listUrl(params)` builds the URL, the caller
 * fetches it, and `extractList` parses what comes back.
 *
 * Every connector below is pointed at an endpoint the platform itself
 * documents for public, unauthenticated use, on a host whose robots.txt allows
 * it. The doc URL and the robots.txt finding are recorded above each one, with
 * the date they were verified. Two platforms did not clear that bar and are
 * deliberately absent — see "Not shipped" at the foot of this file.
 *
 * No connector surfaces a named individual. Several of these payloads carry
 * recruiter contacts (Recruitee stamps a per-job application mailbox on every
 * offer); those fields are dropped rather than mapped. A job posting is
 * company data, and that is all these return.
 */

import { load } from 'cheerio';

// ── The common job shape ─────────────────────────────────────────────────────

/**
 * One shape across all six platforms, so a caller can concatenate two boards
 * without a per-source mapping step.
 *
 * Every field is null where the platform does not carry it. None is inferred:
 * Greenhouse publishes no employment type at all, so a Greenhouse job reports
 * null there rather than a plausible-looking "Full-time".
 *
 * `employment_type` is passed through in the platform's own words ("FullTime",
 * "Full-time", "fulltime_fixed_term"). Collapsing those onto one vocabulary
 * would mean deciding what Lever's "Regular Full Time (Salary)" really is, and
 * that decision belongs to the caller, who can see their own data.
 */
function job(fields) {
  return {
    id: null,
    title: null,
    url: null,
    location: null,
    department: null,
    team: null,
    employment_type: null,
    remote: null,
    published_at: null,
    updated_at: null,
    description: null,
    source: null,
    ...fields
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Empty strings are how several of these payloads write "no value". */
function str(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

/**
 * Ids are numeric on Greenhouse, Recruitee and Workable and UUIDs on Lever,
 * Ashby and Teamtailor. Stringify so a merged list has one id type.
 */
function id(value) {
  return value === null || value === undefined || value === '' ? null : String(value);
}

/** A job body is a rendered HTML fragment; callers want the copy, not the markup. */
function htmlToText(html) {
  if (!html) return null;
  const text = load(`<div>${html}</div>`)('div').text().replace(/\s+/g, ' ').trim();
  return text || null;
}

/**
 * Greenhouse ships the description entity-escaped a second time: the wire
 * carries "&lt;h2&gt;Who we are&lt;/h2&gt;", not "<h2>Who we are</h2>".
 * Stripping tags from that finds none and hands the caller the markup as
 * visible text. Decode first, then strip.
 */
function escapedHtmlToText(escaped) {
  if (!escaped) return null;
  return htmlToText(load(`<div>${escaped}</div>`)('div').text());
}

/**
 * Every platform stamps a date differently: Greenhouse and Ashby ship ISO
 * 8601, Lever ships epoch milliseconds, Teamtailor ships RFC 822 and Recruitee
 * ships "2026-08-28 12:19:42 UTC", which Date parses as Invalid Date on its
 * own. Normalise to ISO 8601 so two boards sort together.
 *
 * A date with no time — all Workable publishes — is left exactly as it is.
 * Widening it to midnight would invent an hour the source never stated.
 */
function isoDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    const epoch = new Date(value);
    return Number.isNaN(epoch.getTime()) ? null : epoch.toISOString();
  }
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/, '$1T$2Z'));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * `remote` answers "can this job be done from anywhere?", and only two of the
 * words these platforms use answer it.
 *
 * Hybrid does not: it is genuinely part-remote, and reading it as false is as
 * wrong as reading it as true. Lever's "unspecified" does not either. Both
 * return null, and the platform's own word is kept in raw_extra.workplace_type
 * so nothing is lost.
 */
const REMOTE_WORDS = new Set(['remote', 'fully', 'telecommuting']);
const ONSITE_WORDS = new Set(['onsite', 'on_site', 'none', 'office']);

function isRemote(workplaceType) {
  const word = String(workplaceType ?? '').trim().toLowerCase().replace(/[\s-]+/g, '');
  if (!word) return null;
  if (REMOTE_WORDS.has(word) || REMOTE_WORDS.has(word.replace(/_/g, ''))) return true;
  if (ONSITE_WORDS.has(word) || ONSITE_WORDS.has(word.replace(/_/g, ''))) return false;
  return null;
}

/** Workable publishes the parts of a location but never the joined string. */
function joinLocation(...parts) {
  const joined = parts.map(str).filter(Boolean);
  return joined.length ? [...new Set(joined)].join(', ') : null;
}

/** The parameter is the caller's, so name it and say where to find its value. */
function requireParam(connector, name, value, where) {
  const given = str(value);
  if (!given) {
    throw new Error(`${connector} listUrl requires a "${name}" parameter — ${where}.`);
  }
  return given;
}

function notJson(connector, url, api) {
  return new Error(
    `Not a ${connector} response: ${url} did not return JSON. This connector reads ${api}.`
  );
}

/** items.length unless the payload declares a larger total of its own. */
function listResult(items, extra = {}, totalAvailable = null) {
  return {
    items,
    count: items.length,
    ...(typeof totalAvailable === 'number' && totalAvailable > items.length
      ? { total_available: totalAvailable }
      : {}),
    ...extra
  };
}

function parseJson(body, onFailure) {
  try {
    return JSON.parse(body);
  } catch {
    throw onFailure();
  }
}

// ── URL builders ─────────────────────────────────────────────────────────────
//
// Each connector's listUrl and resolveUrl are the same construction from two
// starting points, so both call one of these. They are module-level rather than
// methods because a consumer that pulls `resolveUrl` off the template and calls
// it on its own would lose `this`.

function greenhouseUrl({ company, content }) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company)}/jobs`;
  return content === true ? `${url}?content=true` : url;
}

function leverUrl({ company, skip, limit }) {
  const url = new URL(`https://api.lever.co/v0/postings/${encodeURIComponent(company)}`);
  url.searchParams.set('mode', 'json');
  if (skip !== undefined) url.searchParams.set('skip', String(skip));
  if (limit !== undefined) url.searchParams.set('limit', String(limit));
  return url.toString();
}

function ashbyUrl({ company }) {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company)}`;
}

function workableUrl({ company, details }) {
  // Workable documents the www.workable.com URL; it 302s to the
  // apply.workable.com widget endpoint, so the fetch must follow redirects.
  const url = `https://www.workable.com/api/accounts/${encodeURIComponent(company)}`;
  return details === true ? `${url}?details=true` : url;
}

function recruiteeUrl({ company }) {
  return `https://${encodeURIComponent(company)}.recruitee.com/api/offers/`;
}

function teamtailorUrl({ company, per_page, offset }) {
  const url = new URL(`https://${encodeURIComponent(company)}.teamtailor.com/jobs.rss`);
  if (per_page !== undefined) url.searchParams.set('per_page', String(per_page));
  if (offset !== undefined) url.searchParams.set('offset', String(offset));
  return url.toString();
}

// ── Connector definitions ────────────────────────────────────────────────────

export const ATS_TEMPLATES = [
  {
    // Docs:   https://docs.greenhouse.io/job-board.html — "Job Board data is
    //         publicly available, so authentication is not required for any GET
    //         endpoints." (Only POSTing an application needs Basic Auth.)
    // Robots: boards-api.greenhouse.io/robots.txt is "User-agent: * /
    //         Disallow: /embed/". /v1/boards/ is allowed. (2026-08-28)
    id: 'greenhouse-jobs',
    name: 'Greenhouse Job Board',
    description:
      'Read a company\'s whole Greenhouse job board from the Job Board API rather than the rendered ' +
      'careers page: every published job with its title, location, ids and timestamps in one ' +
      'request. Descriptions are opt-in — pass content: true — because they are most of the ' +
      'payload: Stripe\'s 571-job board is 349 KB without them and 4.2 MB with them.',
    targetPattern: /(boards|job-boards|boards-api)\.greenhouse\.io\//i,

    /**
     * `company` is Greenhouse's board token — the path segment in
     * https://job-boards.greenhouse.io/<token>, not the company's display name.
     */
    listUrl(params = {}) {
      const company = requireParam(
        'greenhouse-jobs', 'company', params.company,
        'the board token in https://job-boards.greenhouse.io/<token>'
      );
      return greenhouseUrl({ company, content: params.content });
    },

    /** Point the fetch at the API for the board the URL names. */
    resolveUrl(url) {
      const parsed = new URL(url);
      if (parsed.hostname === 'boards-api.greenhouse.io') return url;
      const token = parsed.pathname.split('/').filter(Boolean)[0];
      if (!token) return url;
      return greenhouseUrl({ company: token, content: parsed.searchParams.get('content') === 'true' });
    },

    extractList(body, url) {
      const payload = parseJson(body, () =>
        notJson('Greenhouse job board', url, 'the Greenhouse Job Board API')
      );

      // An unknown board token answers 404 with {"status":404,"error":"Job not found"}.
      if (!payload || !Array.isArray(payload.jobs)) {
        const reason = str(payload?.error) || 'no jobs array';
        throw new Error(
          `No Greenhouse job board at ${url}: ${reason}. ` +
          'The board token is the path segment in https://job-boards.greenhouse.io/<token>.'
        );
      }

      const items = payload.jobs.map(j => job({
        id: id(j.id),
        title: str(j.title),
        url: str(j.absolute_url),
        location: str(j.location?.name),
        // departments and offices ship only with content=true, so a summary
        // record reports null here rather than a department guessed from the
        // job title.
        department: str(j.departments?.[0]?.name),
        // Greenhouse has no team level and no employment type at all.
        employment_type: null,
        // …and no remote flag: the only hint is prose inside location.name,
        // which is not a fact the payload states.
        remote: null,
        published_at: isoDate(j.first_published),
        updated_at: isoDate(j.updated_at),
        description: escapedHtmlToText(j.content),
        source: 'greenhouse-jobs',
        raw_extra: {
          internal_job_id: id(j.internal_job_id),
          requisition_id: str(j.requisition_id),
          // The flat `location` loses Greenhouse's office hierarchy; keep the
          // names, not the child_ids arrays, which run to hundreds of numbers.
          // Absent on a summary record, where [] would claim the job has no
          // office rather than that this response form does not say.
          offices: j.offices ? j.offices.map(o => str(o.name)).filter(Boolean) : null
        }
      }));

      return listResult(items, { company: str(payload.jobs[0]?.company_name) }, payload.meta?.total);
    }
  },

  {
    // Docs:   https://github.com/lever/postings-api — Lever's own repository
    //         for the Postings API, documenting mode=json plus the skip/limit
    //         paging parameters. No key, no header.
    // Robots: api.lever.co/robots.txt is "User-agent: * / Allow: / /
    //         Crawl-delay: 1". Allowed, at one request per second. (2026-08-28)
    id: 'lever-postings',
    name: 'Lever Postings',
    description:
      'Read a company\'s whole Lever job board from the Postings API rather than the rendered ' +
      'careers page: every published posting with its team, commitment, workplace type and plain-text ' +
      'description. Lever declares Crawl-delay: 1, which this connector republishes as ' +
      'crawlDelaySeconds for the caller\'s rate limiter to honour.',
    targetPattern: /(jobs|api)\.lever\.co\//i,

    /**
     * api.lever.co asks for one request per second in its robots.txt. This
     * package never fetches, so it can only declare the number — the surface
     * that does the fetching has to hold to it.
     */
    crawlDelaySeconds: 1,

    /** `company` is the path segment in https://jobs.lever.co/<company>. */
    listUrl(params = {}) {
      const company = requireParam(
        'lever-postings', 'company', params.company,
        'the path segment in https://jobs.lever.co/<company>'
      );
      return leverUrl({ company, skip: params.skip, limit: params.limit });
    },

    resolveUrl(url) {
      const parsed = new URL(url);
      if (parsed.hostname === 'api.lever.co') return url;
      const company = parsed.pathname.split('/').filter(Boolean)[0];
      return company ? leverUrl({ company }) : url;
    },

    extractList(body, url) {
      const payload = parseJson(body, () =>
        notJson('Lever postings', url, 'the Lever Postings API')
      );

      // The postings response is a bare array. An unknown company answers 404
      // with {"ok":false,"error":"Document not found"}.
      if (!Array.isArray(payload)) {
        const reason = str(payload?.error) || 'the response was not a list of postings';
        throw new Error(
          `No Lever postings at ${url}: ${reason}. ` +
          'The company is the path segment in https://jobs.lever.co/<company>, and the request ' +
          'needs mode=json.'
        );
      }

      const items = payload.map(p => {
        const categories = p.categories || {};
        return job({
          id: id(p.id),
          // Lever calls the job title "text".
          title: str(p.text),
          url: str(p.hostedUrl),
          location: str(categories.location),
          department: str(categories.department),
          team: str(categories.team),
          employment_type: str(categories.commitment),
          remote: isRemote(p.workplaceType),
          published_at: isoDate(p.createdAt),
          // Lever publishes no modification time.
          updated_at: null,
          description: str(p.descriptionPlain),
          source: 'lever-postings',
          raw_extra: {
            workplace_type: str(p.workplaceType),
            level: str(categories.level),
            // The flat `location` is the primary one; a posting open in three
            // cities lists all three here.
            all_locations: (categories.allLocations || []).map(str).filter(Boolean),
            salary_range: p.salaryRange || null,
            apply_url: str(p.applyUrl)
          }
        });
      });

      return listResult(items);
    }
  },

  {
    // Docs:   https://developers.ashbyhq.com/docs/public-job-posting-api —
    //         "Public Job Posting API", GET
    //         api.ashbyhq.com/posting-api/job-board/{JOB_BOARD_NAME}, no key.
    // Robots: api.ashbyhq.com/robots.txt answers 401 with the body
    //         "Unauthorized" — the host serves no robots.txt. Per RFC 9309 an
    //         unavailable robots.txt means unrestricted access. (2026-08-28)
    id: 'ashby-jobs',
    name: 'Ashby Job Board',
    description:
      'Read a company\'s whole Ashby job board from the Public Job Posting API rather than the ' +
      'rendered careers page: every listed job with its department, team, employment type, ' +
      'workplace type and plain-text description in one request.',
    targetPattern: /(jobs|api)\.ashbyhq\.com\//i,

    /** `company` is Ashby's jobs page name — the segment in https://jobs.ashbyhq.com/<name>. */
    listUrl(params = {}) {
      const company = requireParam(
        'ashby-jobs', 'company', params.company,
        'the jobs page name in https://jobs.ashbyhq.com/<name>'
      );
      return ashbyUrl({ company });
    },

    resolveUrl(url) {
      const parsed = new URL(url);
      if (parsed.hostname === 'api.ashbyhq.com') return url;
      const company = parsed.pathname.split('/').filter(Boolean)[0];
      return company ? ashbyUrl({ company }) : url;
    },

    extractList(body, url) {
      const payload = parseJson(body, () =>
        notJson('Ashby job board', url, 'the Ashby Public Job Posting API')
      );

      if (!payload || !Array.isArray(payload.jobs)) {
        throw new Error(
          `No Ashby job board at ${url}: no jobs array. ` +
          'The jobs page name is the path segment in https://jobs.ashbyhq.com/<name>.'
        );
      }

      const items = payload.jobs.map(j => job({
        id: id(j.id),
        title: str(j.title),
        url: str(j.jobUrl),
        location: str(j.location),
        department: str(j.department),
        team: str(j.team),
        employment_type: str(j.employmentType),
        // Read workplaceType, not Ashby's own isRemote boolean. isRemote is
        // true on jobs whose workplaceType is Hybrid — Ramp's "Security
        // Engineer, Cloud" is isRemote: true, workplaceType: "Hybrid", located
        // at the New York HQ (verified 2026-08-28) — so trusting it would
        // report office-based jobs as remote.
        remote: isRemote(j.workplaceType),
        published_at: isoDate(j.publishedAt),
        updated_at: null,
        description: str(j.descriptionPlain),
        source: 'ashby-jobs',
        raw_extra: {
          workplace_type: str(j.workplaceType),
          // Names only. The full entries carry a postal address per country,
          // which is an office directory, not part of a job listing.
          secondary_locations: (j.secondaryLocations || []).map(l => str(l.location)).filter(Boolean),
          apply_url: str(j.applyUrl)
        }
      }));

      return listResult(items, { api_version: str(payload.apiVersion) });
    }
  },

  {
    // Docs:   https://help.workable.com/hc/en-us/articles/115012771647-Using-the-Workable-API-to-create-a-careers-page
    //         — "Alternatively, to get the list of your published jobs only,
    //         you can try in your terminal the below public endpoints:
    //         curl -L GET 'https://www.workable.com/api/accounts/<account_subdomain>?details=true'".
    //         Workable's other jobs endpoint, <subdomain>.workable.com/spi/v3/jobs,
    //         needs a Bearer key and is deliberately not used here.
    // Robots: www.workable.com/robots.txt disallows /user_password_resets,
    //         /admin, /auth/google and /j/ only — /api/accounts/ is allowed.
    //         apply.workable.com, where the documented URL redirects, is
    //         "Disallow:" (nothing disallowed). (2026-08-28)
    id: 'workable-jobs',
    name: 'Workable Jobs',
    description:
      'Read a company\'s published Workable jobs from the public accounts endpoint rather than the ' +
      'rendered careers page: title, department, employment type, location parts and telecommuting ' +
      'flag for every open role. Descriptions are opt-in — pass details: true — matching the ' +
      'documented ?details=true parameter.',
    targetPattern: /(apply\.workable\.com|www\.workable\.com\/api\/accounts|[\w-]+\.workable\.com\/(jobs|spi))/i,

    /** `company` is the account subdomain — the first part of the signed-in Workable URL. */
    listUrl(params = {}) {
      const company = requireParam(
        'workable-jobs', 'company', params.company,
        'the account subdomain, the path segment in https://apply.workable.com/<subdomain>'
      );
      return workableUrl({ company, details: params.details });
    },

    resolveUrl(url) {
      const parsed = new URL(url);
      if (/\/api\/(v1\/widget\/)?accounts\//.test(parsed.pathname)) return url;
      const details = parsed.searchParams.get('details') === 'true';
      // apply.workable.com/<subdomain>. A single-job link (/j/<shortcode>)
      // does not name the account, so it is left alone.
      if (parsed.hostname === 'apply.workable.com') {
        const [first] = parsed.pathname.split('/').filter(Boolean);
        return first && first !== 'j' ? workableUrl({ company: first, details }) : url;
      }
      const subdomain = parsed.hostname.replace(/\.workable\.com$/i, '');
      return subdomain && subdomain !== parsed.hostname
        ? workableUrl({ company: subdomain, details })
        : url;
    },

    extractList(body, url) {
      const payload = parseJson(body, () =>
        // An unknown account answers 404 with the plain text "Not Found".
        notJson('Workable account', url, 'the public Workable accounts endpoint')
      );

      if (!payload || !Array.isArray(payload.jobs)) {
        throw new Error(
          `No Workable account at ${url}: no jobs array. ` +
          'The account subdomain is the path segment in https://apply.workable.com/<subdomain>.'
        );
      }

      const items = payload.jobs.map(j => job({
        // Workable's stable public identifier is the shortcode; there is no
        // separate numeric id in this payload.
        id: id(j.shortcode),
        title: str(j.title),
        url: str(j.url),
        location: joinLocation(j.city, j.state, j.country),
        department: str(j.department),
        // Workable has no team level.
        team: null,
        employment_type: str(j.employment_type),
        remote: typeof j.telecommuting === 'boolean' ? j.telecommuting : null,
        published_at: isoDate(j.published_on),
        updated_at: null,
        // description/requirements/benefits ship only with details=true, so a
        // summary record reports null rather than an empty string.
        description: htmlToText(j.description),
        source: 'workable-jobs',
        raw_extra: {
          shortcode: str(j.shortcode),
          code: str(j.code),
          function: str(j.function),
          apply_url: str(j.application_url)
        }
      }));

      return listResult(items, { company: str(payload.name) });
    }
  },

  {
    // Docs:   https://docs.recruitee.com/reference/intro-to-careers-site-api —
    //         "The Recruitee Careers Site API allows to view company data
    //         publicly available on a careers site"; the offers endpoint is GET
    //         https://<company>.recruitee.com/api/offers/, no key.
    // Robots: <company>.recruitee.com/robots.txt is "User-Agent: * /
    //         Disallow: /v/" — on the default domain and, after the redirect a
    //         tenant with a custom careers domain issues, there too.
    //         /api/offers/ is allowed. (2026-08-28)
    id: 'recruitee-offers',
    name: 'Recruitee Offers',
    description:
      'Read a company\'s published Recruitee offers from the Careers Site API rather than the ' +
      'rendered careers page: title, department, location, employment type code, salary band and ' +
      'plain-text description for every open role in one request.',
    targetPattern: /\.recruitee\.com\//i,

    /** `company` is the Recruitee subdomain in https://<company>.recruitee.com. */
    listUrl(params = {}) {
      const company = requireParam(
        'recruitee-offers', 'company', params.company,
        'the subdomain in https://<company>.recruitee.com'
      );
      return recruiteeUrl({ company });
    },

    /**
     * A tenant on a custom careers domain (jobs.example.com) does not carry its
     * Recruitee subdomain anywhere in the URL, so only *.recruitee.com URLs can
     * be resolved. Callers on a custom domain pass `company` to listUrl.
     */
    resolveUrl(url) {
      const parsed = new URL(url);
      const subdomain = parsed.hostname.replace(/\.recruitee\.com$/i, '');
      return subdomain && subdomain !== parsed.hostname ? recruiteeUrl({ company: subdomain }) : url;
    },

    extractList(body, url) {
      const payload = parseJson(body, () =>
        notJson('Recruitee offers', url, 'the Recruitee Careers Site API')
      );

      // An unknown subdomain answers 404 with {"error":"Not Found"}.
      if (!payload || !Array.isArray(payload.offers)) {
        const reason = str(payload?.error) || 'no offers array';
        throw new Error(
          `No Recruitee careers site at ${url}: ${reason}. ` +
          'The company is the subdomain in https://<company>.recruitee.com.'
        );
      }

      const items = payload.offers.map(o => job({
        id: id(o.id),
        title: str(o.title),
        url: str(o.careers_url),
        location: str(o.location),
        department: str(o.department),
        team: null,
        employment_type: str(o.employment_type_code),
        // Recruitee splits the workplace across three booleans rather than one
        // word, so rebuild the word before reading it.
        remote: isRemote(o.remote ? 'remote' : o.hybrid ? 'hybrid' : o.on_site ? 'onsite' : ''),
        published_at: isoDate(o.published_at),
        updated_at: isoDate(o.updated_at),
        description: htmlToText(o.description),
        source: 'recruitee-offers',
        // Deliberately absent: `mailbox_email` (a per-job application inbox),
        // `open_questions` (the application form) and `translations` (a full
        // copy of the description per locale). The first is contact data that
        // has no place in a job listing; the other two are not the listing.
        raw_extra: {
          workplace_type: o.remote ? 'remote' : o.hybrid ? 'hybrid' : o.on_site ? 'onsite' : null,
          slug: str(o.slug),
          salary: o.salary || null,
          tags: (o.tags || []).map(str).filter(Boolean),
          apply_url: str(o.careers_apply_url)
        }
      }));

      return listResult(items, { company: str(payload.offers[0]?.company_name) });
    }
  },

  {
    // Docs:   https://support.teamtailor.com/en/articles/11171756-rss-feed-how-to-guide
    //         — "Go to the main jobs page of your careers site and add '.rss'.
    //         For example, https://career.teamtailor.com/jobs.rss … Note that
    //         all of the data is publicly available", with offset and per_page
    //         to page past the default first 100.
    //         Teamtailor's other jobs API, api.teamtailor.com/v1/jobs, needs an
    //         Authorization token and is deliberately not used here. The
    //         sibling /jobs.json JSON Feed is live but Teamtailor documents
    //         nothing about it, so this connector reads the documented feed.
    // Robots: career.teamtailor.com/robots.txt disallows /app/, /messages/,
    //         /messenger/, /facebook/tab/ and /jobs/internal/ — /jobs.rss is
    //         allowed. The same file sets Content-Signal ai-train=no, which
    //         governs what may be done with the content after fetching, not
    //         whether it may be fetched. (2026-08-28)
    id: 'teamtailor-jobs',
    name: 'Teamtailor Jobs',
    description:
      'Read a company\'s published Teamtailor jobs from the careers site\'s documented RSS feed ' +
      'rather than the rendered page: title, department, locations, remote status and plain-text ' +
      'description for every open role. The feed returns the first 100 jobs unless per_page says otherwise.',
    targetPattern: /teamtailor\.com\/jobs(\.rss)?(\?|$)/i,

    /** `company` is the subdomain in https://<company>.teamtailor.com. */
    listUrl(params = {}) {
      const company = requireParam(
        'teamtailor-jobs', 'company', params.company,
        'the subdomain in https://<company>.teamtailor.com'
      );
      return teamtailorUrl({ company, per_page: params.per_page, offset: params.offset });
    },

    /**
     * The feed is the jobs page with ".rss" appended, which is how Teamtailor
     * documents it — so this also works on a careers site served from the
     * company's own domain, where nothing in the URL names the tenant.
     */
    resolveUrl(url) {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('.rss')) return url;
      parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}.rss`;
      return parsed.toString();
    },

    extractList(body, url) {
      // xmlMode keeps the tt: namespace prefixes intact; they carry the
      // location, department, role and division, which plain RSS has no slot for.
      const $ = load(body, { xmlMode: true });
      const items = $('channel > item');

      if (!$('rss').length || !items.length) {
        throw new Error(
          `No Teamtailor job feed at ${url}: ${$('rss').length ? 'the feed has no items' : 'the response is not an RSS feed'}. ` +
          'The feed is the careers site jobs page with ".rss" appended, e.g. ' +
          'https://<company>.teamtailor.com/jobs.rss.'
        );
      }

      const parsed = items.map((_, el) => {
        const $item = $(el);
        const field = sel => str($item.find(sel).first().text());
        const locations = $item.find('tt\\:location > tt\\:name')
          .map((__, name) => str($(name).text())).get().filter(Boolean);
        const remoteStatus = field('remoteStatus');

        return job({
          // Teamtailor's guid is the stable id; the numeric id in the URL slug
          // is the one their support pages call the "Job ID".
          id: id(field('guid')),
          title: field('title'),
          url: field('link'),
          location: locations.length ? locations.join(', ') : null,
          department: field('tt\\:department'),
          team: null,
          // The feed carries no employment type.
          employment_type: null,
          remote: isRemote(remoteStatus),
          published_at: isoDate(field('pubDate')),
          updated_at: null,
          // The description is HTML, entity-escaped inside the XML; cheerio
          // decodes it once on the way out, leaving markup to strip.
          description: htmlToText($item.find('description').first().text()),
          source: 'teamtailor-jobs',
          raw_extra: {
            workplace_type: remoteStatus,
            role: field('tt\\:role'),
            division: field('tt\\:division'),
            locations
          }
        });
      }).get();

      return listResult(parsed, { company: str($('channel > title').first().text()) });
    }
  }
];

// ── Not shipped ──────────────────────────────────────────────────────────────
//
// smartrecruiters-postings — SmartRecruiters documents a public Posting API at
//   https://developers.smartrecruiters.com/docs/endpoints (GET
//   api.smartrecruiters.com/v1/companies/<company>/postings, no key), but
//   api.smartrecruiters.com/robots.txt reads, in full:
//
//       User-agent: LinkedInBot
//       Allow: /v1/companies/
//       User-agent: *
//       Disallow: /
//
//   The one carve-out from a blanket disallow is LinkedIn's crawler. Reaching
//   that endpoint as anyone else means overriding robots.txt on every call,
//   which is not something a connector gets to decide on the caller's behalf.
//   Left out pending an agreement with SmartRecruiters. (Verified 2026-08-28.)

export default ATS_TEMPLATES;
