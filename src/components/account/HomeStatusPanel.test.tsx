// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HomeStatusPanel } from "./HomeStatusPanel";
import { storageUsageCache, markStorageChanged } from "../../lib/storageUsage";

const mocks = vi.hoisted(() => ({ command: vi.fn(), active: true, bootstrap: {
  version: "0.2.0", portableRoot: "test-root", settings: { appearance: {
    homeStatusVisible: ["memory", "cpu", "gpu", "storage"], homeMetricsScope: "launcher",
  }, minecraft: { javaMode: "auto" } },
} }));
vi.mock("../../lib/tauri", () => ({ command: mocks.command }));
vi.mock("../../lib/windowActivity", () => ({ useWindowActivity: () => mocks.active }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../i18n/I18nProvider", () => ({ useI18n: () => ({ tr: (value: string) => value, locale: "en-US" }) }));
vi.mock("./HomeStatusContextMenu", () => ({ HomeStatusContextMenu: () => null }));
vi.mock("../../stores/appStore", () => ({ useAppStore: (select: (state: unknown) => unknown) => select({
  bootstrap: mocks.bootstrap, activities: [], pushToast: vi.fn(),
}) }));
beforeEach(() => {
  vi.useFakeTimers(); storageUsageCache.clear(); mocks.active = true;
  mocks.bootstrap.settings.appearance.homeStatusVisible = ["memory", "cpu", "gpu", "storage"];
  mocks.bootstrap.settings.appearance.homeMetricsScope = "launcher";
  mocks.command.mockReset().mockImplementation(async (name: string) => name === "get_launcher_storage_usage" ? 12 : {});
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("ignores legacy metric preferences and refreshes storage only when files change", async () => {
  await act(async () => { render(<HomeStatusPanel />); });
  expect(mocks.command.mock.calls.some(([name]) => name === "get_system_metrics")).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(mocks.command.mock.calls.filter(([name]) => name === "get_system_metrics")).toHaveLength(0);
  expect(mocks.command.mock.calls.filter(([name]) => name === "get_launcher_storage_usage")).toHaveLength(1);
  await act(async () => { markStorageChanged(); });
  expect(mocks.command.mock.calls.filter(([name]) => name === "get_launcher_storage_usage")).toHaveLength(2);
});

it("defers invalidated storage while minimized and refreshes when restored", async () => {
  const view = render(<HomeStatusPanel />);
  await act(async () => {});
  mocks.active = false;
  view.rerender(<HomeStatusPanel />);
  const count = mocks.command.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(mocks.command).toHaveBeenCalledTimes(count);
  await act(async () => { markStorageChanged(); });
  expect(mocks.command).toHaveBeenCalledTimes(count);
  mocks.active = true;
  await act(async () => { view.rerender(<HomeStatusPanel />); });
  expect(mocks.command.mock.calls.filter(([name]) => name === "get_launcher_storage_usage")).toHaveLength(2);
});

it("does not scan storage when hidden in the status layout", async () => {
  mocks.bootstrap.settings.appearance.homeStatusVisible = ["cpu", "gpu", "memory"];
  await act(async () => { render(<HomeStatusPanel />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(mocks.command).not.toHaveBeenCalled();
});
