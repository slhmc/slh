// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ServerProfileDialog } from "./ServerProfileDialog";
import { defaultServerConfig, type ServerOverview } from "../../lib/localServers";
const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ command: mocks.command }));
vi.mock("../../i18n/UiText", () => ({ useUiText: () => (key: string) => key }));
vi.mock("./ServerConfigFields", () => ({ ServerConfigFields: () => null }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); mocks.command.mockReset(); });
const overview: ServerOverview = { servers: [], groups: [], defaults: { directory: null, config: defaultServerConfig() }, directory: "servers", defaultDirectory: "servers" };

it("requires EULA acceptance before enabling blank-name guidance", () => {
  render(<ServerProfileDialog overview={overview} groupId={null} onClose={() => {}} onChanged={() => {}} />);
  const create = screen.getByRole("button", { name: "localServers.createServer" });
  const name = screen.getByLabelText("localServers.name");
  expect(create.hasAttribute("disabled")).toBe(true);
  fireEvent.click(create);
  expect(name.getAttribute("aria-invalid")).toBe("false");
  expect(mocks.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(create.hasAttribute("disabled")).toBe(false);
  fireEvent.click(create);
  expect(document.activeElement).toBe(name);
  expect(name.getAttribute("aria-invalid")).toBe("true");
  expect(mocks.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(create.hasAttribute("disabled")).toBe(true);
});
