// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ServerWhitelistToggle } from "./ServerWhitelistToggle";
import type { LocalServer } from "../../lib/localServers";
const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ command: mocks.command }));
vi.mock("../../i18n/UiText", () => ({ useUiText: () => (key: string) => key }));
vi.mock("../../i18n/I18nProvider", () => ({ useI18n: () => ({ tr: (value: string) => value }) }));
vi.mock("../../lib/windowActivity", () => ({ useWindowActivity: () => false }));
afterEach(() => { cleanup(); mocks.command.mockReset(); });

it("keeps the confirmed host value when a stale properties draft changes", async () => {
  mocks.command.mockResolvedValueOnce({ whitelistEnabled: true, runtimeState: "running" }).mockImplementation(() => new Promise(() => {}));
  const server = { id: "fixture", status: "running" } as LocalServer;
  const view = render(<ServerWhitelistToggle server={server} enabled />);
  const toggle = await screen.findByRole("checkbox");
  await vi.waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));
  view.rerender(<ServerWhitelistToggle server={server} enabled={false} />);
  expect((toggle as HTMLInputElement).checked).toBe(true);
  expect(mocks.command).toHaveBeenCalledTimes(2);
});
