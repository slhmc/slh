import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "./netlify/functions/curseforge.mjs";
const request = (path, body) => new Request(`https://relay.test/api/v1/${path}`, body === undefined ? {} : {
  method: "POST", headers: { "Content-Type": "application/json", "x-api-key": "untrusted-client-key" }, body: JSON.stringify(body),
});
test("batch endpoints forward validated IDs and only the server key", async () => {
  const calls = [];
  const handler = createHandler({ getKey: () => "test-server-key", fetchImpl: async (url, options) => {
    calls.push({ url: String(url), ...options }); return Response.json({ data: [] });
  } });
  for (const [path, field] of [["mods", "modIds"], ["mods/files", "fileIds"]]) {
    assert.equal((await handler(request(path, { [field]: [1, 2, 2] }))).status, 200);
    const call = calls.at(-1);
    assert.equal(call.url, `https://api.curseforge.com/v1/${path}`);
    assert.deepEqual(JSON.parse(call.body), { [field]: [1, 2] });
    assert.equal(call.headers["x-api-key"], "test-server-key");
    assert.equal(call.redirect, "error");
  }
});
test("invalid endpoints, IDs and oversized bodies never reach upstream", async () => {
  const handler = createHandler({ getKey: () => "test", fetchImpl: () => { throw Error("Must not be called"); } });
  for (const body of [{ fileIds: [] }, { fileIds: [-1] }, { fileIds: ["1"] }, { fileIds: Array(101).fill(1) }, { fileIds: [1], extra: true }]) {
    assert.equal((await handler(request("mods/files", body))).status, 400);
  }
  assert.equal((await handler(request("mods/files", { fileIds: ["x".repeat(20000)] }))).status, 413);
  assert.equal((await handler(request("users/1"))).status, 404);
});
test("GET preserves queries, HTTP 429 and Retry-After without exposing secrets", async () => {
  const handler = createHandler({ getKey: () => "test", fetchImpl: async (url) => {
    assert.equal(String(url), "https://api.curseforge.com/v1/mods/search?gameId=432&pageSize=1");
    return new Response('{"error":"limited"}', { status: 429, headers: { "Retry-After": "30", "x-api-key": "test", "Set-Cookie": "secret" } });
  } });
  const result = await handler(request("mods/search?gameId=432&pageSize=1"));
  assert.equal(result.status, 429);
  assert.equal(result.headers.get("Retry-After"), "30");
  assert.equal(result.headers.get("x-api-key"), null);
  assert.equal(result.headers.get("Set-Cookie"), null);
});
test("unconfigured relay and network failures return safe errors", async () => {
  assert.equal((await createHandler({ getKey: () => undefined })(request("games/432"))).status, 503);
  const result = await createHandler({ getKey: () => "secret", fetchImpl: async () => { throw Error("secret"); } })(request("games/432"));
  assert.equal(result.status, 502);
  assert.ok(!(await result.text()).includes("secret"));
});
