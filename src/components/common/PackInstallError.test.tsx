// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PackInstallError } from "./PackInstallError";
const mocks = vi.hoisted(() => ({ command: vi.fn(), openUrl: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ command: mocks.command }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../i18n/I18nProvider", () => ({ useI18n: () => ({ tr: (text: string) => text }) }));
const message = "curseforge-manual:\n- [First](https://www.curseforge.com/minecraft/mc-mods/first/files/1) — `first.jar`\n- [Second](https://www.curseforge.com/minecraft/mc-mods/second/files/2) — `second.jar`";
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
it("opens all required official file pages from one button", async () => {
  mocks.command.mockResolvedValue([]);
  render(<PackInstallError message={message} busy={false} onRetry={vi.fn()} onError={vi.fn()} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open download pages" })); });
  expect(mocks.openUrl.mock.calls).toEqual([
    ["https://www.curseforge.com/minecraft/mc-mods/first/download/1"],
    ["https://www.curseforge.com/minecraft/mc-mods/second/download/2"],
  ]);
});
it("waits for all downloads, resumes once, and stops scanning after closing", async () => {
  vi.useFakeTimers();
  let signatures = ["first.jar\0first (1).jar:100:time"];
  mocks.command.mockImplementation(async () => signatures);
  const retry = vi.fn().mockResolvedValue(undefined);
  const view = render(<PackInstallError message={message} busy={false} onRetry={retry} onError={vi.fn()} />);
  await act(async () => { await Promise.resolve(); });
  expect(retry).not.toHaveBeenCalled();
  signatures = [...signatures, "second.jar\0second.jar:100:time"];
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(retry).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(retry).toHaveBeenCalledTimes(1);
  view.unmount();
  const calls = mocks.command.mock.calls.length;
  await vi.advanceTimersByTimeAsync(6000);
  expect(mocks.command).toHaveBeenCalledTimes(calls);
});
