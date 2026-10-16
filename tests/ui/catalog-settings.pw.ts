import { expect, test, type Page } from '@playwright/test';

async function setting(page: Page, key: string, patch: Record<string, unknown>) {
  await page.evaluate(async ({ key, patch }) => {
    const { command } = await import('/src/lib/tauri.ts');
    const { useAppStore } = await import('/src/stores/appStore.ts');
    await command('update_setting', { key, value: { ...useAppStore.getState().bootstrap.settings[key], ...patch } });
    await useAppStore.getState().refresh();
  }, { key, patch });
}

test('complete project words fit without clipping; both providers filter categories', async ({ page }) => {
  await page.goto('/#/settings/appearance');
  const fit = page.getByRole('switch', { name: 'Fit project names' });
  await expect(fit).toBeVisible();
  await fit.click();
  await page.evaluate(() => location.hash = '/discover');
  const title = page.getByRole('heading', { name: 'Fabulously Optimized', exact: true });
  await expect(title).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1440, 800]) {
    await page.setViewportSize({ width, height: width === 800 ? 560 : 900 });
    await expect.poll(async () => title.evaluate(element => {
      const s = getComputedStyle(element); const c = document.createElement('canvas').getContext('2d')!;
      c.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      return element.scrollWidth <= element.clientWidth + 1 && c.measureText('Fabulously').width <= element.clientWidth;
    })).toBe(true);
    await page.screenshot({ path: `artifacts/ui/discover-fit-${width}.png` });
  }
  for (const provider of ['Modrinth', 'CurseForge']) {
    await page.getByRole('button', { name: provider, exact: true }).click();
    const categories = page.getByRole('combobox', { name: 'Category', exact: true });
    await categories.selectOption({ label: 'Optimization' });
    await expect(title).toBeVisible();
    await categories.selectOption({ label: provider === 'Modrinth' ? 'Adventure' : 'Adventure and RPG' });
    await expect(title).toHaveCount(0);
    await categories.selectOption('');
    await expect(title).toBeVisible();
  }
  await page.evaluate(() => location.hash = '/settings/appearance');
  await expect(fit).toHaveAttribute('aria-checked', 'true');
});

test('new instance inherits memory on first opening, keeps a compact identity and creates its selected group', async ({ page }) => {
  await page.goto('/#/library');
  await expect(page.getByRole('button', { name: 'New instance', exact: true })).toBeVisible();
  await setting(page, 'minecraft', { memoryMinMb: 1024, memoryMaxMb: 8192 });
  await page.getByRole('button', { name: 'New instance', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('slider', { name: 'Maximum memory' })).toHaveValue('8192');
  await expect(dialog.locator('[class*="memoryReview"]')).toContainText('1024');
  const icon = dialog.getByRole('button', { name: 'Edit instance icon' });
  await expect(dialog.locator('[class*="artworkControls"]')).toHaveCount(0);
  await icon.hover();
  await expect(icon.locator('[class*="editOverlay"]')).toHaveCSS('opacity', '1');
  await icon.click();
  await expect(dialog.locator('[class*="artworkControls"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[class*="artworkControls"]')).toHaveCount(0);
  const groups = dialog.getByRole('combobox', { name: 'Group', exact: true });
  await expect(groups.locator('option').last()).toHaveText('Create group…');
  await groups.selectOption('__create_group__');
  await dialog.getByRole('textbox', { name: 'New group name' }).fill('Fresh group');
  await dialog.getByRole('textbox', { name: 'New group name' }).press('Enter');
  await expect(dialog.getByRole('combobox', { name: 'Group', exact: true })).toHaveValue(/.+/);
  await expect(dialog.getByRole('combobox', { name: 'Group', exact: true }).locator('option:checked')).toHaveText('Fresh group');
  await expect(groups.locator('option').last()).toHaveText('Create group…');
  await expect(dialog.getByRole('textbox', {name:'New group name'})).toHaveCount(0);
  await groups.selectOption('__create_group__');
  await dialog.getByRole('textbox', {name:'New group name'}).fill('Second group');
  await dialog.getByRole('button', {name:'Create group…',exact:true}).click();
  await expect(groups.locator('option:checked')).toHaveText('Second group');
  await expect(groups.locator('option').last()).toHaveText('Create group…');
  for (const width of [1440, 800]) {
    await page.setViewportSize({ width, height: width === 800 ? 560 : 900 });
    await page.screenshot({ path: `artifacts/ui/wizard-compact-${width}.png` });
    expect(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  }
});

test('scale notifications are small, coalesced, expire after two seconds and can be disabled', async ({ page }) => {
  await page.goto('/#/settings/notifications');
  const preference = page.getByRole('switch', { name: 'Brief notifications', exact: true });
  await expect(preference).toHaveAttribute('aria-checked', 'true');
  await page.clock.install();
  await page.keyboard.press('Control+=');
  const brief = page.locator('[class*="toast"][class*="brief"]');
  await expect(brief).toHaveCount(1);
  await expect(brief).toContainText('105%');
  expect((await brief.boundingBox())!.height).toBeLessThan(65);
  await page.keyboard.press('Control+=');
  await expect(brief).toHaveCount(1);
  await expect(brief).toContainText('110%');
  await page.clock.fastForward(1000);
  await expect(brief).toBeVisible();
  await page.clock.fastForward(1100);
  await expect(brief).toHaveCount(0);
  await preference.click();
  await expect(preference).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Control+-');
  await expect(brief).toHaveCount(0);
});

test('all settings sections respond to compact layout including fragments in Console', async ({ page }) => {
  await page.goto('/#/settings/appearance');
  await expect(page.getByRole('switch', { name: 'Compact settings menu (beta)' })).toBeVisible();
  for (const section of ['minecraft', 'java', 'bedrock', 'downloads', 'notifications', 'sync', 'console', 'privacy']) {
    await setting(page, 'general', { compactSettings: false });
    await page.evaluate(section => location.hash = `/settings/${section}`, section);
    const row = page.locator('[class*="tileGrid"] > [class*="settingRow"]').first();
    await expect(row).toBeVisible();
    const tiled = await row.evaluate(e => getComputedStyle(e).minHeight);
    await setting(page, 'general', { compactSettings: true });
    await expect.poll(() => row.evaluate(e => getComputedStyle(e).minHeight)).not.toBe(tiled);
  }
});

test('Minecraft and Java defaults save and survive changing sections', async ({ page }) => {
  await page.goto('/#/settings/java');
  const minimum = page.getByRole('spinbutton', { name: 'Default minimum memory', exact: true });
  await expect(minimum).toBeVisible();
  await minimum.fill('1024'); await minimum.press('Tab');
  const maximum = page.getByRole('spinbutton', { name: 'Default maximum memory', exact: true });
  await maximum.fill('8192'); await maximum.press('Tab');
  const args = page.getByRole('textbox', { name: 'JVM arguments' });
  await args.fill('-XX:+UseG1GC\n-Dfixture=a value with spaces'); await args.press('Tab');
  await page.getByRole('switch', { name: 'Download Java automatically', exact: true }).click();
  await page.evaluate(() => location.hash = '/settings/minecraft');
  const fullscreen = page.getByRole('switch', { name: 'Start in fullscreen', exact: true });
  await fullscreen.click();
  await page.getByRole('spinbutton', { name: 'Window width' }).fill('854');
  await page.getByRole('spinbutton', { name: 'Window width' }).press('Tab');
  await page.getByRole('spinbutton', { name: 'Window height' }).fill('480');
  await page.getByRole('spinbutton', { name: 'Window height' }).press('Tab');
  await expect.poll(() => page.evaluate(async () => (await import('/src/stores/appStore.ts')).useAppStore.getState().bootstrap.settings.minecraft)).toMatchObject({ memoryMinMb:1024, memoryMaxMb:8192, fullscreen:true, resolutionWidth:854, resolutionHeight:480, jvmArgs:['-XX:+UseG1GC', '-Dfixture=a value with spaces'] });
  await page.evaluate(() => location.hash = '/settings/java');
  await expect(minimum).toHaveValue('1024'); await expect(maximum).toHaveValue('8192');
  await expect(page.getByRole('switch', { name: 'Download Java automatically', exact: true })).toHaveAttribute('aria-checked', 'false');
});

for (const [code, newInstance] of [['ru-RU', 'Новая сборка'], ['de-DE', 'Neue Instanz']]) {
  test(`${code}: compact creation and embedded catalog fit a small window`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion:'reduce' });
    await page.goto('/#/settings/appearance');
    await expect(page.getByRole('switch', {name:'Fit project names'})).toBeVisible();
    await setting(page,'appearance',{fitProjectTitles:true});
    await setting(page,'general',{language:code});
    await expect(page.locator('html')).toHaveAttribute('lang',code);
    await page.getByRole('button',{name:newInstance,exact:true}).click();
    const dialog=page.getByRole('dialog');
    for(const width of [1440,800]) {
      await page.setViewportSize({width,height:width===800?560:900});
      await expect(dialog.locator('footer button').last()).toBeVisible();
      expect(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
      await page.screenshot({path:`artifacts/ui/wizard-${code}-${width}.png`});
    }
    await dialog.getByRole('button',{name:'Modrinth',exact:true}).click();
    const title=dialog.getByRole('heading',{name:'Fabulously Optimized',exact:true});
    await expect(title).toBeVisible();
    expect(await title.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
    await page.screenshot({path:`artifacts/ui/wizard-catalog-${code}-800.png`});
  });
}

test('filters occupy the full row in the catalog and creation wizard', async ({page}) => {
  await page.setViewportSize({width:2560,height:1350});
  await page.goto('/#/discover');
  await expect(page.getByRole('heading',{name:'Fabulously Optimized',exact:true})).toBeVisible();
  const check = async () => {
    const panel=page.locator('[class*="filters"]').first();
    const bounds=await panel.boundingBox();
    const last=await panel.locator('[class*="snapshotToggle"]').boundingBox();
    expect(bounds!.x+bounds!.width-last!.x-last!.width).toBeLessThan(20);
    for(const select of await panel.locator('select').all()) expect((await select.boundingBox())!.width).toBeGreaterThan(250);
  };
  await check();
  await page.getByRole('button',{name:'New instance',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Modrinth',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('heading',{name:'Fabulously Optimized',exact:true})).toBeVisible();
  // The main route remains mounted behind the dialog; inspect its own filter row.
  const panel=page.getByRole('dialog').locator('[class*="filters"]').first();
  const bounds=await panel.boundingBox();const last=await panel.locator('[class*="snapshotToggle"]').boundingBox();
  expect(bounds!.x+bounds!.width-last!.x-last!.width).toBeLessThan(20);
  for(const select of await panel.locator('select').all()) expect((await select.boundingBox())!.width).toBeGreaterThan(250);
  await page.screenshot({path:'artifacts/ui/filters-full-width.png'});
});
