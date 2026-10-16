import { expect, test } from "@playwright/test";

test("grouped icons retain selection, menus, collapsed groups and saved view", async ({ page }) => {
  await page.goto("/#/library");
  const mode = page.getByRole("button", { name: "Grouped icons", exact: true });
  await mode.click();
  await expect(mode).toHaveAttribute("aria-pressed", "true");
  const instance = page.getByRole("button", { name: "Latest release", exact: true });
  await expect(instance).toBeVisible();
  expect((await instance.locator('[class*="artwork"]').boundingBox())!.width).toBe(64);
  await instance.focus();
  await page.keyboard.press("Enter");
  await expect(instance).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Actions for Latest release", exact: true }).click();
  await expect(instance.getByRole("button", { name: "Open folder", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Actions for Latest release", exact: true }).click();
  await page.getByRole("button", { name: "Collapse Vanilla", exact: true }).click();
  await expect(instance).toHaveCount(0);
  await page.getByRole("button", { name: "Expand Vanilla", exact: true }).click();
  await expect(instance).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: "artifacts/ui/library-icons-en.png" });
  await page.evaluate(() => location.hash = "/settings/general");
  await expect(page.locator("[data-language-selector]")).toBeVisible();
  await page.evaluate(async () => {
    const { useAppStore } = await import("/src/stores/appStore.ts");
    await useAppStore.getState().refresh();
    location.hash = "/library";
  });
  await expect(mode).toHaveAttribute("aria-pressed", "true");
  for (const [language, label] of [["ru-RU", "Значки по группам"], ["de-DE", "Gruppierte Symbole"]]) {
    await page.evaluate(async language => {
      const { command } = await import("/src/lib/tauri.ts");
      const { useAppStore } = await import("/src/stores/appStore.ts");
      await command("update_setting", { key: "general", value: { ...useAppStore.getState().bootstrap.settings.general, language } });
      await useAppStore.getState().refresh();
    }, language);
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.setViewportSize({ width: 800, height: 560 });
    await expect(instance).toBeVisible();
    const viewBox = await page.getByRole("button", { name: label, exact: true }).boundingBox();
    expect(viewBox!.x + viewBox!.width).toBeLessThanOrEqual(800);
    expect(await page.locator('[class*="library_"]').first().evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.locator('[class*="iconsGrid"]').first().evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `artifacts/ui/library-icons-${language}-small.png` });
  }
});

test("minimalism enlarges navigation and primary text without restoring descriptions", async ({ page }) => {
  await page.goto("/#/settings/appearance");
  await expect(page.getByRole("switch", { name: "Minimalism", exact: true })).toBeVisible();
  await page.getByRole("switch", { name: "Minimalism", exact: true }).click();
  const nav = page.locator('[data-minimal-navigation]').first();
  expect((await nav.locator("svg").boundingBox())!.width).toBe(28);
  const title = page.locator('[data-minimal-title]').filter({ hasText: "Interface scale" });
  expect(await title.evaluate(el => getComputedStyle(el).fontSize)).toBe("16px");
  await expect(page.getByText("Changes the whole launcher without changing the Minecraft resolution.", { exact: true })).toBeHidden();
  await page.screenshot({ path: "artifacts/ui/minimalism-appearance-large.png" });
  await page.setViewportSize({ width: 800, height: 560 });
  expect((await nav.locator("svg").boundingBox())!.width).toBe(28);
  await page.screenshot({ path: "artifacts/ui/minimalism-appearance-small.png" });
  await page.getByRole("switch", { name: "Minimalism", exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole("switch", { name: "Minimalism", exact: true }).click();
  expect((await nav.locator("svg").boundingBox())!.width).toBe(20);
});
