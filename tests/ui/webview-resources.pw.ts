import { expect, test } from "@playwright/test";

test("Advanced no longer exposes WebView2 resource limits, including with a saved legacy policy", async ({ page }) => {
  await page.goto("/#/settings/advanced");
  await page.evaluate(async () => {
    const { command } = await import("/src/lib/tauri.ts");
    const { useAppStore } = await import("/src/stores/appStore.ts");
    const store = useAppStore.getState();
    await command("update_setting", { key:"general", value:{ ...store.bootstrap.settings.general,
      webview:{enabled:true,extreme:true,cpuCores:1,backgroundCpuCores:1,backgroundMemoryMb:16,maxFps:1,suspendAfterSeconds:1} } });
    await store.refresh();
  });
  await expect(page.locator("[data-webview-controls]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name:/WebView2 resources|Ресурсы WebView2/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name:"Check for updates",exact:true })).toBeVisible();
  await page.goto("/#/home");
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible();
  await page.waitForFunction(() => document.querySelector("canvas")?.height > 400);
  const widths = await canvas.evaluate(canvas => ({canvas:canvas.getBoundingClientRect().width,stage:canvas.parentElement!.getBoundingClientRect().width}));
  expect(widths.canvas).toBeCloseTo(widths.stage,0);
  await page.screenshot({path:"artifacts/performance/shadow-full-stage.png"});
});
