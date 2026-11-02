import { expect, test } from "@playwright/test";
import { revealControl } from "./revealControl";

for (const language of ["en-US", "ru-RU", "de-DE"]) for (const rows of [false, true]) {
  test(`${language}: appearance keylines and visible title fitting, rows=${rows}`, async ({ page }) => {
    await page.goto("/#/settings/appearance");
    await expect(page.getByRole("switch", { name: "Minimalism", exact: true })).toBeVisible();
    await page.evaluate(async ({ language, rows }) => {
      const { command } = await import("/src/lib/tauri.ts");
      const { useAppStore } = await import("/src/stores/appStore.ts");
      await command("update_setting", { key: "general", value: { ...useAppStore.getState().bootstrap.settings.general, language, compactSettings: rows } });
      await useAppStore.getState().refresh();
    }, { language, rows });
    await expect(page.locator("html")).toHaveAttribute("lang", language);
    const labels = await page.evaluate(async () => {
      const { engine } = await import("/src/i18n/engine.ts");
      return { fit: engine.t("settings.fitTitles"), minimal: engine.t("settings.minimalism"), radius: engine.t("settings.texts.cornerRadius"), density: engine.t("settings.texts.interfaceDensity") };
    });
    const fit = page.getByRole("switch", { name: labels.fit, exact: true });
    await expect(fit).toBeVisible();
    await expect(fit.locator("xpath=ancestor::details")).toHaveCount(0);
    const fitRow = fit.locator('xpath=ancestor::div[contains(@class,"settingRow")]');
    await expect(fitRow.locator("xpath=preceding-sibling::*[1]").locator("strong")).toHaveText(labels.minimal);
    const checked = await fit.getAttribute("aria-checked");
    await fit.click();
    await expect(fit).toHaveAttribute("aria-checked", checked === "true" ? "false" : "true");
    await revealControl(page, '[class*="fontControl"] select');
    for (const width of [800, 1440]) {
      await page.setViewportSize({ width, height: width === 800 ? 560 : 900 });
      const font = await page.locator('[class*="fontSettingRow"]').boundingBox();
      const radius = await page.getByRole("spinbutton", { name: labels.radius, exact: true }).locator('xpath=ancestor::div[contains(@class,"settingRow")]').boundingBox();
      const density = await page.getByRole("combobox", { name: labels.density, exact: true }).locator('xpath=ancestor::div[contains(@class,"settingRow")]').boundingBox();
      expect(Math.abs(radius!.x - font!.x)).toBeLessThan(1);
      expect(Math.abs(density!.x + density!.width - font!.x - font!.width)).toBeLessThan(1);
      await page.getByRole("spinbutton", { name: labels.radius, exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `artifacts/ui/appearance-refine-${language}-${width}-${rows}.png` });
    }
  });
}
