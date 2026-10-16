# SLH CurseForge relay

This folder is a standalone Netlify Functions project. It supports the launcher's
GET endpoints and official batch endpoints `POST /api/v1/mods` and
`POST /api/v1/mods/files` (up to 100 IDs per request). The launcher automatically
falls back to individual requests if an older relay returns 404/405 for POST.

The key stays in the existing project's **CURSEFORGE_API_KEY** environment variable,
with the **Functions** scope. Never put the key in this folder, a public file or
the launcher executable. The function does not cache upstream data. The per-IP
Netlify rule limits requests to 100 per minute; it does not replace the allocation
shared by all users of the upstream key. Check function rate-limit validation in
the deploy log and adjust the rule to the application's approved allocation.

## Verify and deploy

```powershell
cd 'E:\Codex Projects\Apps\SLH\services\curseforge-relay'
node --test relay.test.mjs
npx netlify-cli login
npx netlify-cli deploy --no-build --site voluble-entremet-324baf --dir public --functions netlify/functions
```

The first deploy is a draft. Verify its URL before publishing:

- `GET /api/v1/games/432`
- `GET /api/v1/mods/search?gameId=432&pageSize=1`
- `POST /api/v1/mods` with `{"modIds":[1204182]}`
- `POST /api/v1/mods/files` with `{"fileIds":[8292539]}`

All four should return JSON with HTTP 200. The draft must use the server key's
appropriate deploy-context scope too. After verification, publish with the same
command plus `--prod`, then repeat the checks against the production URL.
The deploy replaces the project's static files and function configuration with
this dedicated relay project. Preserve any unrelated existing site first.

Netlify Drop only uploads static files; use the CLI or connect this directory
to a Git repository so the function is bundled and uploaded too. Signing into
the Netlify dashboard does not sign the CLI in. Login/OAuth is done by the user;
no token or CurseForge key needs to be sent in chat.

Sources: [Netlify Functions deployment](https://docs.netlify.com/build/functions/get-started/),
[Netlify rate limiting](https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/),
[CurseForge API](https://docs.curseforge.com/rest-api/).

## Verified deployment (2026-10-11)

Production deploy: `6acb647ceb3060dffd78d11c`. All four smoke checks passed on
`https://voluble-entremet-324baf.netlify.app`. Deploy preview URLs require Netlify
sign-in on this project; a plain HTTP probe returns 401 before invoking the function.
The previous published deploy is recorded in
`artifacts/curseforge-relay-previous-deploy.json` in the launcher workspace.

A fresh isolated HORROR 1.8 installation (Minecraft 1.19.2, Forge 43.5.0)
prepared 61 entries in 3.24 seconds using two batch requests. All 61 entries
matched the manifest and SHA-1 checks; 13 author-restricted files were reused
from verified local copies. Minecraft's 3364 assets and Forge installation
also completed. This verifies local reuse of restricted files, not an upstream
permission to download restricted files automatically.
