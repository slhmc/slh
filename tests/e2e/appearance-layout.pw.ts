import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const skin = `data:image/png;base64,${readFileSync('src/assets/skins/Alex.png').toString('base64')}`;
const cape = `data:image/png;base64,${readFileSync('tests/fixtures/cape-layout.png').toString('base64')}`;

const capeFront = `data:image/png;base64,${readFileSync("tests/fixtures/cape-layout-front.png").toString("base64")}`;

async function fixture(page: Page, savedCount = 20) {
  const value = { accountId: 'preview-account', provider: 'microsoft', username: 'LayoutPlayer', canChangeSkin: true, canChangeCape: true, message: null,
    skins: Array.from({ length: savedCount }, (_, i) => ({ id: `skin-${i}`, alias: i === 1 ? 'A very long saved skin name with spaces and a suffix.png' : `Saved skin ${i + 1}`, dataUrl: skin, variant: 'slim', active: i === 0 })),
    capes: Array.from({ length: 16 }, (_, i) => ({ id: `cape-${i}`, alias: `Cape ${i + 1}`, dataUrl: cape, thumbnailDataUrl: capeFront, active: i === 0 })) };
  await page.addInitScript(value => { (window as any).appearanceFixture = value; (window as any).appearanceMutations = []; }, value);
  await page.route('**/src/lib/tauri.ts*', async route => {
    const response = await route.fetch();
    let body = await response.text();
    const marker = 'if (name === "get_account_appearance") {';
    expect(body.includes(marker)).toBe(true);
    body = body.replace(marker, `${marker} return structuredClone(window.appearanceFixture);`);
    await route.fulfill({ response, body });
  });
  await page.goto('/#/settings/accounts');
  await page.getByRole('button', { name: /Manage skin and cape/ }).first().click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Saved skin 1', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('tabpanel').locator('canvas')).toHaveCount(0);
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Saved skin 1', exact: true }).locator('img[src^="blob:"]')).toBeVisible({ timeout: 15_000 });
}
async function inside(page: Page, locator: ReturnType<Page['getByRole']>) {
  await expect.poll(async () => {
    const box = await locator.boundingBox(); const size = page.viewportSize()!;
    return Boolean(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1);
  }).toBe(true);
}

test('large skin and cape galleries keep preview and actions on screen at 85%, 100% and 200%', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await fixture(page);
  const dialog = page.getByRole('dialog');
  for (const [width, height, scale] of [[1694,1059,85], [1440,900,100], [800,560,100], [400,280,200]]) {
    await page.setViewportSize({ width, height });
    await inside(page, dialog.getByRole('button', { name: 'Customize', exact: true }));
    await inside(page, dialog.getByRole('button', { name: 'Apply', exact: true }));
    const panel = dialog.getByRole('tabpanel');
    await panel.evaluate(e => { e.scrollTop = e.scrollHeight; });
    await inside(page, dialog.getByRole('button', { name: 'Customize', exact: true }));
    expect(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    if (height > 500) await expect(dialog.getByRole('button', { name: 'Zuri', exact: true }).locator('img[src^="blob:"]')).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `artifacts/appearance-catalog-${width}-${scale}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await dialog.getByRole('button', { name: 'Customize', exact: true }).click();
  await dialog.getByRole('tab', { name: 'Cape', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cape 16', exact: true }).click();
  for (const [width, height] of [[1440,900],[800,560],[400,280]]) {
    await page.setViewportSize({ width, height });
    await inside(page, dialog.getByRole('button', { name: 'Save skin', exact: true }));
    await inside(page, dialog.getByRole('button', { name: 'Delete', exact: true }));
    expect(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `artifacts/appearance-capes-${width}.png` });
  }
  expect(errors).toEqual([]);
});

test('skin library tabs support arrow keys and preserve the selected skin', async ({ page }) => {
  await fixture(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Skin', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('tab', { name: 'Cape', exact: true })).toHaveAttribute('aria-selected','true');
  await expect(dialog.getByRole('button', {name:'Cape 1',exact:true})).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(dialog.getByRole('tab', {name:'Skin',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(dialog.getByRole('tab', {name:'Saved skins',exact:true})).toHaveCount(0);
  await expect(dialog.getByRole('tab', {name:'Default skins',exact:true})).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Alex', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Customize', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Slim', exact: true })).toHaveAttribute('aria-pressed','true');
  await expect(dialog.getByRole('button', { name: 'Save skin', exact: true })).toBeEnabled();
});
for (const code of ['ru-RU','de-DE','en-US']) {
  test(`appearance stays usable in ${code} with readable controls`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await fixture(page);
    if (code === 'en-US') {
      await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await page.evaluate(() => location.hash = '/settings/appearance');
      await page.getByRole('button', { name: /Light Orange/ }).click();
      await page.evaluate(() => location.hash = '/settings/accounts');
      await page.getByRole('button', { name: /Manage skin and cape/ }).first().click();
    }
    await page.evaluate(async code => {
      const {command} = await import('/src/lib/tauri.ts');
      const {useAppStore} = await import('/src/stores/appStore.ts');
      const store = useAppStore.getState();
      await command('update_setting', {key:'general', value:{...store.bootstrap.settings.general, language:code}});
      await store.refresh(); window.dispatchEvent(new Event('slh-refresh-languages'));
    }, code);
    await expect(page.locator('html')).toHaveAttribute('lang',code);
    const text = JSON.parse(readFileSync(`resources/languages/${code}.json`,'utf8'));
    const dialog = page.getByRole('dialog');
    await page.setViewportSize({width:800,height:560});
    await dialog.getByRole('button',{name:text.accounts.appearance.customize,exact:true}).click();
    await inside(page,dialog.getByRole('button',{name:text.accounts.texts.saveSkin,exact:true}));
    await dialog.getByRole('tab',{name:text.accounts.texts.cape,exact:true}).click();
    await expect(dialog.getByRole('button',{name:'Cape 1',exact:true})).toBeVisible();
    await page.screenshot({path:`artifacts/appearance-${code}-800.png`});
  });
}
test('skin card feedback stays clear with slow transitions and reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await fixture(page);
  const dialog = page.getByRole('dialog');
  const card = dialog.getByRole('button', {name:'Saved skin 3',exact:true});
  const session = await page.context().newCDPSession(page);
  await session.send('Animation.enable');
  await session.send('Animation.setPlaybackRate',{playbackRate:.1});
  await card.hover();
  await page.mouse.down();
  await page.waitForTimeout(1700);
  await expect.poll(() => card.evaluate(e => getComputedStyle(e).transform)).toMatch(/0\.96/);
  await page.mouse.up();
  await expect(card).toHaveAttribute('aria-pressed','true');
  await session.send('Animation.setPlaybackRate',{playbackRate:1});
  await page.emulateMedia({reducedMotion:'reduce'});
  await card.hover(); await page.mouse.down();
  await expect.poll(() => card.evaluate(e => getComputedStyle(e).transform)).toBe('none');
  await page.mouse.up();
});


test('default Minecraft skins appear below saved skins without switching tabs', async ({ page }) => {
  test.setTimeout(60_000);
  await fixture(page, 5);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('tab', { name: 'Skin', exact: true })).toHaveAttribute('aria-selected', 'true');
  const saved = await dialog.getByRole('heading', { name: 'Saved skins', exact: true }).boundingBox();
  const defaults = await dialog.getByRole('heading', { name: 'Default skins', exact: true }).boundingBox();
  expect(defaults!.y).toBeGreaterThan(saved!.y);
  await dialog.getByRole('button', { name: 'Alex', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Alex', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  const panel = dialog.getByRole('tabpanel');
  await panel.evaluate(e => { e.scrollTop = e.scrollHeight; });
  for (const name of ['Steve', 'Alex', 'Sunny', 'Noor', 'Efe', 'Ari', 'Kai', 'Makena', 'Zuri']) {
    await expect(dialog.getByRole('button', { name, exact: true }).locator('img[src^="blob:"]')).toBeVisible({ timeout: 15_000 });
  }
  await page.screenshot({ path: 'artifacts/appearance-standing-defaults.png' });
  await panel.evaluate(e => { e.scrollTop = 0; });
  await page.screenshot({ path: 'artifacts/appearance-standing-saved.png' });
});
