import { expect, test } from "@playwright/test";

test("wide settings use tiles, retain dock preference and group working switches first", async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1359 });
  await page.goto("/#/settings/advanced");
  const automatic = page.getByRole("switch", { name: "Check for launcher updates automatically" });
  await expect(automatic).toBeVisible();
  await page.evaluate(async () => {
    const { useAppStore } = await import("/src/stores/appStore.ts");
    const { command } = await import("/src/lib/tauri.ts");
    await command("update_setting", { key: "general", value: { ...useAppStore.getState().bootstrap.settings.general, navigationPosition: "top", settingsNavigationPosition: "right" } });
    await useAppStore.getState().refresh();
  });
  await expect(page.getByRole("switch").first()).toHaveAccessibleName("Check for launcher updates automatically");
  await expect(automatic).toHaveAttribute("aria-checked", "true");
  await automatic.click();
  await expect(automatic).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("switch", { name: "Compact top bar (beta)" })).toHaveCount(0);
  await page.screenshot({ path: "artifacts/ui/settings-advanced-wide.png" });
  for (const section of ["general", "appearance"]) {
    await page.evaluate(section => location.hash = `/settings/${section}`, section);
    const panel = page.locator('[class*="sectionBody"]').first();
    await expect(panel).toBeVisible();
    expect((await panel.boundingBox())!.width).toBeGreaterThan(1200);
    await page.screenshot({ path: `artifacts/ui/settings-${section}-wide.png` });
  }
  for (const code of ["ru-RU", "de-DE"]) {
    await page.evaluate(async code => {
      const { useAppStore } = await import("/src/stores/appStore.ts");
      const { command } = await import("/src/lib/tauri.ts");
      await command("update_setting", { key: "general", value: { ...useAppStore.getState().bootstrap.settings.general, language: code } });
      await useAppStore.getState().refresh();
    }, code);
    await expect(page.locator("html")).toHaveAttribute("lang", code);
    for (const section of ["general", "appearance", "advanced"]) {
      await page.evaluate(section => location.hash = `/settings/${section}`, section);
      await expect(page.locator('[class*="sectionBody"]').first()).toBeVisible();
      await page.setViewportSize({ width: 800, height: 560 });
      expect(await page.locator('[class*="sectionBody"]').first().evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: `artifacts/ui/settings-${section}-${code}-small.png` });
    }
  }
});

test("Minecraft version details and type stay optically centered", async ({ page }) => {
  await page.goto("/#/library");
  await page.getByRole("button", { name: "New instance", exact: true }).click();
  const row = page.locator('[class*="versionRow"]').first();
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  for (const selector of ['[class*="versionDetails"]', '[class*="versionBadge"]']) {
    const child = await row.locator(selector).boundingBox();
    expect(Math.abs(child!.y + child!.height / 2 - box!.y - box!.height / 2 + 2)).toBeLessThan(1);
  }
  await page.screenshot({ path: "artifacts/ui/version-picker-centered.png" });
});

test("compact settings persist across navigation without shrinking text; account cards remain large", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/settings/appearance");
  const toggle = page.getByRole("switch", { name: "Compact settings menu (beta)" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  const row = toggle.locator('xpath=ancestor::div[contains(@class,"settingRow")]');
  const title = row.locator("strong").first();
  const font = await title.evaluate(element => getComputedStyle(element).fontSize);
  const before = (await row.boundingBox())!.height;
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(await title.evaluate(element => getComputedStyle(element).fontSize)).toBe(font);
  expect((await row.boundingBox())!.height).toBeLessThan(before);
  await page.screenshot({ path: "artifacts/ui/settings-compact-advanced.png" });
  await page.evaluate(() => location.hash = "/settings/appearance");
  await expect(page.locator('[class*="compactSettings"]')).toBeVisible();
  await page.screenshot({ path: "artifacts/ui/settings-compact-appearance.png" });
  await page.evaluate(() => location.hash = "/settings/accounts");
  const account = page.locator('[class*="accountRow"]').first();
  await expect(account).toBeVisible();
  expect((await account.boundingBox())!.height).toBeGreaterThanOrEqual(128);
  expect((await account.locator('[class*="accountAvatar"]').boundingBox())!.width).toBe(68);
  await page.screenshot({ path: "artifacts/ui/settings-accounts-large.png" });
  await page.setViewportSize({ width: 400, height: 280 });
  expect(await page.locator('[class*="sectionBody"]').first().evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "artifacts/ui/settings-accounts-small.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => location.hash = "/settings/appearance");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
});
