import { expect, test } from "@playwright/test";

for (const width of [800, 1440]) test(`settings spacing and animation limits at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 800 ? 560 : 900 });
  await page.goto("/#/settings/appearance");
  const speed = page.getByRole("spinbutton", { name: "Animation speed", exact: true });
  for (const value of ["0.1", "10"]) {
    await speed.fill(value); await speed.press("Tab");
    await expect(speed).toHaveValue(value);
  }
  await speed.fill("10.1"); await speed.press("Tab"); await expect(speed).toHaveValue("10");
  const more = page.getByRole("button", { name: "Animation settings", exact: true });
  const controls = more.locator("..");
  const rightGap = await controls.evaluate(node => node.getBoundingClientRect().right - node.lastElementChild!.getBoundingClientRect().right);
  expect(rightGap).toBeLessThan(2);
  await more.click();
  const dialog = page.getByRole("dialog", { name: "Animation settings", exact: true });
  await expect(dialog.getByText("Slight compression when pressed and smooth color changes.")).toBeVisible();
  const icons = dialog.getByRole("spinbutton", { name: "Icons: speed", exact: true });
  await icons.fill("0.1"); await icons.press("Tab");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await more.click(); await expect(icons).toHaveValue("0.1");
  await expect(dialog).not.toHaveAttribute("data-motion");
  if (width === 1440) expect((await dialog.boundingBox())!.width).toBeCloseTo(816 * 0.9, 0);
  await page.screenshot({ path: `artifacts/ui/animation-expanded-${width}.png` });
  await page.keyboard.press("Escape");
  await page.goto("/#/settings/storage");
  const cleanup = page.locator('section[class*="cleanup"]').first();
  await expect(cleanup.getByRole("button", { name: "Analyze files", exact: true })).toBeVisible();
  expect(await cleanup.evaluate(node => parseFloat(getComputedStyle(node).paddingLeft))).toBe(24);
  expect(await page.locator('[class*="storageGrid"]').evaluate(node => parseFloat(getComputedStyle(node).gap))).toBe(12);
  await page.screenshot({ path: `artifacts/ui/storage-spacing-${width}.png` });
});

test("action list settings change both panels and allow independent server configuration", async ({ page }) => {
  await page.goto("/#/settings/appearance");
  await page.getByRole("switch", { name: "Show actions as a list", exact: true }).click();
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Weekend", exact: true }).click();
  const grid = page.locator('[class*="quickGrid"]').first();
  await expect(grid).toHaveAttribute("data-list", "true");
  expect(await grid.evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length)).toBe(1);
  await page.goto("/#/settings/appearance");
  await page.getByRole("button", { name: "Action display settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Action display settings", exact: true });
  await dialog.getByRole("switch", { name: "Local servers", exact: true }).click();
  await expect(dialog.getByRole("switch", { name: "Minecraft", exact: true })).toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.goto("/#/local-servers");
  await expect(grid).toHaveAttribute("data-list", "false");
  await page.goto("/#/library");
  await page.getByRole("button", { name: "Latest release", exact: true }).click();
  await expect(grid).toHaveAttribute("data-list", "true");
});

test("starting servers expose an actionable stop cross", async ({ page }) => {
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Weekend", exact: true }).click();
  await page.evaluate(async () => {
    const { useServerLibraryStore } = await import("/src/stores/serverLibraryStore.ts");
    useServerLibraryStore.setState(state => ({ data: { ...state.data!, servers: state.data!.servers.map(server => ({ ...server, status: "starting" })) }, refresh: async () => useServerLibraryStore.getState().data! }));
  });
  const stop = page.getByRole("button", { name: "Stop", exact: true }).first();
  await expect(stop).toBeEnabled();
  await expect(stop.locator("[data-morph-icon]")).toHaveAttribute("data-icon-state", "idle");
  await expect(stop).not.toHaveAttribute("aria-busy");
});
