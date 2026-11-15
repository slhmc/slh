import {test,expect} from '@playwright/test';
for(const width of [800,1440]) test(`Ctrl docking and global scale ${width}`,async({page})=>{
 await page.setViewportSize({width,height:width===800?560:900});await page.goto('/#/settings/general');
 await expect(page.getByRole('switch',{name:'Separate area scales'})).toHaveCount(0);await expect(page.getByRole('switch',{name:'Show ungrouped instances'})).toHaveCount(0);
 await page.getByRole('switch',{name:'Move panels with Ctrl',exact:true}).check();await page.goto('/#/library');
 const nav=page.locator('[data-slh-dock=navigationPosition]');await expect(nav).toBeVisible();const rect=await nav.boundingBox();await page.keyboard.down('Control');await page.mouse.move(rect!.x+rect!.width/2,rect!.y+80);await page.mouse.down();await page.mouse.move(width-5,200,{steps:12});await page.mouse.up();await page.keyboard.up('Control');await expect.poll(async()=>{const box=await nav.boundingBox();return box!.x>width/2;}).toBe(true);
 await nav.hover();await page.keyboard.press('Control+Equal');await expect.poll(async()=>page.evaluate(async()=>{const {useAppStore}=await import('/src/stores/appStore.ts');return useAppStore.getState().bootstrap!.settings.appearance.scalePercent;})).toBe(105);
});
