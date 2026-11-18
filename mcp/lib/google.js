/**
 * Google auth + Search Console API client. Node 18+ built-ins only (fetch, crypto, http).
 *
 * Two credential types per account:
 *   - oauth            a refresh token from a Google account you signed in with
 *                      (one OAuth "Desktop app" client can connect any number of accounts)
 *   - service_account  a JSON key; the service account's email is added as a user
 *                      on each Search Console property
 *
 * Access tokens are minted on demand, cached per account and refreshed ~2 min early.
 */
import { createSign, randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

export const SCOPES = {
  readonly: "https://www.googleapis.com/auth/webmasters.readonly",
  full: "https://www.googleapis.com/auth/webmasters",
};

// Overridable for offline tests.
const TOKEN_URL = () => process.env.GSC_TOKEN_URL || "https://oauth2.googleapis.com/token";
const AUTH_URL = () => process.env.GSC_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
const API_BASE = () => process.env.GSC_API_BASE || "https://searchconsole.googleapis.com";

export class GoogleError extends Error {
  constructor(message, { status, details } = {}) {
    super(message);
    this.name = "GoogleError";
    this.status = status;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

const tokenCache = new Map(); // account name -> { token, expiresAt }

export function clearToken(accountName) {
  tokenCache.delete(accountName);
}

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Load a service account key (from inline object or file path). */
export function loadServiceAccountKey(account) {
  let key = account.key;
  if (!key && account.keyFile) {
    try {
      key = JSON.parse(readFileSync(account.keyFile, "utf8"));
    } catch (e) {
      throw new GoogleError(`Could not read service account key file "${account.keyFile}": ${e.message}`);
    }
  }
  if (!key || key.type !== "service_account" || !key.client_email || !key.private_key) {
    throw new GoogleError(
      `"${account.name}" is not a valid service account key (expected a JSON key with type "service_account", ` +
        `client_email and private_key — download it from Google Cloud > IAM > Service Accounts > Keys).`,
    );
  }
  return key;
}

/** Build and sign the JWT assertion for the service-account (jwt-bearer) grant. */
export function signServiceAccountJwt(key, scope, now = Math.floor(Date.now() / 1000)) {
  const header = { alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) };
  const claims = {
    iss: key.client_email,
    scope,
    aud: key.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const sig = signer.sign(key.private_key).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${unsigned}.${sig}`;
}

async function postForm(url, params) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params),
    });
  } catch (e) {
    throw new GoogleError(`Network error contacting Google's token endpoint: ${e.message}`);
  }
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* handled below */
  }
  return { res, json, text };
}

async function mintToken(account) {
  const scope = SCOPES[account.access] || SCOPES.readonly;
  let res, json, text;
  if (account.type === "service_account") {
    const key = loadServiceAccountKey(account);
    const tokenUrl = process.env.GSC_TOKEN_URL || key.token_uri || TOKEN_URL();
    ({ res, json, text } = await postForm(tokenUrl, {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signServiceAccountJwt(key, scope),
    }));
  } else {
    ({ res, json, text } = await postForm(TOKEN_URL(), {
      grant_type: "refresh_token",
      refresh_token: account.refreshToken,
      client_id: account.clientId,
      client_secret: account.clientSecret,
    }));
  }

  if (!res.ok || !json.access_token) {
    const reason = json.error_description || json.error || text.slice(0, 200) || `HTTP ${res.status}`;
    let hint = "";
    if (json.error === "invalid_grant") {
      hint =
        account.type === "oauth"
          ? " The refresh token was revoked or expired. If your OAuth consent screen is still in " +
            "'Testing', Google expires refresh tokens after 7 days — set it to 'In production', then " +
            "reconnect this account with connect_google_account."
          : " Check the service account key is current (not deleted) and the machine clock is correct.";
    }
    throw new GoogleError(`Could not get an access token for account "${account.name}": ${reason}.${hint}`, {
      status: res.status,
      details: json,
    });
  }
  const expiresIn = Number(json.expires_in) || 3599;
  const entry = { token: json.access_token, expiresAt: Date.now() + Math.max(0, expiresIn - 120) * 1000 };
  tokenCache.set(account.name, entry);
  return entry.token;
}

async function getToken(account) {
  const cached = tokenCache.get(account.name);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  return mintToken(account);
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/**
 * Call a Search Console REST endpoint as `account`. `path` is relative to the API
 * base (e.g. "/webmasters/v3/sites"). Retries once with a fresh token on 401.
 */
export async function api(account, method, path, body, isRetry = false) {
  const token = await getToken(account);
  let res;
  try {
    res = await fetch(API_BASE() + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new GoogleError(`Network error contacting Search Console: ${e.message}`);
  }

  if (res.status === 401 && !isRetry) {
    clearToken(account.name);
    return api(account, method, path, body, true);
  }

  const text = await res.text();
  let json = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 300) };
    }
  }

  if (!res.ok) {
    const msg = json.error?.message || json.raw || `HTTP ${res.status}`;
    let hint = "";
    if (res.status === 403) {
      if (/insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(text)) {
        hint = ` Account "${account.name}" is connected read-only. Reconnect it with access "full" to allow this.`;
      } else if (/permission|not.*owner|not.*verified/i.test(msg)) {
        hint =
          account.type === "service_account"
            ? ` Add the service account's email as a user on this property in Search Console (Settings > Users and permissions).`
            : ` The Google account "${account.email || account.name}" may have lost access to this property.`;
      }
      if (/has not been used in project|is disabled/i.test(msg)) {
        hint = " Enable the 'Google Search Console API' in your Google Cloud project, wait a minute, then retry.";
      }
    }
    if (res.status === 429) hint = " Search Console rate limit hit — wait a bit and retry, or narrow the query.";
    throw new GoogleError(`Search Console API error (HTTP ${res.status}) as "${account.name}": ${msg}.${hint}`, {
      status: res.status,
      details: json.error || json,
    });
  }
  return json;
}

export const enc = (s) => encodeURIComponent(s);

export async function listSitesFor(account) {
  const data = await api(account, "GET", "/webmasters/v3/sites");
  return (data.siteEntry || []).map((e) => ({ siteUrl: e.siteUrl, permissionLevel: e.permissionLevel }));
}

// ---------------------------------------------------------------------------
// OAuth "installed app" flow with a loopback redirect + PKCE
// ---------------------------------------------------------------------------

const pending = new Map(); // state -> flow

function decodeJwtPayload(jwt) {
  try {
    const part = jwt.split(".")[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return {};
  }
}

/**
 * Exchange an authorization code for tokens. Returns { refreshToken, email }.
 */
export async function exchangeCode({ clientId, clientSecret, code, codeVerifier, redirectUri }) {
  const { res, json, text } = await postForm(TOKEN_URL(), {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  if (!res.ok || !json.access_token) {
    const reason = json.error_description || json.error || text.slice(0, 200);
    throw new GoogleError(`Google rejected the sign-in code: ${reason}`, { status: res.status, details: json });
  }
  if (!json.refresh_token) {
    throw new GoogleError(
      "Google didn't return a refresh token. Remove this app's access at myaccount.google.com/permissions " +
        "and connect again (the connector always asks for offline access).",
    );
  }
  const email = json.id_token ? decodeJwtPayload(json.id_token).email || "" : "";
  return { refreshToken: json.refresh_token, email, accessToken: json.access_token, expiresIn: json.expires_in };
}

/**
 * Start a sign-in. Opens a one-shot listener on 127.0.0.1 (random port) and returns
 * the Google consent URL. When the browser is redirected back, the code is exchanged
 * and `onComplete(result)` runs (it should save the account). The listener closes on
 * completion or after `timeoutMs`.
 */
export async function startOAuthFlow({ clientId, clientSecret, access, onComplete, timeoutMs = 10 * 60 * 1000 }) {
  const state = b64url(randomBytes(18));
  const codeVerifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(codeVerifier).digest());

  const flow = { state, codeVerifier, clientId, clientSecret, access, status: "waiting", result: null, error: null };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/") {
      res.writeHead(404).end();
      return;
    }
    const page = (title, body) =>
      `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font-family:system-ui;max-width:520px;margin:12vh auto;padding:0 16px;line-height:1.5">` +
      `<h2>${title}</h2><p>${body}</p></body>`;
    if (url.searchParams.get("state") !== state) {
      res.writeHead(400, { "Content-Type": "text/html" }).end(page("Sign-in link mismatch", "Start again from Claude."));
      return;
    }
    const err = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (err || !code) {
      flow.status = "failed";
      flow.error = err || "no code returned";
      res.writeHead(400, { "Content-Type": "text/html" }).end(page("Sign-in cancelled", `Google said: ${flow.error}`));
      finish();
      return;
    }
    try {
      const tokens = await exchangeCode({ clientId, clientSecret, code, codeVerifier, redirectUri: flow.redirectUri });
      flow.result = await onComplete(tokens);
      flow.status = "connected";
      const n = flow.result?.siteCount ?? 0;
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end(page("Connected to Claude", `${tokens.email || "Your Google account"} is connected with ${n} Search Console propert${n === 1 ? "y" : "ies"}. You can close this tab and go back to Claude.`));
    } catch (e) {
      flow.status = "failed";
      flow.error = e.message;
      res.writeHead(500, { "Content-Type": "text/html" }).end(page("Couldn't finish connecting", e.message));
    }
    finish();
  });

  function finish() {
    clearTimeout(flow.timer);
    setTimeout(() => server.close(), 500);
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.unref();
  flow.redirectUri = `http://127.0.0.1:${server.address().port}`;
  flow.timer = setTimeout(() => {
    if (flow.status === "waiting") {
      flow.status = "expired";
      server.close();
    }
  }, timeoutMs);
  flow.timer.unref?.();

  const scope = [SCOPES[access] || SCOPES.readonly, "openid", "email"].join(" ");
  const authUrl =
    AUTH_URL() +
    "?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: flow.redirectUri,
      response_type: "code",
      scope,
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "true",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });
  flow.authUrl = authUrl;
  pending.set(state, flow);
  return flow;
}

/** Most recent flows, newest first (for status reporting). */
export function oauthFlows() {
  return [...pending.values()].reverse();
}

/** Find a pending flow from a pasted redirect URL (or the state value). */
export function findFlow(stateOrUrl) {
  if (!stateOrUrl) return oauthFlows().find((f) => f.status === "waiting") || null;
  let state = stateOrUrl;
  try {
    state = new URL(stateOrUrl).searchParams.get("state") || stateOrUrl;
  } catch {
    /* not a URL */
  }
  return pending.get(state) || null;
}
