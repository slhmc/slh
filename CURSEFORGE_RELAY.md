# CurseForge relay

SLH uses `https://voluble-entremet-324baf.netlify.app/api/v1` when no personal CurseForge key is configured. The launcher sends no `x-api-key` header to this relay. A configured personal key switches requests to `https://api.curseforge.com/v1` and adds the key only in the Rust backend.

The relay deployment must:

- expose public JSON responses under `/api/v1/*` without Netlify Visitor Access;
- forward only allow-listed `GET` requests to `https://api.curseforge.com/v1/*`;
- include `GET /api/v1/mods/{id}/description` in that allow-list. SLH uses this official
  endpoint for the full project page body (including images and rich text), not just the
  short summary returned by `GET /mods/{id}`;
- add `x-api-key` from the server-side `CURSEFORGE_API_KEY` environment variable;
- never return that environment value in headers, bodies, redirects, or logs;
- preserve query parameters and upstream status codes;
- apply rate limits and do not cache API data unless CurseForge has approved that behavior in writing.

Before enabling the relay for public users, obtain written confirmation from CurseForge that the
approved SLH application may use a server-side relay. Their published third-party terms describe
API keys as non-transferable and restrict proxy use intended to conceal identity or location. The
relay must identify the SLH application honestly and stay within the allocation approved for it.

Health checks:

```text
GET https://voluble-entremet-324baf.netlify.app/api/v1/games/432
GET https://voluble-entremet-324baf.netlify.app/api/v1/mods/search?gameId=432&pageSize=1
```

Both must return `200` with `Content-Type: application/json`. A `401` indicates Netlify access protection. A `404` indicates the function or rewrite was not deployed.

Deploy the project through a connected Git repository or the Netlify CLI so Netlify builds and
uploads `netlify/functions`. Dragging the directory into a static Drop deploy does not prove that
the function was bundled; always verify both URLs above after a production deploy.

CurseForge's official API base is `https://api.curseforge.com`; `https://curseforge.com` is the website and is not the REST API origin.
