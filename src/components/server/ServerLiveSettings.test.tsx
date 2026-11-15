// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ServerLiveSettings } from "./ServerLiveSettings";
import { defaultServerConfig, type LocalServer } from "../../lib/localServers";

const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ command: mocks.command }));
vi.mock("../../i18n/UiText", () => ({ useUiText: () => (key: string) => key }));
vi.mock("../../i18n/I18nProvider", () => ({ useI18n: () => ({ tr: (value: string) => value }) }));
vi.mock("../../lib/windowActivity", () => ({ useWindowActivity: () => false }));
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); }; HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); }; });
afterEach(() => { cleanup(); mocks.command.mockReset(); });
const server = { id: "fixture", status: "running", config: { ...defaultServerConfig(), minecraftVersion: "1.21.4" } } as LocalServer;

it("shows the actual command and missing-reply warning next to the submitted setting", async () => {
  mocks.command.mockResolvedValue({ command: "weather rain", lines: [] });
  render(<ServerLiveSettings server={server} />);
  const weather = screen.getByLabelText("serverLive.fields.weather");
  fireEvent.change(weather, { target: { value: "rain" } });
  const row = weather.closest('[class*="settingRow"]')! as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "serverLive.apply" }));
  expect(mocks.command).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "serverLive.apply" }));
  await waitFor(() => expect(within(row).getByRole("status").textContent).toContain("weather rain"));
  expect(within(row).getByRole("status").textContent).toContain("serverLive.noReply");
  expect(mocks.command).toHaveBeenCalledWith("apply_local_server_live", { serverId: "fixture", request: { kind: "weather", value: "rain" } });
});

it("updates availability from server status while inactive and blocks an obsolete confirmation", () => {
  const view = render(<ServerLiveSettings server={server} />);
  fireEvent.change(screen.getByLabelText("serverLive.fields.weather"), { target: { value: "rain" } });
  const weather = screen.getByLabelText("serverLive.fields.weather");
  fireEvent.click(within(weather.closest('[class*="settingRow"]')! as HTMLElement).getByRole("button", { name: "serverLive.apply" }));
  view.rerender(<ServerLiveSettings server={{ ...server, status: "stopped" }} />);
  expect(screen.getByLabelText("serverLive.fields.weather").hasAttribute("disabled")).toBe(true);
  expect(within(screen.getByRole("dialog")).getByRole("button", { name: "serverLive.apply" }).hasAttribute("disabled")).toBe(true);
  expect(mocks.command).not.toHaveBeenCalled();
});
