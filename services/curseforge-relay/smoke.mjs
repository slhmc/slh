const base = process.argv[2]?.replace(/\/$/, "");
if (!base || !/^https:\/\/[a-z0-9-]+(?:--[a-z0-9-]+)?\.netlify\.app$/.test(base)) throw Error("Supply the Netlify deploy URL");
for (const [path, body, expectedId] of [
  ["games/432", null, 432],
  ["mods/search?gameId=432&pageSize=1", null, null],
  ["mods", { modIds: [1204182] }, 1204182],
  ["mods/files", { fileIds: [8292539] }, 8292539],
]) {
  const started = performance.now();
  const result = await fetch(`${base}/api/v1/${path}`, {
    method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
    signal: AbortSignal.timeout(30000), redirect: "error",
  });
  if (!result.ok) throw Error(`${path}: HTTP ${result.status}`);
  const payload = await result.json();
  const items = Array.isArray(payload.data) ? payload.data : [payload.data];
  if (!items.length || (expectedId != null && !items.some((item) => item?.id === expectedId))) throw Error(`${path}: unexpected data`);
  console.log(`${body ? "POST" : "GET"} ${path}: HTTP 200, ${Math.round(performance.now() - started)} ms`);
}
