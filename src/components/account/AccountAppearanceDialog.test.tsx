// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { AccountAppearanceDialog } from "./AccountAppearanceDialog";
import type { Account, AccountAppearance } from "../../lib/types";

const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ command: mocks.command }));
vi.mock("../../i18n/UiText", () => ({ useUiText: () => (key: string, fallback?: string) => fallback ?? key }));
vi.mock("../../lib/windowActivity", () => ({ useWindowActivity: () => true }));
vi.mock("./MinecraftSkinViewer", () => ({ MinecraftSkinViewer: ({ label, cape }: { label: string; cape?: string | null }) => <span data-testid="appearance-preview" data-cape={cape ?? "none"}>{label}</span> }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
beforeEach(() => { mocks.command.mockReset(); });
afterEach(cleanup);

function appearance(provider: AccountAppearance["provider"]): AccountAppearance {
  return { accountId: "test", provider, username: "Player", canChangeSkin: provider !== "elyby", canChangeCape: provider === "microsoft", message: null, skins: [], capes: [] };
}

it("opens the offline editor, uploads a selected skin/model and never changes a cape", async () => {
  const value = appearance("offline");
  mocks.command.mockImplementation(async (name: string, args: any) => name === "get_account_appearance" ? value : {
    ...value, skins: [{ id: "local-skin", dataUrl: "data:image/png;base64,AA==", variant: args.variant, alias: "Alex", active: true }],
  });
  const changed = vi.fn();
  render(<AccountAppearanceDialog account={{ id: "test", username: "Player", provider: "offline" } as Account} onClose={vi.fn()} onChanged={changed} />);
  await screen.findByRole("tab", { name: "Skin" });
  fireEvent.click(screen.getByRole("button", { name: "Alex" }));
  fireEvent.click(screen.getByRole("button", { name: "Customize" }));
  expect(screen.getByRole("tab", { name: "Cape" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Wide" }));
  fireEvent.click(screen.getByRole("button", { name: "Save skin" }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  const upload = mocks.command.mock.calls.find(([name]) => name === "upload_account_skin_bytes");
  expect(upload?.[1]).toMatchObject({ accountId: "test", variant: "classic", fileName: "alex.png" });
  expect(upload?.[1].pngBytes.slice(0, 4)).toEqual([137, 80, 78, 71]);
  expect(mocks.command.mock.calls.some(([name]) => name === "select_account_cape")).toBe(false);
});

it("offers the Ely.by website when the editor is opened directly", async () => {
  mocks.command.mockResolvedValue(appearance("elyby"));
  render(<AccountAppearanceDialog account={{ id: "test", username: "Player", provider: "elyby" } as Account} onClose={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "Manage on Ely.by" })).toBeTruthy();
});

it("preserves cape controls for Microsoft accounts", async () => {
  mocks.command.mockResolvedValue(appearance("microsoft"));
  render(<AccountAppearanceDialog account={{ id: "test", username: "Player", provider: "microsoft" } as Account} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("tab", { name: "Cape" }));
  expect(screen.getByRole("button", { name: "None" }).hasAttribute("disabled")).toBe(false);
});


it("opens on skins, exposes capes directly and applies only the selected cape", async () => {
  const value = {...appearance("microsoft"), capes:[{id:"cape-1",alias:"Aurora",active:false,dataUrl:null}]};
  mocks.command.mockResolvedValue(value);
  const close = vi.fn();
  render(<AccountAppearanceDialog account={{id:"test",username:"Player",provider:"microsoft"} as Account} onClose={close} />);
  expect((await screen.findByRole("tab",{name:"Skin"})).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("tab",{name:"Saved skins"})).toBeNull();
  expect(screen.queryByRole("tab",{name:"Default skins"})).toBeNull();
  fireEvent.click(screen.getByRole("tab",{name:"Cape"}));
  fireEvent.click(screen.getByRole("button",{name:"Aurora"}));
  fireEvent.click(screen.getByRole("button",{name:"Apply"}));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(mocks.command).toHaveBeenCalledWith("select_account_cape",{accountId:"test",capeId:"cape-1"});
  expect(mocks.command.mock.calls.some(([name]) => name === "upload_account_skin_bytes")).toBe(false);
});


it("keeps an unapplied cape, including None, in the preview when switching tabs", async () => {
  mocks.command.mockResolvedValue({...appearance("microsoft"), capes:[
    {id:"current",alias:"Current cape",active:true,dataUrl:"current.png"},
    {id:"draft",alias:"Draft cape",active:false,dataUrl:"draft.png"},
  ]});
  render(<AccountAppearanceDialog account={{id:"test",username:"Player",provider:"microsoft"} as Account} onClose={vi.fn()} />);
  await screen.findByRole("tab",{name:"Skin"});
  expect(screen.getByTestId("appearance-preview").getAttribute("data-cape")).toBe("current.png");
  fireEvent.click(screen.getByRole("tab",{name:"Cape"}));
  fireEvent.click(screen.getByRole("button",{name:"Draft cape"}));
  fireEvent.click(screen.getByRole("tab",{name:"Skin"}));
  expect(screen.getByTestId("appearance-preview").getAttribute("data-cape")).toBe("draft.png");
  fireEvent.click(screen.getByRole("tab",{name:"Cape"}));
  expect(screen.getByRole("button",{name:"Draft cape"}).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button",{name:"None"}));
  fireEvent.click(screen.getByRole("tab",{name:"Skin"}));
  expect(screen.getByTestId("appearance-preview").getAttribute("data-cape")).toBe("none");
  expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(["get_account_appearance"]);
});
