import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 800, height: 560 }, { width: 1440, height: 900 }]) {
  test(`FPS track stays still at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/#/settings/appearance");
    for (const tiles of [true, false]) {
      await page.getByRole("switch", { name: "Compact settings menu (beta)", exact: true }).setChecked(tiles);
      await page.getByRole("button", { name: "3D", exact: true }).click();
      await page.getByRole("button", { name: "60 FPS", exact: true }).click();
      const slider = page.getByRole("slider", { name: "Player FPS", exact: true });
      await slider.scrollIntoViewIfNeeded();
      const numeric = await slider.boundingBox();
      const output = slider.locator("../..").locator("strong");
      await expect(output).toHaveText("60");
      await slider.focus();
      await slider.press("End");
      await expect(output).toHaveText("∞");
      expect(await slider.boundingBox()).toEqual(numeric);
      await slider.press("ArrowLeft");
      await expect(output).toHaveText("60");
      expect(await slider.boundingBox()).toEqual(numeric);
      const x = numeric!.x + numeric!.width - 1;
      const y = numeric!.y + numeric!.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 0; i < 8; i++) {
        await page.mouse.move(x, y);
        await expect(slider).toHaveValue("61");
        expect(await slider.boundingBox()).toEqual(numeric);
      }
      await page.mouse.up();
      await expect(slider).toHaveAttribute("aria-valuetext", "Unlimited");
      await slider.locator("../../../..").screenshot({ path: `test-results/fps-${viewport.width}-${tiles ? "tiles" : "rows"}.png` });
    }
  });
}
