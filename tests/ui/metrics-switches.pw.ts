import {expect,test} from '@playwright/test';

test('whole toggle cards switch exactly once by title, blank area, knob and keyboard',async({page})=>{
 await page.goto('/#/settings/appearance');
 const toggle=page.getByRole('switch',{name:'Compact top bar (beta)',exact:true});
 await expect(toggle).toBeVisible();
 const card=toggle.locator('xpath=ancestor::div[contains(@class,"settingRow")]');
 await card.locator('strong').click();await expect(toggle).toHaveAttribute('aria-checked','true');
 await toggle.click();await expect(toggle).toHaveAttribute('aria-checked','false');
 const box=await card.boundingBox();await page.mouse.click(box!.x+box!.width-16,box!.y+box!.height-16);
 await expect(toggle).toHaveAttribute('aria-checked','true');
 await toggle.focus();await page.keyboard.press('Space');await expect(toggle).toHaveAttribute('aria-checked','false');
 await page.evaluate(async()=>{const{command}=await import('/src/lib/tauri.ts');const{useAppStore}=await import('/src/stores/appStore.ts');await command('update_setting',{key:'general',value:{...useAppStore.getState().bootstrap.settings.general,compactSettings:true}});await useAppStore.getState().refresh();});
 await card.locator('strong').click();await expect(toggle).toHaveAttribute('aria-checked','true');
 await page.evaluate(()=>location.hash='/settings/minecraft');
 const input=page.getByRole('spinbutton',{name:'Window width'});await input.fill('854');await input.press('Tab');
 await expect(input).toHaveValue('854');await expect(page.getByRole('switch',{name:'Start in fullscreen'})).toHaveAttribute('aria-checked','false');
});

test('legacy resource preferences cannot restore monitoring controls or status rows',async({page})=>{
 await page.goto('/#/settings/appearance');
 await expect(page.getByRole('switch',{name:'Compact top bar (beta)',exact:true})).toBeVisible();
 await page.evaluate(async()=>{const{command}=await import('/src/lib/tauri.ts');const{useAppStore}=await import('/src/stores/appStore.ts');await command('update_setting',{key:'appearance',value:{...useAppStore.getState().bootstrap.settings.appearance,homeStatusVisible:['launcher','java','downloads','storage','folder','memory','cpu','gpu'],homeStatusOrder:['cpu','gpu','memory','launcher','java','downloads','storage','folder'],homeMetricsScope:'system'}});await useAppStore.getState().refresh();});
 for(const name of ['Memory usage','CPU usage','GPU usage'])await expect(page.getByRole('switch',{name,exact:true})).toHaveCount(0);
 await expect(page.getByRole('combobox',{name:'Resource usage scope'})).toHaveCount(0);
 await page.evaluate(()=>location.hash='/home');
 const panel=page.locator('section').filter({has:page.getByRole('heading',{name:/Launcher status/})});
 await expect(panel).toBeVisible();await expect(panel).toContainText('Data folder');
 for(const name of ['Memory usage','CPU usage','GPU usage'])await expect(panel).not.toContainText(name);
 await panel.click({button:'right'});
 for(const name of ['Memory usage','CPU usage','GPU usage'])await expect(page.getByRole('menuitemcheckbox',{name,exact:true})).toHaveCount(0);
 await page.keyboard.press('Escape');await page.screenshot({path:'artifacts/ui/status-without-resource-monitor.png'});
});
