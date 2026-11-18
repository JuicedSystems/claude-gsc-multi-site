// Smoke test: offline. Starts the server with a throwaway config and checks the
// handshake, the tool list, and the per-tool `site` guardrail.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startServer } from "./client.mjs";

const dir = mkdtempSync(join(tmpdir(), "gsc-smoke-"));
const cfg = join(dir, "config.json");
writeFileSync(
  cfg,
  JSON.stringify({
    oauthClient: { clientId: "x.apps.googleusercontent.com", clientSecret: "GOCSPX-test" },
    accounts: [{ name: "main", type: "oauth", email: "me@example.com", refreshToken: "1//test" }],
    sites: [
      { alias: "alpha.com", siteUrl: "sc-domain:alpha.com", account: "main", permissionLevel: "siteOwner" },
      { alias: "www.beta.com", siteUrl: "https://www.beta.com/", account: "main", permissionLevel: "siteFullUser" },
      { alias: "hidden.com", siteUrl: "sc-domain:hidden.com", account: "main", permissionLevel: "siteOwner", hidden: true },
    ],
  }),
);

const s = startServer({ GSC_MULTI_SITE_CONFIG: cfg });
const timer = setTimeout(() => {
  console.error("timeout", s.stderr.join(""));
  s.stop();
  process.exit(1);
}, 10000);

const init = await s.init();
assert.equal(init.result.serverInfo.name, "gsc-multi-site");
assert.equal(init.result.capabilities.tools.listChanged, true);

const { result } = await s.request("tools/list");
const names = result.tools.map((t) => t.name);
const SETUP = new Set([
  "list_sites", "list_accounts", "connect_google_account", "finish_google_account",
  "add_service_account", "refresh_sites", "update_site", "remove_account", "all_sites_summary",
]);
const SITE = ["search_analytics", "performance_summary", "inspect_url", "list_sitemaps", "submit_sitemap", "delete_sitemap"];
for (const n of [...SETUP, ...SITE]) assert.ok(names.includes(n), `missing tool ${n}`);

for (const t of result.tools.filter((t) => !SETUP.has(t.name))) {
  assert.ok(t.inputSchema.required?.includes("site"), `${t.name}: site must be required`);
  assert.deepEqual([...t.inputSchema.properties.site.enum].sort(), ["alpha.com", "www.beta.com"], `${t.name}: site enum`);
}
const all = result.tools.find((t) => t.name === "all_sites_summary");
assert.deepEqual([...all.inputSchema.properties.sites.items.enum].sort(), ["alpha.com", "www.beta.com"]);

// Unknown site is refused before any network call.
const bad = await s.call("search_analytics", { site: "nope.com" });
assert.ok(bad.isError && /Unknown site "nope.com"/.test(bad.text));

// list_sites never leaks secrets.
const ls = await s.call("list_sites");
assert.equal(ls.json.siteCount, 2);
assert.ok(!/1\/\/test|GOCSPX/.test(ls.text), "secrets leaked");

console.log(`ok smoke: ${names.length} tools, site guardrail on ${SITE.length}`);
clearTimeout(timer);
s.stop();
