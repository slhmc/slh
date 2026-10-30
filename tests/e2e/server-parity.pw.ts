import { expect, test, type Page } from "@playwright/test";

async function workspace(page: Page) {
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
  return page.getByRole("navigation", { name: "Server sections" });
}
async function savedView(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("slh.previewServerLibrary")!).view);
}

test("server tab visibility, ordering and position persist independently of instances", async ({ page }) => {
  let nav = await workspace(page);
  await nav.getByRole("button", { name: "Plugins", exact: true }).click();
  await nav.click({ button: "right" });
  let menu = page.getByRole("menu", { name: "Server sections" });
  await menu.getByRole("menuitemcheckbox", { name: "Plugins", exact: true }).click();
  await expect(nav.getByRole("button", { name: "Plugins", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
  await menu.getByRole("menuitemcheckbox", { name: "Console", exact: true }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(async () => (await savedView(page)).tabOrder).toEqual(["overview", "console", "settings", "plugins"]);
  const hiddenPlugin = menu.getByRole("menuitemcheckbox", { name: "Plugins", exact: true });
  const source = await hiddenPlugin.boundingBox();
  const target = await menu.getByRole("menuitemcheckbox", { name: "Overview", exact: true }).boundingBox();
  await page.mouse.move(source!.x + 70, source!.y + source!.height / 2); await page.mouse.down();
  await page.mouse.move(target!.x + 70, target!.y + 2, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await savedView(page)).tabOrder).toEqual(["plugins", "overview", "console", "settings"]);
  await expect(hiddenPlugin).toHaveAttribute("aria-checked", "false");
  await expect(menu.getByRole("menuitemradio")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/server-parity-tabs-menu.png" });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await nav.getByRole("button", { name: "Settings", exact: true }).click();
  for (const side of ["top", "bottom", "left", "right"]) {
    await page.getByRole("combobox", { name: "Tab position", exact: true }).selectOption(side);
    await expect.poll(async () => (await savedView(page)).tabsPosition).toBe(side);
  }
  await page.reload();
  nav = page.getByRole("navigation", { name: "Server sections" });
  await expect(nav.getByRole("button", { name: "Plugins", exact: true })).toHaveCount(0);
  await nav.getByRole("button", { name: "Settings", exact: true }).focus();
  await page.keyboard.press("Shift+F10");
  menu = page.getByRole("menu", { name: "Server sections" });
  await menu.getByRole("menuitemcheckbox", { name: "Console", exact: true }).click();
  await menu.getByRole("menuitemcheckbox", { name: "Settings", exact: true }).click();
  await expect(menu.getByRole("menuitemcheckbox", { name: "Overview", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(nav.getByRole("button", { name: "Console", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("Server output", { exact: true })).toContainText("SLH browser preview");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
});

test("server console shares palette, filters, wrapping and non-destructive clear", async ({ page }) => {
  const nav = await workspace(page);
  await nav.getByRole("button", { name: "Console", exact: true }).click();
  const output = page.getByLabel("Server output", { exact: true });
  await expect(output).toContainText("Preview details");
  const colors = await output.locator("[data-log-level]").evaluateAll(lines => Object.fromEntries(lines.map(line => [line.getAttribute("data-log-level"), getComputedStyle(line).color])));
  expect(new Set(Object.values(colors)).size).toBe(4);
  await page.getByRole("textbox", { name: "Find in log", exact: true }).fill("Preview error");
  await expect(output).toContainText("Preview error");
  await expect(output).not.toContainText("Preview warning");
  await page.getByRole("button", { name: "Console actions", exact: true }).click();
  const wrap = page.getByRole("dialog").getByRole("button", { name: /^Wrap:/ });
  const previous = await wrap.getAttribute("aria-pressed");
  await wrap.click();
  await expect(wrap).toHaveAttribute("aria-pressed", previous === "true" ? "false" : "true");
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "Find in log", exact: true }).fill("");
  await page.screenshot({ path: "artifacts/server-parity-console-colors.png" });
  await page.getByRole("button", { name: "Console actions", exact: true }).click();
  await page.getByRole("button", { name: "Clear view", exact: true }).click();
  await expect(output).not.toContainText("SLH browser preview");
  // Wait through more than one poll to prove that old history stays cleared.
  await page.waitForTimeout(2100);
  await expect(output.locator("[data-log-level]")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/server-parity-console.png" });
});

test("server card menus do not open details and every view preserves selection", async ({ page }) => {
  await page.goto("/#/local-servers");
  for (const mode of ["Grid view", "Grouped icons", "List view"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    const card = page.getByRole("button", { name: "Weekend", exact: true });
    await card.click();
    await expect(card).toHaveAttribute("aria-pressed", "true");
    const menuButton = card.getByRole("button", { name: "Actions for Weekend", exact: true });
    await menuButton.dblclick();
    await expect(page).toHaveURL(/#\/local-servers$/);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `artifacts/server-parity-${mode.split(" ")[0]}.png` });
  }
});

for (const locale of ["en-US", "ru-RU", "de-DE"]) {
  test(`${locale} server plugins and tabs fit a narrow light layout`, async ({ page }) => {
    await page.goto("/#/settings/appearance");
    await page.getByRole("button", { name: /Light Orange/ }).click();
    await page.goto("/#/settings/general");
    await page.locator("[data-language-selector]").selectOption(locale);
    await page.goto("/#/local-servers");
    await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
    await page.locator("[data-server-tab=plugins]").click();
    await page.setViewportSize({ width: 800, height: 560 });
    await page.locator("[data-server-tab=plugins]").click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    expect(await page.getByRole("menu").evaluate(e => e.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.locator("main").first().evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    const browse = { "en-US": "Browse plugins", "ru-RU": "Скачать плагины", "de-DE": "Plugins entdecken" }[locale]!;
    await page.getByRole("button", { name: browse, exact: true }).click();
    await expect(page.getByRole("heading", { name: "Example Plugin", exact: true })).toBeVisible();
    for (const [width, height] of [[1440, 900], [800, 560], [400, 280]]) {
      await page.setViewportSize({ width, height });
      expect(await page.locator("main").first().evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: `artifacts/server-parity-${locale}-${width}.png` });
    }
  });
}


test("server drag inserts after a row, ignores self drops and releases after cancellation", async ({ page }) => {
  await page.goto("/#/local-servers");
  await expect(page.getByRole("button", { name: "Weekend", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("slh.previewServerLibrary")!);
    const source = saved.servers.find((server: { name: string }) => server.name === "Weekend");
    saved.servers.push({ ...source, id: "second-root", name: "Second server", path: source.path + "-second", presentation: { ...source.presentation, sortOrder: 100 } });
    saved.view = { ...saved.view, view: "list", sort: "manual" };
    localStorage.setItem("slh.previewServerLibrary", JSON.stringify(saved));
  });
  await page.reload();
  const source = page.getByRole("button", { name: "Weekend", exact: true });
  const target = page.getByRole("button", { name: "Second server", exact: true });
  const root = page.locator('section[data-server-group=""]');
  const start = await source.boundingBox(); const end = await target.boundingBox();
  await page.mouse.move(start!.x + 100, start!.y + start!.height / 2); await page.mouse.down();
  await page.mouse.move(end!.x + 100, end!.y + end!.height * 0.8, { steps: 12 });
  await expect(target).toHaveAttribute("data-insert-position", "after");
  await page.mouse.up();
  await expect.poll(() => root.locator("[data-server-card]").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")))).toEqual(["Second server", "Weekend"]);
  const self = await source.boundingBox();
  await page.mouse.move(self!.x + 90, self!.y + 15); await page.mouse.down(); await page.mouse.move(self!.x + 110, self!.y + 15); await page.mouse.up();
  await expect.poll(() => root.locator("[data-server-card]").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")))).toEqual(["Second server", "Weekend"]);
  await page.mouse.move(self!.x + 90, self!.y + 15); await page.mouse.down();
  await page.mouse.move(self!.x + 120, self!.y + 15);
  await page.dispatchEvent("body", "pointercancel", { pointerId: 1 });
  await page.mouse.up();
  await target.click(); await expect(target).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect.poll(() => root.locator("[data-server-card]").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")))).toEqual(["Second server", "Weekend"]);
});
