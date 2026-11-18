---
description: List every Search Console property connected to the multi-site connector
---

Call `list_sites` from the gsc-multi-site connector and show my properties in a compact table:
site (the alias to use), label, type (domain / url-prefix), account, and permission.

If it reports zero sites or a config error, tell me what's wrong and suggest `/gsc-setup`.
If I just added a property in Search Console and it isn't listed, call `refresh_sites`.
Never show credentials.
