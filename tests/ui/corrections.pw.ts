import { expect, test } from "@playwright/test";

for (const mode of ["Grid view", "Grouped icons", "List view"]) {
  test(`${mode}: drag changes order and persists after navigation`, async ({ page }) => {
    await page.goto("/#/library");
    await page.getByRole("button", { name: mode, exact: true }).click();
    const first = page.locator('[data-slh-instance="preview-2"]');
    const second = page.locator('[data-slh-instance="preview-3"]');
    const a = await first.boundingBox();
    const b = await second.boundingBox();
    await page.mouse.move(a!.x + 20, a!.y + 20);
    await page.mouse.down();
    await page.mouse.move(b!.x + b!.width - 12, b!.y + b!.height - 12, { steps: 12 });
    await expect(second).toHaveAttribute("data-insert-position", "after");
    await page.mouse.up();
    const group = page.locator('section[data-slh-group-drop="g-modded"]');
    await expect(group.locator('[data-slh-instance]').first()).toHaveAttribute("data-slh-instance", "preview-3");
    await page.evaluate(() => location.hash = "/home");
    await expect(page.getByRole("search")).toBeVisible();
    await page.evaluate(async () => {
      const { useAppStore } = await import("/src/stores/appStore.ts");
      await useAppStore.getState().refresh();
      location.hash = "/library";
    });
    await expect(group.locator('[data-slh-instance]').first()).toHaveAttribute("data-slh-instance", "preview-3");
    await expect(page.getByRole("button", { name: "Filter", exact: true })).toHaveCount(0);
    const self = await second.boundingBox();
    await page.mouse.move(self!.x + 20, self!.y + 20);
    await page.mouse.down();
    await page.mouse.move(self!.x + 34, self!.y + 20, { steps: 3 });
    await page.mouse.up();
    await expect(group.locator('[data-slh-instance]').first()).toHaveAttribute("data-slh-instance", "preview-3");
    await page.screenshot({ path: `artifacts/ui/reorder-${mode.replaceAll(" ", "-")}.png` });
  });
}

test("appearance controls save immediately and beta switches live in Appearance", async ({ page }) => {
  await page.goto("/#/settings/appearance");
  await expect(page.getByRole("switch", { name: "Compact top bar (beta)", exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Compact settings menu (beta)", exact: true })).toBeVisible();
  await page.getByRole("spinbutton", { name: "Corner radius", exact: true }).fill("0");
  await expect.poll(() => page.locator("html").evaluate(el => getComputedStyle(el).getPropertyValue("--radius-lg"))).toBe("0px");
  await page.getByRole("combobox", { name: "Interface density", exact: true }).selectOption("compact");
  await expect.poll(() => page.locator("html").evaluate(el => getComputedStyle(el).getPropertyValue("--control-height"))).toBe("32px");
  await page.evaluate(() => location.hash = "/settings/advanced");
  await expect(page.getByRole("switch", { name: "Compact top bar (beta)", exact: true })).toHaveCount(0);
  await page.evaluate(() => location.hash = "/settings/appearance");
  await expect(page.getByRole("spinbutton", { name: "Corner radius", exact: true })).toHaveValue("0");
  await expect(page.getByRole("combobox", { name: "Interface density", exact: true })).toHaveValue("compact");
  await page.getByRole("combobox", { name: "Interface density", exact: true }).selectOption("comfortable");
  await expect.poll(() => page.locator("html").evaluate(el => getComputedStyle(el).getPropertyValue("--control-height"))).toBe("38px");
});

test("Discover is separate from last build and search focus stays within its border", async ({ page }) => {
  await page.goto("/#/home");
  const search = page.getByRole("search");
  await expect(search).toBeVisible();
  await expect(page.locator('[class*="lastBuild"]').getByRole("search")).toHaveCount(0);
  await search.getByRole("searchbox").focus();
  expect(await search.getByRole("searchbox").evaluate(el => getComputedStyle(el).outlineStyle)).toBe("none");
  await page.screenshot({ path: "artifacts/ui/separate-home-search-focus.png" });
});
