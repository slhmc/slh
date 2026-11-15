import {test,expect} from '@playwright/test';
for (const width of [800,1440]) for (const compact of [false,true]) test(`Java folder fits at ${width}, compact=${compact}`,async({page})=>{
 await page.setViewportSize({width,height:width===800?560:900}); await page.goto('/#/settings/java');
 await page.getByRole('heading',{name:'Java',exact:true}).waitFor();
 if(compact) await page.evaluate(async()=>{const {command}=await import('/src/lib/tauri.ts');const {useAppStore}=await import('/src/stores/appStore.ts');const general=useAppStore.getState().bootstrap.settings.general;await command('update_setting',{key:'general',value:{...general,compactSettings:true}});await useAppStore.getState().refresh();});
 await page.locator('summary').filter({hasText:'Manual Java settings'}).click();
 const row=page.locator('[class*=settingRow]').filter({hasText:'Managed Java download location'}); await expect(row).toBeVisible();
 const grid=row.locator('..'); const a=await row.boundingBox(),b=await grid.boundingBox(); expect(a!.width).toBeGreaterThan(b!.width-4);
 await expect(row.getByRole('button',{name:'Choose folder'})).toBeVisible(); await expect(page.getByRole('link',{name:'Memory settings'})).toHaveCount(0);
 await row.scrollIntoViewIfNeeded(); await page.screenshot({path:`artifacts/ui/java-folder-${width}-${compact}.png`});
});
