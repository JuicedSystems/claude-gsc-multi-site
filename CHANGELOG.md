# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-18

### Added

- Zero-dependency stdio MCP server connecting any number of Google accounts to Search Console.
- Account types: OAuth sign-in (installed-app flow with PKCE and a loopback listener) and service
  accounts (locally signed JWT).
- Automatic property discovery across accounts, de-duplicated to the account with the highest
  permission, with editable aliases, labels and hidden flags that survive refreshes.
- Required `site` enum on every site-scoped tool, updated live with `notifications/tools/list_changed`.
- Tools: `list_sites`, `list_accounts`, `connect_google_account`, `finish_google_account`,
  `add_service_account`, `refresh_sites`, `update_site`, `remove_account`, `all_sites_summary`,
  `search_analytics`, `performance_summary`, `inspect_url`, `list_sitemaps`, `submit_sitemap`,
  `delete_sitemap`.
- Commands: `/gsc-setup`, `/gsc-sites`, `/gsc-report`.
- Read-only access by default; full access opt-in per account.
- Offline smoke test and end-to-end test against a local mock of Google; CI on Node 18, 20 and 22.
- Documentation: README, setup guide, privacy policy, terms, security policy, submission packet.

[1.0.0]: https://github.com/JuicedSystems/claude-gsc-multi-site/releases/tag/v1.0.0
