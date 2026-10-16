import { expect, test } from "@playwright/test";

test("Java discovery fits long paths in rows and tiles and distinguishes disk search", async ({ page }) => {
  await page.goto("/#/settings/java");
  const find = page.getByRole("button", { name: "Detect Java", exact: true }).last();
  await expect(find).toBeVisible();
  await page.getByRole("button", { name: "Search all disks", exact: true }).click();
  await expect(page.locator('[class*="runtimeList"]')).toContainText("JAVA_HOME");
  await expect(page.locator('[class*="runtimeList"]')).not.toContainText("disk scan");
  for (const compact of [false, true]) {
    await page.evaluate(async compact => {
      const { command } = await import("/src/lib/tauri.ts");
      const { useAppStore } = await import("/src/stores/appStore.ts");
      await command("update_setting", { key: "general", value: { ...useAppStore.getState().bootstrap!.settings.general, compactSettings: compact, language: "ru-RU" } });
      await useAppStore.getState().refresh();
    }, compact);
    for (const width of [1440, 800]) {
      await page.setViewportSize({ width, height: 900 });
      const runtimes = page.locator('[class*="runtimeList"]');
      await expect(runtimes).toBeVisible();
      expect(await runtimes.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const overlapping = await runtimes.locator(':scope > div').evaluateAll(rows => rows.some(row => {
        const spans = row.querySelectorAll(':scope > span');
        if (spans.length < 2) return false;
        const text = spans[0].getBoundingClientRect(), badge = spans[1].getBoundingClientRect();
        return text.right > badge.left + 1 && text.top < badge.bottom && text.bottom > badge.top;
      }));
      expect(overlapping).toBe(false);
      await runtimes.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `artifacts/ui/java-${width}-${compact}.png` });
    }
  }
});

test("shared busy arrows respect reduced motion and clear after failure", async ({ page }) => {
  await page.goto("/#/settings/java");
  await expect(page.getByRole("button", { name: "Detect Java", exact: true }).last()).toBeVisible();
  await page.evaluate(async () => {
    const { useAppStore } = await import("/src/stores/appStore.ts");
    useAppStore.getState().receiveProgress({ operationId: "java-ui-test", instanceId: null,
      operation: "java", stage: "metadata", message: "Installing", completed: 0, total: null,
      downloadedBytes: null, totalBytes: null });
  });
  const indicator = page.locator('[class*="javaProgress"] svg');
  await expect(indicator).toBeVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await indicator.evaluate(element => getComputedStyle(element).animationName)).not.toBe("none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await indicator.evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  await page.evaluate(async () => {
    const { useAppStore } = await import("/src/stores/appStore.ts");
    useAppStore.getState().receiveProgress({ operationId: "java-ui-test", instanceId: null,
      operation: "java", stage: "failed", message: "Failed", completed: 0, total: null,
      downloadedBytes: null, totalBytes: null });
  });
  await expect(indicator).toHaveCount(0);
});
