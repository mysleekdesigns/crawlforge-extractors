# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

The behavioural guidelines in the sibling repos' `CLAUDE.md`
(`crawlforge-website`, `crawlforge-mcp-server`) apply here too: think before
coding, simplest thing that works, surgical changes, verify against the test
suite. This file covers what is specific to this package.

## What this package is

`crawlforge-extractors` is the code **both** CrawlForge surfaces install from
npm — the website (`crawlforge-website`) and the MCP server
(`crawlforge-mcp-server`) each depend on it. A change here reaches production on
two independent deploy paths.

That has one consequence worth stating plainly: **fix things here, not in either
consumer.** A patch applied in one surface fixes half the product and silently
diverges from the other. If a bug is in shared extraction logic, it belongs in
this repo and reaches the surfaces through a release.

## The invariants that make this package auditable

This is a pure library. It has:

- **no network access** — no `fetch`, no HTTP client;
- **no `process.env` reads** — no configuration, no kill switches;
- **no `eval`, `vm`, or `child_process`**;
- **one runtime dependency**, `cheerio`.

Those properties are why a security review of this package is short, and why the
consumers can treat its output as the only thing they need to check. Keep them.
In particular, do not move network-facing code (an SSRF guard, an HTTP client)
into this package because both surfaces need it — that trades a clean audit
story for a little deduplication. Duplicate it in the consumers instead.

Its output is still **untrusted content**: it parses attacker-controlled pages.
URLs it returns are scheme-filtered through `src/urls.js` `safeHref()`; anything
new that extracts a URL from page content goes through there too.

## Branch workflow

Same as `crawlforge-website` and `crawlforge-mcp-server`:

- **`development` is the working branch.** All work happens there, or on a
  short-lived branch off it.
- **`main` is the release branch.** npm publishes come from `main`.
- Ship by merging `development` into `main` with a **merge commit**
  (`--no-ff`), never a fast-forward, then pushing both.

```bash
# work, then:
git checkout development
git commit -m "..."
git push origin development

git checkout main
git merge --no-ff development -m "Merge development: ..."
git push origin main
```

Historically this repo was developed directly on `main`; `development` was added
2026-08-31 to match the other two. If you find yourself committing to `main`,
that is the thing to correct.

## Release

1. Bump `version` in `package.json` (and `package-lock.json` — `npm version
   <v> --no-git-tag-version` does both).
2. `npm test` — `node --test tests/*.test.js`, no network, no fixtures server.
3. Commit on `development`, merge to `main`, tag `v<x.y.z>`, push both + tag.
4. `npm publish` from `main`.
5. **Then bump the dependency in both consumers** (`crawlforge-website` and
   `crawlforge-mcp-server` `package.json` → `^<x.y.z>`, lockfile pinned) and
   release those. A publish here changes nothing in production until they do.

Verify a release **by content, not by version number**: download the published
tarball and grep the file you changed. `npm view <pkg>@<v>` returning a version
proves the manifest, not the contents. Note that npm propagation lags the
publish — the `+ crawlforge-extractors@<v>` line is the success signal; a 404 on
the version for the next minute or two is lag, never a failed publish, so never
re-publish on it.

## Commands

```bash
npm test                # node --test tests/*.test.js
npm pack --dry-run      # confirm what actually ships (`files` excludes tests/)
```

`files` in `package.json` is `index.js`, `index.d.ts`, `src/`, `README.md`,
`LICENSE` — tests and fixtures never ship, which is correct.
