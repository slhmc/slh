import { expect, test, type Page } from "@playwright/test";

async function language(page: Page, code: string) {
  await page.evaluate(async (code) => {
    const { command } = await import("/src/lib/tauri.ts");
    const { useAppStore } = await import("/src/stores/appStore.ts");
    const store = useAppStore.getState();
    await command("update_setting", { key: "general", value: { ...store.bootstrap.settings.general, language: code } });
    await store.refresh();
    window.dispatchEvent(new Event("slh-refresh-languages"));
  }, code);
  await expect(page.locator("html")).toHaveAttribute("lang", code);
}

test("switching language preserves an open form and unsaved palette", async ({ page }) => {
  await page.goto("/#/discover");
  await page.getByRole("button", { name: "Install", exact: true }).click();
  const input = page.getByLabel("Instance name");
  await input.fill("My custom pack — draft");
  await input.evaluate((element) => element.setAttribute("data-preserved", "yes"));
  await language(page, "ru-RU");
  await expect(page.locator("input[data-preserved=yes]")).toHaveValue("My custom pack — draft");
  await expect(page.getByRole("dialog").filter({ has: page.locator("input[data-preserved=yes]") })).toBeVisible();
  await language(page, "de-DE");
  await expect(page.locator("input[data-preserved=yes]")).toHaveValue("My custom pack — draft");
  await page.goto("/#/settings/appearance");
  const color = page.locator("input[type=color]").first();
  await color.fill("#123456");
  await language(page, "de-DE");
  await expect(color).toHaveValue("#123456");
});

test("waiting installations retain their job across locale changes, use palette and support keyboard closure", async ({ page }) => {
  await page.goto("/#/library");
  await page.getByRole("heading", { name: "Your Minecraft worlds, separated and ready" }).waitFor();
  await page.evaluate(async () => {
    const { usePackJobs } = await import("/src/stores/packJobs.ts");
    const { useAppStore } = await import("/src/stores/appStore.ts");
    const { command } = await import("/src/lib/tauri.ts");
    const appearance = useAppStore.getState().bootstrap.settings.appearance;
    await command("update_setting", { key: "appearance", value: { ...appearance, accent: "#3366cc", warning: "#a07820", success: "#309060", error: "#c04050", info: "#4080a0" } });
    await useAppStore.getState().refresh();
    const failure = { code: "manual_downloads_required", message: "diagnostic only", messageKey: "installation.manualRequired", details: { directory: "E:\\SLH\\data\\downloads\\curseforge-manual", files: [{ fileName: "example-very-long-mod-filename-neoforge-26.1.2-build-20261011.jar", name: "Example mod with a long name", url: "https://www.curseforge.com/minecraft/mc-mods/example/download/123", sha1: "a".repeat(40) }] } };
    usePackJobs.setState({ activeKey: "fixture", jobs: [{ key: "fixture", name: "All the Mods 11 — a long custom modpack name", minecraftVersion: "26.1.2", loaderType: "neoforge", commandName: "install_curseforge_modpack", args: {}, phase: "waiting", error: failure.message, failure, startedAt: new Date().toISOString() }] });
  });
  const dialog = page.getByRole("dialog").filter({ hasText: "All the Mods 11" });
  await expect(dialog.getByRole("heading", { name: "Files needed" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Open download pages" })).toBeEnabled();
  await language(page, "ru-RU");
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: "artifacts/ui/manual-ru-1440.png" });
  await page.setViewportSize({ width: 800, height: 560 });
  await page.screenshot({ path: "artifacts/ui/manual-ru-800.png" });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await language(page, "de-DE");
  await page.screenshot({ path: "artifacts/ui/manual-de-800.png" });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  const jobs = await page.evaluate(async () => (await import("/src/stores/packJobs.ts")).usePackJobs.getState().jobs.map(job => ({ key: job.key, phase: job.phase })));
  expect(jobs).toEqual([{ key: "fixture", phase: "waiting" }]);
});

for (const code of ["en-US", "ru-RU", "de-DE"]) {
  test(`${code}: theme editor at two viewport sizes and 200% scale`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#/settings/appearance");
    await page.getByRole("heading", { name: "Appearance", exact: true }).waitFor();
    await language(page, code);
    await page.screenshot({ path: `artifacts/ui/appearance-${code}-1440.png` });
    await page.setViewportSize({ width: 800, height: 560 });
    await page.screenshot({ path: `artifacts/ui/appearance-${code}-800.png` });
    expect(await page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    for (const route of ["home", "library", "discover", "instance/preview-2?tab=settings"]) {
      await page.evaluate(route => location.hash = "/" + route, route);
      await expect(page.locator("main").getByRole("heading").first()).toBeVisible();
      await page.screenshot({ path: `artifacts/ui/${route.split("/")[0]}-${code}-800.png` });
    }
    await page.evaluate(() => location.hash = "/settings/appearance");
    await expect(page.locator("input[type=color]").first()).toBeVisible();
    // Effective CSS viewport for a WebView setZoom(2) at 800×560.
    await page.setViewportSize({ width: 400, height: 280 });
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 280, deviceScaleFactor: 2, mobile: false });
    await page.screenshot({ path: `artifacts/ui/appearance-${code}-200.png` });
    expect(await page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  });
}


test("light preset updates document, dialogs and native controls together", async ({ page }) => {
  await page.goto("/#/settings/appearance");
  await page.getByRole("button", { name: /Light Orange/ }).click();
  await expect.poll(() => page.locator("html").evaluate(element => getComputedStyle(element).colorScheme)).toBe("light");
  expect(await page.locator("html").evaluate(element => getComputedStyle(element).getPropertyValue("--color-bg").trim())).toBe("#ffffff");
  await page.getByRole("button", { name: "New instance", exact: true }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Create a Minecraft instance" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => getComputedStyle(element).getPropertyValue("--color-bg").trim())).toBe("#ffffff");
  await page.screenshot({ path: "artifacts/ui/wizard-light-1440.png" });
});
