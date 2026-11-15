import { expect, test } from "@playwright/test";

for (const [width, height] of [[800, 560], [1440, 900]]) {
  test(`Bedrock catalog keeps the profile version and imports into the selected profile at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.route("**/src/lib/tauri.ts*", async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace('if (name === "list_bedrock_versions") {', `
        if (name === "search_bedrock_curseforge") {
          (window.bedrockCalls ??= []).push({name, args});
          return {hits:[{projectId:"1234",slug:"test-pack",title:"Test Bedrock pack",description:"Test resource and behavior pack",author:"Test author",downloads:42,versions:["1.26.70"],iconUrl:null}],offset:0,limit:24,totalHits:1};
        }
        if (name === "download_bedrock_curseforge") {
          (window.bedrockCalls ??= []).push({name, args}); return "E:/test/bundle.mcaddon";
        }
        if (name === "import_instance_files") {
          if (window.bedrockImportFails) return {imported:0,errors:["bundle.mcaddon: Invalid input: bedrock.packVersionIncompatible"]};
          (window.bedrockCalls ??= []).push({name, args}); return {imported:2,errors:[]};
        }
        if (name === "list_bedrock_versions") {
      `);
      // Put the import hook before the preview's normal import handler.
      await route.fulfill({ response, body: body.replace('if (name === "import_instance_files") {', 'if (name === "preview_unused_import_instance_files") {') });
    });
    await page.goto("/#/library");
    await page.getByRole("button", { name: "New instance", exact: true }).waitFor();
    await page.evaluate(async () => {
      const { useAppStore } = await import("/src/stores/appStore.ts");
      const store = useAppStore.getState();
      const bootstrap = store.bootstrap!;
      useAppStore.setState({ bootstrap: { ...bootstrap, instances: bootstrap.instances.map(instance => instance.id === "preview-1"
        ? { ...instance, loaderType: "bedrock", minecraftVersion: "1.20.31.1", bedrockProfileMode: "shared" } : instance) } });
      window.location.hash = "/instance/preview-1?tab=mods";
    });
    await page.locator("main[data-instance-file-drop]").getByRole("button", { name: "Add-ons", exact: true }).click();
    const version = page.getByRole("combobox", { name: "Bedrock version", exact: true });
    await expect(version).toHaveValue("1.20.31");
    await expect(page.getByText("Test Bedrock pack", { exact: true })).toBeVisible();
    await page.locator("main[data-instance-file-drop]").getByRole("button", { name: "Resource packs", exact: true }).click();
    await expect(version).toHaveValue("1.20.31");
    await page.getByRole("button", { name: "Install", exact: true }).click();
    await expect(page.getByText("Content installed", { exact: true })).toBeVisible();
    const calls = await page.evaluate(() => (window as unknown as { bedrockCalls: { name: string; args: Record<string, unknown> }[] }).bedrockCalls);
    expect(calls.find(call => call.name === "download_bedrock_curseforge")?.args.gameVersion).toBe("1.20.31");
    expect(calls.find(call => call.name === "import_instance_files")?.args).toMatchObject({ instanceId: "preview-1", category: "resourcepacks", paths: ["E:/test/bundle.mcaddon"] });
    await page.evaluate(() => { (window as unknown as { bedrockImportFails: boolean }).bedrockImportFails = true; });
    await page.getByRole("button", { name: "Install", exact: true }).click();
    await expect(page.getByText("This pack requires a newer Minecraft version. Choose a compatible file.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Dismiss notification" }).evaluateAll(buttons => buttons.forEach(button => (button as HTMLButtonElement).click()));
    await version.focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("combobox", { name: "Sort by", exact: true })).toBeFocused();
    await page.locator("main[data-instance-file-drop]").evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: `artifacts/ui/bedrock-catalog-${width}.png` });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await page.locator('[data-slh-instance-tab="settings"]').click();
    await expect(page.getByRole("combobox", { name: "Bedrock profile", exact: true })).toHaveCount(0);
    const notice = page.getByText("Bedrock uses shared game data. Worlds and packs are shared between profiles of the same channel.", { exact: true });
    await expect(notice).toBeVisible();
    await notice.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/ui/bedrock-profile-${width}.png` });
    await page.evaluate(async () => {
      const { command } = await import("/src/lib/tauri.ts");
      const { useAppStore } = await import("/src/stores/appStore.ts");
      await command("update_instance", { request: { instanceId: "preview-1", loaderType: "bedrock", minecraftVersion: "1.20.31.1", bedrockProfileMode: "isolated" } });
      await useAppStore.getState().refresh();
    });
    const recover = page.getByRole("button", { name: "Use shared data", exact: true });
    await expect(recover).toBeVisible();
    await recover.focus();
    await page.keyboard.press("Enter");
    await expect(recover).toHaveCount(0);
    const recovered = await page.evaluate(async () => (await import("/src/stores/appStore.ts")).useAppStore.getState().bootstrap!.instances.find(instance => instance.id === "preview-1"));
    expect(recovered).toMatchObject({ minecraftVersion: "1.20.31.1", bedrockProfileMode: "shared" });
    await page.goto("/#/settings/bedrock");
    await expect(page.getByText("Enable Bedrock", { exact: true })).toBeVisible();
    await expect(page.getByText("Default profile mode", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("option", { name: "Isolated profile", exact: true })).toHaveCount(0);
    await page.screenshot({ path: `artifacts/ui/bedrock-global-settings-${width}.png` });
  });
}
