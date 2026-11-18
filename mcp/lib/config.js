import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";

/**
 * Config file layout (~/.gsc-multi-site/config.json):
 *
 * {
 *   "oauthClient": { "clientId": "...apps.googleusercontent.com", "clientSecret": "GOCSPX-..." },
 *   "accounts": [
 *     { "name": "main", "type": "oauth", "email": "...", "access": "readonly",
 *       "refreshToken": "1//..." },
 *     { "name": "client-sa", "type": "service_account", "keyFile": "C:\\keys\\gsc.json" }
 *   ],
 *   "sites": [
 *     { "alias": "example.com", "siteUrl": "sc-domain:example.com",
 *       "account": "main", "permissionLevel": "siteOwner", "label": "Example Store" }
 *   ]
 * }
 *
 * `sites` is written by the server (refresh_sites / connect flows). Users may edit
 * `alias`, `label` and `hidden`; those survive later refreshes.
 */

export function resolveConfigPath() {
  const fromEnv = process.env.GSC_MULTI_SITE_CONFIG;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  return join(homedir(), ".gsc-multi-site", "config.json");
}

export const ALIAS_RE = /^[a-z0-9][a-z0-9.:/_~-]*$/i;
export const ACCOUNT_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/** Read the raw file as a plain object (fresh skeleton if missing). */
export function readRawConfig(path = resolveConfigPath()) {
  if (!existsSync(path)) return { accounts: [], sites: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return {
    ...parsed,
    accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
    sites: Array.isArray(parsed.sites) ? parsed.sites : [],
  };
}

export function writeRawConfig(data, path = resolveConfigPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const clean = { ...data };
  for (const k of Object.keys(clean)) if (k.startsWith("//")) delete clean[k];
  writeFileSync(path, JSON.stringify(clean, null, 2) + "\n", "utf8");
  // Holds refresh tokens / key paths — keep it private on POSIX systems.
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best effort */
    }
  }
  return path;
}

/**
 * Load and validate. Returns
 *   { path, oauthClient, accounts: Map<name, account>, sites: Map<alias, site>, error, warning }
 * The server still starts on error so list_sites can explain what's wrong.
 */
export function loadConfig() {
  const path = resolveConfigPath();
  const out = { path, oauthClient: null, accounts: new Map(), sites: new Map(), error: null, warning: null };

  if (!existsSync(path)) {
    out.error =
      `No config yet at "${path}". Run /gsc-setup (or call connect_google_account / ` +
      `add_service_account) to connect your first Google account.`;
    return out;
  }

  let raw;
  try {
    raw = readRawConfig(path);
  } catch (e) {
    out.error = `Config at "${path}" is not valid JSON: ${e.message}`;
    return out;
  }

  if (raw.oauthClient?.clientId && raw.oauthClient?.clientSecret) {
    out.oauthClient = { clientId: raw.oauthClient.clientId.trim(), clientSecret: raw.oauthClient.clientSecret.trim() };
  }

  const problems = [];
  for (const a of raw.accounts) {
    const name = String(a.name || "").trim();
    if (!ACCOUNT_RE.test(name)) {
      problems.push(`account "${name}" has an invalid or missing name`);
      continue;
    }
    if (out.accounts.has(name)) {
      problems.push(`duplicate account "${name}"`);
      continue;
    }
    if (a.type === "oauth") {
      const clientId = (a.clientId || out.oauthClient?.clientId || "").trim();
      const clientSecret = (a.clientSecret || out.oauthClient?.clientSecret || "").trim();
      if (!a.refreshToken) {
        problems.push(`account "${name}" has no refreshToken — reconnect it`);
        continue;
      }
      if (!clientId || !clientSecret) {
        problems.push(`account "${name}" needs an OAuth client (top-level "oauthClient")`);
        continue;
      }
      out.accounts.set(name, {
        name,
        type: "oauth",
        email: a.email || "",
        access: a.access === "full" ? "full" : "readonly",
        refreshToken: a.refreshToken,
        clientId,
        clientSecret,
      });
    } else if (a.type === "service_account") {
      if (!a.keyFile && !a.key) {
        problems.push(`service account "${name}" needs "keyFile" (path to the JSON key)`);
        continue;
      }
      out.accounts.set(name, {
        name,
        type: "service_account",
        keyFile: a.keyFile || null,
        key: a.key || null,
        email: a.email || "",
        access: a.access === "full" ? "full" : "readonly",
      });
    } else {
      problems.push(`account "${name}" has unknown type "${a.type}" (use "oauth" or "service_account")`);
    }
  }

  for (const s of raw.sites) {
    const alias = String(s.alias || "").trim();
    if (s.hidden) continue;
    if (!alias || !ALIAS_RE.test(alias)) {
      problems.push(`site "${s.siteUrl}" has an invalid alias "${alias}"`);
      continue;
    }
    if (!out.accounts.has(s.account)) {
      problems.push(`site "${alias}" points at unknown account "${s.account}"`);
      continue;
    }
    if (out.sites.has(alias)) {
      problems.push(`duplicate site alias "${alias}"`);
      continue;
    }
    out.sites.set(alias, {
      alias,
      siteUrl: s.siteUrl,
      account: s.account,
      permissionLevel: s.permissionLevel || "",
      label: s.label || "",
      alsoIn: Array.isArray(s.alsoIn) ? s.alsoIn : [],
    });
  }

  if (out.accounts.size === 0) {
    out.error = `No usable Google accounts in "${path}".` + (problems.length ? ` Problems: ${problems.join("; ")}.` : "");
  } else if (problems.length) {
    out.warning = `Some entries were skipped: ${problems.join("; ")}.`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// site discovery merge
// ---------------------------------------------------------------------------

const PERMISSION_RANK = { siteOwner: 3, siteFullUser: 2, siteRestrictedUser: 1 };

/** Friendly alias for a GSC siteUrl. sc-domain:x.com -> x.com, https://www.x.com/ -> www.x.com */
export function defaultAlias(siteUrl) {
  if (siteUrl.startsWith("sc-domain:")) return siteUrl.slice("sc-domain:".length).toLowerCase();
  return siteUrl.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

/** Fallback alias when the friendly one collides: the full URL without its trailing slash. */
function fallbackAlias(siteUrl) {
  return siteUrl.replace(/\/+$/, "").toLowerCase();
}

/**
 * Merge freshly discovered sites (per account) into the raw `sites` list.
 *  - keeps user-chosen alias / label / hidden for sites already known
 *  - a site reachable from several accounts is listed once, under the account
 *    with the highest permission (others recorded in `alsoIn`)
 *  - unverified properties are skipped (the API refuses to query them)
 *  - sites belonging only to accounts in `refreshedAccounts` that no longer
 *    return them are dropped; sites of other accounts are left untouched
 *
 * @param {Array} existing           raw sites array from the file
 * @param {Map<string, Array<{siteUrl, permissionLevel}>>} discovered  account -> entries
 *  - a new URL-prefix property inside a connected Domain property is hidden
 *    (`coveredBy`) so all-sites totals don't count the same traffic twice
 *
 * @returns {{ sites: Array, added: string[], removed: string[], autoHidden: string[] }}
 */
export function mergeSites(existing, discovered) {
  const refreshed = new Set(discovered.keys());
  const byUrl = new Map();
  for (const s of existing) byUrl.set(s.siteUrl, { ...s });

  // Collect who can see each URL, from the refreshed accounts.
  const access = new Map(); // siteUrl -> [{account, permissionLevel}]
  for (const [account, entries] of discovered) {
    for (const e of entries) {
      if (!PERMISSION_RANK[e.permissionLevel]) continue; // unverified
      if (!access.has(e.siteUrl)) access.set(e.siteUrl, []);
      access.get(e.siteUrl).push({ account, permissionLevel: e.permissionLevel });
    }
  }

  const removed = [];
  for (const [url, s] of byUrl) {
    const owners = [s.account, ...(s.alsoIn || [])];
    const allRefreshed = owners.every((a) => refreshed.has(a));
    if (allRefreshed && !access.has(url)) {
      byUrl.delete(url);
      removed.push(s.alias || url);
    }
  }

  const taken = new Set([...byUrl.values()].map((s) => s.alias));
  const added = [];
  const autoHidden = [];
  // Domain properties first so they win the bare-domain alias.
  const urls = [...access.keys()].sort((a, b) => {
    const da = a.startsWith("sc-domain:") ? 0 : 1;
    const db = b.startsWith("sc-domain:") ? 0 : 1;
    return da - db || a.localeCompare(b);
  });

  for (const url of urls) {
    const viewers = access.get(url).sort((x, y) => PERMISSION_RANK[y.permissionLevel] - PERMISSION_RANK[x.permissionLevel]);
    const prev = byUrl.get(url);
    if (prev) {
      // Keep the current account if it can still see the site; otherwise switch to the best one.
      const stillThere = viewers.find((v) => v.account === prev.account);
      const keep = stillThere || (refreshed.has(prev.account) ? viewers[0] : { account: prev.account, permissionLevel: prev.permissionLevel });
      const others = new Set([...(prev.alsoIn || []), ...viewers.map((v) => v.account)]);
      others.delete(keep.account);
      // Drop alsoIn entries for refreshed accounts that lost access.
      for (const a of [...others]) if (refreshed.has(a) && !viewers.some((v) => v.account === a)) others.delete(a);
      byUrl.set(url, { ...prev, account: keep.account, permissionLevel: keep.permissionLevel, alsoIn: [...others] });
      continue;
    }
    let alias = defaultAlias(url);
    if (taken.has(alias)) alias = fallbackAlias(url);
    let n = 2;
    const base = alias;
    while (taken.has(alias)) alias = `${base}~${n++}`;
    taken.add(alias);
    const best = viewers[0];
    const entry = {
      alias,
      siteUrl: url,
      account: best.account,
      permissionLevel: best.permissionLevel,
      alsoIn: viewers.slice(1).map((v) => v.account),
    };
    // A URL-prefix property inside a connected Domain property is a subset of
    // its traffic; listing both would double-count all-sites totals. Hide it on
    // first discovery (the user can unhide it with update_site).
    const parent = coveringDomain(url, byUrl);
    if (parent) {
      entry.hidden = true;
      entry.coveredBy = parent.alias;
      autoHidden.push(alias);
    } else {
      added.push(alias);
    }
    byUrl.set(url, entry);
  }

  const sites = [...byUrl.values()].map((s) => {
    const o = { ...s };
    if (!o.alsoIn || o.alsoIn.length === 0) delete o.alsoIn;
    return o;
  });
  sites.sort((a, b) => a.alias.localeCompare(b.alias));
  return { sites, added, removed, autoHidden };
}

/** Host of a URL-prefix property, or null for domain properties / bad URLs. */
export function prefixHost(siteUrl) {
  if (siteUrl.startsWith("sc-domain:")) return null;
  try {
    return new URL(siteUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The connected Domain property that contains this URL-prefix property, if any. */
function coveringDomain(siteUrl, byUrl) {
  const host = prefixHost(siteUrl);
  if (!host) return null;
  for (const s of byUrl.values()) {
    if (!s.siteUrl.startsWith("sc-domain:")) continue;
    const dom = s.siteUrl.slice(10).toLowerCase();
    if (host === dom || host.endsWith("." + dom)) return s;
  }
  return null;
}
