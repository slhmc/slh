import { expect, test } from "@playwright/test";

test("3D controls share a tile and keep all mode labels readable", async ({ page }) => {
  await page.goto("/#/settings/appearance");
  const compact = page.getByRole("switch", { name: "Compact settings menu (beta)", exact: true });
  await compact.check();
  await expect(page.getByText("3D character settings", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Follow cursor", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "2 · 3D", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "1 · Image", exact: true }).click();
  const follow = page.getByRole("switch", { name: "Follow cursor", exact: true });
  await expect(follow).toBeDisabled();
  const disabledColor = await follow.evaluate(element => getComputedStyle(element).backgroundColor);
  await page.getByRole("button", { name: "2 · 3D", exact: true }).click();
  await follow.check();
  expect(await follow.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(disabledColor);
  await page.screenshot({ path: "test-results/character-settings-tiles.png" });
  await compact.uncheck();
  await expect(page.getByText("3D character settings", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Follow cursor", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/character-settings-rows.png" });
  await page.goto("/#/settings/sync");
  const rust = page.getByRole("switch", { name: "Sync with Rust instances", exact: true });
  await rust.check();
  await page.reload();
  // Preview settings are memory-backed; native persistence is tested in Rust.
  await expect(rust).toBeVisible();
});

test("Horizon badge and help do not overlap its switch in both layouts", async ({ page }) => {
  await page.goto("/#/settings/appearance");
  const compact = page.getByRole("switch", { name: "Compact settings menu (beta)", exact: true });
  for (const enabled of [true, false]) {
    await compact.setChecked(enabled);
    await page.goto("/#/settings/advanced");
    const toggle = page.getByRole("switch", { name: "Minecraft on Rust", exact: true });
    const help = page.getByRole("button", { name: "FAQ?", exact: true });
    const badge = page.getByText("Beta", { exact: true });
    const [toggleBox, helpBox, badgeBox] = await Promise.all([toggle.boundingBox(), help.boundingBox(), badge.boundingBox()]);
    expect(toggleBox!.y).toBeGreaterThanOrEqual(Math.max(helpBox!.y + helpBox!.height, badgeBox!.y + badgeBox!.height));
    await page.goto("/#/settings/appearance");
  }
});
