import { expect, test } from "@playwright/test";

test("100% uses the 90% baseline and the shell fills the viewport", async ({ page }) => {
  await page.goto("/#/library");
  await expect(page.getByRole("heading", { name: "Instance library" })).toBeVisible();
  await expect(page.locator("body")).toHaveCSS("zoom", "0.9");
  const state = await page.evaluate(async () => (await import("/src/stores/appStore.ts")).useAppStore.getState().bootstrap!.settings.appearance.scalePercent);
  expect(state).toBe(100);
  const bar = (await page.getByRole("contentinfo").boundingBox())!;
  expect(bar.y + bar.height).toBeCloseTo(900, 0);
  expect(bar.x + bar.width).toBeCloseTo(1440, 0);
});

test("dialogs and switch thumbs animate, and the saved switch disables new motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/#/library");
  await page.getByRole("button", { name: "New instance", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAttribute("data-motion", "entering");
  await expect(dialog).not.toHaveAttribute("data-motion");
  expect((await dialog.boundingBox())!.height).toBeGreaterThan(740);
  await page.keyboard.press("Escape");
  await page.goto("/#/settings/appearance");
  const toggle = page.getByRole("switch", { name: "Smooth animations", exact: true });
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("html")).toHaveAttribute("data-smooth-animations", "false");
  await page.getByRole("button", { name: "New instance", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveAttribute("data-motion");
});
