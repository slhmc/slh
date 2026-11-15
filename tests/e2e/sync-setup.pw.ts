import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
const ru = JSON.parse(readFileSync("resources/languages/ru-RU.json", "utf8"));

for (const viewport of [{ width: 800, height: 560 }, { width: 1440, height: 900 }]) {
  test(`sync creation and safety at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => { (window as any).syncFixture = []; (window as any).syncRequest = null; });
    await page.route("**/src/lib/tauri.ts*", async route => {
      const response = await route.fetch();
      const body = await response.text();
      const marker = 'export async function command(name, args) {';
      expect(body).toContain(marker);
      await route.fulfill({ response, body: body.replace(marker, `${marker}
        if (!window.syncBuildsReady) {
          const base = previewBootstrap.instances[0];
          previewBootstrap.instances = [{ ...base, id:"build-26-2", name:"26.2" }, { ...base, id:"build-26-3", name:"26.3" }];
          window.syncBuildsReady = true;
        }
        if (name === "run_sync_mapping_now") { window.syncManualRequest = args; return []; }
        if (name === "list_sync_mappings") return structuredClone(window.syncFixture);
        if (name === "create_sync_mapping") {
          window.syncRequest = args.request;
          const mapping = { id:"fixture", ...args.request, enabled:true, lastSyncAt:null };
          window.syncFixture.push(mapping); return mapping;
        }
        if (name === "set_sync_mapping_enabled") { window.syncFixture[0].enabled = args.enabled; return; }
        if (name === "delete_sync_mapping") { window.syncFixture = []; return; }
      `) });
    });
    await page.goto("/#/settings/sync");
    await expect(page.getByLabel("1. What to share")).toHaveCount(0);
    await page.getByRole("button", { name: "Create sync", exact: true }).click();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("1. What to share")).toBeFocused();
    const stepBoxes = await Promise.all(["1. What to share", "2. Which builds", "3. Where to take the first copy"].map(text => page.getByText(text, { exact: true }).boundingBox()));
    expect(Math.max(...stepBoxes.map(box => box!.x)) - Math.min(...stepBoxes.map(box => box!.x))).toBeLessThan(1);
    await page.getByLabel("1. What to share").selectOption("worlds");
    await expect(page.getByRole("button", { name: "Create sync", exact: true })).toBeDisabled();
    await expect(page.getByText(/World sync can replace saves/)).toBeVisible();
    await page.getByLabel("1. What to share").selectOption("servers");
    await page.getByRole("checkbox", { name: /All current and future/ }).uncheck();
    for (const checkbox of await page.locator("#sync-setup-form").getByRole("checkbox").all()) await checkbox.uncheck();
    await expect(page.getByRole("button", { name: "Create sync", exact: true })).toBeDisabled();
    await page.getByRole("checkbox", { name: /All current and future/ }).check();
    await page.getByLabel("3. Where to take the first copy").selectOption("build-26-3");
    await page.getByRole("button", { name: "Create sync", exact: true }).click();
    await expect(page.locator("#sync-setup-form")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).syncRequest)).toMatchObject({ category: "servers", instanceIds: ["*"], initialSource: "build-26-3", direction: "bidirectional" });
    await expect(page.getByLabel("Manual update source")).toHaveValue("build-26-3");
    await page.getByRole("button", { name: "Update now", exact: true }).click();
    expect(await page.evaluate(() => (window as any).syncManualRequest.sourceInstanceId)).toBe("build-26-3");
    await expect(page.getByRole("switch", { name: "Sync enabled", exact: true })).toBeChecked();
    await page.getByRole("switch", { name: "Sync enabled", exact: true }).uncheck();
    await expect(page.getByRole("button", { name: "Update now", exact: true })).toBeDisabled();
    await page.goto("/#/settings/general");
    await page.locator("[data-language-selector]").selectOption("ru-RU");
    await page.goto("/#/settings/sync");
    await page.getByRole("button", { name: ru.settings.syncSetup.create, exact: true }).click();
    await page.getByLabel(ru.settings.syncSetup.source).scrollIntoViewIfNeeded();
    expect(await page.locator("#sync-setup-form").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: `test-results/sync-form-${viewport.width}.png` });
    await page.getByRole("button", { name: ru.common.cancel, exact: true }).click();
    const sourceBox = await page.getByLabel(ru.settings.syncSetup.manual).boundingBox();
    const updateBox = await page.getByRole("button", { name: ru.settings.texts.updateNow, exact: true }).boundingBox();
    if (viewport.width === 1440) expect(Math.abs(sourceBox!.y + sourceBox!.height - updateBox!.y - updateBox!.height)).toBeLessThan(1);
    await page.screenshot({ path: `test-results/sync-list-${viewport.width}.png` });
    page.on("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: ru.settings.syncSetup.remove, exact: true }).click();
    await expect(page.getByText(ru.settings.syncSetup.emptyHint)).toBeVisible();
    await page.addInitScript(() => {
      (window as any).syncFixture = [{ id: "restored", category: "servers", instanceIds: ["*"], enabled: true, lastSyncAt: null }];
    });
    await page.reload();
    await expect(page.getByLabel("Manual update source")).toHaveValue("");
    await expect(page.getByRole("button", { name: "Update now", exact: true })).toBeDisabled();
  });
}
