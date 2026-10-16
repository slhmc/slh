import { expect,test } from '@playwright/test';

test('window width and height have equal usable space in both settings layouts', async ({page}) => {
  await page.goto('/#/settings/minecraft');
  const width=page.getByRole('spinbutton',{name:'Window width'});
  const height=page.getByRole('spinbutton',{name:'Window height'});
  await expect(width).toBeVisible();
  for(const compactSettings of [false,true]) {
    await page.evaluate(async compactSettings => {
      const {command}=await import('/src/lib/tauri.ts');
      const {useAppStore}=await import('/src/stores/appStore.ts');
      await command('update_setting',{key:'general',value:{...useAppStore.getState().bootstrap.settings.general,compactSettings}});
      await useAppStore.getState().refresh();
    },compactSettings);
    for(const viewport of [{width:2048,height:900},{width:1440,height:900},{width:800,height:560}]) {
      await page.setViewportSize(viewport);
      await width.scrollIntoViewIfNeeded();
      const first=await width.boundingBox();const second=await height.boundingBox();
      expect(Math.abs(first!.width-second!.width)).toBeLessThan(1);
      expect(Math.abs(first!.height-second!.height)).toBeLessThan(1);
      expect(Math.abs(first!.y-second!.y)).toBeLessThan(1);
      expect(first!.width).toBeGreaterThan(85);
      await page.screenshot({path:`artifacts/ui/resolution-${viewport.width}-${compactSettings}.png`});
    }
  }
  await width.fill('854');await width.press('Tab');
  await height.fill('480');await height.press('Tab');
  await expect.poll(()=>page.evaluate(async()=>(await import('/src/stores/appStore.ts')).useAppStore.getState().bootstrap.settings.minecraft)).toMatchObject({resolutionWidth:854,resolutionHeight:480});
});
