import { expect, test } from "@playwright/test";

test("offline accounts open the skin editor and cannot select capes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/#/settings/accounts");
  await page.getByRole("button", { name: /Manage skin and cape/ }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: /Add a skin/ })).toBeEnabled();
  await dialog.getByRole("button", { name: "Customize", exact: true }).click();
  await expect(dialog.getByRole("tab", { name: "Cape", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Replace texture", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Slim", exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 800, height: 560 });
  await expect(dialog.getByRole("button", { name: "Save skin", exact: true })).toBeVisible();
  await page.screenshot({ path: "artifacts/offline-skin-editor.png" });
  expect(errors).toEqual([]);
});
