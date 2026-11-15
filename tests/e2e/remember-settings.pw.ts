import {test,expect} from '@playwright/test';
for(const width of [800,1440]) test(`remembers settings at ${width}`,async({page})=>{
 await page.setViewportSize({width,height:width===800?560:900});await page.goto('/#/settings/general');
 const toggle=page.getByRole('switch',{name:'Remember settings section'});await expect(toggle).toBeVisible();await toggle.click();await expect(toggle).toHaveAttribute('aria-checked','true');
 await page.getByRole('link',{name:'Java',exact:true}).click();await expect(page).toHaveURL(/settings\/java/);
 await page.getByRole('link',{name:'Library',exact:true}).click();await page.getByRole('link',{name:'Settings',exact:true}).click();await expect(page).toHaveURL(/settings\/java/);
 await page.getByRole('link',{name:'General',exact:true}).click();await page.getByRole('switch',{name:'Remember settings section'}).click();
 await page.getByRole('link',{name:'Java',exact:true}).click();await page.getByRole('link',{name:'Library',exact:true}).click();await page.getByRole('link',{name:'Settings',exact:true}).click();await expect(page).toHaveURL(/settings\/general/);
 await expect(page.getByRole('switch',{name:'Remember settings section'})).toBeVisible();
 await page.screenshot({path:`artifacts/ui/remember-settings-${width}.png`});
});
