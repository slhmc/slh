// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { RequestCache } from "./requestCache";

afterEach(() => { window.dispatchEvent(new Event("slh-release-scenes")); vi.useRealTimers(); });

it("releases expired values without waiting for another search", async () => {
  vi.useFakeTimers();
  const cache = new RequestCache<object>(1000);
  await cache.load("old", async () => ({ body: "large description" }));
  expect(cache.peek("old", true)).toBeDefined();
  vi.advanceTimersByTime(1001);
  expect(cache.peek("old", true)).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not resurrect a released cache when an old request finishes", async () => {
  const cache = new RequestCache<string>(1000);
  let finish!: (value: string) => void;
  const pending = cache.load("page", () => new Promise<string>(resolve => { finish = resolve; }));
  cache.clear();
  await cache.load("page", async () => "new");
  finish("old");
  expect(await pending).toBe("old");
  expect(cache.peek("page")).toBe("new");
  window.dispatchEvent(new Event("slh-release-scenes"));
  expect(cache.peek("page", true)).toBeUndefined();
});

it("deduplicates concurrent requests and bounds recently visited pages", async () => {
  const cache = new RequestCache<string>(1000, 2);
  const fetch = vi.fn(async () => "one");
  await Promise.all([cache.load("one", fetch), cache.load("one", fetch)]);
  expect(fetch).toHaveBeenCalledTimes(1);
  await cache.load("two", async () => "two");
  await cache.load("three", async () => "three");
  expect(cache.peek("one", true)).toBeUndefined();
  expect(cache.peek("two")).toBe("two");
  cache.clear();
});
