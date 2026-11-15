import { expect, test } from "@playwright/test";
for (const width of [800, 1440]) test(`home and discover omit random at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 800 ? 560 : 900 });
  await page.goto("/#/home");
  await expect(page.getByRole("button", { name: "Random", exact: true })).toHaveCount(0);
  await page.goto("/#/discover");
  await expect(page.getByRole("button", { name: "Random", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Discover something worth playing" })).toBeVisible();
  await page.screenshot({ path: `artifacts/ui/discover-no-random-${width}.png` });
});
