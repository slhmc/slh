import { expect, test } from "@playwright/test";

test("Horizon server core is opt-in and selects native releases", async ({ page }) => {
  await page.goto('/#/local-servers');
  await page.getByRole('button', {name:'Create server',exact:true}).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.locator('option[value="horizon"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.goto('/#/settings/advanced');
  await page.getByRole('switch', {name:'Minecraft on Rust',exact:true}).check();
  await page.goto('/#/local-servers');
  await page.getByRole('button', {name:'Create server',exact:true}).click();
  dialog = page.getByRole('dialog');
  const core = dialog.locator('select').filter({has:page.locator('option[value="horizon"]')});
  await core.selectOption('horizon');
  await expect(dialog.getByText(/Experimental native Horizon server/)).toBeVisible();
  await expect(dialog.locator('select').filter({has:page.locator('option[value="26.3"]')})).toHaveValue('26.3');
  await expect(dialog.locator('select').filter({has:page.locator('option[value="v0.2.97"]')})).toHaveValue('v0.2.97');
  await expect(dialog.getByRole('tab',{name:'Java',exact:true})).toHaveCount(0);
});

test("Horizon side panel fits both supported window sizes", async ({ page }) => {
  await page.goto("/#/local-servers");
  await expect(page.getByRole("button", { name: "Weekend", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const key = "slh.previewServerLibrary";
    const library = JSON.parse(localStorage.getItem(key)!);
    const server = library.servers.find((item: { name: string }) => item.name === "Weekend");
    server.config.core = "horizon";
    localStorage.setItem(key, JSON.stringify(library));
  });
  await page.reload();
  await page.getByRole("button", { name: "Weekend", exact: true }).click();
  const panel = page.locator("aside").filter({ hasText: "Weekend" });
  await expect(panel).toBeVisible();
  for (const [width, height] of [[800, 560], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    const scroll = panel.locator('[class*="scroll"]').first();
    expect(await scroll.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `artifacts/horizon-panel-${width}.png`, animations: "disabled" });
  }
});
