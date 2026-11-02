import { expect, test } from "@playwright/test";

test("server placement is controlled only by launcher settings", async ({ page }) => {
  await page.goto("/#/settings/general");
  const position = page.getByRole("combobox", { name: "Instance and server tabs position", exact: true });
  await position.selectOption("right");
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
  await expect(page.locator('[class*="detailFrame"]')).toHaveClass(/tabsRight/);
  await page.locator('[data-server-tab="settings"]').click();
  await expect(page.getByRole("combobox", { name: "Tab position", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Server layout", exact: true })).toHaveCount(0);
  await page.goto("/#/settings/general");
  await position.selectOption("bottom");
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
  await expect(page.locator('[class*="detailFrame"]')).toHaveClass(/tabsBottom/);
});

test("running server keeps settings navigation and applies every access list", async ({ page }) => {
  await page.goto("/#/local-servers");
  await page.evaluate(() => localStorage.setItem("slh.previewServerProperties", JSON.stringify({ "preview-Weekend": "op-permission-level=2\n" })));
  await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.locator('[data-server-tab="settings"]').click();
  const players = page.getByRole("tab", { name: "Players and access", exact: true });
  await expect(players).toHaveAttribute("aria-selected", "true");
  for (const tab of await players.locator(".. ").getByRole("tab").all()) {
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
  await page.getByRole("tab", { name: "Java and launch", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "Maximum memory (MiB)" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await players.focus(); await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Advanced", exact: true })).toBeFocused();
  await page.keyboard.press("Home"); await expect(players).toBeFocused();
  await page.getByRole("checkbox", { name: "Whitelist", exact: true }).check();
  await expect(page.getByRole("checkbox", { name: "Whitelist", exact: true })).toBeChecked();
  for (const [label, name, ip] of [
    ["Whitelist", "Alex", false], ["Administrators (OP)", "Admin", false],
    ["Banned players", "Griefer", false], ["Banned IP addresses", "192.0.2.10", true],
  ] as const) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    const region = page.getByRole("region", { name: label, exact: true });
    await region.locator("summary").click();
    await expect(region.getByRole("textbox", { name: "UUID (optional)", exact: true })).toHaveCount(0);
    await region.getByRole("textbox", { name: ip ? "IP address" : "Player name", exact: true }).fill(name);
    await region.getByRole("button", { name: ip ? "Ban IP address" : "Add player", exact: true }).click();
    if (label !== "Administrators (OP)") await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(region.getByRole("listitem")).toContainText(name);
    if (label === "Administrators (OP)") {
      await expect(region.getByRole("combobox")).toHaveValue("2");
      await expect(region.getByRole("listitem")).toContainText("Permission level: 2");
    }
    await region.getByRole("button", { name: `Remove ${name}`, exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(region.getByRole("listitem")).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("tab", { name: "Java and launch", exact: true }).click();
  const memory = page.getByRole("spinbutton", { name: "Maximum memory (MiB)" });
  await expect(memory).toBeEnabled(); await memory.fill("3072");
  await players.click(); await page.getByRole("tab", { name: "Java and launch", exact: true }).click();
  await expect(memory).toHaveValue("3072");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Settings saved." })).toBeVisible();
});

for (const locale of ["en-US", "ru-RU", "de-DE"]) {
  test(`${locale} settings match launcher geometry at both window sizes`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#/settings/general");
    await page.locator("[data-language-selector]").selectOption(locale);
    await page.goto("/#/local-servers");
    await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
    await page.locator('[data-server-tab="settings"]').click();
    await expect(page.getByRole("region")).toHaveCount(1);
    for (const [width, height] of [[1440, 900], [800, 560]]) {
      await page.setViewportSize({ width, height });
      const settingsTabs = page.getByRole("tab", { name: locale === "en-US" ? "Players and access" : locale === "ru-RU" ? "Игроки и доступ" : "Spieler und Zugriff", exact: true }).locator("..");
      for (const tab of await settingsTabs.getByRole("tab").all()) {
        await tab.click();
        const panel = page.getByRole("tabpanel").first();
        expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      }
      await page.getByRole("tab").first().click();
      await page.screenshot({ path: `artifacts/server-settings-${locale}-${width}.png`, animations: "disabled" });
    }
  });
}
