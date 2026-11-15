import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
const russian = JSON.parse(readFileSync("resources/languages/ru-RU.json", "utf8"));

for (const viewport of [{ width: 800, height: 560 }, { width: 1440, height: 900 }]) {
  test(`character settings stay grouped at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/#/settings/appearance");
    const compact = page.getByRole("switch", { name: "Compact settings menu (beta)", exact: true });
    for (const tiles of [true, false]) {
      await compact.setChecked(tiles);
      const modes = page.getByRole("group", { name: "Home character", exact: true });
      const follow = page.getByRole("switch", { name: "Follow cursor", exact: true });
      const fps = page.getByRole("slider", { name: "Player FPS", exact: true });
      const section = modes.locator("../../..");
      await expect(section.getByRole("switch", { name: "Follow cursor" })).toHaveCount(1);
      await expect(section.getByRole("slider", { name: "Player FPS" })).toHaveCount(1);
      await expect(page.getByText("3D character settings", { exact: true })).toHaveCount(0);
      await modes.getByRole("button", { name: "3D", exact: true }).click();
      await follow.check();
      await page.getByRole("button", { name: "Set 30 FPS", exact: true }).click();
      for (const name of ["Image", "Off"]) {
        await modes.getByRole("button", { name, exact: true }).click();
        await expect(follow).toBeDisabled();
        await expect(fps).toBeDisabled();
      }
      const threeD = modes.getByRole("button", { name: "3D", exact: true });
      await threeD.focus();
      await page.keyboard.press("Enter");
      await expect(threeD).toHaveAttribute("aria-pressed", "true");
      await expect(follow).toBeChecked();
      await expect(fps).toHaveValue("30");
      await section.scrollIntoViewIfNeeded();
      const buttons = await modes.getByRole("button").all();
      const boxes = await Promise.all(buttons.map(button => button.boundingBox()));
      expect(boxes.every(box => box && Math.abs(box.y - boxes[0]!.y) < 1)).toBe(true);
      expect(await section.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      if (tiles && viewport.width === 1440) {
        expect(await section.evaluate(element => Math.abs(element.getBoundingClientRect().width - element.previousElementSibling!.getBoundingClientRect().width))).toBeLessThan(1);
      }
      const [fpsBox, followBox] = await Promise.all([fps.boundingBox(), follow.boundingBox()]);
      expect(fpsBox!.y + fpsBox!.height).toBeLessThan(followBox!.y);
      await page.screenshot({ path: `test-results/character-${viewport.width}-${tiles ? "tiles" : "rows"}.png` });
    }
    const beautiful = page.getByRole("switch", { name: "Beautiful Home Menu", exact: true });
    await beautiful.uncheck();
    await expect(page.getByRole("group", { name: "Home character", exact: true })).toHaveCount(0);
    await beautiful.check();
    await expect(page.getByRole("slider", { name: "Player FPS", exact: true })).toHaveValue("30");
    await page.goto("/#/settings/general");
    await page.locator("[data-language-selector]").selectOption("ru-RU");
    await page.goto("/#/settings/appearance");
    const russianModes = page.getByRole("group", { name: russian.settings.character.title, exact: true });
    await expect(russianModes.getByRole("button", { name: russian.settings.character.mode1.replace(/^\d+\s*[^\w\s]+\s*/, ""), exact: true })).toBeVisible();
    await russianModes.scrollIntoViewIfNeeded();
    const dismiss = page.getByRole("button", { name: russian.common.texts.dismissNotification, exact: true });
    while (await dismiss.count()) await dismiss.first().click();
    await russianModes.locator("../../..").screenshot({ path: `test-results/character-${viewport.width}-ru-section.png` });
    await page.screenshot({ path: `test-results/character-${viewport.width}-ru.png` });
    await page.getByRole("switch", { name: russian.settings.texts.compactMenuBeta, exact: true }).check();
    const russianFps = page.getByRole("slider", { name: russian.accounts.texts.playerFps, exact: true });
    await russianFps.focus();
    await russianFps.press("End");
    await expect(russianFps).toHaveValue("61");
    await expect(russianFps).toHaveAttribute("aria-valuetext", russian.accounts.texts.unlimited);
    const tile = russianModes.locator("../../..");
    await tile.scrollIntoViewIfNeeded();
    while (await dismiss.count()) await dismiss.first().click();
    await tile.getByText(russian.settings.character.title, { exact: true }).click();
    expect(await tile.evaluate(element => [...element.querySelectorAll("button,input,strong,span")].every(child => child.scrollWidth <= child.clientWidth + 1))).toBe(true);
    await tile.screenshot({ path: `test-results/character-${viewport.width}-ru-tile.png` });
  });
}

test("Horizon badge and help do not overlap its switch in both layouts", async ({ page }) => {
  await page.goto("/#/settings/appearance");
  const compact = page.getByRole("switch", { name: "Compact settings menu (beta)", exact: true });
  for (const enabled of [true, false]) {
    await compact.setChecked(enabled);
    await page.goto("/#/settings/advanced");
    const toggle = page.getByRole("switch", { name: "Minecraft on Rust", exact: true });
    const help = page.getByRole("button", { name: "FAQ?", exact: true });
    const badge = page.getByText("Beta", { exact: true });
    const [toggleBox, helpBox, badgeBox] = await Promise.all([toggle.boundingBox(), help.boundingBox(), badge.boundingBox()]);
    expect(toggleBox!.y).toBeGreaterThanOrEqual(Math.max(helpBox!.y + helpBox!.height, badgeBox!.y + badgeBox!.height));
    await page.goto("/#/settings/appearance");
  }
});
