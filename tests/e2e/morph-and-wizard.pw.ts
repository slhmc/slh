import { expect, test, type Page } from "@playwright/test";

async function status(page: Page, value: string) {
  await page.evaluate(async status => {
    const { useAppStore } = await import("/src/stores/appStore.ts");
    useAppStore.setState(state => ({ bootstrap: { ...state.bootstrap!, instances: state.bootstrap!.instances.map(instance => instance.id === "preview-1" ? { ...instance, status } : instance) } }));
  }, value);
}

for (const width of [800, 1440]) {
  test(`custom instance form is compact and uses automatic Java at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 800 ? 560 : 900 });
    await page.goto("/#/library");
    await page.getByRole("button", { name: "New instance", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("radio")).toHaveCount(0);
    const memory = dialog.getByRole("slider", { name: "Maximum memory", exact: true });
    await memory.fill("6144");
    await memory.focus();
    await page.keyboard.press("ArrowRight");
    await expect(memory).toHaveValue("6400");
    const loader = dialog.locator('[class*="loaderStage"]');
    const review = dialog.locator('[class*="reviewStage"]');
    await expect(loader.getByRole("button", { name: "Vanilla", exact: true })).toBeEnabled();
    await expect(review).toContainText("512 MB – 6400 MB");
    if (width === 1440) {
      const box = (await dialog.boundingBox())!;
      expect(box.height).toBeLessThan(860);
      const memoryBox = (await dialog.locator('[class*="runtimeStage"]').boundingBox())!;
      const reviewBox = (await review.boundingBox())!;
      expect(reviewBox.x).toBeCloseTo(memoryBox.x, 0);
      expect(reviewBox.y - memoryBox.y - memoryBox.height).toBeGreaterThanOrEqual(8);
      expect(reviewBox.y - memoryBox.y - memoryBox.height).toBeLessThan(20);
      await expect(review).toContainText("Vanilla");
      const loaderBox = (await loader.boundingBox())!;
      const gridBox = (await loader.locator('[class*="loaderGrid"]').boundingBox())!;
      expect(loaderBox.y + loaderBox.height - gridBox.y - gridBox.height).toBeLessThan(20);
    }
    await review.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/ui/custom-compact-${width}.png` });
    const install = dialog.getByRole("button", { name: "Create and install", exact: true });
    await expect(install).toBeVisible();
    await expect(install).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });
}

test("icon geometry morphs in both directions, retargets, and respects its saved switch", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/#/instance/preview-1");
  
  const header = page.locator('header[class*="header"]').first();
  const icon = header.locator("[data-morph-icon]");
  const button = header.getByRole("button", { name: "Play", exact: true });
  await expect(button).toBeVisible();
  const initialPath = await icon.locator("path").getAttribute("d");
  await status(page, "running");
  await expect(icon).toHaveAttribute("data-morphing", "true");
  const geometry = icon.locator("[data-morph-geometry]");
  await expect(geometry).toHaveCount(1);
  const first = await geometry.getAttribute("d");
  await expect.poll(() => geometry.getAttribute("d")).not.toBe(first);
  // Reverse before completion: there must be one current geometry, no queued exit.
  await status(page, "installed");
  await expect(icon).toHaveAttribute("data-morphing", "true");
  await expect(icon.locator("svg")).toHaveCount(1);
  await expect(icon).not.toHaveAttribute("data-morphing");
  await expect(icon.locator("path")).toHaveAttribute("d", initialPath!);
  await status(page, "launching");
  await expect(icon).toHaveAttribute("data-icon-state", "busy");
  await expect(icon).toHaveAttribute("data-morphing", "true");
  await status(page, "installed");
  await expect(icon).not.toHaveAttribute("data-morphing");
  await page.goto("/#/settings/appearance");
  const toggle = page.getByRole("switch", { name: "Smooth animations", exact: true });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.goto("/#/instance/preview-1");
  await expect(header.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await status(page, "running");
  await expect(header.getByRole("button", { name: "Kill", exact: true })).toBeVisible();
  await expect(icon).not.toHaveAttribute("data-morphing");
  await page.goto("/#/settings/appearance");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});

test("reduced motion suppresses icon morphing and spinner rotation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/instance/preview-1");
  const icon = page.locator('header[class*="header"]').first().locator("[data-morph-icon]");
  await expect(icon).toHaveCount(1);
  await status(page, "launching");
  await expect(icon).toHaveAttribute("data-icon-state", "busy");
  await expect(icon).not.toHaveAttribute("data-morphing");
  await expect(icon).toHaveCSS("animation-name", "none");
});

for (const language of ["ru-RU", "de-DE"]) for (const width of [800, 1440]) {
  test(`custom form keeps localized fields and review within the dialog at ${language} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 800 ? 560 : 900 });
    await page.goto("/#/settings/general");
    await page.locator("[data-language-selector]").selectOption(language);
    await expect(page.locator("html")).toHaveAttribute("lang", language);
    await page.evaluate(async () => (await import("/src/stores/appStore.ts")).useAppStore.getState().setCreateWizardOpen(true));
    const dialog = page.getByRole("dialog");
    const input = dialog.locator('[class*="identityStage"] input').first();
    await input.fill("Длинное название сборки · Meine Minecraft-Sammlung");
    const loader = dialog.locator('[class*="loaderStage"]');
    await loader.getByRole("button", { name: "Fabric", exact: true }).click();
    await expect(loader.locator("select")).toHaveValue("0.16.14");
    const review = dialog.locator('[class*="reviewStage"]');
    await review.scrollIntoViewIfNeeded();
    expect(await review.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    const footer = dialog.locator("footer");
    await expect(footer.getByRole("button").last()).toBeEnabled();
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `artifacts/ui/custom-${language}-${width}.png` });
  });
}
