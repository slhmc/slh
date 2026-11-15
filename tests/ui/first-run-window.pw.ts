import { test, expect } from '@playwright/test';
for (const platform of ['Win32','MacIntel']) for (const viewport of [{width:800,height:560},{width:1440,height:900}]) {
 test(`${platform} ${viewport.width} first run window controls`, async ({page}) => {
  await page.addInitScript(platform => Object.defineProperty(navigator,'platform',{value:platform,configurable:true}),platform);
  await page.setViewportSize(viewport); await page.goto('/#/library');
  await page.getByRole('button',{name:'New instance',exact:true}).waitFor();
  await page.evaluate(async()=>{const {useAppStore}=await import('/src/stores/appStore.ts');const bootstrap=structuredClone(useAppStore.getState().bootstrap);bootstrap.firstRun=true;useAppStore.setState({bootstrap});});
  const bar=page.locator('[data-first-run-window-bar]'); await expect(bar).toHaveAttribute('data-tauri-drag-region','true');
  const controls=bar.locator('[data-window-style]'); await expect(controls).toHaveAttribute('data-window-style',platform==='MacIntel'?'macos':'windows');
  const buttons=controls.locator('button'); await expect(buttons).toHaveCount(3);
  for(let i=0;i<3;i++) expect(await buttons.nth(i).locator('svg').evaluate(e=>getComputedStyle(e).opacity)).toBe('0');
  for(let i=0;i<3;i++){await buttons.nth(i).hover();for(let j=0;j<3;j++) expect(await buttons.nth(j).locator('svg').evaluate(e=>getComputedStyle(e).opacity)).toBe(i===j?'1':'0');}
  await buttons.first().focus();await page.mouse.move(viewport.width/2,viewport.height/2);expect(await buttons.first().locator('svg').evaluate(e=>getComputedStyle(e).opacity)).toBe('1');
  const panel=page.getByRole('region',{name:'Welcome to Smile LauncHer'});await expect(panel).toBeVisible();
  await page.screenshot({path:`artifacts/ui/first-run-controls-${platform}-${viewport.width}.png`});
 });
}

