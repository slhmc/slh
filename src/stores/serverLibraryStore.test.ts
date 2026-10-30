import { beforeEach, expect, it, vi } from "vitest";
import type { ServerOverview } from "../lib/localServers";
const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../lib/tauri", () => ({ command: mocks.command }));
vi.mock("../lib/serverIconCache", () => ({ primeServerIcons: vi.fn() }));
let store: typeof import("./serverLibraryStore").useServerLibraryStore;
const overview = (directory: string): ServerOverview => ({ directory, defaultDirectory: directory, servers: [], groups: [], defaults: { directory: null, config: {} as ServerOverview["defaults"]["config"] }, view: { view: "grid" } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(async () => { vi.resetModules(); mocks.command.mockReset(); store = (await import("./serverLibraryStore")).useServerLibraryStore; });
it("keeps the previous overview usable during a slow or failed background refresh", async () => {
  const first = overview("first");
  mocks.command.mockResolvedValueOnce(first);
  await store.getState().refresh();
  const delayed = deferred<ServerOverview>();
  mocks.command.mockReturnValueOnce(delayed.promise);
  const refresh = store.getState().refresh();
  expect(store.getState().data).toBe(first);
  delayed.resolve(overview("updated")); await refresh;
  expect(store.getState().data?.directory).toBe("updated");
  mocks.command.mockRejectedValueOnce(Error("offline"));
  await expect(store.getState().refresh()).rejects.toThrow("offline");
  expect(store.getState().data?.directory).toBe("updated");
});
it("ignores an older response that finishes after a newer overview", async () => {
  const old = deferred<ServerOverview>();
  mocks.command.mockReturnValueOnce(old.promise).mockResolvedValueOnce(overview("new"));
  const request = store.getState().refresh(); await store.getState().refresh();
  old.resolve(overview("old")); await request;
  expect(store.getState().data?.directory).toBe("new");
});
it("keeps optimistic view changes while their queued save is pending", async () => {
  store.setState({ data: overview("root") });
  const saved = deferred<void>(); const response = deferred<ServerOverview>();
  mocks.command.mockImplementation(name => name === "save_server_library_view" ? saved.promise : response.promise);
  const write = store.getState().saveView({ view: "list", selected: "server" });
  const refresh = store.getState().refresh();
  saved.resolve(); await write;
  response.resolve(overview("root")); await refresh;
  expect(store.getState().data?.view).toEqual({ view: "list", selected: "server" });
});
it("does not restore a deleted server from a pending response", async () => {
  const data = { ...overview("root"), servers: [{ id: "removed" }] } as ServerOverview;
  store.setState({ data });
  const response = deferred<ServerOverview>(); mocks.command.mockReturnValueOnce(response.promise);
  const request = store.getState().refresh();
  store.getState().removeServer("removed"); response.resolve(data); await request;
  expect(store.getState().data?.servers).toEqual([]);
});
it("reuses a running scan and avoids rescanning fresh folders on reentry", async () => {
  const response = deferred<ServerOverview>(); mocks.command.mockReturnValueOnce(response.promise);
  const scan = store.getState().synchronize();
  expect(store.getState().scanIfStale()).toBe(scan);
  response.resolve(overview("root")); await scan;
  await store.getState().scanIfStale();
  expect(mocks.command).toHaveBeenCalledTimes(1);
});
