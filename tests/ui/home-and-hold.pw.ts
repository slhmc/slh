import { expect, test } from "@playwright/test";

for (const mode of ["Grid view", "Grouped icons", "List view"]) {
  test(`${mode}: hold and drag moves instances, preserves selection and cancels safely`, async ({ page }) => {
    await page.goto("/#/library");
    await page.getByRole("button", { name: mode, exact: true }).click();
    await page.evaluate(async () => {
      const { useAppStore } = await import("/src/stores/appStore.ts");
      useAppStore.getState().selectInstance("preview-3");
    });
    const instance = page.locator('article[role="button"], div[role="button"]').filter({ has: page.getByText("Latest release", { exact: true }) });
    await page.getByRole("button", { name: "Collapse Modded", exact: true }).click();
    const source = await instance.boundingBox();
    const target = await page.locator('[data-slh-group-order="g-modded"]').boundingBox();
    await page.mouse.move(source!.x + 20, source!.y + 20);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.move(target!.x + 55, target!.y + target!.height / 2, { steps: 12 });
    await expect(page.locator('[class*="dragPreview"]')).toBeVisible();
    await page.screenshot({ path: `artifacts/ui/hold-${mode.replaceAll(" ", "-")}.png` });
    await page.mouse.up();
    await expect(page.locator('[class*="dragPreview"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Expand Modded", exact: true }).click();
    await expect(page.locator('section[data-slh-group-drop="g-modded"]').getByText("Latest release", { exact: true })).toBeVisible();
    expect(await page.evaluate(async () => {
      const { useAppStore } = await import("/src/stores/appStore.ts");
      return useAppStore.getState().selectedInstanceId;
    })).toBe("preview-3");
    const moved = await instance.boundingBox();
    const ungrouped = await page.locator('[data-slh-group-order="ungrouped"]').boundingBox();
    await page.mouse.move(moved!.x + 20, moved!.y + 20);
    await page.mouse.down();
    await page.mouse.move(ungrouped!.x + 55, ungrouped!.y + ungrouped!.height / 2, { steps: 10 });
    await page.evaluate(() => window.dispatchEvent(new Event("slh-ui-cancel")));
    await page.mouse.up();
    await expect(page.locator('section[data-slh-group-drop="g-modded"]').getByText("Latest release", { exact: true })).toBeVisible();
    await instance.click();
    await expect(instance).toHaveAttribute("aria-pressed", "true");
  });
}

test("minimal settings tiles fit their content while retaining enlarged text", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/settings/appearance");
  await page.getByRole("switch", { name: "Minimalism", exact: true }).click();
  await page.evaluate(() => location.hash = "/settings/appearance");
  const row = page.getByRole("switch", { name: "Compact top bar (beta)", exact: true }).locator('xpath=ancestor::div[contains(@class,"settingRow")]');
  await expect(row).toBeVisible();
  expect((await row.boundingBox())!.height).toBeLessThan(125);
  expect(await row.locator("strong").first().evaluate(el => getComputedStyle(el).fontSize)).toBe("16px");
  await page.screenshot({ path: "artifacts/ui/minimalism-advanced-content.png" });
  await page.setViewportSize({ width: 800, height: 560 });
  expect(await row.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "artifacts/ui/minimalism-advanced-content-small.png" });
});

test("home search passes the query and selected provider to Discover in both home designs", async ({ page }) => {
  await page.goto("/#/home");
  for (const provider of ["CurseForge", "Modrinth"]) {
    const search = page.getByRole("search", { name: "Find a modpack" });
    await search.getByRole("searchbox").fill("Cobblemon & friends");
    await search.getByRole("button", { name: provider, exact: true }).click();
    await expect(search.getByRole("button", { name: provider, exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: `artifacts/ui/home-search-${provider}.png` });
    await search.getByRole("searchbox").press("Enter");
    await expect(page).toHaveURL(new RegExp(`source=${provider.toLowerCase()}&query=Cobblemon`));
    await expect(page.locator('[class*="searchBox"] input')).toHaveValue("Cobblemon & friends");
    await expect(page.locator('[class*="sourceActive"]')).toContainText(provider);
    await page.evaluate(() => location.hash = "/home");
  }
  await page.evaluate(async () => {
    const { useAppStore } = await import("/src/stores/appStore.ts");
    const { command } = await import("/src/lib/tauri.ts");
    await command("update_setting", { key: "appearance", value: { ...useAppStore.getState().bootstrap.settings.appearance, beautifulHome: false } });
    await useAppStore.getState().refresh();
  });
  await expect(page.getByRole("search")).toBeVisible();
  await page.getByRole("searchbox").fill("Sky Factory");
  await page.getByRole("searchbox").press("Enter");
  await expect(page.locator('[class*="searchBox"] input')).toHaveValue("Sky Factory");
});

test("home search and minimal tiles fit RU, EN and DE at small window and 200% scale", async ({ page }) => {
  await page.goto("/#/home");
  await expect(page.getByRole("search")).toBeVisible();
  for (const language of ["ru-RU", "en-US", "de-DE"]) {
    await page.evaluate(async language => {
      const { useAppStore } = await import("/src/stores/appStore.ts");
      const { command } = await import("/src/lib/tauri.ts");
      await command("update_setting", { key: "general", value: { ...useAppStore.getState().bootstrap.settings.general, language } });
      await command("update_setting", { key: "appearance", value: { ...useAppStore.getState().bootstrap.settings.appearance, minimalism: true } });
      await useAppStore.getState().refresh();
    }, language);
    await expect(page.locator("html")).toHaveAttribute("lang", language);
    for (const width of [1440, 800, 400]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 560 });
      await page.evaluate(() => location.hash = "/home");
      const search = page.getByRole("search");
      await search.scrollIntoViewIfNeeded();
      expect(await search.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: `artifacts/ui/home-search-${language}-${width}.png` });
      await page.evaluate(() => location.hash = "/settings/advanced");
      const rows = page.locator('[class*="tileGrid"] > [class*="settingRow"]');
      await expect(rows.first()).toBeVisible();
      for (const row of await rows.all()) expect(await row.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: `artifacts/ui/minimal-content-${language}-${width}.png` });
    }
  }
});
