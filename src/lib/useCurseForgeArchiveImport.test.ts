// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCurseForgeArchiveImport } from "./useCurseForgeArchiveImport";
const mocks = vi.hoisted(() => ({ command: vi.fn(), install: vi.fn(), jobs: [] as unknown[] }));
vi.mock("./tauri", () => ({ isTauri: true, command: mocks.command }));
vi.mock("../stores/packJobs", () => ({ runPackInstall: mocks.install, usePackJobs: { getState: () => ({ jobs: mocks.jobs }) } }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

it("does no folder polling when automatic import is off", async () => {
  renderHook(() => useCurseForgeArchiveImport(false));
  expect(mocks.command).not.toHaveBeenCalled();
});

it("waits for stable downloads, imports only CurseForge ZIPs and avoids repeated imports", async () => {
  vi.useFakeTimers();
  mocks.command.mockImplementation(async (name: string, args?: {archivePath: string}) => {
    if (name === "scan_curseforge_archives") return [["broken.zip", "broken-v1"], ["pack.zip", "pack-v1"], ["other.zip", "other-v1"]];
    if (args?.archivePath === "broken.zip") throw new Error("ZIP is still incomplete");
    return { canImport: true, archiveType: args?.archivePath === "pack.zip" ? "curseforge" : "slh", name: "Pack", minecraftVersion: "1.21.1", loaderType: "fabric" };
  });
  mocks.install.mockResolvedValue({ id: "installed" });
  const hook = renderHook(() => useCurseForgeArchiveImport(true));
  await act(async () => {});
  expect(mocks.install).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(mocks.install).toHaveBeenCalledTimes(1);
  expect(mocks.install.mock.calls[0][0]).toMatchObject({ commandName: "import_curseforge_pack", args: { request: {archivePath: "pack.zip"} } });
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(mocks.install).toHaveBeenCalledTimes(1);
  hook.unmount();
  const calls = mocks.command.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(mocks.command).toHaveBeenCalledTimes(calls);
});
