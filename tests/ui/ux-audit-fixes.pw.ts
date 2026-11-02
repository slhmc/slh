import { expect, test, type Page } from "@playwright/test";

async function route(page: Page, path: string) {
  await page.evaluate(path => { location.hash = path; }, path);
}
async function settings(page: Page, key: string, value: Record<string, unknown>) {
  await page.evaluate(async ({ key, value }) => {
    const { command } = await import("/src/lib/tauri.ts");
    const { useAppStore } = await import("/src/stores/appStore.ts");
    await command("update_setting", { key, value: { ...useAppStore.getState().bootstrap.settings[key], ...value } });
    await useAppStore.getState().refresh();
  }, { key, value });
}

test("instance deletion asks once, cancels safely and honors the warning preference", async ({ page }) => {
  await page.goto("/#/library");
  const card = page.getByRole("button", { name: "Latest release", exact: true });
  await card.click();
  await page.getByRole("button", { name: "Delete instance", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete instance", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Latest release", { exact: true })).toBeVisible();
  await expect(card).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(card).toHaveCount(1);
  await route(page, "/settings/advanced");
  const warnings = page.getByRole("switch", { name: "Confirm dangerous actions", exact: true });
  await warnings.click();
  await expect(warnings).toHaveAttribute("aria-checked", "false");
  await route(page, "/library");
  await card.click();
  await page.getByRole("button", { name: "Delete instance", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
});

test("a failed file category cannot display the previous category and can retry", async ({ page }) => {
  await page.route("**/src/lib/tauri.ts*", async request => {
    const response = await request.fetch();
    const body = (await response.text()).replace('export async function command(name, args) {', `export async function command(name, args) {
      if (name === "list_instance_files") {
        if (args.category === "worlds" && !window.auditRetry) throw new Error("fixture read failure");
        return args.category === "mods" ? [{name:"audit-mod.jar",path:"E:/fixture/mods/audit-mod.jar",entryType:"file",sizeBytes:10,modifiedAt:null,iconDataUrl:null}] : [];
      }`);
    await request.fulfill({ response, body });
  });
  await page.goto("/#/instance/preview-2?tab=mods");
  await expect(page.getByText("audit-mod.jar", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Worlds", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Files could not be indexed" })).toBeVisible();
  await expect(page.getByText("audit-mod.jar", { exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).auditRetry = true; });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No worlds yet" })).toBeVisible();
});

test("world deletion waits for confirmation and Stop keeps a painted background", async ({ page }) => {
  await page.route("**/src/lib/tauri.ts*", async request => {
    const response = await request.fetch();
    const body = (await response.text()).replace('export async function command(name, args) {', `export async function command(name, args) {
      if(name === "list_instance_files") return [{name:"Audit World",path:"E:/fixture/saves/Audit World",entryType:"directory",sizeBytes:10,modifiedAt:null,iconDataUrl:null}];
      if(name === "delete_instance_content") {window.auditDeleted = args; return null;}`);
    await request.fulfill({ response, body });
  });
  await page.goto("/#/instance/preview-2?tab=worlds");
  await page.getByRole("button", { name: "Delete Audit World", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Delete", exact: true });
  await expect(confirmation).toBeVisible();
  expect(await page.evaluate(() => (window as any).auditDeleted)).toBeUndefined();
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Audit World", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete Audit World", exact: true }).click();
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).auditDeleted?.category)).toBe("worlds");
  await page.evaluate(async () => {
    const { useAppStore } = await import("/src/stores/appStore.ts");
    const bootstrap = structuredClone(useAppStore.getState().bootstrap);
    bootstrap.instances.forEach(instance => { instance.status = "running"; });
    useAppStore.setState({ bootstrap });
  });
  await route(page, "/home");
  const stop = page.locator('[class*="stopRow"] > button');
  await expect(stop).toBeVisible();
  const styles = await stop.evaluate(element => ({ fill: getComputedStyle(element).backgroundColor, shadow: getComputedStyle(element.parentElement!).boxShadow }));
  expect(styles.fill).not.toBe("rgba(0, 0, 0, 0)");
  expect(styles.shadow).not.toBe("none");
});

test("Rust tile and its switch toggle once; offline onboarding has no pledge", async ({ page }) => {
  await page.goto("/#/settings/advanced");
  const toggle = page.getByRole("switch", { name: "Minecraft on Rust", exact: true });
  const row = page.locator('[class*="settingRow"]').filter({ has: toggle });
  await row.locator("strong").first().click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.evaluate(async () => {
    const { useAppStore } = await import("/src/stores/appStore.ts");
    const bootstrap = structuredClone(useAppStore.getState().bootstrap);
    bootstrap.firstRun = true; bootstrap.accounts = []; bootstrap.instances = [];
    useAppStore.setState({ bootstrap });
  });
  await page.getByRole("button", { name: "Create Offline account", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Offline username" })).toBeVisible();
  await expect(page.getByText("I commit to sign in to a Microsoft account later.")).toHaveCount(0);
});

test("Store version selection does not call a hook from the event handler", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/src/lib/tauri.ts*", async request => {
    const response = await request.fetch();
    const body = (await response.text()).replaceAll('installMethod: "native_msixvc"', 'installMethod: "registered_store"').replace('export async function command(name, args) {', `export async function command(name, args) {
      if(name === "update_instance") { window.auditStoreRequest = args.request; return {}; }
      if(name === "launch_instance") return {};`);
    await request.fulfill({ response, body });
  });
  await page.goto("/#/library");
  await expect(page.getByRole("button", { name: "Latest release", exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const { useAppStore } = await import("/src/stores/appStore.ts");
    const bootstrap = structuredClone(useAppStore.getState().bootstrap);
    bootstrap.instances[0] = { ...bootstrap.instances[0], loaderType: "bedrock", status: "created", minecraftVersion: "1.0" };
    useAppStore.setState({ bootstrap });
  });
  await page.getByRole("button", { name: "Latest release", exact: true }).click();
  await page.getByRole("button", { name: "Use Store version" }).click();
  const dialog = page.getByRole("dialog", { name: "Select installed Store version" });
  await dialog.getByRole("button").filter({ hasText: "26.51.01" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).auditStoreRequest?.minecraftVersion)).toBe("26.51.01");
  await expect(dialog).not.toBeVisible();
  expect(errors).toEqual([]);
});

test("macOS defaults, window overrides and native dropdown gate persist across pages", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }));
  await page.goto("/#/settings/advanced");
  const chrome = page.locator("[data-window-style]");
  await expect(chrome).toHaveAttribute("data-window-style", "macos");
  await expect(chrome).toHaveAttribute("data-window-side", "left");
  await page.getByRole("switch", { name: "Platform appearance options", exact: true }).click();
  await route(page, "/settings/appearance");
  await page.getByRole("switch", { name: "System-style dropdowns" }).click();
  await page.getByLabel("Window controls style", { exact: true }).selectOption("windows");
  await page.getByLabel("Window controls position", { exact: true }).selectOption("right");
  await expect(chrome).toHaveAttribute("data-window-style", "windows");
  await expect(chrome).toHaveAttribute("data-window-side", "right");
  await expect(page.locator("html")).toHaveAttribute("data-system-controls", "true");
  await route(page, "/settings/general");
  await route(page, "/settings/appearance");
  await expect(page.getByLabel("Window controls style", { exact: true })).toHaveValue("windows");
  await route(page, "/settings/advanced");
  await page.getByRole("switch", { name: "Platform appearance options", exact: true }).click();
  await expect(chrome).toHaveAttribute("data-window-style", "macos");
  await expect(chrome).toHaveAttribute("data-window-side", "left");
  await expect(page.locator("html")).toHaveAttribute("data-system-controls", "false");
});

for (const locale of ["en-US", "ru-RU", "de-DE"]) {
  test(`${locale}: small wizard, settings and home keep actions and palette`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto("/#/library");
    await expect(page.getByRole("button", { name: "Latest release", exact: true })).toBeVisible();
    await settings(page, "general", { language: locale, platformCustomization: true, navigationPosition: "top", settingsNavigationPosition: "right" });
    await settings(page, "appearance", { windowControlsStyle: "macos", windowControlsSide: "left", homeCharacterMode: 1 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const [width, height] of [[800, 560], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      await page.locator("button").filter({ has: page.locator('svg') }).first().count();
      await page.locator('[class*="actions"] > button').first().click();
      const dialog = page.locator("dialog[open]");
      await expect(dialog.locator('[class*="footerSummary"]')).toContainText("Minecraft");
      await expect(dialog.locator('[class*="versionRow"]').first()).toBeVisible();
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: `artifacts/ui/ux-wizard-${locale}-${width}.png` });
      await page.keyboard.press("Escape");
      for (const path of ["/settings/advanced", "/settings/appearance", "/home"]) {
        await route(page, path);
        await expect(page.locator("main").first()).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        expect(await page.locator("main").first().evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await page.screenshot({ path: `artifacts/ui/ux-${path.split("/").at(-1)}-${locale}-${width}.png` });
      }
    }
    expect(errors).toEqual([]);
    const theme = await page.locator("html").evaluate(element => ({ error: getComputedStyle(element).getPropertyValue("--color-error"), shadow: getComputedStyle(element).getPropertyValue("--shadow-panel") }));
    expect(theme.error).not.toContain("color-mix("); expect(theme.shadow).not.toContain("color-mix(");
  });
}
