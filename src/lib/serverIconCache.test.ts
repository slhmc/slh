import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("./tauri", () => ({ command: mocks.command }));
let cache: typeof import("./serverIconCache");
beforeEach(async () => { vi.resetModules(); mocks.command.mockReset(); cache = await import("./serverIconCache"); });
it("retains the displayed image while refreshing and shares concurrent requests", async () => {
  mocks.command.mockResolvedValueOnce("old-image");
  await cache.refreshServerIcon("server");
  let resolve!: (image: string) => void;
  mocks.command.mockReturnValueOnce(new Promise<string>(done => { resolve = done; }));
  const request = cache.refreshServerIcon("server");
  expect(cache.refreshServerIcon("server")).toBe(request);
  expect(cache.cachedServerIcon("server")).toBe("old-image");
  resolve("new-image"); await request;
  expect(cache.cachedServerIcon("server")).toBe("new-image");
  expect(mocks.command).toHaveBeenCalledTimes(2);
});
it("does not replace a newly chosen image with an older pending request", async () => {
  let resolve!: (image: string) => void;
  mocks.command.mockReturnValueOnce(new Promise<string>(done => { resolve = done; })).mockResolvedValueOnce("new-image");
  const old = cache.refreshServerIcon("server", 0);
  await cache.refreshServerIcon("server", 1);
  resolve("old-image"); await old;
  expect(cache.cachedServerIcon("server")).toBe("new-image");
});
