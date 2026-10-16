// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ArchiveImportDialog } from "./ArchiveImportDialog";

const mocks = vi.hoisted(() => ({ command: vi.fn(), open: vi.fn(), openUrl: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ command: mocks.command }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("../../i18n/I18nProvider", () => ({ useI18n: () => ({
  tr: (text: string, params: Record<string, string> = {}) => text.replace(/\{(\w+)\}/g, (_, key) => params[key] ?? key),
}) }));
vi.mock("../common/Dialog", () => ({ Dialog: ({ open, children, footer }: { open: boolean; children: ReactNode; footer?: ReactNode }) => open ? <div role="dialog">{children}{footer}</div> : null }));
const inspection = { archiveType: "curseforge", name: "OneBlock", canImport: true, minecraftVersion: "1.19.2", loaderType: "forge", loaderVersion: "43.5.0" };
const manual = "Download files into `curseforge-manual`:\n\n- [Required mod](https://www.curseforge.com/minecraft/mc-mods/example/files/123)";
beforeEach(() => { mocks.command.mockReset(); mocks.open.mockReset(); mocks.openUrl.mockReset(); });
afterEach(cleanup);

it("keeps CurseForge import open with all manual-file links and resumes after selecting files", async () => {
  let attempts = 0;
  mocks.command.mockImplementation(async (name: string) => {
    if (name === "inspect_archive") return inspection;
    if (name === "run_pack_install") {
      if (++attempts === 1) throw { message: manual };
      return { id: "imported", name: "OneBlock" };
    }
    if (name === "add_curseforge_manual_files") return 1;
    throw new Error(`unexpected command ${name}`);
  });
  mocks.open.mockResolvedValue(["C:/Downloads/required.jar"]);
  const imported = vi.fn().mockResolvedValue(undefined);
  render(<ArchiveImportDialog archivePath="C:/Downloads/pack.zip" onClose={vi.fn()} onImported={imported} />);
  const select = await screen.findByRole("button", { name: "Choose downloaded files" });
  fireEvent.click(screen.getByRole("link", { name: "Required mod" }));
  expect(mocks.openUrl).toHaveBeenCalledWith("https://www.curseforge.com/minecraft/mc-mods/example/download/123");
  fireEvent.click(select);
  await waitFor(() => expect(imported).toHaveBeenCalledWith({ id: "imported", name: "OneBlock" }, "C:/Downloads/pack.zip"));
  expect(mocks.command).toHaveBeenCalledWith("add_curseforge_manual_files", { paths: ["C:/Downloads/required.jar"] });
  expect(attempts).toBe(2);
  expect(mocks.command.mock.calls.some(([name]) => name === "import_slh_archive")).toBe(false);
});

it("shows a useful cooldown message and allows retrying a rate-limited local ZIP import", async () => {
  let attempts = 0;
  mocks.command.mockImplementation(async (name: string) => {
    if (name === "inspect_archive") return inspection;
    if (++attempts === 1) throw { message: "This capability is unavailable: CurseForge is temporarily rate limited (HTTP 429). Retry in 60 seconds." };
    return { id: "imported" };
  });
  const imported = vi.fn().mockResolvedValue(undefined);
  render(<ArchiveImportDialog archivePath="pack.zip" onClose={vi.fn()} onImported={imported} />);
  await screen.findByText("CurseForge has temporarily limited requests. Please retry in 60 seconds.");
  fireEvent.click(screen.getByRole("button", { name: "Retry import" }));
  await waitFor(() => expect(imported).toHaveBeenCalledWith({ id: "imported" }, "pack.zip"));
});

it("does not start an installation for an unsupported archive", async () => {
  mocks.command.mockResolvedValue({ archiveType: "unknown", canImport: false, message: "No supported pack manifest was found" });
  render(<ArchiveImportDialog archivePath="invalid.zip" onClose={vi.fn()} onImported={vi.fn()} />);
  await screen.findByText("No supported pack manifest was found");
  expect(mocks.command).toHaveBeenCalledTimes(1);
});
