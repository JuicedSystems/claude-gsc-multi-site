# Security Policy

## Reporting a vulnerability

Please report security issues privately to **dylan@juicedsystems.com** with the subject
`[security] claude-gsc-multi-site`. Please don't open a public issue for a vulnerability.

Include the version, your OS and Node version, steps to reproduce, and the impact you see. You'll get an
acknowledgement within 3 business days and a fix or mitigation plan within 14 days for confirmed issues.

## Supported versions

| Version | Supported |
|---|---|
| 1.x | Yes |

## Security model

| Area | What the Plugin does |
|---|---|
| Credentials at rest | Stored only in `~/.gsc-multi-site/config.json` on your machine; written `0600` on macOS/Linux. On Windows it sits in your user profile, protected by your account's NTFS permissions |
| Credentials in output | No tool returns a client secret, refresh token, access token or private key |
| Sign-in | OAuth 2.0 installed-app flow with PKCE (S256) and a random `state`; the redirect listener binds to `127.0.0.1` on a random port, accepts one callback, and closes after 10 minutes |
| Least privilege | Read-only scope (`webmasters.readonly`) by default; full scope only when you choose it per account. Write tools check the account's access before calling Google |
| Wrong-target protection | Every site-scoped tool requires a `site` from an enum of your discovered properties; URL Inspection and sitemap tools refuse URLs outside the chosen property |
| Supply chain | Zero runtime dependencies: only Node.js built-ins (`fetch`, `crypto`, `http`, `fs`). Nothing is downloaded at install or run time |
| Network | Calls only Google endpoints (see the README's "Data & network access") |

## If a credential leaks

1. Ask Claude to run `remove_account` for the affected account (or delete the config file).
2. Revoke access at <https://myaccount.google.com/permissions>.
3. If the OAuth client secret leaked, reset it in Google Cloud Console → Google Auth Platform → Clients,
   then reconnect your accounts.
4. If a service-account key leaked, delete that key in Google Cloud Console → IAM → Service Accounts.
