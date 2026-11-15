import {test,expect} from '@playwright/test';
for(const width of [800,1440])test(`instance artwork never overlaps identity or launch ${width}`,async({page})=>{
 await page.setViewportSize({width,height:width===800?560:900});await page.goto('/#/library');await page.getByRole('button',{name:'Latest release',exact:true}).click();const panel=page.locator('[data-instance-panel-scroll]');await expect(panel).toBeVisible();
 const boxes=await panel.evaluate(el=>Array.from(el.children).slice(0,3).map(n=>{const r=n.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};}));
 expect(boxes[0].height).toBeGreaterThan(100);expect(boxes[1].top-boxes[0].bottom).toBeGreaterThanOrEqual(14);expect(boxes[2].top-boxes[1].bottom).toBeGreaterThanOrEqual(14);await expect(panel.getByRole('heading',{name:'Latest release',exact:true})).toBeVisible();
 await page.screenshot({path:`artifacts/ui/artwork-layout-fixed-${width}.png`});
});
