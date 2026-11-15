// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AppSidebar, sidebarPreferences } from "./AppSidebar";
import styles from "./AppSidebar.module.css";

vi.mock("../../lib/tauri", () => ({ command: vi.fn() }));
vi.mock("../brand/BrandLogo", () => ({ BrandLogo: () => null }));
vi.mock("../account/AccountAvatar", () => ({ AccountAvatar: () => null }));
vi.mock("../../i18n/I18nProvider", () => ({ useI18n: () => ({ tr: (text: string) => text, t: (_key: string, fallback: string) => fallback }) }));
vi.mock("../../stores/appStore", () => ({ useAppStore: (select: (state: unknown) => unknown) => select({
  bootstrap: { accounts: [], settings: { general: { navigationPosition: "top" } } },
  refresh: vi.fn(), setAccountPopoverOpen: vi.fn(), pushToast: vi.fn(),
}) }));
afterEach(cleanup);

it("ignores removed navigation items without rewriting stored preferences", () => {
  const general = JSON.parse('{"navigationOrder":["library","friends","settings"],"visibleNavigation":["library","friends"]}');
  const original = JSON.stringify(general);
  const preferences = sidebarPreferences(general);
  expect(preferences.order).not.toContain("friends");
  expect([...preferences.visible]).not.toContain("friends");
  expect(JSON.stringify(general)).toBe(original);
});

it.each(["general", "appearance", "minecraft", "java", "bedrock", "accounts", "storage", "downloads", "notifications", "sync", "console", "privacy", "advanced"])("keeps Settings active on /settings/%s", (section) => {
  render(<MemoryRouter initialEntries={[`/settings/${section}`]}><AppSidebar /></MemoryRouter>);
  const link = screen.getByRole("link", { name: "Settings" });
  expect(link.getAttribute("aria-current")).toBe("page");
  expect(link.classList.contains(styles.active)).toBe(true);
  expect(link.getAttribute("href")).toBe("/settings/general");
});

it("does not highlight Settings on the home page", () => {
  render(<MemoryRouter initialEntries={["/home"]}><AppSidebar /></MemoryRouter>);
  const link = screen.getByRole("link", { name: "Settings" });
  expect(link.hasAttribute("aria-current")).toBe(false);
  expect(link.classList.contains(styles.active)).toBe(false);
});

it.each(["overview", "mods", "settings", "logs"])("keeps Library active on instance %s", (tab) => {
  render(<MemoryRouter initialEntries={[`/instance/example?tab=${tab}`]}><AppSidebar /></MemoryRouter>);
  const link = screen.getByRole("link", { name: "Library" });
  expect(link.getAttribute("aria-current")).toBe("page");
  expect(link.classList.contains(styles.active)).toBe(true);
  expect(screen.getByRole("link", { name: "Settings" }).hasAttribute("aria-current")).toBe(false);
});
