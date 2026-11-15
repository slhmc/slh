import { expect, test } from "@playwright/test";

for (const [width, height] of [[800, 560], [1440, 900]]) {
  test(`refresh replaces its icon with a single busy indicator at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/#/local-servers");
    const refresh = page.getByRole("button", { name: "Refresh and scan folders", exact: true });
    await expect(refresh).toBeEnabled();
    const idleBox = await refresh.boundingBox();
    await page.evaluate(async () => {
      const { useServerLibraryStore } = await import("/src/stores/serverLibraryStore.ts");
      useServerLibraryStore.setState({ synchronize: () => new Promise(resolve => {
        (window as any).finishRefresh = () => resolve(useServerLibraryStore.getState().data!);
      }) });
    });
    await refresh.click();
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect(refresh).toBeDisabled();
    await expect(refresh.locator("svg")).toHaveCount(1);
    const busyBox = await refresh.boundingBox();
    expect(busyBox!.width).toBeCloseTo(idleBox!.width, 1);
    expect(busyBox!.height).toBeCloseTo(idleBox!.height, 1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(refresh.locator("svg")).toHaveCSS("animation-name", "none");
    await page.screenshot({ path: `artifacts/ui/refresh-loading-${width}.png` });
    await page.evaluate(() => (window as any).finishRefresh());
    await expect(refresh).toBeEnabled();
    await expect(refresh.locator("svg")).toHaveCount(1);
  });

  test(`Horizon remains selected during loading and recovers from release failure at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.route("**/src/lib/tauri.ts*", async route => {
      const response = await route.fetch();
      let body = await response.text();
      body = body.replace('if (name === "get_bootstrap") {', 'if (name === "get_bootstrap") { previewBootstrap.settings.general.rustMinecraft = true;');
      body = body.replace('if (name === "list_horizon_minecraft_versions")', 'if (name === "list_horizon_minecraft_versions") { await new Promise(resolve => window.finishManifest = resolve); } if (name === "list_horizon_minecraft_versions")');
      body = body.replace('if (name === "list_loader_versions") {', 'if (name === "list_loader_versions") { if (args?.loaderType === "rust" && !window.releaseRetried) { window.releaseRetried = true; throw new Error("Release unavailable"); }');
      await route.fulfill({ response, body });
    });
    await page.goto("/#/library");
    await page.getByRole("button", { name: "New instance", exact: true }).click();
    const dialog = page.getByRole("dialog");
    // The native runtime must not inherit Java-only validation.
    await dialog.getByRole("tab", { name: "Rust", exact: true }).click();
    const client = dialog.getByRole("button", { name: "Rust", exact: true });
    await expect(client).toBeEnabled();
    await client.focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("button", { name: "Create and install", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("heading", { name: "Java and memory" })).toHaveCount(0);
    const name = dialog.getByRole("textbox", { name: "Instance name", exact: true });
    await name.fill("My native instance");
    await expect.poll(() => page.evaluate(() => typeof (window as any).finishManifest)).toBe("function");
    await page.evaluate(() => (window as any).finishManifest());
    await expect(name).toHaveValue("My native instance");
    await dialog.getByRole("button", { name: "Technical details", exact: true }).click();
    await expect(dialog.getByText("Release unavailable", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(dialog.getByRole("combobox", { name: "Horizon release", exact: true })).toHaveValue("v0.3.0");
    await expect(dialog.getByRole("button", { name: "Create and install", exact: true })).toBeEnabled();
    await dialog.screenshot({ path: `test-results/horizon-loading-${width}.png` });
  });
}

test("Bedrock search with no results does not report a missing package", async ({ page }) => {
  await page.goto("/#/library");
  await page.getByRole("button", { name: "New instance", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Bedrock", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /^26.51.01/ })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Search Minecraft versions" }).fill("no-such-version");
  await expect(dialog.getByText("No matching versions", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Open Microsoft Store", exact: true })).toHaveCount(0);
});
