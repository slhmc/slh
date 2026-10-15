// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { LauncherUpdateDialog, requestLauncherUpdate } from "./LauncherUpdateDialog";
import { useAppStore } from "../../stores/appStore";
const mocks = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mocks.relaunch }));
vi.mock('../../i18n/I18nProvider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => { vi.resetAllMocks(); useAppStore.setState({ activities: [], bootstrap: null }); });
afterEach(cleanup);
function open() {
  render(<LauncherUpdateDialog />);
  act(() => { requestLauncherUpdate({ latestVersion: '0.2.2', updateAvailable: true } as never); });
}
it('waits for explicit installation and restarts only after a successful verified install', async () => {
  const downloadAndInstall = vi.fn().mockResolvedValue(undefined), close = vi.fn().mockResolvedValue(undefined);
  mocks.check.mockResolvedValue({ downloadAndInstall, close }); mocks.relaunch.mockResolvedValue(undefined);
  open(); expect(mocks.check).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'updater.install' }));
  await waitFor(() => expect(downloadAndInstall).toHaveBeenCalledOnce());
  await screen.findByRole('button', { name: 'updater.restart' }); expect(mocks.relaunch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'updater.restart' }));
  await waitFor(() => expect(mocks.relaunch).toHaveBeenCalledOnce()); expect(close).toHaveBeenCalledOnce();
});
it('keeps the launcher usable and never restarts after a signature error', async () => {
  const close = vi.fn().mockResolvedValue(undefined);
  mocks.check.mockResolvedValue({ downloadAndInstall: vi.fn().mockRejectedValue(new Error('invalid signature')), close });
  open(); fireEvent.click(screen.getByRole('button', { name: 'updater.install' }));
  await screen.findByRole('alert'); expect(screen.getByRole('button', { name: 'updater.install' }).hasAttribute('disabled')).toBe(false);
  expect(mocks.relaunch).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
});
it('does not install while Minecraft files are being downloaded', () => {
  useAppStore.setState({ activities: [{ operationId: 'installing' }] as never }); open();
  expect(screen.getByRole('button', { name: 'updater.install' }).hasAttribute('disabled')).toBe(true);
  expect(mocks.check).not.toHaveBeenCalled();
});
