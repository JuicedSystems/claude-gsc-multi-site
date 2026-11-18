---
description: Cross-site Search Console report — every property, last 28 days vs the previous 28
argument-hint: "[days, e.g. 7 or 90]"
---

Build me a Search Console report across all my connected sites.

1. Call `all_sites_summary` with `days` set to $ARGUMENTS if I gave a number, otherwise 28.
2. Open with one line: total clicks and impressions across all sites and the % change vs the
   previous period.
3. Then a table sorted by clicks: site, clicks, Δ clicks %, impressions, Δ impr %, CTR %,
   avg position, Δ position (negative = moving up).
4. Call out the biggest mover up and the biggest mover down. For each, call
   `performance_summary` on that site and name the two or three queries or pages that explain
   the change.
5. List any sites that returned an error and what the error says.

Keep it tight: no generic SEO advice unless the numbers point to something specific.
Search Console data lags 2–3 days; the window ends 3 days ago by default — say so once.
