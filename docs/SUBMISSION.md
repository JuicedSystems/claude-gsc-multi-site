# Submission packet

Ready-to-paste copy and answers for every place this plugin is listed or reviewed. Keep it in sync with
`plugin.json`, the README and [PRIVACY.md](../PRIVACY.md) when the plugin changes.

- [Distribution status](#distribution-status)
- [Listing copy](#listing-copy)
- [Anthropic Claude directory](#anthropic-claude-directory)
- [Google OAuth consent screen](#google-oauth-consent-screen)
- [Third-party directories](#third-party-directories)
- [Release checklist](#release-checklist)

## Distribution status

| Channel | Status | Notes |
|---|---|---|
| Own marketplace (`JuicedSystems/claude-gsc-multi-site`) | **Live** | `/plugin marketplace add JuicedSystems/claude-gsc-multi-site` |
| Anthropic Claude directory | **Not eligible yet** | Validation passes 5 of 7 checks. The directory accepts plugins with local (stdio) MCP servers only from Verified organizations. Path: hosted connector version, or Verified status |
| claudemarketplaces.com | Ready to submit | <https://claudemarketplaces.com/submit> |
| claudepluginhub.com | Ready to submit | Indexes public GitHub plugin repos |
| Product Hunt | Optional | Copy below |

## Listing copy

| Field | Value |
|---|---|
| Plugin name (`name`) | `gsc-multi-site` |
| Display name | Search Console Multi-Site Connector |
| Publisher | Juiced Systems |
| Tagline (≤ 60 chars) | Every Google account. Every property. One Claude plugin. |
| Short description (≤ 160 chars) | Connect multiple Google accounts and every Search Console property they can see to Claude, with a required site selector and an all-sites report. |
| Category | SEO / Marketing analytics / Developer tools |
| Keywords | google-search-console, gsc, seo, search-analytics, multi-site, url-inspection, sitemaps, mcp |
| Repository | <https://github.com/JuicedSystems/claude-gsc-multi-site> |
| License | MIT |
| Icon | `.claude-plugin/icon.png` (1024 × 1024 PNG) |
| Banner | `docs/banner.svg` (1200 × 300) |
| Support / contact | dylan@juicedsystems.com |
| Privacy policy | <https://github.com/JuicedSystems/claude-gsc-multi-site/blob/main/PRIVACY.md> |
| Terms | <https://github.com/JuicedSystems/claude-gsc-multi-site/blob/main/TERMS.md> |

**Long description**

> Search Console Multi-Site Connector lets Claude work across all of your Google Search Console
> properties at once, even when they live in different Google accounts. Sign in to each Google account
> once; the plugin discovers every property those accounts can see and merges them into one list.
>
> Every site tool requires Claude to name the property from that list, so it can't query the wrong site
> or invent one. Ask "how are all my sites doing?" and `all_sites_summary` returns clicks, impressions,
> CTR and position for every property with change versus the previous period. Drill into any site with
> full Search Analytics queries, a performance report card, URL Inspection, and sitemap tools.
>
> It runs locally with zero dependencies, uses your own Google OAuth client, connects read-only by
> default, and sends data only to Google and to Claude. Juiced Systems never receives your data.

**Example prompts**

1. "How are all my sites doing this month compared to last month?"
2. "Top non-branded queries for example.com on mobile, last 90 days."
3. "Which pages on example.org lost the most clicks this quarter, and for which queries?"
4. "Is https://example.org/products/widget indexed? What canonical did Google pick?"
5. "Resubmit the sitemap for blog.example.com."

## Anthropic Claude directory

Portal: <https://claude.ai/directory/manage> → **Submit new** → **Plugin bundle** →
Repository `JuicedSystems/claude-gsc-multi-site`, path blank, branch `main`.

### Last validation (commit `317c1d3`, 2026-11-18)

| Result | Finding | Action |
|---|---|---|
| Blocking | Local MCP servers accepted only from Verified organizations | Requires Verified status or a hosted (remote) server |
| Blocking | Files outside the allowed list (`mcp/lib/config.js` …) | Same root cause: server code ships in the plugin |
| Blocking | Config fields outside the allowed list (`mcp/package.json` · `main`) | Same root cause |
| Policy hold | Uses a credential from the user's machine | Follows from the local server |
| Policy hold | Scripts the validator couldn't follow (`mcp/server.js`) | Follows from the local server |
| Warning | No icon | **Fixed** — `.claude-plugin/icon.png` added |
| Note | Local MCP server runs in Claude Code and Cowork, not claude.ai | Expected |

### Answers for the form (when eligible)

**Data handling**

| Question | Answer |
|---|---|
| Does the plugin read or store personal data? | Yes. It reads the user's Google account email and Search Console data (queries, pages, URLs, performance metrics) to answer the user's requests. It stores OAuth refresh tokens, the user's own OAuth client credentials, and the discovered property list locally in `~/.gsc-multi-site/config.json` on the user's machine. Search Console data is not stored. |
| Does it send data to services other than its declared connectors? | Only to Google: `oauth2.googleapis.com` (tokens), `accounts.google.com` (sign-in link), `searchconsole.googleapis.com` (API). No telemetry or third parties. |
| How long does it keep data? | Until the user removes the account (`remove_account`), deletes the config file, or uninstalls. Access tokens live in memory for under an hour. |
| Intended for people under 18? | No. |

**Compliance**

- Contact email: dylan@juicedsystems.com
- Read and accept the four acknowledgements yourself (they bind Juiced Systems): the
  [Anthropic Software Directory Terms](https://support.claude.com/en/articles/13145338-anthropic-software-directory-terms)
  and [Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy).

**Review and submit**

- New versions: **GitHub push webhook** (default).
- Auto-publish passing versions: off for the first release.

## Google OAuth consent screen

Each user creates their own client (see [SETUP.md](SETUP.md)), so these values are for **your** project
and for a future hosted version that would need Google's verification.

| Field | Value |
|---|---|
| App name | Claude GSC (personal) · for a public hosted version: "Search Console Multi-Site by Juiced Systems" |
| User support email | dylan@juicedsystems.com |
| App logo | `.claude-plugin/icon.png` (Google requires 120 × 120; resize when needed) |
| Application home page | <https://github.com/JuicedSystems/claude-gsc-multi-site> |
| Privacy policy | <https://github.com/JuicedSystems/claude-gsc-multi-site/blob/main/PRIVACY.md> |
| Terms of service | <https://github.com/JuicedSystems/claude-gsc-multi-site/blob/main/TERMS.md> |
| Authorized domains | Only needed for verification; GitHub can't be verified as yours, so host the three pages on a domain you own first |
| Scopes | `…/auth/webmasters.readonly`, `…/auth/webmasters` (optional), `openid`, `email` |
| Audience | External, **In production**. Publish stays greyed out until Branding has a home page, privacy policy link and authorized domain on a domain you own |

**Scope justification (if Google asks)**

> `webmasters.readonly`: The app shows a signed-in user their own Search Console properties and search
> performance (clicks, impressions, CTR, position by query, page, country and device) and URL Inspection
> results, inside Claude, at the user's request. `webmasters` (optional, requested only when the user
> opts in): lets the user submit or remove sitemaps for properties they manage. Data is used only to
> fulfil the user's request, stays on the user's machine except for responses shown to the user, and is
> not used for advertising.

## Third-party directories

**claudemarketplaces.com** — <https://claudemarketplaces.com/submit>

- Name: Search Console Multi-Site Connector
- Repository: `https://github.com/JuicedSystems/claude-gsc-multi-site`
- Type: Plugin (marketplace `juiced-systems-gsc`)
- Description: the short description above
- Install: `/plugin marketplace add JuicedSystems/claude-gsc-multi-site` then
  `/plugin install gsc-multi-site@juiced-systems-gsc`

**Product Hunt**

- Name: Search Console Multi-Site for Claude
- Tagline: Every Google account. Every property. One Claude plugin.
- Description: the long description above, first two paragraphs
- Topics: SEO, Developer Tools, Artificial Intelligence, Analytics
- First comment: why you built it (managing several brands across separate Google accounts and
  reconnecting one at a time), what it does, that it's free and open source, and the install command

## Release checklist

1. Bump `version` in `.claude-plugin/plugin.json`, `mcp/package.json` and `SERVER_INFO` in
   `mcp/server.js`.
2. Add a dated entry to [CHANGELOG.md](../CHANGELOG.md).
3. Update [PRIVACY.md](../PRIVACY.md) and the README's data table if any data handling changed.
4. `cd mcp && npm test`.
5. Commit, tag `vX.Y.Z`, push, and create a GitHub release from the changelog entry.
6. Confirm CI is green.
