import { expect, test, type Page } from "@playwright/test";

async function preferences(page: Page, compact: boolean, minimal = false) {
  await page.evaluate(async ({ compact, minimal }) => {
    const { command } = await import("/src/lib/tauri.ts");
    const { useAppStore } = await import("/src/stores/appStore.ts");
    const settings = useAppStore.getState().bootstrap.settings;
    await command("update_setting", { key: "general", value: { ...settings.general, compactSettings: compact } });
    await command("update_setting", { key: "appearance", value: { ...settings.appearance, minimalism: minimal } });
    await useAppStore.getState().refresh();
  }, { compact, minimal });
}

test("server defaults share launcher rows and tiles without losing edited values", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/#/settings/servers");
  const memory = page.getByRole("spinbutton", { name: "Maximum memory (MiB)", exact: true });
  await expect(memory).toBeVisible();
  await memory.fill("6144");
  const row = memory.locator('xpath=ancestor::div[contains(@class,"settingRow")]');
  const title = row.locator("strong").first();
  const font = await title.evaluate(element => getComputedStyle(element).fontSize);
  const tileHeight = (await row.boundingBox())!.height;
  await preferences(page, true);
  await expect(memory).toHaveValue("6144");
  expect(await title.evaluate(element => getComputedStyle(element).fontSize)).toBe(font);
  expect((await row.boundingBox())!.height).toBeLessThan(tileHeight);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Settings saved." })).toBeVisible();
  await page.evaluate(() => { location.hash = "/local-servers"; });
  await page.getByRole("button", { name: "Create server", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Java and launch", exact: true }).click();
  await expect(dialog.getByRole("spinbutton", { name: "Maximum memory (MiB)", exact: true })).toHaveValue("6144");
});

test("server toggle rows do not edit a running server through their expanded hit area", async ({ page }) => {
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
  await page.locator('[data-server-tab="settings"]').click();
  const checkbox = page.getByRole("checkbox", { name: "Whitelist", exact: true });
  const row = checkbox.locator('xpath=ancestor::div[contains(@class,"settingRow")]');
  await expect(checkbox).not.toBeChecked();
  await row.locator("strong").click();
  await expect(checkbox).toBeChecked();
  await row.locator("strong").click();
  await expect(checkbox).not.toBeChecked();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.locator('[data-server-tab="settings"]').click();
  await expect(checkbox).toBeDisabled();
  await row.locator("strong").click();
  await expect(checkbox).not.toBeChecked();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
});

for (const locale of ["ru-RU", "de-DE"]) {
  test(`${locale}: server settings keep controls inside narrow rows and minimal tiles`, async ({ page }) => {
    await page.goto("/#/settings/general");
    await page.locator("[data-language-selector]").selectOption(locale);
    await page.evaluate(() => { location.hash = "/settings/servers"; });
    await expect(page.locator('[class*="defaultsPanel"]')).toBeVisible();
    for (const compact of [false, true]) {
      await preferences(page, compact, true);
      for (const width of [1440, 800, 400]) {
        await page.setViewportSize({ width, height: 560 });
        const panel = page.locator('[class*="defaultsPanel"]');
        expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        const toggle = panel.getByRole("checkbox").first();
        await expect(toggle).toBeVisible();
        expect(Math.round((await toggle.boundingBox())!.width)).toBe(40);
      }
    }
  });
}
