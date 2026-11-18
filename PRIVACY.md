# Privacy Policy

**Search Console Multi-Site Connector** (the "Plugin")
Published by Juiced Systems · Effective date: November 18, 2026

This policy explains what the Plugin does with your information. The short version: the Plugin runs
entirely on your own computer, talks only to Google, and Juiced Systems never receives any of your data.

## 1. Who we are

The Plugin is open-source software published by Juiced Systems ("we", "us"). Source code:
<https://github.com/JuicedSystems/claude-gsc-multi-site>. Contact: <dylan@juicedsystems.com>.

## 2. How the Plugin works

The Plugin is a local Model Context Protocol (MCP) server. When you use it with Claude Code, Cowork or
Claude Desktop, it runs as a process on your computer. We do not operate any server for it. There is no
Juiced Systems account, backend, database, telemetry or analytics.

## 3. Information the Plugin accesses

When you connect a Google account, the Plugin accesses, through Google's official Search Console API:

| Data | Purpose |
|---|---|
| The list of Search Console properties your account can access, and your permission level on each | To show which sites you can query |
| Search performance data: queries, pages, countries, devices, search appearance, clicks, impressions, click-through rate and average position | To answer your questions about search performance |
| URL Inspection results for URLs you ask about | To report indexing status |
| Sitemap information, and (only if you grant full access) sitemap submissions and removals you request | To manage sitemaps on your instruction |
| Your Google account email address (from Google's sign-in response) | To label the connected account |

The Plugin requests these Google OAuth scopes:

* `https://www.googleapis.com/auth/webmasters.readonly` (default), or
  `https://www.googleapis.com/auth/webmasters` (only if you choose full access)
* `openid` and `email` (to identify which account you connected)

## 4. Where information is stored

Stored **only on your computer**, in `~/.gsc-multi-site/config.json` (Windows:
`C:\Users\<you>\.gsc-multi-site\config.json`):

* your OAuth client ID and client secret (from your own Google Cloud project)
* a Google refresh token for each account you connect
* file paths to any service-account keys you add (the keys themselves stay where you put them)
* the list of properties discovered, plus any aliases or labels you set

Short-lived Google access tokens are kept in memory only and expire within an hour. Search Console data
is not written to disk by the Plugin.

## 5. Where information is sent

The Plugin sends data only to:

* **Google** (`oauth2.googleapis.com`, `accounts.google.com`, `searchconsole.googleapis.com`) to sign
  you in, obtain access tokens, and call the Search Console API
* **The Claude application you are using**, as tool results, so Claude can answer your request. That
  data is then handled under the terms and privacy policy of the Claude product you use
  (see <https://www.anthropic.com/legal/privacy>)

Nothing is sent to Juiced Systems or any other third party. We do not sell, rent, share or use your
data for advertising, profiling or model training.

## 6. Google API Services User Data Policy

The Plugin's use and transfer of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements. Google user data is used only to provide the features you ask
for, is not transferred except as described in section 5, and is not used for advertising or read by
humans other than you.

## 7. Retention and deletion

Data stays on your computer until you remove it. To delete it:

1. Ask Claude to "remove my Google account from the Search Console connector" (the `remove_account`
   tool deletes that account's refresh token and site list), or delete `~/.gsc-multi-site/config.json`.
2. Revoke the app's access at <https://myaccount.google.com/permissions>.
3. Uninstall the Plugin from Claude.

## 8. Security

The configuration file is written with owner-only permissions on macOS and Linux. The sign-in listener
binds to `127.0.0.1` only, uses PKCE and a random state value, and closes after one sign-in or ten
minutes. Tools never return secrets in their output. See [SECURITY.md](SECURITY.md) to report a
vulnerability.

## 9. Children

The Plugin is a business tool and is not directed to anyone under 18.

## 10. Changes

We'll update this policy in the repository when the Plugin's data handling changes, and note the change
in [CHANGELOG.md](CHANGELOG.md). The effective date above shows the latest version.

## 11. Contact

Questions: <dylan@juicedsystems.com>
