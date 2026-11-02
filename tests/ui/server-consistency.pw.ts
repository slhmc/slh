import { expect, test } from "@playwright/test";

test("server icon status stays compact and remains available as a description", async ({ page }) => {
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Grouped icons", exact: true }).click();
  await page.getByRole("button", { name: "Weekend", exact: true }).click();
  const stoppedHeight = (await page.getByRole("button", { name: "Weekend", exact: true }).boundingBox())!.height;
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Grouped icons", exact: true }).click();
  const card = page.getByRole("button", { name: "Weekend", exact: true });
  await expect(card).toHaveAccessibleDescription("Running");
  const indicator = card.locator('[title="Running"]');
  await expect(indicator).toBeVisible();
  expect(await indicator.evaluate(element => getComputedStyle(element).position)).toBe("absolute");
  expect((await indicator.boundingBox())!.width).toBe(20);
  expect((await card.boundingBox())!.height).toBe(stoppedHeight);
});

test("shared button press does not move with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/local-servers");
  const button = page.getByRole("button", { name: "Create server", exact: true });
  await button.hover();
  await page.mouse.down();
  expect(await button.evaluate(element => getComputedStyle(element).transform)).toBe("none");
  await page.mouse.up();
});
