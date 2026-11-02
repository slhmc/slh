import { expect, test } from "@playwright/test";

test("rapid zoom shortcuts apply each step even when saving is slow", async ({ page }) => {
  await page.route("**/src/lib/tauri.ts*", async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = 'if (!isTauri) {';
    expect(source).toContain(marker);
    await route.fulfill({ response, body: source.replace(marker, 'if (name === "update_setting" && args?.key === "appearance") await new Promise(resolve => setTimeout(resolve, 250));\n  ' + marker) });
  });
  await page.goto("/#/library");
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) window.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, code: "Equal", key: "=", bubbles: true, cancelable: true }));
  });
  await expect.poll(() => page.evaluate(async () => {
    const { useAppStore } = await import("/src/stores/appStore.ts");
    return useAppStore.getState().bootstrap?.settings.appearance.scalePercent;
  })).toBe(115);
  await expect(page.locator('[class*="toast"][class*="brief"]')).toContainText("115%");
});
