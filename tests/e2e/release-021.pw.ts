import { expect, test } from "@playwright/test";

test('Monterey catalog opens Modrinth and CurseForge without page errors', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#/discover');
  await expect(page.getByRole('heading', { name: 'Fabulously Optimized', exact: true })).toBeVisible();
  await page.getByRole('heading', { name: 'Fabulously Optimized', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'CurseForge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fabulously Optimized', exact: true })).toBeVisible();
  await page.getByRole('heading', { name: 'Fabulously Optimized', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  expect(errors).toEqual([]);
});

test('Mac blank-space hold opens a context menu and movement cancels it', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }));
  await page.goto('/#/library');
  const main = page.locator('main'); await expect(main).toBeVisible();
  const rect = await main.boundingBox(); if (!rect) throw Error('Missing main content');
  const x = rect.x + rect.width - 12, y = rect.y + rect.height - 12;
  await page.mouse.move(x, y); await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
  await expect(page.locator('.slh-context-menu')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('.slh-context-menu')).toHaveCount(0);
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 20, y); await page.waitForTimeout(650); await page.mouse.up();
  await expect(page.locator('.slh-context-menu')).toHaveCount(0);
});

test('Update prompt offers installation inside the launcher at narrow size', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 });
  await page.goto('/#/library'); await expect(page.locator('main')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('slh-launcher-update', { detail: { latestVersion: '0.2.2', updateAvailable: true } })));
  const dialog = page.getByRole('dialog', { name: 'Launcher update' });
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Update now', exact: true })).toBeVisible();
  await expect(dialog.getByText('Your instances, accounts, settings and custom languages will be kept.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Later', exact: true }).click(); await expect(dialog).not.toBeVisible();
});
