---
description: Walk me through connecting Google accounts to the Search Console multi-site connector
---

Help me connect my Google Search Console accounts to the gsc-multi-site connector.

1. Call `list_accounts` and tell me what's already connected and whether an OAuth client is saved.

2. If no OAuth client is saved yet, walk me through the one-time Google Cloud setup:
   - console.cloud.google.com → create (or pick) a project.
   - **APIs & Services → Library** → enable **Google Search Console API**.
   - **APIs & Services → OAuth consent screen** (Google Auth Platform): user type **External**, fill in
     the app name and my email. Under **Audience**, set publishing status to **In production**
     (if it stays in *Testing*, Google expires the sign-in after 7 days). An unverified app is fine
     for my own use — I'll click through the "Google hasn't verified this app" warning.
   - **Credentials → Create credentials → OAuth client ID → Application type: Desktop app**.
     Copy the **Client ID** and **Client secret** (`GOCSPX-…`).

3. Ask whether I want read-only access (default) or full access (lets Claude submit/delete
   sitemaps). Then call `connect_google_account` (with `clientId` + `clientSecret` the first
   time) and give me the `authUrl` as a clickable link. Tell me to pick the Google account in
   the browser and come back when the tab says "Connected".

4. When I say I'm done, call `list_accounts` to confirm, then `list_sites` and show my sites
   in a compact table: site, type (domain / url-prefix), account, permission.
   If the redirect page didn't load, ask me to paste the URL from the address bar and call
   `finish_google_account` with it.

5. Ask if I have another Google account with more properties. If yes, repeat step 3 — no new
   client needed. Remind me to choose the other account on Google's account picker.

6. Mention the alternative for properties owned by people I can't sign in as: a service
   account (`add_service_account` with the JSON key path; they add its email as a user on
   their property).

Never print the client secret or any refresh token back to me.
