import { expect, test } from "@playwright/test";

test("files hover opens the destination tab and drop imports into that category", async ({ page }) => {
  await page.addInitScript(() => { (window as any).localFileImports = []; });
  await page.route("**/src/lib/tauri.ts*", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('if (name === "import_instance_files") {', 'if (name === "import_instance_files") { window.localFileImports.push(args);');
    await route.fulfill({ response, body });
  });
  await page.goto("/#/instance/preview-1");
  for (const [width, height, category, filename] of [[1440, 900, "mods", "example.jar"], [900, 700, "resourcepacks", "pack.zip"], [1440, 900, "shaders", "shader.zip"]] as const) {
    await page.setViewportSize({ width, height });
    const tab = page.locator(`[data-slh-instance-tab="${category}"]`);
    const box = (await tab.boundingBox())!;
    await page.evaluate(({ x, y, filename }) => {
      const transfer = new DataTransfer();
      const file = new File(["fixture"], filename);
      Object.defineProperty(file, "path", { value: `C:/Downloads/${filename}` });
      transfer.items.add(file);
      (window as any).fileTransfer = transfer;
      window.dispatchEvent(new DragEvent("dragover", { clientX: x, clientY: y, dataTransfer: transfer, cancelable: true }));
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2, filename });
    await expect(page).toHaveURL(new RegExp(`tab=${category}`));
    await expect(page.getByText("Release to add files", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose files", exact: true })).toBeVisible();
    const choose = page.getByRole("button", { name: "Choose files", exact: true });
    const hintBox = (await choose.locator("..").boundingBox())!;
    const chooseBox = (await choose.boundingBox())!;
    expect(chooseBox.x).toBeGreaterThanOrEqual(hintBox.x + 12);
    expect(chooseBox.x + chooseBox.width).toBeLessThanOrEqual(hintBox.x + hintBox.width - 12);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const zone = page.locator(`main[data-instance-file-drop="${category}"]`);
    const zoneBox = (await zone.boundingBox())!;
    await page.evaluate(({ x, y }) => {
      window.dispatchEvent(new DragEvent("drop", { clientX: x, clientY: y, dataTransfer: (window as any).fileTransfer, cancelable: true }));
    }, { x: zoneBox.x + 20, y: zoneBox.y + 20 });
    await expect.poll(() => page.evaluate(() => (window as any).localFileImports.length)).toBe(["mods", "resourcepacks", "shaders"].indexOf(category) + 1);
    const request = await page.evaluate(() => (window as any).localFileImports.at(-1));
    expect(request.category).toBe(category);
    expect(request.paths).toEqual([`C:/Downloads/${filename}`]);
  }
  await page.screenshot({ path: "test-results/local-files-desktop.png" });
});

test("deletion hides the card before disk cleanup completes and displays percent", async ({ page }) => {
  await page.route("**/src/lib/tauri.ts*", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('if (name === "delete_instance") {', `if (name === "delete_instance") {
      const { useAppStore } = await import("/src/stores/appStore.ts");
      useAppStore.getState().receiveProgress({operationId: "delete-" + args.instanceId, instanceId: args.instanceId, operation: "delete", stage: "deleting", message: "Removing instance files", completed: 35, total: 100, downloadedBytes: null, totalBytes: null});
      await new Promise(resolve => setTimeout(resolve, 2500));`);
    await route.fulfill({ response, body });
  });
  await page.goto("/#/library");
  await page.getByRole("button", { name: "Actions for Latest release" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).first().click();
  await page.getByRole("dialog", { name: "Delete instance", exact: true }).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("button", { name: "Actions for Latest release" })).toHaveCount(0);
  await expect(page.getByText("Removing instance files", { exact: true })).toBeVisible();
  await expect(page.getByText("35%", { exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "35");
  await page.screenshot({ path: "test-results/deleting-instance.png" });
  await expect(page.getByText("Removing instance files", { exact: true })).toHaveCount(0);
});

test("Rust is marked beta in advanced settings", async ({ page }) => {
  await page.goto("/#/settings/advanced");
  const row = page.getByRole("switch", { name: "Minecraft on Rust", exact: true }).locator("../..");
  await expect(row.getByText("Beta", { exact: true })).toBeVisible();
});
