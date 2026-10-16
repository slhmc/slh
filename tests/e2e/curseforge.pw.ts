import { expect, test } from "@playwright/test";

test("CurseForge modpacks require a selected Minecraft and pack version", async ({ page }) => {
  await page.goto("/#/discover", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "CurseForge", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fabulously Optimized" })).toBeVisible();
  await page.getByRole("button", { name: "Install", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Download and install" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Minecraft version", exact: true }).click();
  await dialog.getByRole("listbox").getByRole("option", { name: "1.21.7", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Modpack version", exact: true })).toContainText("1.0");
  await expect(dialog.getByRole("button", { name: "Download and install" })).toBeEnabled();
});

test("installing from description keeps the enclosing creation wizard open", async ({ page }) => {
  await page.goto("/#/library", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New instance", exact: true }).click();
  const wizard = page.getByRole("dialog").filter({ hasText: "Create a Minecraft instance" });
  await wizard.getByRole("button", { name: "CurseForge", exact: true }).click();
  await wizard.getByRole("heading", { name: "Fabulously Optimized" }).click();
  const description = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Description", exact: true }) }).last();
  await description.getByRole("button", { name: "Install", exact: true }).click();
  const install = page.locator("dialog[open]").filter({ has: page.locator("[data-install-dialog]") }).last();
  await expect(install).toBeVisible();
  await expect(wizard).toBeVisible();
  await install.getByRole("button", { name: "Minecraft version", exact: true }).click();
  await install.getByRole("option", { name: "1.21.7", exact: true }).click();
  await install.getByRole("button", { name: "Download and install", exact: true }).click();
  await expect(page).toHaveURL(/#\/instance\/preview-modpack$/);
  await expect(wizard).not.toBeVisible();
});


