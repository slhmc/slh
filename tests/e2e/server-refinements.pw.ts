import { expect, test } from "@playwright/test";

test("server stop uses the instance stop surface and side actions are configurable tiles", async ({ page }) => {
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Weekend", exact: true }).click();
  const panel = page.locator("aside").filter({ has: page.getByRole("heading", { name: "Weekend", exact: true }) });
  await expect(panel.locator('[class*="quickGrid"]')).toBeVisible();
  await panel.getByRole("button", { name: "Start", exact: true }).click();
  // Built-in console opens automatically; inspect the workspace stop button.
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveClass(/killButton/);
  await page.screenshot({ path: "artifacts/server-stop-instance-style.png" });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Weekend", exact: true }).click();
  await page.screenshot({ path: "artifacts/server-side-tiles-default.png", animations: "disabled" });
  await panel.getByRole("heading", { name: "Weekend", exact: true }).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Server panel", exact: true });
  await page.screenshot({ path: "artifacts/server-side-panel-menu.png", animations: "disabled" });
  await menu.getByRole("menuitemcheckbox", { name: "Plugins", exact: true }).click();
  await menu.getByRole("menuitemcheckbox", { name: "Icon / artwork", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Plugins", exact: true })).toHaveCount(0);
  await menu.getByRole("menuitemcheckbox", { name: "Console", exact: true }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(panel.getByRole("heading", { name: "Weekend", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Plugins", exact: true })).toHaveCount(0);
  await expect(panel.locator('[class*="artwork"]')).toHaveCount(0);
  await page.screenshot({ path: "artifacts/server-side-tiles.png", animations: "disabled" });
});

test("settings follow disk edits without erasing a draft and reject stale saves", async ({ page }) => {
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
  await page.locator('[data-server-tab="settings"]').click();
  const whitelist = page.getByRole("checkbox", { name: "Whitelist", exact: true });
  await expect(whitelist).not.toBeChecked();
  await page.evaluate(() => localStorage.setItem("slh.previewServerProperties", JSON.stringify({ "preview-Weekend": "white-list=true\npvp=true\n" })));
  await expect(whitelist).toBeChecked({ timeout: 5000 });
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("My draft");
  await page.evaluate(() => localStorage.setItem("slh.previewServerProperties", JSON.stringify({ "preview-Weekend": "white-list=false\npvp=false\n" })));
  await page.waitForTimeout(2200);
  await expect(whitelist).toBeChecked();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("My draft");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Server settings changed on disk");
  await page.getByRole("button", { name: "Reload from file", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Discard unsaved changes");
  await dialog.getByRole("button", { name: "Reload from file", exact: true }).click();
  await expect(whitelist).not.toBeChecked();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Weekend");
});

test("server deletion requires explicit confirmation and survives library rescan", async ({ page }) => {
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
  await page.locator('[data-server-tab="settings"]').click();
  await page.getByRole("button", { name: "Delete server", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("No backup will be created");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Weekend", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete server", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete server", exact: true }).click();
  await expect(page).toHaveURL(/#\/local-servers$/);
  await expect(page.getByRole("button", { name: "Weekend", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Weekend", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open group gdz", exact: true })).toBeVisible();
});

for (const [locale, deleteLabel] of [["en-US", "Delete server"], ["ru-RU", "Удалить сервер"], ["de-DE", "Server löschen"]]) {
  test(`${locale} side panel and delete warning fit narrow windows`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#/settings/appearance"); await page.getByRole("button", { name: /Light Orange/ }).click();
    await page.goto("/#/settings/general"); await page.locator("[data-language-selector]").selectOption(locale);
    await page.goto("/#/local-servers"); await page.getByRole("button", { name: "Weekend", exact: true }).click();
    const panel = page.locator("aside").filter({ has: page.getByRole("heading", { name: "Weekend", exact: true }) });
    await expect(panel.locator('[class*="quickGrid"]')).toBeVisible();
    for (const [width, height] of [[800, 560], [400, 280]]) {
      await page.setViewportSize({ width, height });
      await panel.getByRole("heading", { name: "Weekend", exact: true }).click({ button: "right" });
      const menu = page.getByRole("menu"); await expect(menu).toBeVisible();
      const box = await menu.boundingBox(); expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1);
      await page.keyboard.press("Escape");
    }
    await panel.getByRole("button", { name: deleteLabel, exact: true }).click();
    const dialog = page.getByRole("dialog"); await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `artifacts/server-delete-${locale}-narrow.png`, animations: "disabled" });
    await page.keyboard.press("Escape"); await expect(dialog).not.toBeVisible();
  });
}


test("server card menus match library rows, open right and fit the viewport", async ({ page }) => {
  await page.goto("/#/local-servers");
  const server = page.getByRole("button", { name: "Weekend", exact: true });
  await expect(server).not.toContainText("Stopped");
  const trigger = server.getByRole("button", { name: "Actions for Weekend", exact: true });
  const anchor = await trigger.boundingBox();
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Weekend", exact: true });
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(anchor!.x + anchor!.width - 1);
  expect(box.width).toBeLessThanOrEqual(160);
  expect(box.height).toBeLessThanOrEqual(160);
  for (const row of await menu.getByRole("menuitem").all()) {
    await expect(row.locator("svg")).toHaveCount(1);
    const rowBox = (await row.boundingBox())!;
    expect(rowBox.width).toBeGreaterThanOrEqual(box.width - 12);
  }
  await page.screenshot({ path: "artifacts/server-card-menu-library-style.png", animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(server).toHaveAttribute("aria-pressed", "false");
  await page.setViewportSize({ width: 800, height: 560 });
  await server.click({ button: "right", position: { x: 5, y: 5 } });
  const narrow = (await menu.boundingBox())!;
  expect(narrow.x).toBeGreaterThanOrEqual(8);
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(792);
  expect(narrow.y + narrow.height).toBeLessThanOrEqual(552);
  await menu.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page.locator('[data-server-tab="settings"]')).toHaveAttribute("aria-current", "page");
});
