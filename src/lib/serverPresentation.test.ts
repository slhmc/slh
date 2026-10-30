import { describe, expect, it } from "vitest";
import { moveBefore, normalizeServerTabs, toggleServerTab } from "./serverPresentation";

describe("server tabs", () => {
  it("restores defaults for legacy settings and normalizes unknown and duplicate ids", () => {
    expect(normalizeServerTabs({}).visible).toEqual(["overview", "settings", "console", "plugins"]);
    expect(normalizeServerTabs({ tabOrder: ["console", "gone", "console"] }).order).toEqual(["console", "overview", "settings", "plugins"]);
    expect(normalizeServerTabs({ visibleTabs: ["gone"] }).visible).toEqual(["overview"]);
  });
  it("keeps hidden tabs ordered and falls back when the active tab is hidden", () => {
    const next = toggleServerTab({ tabOrder: ["plugins", "console", "settings", "overview"] }, "plugins", "plugins");
    expect(next.current).toBe("console");
    expect(next.view.visibleTabs).toEqual(["console", "settings", "overview"]);
    expect(normalizeServerTabs(next.view).order[0]).toBe("plugins");
  });
  it("keeps the last tab and re-enables a hidden tab in its saved position", () => {
    const view = { visibleTabs: ["settings"] };
    expect(toggleServerTab(view, "settings", "settings")).toEqual({ view, current: "settings" });
    expect(toggleServerTab(view, "console", "settings").view.visibleTabs).toEqual(["settings", "console"]);
  });
});
it("inserts on either side and ignores self drops", () => {
  const items = ["a", "b", "c"];
  expect(moveBefore(items, "a", "b", true)).toEqual(["b", "a", "c"]);
  expect(moveBefore(items, "c", "a")).toEqual(["c", "a", "b"]);
  expect(moveBefore(items, "b", "b")).toBe(items);
});
