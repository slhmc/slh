import {test,expect} from '@playwright/test';
for(const width of [800,1440]) test(`home artwork retains configured color ${width}`,async({page})=>{
 await page.setViewportSize({width,height:width===800?560:900});await page.goto('/#/library');await page.getByRole('button',{name:'Latest release',exact:true}).waitFor();
 await page.evaluate(async()=>{const {useAppStore}=await import('/src/stores/appStore.ts');useAppStore.setState(state=>({bootstrap:{...state.bootstrap!,instances:state.bootstrap!.instances.map((i,n)=>n===0?{...i,iconKey:'pixel:Box',iconForeground:'#fff0dd',iconBackground:'#21043a'}:i),settings:{...state.bootstrap!.settings,appearance:{...state.bootstrap!.settings.appearance,beautifulHome:true,homeCharacterMode:0}}}}));window.location.hash='/home';});
 const artwork=page.locator('[class*=buildInfo] > div:first-child');await expect(artwork).toBeVisible();const foreground=artwork.locator(':scope > span');await expect(foreground).toHaveCSS('color','rgb(255, 240, 221)');await expect(foreground.locator('svg').first()).toHaveCSS('color','rgb(255, 240, 221)');
 const details=page.locator('[class*=buildInfo] > div:nth-child(2) > span');await expect(details).not.toHaveCSS('color','rgb(255, 240, 221)');
 await page.screenshot({path:`artifacts/ui/home-artwork-color-${width}.png`});
});
