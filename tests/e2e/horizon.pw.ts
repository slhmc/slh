import { expect, test } from "@playwright/test";

test("Horizon edition lists only supported Minecraft versions and pins its release", async ({ page }) => {
  await page.goto("/#/settings/advanced");
  await page.getByRole("switch", { name: "Minecraft on Rust", exact: true }).check();
  await page.goto("/#/library");
  await page.getByRole("button", { name: "New instance", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Rust", exact: true }).click();
  await expect(dialog.getByText("Only Minecraft versions supported by verified Horizon releases are listed.")).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Horizon client" })).toBeVisible();
  await expect(dialog.getByText("Adapter pending")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Minecraft 1.21.8|^1.21.8/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: /Minecraft 26.3|^26.3/ }).click();
  await expect(dialog.getByText("Compatible Horizon release available").first()).toBeVisible();
  const release = dialog.getByRole("combobox", { name: "Horizon release", exact: true });
  await expect(release).toHaveValue("v0.2.97");
  await release.selectOption("v0.2.95");
  await expect(dialog.getByRole("button", { name: "Create and install", exact: true })).toBeEnabled();
});

test("an existing Horizon instance keeps its pinned release until explicit apply", async ({ page }) => {
  await page.addInitScript(() => { (window as any).horizonMutations = []; });
  await page.route('**/src/lib/tauri.ts*', async route => {
    const response = await route.fetch();
    let body = await response.text();
    const marker = 'if (name === "get_bootstrap") {';
    expect(body.includes(marker)).toBe(true);
    body = body.replace(marker, `${marker} previewBootstrap.settings.general.rustMinecraft = true; previewBootstrap.instances[0].loaderType = "rust"; previewBootstrap.instances[0].minecraftVersion = "26.3"; previewBootstrap.instances[0].loaderVersion = "v0.2.96";`);
    const update = 'if (name === "update_instance") {';
    body = body.replace(update, `${update} window.horizonMutations.push(args.request);`);
    await route.fulfill({ response, body });
  });
  await page.goto('/#/instance/preview-1?tab=settings');
  const version = page.getByRole('combobox', { name: 'Horizon release', exact: true });
  await expect(version).toHaveValue('v0.2.96');
  const apply = page.getByRole('button', { name: 'Apply release', exact: true });
  await expect(apply).toBeDisabled();
  await version.selectOption('v0.2.97');
  await expect(apply).toBeEnabled();
  expect(await page.evaluate(() => (window as any).horizonMutations.length)).toBe(0);
  await apply.click();
  await expect.poll(() => page.evaluate(() => (window as any).horizonMutations.length)).toBe(1);
  const request = await page.evaluate(() => (window as any).horizonMutations[0]);
  expect(request.loaderType).toBe('rust');
  expect(request.loaderVersion).toBe('v0.2.97');
  expect(request.minecraftVersion).toBe('26.3');
});
