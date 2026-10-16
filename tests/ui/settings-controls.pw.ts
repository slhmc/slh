import { expect, test } from "@playwright/test";

for (const code of ["ru-RU", "de-DE"]) {
  test(`${code}: compound settings controls fit their text in both layouts`, async ({ page }) => {
    await page.goto("/#/settings/appearance");
    await expect(page.locator('[class*="fontControl"] select')).toBeVisible();
    await page.evaluate(async code => {
      const { command } = await import("/src/lib/tauri.ts");
      const { useAppStore } = await import("/src/stores/appStore.ts");
      await command("update_setting", { key: "general", value: { ...useAppStore.getState().bootstrap.settings.general, language: code, navigationPosition: "top", settingsNavigationPosition: "right" } });
      await useAppStore.getState().refresh();
    }, code);
    await expect(page.locator("html")).toHaveAttribute("lang", code);
    for (const compact of [false, true]) {
      await page.evaluate(async compact => {
        const { command } = await import("/src/lib/tauri.ts");
        const { useAppStore } = await import("/src/stores/appStore.ts");
        await command("update_setting", { key: "general", value: { ...useAppStore.getState().bootstrap.settings.general, compactSettings: compact } });
        await useAppStore.getState().refresh();
      }, compact);
      for (const width of [2560, 1440, 1100, 800]) {
        await page.setViewportSize({ width, height: width === 800 ? 560 : 900 });
        for (const section of ["appearance", "minecraft"]) {
          await page.evaluate(section => location.hash = `/settings/${section}`, section);
          const field = page.locator(section === "appearance" ? '[class*="fontControl"] select' : '[class*="inlineForm"] input[placeholder]');
          await expect(field).toBeVisible();
          await page.evaluate(() => document.fonts.ready);
          const fits = await field.evaluate(element => {
            const style = getComputedStyle(element);
            const canvas = document.createElement("canvas");
            const context = canvas.getContext("2d")!;
            context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const select = element as HTMLSelectElement;
            const text = element.tagName === "SELECT" ? select.selectedOptions[0].textContent! : (element as HTMLInputElement).placeholder;
            const required = context.measureText(text).width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + (element.tagName === "SELECT" ? 24 : 0);
            return element.clientWidth >= required;
          });
          expect(fits, `${section}, ${code}, ${width}, compact=${compact}`).toBe(true);
          expect(await page.locator('[class*="sectionBody"]').first().evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
          if (width === 1440 || width === 800) {
            await field.scrollIntoViewIfNeeded();
            await page.screenshot({ path: `artifacts/ui/controls-${section}-${code}-${width}-${compact}.png` });
          }
        }
      }
    }
  });
}
