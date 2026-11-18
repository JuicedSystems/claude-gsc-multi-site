// End-to-end test against a local mock of Google's token endpoint and the
// Search Console API. Exercises: refresh-token auth, service-account JWT auth
// (signature verified), site discovery + merge, live enum update, search
// analytics, all-sites summary, URL inspection, sitemap write guard, the OAuth
// loopback sign-in, renaming and removing. No real network.
import { createServer } from "node:http";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startServer } from "./client.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const dir = mkdtempSync(join(tmpdir(), "gsc-e2e-"));

// ---- mock Google ----
const SITES = {
  "tok-A": [
    { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
    { siteUrl: "https://www.example.net/", permissionLevel: "siteFullUser" },
  ],
  "tok-SA": [
    { siteUrl: "sc-domain:example.com", permissionLevel: "siteRestrictedUser" },
    { siteUrl: "sc-domain:example.org", permissionLevel: "siteFullUser" },
    { siteUrl: "sc-domain:unverified.example.com", permissionLevel: "siteUnverifiedUser" },
  ],
  "tok-NEW": [{ siteUrl: "sc-domain:blog.example.com", permissionLevel: "siteOwner" }],
};
const seen = { saBodies: [], jwtVerified: false, inspect: null };

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

const mock = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const url = new URL(req.url, "http://x");
  const json = (code, obj) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(obj));

  if (url.pathname === "/token") {
    const p = new URLSearchParams(body);
    const g = p.get("grant_type");
    if (g === "refresh_token") {
      if (p.get("refresh_token") === "rt-A") return json(200, { access_token: "tok-A", expires_in: 3599 });
      if (p.get("refresh_token") === "rt-NEW") return json(200, { access_token: "tok-NEW", expires_in: 3599 });
      return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
    }
    if (g === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
      const [h, c, sig] = p.get("assertion").split(".");
      const v = createVerify("RSA-SHA256");
      v.update(`${h}.${c}`);
      const okSig = v.verify(publicKey, Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
      const claims = JSON.parse(Buffer.from(c, "base64").toString());
      if (!okSig || claims.iss !== "gsc-bot@proj.iam.gserviceaccount.com") return json(400, { error: "invalid_grant" });
      seen.jwtVerified = true;
      seen.saScope = claims.scope;
      return json(200, { access_token: "tok-SA", expires_in: 3599 });
    }
    if (g === "authorization_code") {
      assert.equal(p.get("code"), "the-code");
      assert.ok(p.get("code_verifier")?.length >= 43, "PKCE verifier missing");
      assert.ok(p.get("redirect_uri").startsWith("http://127.0.0.1:"));
      return json(200, {
        access_token: "tok-NEW",
        refresh_token: "rt-NEW",
        expires_in: 3599,
        id_token: `${b64urlJson({ alg: "none" })}.${b64urlJson({ email: "Owner@Example.com" })}.x`,
      });
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!SITES[token]) return json(401, { error: { message: "Invalid Credentials" } });

  if (req.method === "GET" && url.pathname === "/webmasters/v3/sites") return json(200, { siteEntry: SITES[token] });

  const m = url.pathname.match(/^\/webmasters\/v3\/sites\/([^/]+)\/(searchAnalytics\/query|sitemaps)(?:\/(.+))?$/);
  if (m) {
    const siteUrl = decodeURIComponent(m[1]);
    if (!SITES[token].some((s) => s.siteUrl === siteUrl)) return json(403, { error: { message: "User does not have sufficient permission for site" } });
    if (m[2] === "searchAnalytics/query") {
      const b = JSON.parse(body);
      seen.saBodies.push({ siteUrl, ...b });
      const scale = siteUrl.includes("example.org") ? 3 : 1;
      const older = b.startDate < "2026-01-01" ? 0.5 : 1; // makes "previous period" differ
      if (!b.dimensions?.length) {
        return json(200, { rows: [{ clicks: 100 * scale * older, impressions: 4000 * scale, ctr: 0.025 * older, position: 12.34 }], responseAggregationType: "byProperty" });
      }
      return json(200, {
        rows: [
          { keys: b.dimensions.map((d) => `${d}-one`), clicks: 40, impressions: 900, ctr: 0.0444, position: 3.21 },
          { keys: b.dimensions.map((d) => `${d}-two`), clicks: 20, impressions: 1200, ctr: 0.0167, position: 8.9 },
        ],
        responseAggregationType: "byProperty",
      });
    }
    if (m[2] === "sitemaps" && req.method === "GET") return json(200, { sitemap: [{ path: "https://example.org/sitemap.xml", errors: "0" }] });
    if (m[2] === "sitemaps" && req.method === "PUT") return json(200, {});
  }
  if (req.method === "POST" && url.pathname === "/v1/urlInspection/index:inspect") {
    seen.inspect = JSON.parse(body);
    return json(200, { inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed" } } });
  }
  json(404, { error: { message: `mock: no route ${req.method} ${url.pathname}` } });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${mock.address().port}`;

// ---- config ----
const keyFile = join(dir, "sa-key.json");
writeFileSync(
  keyFile,
  JSON.stringify({
    type: "service_account",
    client_email: "gsc-bot@proj.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    private_key_id: "k1",
    token_uri: `${base}/token`,
  }),
);
const cfg = join(dir, "config.json");
writeFileSync(
  cfg,
  JSON.stringify({
    oauthClient: { clientId: "abc.apps.googleusercontent.com", clientSecret: "GOCSPX-secret" },
    accounts: [{ name: "main", type: "oauth", email: "you@example.com", refreshToken: "rt-A" }],
  }),
);

const s = startServer({ GSC_MULTI_SITE_CONFIG: cfg, GSC_TOKEN_URL: `${base}/token`, GSC_API_BASE: base });
const timer = setTimeout(() => {
  console.error("timeout\n", s.stderr.join(""));
  process.exit(1);
}, 20000);
await s.init();

// 1. discover sites for the OAuth account
let r = await s.call("refresh_sites");
assert.ok(!r.isError, r.text);
assert.deepEqual(r.json.added.sort(), ["example.com", "www.example.net"].sort());

// 2. add a service account: JWT is signed + verified, sites merged, unverified skipped
r = await s.call("add_service_account", { name: "client-sa", keyFile });
assert.ok(!r.isError, r.text);
assert.ok(seen.jwtVerified, "JWT signature not verified by mock");
assert.equal(seen.saScope, "https://www.googleapis.com/auth/webmasters.readonly");
assert.deepEqual(r.json.added, ["example.org"]);
assert.equal(r.json.serviceAccountEmail, "gsc-bot@proj.iam.gserviceaccount.com");

r = await s.call("list_sites");
const byAlias = Object.fromEntries(r.json.sites.map((x) => [x.site, x]));
assert.deepEqual(Object.keys(byAlias).sort(), ["example.org", "example.com", "www.example.net"].sort());
assert.equal(byAlias["example.com"].account, "main", "owner account should win");
assert.deepEqual(byAlias["example.com"].alsoVisibleTo, ["client-sa"]);
assert.ok(!r.text.includes("rt-A") && !r.text.includes("PRIVATE KEY"), "secret leaked");

// 3. enum updated live + list_changed notification sent
assert.ok(s.notifications.some((n) => n.method === "notifications/tools/list_changed"));
const tl = await s.request("tools/list");
const sa = tl.result.tools.find((t) => t.name === "search_analytics");
assert.deepEqual([...sa.inputSchema.properties.site.enum].sort(), ["example.org", "example.com", "www.example.net"].sort());

// 4. search analytics with filters
r = await s.call("search_analytics", {
  site: "example.org",
  startDate: "2026-10-01",
  endDate: "2026-10-28",
  dimensions: ["query"],
  filters: [{ dimension: "query", operator: "notContains", expression: "example brand" }],
  rowLimit: 50,
});
assert.ok(!r.isError, r.text);
assert.equal(r.json.rows[0].query, "query-one");
assert.equal(r.json.rows[0].ctr, 4.44);
const sent = seen.saBodies.at(-1);
assert.equal(sent.siteUrl, "sc-domain:example.org");
assert.deepEqual(sent.dimensionFilterGroups, [{ groupType: "and", filters: [{ dimension: "query", operator: "notContains", expression: "example brand" }] }]);
assert.equal(sent.rowLimit, 50);
assert.equal(r.json.window.days, 28);

// 5. all sites in one call, with period comparison
r = await s.call("all_sites_summary", { endDate: "2026-01-14", days: 14 });
assert.ok(!r.isError, r.text);
assert.equal(r.json.sites.length, 3);
assert.equal(r.json.sites[0].site, "example.org", "sorted by clicks");
assert.equal(r.json.previousWindow.endDate, "2025-12-31");
assert.equal(r.json.sites[0].change.clicks, 100); // 300 vs 150
assert.equal(r.json.totals.clicks, 500);
// the SA-only site went through the SA token; owner site through the OAuth token (else mock 403s)
assert.ok(r.json.sites.every((x) => !x.error), JSON.stringify(r.json.sites));

// 6. performance summary
r = await s.call("performance_summary", { site: "example.com", top: 5 });
assert.ok(!r.isError, r.text);
assert.equal(r.json.topQueries.length, 2);
assert.equal(r.json.topPages[0].page, "page-one");
assert.ok(r.json.window.endDate < new Date().toISOString().slice(0, 10));

// 7. URL inspection: wrong property is caught and redirected
r = await s.call("inspect_url", { site: "example.com", url: "https://example.org/products/widget" });
assert.ok(r.isError && /belongs to site "example.org"/.test(r.text), r.text);
r = await s.call("inspect_url", { site: "example.com", url: "https://www.example.com/products" });
assert.ok(!r.isError, r.text);
assert.equal(seen.inspect.siteUrl, "sc-domain:example.com");
assert.equal(r.json.indexStatusResult.verdict, "PASS");

// 8. sitemaps: read works, write blocked for read-only accounts
r = await s.call("list_sitemaps", { site: "example.org" });
assert.equal(r.json.sitemaps.length, 1);
r = await s.call("submit_sitemap", { site: "example.org", sitemapUrl: "https://example.org/sitemap.xml" });
assert.ok(r.isError && /read-only/.test(r.text));

// 9. OAuth loopback sign-in for a second Google account
r = await s.call("connect_google_account", { access: "full" });
assert.ok(!r.isError, r.text);
const auth = new URL(r.json.authUrl);
assert.equal(auth.searchParams.get("access_type"), "offline");
assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
assert.ok(auth.searchParams.get("scope").includes("auth/webmasters "), "full scope requested");
const redirect = `${auth.searchParams.get("redirect_uri")}/?state=${auth.searchParams.get("state")}&code=the-code`;
const page = await fetch(redirect).then((x) => x.text());
assert.ok(page.includes("Connected to Claude"), page);
r = await s.call("list_accounts");
const newAcct = r.json.accounts.find((a) => a.email === "Owner@Example.com");
assert.ok(newAcct, JSON.stringify(r.json));
assert.equal(newAcct.name, "owner-example.com");
assert.equal(newAcct.access, "full");
assert.deepEqual(newAcct.sites, ["blog.example.com"]);
assert.equal(r.json.signIns[0].status, "connected");

// full-access account can write
r = await s.call("submit_sitemap", { site: "blog.example.com", sitemapUrl: "https://blog.example.com/sitemap.xml" });
assert.ok(!r.isError, r.text);
assert.equal(r.json.submitted, "https://blog.example.com/sitemap.xml");

// 10. rename + hide, then remove an account
r = await s.call("update_site", { site: "www.example.net", alias: "example-net", label: "Example Net" });
assert.ok(!r.isError, r.text);
r = await s.call("update_site", { site: "example.org", hidden: true });
r = await s.call("list_sites");
assert.deepEqual(r.json.sites.map((x) => x.site).sort(), ["example-net", "example.com", "blog.example.com"].sort());
// alias survives a refresh
await s.call("refresh_sites");
r = await s.call("list_sites");
assert.ok(r.json.sites.some((x) => x.site === "example-net" && x.label === "Example Net"));

r = await s.call("remove_account", { name: "main" });
assert.deepEqual(r.json.removedSites, ["example-net"]);
r = await s.call("list_sites");
const pp = r.json.sites.find((x) => x.site === "example.com");
assert.equal(pp.account, "client-sa", "shared site should move to the remaining account");

const onDisk = JSON.parse(readFileSync(cfg, "utf8"));
assert.ok(!onDisk.accounts.some((a) => a.name === "main"));

console.log("ok e2e: auth (refresh + JWT + loopback), discovery/merge, analytics, all-sites, inspection, sitemaps, rename/remove");
clearTimeout(timer);
s.stop();
mock.close();
