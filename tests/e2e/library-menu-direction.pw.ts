import { expect, test } from "@playwright/test";

test("library card action menus open right in all views and stay inside the window", async ({ page }) => {
  await page.goto("/#/library");
  for (const mode of ["Grid view", "Grouped icons", "List view"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    const menu = page.locator("details[data-card-action-menu]").first();
    const summary = menu.locator("summary");
    await summary.click();
    const popup = menu.locator(":scope > div");
    await expect(popup).toBeVisible();
    const anchor = (await summary.boundingBox())!;
    const box = (await popup.boundingBox())!;
    if (anchor.x + anchor.width + box.width < 1432) expect(box.x).toBeGreaterThanOrEqual(anchor.x + anchor.width - 2);
    expect(box.x + box.width).toBeLessThanOrEqual(1433);
    await page.screenshot({ path: `artifacts/library-menu-right-${mode.split(" ")[0]}.png`, animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(popup).not.toBeVisible();
  }
  await page.setViewportSize({ width: 800, height: 560 });
  const menu = page.locator("details[data-card-action-menu]").first();
  await menu.locator("summary").click();
  await expect(menu.locator(":scope > div")).toBeVisible();
  const box = (await menu.locator(":scope > div").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(7);
  expect(box.x + box.width).toBeLessThanOrEqual(793);
});
