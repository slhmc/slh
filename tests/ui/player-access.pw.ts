import { expect, test } from "@playwright/test";
for (const compact of [false, true]) {
  test(`player access is discoverable with compact=${compact}`, async ({ page }) => {
    await page.route("https://mc-heads.net/**", route => route.abort());
    await page.goto("/#/settings/general");
    await page.evaluate(async compact => {
      const { command } = await import("/src/lib/tauri.ts");
      const { useAppStore } = await import("/src/stores/appStore.ts");
      await command("update_setting", { key: "general", value: { ...useAppStore.getState().bootstrap.settings.general, compactSettings: compact } });
      await useAppStore.getState().refresh();
    }, compact);
    await page.goto("/#/local-servers");
    await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
    await page.locator('[data-server-tab="settings"]').click();
    await page.getByRole("button", { name: "Players and access", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Players and access", exact: true })).toBeVisible();
    const whitelist = page.getByRole("region", { name: "Whitelist", exact: true });
    await expect(whitelist).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Whitelist", exact: true })).not.toBeChecked();
    const ops = page.getByRole("region", { name: "Administrators (OP)", exact: true });
    await ops.getByText("Add administrator", { exact: true }).click();
    await ops.getByRole("textbox", { name: "Player name", exact: true }).fill("Notch");
    await ops.getByRole("button", { name: "Add player", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(ops.getByRole("listitem")).toContainText("Notch");
    await expect(ops.locator('[class*="head"] svg')).toBeVisible();
    await ops.locator("summary").click();
    for (const width of [800, 1440]) {
      await page.setViewportSize({ width, height: width === 800 ? 560 : 900 });
      await ops.scrollIntoViewIfNeeded();
      expect(await ops.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: `artifacts/ui/player-access-${compact}-${width}.png` });
    }
  });
}
