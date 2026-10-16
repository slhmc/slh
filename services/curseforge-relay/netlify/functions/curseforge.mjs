const json = (status, message) => Response.json({ error: message }, {
  status, headers: { "Cache-Control": "no-store" },
});
const allowedGet = /^(?:games\/432(?:\/(?:versions|version-types))?|categories|mods\/search|mods\/[1-9]\d*(?:\/(?:description|files(?:\/[1-9]\d*(?:\/download-url)?)?))?)$/;

// Dependencies are injectable for local tests; production reads only the server environment.
export function createHandler({ fetchImpl = fetch, getKey = () => process.env.CURSEFORGE_API_KEY } = {}) {
  return async (request) => {
    const url = new URL(request.url);
    const prefix = "/api/v1/";
    if (!url.pathname.startsWith(prefix)) return json(404, "Unknown API endpoint");
    const path = url.pathname.slice(prefix.length);
    let body;
    if (request.method === "GET") {
      if (!allowedGet.test(path)) return json(404, "Unknown API endpoint");
      if (url.search.length > 4096) return json(400, "Query is too long");
    } else if (request.method === "POST") {
      const field = path === "mods" ? "modIds" : path === "mods/files" ? "fileIds" : null;
      if (!field) return json(404, "Unknown API endpoint");
      if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json(415, "JSON is required");
      // Bound the streamed body too: Content-Length may be missing or forged.
      const reader = request.body?.getReader();
      if (!reader) return json(400, "Missing batch body");
      let size = 0;
      const parts = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 16384) { await reader.cancel(); return json(413, "Batch body is too large"); }
          parts.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.length; }
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        const ids = parsed?.[field];
        if (!parsed || Object.keys(parsed).length !== 1 || !Array.isArray(ids) || !ids.length || ids.length > 100
          || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) return json(400, "Batch requires 1 to 100 positive IDs");
        body = JSON.stringify({ [field]: [...new Set(ids)] });
      } catch { return json(400, "Invalid JSON batch body"); }
    } else return json(405, "Only GET and POST are supported");

    const key = getKey();
    if (!key) return json(503, "CurseForge relay is not configured");
    const target = new URL(`https://api.curseforge.com/v1/${path}`);
    if (request.method === "GET") target.search = url.search;
    try {
      const upstream = await fetchImpl(target, {
        method: request.method, body, redirect: "error", signal: AbortSignal.timeout(25000),
        headers: { "x-api-key": key, Accept: "application/json", "User-Agent": "SLH-CurseForge-Relay/1.0",
          ...(body ? { "Content-Type": "application/json" } : {}) },
      });
      // No client headers, cookies, secrets or upstream redirects are forwarded.
      const headers = new Headers({ "Cache-Control": "no-store", "Content-Type": "application/json" });
      const retry = upstream.headers.get("Retry-After");
      if (retry) headers.set("Retry-After", retry);
      if (upstream.status >= 300 && upstream.status < 400) return json(502, "Unexpected upstream redirect");
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch { return json(502, "CurseForge is temporarily unavailable"); }
  };
}

export default createHandler();
export const config = {
  path: "/api/v1/*",
  rateLimit: { windowLimit: 100, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
