// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ServerPlayerList } from "./ServerPlayerList";
import type { LocalServer } from "../../lib/localServers";

const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ command: mocks.command }));
vi.mock("../../i18n/UiText", () => ({ useUiText: () => (key: string) => key }));
vi.mock("../../lib/windowActivity", () => ({ useWindowActivity: () => false }));
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); }; HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); }; });
afterEach(() => { cleanup(); mocks.command.mockReset(); });

it("adds a player using automatic identity resolution", async () => {
  const lists = { whitelist: [], operators: [], bannedPlayers: [], bannedIps: [], revisions: { whitelist: "r1", operators: "r1", bannedPlayers: "r1", bannedIps: "r1" }, whitelistEnabled: false, operatorLevel: 4, runtimeState: "stopped" };
  mocks.command.mockResolvedValue(lists);
  render(<ServerPlayerList server={{ id: "fixture", status: "stopped" } as LocalServer} kind="whitelist" />);
  fireEvent.click(await screen.findByText("serverPlayers.addActions.whitelist"));
  expect(screen.queryByText("serverPlayers.identityProvider")).toBeNull();
  expect(screen.queryByText("serverPlayers.identityHintV2")).toBeNull();
  fireEvent.change(screen.getByLabelText("serverPlayers.name"), { target: { value: "Alex" } });
  fireEvent.click(screen.getByRole("button", { name: "serverPlayers.add" }));
  fireEvent.click(screen.getByRole("button", { name: "localServers.confirm" }));
  await waitFor(() => expect(mocks.command).toHaveBeenCalledWith("edit_server_players", expect.objectContaining({ request: expect.objectContaining({ kind: "whitelist", name: "Alex", identityProvider: "auto", expectedRevision: "r1" }) })));
});
