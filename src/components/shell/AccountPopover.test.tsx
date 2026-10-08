// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountPopover } from "./AccountPopover";

const mocks = vi.hoisted(() => ({
  open: true, setOpen: vi.fn(), dock: "left", anchor: { left: 12, top: 650, width: 180, height: 55 },
  resized: undefined as (() => void) | undefined,
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../lib/tauri", () => ({ command: vi.fn() }));
vi.mock("../../i18n/I18nProvider", () => ({ useI18n: () => ({ tr: (text: string) => text }) }));
vi.mock("../account/AccountAvatar", () => ({ AccountAvatar: () => null }));
vi.mock("../../stores/appStore", () => ({ useAppStore: (select: (state: unknown) => unknown) => select({
  accountPopoverOpen: mocks.open, setAccountPopoverOpen: mocks.setOpen, refresh: vi.fn(), pushToast: vi.fn(),
  bootstrap: { accounts: [], providers: [], settings: { general: { navigationPosition: mocks.dock }, appearance: { scalePercent: 90 } } },
}) }));

beforeEach(() => {
  mocks.open = true; mocks.dock = "left"; mocks.anchor = { left: 12, top: 650, width: 180, height: 55 };
  mocks.setOpen.mockReset();
  const anchor = document.createElement("button");
  anchor.dataset.accountPopoverAnchor = "";
  document.body.append(anchor);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const value = this.hasAttribute("data-account-popover-anchor") ? mocks.anchor
      : this.tagName === "SECTION" ? { left: 0, top: 0, width: 350, height: 400 }
      : { left: 0, top: 40, width: 1200, height: 740 };
    return { ...value, right: value.left + value.width, bottom: value.top + value.height, x: value.left, y: value.top, toJSON: () => value };
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { mocks.resized = callback; }
    observe() {} disconnect() {}
  });
});
afterEach(() => { cleanup(); document.querySelector("[data-account-popover-anchor]")?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("follows the sidebar button when navigation changes while the menu is open", () => {
  const view = render(<AccountPopover />);
  expect(screen.getByLabelText("Account switcher").style.left).toBe("200px");
  mocks.dock = "right"; mocks.anchor = { left: 1008, top: 650, width: 180, height: 55 };
  view.rerender(<AccountPopover />);
  expect(screen.getByLabelText("Account switcher").style.left).toBe("650px");
  mocks.dock = "bottom"; mocks.anchor = { left: 900, top: 705, width: 180, height: 55 };
  view.rerender(<AccountPopover />);
  expect(screen.getByLabelText("Account switcher").style.top).toBe("257px");
});

it("remeasures a moved button on resize and unregisters Escape on close", () => {
  const view = render(<AccountPopover />);
  mocks.anchor = { left: 12, top: 550, width: 180, height: 55 };
  act(() => { mocks.resized?.(); });
  expect(screen.getByLabelText("Account switcher").style.top).toBe("165px");
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(mocks.setOpen).toHaveBeenCalledWith(false);
  mocks.setOpen.mockClear(); mocks.open = false;
  view.rerender(<AccountPopover />);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(mocks.setOpen).not.toHaveBeenCalled();
});
