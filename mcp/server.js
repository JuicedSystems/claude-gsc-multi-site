#!/usr/bin/env node
/**
 * Google Search Console Multi-Site MCP server (zero-dependency).
 *
 * Connect any number of Google accounts (OAuth sign-in or service-account keys).
 * The server discovers every Search Console property those accounts can see and
 * exposes them through ONE connector. Every site-scoped tool takes a REQUIRED
 * `site` argument whose JSON-schema enum is the list of discovered properties,
 * so Claude must name the property and can't invent one. all_sites_summary
 * pulls every property at once.
 *
 * Speaks the MCP stdio transport (newline-delimited JSON-RPC 2.0) directly, so
 * there's no npm install and no node_modules.
 */
import {
  loadConfig,
  readRawConfig,
  writeRawConfig,
  resolveConfigPath,
  mergeSites,
  ALIAS_RE,
  ACCOUNT_RE,
} from "./lib/config.js";
import {
  api,
  enc,
  listSitesFor,
  startOAuthFlow,
  exchangeCode,
  oauthFlows,
  findFlow,
  loadServiceAccountKey,
  clearToken,
  GoogleError,
} from "./lib/google.js";

const SERVER_INFO = { name: "gsc-multi-site", version: "1.0.0" };
const SUPPORTED_PROTOCOL = "2025-06-18";

let config = loadConfig();
let siteNames = [...config.sites.keys()];
let initialized = false;

function reloadConfig() {
  config = loadConfig();
  siteNames = [...config.sites.keys()];
  applySiteProp();
  if (initialized) notifyToolsChanged();
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function fail(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function requireSite(alias) {
  const site = config.sites.get(alias);
  if (!site) {
    const list = siteNames.length ? siteNames.join(", ") : "(none yet)";
    throw new GoogleError(`Unknown site "${alias}". Connected sites: ${list}. Use list_sites, or refresh_sites if it's new.`);
  }
  const account = config.accounts.get(site.account);
  if (!account) throw new GoogleError(`Site "${alias}" belongs to account "${site.account}", which isn't configured.`);
  return { site, account };
}

// Shared enum fragment referenced by every site-scoped tool. Mutated in place by
// applySiteProp(); clients refetch after notifications/tools/list_changed.
const siteProp = { type: "string" };
function applySiteProp() {
  if (siteNames.length) {
    siteProp.enum = siteNames;
    siteProp.description =
      "REQUIRED. Which Search Console property to use. Must be exactly one of: " + siteNames.join(", ") + ".";
  } else {
    delete siteProp.enum;
    siteProp.description = "Site alias (none connected yet — run connect_google_account or add_service_account first).";
  }
}
applySiteProp();

function schema(properties, required = []) {
  return { type: "object", properties, required };
}

// --- dates (Search Console reports in Pacific Time) ---

const ptFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function todayPT() {
  return ptFormatter.format(new Date());
}
function addDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function checkDate(v, label) {
  if (v && !DATE_RE.test(v)) throw new GoogleError(`${label} must be YYYY-MM-DD (got "${v}").`);
}
/** Resolve a window: explicit start/end, or `days` ending `endDate` (default: 3 days ago, PT). */
function resolveWindow({ startDate, endDate, days }) {
  checkDate(startDate, "startDate");
  checkDate(endDate, "endDate");
  const end = endDate || addDays(todayPT(), -3);
  const n = clampInt(days, 28, 1, 480);
  const start = startDate || addDays(end, -(n - 1));
  if (start > end) throw new GoogleError(`startDate (${start}) is after endDate (${end}).`);
  const span = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  return { startDate: start, endDate: end, days: span };
}
function previousWindow(w) {
  const end = addDays(w.startDate, -1);
  return { startDate: addDays(end, -(w.days - 1)), endDate: end, days: w.days };
}

function round(n, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
function metrics(row) {
  if (!row) return { clicks: 0, impressions: 0, ctr: 0, position: null };
  return {
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: round((row.ctr ?? 0) * 100, 2), // percent
    position: row.position != null ? round(row.position, 1) : null,
  };
}
function pctChange(now, before) {
  if (!before) return now ? null : 0;
  return round(((now - before) / before) * 100, 1);
}
function delta(cur, prev) {
  return {
    clicks: pctChange(cur.clicks, prev.clicks),
    impressions: pctChange(cur.impressions, prev.impressions),
    ctrPoints: round(cur.ctr - prev.ctr, 2),
    position: cur.position != null && prev.position != null ? round(cur.position - prev.position, 1) : null,
  };
}

const SEARCH_TYPES = ["web", "image", "video", "news", "discover", "googleNews"];
const DIMENSIONS = ["date", "hour", "query", "page", "country", "device", "searchAppearance"];
const OPERATORS = ["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"];

/** Run a searchAnalytics.query for a site and return rows keyed by dimension name. */
async function querySA(site, account, body) {
  const data = await api(account, "POST", `/webmasters/v3/sites/${enc(site.siteUrl)}/searchAnalytics/query`, body);
  const dims = body.dimensions || [];
  const rows = (data.rows || []).map((r) => {
    const o = {};
    dims.forEach((d, i) => (o[d] = r.keys?.[i]));
    return { ...o, ...metrics(r) };
  });
  return { rows, responseAggregationType: data.responseAggregationType };
}

async function totals(site, account, w, type, dataState) {
  const { rows } = await querySA(site, account, {
    startDate: w.startDate,
    endDate: w.endDate,
    type: type || "web",
    ...(dataState ? { dataState } : {}),
  });
  return rows[0] ? (({ clicks, impressions, ctr, position }) => ({ clicks, impressions, ctr, position }))(rows[0]) : metrics(null);
}

/** Run async tasks with a small concurrency limit. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Is `url` inside the property? */
function covers(siteUrl, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (siteUrl.startsWith("sc-domain:")) {
    const dom = siteUrl.slice(10).toLowerCase();
    const host = u.hostname.toLowerCase();
    return host === dom || host.endsWith("." + dom);
  }
  return url.toLowerCase().startsWith(siteUrl.toLowerCase());
}

function accountSummary(a) {
  const sites = [...config.sites.values()].filter((s) => s.account === a.name).map((s) => s.alias);
  return { name: a.name, type: a.type, email: a.email || undefined, access: a.access, siteCount: sites.length, sites };
}

function accountNameFromEmail(email) {
  return (email || "google-account").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Save an account into the raw config, discover its properties, merge them into
 * `sites`, write, and reload. Returns { name, siteCount, added, removed }.
 */
async function saveAccountAndDiscover(entry, liveAccount) {
  const raw = readRawConfig(resolveConfigPath());
  const idx = raw.accounts.findIndex((a) => a.name === entry.name);
  if (idx >= 0) raw.accounts[idx] = entry;
  else raw.accounts.push(entry);

  clearToken(entry.name);
  const found = await listSitesFor(liveAccount);
  const merged = mergeSites(raw.sites, new Map([[entry.name, found]]));
  raw.sites = merged.sites;
  writeRawConfig(raw, resolveConfigPath());
  reloadConfig();
  const siteCount = [...config.sites.values()].filter((s) => s.account === entry.name).length;
  return { name: entry.name, siteCount, added: merged.added, removed: merged.removed };
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const windowProps = {
  startDate: { type: "string", description: "YYYY-MM-DD (Pacific Time). Overrides `days`." },
  endDate: { type: "string", description: "YYYY-MM-DD (Pacific Time). Default: 3 days ago, since Search Console data lags ~2-3 days." },
  days: { type: "integer", description: "Window length ending at endDate when startDate is omitted (default 28, max 480 ≈ 16 months of history)." },
};

const tools = [
  // ---------------- setup / discovery (no site argument) ----------------
  {
    name: "list_sites",
    description:
      "List every Search Console property this connector can reach, across all connected Google " +
      "accounts: alias (the value to pass as `site`), the real siteUrl, the account it's read through, " +
      "and permission level. Call this first. Never returns credentials.",
    inputSchema: schema({}),
    handler: async () =>
      ok({
        configPath: config.path,
        siteCount: siteNames.length,
        sites: siteNames.map((n) => {
          const s = config.sites.get(n);
          return {
            site: s.alias,
            siteUrl: s.siteUrl,
            type: s.siteUrl.startsWith("sc-domain:") ? "domain" : "url-prefix",
            ...(s.label ? { label: s.label } : {}),
            account: s.account,
            permission: s.permissionLevel,
            ...(s.alsoIn?.length ? { alsoVisibleTo: s.alsoIn } : {}),
          };
        }),
        accounts: [...config.accounts.keys()],
        ...(config.error ? { error: config.error } : {}),
        ...(config.warning ? { warning: config.warning } : {}),
      }),
  },

  {
    name: "list_accounts",
    description:
      "List connected Google accounts (name, type, email, read-only vs full access, which sites each " +
      "provides) plus the status of any sign-in started with connect_google_account. Never returns secrets.",
    inputSchema: schema({}),
    handler: async () =>
      ok({
        configPath: config.path,
        oauthClientConfigured: Boolean(config.oauthClient),
        accounts: [...config.accounts.values()].map(accountSummary),
        signIns: oauthFlows()
          .slice(0, 5)
          .map((f) => ({
            status: f.status,
            access: f.access,
            ...(f.result ? { account: f.result.name, siteCount: f.result.siteCount } : {}),
            ...(f.error ? { error: f.error } : {}),
          })),
        ...(config.error ? { error: config.error } : {}),
      }),
  },

  {
    name: "connect_google_account",
    description:
      "Start connecting a Google account by signing in (OAuth). Returns a Google sign-in URL for the " +
      "user to open on THIS computer. After they approve, the account and every Search Console property " +
      "it can see are saved automatically and become valid `site` values — no restart. Repeat for each " +
      "Google account. Needs an OAuth client (Google Cloud > APIs & Services > Credentials > 'Desktop " +
      "app'); pass clientId + clientSecret the first time and they're saved for later sign-ins. " +
      "Use access 'full' only if you want sitemap submit/delete.",
    inputSchema: schema({
      access: { type: "string", enum: ["readonly", "full"], description: "readonly (default) or full (allows sitemap submit/delete)." },
      name: { type: "string", description: "Optional account name. Default: derived from the Google email." },
      clientId: { type: "string", description: "OAuth Desktop-app client ID (first time only; saved)." },
      clientSecret: { type: "string", description: "OAuth Desktop-app client secret, GOCSPX-... (first time only; saved)." },
    }),
    handler: async ({ access, name, clientId, clientSecret }) => {
      access = access === "full" ? "full" : "readonly";
      if (name && !ACCOUNT_RE.test(name)) return fail(`Invalid account name "${name}". Use letters, numbers, dot, dash, underscore.`);
      clientId = String(clientId || "").trim();
      clientSecret = String(clientSecret || "").trim();

      if (clientId || clientSecret) {
        if (!clientId || !clientSecret) return fail("Pass both clientId and clientSecret (or neither, to use the saved client).");
        if (!/\.apps\.googleusercontent\.com$/.test(clientId)) {
          return fail("That clientId doesn't look like a Google OAuth client ID (it should end in .apps.googleusercontent.com).");
        }
        const raw = readRawConfig(resolveConfigPath());
        raw.oauthClient = { clientId, clientSecret };
        writeRawConfig(raw, resolveConfigPath());
        reloadConfig();
      }
      const client = config.oauthClient || readRawConfig(resolveConfigPath()).oauthClient;
      if (!client?.clientId || !client?.clientSecret) {
        return fail(
          "No OAuth client saved yet. Create one in Google Cloud Console > APIs & Services > Credentials > " +
            "Create credentials > OAuth client ID > Application type 'Desktop app', then call this again with " +
            "clientId and clientSecret. (Also enable the 'Google Search Console API' in that project.)",
        );
      }

      const flow = await startOAuthFlow({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        access,
        onComplete: async ({ refreshToken, email }) => {
          const raw = readRawConfig(resolveConfigPath());
          const existing = raw.accounts.find((a) => a.type === "oauth" && email && a.email === email);
          const acctName = name || existing?.name || accountNameFromEmail(email);
          const entry = { name: acctName, type: "oauth", email, access, refreshToken };
          return saveAccountAndDiscover(entry, { ...entry, clientId: client.clientId, clientSecret: client.clientSecret });
        },
      });

      return ok({
        authUrl: flow.authUrl,
        access,
        instructions:
          "Open authUrl in a browser on this computer and choose the Google account. If Google warns the " +
          "app isn't verified, click Advanced > Go to (your app) — it's your own client. When the tab says " +
          "'Connected', call list_sites. If the redirect page fails to load (browser on another machine), " +
          "copy the full address from the browser bar and call finish_google_account with it. The link " +
          "expires in 10 minutes.",
      });
    },
  },

  {
    name: "finish_google_account",
    description:
      "Fallback for connect_google_account: if the browser couldn't reach the local redirect page, paste " +
      "the full URL from the browser's address bar (it starts with http://127.0.0.1 and contains code=...).",
    inputSchema: schema({ redirectUrl: { type: "string", description: "The full redirected URL from the address bar." } }, ["redirectUrl"]),
    handler: async ({ redirectUrl }) => {
      let u;
      try {
        u = new URL(String(redirectUrl).trim());
      } catch {
        return fail("That isn't a URL. Copy the whole address (http://127.0.0.1:.../?state=...&code=...).");
      }
      const flow = findFlow(u.toString());
      if (!flow) return fail("No matching sign-in in progress (it may have expired). Start again with connect_google_account.");
      if (flow.status === "connected") return ok({ alreadyConnected: true, ...flow.result });
      const code = u.searchParams.get("code");
      if (!code) return fail(`The URL has no code. Google said: ${u.searchParams.get("error") || "nothing"}.`);
      const tokens = await exchangeCode({
        clientId: flow.clientId,
        clientSecret: flow.clientSecret,
        code,
        codeVerifier: flow.codeVerifier,
        redirectUri: flow.redirectUri,
      });
      const raw = readRawConfig(resolveConfigPath());
      const existing = raw.accounts.find((a) => a.type === "oauth" && tokens.email && a.email === tokens.email);
      const entry = {
        name: existing?.name || accountNameFromEmail(tokens.email),
        type: "oauth",
        email: tokens.email,
        access: flow.access,
        refreshToken: tokens.refreshToken,
      };
      flow.result = await saveAccountAndDiscover(entry, { ...entry, clientId: flow.clientId, clientSecret: flow.clientSecret });
      flow.status = "connected";
      return ok({ connected: true, ...flow.result });
    },
  },

  {
    name: "add_service_account",
    description:
      "Connect a Google Cloud service account by pointing at its JSON key file on this computer. The " +
      "service account only sees properties where its email (shown in the result) was added as a user in " +
      "Search Console > Settings > Users and permissions. Discovers those properties and saves them.",
    inputSchema: schema(
      {
        name: { type: "string", description: "Short account name, e.g. client-sa." },
        keyFile: { type: "string", description: "Absolute path to the service account JSON key file." },
        access: { type: "string", enum: ["readonly", "full"], description: "readonly (default) or full (sitemap submit/delete)." },
        overwrite: { type: "boolean", description: "Replace an existing account with this name." },
      },
      ["name", "keyFile"],
    ),
    handler: async ({ name, keyFile, access, overwrite }) => {
      name = String(name || "").trim();
      if (!ACCOUNT_RE.test(name)) return fail(`Invalid account name "${name}".`);
      const raw = readRawConfig(resolveConfigPath());
      if (raw.accounts.some((a) => a.name === name) && !overwrite) {
        return fail(`An account named "${name}" exists. Pass overwrite:true or pick another name.`);
      }
      const probe = { name, type: "service_account", keyFile, access: access === "full" ? "full" : "readonly" };
      const key = loadServiceAccountKey(probe);
      const entry = { name, type: "service_account", keyFile, email: key.client_email, access: probe.access };
      const res = await saveAccountAndDiscover(entry, entry);
      return ok({
        ...res,
        serviceAccountEmail: key.client_email,
        ...(res.siteCount === 0
          ? { next: `No properties yet. In Search Console, add ${key.client_email} as a user on each property, then call refresh_sites.` }
          : {}),
      });
    },
  },

  {
    name: "refresh_sites",
    description:
      "Re-discover Search Console properties for all accounts (or one). Picks up newly added properties " +
      "and drops ones you lost access to. Keeps any custom aliases/labels.",
    inputSchema: schema({ account: { type: "string", description: "Only refresh this account (default: all)." } }),
    handler: async ({ account }) => {
      const targets = account ? [config.accounts.get(account)].filter(Boolean) : [...config.accounts.values()];
      if (!targets.length) return fail(account ? `No account named "${account}".` : "No accounts connected yet.");
      const discovered = new Map();
      const errors = {};
      await pool(targets, 4, async (a) => {
        try {
          discovered.set(a.name, await listSitesFor(a));
        } catch (e) {
          errors[a.name] = e.message;
        }
      });
      const raw = readRawConfig(resolveConfigPath());
      const merged = mergeSites(raw.sites, discovered);
      raw.sites = merged.sites;
      writeRawConfig(raw, resolveConfigPath());
      reloadConfig();
      return ok({
        siteCount: siteNames.length,
        added: merged.added,
        removed: merged.removed,
        ...(Object.keys(errors).length ? { accountErrors: errors } : {}),
      });
    },
  },

  {
    name: "update_site",
    description:
      "Rename a site's alias, give it a friendly label, or hide/unhide it (hidden sites drop out of the " +
      "`site` list and all_sites_summary). Identify the site by current alias or siteUrl.",
    inputSchema: schema(
      {
        site: { type: "string", description: "Current alias or siteUrl (hidden sites included)." },
        alias: { type: "string", description: "New alias (letters, numbers, . : / _ ~ -)." },
        label: { type: "string", description: "Friendly label, e.g. 'Example Store'." },
        hidden: { type: "boolean", description: "true to hide, false to show." },
      },
      ["site"],
    ),
    handler: async ({ site, alias, label, hidden }) => {
      const raw = readRawConfig(resolveConfigPath());
      const s = raw.sites.find((x) => x.alias === site || x.siteUrl === site);
      if (!s) return fail(`No site "${site}". Use list_sites (or check the config file for hidden ones).`);
      if (alias !== undefined) {
        alias = String(alias).trim();
        if (!ALIAS_RE.test(alias)) return fail(`Invalid alias "${alias}".`);
        if (raw.sites.some((x) => x !== s && x.alias === alias)) return fail(`Alias "${alias}" is already used.`);
        s.alias = alias;
      }
      if (label !== undefined) s.label = label;
      if (hidden !== undefined) {
        if (hidden) s.hidden = true;
        else delete s.hidden;
      }
      writeRawConfig(raw, resolveConfigPath());
      reloadConfig();
      return ok({ updated: { alias: s.alias, siteUrl: s.siteUrl, label: s.label, hidden: Boolean(s.hidden) } });
    },
  },

  {
    name: "remove_account",
    description:
      "Disconnect a Google account and remove its saved credentials. Sites only it could see are removed; " +
      "sites another account can also see move to that account.",
    inputSchema: schema({ name: { type: "string", description: "Account name from list_accounts." } }, ["name"]),
    handler: async ({ name }) => {
      const raw = readRawConfig(resolveConfigPath());
      if (!raw.accounts.some((a) => a.name === name)) return fail(`No account named "${name}".`);
      raw.accounts = raw.accounts.filter((a) => a.name !== name);
      const removedSites = [];
      raw.sites = raw.sites.flatMap((s) => {
        const also = (s.alsoIn || []).filter((a) => a !== name);
        let next;
        if (s.account !== name) next = { ...s, alsoIn: also };
        else if (also.length) next = { ...s, account: also[0], alsoIn: also.slice(1) };
        else {
          removedSites.push(s.alias);
          return [];
        }
        if (!next.alsoIn.length) delete next.alsoIn;
        return [next];
      });
      writeRawConfig(raw, resolveConfigPath());
      clearToken(name);
      reloadConfig();
      return ok({
        removed: name,
        removedSites,
        note: "Credentials deleted locally. To fully revoke an OAuth sign-in, also remove the app at myaccount.google.com/permissions.",
      });
    },
  },

  // ---------------- cross-site ----------------
  {
    name: "all_sites_summary",
    description:
      "One call for EVERY connected property (or a chosen subset): clicks, impressions, CTR % and average " +
      "position for the window, plus change vs the previous period of equal length. Sorted by clicks. " +
      "Use this for 'how are all my sites doing'.",
    inputSchema: schema({
      ...windowProps,
      sites: { type: "array", items: siteProp, description: "Optional subset of sites (default: all)." },
      compare: { type: "boolean", description: "Include the previous period and % change (default true)." },
      type: { type: "string", enum: SEARCH_TYPES, description: "Search type (default web)." },
    }),
    handler: async ({ sites, compare, type, ...w }) => {
      const list = sites?.length ? sites : siteNames;
      if (!list.length) return fail("No sites connected yet. Run /gsc-setup.");
      const win = resolveWindow(w);
      const prev = previousWindow(win);
      const doCompare = compare !== false;
      const rows = await pool(list, 4, async (alias) => {
        try {
          const { site, account } = requireSite(alias);
          const [cur, before] = await Promise.all([
            totals(site, account, win, type),
            doCompare ? totals(site, account, prev, type) : null,
          ]);
          return { site: alias, ...(site.label ? { label: site.label } : {}), ...cur, ...(before ? { previous: before, change: delta(cur, before) } : {}) };
        } catch (e) {
          return { site: alias, error: e.message };
        }
      });
      rows.sort((a, b) => (b.clicks ?? -1) - (a.clicks ?? -1));
      const good = rows.filter((r) => !r.error);
      const sum = (k) => good.reduce((t, r) => t + (r[k] || 0), 0);
      return ok({
        window: win,
        ...(doCompare ? { previousWindow: prev } : {}),
        type: type || "web",
        totals: {
          clicks: sum("clicks"),
          impressions: sum("impressions"),
          ...(doCompare
            ? {
                previousClicks: good.reduce((t, r) => t + (r.previous?.clicks || 0), 0),
                previousImpressions: good.reduce((t, r) => t + (r.previous?.impressions || 0), 0),
              }
            : {}),
        },
        sites: rows,
        notes: "ctr is a percent; position is average rank (lower is better). Dates are Pacific Time.",
      });
    },
  },

  // ---------------- site-scoped ----------------
  {
    name: "search_analytics",
    description:
      "Search performance for one property: clicks, impressions, CTR % and average position, grouped by " +
      "any of date, hour, query, page, country, device, searchAppearance, with optional filters. This is " +
      "the full Search Analytics API — use it for top queries, top pages, trends, branded vs non-branded, " +
      "page-level keyword lists, device/country splits, etc.",
    inputSchema: schema(
      {
        site: siteProp,
        ...windowProps,
        dimensions: { type: "array", items: { type: "string", enum: DIMENSIONS }, description: "Group-by dimensions, e.g. [\"query\"] or [\"page\",\"query\"]. 'hour' needs dataState hourly_all." },
        filters: {
          type: "array",
          description: "AND-ed filters.",
          items: {
            type: "object",
            properties: {
              dimension: { type: "string", enum: ["query", "page", "country", "device", "searchAppearance"] },
              operator: { type: "string", enum: OPERATORS },
              expression: { type: "string", description: "Value or RE2 regex. country = ISO-3166 alpha-3 (usa); device = DESKTOP|MOBILE|TABLET." },
            },
            required: ["dimension", "expression"],
          },
        },
        type: { type: "string", enum: SEARCH_TYPES, description: "Search type (default web)." },
        aggregationType: { type: "string", enum: ["auto", "byPage", "byProperty"], description: "How to aggregate (default auto)." },
        dataState: { type: "string", enum: ["final", "all", "hourly_all"], description: "final (default) = complete data only; all = include fresh partial data." },
        rowLimit: { type: "integer", description: "Rows to return (default 100, max 25000)." },
        startRow: { type: "integer", description: "Offset for paging (default 0)." },
      },
      ["site"],
    ),
    handler: async ({ site: alias, dimensions, filters, type, aggregationType, dataState, rowLimit, startRow, ...w }) => {
      const { site, account } = requireSite(alias);
      const win = resolveWindow(w);
      const body = {
        startDate: win.startDate,
        endDate: win.endDate,
        dimensions: dimensions || [],
        type: type || "web",
        rowLimit: clampInt(rowLimit, 100, 1, 25000),
        startRow: clampInt(startRow, 0, 0, 10_000_000),
        ...(aggregationType ? { aggregationType } : {}),
        ...(dataState ? { dataState } : {}),
        ...(filters?.length
          ? {
              dimensionFilterGroups: [
                {
                  groupType: "and",
                  filters: filters.map((f) => ({ dimension: f.dimension, operator: f.operator || "equals", expression: f.expression })),
                },
              ],
            }
          : {}),
      };
      const { rows, responseAggregationType } = await querySA(site, account, body);
      return ok({
        site: alias,
        siteUrl: site.siteUrl,
        window: win,
        dimensions: body.dimensions,
        rowCount: rows.length,
        ...(rows.length === body.rowLimit ? { more: `Possibly more rows — call again with startRow ${body.startRow + rows.length}.` } : {}),
        responseAggregationType,
        rows,
      });
    },
  },

  {
    name: "performance_summary",
    description:
      "A quick report card for one property: totals for the window vs the previous period (with % change), " +
      "plus the top queries and top pages by clicks.",
    inputSchema: schema(
      {
        site: siteProp,
        ...windowProps,
        top: { type: "integer", description: "How many top queries/pages to include (default 10, max 100)." },
        type: { type: "string", enum: SEARCH_TYPES, description: "Search type (default web)." },
      },
      ["site"],
    ),
    handler: async ({ site: alias, top, type, ...w }) => {
      const { site, account } = requireSite(alias);
      const win = resolveWindow(w);
      const prev = previousWindow(win);
      const n = clampInt(top, 10, 1, 100);
      const base = { startDate: win.startDate, endDate: win.endDate, type: type || "web", rowLimit: n };
      const [cur, before, q, p] = await Promise.all([
        totals(site, account, win, type),
        totals(site, account, prev, type),
        querySA(site, account, { ...base, dimensions: ["query"] }),
        querySA(site, account, { ...base, dimensions: ["page"] }),
      ]);
      return ok({
        site: alias,
        siteUrl: site.siteUrl,
        window: win,
        previousWindow: prev,
        current: cur,
        previous: before,
        change: delta(cur, before),
        topQueries: q.rows,
        topPages: p.rows,
      });
    },
  },

  {
    name: "inspect_url",
    description:
      "URL Inspection for one page in a property: Google index status, coverage state, last crawl time, " +
      "canonical (user vs Google-selected), robots.txt/indexing allowed, mobile usability and rich results. " +
      "The URL must belong to the chosen site.",
    inputSchema: schema(
      {
        site: siteProp,
        url: { type: "string", description: "Full page URL to inspect." },
        languageCode: { type: "string", description: "Optional BCP-47 language for messages (default en-US)." },
      },
      ["site", "url"],
    ),
    handler: async ({ site: alias, url, languageCode }) => {
      const { site, account } = requireSite(alias);
      if (!covers(site.siteUrl, url)) {
        const match = siteNames.find((n) => covers(config.sites.get(n).siteUrl, url));
        return fail(`${url} is not inside ${alias} (${site.siteUrl}).` + (match ? ` It belongs to site "${match}".` : ""));
      }
      const data = await api(account, "POST", "/v1/urlInspection/index:inspect", {
        inspectionUrl: url,
        siteUrl: site.siteUrl,
        languageCode: languageCode || "en-US",
      });
      return ok({ site: alias, url, ...data.inspectionResult });
    },
  },

  {
    name: "list_sitemaps",
    description: "List sitemaps submitted for a property, with last submitted/downloaded time, errors, warnings and indexed counts.",
    inputSchema: schema({ site: siteProp }, ["site"]),
    handler: async ({ site: alias }) => {
      const { site, account } = requireSite(alias);
      const data = await api(account, "GET", `/webmasters/v3/sites/${enc(site.siteUrl)}/sitemaps`);
      return ok({ site: alias, sitemaps: data.sitemap || [] });
    },
  },

  {
    name: "submit_sitemap",
    description:
      "WRITE: submit (or resubmit) a sitemap URL to a property. Requires the account to be connected with " +
      "access 'full' and a Full/Owner permission on the property. Confirm the site with the user first.",
    inputSchema: schema(
      { site: siteProp, sitemapUrl: { type: "string", description: "Full sitemap URL, e.g. https://example.com/sitemap.xml" } },
      ["site", "sitemapUrl"],
    ),
    handler: async ({ site: alias, sitemapUrl }) => {
      const { site, account } = requireSite(alias);
      if (account.access !== "full") {
        return fail(`Account "${account.name}" is read-only. Reconnect it with access "full" to submit sitemaps.`);
      }
      if (!covers(site.siteUrl, sitemapUrl)) return fail(`${sitemapUrl} is not inside ${alias} (${site.siteUrl}).`);
      await api(account, "PUT", `/webmasters/v3/sites/${enc(site.siteUrl)}/sitemaps/${enc(sitemapUrl)}`);
      return ok({ site: alias, submitted: sitemapUrl });
    },
  },

  {
    name: "delete_sitemap",
    description:
      "WRITE: remove a submitted sitemap from a property (it doesn't delete the file from your site). " +
      "Requires access 'full'. Confirm with the user first.",
    inputSchema: schema({ site: siteProp, sitemapUrl: { type: "string", description: "The sitemap URL as listed." } }, ["site", "sitemapUrl"]),
    handler: async ({ site: alias, sitemapUrl }) => {
      const { site, account } = requireSite(alias);
      if (account.access !== "full") {
        return fail(`Account "${account.name}" is read-only. Reconnect it with access "full" to delete sitemaps.`);
      }
      await api(account, "DELETE", `/webmasters/v3/sites/${enc(site.siteUrl)}/sitemaps/${enc(sitemapUrl)}`);
      return ok({ site: alias, deleted: sitemapUrl });
    },
  },
];

function clampInt(v, def, min, max) {
  const n = Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(max, Math.max(min, n));
}

const toolByName = new Map(tools.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// MCP stdio JSON-RPC loop
// ---------------------------------------------------------------------------

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function result(id, res) {
  send({ jsonrpc: "2.0", id, result: res });
}
function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}
function notifyToolsChanged() {
  send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      result(id, {
        protocolVersion: params?.protocolVersion || SUPPORTED_PROTOCOL,
        capabilities: { tools: { listChanged: true } },
        serverInfo: SERVER_INFO,
      });
      return;
    case "notifications/initialized":
      initialized = true;
      return;
    case "ping":
      result(id, {});
      return;
    case "tools/list":
      result(id, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      return;
    case "tools/call": {
      const tool = toolByName.get(params?.name);
      if (!tool) {
        error(id, -32602, `Unknown tool: ${params?.name}`);
        return;
      }
      try {
        result(id, await tool.handler(params.arguments || {}));
      } catch (e) {
        const detail = e instanceof GoogleError && e.details ? `\n\nDetails: ${JSON.stringify(e.details, null, 2)}` : "";
        result(id, fail(`${e.message}${detail}`));
      }
      return;
    }
    default:
      if (isNotification) return;
      error(id, -32601, `Method not found: ${method}`);
  }
}

function start() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      Promise.resolve(handleMessage(msg)).catch((e) => {
        if (msg && msg.id != null) error(msg.id, -32603, `Internal error: ${e.message}`);
      });
    }
  });
  process.stdin.on("end", () => process.exit(0));

  if (config.error) console.error(`[gsc-multi-site] ${config.error}`);
  else console.error(`[gsc-multi-site] Ready: ${config.accounts.size} account(s), ${siteNames.length} site(s): ${siteNames.join(", ")}`);
}

start();
