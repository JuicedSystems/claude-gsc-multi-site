# Setup guide

This guide takes you from a fresh install to every Search Console property you own answering in Claude.
Plan on about 10 minutes the first time, and about 30 seconds for each extra Google account.

- [Before you start](#before-you-start)
- [Step 1 — Install the plugin](#step-1--install-the-plugin)
- [Step 2 — Create your Google OAuth client](#step-2--create-your-google-oauth-client-one-time)
- [Step 3 — Connect your first Google account](#step-3--connect-your-first-google-account)
- [Step 4 — Connect more Google accounts](#step-4--connect-more-google-accounts)
- [Option — Service accounts](#option--service-accounts)
- [Managing sites](#managing-sites)
- [Disconnecting and uninstalling](#disconnecting-and-uninstalling)
- [Troubleshooting](#troubleshooting)

## Before you start

You need:

- **Node.js 18 or newer** on your PATH. Check with `node --version`. Install from
  <https://nodejs.org> if needed.
- **Claude Code, Cowork or Claude Desktop** (the plugin runs a local server, so it doesn't run in the
  claude.ai web or mobile apps).
- **A Google account** that can sign in to Google Cloud Console. It doesn't have to be one of the
  accounts that owns your Search Console properties.

## Step 1 — Install the plugin

In Claude:

```text
/plugin marketplace add JuicedSystems/claude-gsc-multi-site
/plugin install gsc-multi-site@juiced-systems-gsc
/reload-plugins
```

Check it's running by asking Claude: *"List my Search Console accounts."* It should answer that no
accounts are connected yet.

## Step 2 — Create your Google OAuth client (one time)

The plugin signs in to Google with an OAuth client that **you** own, so your tokens never pass through
anyone else's app. One client works for all your Google accounts.

### 2a. Create a project and enable the API

1. Open <https://console.cloud.google.com> and choose **Select a project → New project**. Name it
   something like `Claude GSC` and select **Create**.
2. With the new project selected, go to **APIs & Services → Library**.
3. Search for **Google Search Console API**, open it, and select **Enable**.

### 2b. Configure the consent screen

1. Go to **Google Auth Platform → Branding** (older consoles call it **OAuth consent screen**) and
   select **Get started** if prompted.
2. **App name:** `Claude GSC` (anything you'll recognize). **User support email:** your email.
3. **Audience:** choose **External**. (Choose **Internal** only if every account you'll connect is in
   the same Google Workspace organization.)
4. **Contact information:** your email. Agree to the Google API Services User Data Policy and select
   **Create**.
5. Go to **Audience** and select **Publish app**, then **Confirm**. The status should read
   **In production**.

> **Why publish?** While an External app is in *Testing*, Google expires refresh tokens after 7 days,
> so you'd have to reconnect every week. Publishing doesn't make your app public; it only means anyone
> with the link *could* sign in. Since only you have the link, that's you.
> You don't need Google's verification for personal use. You'll see a "Google hasn't verified this
> app" screen when signing in; that's expected for your own client.

### 2c. Create the Desktop client

1. Go to **Google Auth Platform → Clients → Create client**.
2. **Application type:** **Desktop app**. Name: `Claude GSC desktop`. Select **Create**.
3. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret**
   (starts with `GOCSPX-`).

> It must be **Desktop app**. A *Web application* client rejects the plugin's local redirect.

## Step 3 — Connect your first Google account

Run `/gsc-setup`, or tell Claude:

> Connect my Google Search Console account. Client ID is `…apps.googleusercontent.com`, secret is
> `GOCSPX-…`.

Claude saves the client to your local config and replies with a Google sign-in link.

1. Open the link **on the same computer** Claude runs on.
2. Choose the Google account that owns (or has access to) your properties.
3. On "Google hasn't verified this app", select **Advanced → Go to Claude GSC (unsafe)**. It's your own
   app.
4. Approve the permissions. The tab says **Connected to Claude** and how many properties it found.

Back in Claude, run `/gsc-sites` to see them.

**Read-only or full?** Accounts connect read-only by default. Say "connect with full access" if you want
Claude to be able to submit and remove sitemaps for that account.

## Step 4 — Connect more Google accounts

Say *"Connect another Google account"*. Claude gives you a new link; pick the other account in Google's
account chooser. No new client is needed. Properties from every account appear in one list.

If the same property is shared with several of your accounts, it's listed once, read through the account
with the highest permission.

## Option — Service accounts

Use a service account for properties owned by someone you can't sign in as (a client, say).

1. In Google Cloud Console (same project is fine): **IAM & Admin → Service Accounts → Create service
   account**. No roles are needed.
2. Open it → **Keys → Add key → Create new key → JSON**. Save the file somewhere private, e.g.
   `C:\Users\<you>\.gsc-multi-site\client-sa.json`.
3. Ask the property owner to add the service account's email (`…@….iam.gserviceaccount.com`) in
   **Search Console → Settings → Users and permissions → Add user**, with **Restricted** (read) or
   **Full** permission.
4. Tell Claude: *"Add the service account at C:\Users\<you>\.gsc-multi-site\client-sa.json as
   client-sa."*

Properties shared later appear after you say *"Refresh my Search Console sites."*

## Managing sites

| Say to Claude | What happens |
|---|---|
| "Rename www.juicedsystems.com to juiced" | Changes the alias Claude uses (`update_site`) |
| "Label phoenixputter.com as Phoenix Putter Co" | Adds a friendly label |
| "Hide old-blog.example.com" | Removes it from the site list and all-sites reports; unhide any time |
| "Refresh my Search Console sites" | Picks up new properties and drops lost ones; keeps your aliases |

## Disconnecting and uninstalling

- **One account:** *"Remove the Google account dylan-juicedsystems.com from the Search Console
  connector."* Then revoke access at <https://myaccount.google.com/permissions>.
- **Everything:** uninstall the plugin (`/plugin uninstall gsc-multi-site`) and delete the
  `.gsc-multi-site` folder in your home directory.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `invalid_grant` after about a week | Consent screen is still in *Testing*. Publish it (step 2b.5) and reconnect |
| "Search Console API has not been used in project…" | Enable the API (step 2a) in the same project as the client; wait a minute |
| `redirect_uri_mismatch` | The client isn't a **Desktop app**. Create a Desktop client (step 2c) |
| Sign-in tab can't reach `127.0.0.1` | The browser is on another machine. Copy the full address-bar URL and say "finish the Google sign-in with this URL: …" |
| A property is missing | The account must have a verified Owner, Full or Restricted permission (unverified properties are skipped). Then refresh |
| Service account sees nothing | The owner hasn't added its email to the property yet |
| "read-only" when submitting a sitemap | Reconnect that account with full access |
| No refresh token returned | Remove the app at <https://myaccount.google.com/permissions> and connect again |
