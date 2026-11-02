import { expect, test, type Page } from "@playwright/test";

async function workspace(page: Page, modern = false) {
  await page.goto("/#/local-servers");
  await expect(page.getByRole("button", { name: "Weekend", exact: true })).toBeVisible();
  if (modern) {
    await page.evaluate(() => {
      const library = JSON.parse(localStorage.getItem("slh.previewServerLibrary")!);
      library.servers.find((server: { name: string }) => server.name === "Weekend").config.minecraftVersion = "26.3";
      localStorage.setItem("slh.previewServerLibrary", JSON.stringify(library));
    });
    await page.reload();
  }
  await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.locator('[data-server-tab="settings"]').click();
}

test("fresh host state enables players even if workspace still displays starting", async ({ page }) => {
  await workspace(page);
  await page.evaluate(() => localStorage.setItem("slh.previewDisplayedServerStates", JSON.stringify({ "preview-Weekend": "starting" })));
  await expect(page.getByRole("checkbox", { name: "Whitelist", exact: true })).toBeEnabled();
  const whitelist = page.getByRole("region", { name: "Whitelist", exact: true });
  await whitelist.locator("summary").click();
  await whitelist.getByRole("textbox", { name: "Player name", exact: true }).fill("Alex");
  await expect(whitelist.getByRole("button", { name: "Add player", exact: true })).toBeEnabled();
  await whitelist.getByRole("button", { name: "Add player", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(whitelist.getByRole("listitem")).toContainText("Alex");
});

test("manual RAM values save while running and remain after reload", async ({ page }) => {
  await workspace(page);
  await page.getByRole("tab", { name: "Java and launch", exact: true }).click();
  const minimum = page.getByRole("spinbutton", { name: "Minimum memory (MiB)", exact: true });
  const maximum = page.getByRole("spinbutton", { name: "Maximum memory (MiB)", exact: true });
  await minimum.fill("128"); await maximum.fill("2048");
  await expect(page.getByRole("button", { name: "Choose Java", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Save memory", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Memory saved for the next start." })).toBeVisible();
  await maximum.fill("100");
  await expect(page.getByRole("button", { name: "Save memory", exact: true })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("maximum must be at least minimum");
  await page.reload(); await page.getByRole("tab", { name: "Java and launch", exact: true }).click();
  await expect(minimum).toHaveValue("128"); await expect(maximum).toHaveValue("2048");
  await page.locator('[data-server-tab="overview"]').click();
  await expect(page.locator("dt").filter({ hasText: "RAM (MiB)" })).toBeVisible();
  await expect(page.locator("dd").filter({ hasText: "128–2048 MiB" })).toBeVisible();
});

test("live world settings send validated commands and versioned or custom gamerules", async ({ page }) => {
  await workspace(page, true);
  await page.getByRole("tab", { name: "Live world settings", exact: true }).click();
  for (const [label, value, command] of [["Difficulty", "hard", "difficulty hard"], ["Default game mode", "creative", "defaultgamemode creative"], ["Weather", "rain", "weather rain"], ["Time of day", "noon", "time set noon"]]) {
    const select = page.getByRole("combobox", { name: label, exact: true });
    await select.selectOption(value);
    await page.locator('[class*="settingRow"]').filter({ has: select }).getByRole("button", { name: "Apply", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Command sent" })).toContainText(command);
  }
  await page.getByRole("combobox", { name: "Game rule", exact: true }).selectOption("pvp");
  await page.getByRole("combobox", { name: "Rule value", exact: true }).selectOption("false");
  const rule = page.locator('[class*="settingRow"]').filter({ has: page.getByRole("combobox", { name: "Game rule", exact: true }) });
  await rule.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Command sent" })).toContainText("gamerule minecraft:pvp false");
  await page.getByRole("combobox", { name: "Game rule", exact: true }).selectOption("custom");
  await page.getByRole("textbox", { name: "Rule identifier", exact: true }).fill("mod:custom_rule");
  await page.getByRole("textbox", { name: "Rule value", exact: true }).fill("42");
  await rule.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Command sent" })).toContainText("gamerule mod:custom_rule 42");
});

test("live controls and confirmation work in light row layout at 800 pixels", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/settings/appearance");
  await page.getByRole("button", { name: /Light Orange/ }).click();
  const compact = page.getByRole("switch", { name: "Compact settings menu (beta)", exact: true });
  if (await compact.getAttribute("aria-checked") === "true") await compact.click();
  await workspace(page, true);
  await page.setViewportSize({ width: 800, height: 560 });
  await page.getByRole("tab", { name: "Live world settings", exact: true }).click();
  const border = page.getByRole("spinbutton", { name: "World border diameter", exact: true });
  await border.fill("1000");
  const row = page.locator('[class*="settingRow"]').filter({ has: border });
  await row.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("A smaller border");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("slh.previewLiveCommands") ?? "[]"))).toEqual([]);
  expect(await page.getByRole("tabpanel").evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "artifacts/server-live-v2-light-rows-800.png", animations: "disabled" });
});

for (const [locale, label] of [["en-US", "Live world settings"], ["ru-RU", "Управление миром"], ["de-DE", "Welt im laufenden Betrieb"]]) {
  test(`${locale} live settings use launcher layout at both sizes`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#/settings/general"); await page.locator("[data-language-selector]").selectOption(locale);
    await page.goto("/#/local-servers"); await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
    await page.locator('[data-server-tab="settings"]').click(); await page.getByRole("tab", { name: label, exact: true }).click();
    for (const [width, height] of [[1440, 900], [800, 560]]) {
      await page.setViewportSize({ width, height });
      expect(await page.getByRole("tabpanel").evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: `artifacts/server-live-v2-${locale}-${width}.png`, animations: "disabled" });
    }
  });
}
