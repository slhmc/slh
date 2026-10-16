import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

for (const code of ["en-US", "ru-RU", "de-DE"]) {
  for (const light of [false, true]) {
    test(`${code}: update actions fit narrow and large windows, 200% text, ${light ? "light" : "dark"}`, async ({ page }) => {
      const messages = JSON.parse(readFileSync(`resources/languages/${code}.json`, "utf8")).updater;
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/#/settings/appearance");
      await expect(page.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();
      if (light) await page.getByRole("button", { name: /Light Orange/ }).click();
      await page.evaluate(async code => {
        const { command } = await import("/src/lib/tauri.ts");
        const { useAppStore } = await import("/src/stores/appStore.ts");
        await command("update_setting", { key: "general", value: { ...useAppStore.getState().bootstrap.settings.general, language: code } });
        await useAppStore.getState().refresh();
      }, code);
      await expect(page.locator("html")).toHaveAttribute("lang", code);
      for (const [width, height] of [[1440, 900], [800, 560], [400, 280]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("slh-launcher-update", { detail: { latestVersion: "0.2.2", updateAvailable: true } })));
        const dialog = page.getByRole("dialog", { name: messages.title });
        await expect(dialog).toBeVisible();
        const install = dialog.getByRole("button", { name: messages.install, exact: true });
        await expect(install).toBeVisible();
        const box = await install.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(box!.y + box!.height).toBeLessThanOrEqual(height);
        expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await page.keyboard.press("Tab");
        expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
        await page.screenshot({ path: `artifacts/ui/local-021-updater-${code}-${width}-${light ? "light" : "dark"}.png` });
        await page.keyboard.press("Escape");
        await expect(dialog).not.toBeVisible();
      }
    });
  }
}
