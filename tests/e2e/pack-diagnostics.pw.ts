import { expect, test } from "@playwright/test";

test("a game crash event keeps its report reachable in the notification", async ({ page }) => {
  await page.addInitScript(() => { (window as any).openedReport = null; });
  await page.route("**/src/lib/tauri.ts*", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('if (name === "get_bootstrap") {', `
      if (name === "open_crash_report") { window.openedReport = args.path; return; }
      if (name === "get_bootstrap") {`);
    await route.fulfill({ response, body });
  });
  await page.goto("/#/library");
  await page.getByRole("button", { name: "New instance", exact: true }).waitFor();
  await page.evaluate(`import('/src/stores/appStore.ts').then(({useAppStore}) => useAppStore.getState().receiveLaunchState({
    instanceId:'preview-1', state:'crashed', exitCode:1, reportPath:'E:/SLH/crash/slh-game-crash.txt'
  }))`);
  const report = page.getByRole("button", { name: "Open error report", exact: true });
  await expect(report).toBeVisible();
  await report.click();
  await expect.poll(() => page.evaluate(() => (window as any).openedReport)).toBe("E:/SLH/crash/slh-game-crash.txt");
});

test("saved reports remain reachable from Advanced settings", async ({ page }) => {
  await page.addInitScript(() => { (window as any).openedCrashFolder = false; });
  await page.route("**/src/lib/tauri.ts*", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('if (name === "get_bootstrap") {', `
      if (name === "open_crash_report") { window.openedCrashFolder = args.path === null; return; }
      if (name === "get_bootstrap") {`);
    await route.fulfill({ response, body });
  });
  await page.goto("/#/settings/advanced");
  await page.getByRole("button", { name: "Open crash folder", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).openedCrashFolder)).toBe(true);
});

for (const provider of ["Modrinth", "CurseForge"]) {
  test(`${provider} installation failure exposes the file, report and retry`, async ({ page }) => {
    await page.addInitScript(() => { (window as any).packDiagnosticCalls = []; });
    await page.route("**/src/lib/tauri.ts*", async route => {
      const response = await route.fetch();
      let body = await response.text();
      const marker = 'if (name === "get_bootstrap") {';
      expect(body.includes(marker)).toBe(true);
      body = body.replace(marker, `
        if (name === "open_crash_report") { window.packDiagnosticCalls.push(args.path); return; }
        if (name === "install_modrinth_modpack" || name === "install_curseforge_modpack") {
          window.packDiagnosticCalls.push("install");
          throw { code: "network_error", message: "Download failed for needed.jar: HTTP 404", messageKey: "errors.downloadMissing", details: { reportPath: "E:/SLH/crash/slh-test.txt" } };
        }
        ${marker}`);
      await route.fulfill({ response, body });
    });
    await page.goto("/#/discover");
    await page.getByRole("button", { name: provider, exact: true }).click();
    await page.getByRole("button", { name: "Install", exact: true }).click();
    const install = page.getByRole("dialog");
    await install.getByRole("button", { name: "Minecraft version", exact: true }).click();
    await install.getByRole("option", { name: "1.21.7", exact: true }).click();
    await install.getByRole("button", { name: "Download and install", exact: true }).click();
    const failure = page.getByRole("dialog").filter({ hasText: "A required file is no longer available" });
    await expect(failure).toBeVisible();
    await failure.getByText("Technical details", { exact: true }).click();
    await expect(failure.getByText("Download failed for needed.jar: HTTP 404", { exact: true })).toBeVisible();
    await failure.getByRole("button", { name: "Open error report", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).packDiagnosticCalls)).toContain("E:/SLH/crash/slh-test.txt");
    await failure.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).packDiagnosticCalls.filter((s: string) => s === "install").length)).toBe(2);
  });
}
