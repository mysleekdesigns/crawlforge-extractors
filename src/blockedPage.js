/**
 * blockedPage.js — decide whether a fetched document is the page or a wall.
 *
 * Cloudflare, Amazon, DataDome, PerimeterX, Akamai and Vercel all answer a
 * blocked request with HTTP 200 and a page of their own: a title, some prose
 * and a challenge script. Reported as a successful scrape, that page hides
 * the block — producthunt.com came back "success:true, title: Just a
 * moment..." for three regression rounds (R10 Q1 → R15, 2026-09-04). The
 * MCP server's stealth path learned to name these in 5.6.2 and to name HTTP
 * error pages and short error-titled placeholders in 5.6.9; the plain
 * `scrape` path on both surfaces never looked. The tables live here so the
 * two surfaces reach one verdict.
 *
 * A title match is definitive; a script or form marker is definitive only
 * on a short page, because a real page can legitimately embed a Turnstile
 * widget.
 */

const SHORT_PAGE_CHARS = 4000;

const CHALLENGES = [
  {
    vendor: 'cloudflare',
    title: /^just a moment/i,
    markers: /challenges\.cloudflare\.com|cf-chl-|_cf_chl_opt|cf_chl_rc_|window\._cf_chl/i,
    evidence: 'a Cloudflare challenge script'
  },
  {
    vendor: 'amazon',
    // The robot check is the only Amazon page whose form posts to validateCaptcha.
    definitive: /action="[^"]*validateCaptcha/i,
    evidence: 'the validateCaptcha form'
  },
  {
    vendor: 'datadome',
    markers: /captcha-delivery\.com\/captcha|geo\.captcha-delivery\.com|dd\.captcha/i,
    evidence: 'a DataDome captcha frame'
  },
  {
    vendor: 'perimeterx',
    markers: /px-captcha|_pxCaptcha|human-challenge/i,
    evidence: 'a PerimeterX / HUMAN challenge element'
  },
  {
    vendor: 'akamai',
    title: /^access denied/i,
    markers: /errors\.edgesuite\.net/i,
    evidence: 'an Akamai access-denied page'
  },
  {
    // Vercel's Attack Challenge Mode answers with HTTP 429, an
    // x-vercel-mitigated: challenge header and a JavaScript interstitial
    // titled "Vercel Security Checkpoint" (lesswrong.com, hashicorp.com,
    // bombas.com, R17 2026-09-04). Chromium solves it and reloads; camoufox
    // was left on the interstitial, which then read as a successful scrape.
    vendor: 'vercel',
    title: /^vercel security checkpoint/i,
    markers: /vercel\.link\/security-checkpoint|_vercel\/challenge|x-vercel-challenge-token/i,
    evidence: 'a Vercel Security Checkpoint page'
  }
];

/**
 * @param {{ title?: string, html?: string, text?: string }} page
 * @returns {{ vendor: string, evidence: string } | null}
 */
export function detectChallengePage({ title = '', html = '', text = '' } = {}) {
  const cleanTitle = (title || '').trim();
  const visible = (text || '').replace(/\s+/g, ' ').trim();
  const shortPage = visible.length < SHORT_PAGE_CHARS;
  for (const challenge of CHALLENGES) {
    if (challenge.title && challenge.title.test(cleanTitle)) {
      return { vendor: challenge.vendor, evidence: `title "${cleanTitle}"` };
    }
    if (challenge.definitive && challenge.definitive.test(html)) {
      return { vendor: challenge.vendor, evidence: challenge.evidence };
    }
    if (shortPage && challenge.markers && challenge.markers.test(html)) {
      return { vendor: challenge.vendor, evidence: `${challenge.evidence} on a ${visible.length}-character page` };
    }
  }
  return null;
}

// A document this short with one of these titles is an error placeholder,
// not a page. Real pages with these words in a longer title (a news story
// about an outage) carry far more text than the cap.
const ERROR_TITLE = /^(?:(?:\d{3}\s*[-–—|:]\s*)?(?:error(?: page)?|access denied|forbidden|(?:page )?not found|service unavailable|internal server error|bad gateway|something went wrong|oops!?[^\n]{0,60}))$/i;
export const SOFT_ERROR_MAX_CHARS = 1500;

/**
 * What a fetched document is: the page, a challenge wall, an HTTP error
 * page, an empty shell, or a short error-titled placeholder. The content is
 * for the caller to keep or drop — this only says what it is.
 *
 * The defaults describe the MCP server's stealth path, the original caller:
 * a browser `rendered` the document, `fetcher` names it in the messages,
 * `waitedMs` is the extra render wait it gave an empty document, and the
 * failure result still carries the content (`contentReturned`). A plain
 * fetch passes `rendered: false` (its empty shell or placeholder cannot be
 * waited out — only a browser paints it) and `contentReturned: false` (it
 * drops the document on a failure).
 *
 * @param {{ url?: string, title?: string, text?: string, html?: string, status?: number|null }} scraped
 * @param {{ waitedMs?: number, allowEmpty?: boolean, fetcher?: string, rendered?: boolean, contentReturned?: boolean }} [options]
 * @returns {{ success: boolean, status: number|null, error?: string, blocked?: { vendor: string, evidence: string } }}
 */
export function documentVerdict(scraped, { waitedMs = 0, allowEmpty = false, fetcher = 'the stealth browser', rendered = true, contentReturned = true } = {}) {
  const status = Number.isInteger(scraped?.status) ? scraped.status : null;
  const url = scraped?.url || '';
  const title = String(scraped?.title || '').trim();
  const text = String(scraped?.text || '').trim();

  const challenge = detectChallengePage(scraped || {});
  if (challenge) {
    return {
      success: false,
      status,
      blocked: challenge,
      error: `${challenge.vendor} served a challenge page instead of the content (${challenge.evidence}); ${fetcher} did not pass it.`
    };
  }

  if (status !== null && status >= 400) {
    const why = status === 403
      ? 'A 403 with no challenge vendor on the page is an IP-reputation or WAF block; the site will not serve this network.'
      : status === 404
        ? 'The site says the URL does not exist — check the path.'
        : status === 429
          ? 'The site is rate-limiting this network; wait before retrying.'
          : 'Retry later; the server, not the page, failed.';
    return {
      success: false,
      status,
      error: `HTTP ${status}: ${url} answered with an error page${title ? ` titled "${title}"` : ''}, not the resource${contentReturned ? '; the content returned is that page' : ''}. ${why}`
    };
  }

  if (!title && !text) {
    if (allowEmpty) return { success: true, status };
    const reached = fetcher.charAt(0).toUpperCase() + fetcher.slice(1);
    const bytes = (scraped?.html || '').length;
    return {
      success: false,
      status,
      error: rendered
        ? `${reached} reached ${url} but the document rendered no title and no text` +
          ` after ${waitedMs}ms of extra wait (${bytes} bytes of HTML).` +
          ' A JavaScript-rendered page needs a longer wait_for; an empty document means the server sent nothing to render.'
        : `${reached} reached ${url} but the document has no title and no text (${bytes} bytes of HTML).` +
          ' The page is rendered by JavaScript or the server sent an empty shell; only a browser renders it.'
    };
  }

  if (text.length < SOFT_ERROR_MAX_CHARS && ERROR_TITLE.test(title)) {
    return {
      success: false,
      status,
      error:
        `${url} rendered an error page titled "${title}" (${text.length} characters of text) instead of the resource` +
        (rendered
          ? ' — a soft block or an application error. Retry later, or with a longer wait_for if the site paints content after a placeholder.'
          : ' — a soft block or an application error. Retry later; if the site paints content after a placeholder, only a browser renders it.')
    };
  }

  return { success: true, status };
}
