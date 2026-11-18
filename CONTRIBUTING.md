# Contributing

Thanks for helping improve the Search Console Multi-Site Connector.

## Ground rules

- **Keep it zero-dependency.** Node.js built-ins only. No `package-lock.json`, no `node_modules`.
- **Keep site tools site-scoped.** Any new tool that reads or writes a property must take the shared
  `site` enum as a required argument.
- **Never return secrets.** Tool output must not include client secrets, refresh or access tokens, or
  private keys.
- **Disclose network calls.** If a change adds an endpoint, add it to the README's "Data & network
  access" table and to [PRIVACY.md](PRIVACY.md).
- **Writes are opt-in.** New write tools must check `account.access === "full"` before calling Google.

## Development

```bash
cd mcp
npm test   # syntax check + offline smoke test + end-to-end test against a local mock of Google
```

The mock lives in `mcp/test/e2e.mjs`. Add a case there for any new tool. To point the server at a mock
by hand, set `GSC_TOKEN_URL`, `GSC_AUTH_URL` and `GSC_API_BASE`.

## Pull requests

1. Fork and branch from `main`.
2. Run `npm test` in `mcp/`.
3. Update [CHANGELOG.md](CHANGELOG.md) under an "Unreleased" heading and, for user-facing changes, the
   README.
4. Bump `version` in `.claude-plugin/plugin.json`, `mcp/package.json` and `SERVER_INFO` in
   `mcp/server.js` for releases.

## Reporting bugs

Open an issue with the tool name, the arguments you passed (with any secrets removed), and the exact
error text the tool returned. For security issues, see [SECURITY.md](SECURITY.md).
