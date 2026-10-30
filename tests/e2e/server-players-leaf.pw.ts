import { expect, test } from "@playwright/test";

test("Leaf is available in creation and keeps Bukkit path validation", async ({ page }) => {
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Create server", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Core", exact: true }).selectOption("leaf");
  await expect(dialog.getByRole("combobox", { name: "Core", exact: true })).toHaveValue("leaf");
  await expect(dialog.getByRole("combobox", { name: "Core version / build", exact: true })).toHaveValue("1.0");
  await dialog.getByLabel("Name", { exact: true }).fill("Leaf server");
  await dialog.getByLabel("Folder name", { exact: true }).fill("Leaf+server");
  await expect(dialog.getByRole("alert")).toContainText("Bukkit");
  await expect(dialog.getByRole("button", { name: "Create server", exact: true })).toBeDisabled();
});

test("standard player lists support confirmation, persistence, removal and running-server protection", async ({ page }) => {
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
  await page.locator('[data-server-tab="settings"]').click();
  await expect(page.getByRole("region", { name: "Whitelist", exact: true })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Whitelist", exact: true }).check();
  const whitelist = page.getByRole("region", { name: "Whitelist", exact: true });
  await whitelist.getByRole("textbox", { name: "Player name", exact: true }).fill("Notch");
  await whitelist.getByRole("textbox", { name: "UUID (optional)", exact: true }).fill("b50ad385-829d-3141-a216-7e7d7539ba7f");
  await whitelist.getByRole("button", { name: "Add player", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(whitelist.getByRole("listitem")).toHaveCount(0);
  await whitelist.getByRole("button", { name: "Add player", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(whitelist.getByRole("listitem")).toContainText("Notch");
  const ops = page.getByRole("region", { name: "Administrators (OP)", exact: true });
  await ops.getByRole("textbox", { name: "Player name", exact: true }).fill("Admin");
  await ops.getByRole("combobox").selectOption("2");
  await ops.getByRole("button", { name: "Add player", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("level 2");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(ops.getByRole("listitem")).toContainText("Permission level: 2");
  const bans = page.getByRole("region", { name: "Banned players", exact: true });
  await bans.getByRole("textbox", { name: "Player name", exact: true }).fill("Griefer");
  await bans.getByRole("textbox", { name: "Ban reason (optional)", exact: true }).fill("Griefing");
  await bans.getByRole("button", { name: "Add player", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(bans.getByRole("listitem")).toContainText("Griefing");
  const ips = page.getByRole("region", { name: "Banned IP addresses", exact: true });
  await ips.getByRole("textbox", { name: "IP address", exact: true }).fill("192.0.2.1");
  await ips.getByRole("button", { name: "Ban IP address", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(ips.getByRole("listitem")).toContainText("192.0.2.1");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Settings saved." })).toBeVisible();
  await page.reload();
  await expect(whitelist.getByRole("listitem")).toContainText("Notch");
  await expect(ops.getByRole("listitem")).toContainText("Admin");
  await ips.getByRole("button", { name: "Remove 192.0.2.1", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(ips.getByRole("listitem")).toHaveCount(0);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.locator('[data-server-tab="settings"]').click();
  await expect(ops.getByRole("button", { name: "Add player", exact: true })).toBeDisabled();
});

for (const [locale, heading] of [["en-US", "Administrators (OP)"], ["ru-RU", "Администраторы (OP)"], ["de-DE", "Administratoren (OP)"]]) {
  test(`${locale} player list controls fit a narrow window`, async ({ page }) => {
    await page.goto("/#/settings/general"); await page.locator("[data-language-selector]").selectOption(locale);
    await page.goto("/#/local-servers"); await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
    await page.locator('[data-server-tab="settings"]').click();
    await page.setViewportSize({ width: 800, height: 560 });
    const ops = page.getByRole("region", { name: heading, exact: true });
    await ops.scrollIntoViewIfNeeded();
    expect(await ops.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `artifacts/server-players-${locale}.png`, animations: "disabled" });
  });
}
