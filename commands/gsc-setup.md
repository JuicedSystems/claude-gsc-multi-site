---
description: Walk me through connecting Google accounts to the Search Console multi-site connector
---

Help me connect my Google Search Console accounts to the gsc-multi-site connector. Follow the setup guide
at https://github.com/JuicedSystems/claude-gsc-multi-site/blob/main/docs/SETUP.md and keep each reply short.

1. Call `list_accounts`. Tell me what's already connected and whether an OAuth client is saved.

2. If no OAuth client is saved, walk me through the one-time Google Cloud setup, one stage at a time,
   waiting for me to confirm each:
   - **Project + API:** new project `Claude GSC` → APIs & Services → Library → enable
     **Google Search Console API**.
   - **Google Auth Platform → Get started:** app name, support email, audience **External** (even for
     Workspace accounts), contact email, agree → Create.
   - **Branding:** Application home page and privacy policy link on a website I own, plus that domain
     under Authorized domains. No logo. Save. Offer the privacy page template from the guide.
   - **Audience → Publish app → Confirm** so it says **In production** (otherwise sign-ins expire after
     7 days). If Publish is greyed out, the Branding fields are incomplete.
   - **Clients → Create client → Desktop app.** Copy the Client ID and secret, and download the JSON.

3. Ask whether I want read-only (default) or full access (lets Claude submit and remove sitemaps). Call
   `connect_google_account` (with `clientId` and `clientSecret` the first time) and give me the `authUrl`
   as a clickable link. Tell me to pick ONE account, click **Advanced → Go to (app)** on the unverified
   warning, and approve.

4. When I come back:
   - If the tab said **Connected**, call `list_accounts`.
   - If it said **"This site can't be reached"**, ask me to paste the full address-bar URL and call
     `finish_google_account` with it.
   Then show the properties found in a compact table, and mention any that were auto-hidden as
   duplicates.

5. Ask if I have another Google account with Search Console properties. If yes, call
   `connect_google_account` again (no client needed) and remind me to choose a different account.

6. When I'm done, call `list_sites` and suggest `/gsc-report` as a first try.

Never print the client secret or any refresh token back to me.
