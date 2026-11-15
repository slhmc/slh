import { expect, test } from "@playwright/test";

for (const width of [800, 1440]) test(`server templates support access lists and clear sections at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 800 ? 560 : 900 });
  await page.goto("/#/settings/servers");
  await page.getByRole("switch", { name: "Whitelist", exact: true }).check();
  const name = page.getByRole("textbox", { name: "Player name", exact: true });
  await name.fill("Alex");
  await page.getByRole("button", { name: "Add to whitelist", exact: true }).click();
  await expect(page.getByRole("listitem")).toContainText("Alex");
  await page.getByRole("button", { name: "Administrators (OP)", exact: true }).click();
  await name.fill("Admin");
  await page.getByRole("combobox", { name: /Permission level/ }).selectOption("3");
  await page.getByRole("button", { name: "Add administrator", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("switch", { name: "Whitelist", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Administrators (OP)", exact: true }).click();
  await expect(page.getByRole("listitem")).toContainText("Admin");
  await expect(page.getByRole("listitem")).toContainText("3");
  await name.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `artifacts/ui/server-defaults-access-${width}.png` });
  await page.getByRole("tab", { name: "World", exact: true }).click();
  await expect(page.getByText(/Changing them does not recreate/)).toBeVisible();
  expect(await page.locator('[class*="formShell"]').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `artifacts/ui/server-defaults-world-${width}.png` });
  for (const section of ["Folders and ports", "Core and version", "Java and launch", "Network", "Server rules", "Advanced"]) {
    await page.getByRole("tab", { name: section, exact: true }).click();
    const panel = page.getByRole("tabpanel");
    expect(await panel.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  }
});

test("stopped installed server can install a changed core after explicit review", async ({ page }) => {
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
  await page.locator('[data-server-tab="settings"]').click();
  await page.getByRole("tab", { name: "Core and version", exact: true }).click();
  const core = page.getByRole("combobox", { name: "Core", exact: true });
  await expect(core).toBeEnabled(); await core.selectOption("purpur");
  const version = page.getByRole("combobox", { name: "Minecraft version", exact: true });
  await expect(version).toBeEnabled(); await version.selectOption("1.21.3");
  const build = page.getByRole("combobox", { name: "Core version / build", exact: true });
  await expect(build).toBeEnabled();
  await expect(build).not.toHaveValue("");
  await page.getByRole("button", { name: "Install selected core", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Install selected core", exact: true });
  await expect(confirm).toContainText("1.21.3");
  await confirm.getByRole("button", { name: "Install selected core", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Settings saved." })).toBeVisible();
  await page.reload(); await page.getByRole("tab", { name: "Core and version", exact: true }).click();
  await expect(core).toHaveValue("purpur"); await expect(version).toHaveValue("1.21.3");
});
