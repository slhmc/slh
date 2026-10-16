// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "./I18nProvider";
const mocks = vi.hoisted(() => ({ revision: "one", command: vi.fn(), activity: null as null | ((visible: boolean) => void) }));
vi.mock("../lib/tauri", () => ({ command: mocks.command }));
vi.mock("../lib/windowActivity", () => ({ subscribeWindowActivity: (callback: (visible: boolean) => void) => { mocks.activity=callback; callback(true); return () => { mocks.activity=null; }; } }));
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("polls only the revision while retaining an edited form, and reloads changed files", async () => {
  vi.useFakeTimers();
  mocks.revision = "one";
  mocks.command.mockReset().mockImplementation(async (name: string) => name === "get_locale_revision" ? mocks.revision : {
    code: "en-US", messages: { common: { close: "Close" } }, locales: [], diagnostics: [], valid: true,
  });
  const view = render(<I18nProvider locale="en-US"><input defaultValue="draft" /></I18nProvider>);
  await act(async () => {});
  for (let i = 0; i < 3; i++) await act(async () => { vi.advanceTimersByTime(1500); });
  const snapshots = () => mocks.command.mock.calls.filter(([name]) => name === "get_locale_snapshot");
  expect(snapshots()).toHaveLength(1);
  mocks.revision = "two";
  await act(async () => { vi.advanceTimersByTime(1500); });
  expect(snapshots()).toHaveLength(2);
  await act(async () => { window.dispatchEvent(new Event("slh-refresh-languages")); });
  expect(snapshots()).toHaveLength(3);
  expect(view.container.querySelector("input")!.value).toBe("draft");
  await act(async () => { mocks.activity!(false); });
  expect(vi.getTimerCount()).toBe(0);
  const calls=mocks.command.mock.calls.length;
  await act(async () => { vi.advanceTimersByTime(3000); });
  expect(mocks.command).toHaveBeenCalledTimes(calls);
  await act(async () => { mocks.activity!(true); });
  expect(vi.getTimerCount()).toBe(1);
});
