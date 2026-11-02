import { expect, test } from "@playwright/test";

test("server player editors keep content away from the panel borders", async ({ page }) => {
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
  await page.locator('[data-server-tab="settings"]').click();
  await page.getByRole("checkbox", { name: "Whitelist", exact: true }).check();
  for (const width of [800, 1440]) {
    await page.setViewportSize({ width, height: width === 800 ? 560 : 900 });
    for (const name of ["Whitelist", "Administrators (OP)", "Banned players", "Banned IP addresses"]) {
      const region = page.getByRole("region", { name, exact: true });
      await expect(region).toBeVisible();
      if (await region.locator("details").getAttribute("open") === null) await region.locator("summary").click();
      const metrics = await region.evaluate(element => {
        const parent = element.parentElement!.getBoundingClientRect();
        const first = element.querySelector("h4")!.getBoundingClientRect();
        const input = element.querySelector("input")!.getBoundingClientRect();
        return { left: first.left - parent.left, right: parent.right - input.right, fits: element.scrollWidth <= element.clientWidth + 1 };
      });
      expect(metrics.left).toBeGreaterThanOrEqual(16);
      expect(metrics.right).toBeGreaterThanOrEqual(16);
      expect(metrics.fits).toBe(true);
    }
    await page.getByRole("region", { name: "Administrators (OP)", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/ui/player-padding-${width}.png` });
  }
});

test("Rust card stays compact while Minecraft versions load", async ({ page }) => {
  await page.route("**/src/lib/tauri.ts*", async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = 'if (name === "list_horizon_minecraft_versions") return';
    expect(source).toContain(marker);
    await route.fulfill({ response, body: source.replace(marker, 'if (name === "list_horizon_minecraft_versions") await new Promise(resolve => setTimeout(resolve, 3000));\n    ' + marker) });
  });
  await page.goto("/#/settings/advanced");
  await page.getByRole("switch", { name: "Minecraft on Rust", exact: true }).check();
  await page.goto("/#/library");
  await page.getByRole("button", { name: "New instance", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Rust", exact: true }).click();
  const card = dialog.getByRole("button", { name: "Rust", exact: true });
  await expect(card).toBeVisible();
  await expect(card.locator("em")).toHaveCount(0);
  for (const width of [800, 1440]) {
    await page.setViewportSize({ width, height: width === 800 ? 560 : 900 });
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/ui/rust-card-${width}.png` });
  }
  await expect(dialog.getByRole("button", { name: /^26\.3/ })).toBeVisible();
  await dialog.getByRole("button", { name: /^26\.3/ }).click();
  await expect(dialog.getByRole("combobox", { name: "Horizon release", exact: true })).toHaveValue("v0.2.97");
});
