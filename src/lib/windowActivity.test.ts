// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { subscribeWindowActivity } from "./windowActivity";

const mocks = vi.hoisted(() => ({ minimized: false, resized: null as null | (() => Promise<void>), remove: vi.fn() }));
vi.mock("./tauri", () => ({ isTauri: true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  isVisible: async () => true, isMinimized: async () => mocks.minimized,
  onResized: async (callback: () => Promise<void>) => { mocks.resized = callback; return mocks.remove; },
  onFocusChanged: async () => mocks.remove,
}) }));
afterEach(() => { mocks.minimized = false; mocks.remove.mockClear(); vi.restoreAllMocks(); });

it("pauses native minimization even if document visibility has not changed, then resumes", async () => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const values: boolean[] = [];
  const unsubscribe = subscribeWindowActivity((value) => values.push(value));
  await vi.waitFor(() => expect(mocks.resized).not.toBeNull());
  mocks.minimized = true;
  await mocks.resized!();
  expect(values[values.length - 1]).toBe(false);
  mocks.minimized = false;
  await mocks.resized!();
  expect(values[values.length - 1]).toBe(true);
  unsubscribe();
  expect(mocks.remove).toHaveBeenCalledTimes(2);
  const count = values.length;
  await mocks.resized!();
  expect(values).toHaveLength(count);
});

it("removes listeners that finish registering after unmount", async () => {
  const callback = vi.fn();
  const unsubscribe = subscribeWindowActivity(callback);
  unsubscribe();
  await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(2));
  expect(callback).toHaveBeenCalledTimes(1);
});

it("shares native listeners until the last view unsubscribes", async () => {
  const first = vi.fn();
  const second = vi.fn();
  const stopFirst = subscribeWindowActivity(first);
  const stopSecond = subscribeWindowActivity(second);
  await vi.waitFor(() => expect(mocks.resized).not.toBeNull());
  window.dispatchEvent(new CustomEvent("slh-native-activity", { detail: false }));
  expect(first).toHaveBeenLastCalledWith(false);
  expect(second).toHaveBeenLastCalledWith(false);
  stopFirst();
  expect(mocks.remove).not.toHaveBeenCalled();
  window.dispatchEvent(new CustomEvent("slh-native-activity", { detail: true }));
  expect(second).toHaveBeenLastCalledWith(true);
  stopSecond();
  await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(2));
});
