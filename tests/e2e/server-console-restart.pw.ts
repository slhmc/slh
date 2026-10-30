import { expect, test } from "@playwright/test";

test("console follows repeated server launches and keeps secondary actions out of the toolbar", async ({ page }) => {
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
  await page.locator('[data-server-tab="console"]').click();
  const output = page.getByLabel("Server output", { exact: true });
  await expect(output).toContainText("preview-initial");
  await expect(page.getByRole("button", { name: "Clear view", exact: true })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Separate console window", exact: true })).not.toBeVisible();
  for (let run = 0; run < 2; run++) {
    const previous = await output.textContent();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect.poll(() => output.textContent()).not.toBe(previous);
    await expect(output).not.toContainText("preview-initial");
    await expect(output.locator('[data-log-level]')).toHaveCount(5);
    await expect(page.getByRole("textbox", { name: "Server command", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Server command", exact: true })).toBeDisabled();
  }
  await page.getByRole("button", { name: "Console actions", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Save output", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Clear view", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(output.locator('[data-log-level]')).toHaveCount(0);
  await page.waitForTimeout(2100);
  await expect(output.locator('[data-log-level]')).toHaveCount(0);
});

for (const [locale, library, folder, plugins, logs] of [
  ["en-US", "Library", "Folder", "Plugin folder", "Log folder"],
  ["ru-RU", "Библиотека", "Папка", "Папка плагинов", "Папка логов"],
  ["de-DE", "Bibliothek", "Ordner", "Plugin-Ordner", "Protokollordner"],
]) {
  test(`${locale}: header navigation and contextual folders fit narrow windows`, async ({ page }) => {
    await page.goto("/#/settings/general");
    await page.locator("[data-language-selector]").selectOption(locale);
    await page.goto("/#/local-servers/preview-Weekend?tab=plugins");
    const header = page.locator('header[class*="workspaceHeader"]');
    await expect(header.getByRole("button", { name: library, exact: true })).toBeVisible();
    await expect(page.locator('[data-server-tab="plugins"]').locator('..').getByRole("button", { name: library, exact: true })).toHaveCount(0);
    await expect(header.getByRole("button", { name: folder, exact: true })).toHaveAttribute("title", plugins);
    await header.getByRole("button", { name: folder, exact: true }).click();
    await page.locator('[data-server-tab="console"]').click();
    await expect(header.getByRole("button", { name: folder, exact: true })).toHaveAttribute("title", logs);
    await page.screenshot({ path: `artifacts/server-console-${locale}.png` });
    for (const width of [1440, 800, 400]) {
      await page.setViewportSize({ width, height: 560 });
      expect(await header.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      const viewer = page.locator('[data-log-viewer]');
      expect(await viewer.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }
    await page.screenshot({ path: `artifacts/server-console-${locale}-narrow.png` });
    await header.getByRole("button", { name: library, exact: true }).click();
    await expect(page).toHaveURL(/#\/local-servers$/);
  });
}
