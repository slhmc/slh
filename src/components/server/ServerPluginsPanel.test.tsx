// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ServerPluginsPanel } from "./ServerPluginsPanel";
import { defaultServerConfig, type LocalServer } from "../../lib/localServers";
import type { ModrinthSearchResult } from "../../lib/types";
const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../common/AutoFitTitle", () => ({ AutoFitTitle: ({ text }: { text: string }) => <h2>{text}</h2> }));
vi.mock("../../lib/tauri", () => ({ command: mocks.command }));
vi.mock("../../i18n/I18nProvider", () => ({ useI18n: () => ({ locale: "en-US" }) }));
vi.mock("../../i18n/UiText", () => ({ useUiText: () => (key: string) => key }));
vi.mock("../../stores/appStore", () => ({ useAppStore: (select: (state: unknown) => unknown) => select({ bootstrap: null }) }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const server: LocalServer = { id: "test", name: "Test", path: "test", config: { ...defaultServerConfig(), core: "paper" }, status: "stopped", groupId: null, installed: true, createdAt: "" };
function result(title: string): ModrinthSearchResult {
  return { hits: [{ projectId: title, slug: title, title, description: title, projectType: "plugin", iconUrl: null, downloads: 1, follows: 0, author: "Test", categories: [], versions: [], dateModified: "" }], totalHits: 1, offset: 0, limit: 20 };
}
it("ignores a stale provider response", async () => {
  let oldResponse!: (value: ModrinthSearchResult) => void;
  mocks.command.mockImplementation((name: string, args: { provider: string }) => {
    if (name === "list_server_plugins") return Promise.resolve([]);
    if (args.provider === "modrinth") return new Promise(resolve => { oldResponse = resolve; });
    return Promise.resolve(result("Current provider"));
  });
  render(<ServerPluginsPanel server={server} />);
  fireEvent.click(screen.getByRole("button", { name: "serverWorkspace.browsePlugins" }));
  await waitFor(() => expect(oldResponse).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "CurseForge" }));
  await screen.findByRole("heading", { name: "Current provider" });
  await act(async () => { oldResponse(result("Stale provider")); });
  expect(screen.queryByText("Stale provider")).toBeNull();
  expect(screen.getAllByText("Current provider").length).toBeGreaterThan(0);
});
it("keeps install disabled when no compatible versions exist", async () => {
  mocks.command.mockImplementation((name: string) => Promise.resolve(name === "search_server_plugins" ? result("Plugin") : []));
  render(<ServerPluginsPanel server={server} />);
  fireEvent.click(screen.getByRole("button", { name: "serverWorkspace.browsePlugins" }));
  fireEvent.click(await screen.findByRole("button", { name: "serverWorkspace.chooseVersion" }));
  await screen.findByText("localServers.noBuilds");
  expect(screen.getByRole("button", { name: "serverWorkspace.review" }).hasAttribute("disabled")).toBe(true);
  expect(mocks.command.mock.calls.some(([name]) => name === "install_server_plugin")).toBe(false);
});
