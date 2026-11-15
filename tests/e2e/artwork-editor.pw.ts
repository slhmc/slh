import { test, expect } from '@playwright/test';
for (const width of [800, 1440]) test(`artwork editing and immediate persistence ${width}`, async ({page}) => {
 await page.setViewportSize({width,height:width===800?560:900});
 await page.goto('/#/instance/preview-1?tab=settings');
 const edit=page.getByRole('button',{name:'Edit artwork',exact:true});await edit.click();
 const d=page.getByRole('dialog',{name:'Edit artwork',exact:true});
 const w=d.getByLabel('Width (%)',{exact:true}),h=d.getByLabel('Height (%)',{exact:true}),r=d.getByLabel('Rotation (°)',{exact:true});
 const separate=d.getByLabel('Edit square and rectangular icons separately');await expect(separate).not.toBeChecked();
 await w.fill('120');await w.press('Control+z');await expect(w).toHaveValue('80');await w.press('Control+Shift+z');await expect(w).toHaveValue('120');
 await w.press('Control+z');await w.press('Control+y');await expect(w).toHaveValue('120');
 await d.getByRole('button',{name:'Square icon',exact:true}).click();await expect(w).toHaveValue('120');
 await separate.check();await w.fill('150');await d.getByRole('button',{name:'Rectangular icon',exact:true}).click();await expect(w).toHaveValue('120');
 await separate.uncheck();await d.getByRole('button',{name:'Reset size',exact:true}).click();
 const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=200;c.height=100;c.getContext('2d')!.fillRect(0,0,200,100);return c.toDataURL().split(',')[1];});
 await d.locator('input[type=file]').setInputFiles({name:'wide-photo.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
 await expect(d.getByText('wide-photo.png',{exact:true})).toBeVisible();await expect(h).toHaveValue('40');await expect(d.locator('input[type=color]').first()).toBeDisabled();
 const stage=d.locator('[data-artwork-stage]');await stage.scrollIntoViewIfNeeded();
 const rect=await stage.boundingBox();expect(rect).toBeTruthy();
 await page.mouse.move(rect!.x+rect!.width/2,rect!.y+rect!.height/2);await page.keyboard.down('Control');await page.mouse.wheel(0,-100);await page.keyboard.up('Control');await expect(w).toHaveValue('84');
 await d.getByRole('button',{name:'Undo',exact:true}).click();await expect(w).toHaveValue('80');
 // A drag near the center snaps both coordinates; one undo restores the entire gesture.
 await stage.scrollIntoViewIfNeeded();const box=await stage.boundingBox();
 await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2);await page.mouse.down();await page.mouse.move(box!.x+box!.width/2+1,box!.y+box!.height/2+1,{steps:3});await page.mouse.up();
 await expect(d.getByLabel('Horizontal position',{exact:true})).toHaveValue('50');
 // Deselect outside the artwork, then select again.
 await d.getByRole('heading',{name:'Icon or photo',exact:true}).click();await expect(d.locator('[data-resize-handle=n]')).not.toBeVisible();
 await stage.click({position:{x:box!.width/2,y:box!.height/2}});await expect(d.locator('[data-resize-handle=n]')).toBeVisible();
 await stage.scrollIntoViewIfNeeded();
 const bounds=await d.locator('[data-artwork-selection]').boundingBox();const photo=await stage.locator('span img').boundingBox();
 expect(Math.abs(bounds!.width-photo!.width)).toBeLessThan(3);expect(Math.abs(bounds!.height-photo!.height)).toBeLessThan(3);
 const corner=await d.locator('[data-rotate-handle=ne]').boundingBox();
 await page.mouse.move(corner!.x+corner!.width/2,corner!.y+corner!.height/2);await page.mouse.down();await page.mouse.move(corner!.x+corner!.width/2+15,corner!.y+corner!.height/2+30,{steps:5});await page.mouse.up();
 await expect(r).not.toHaveValue('0');await d.getByRole('button',{name:'Undo',exact:true}).click();await expect(r).toHaveValue('0');
 await stage.scrollIntoViewIfNeeded();await stage.click();
 const handle=await d.locator('[data-resize-handle=e]').boundingBox();await page.mouse.move(handle!.x+handle!.width/2,handle!.y+handle!.height/2);await page.mouse.down();await page.mouse.move(handle!.x+handle!.width/2+20,handle!.y+handle!.height/2,{steps:5});await page.mouse.up();
 await expect(w).not.toHaveValue('80');await d.getByRole('button',{name:'Undo',exact:true}).click();await expect(w).toHaveValue('80');
 await w.fill('160');await h.fill('100');await stage.scrollIntoViewIfNeeded();await stage.click();
 const edge=await d.locator('[data-resize-handle=e]').boundingBox();const stageEdge=await stage.boundingBox();expect(edge!.x+edge!.width).toBeGreaterThan(stageEdge!.x+stageEdge!.width);
 await expect(d.locator('[data-resize-handle=e]')).toBeVisible();
 await d.getByRole('button',{name:'Choose icon',exact:true}).click();const gallery=d.locator('[class*="icons"]').last();
 const count=await gallery.getByRole('button').count();await gallery.getByRole('button').first().click();await expect(gallery).toBeVisible();
 await gallery.evaluate(el=>{el.scrollTop=el.scrollHeight;});await expect.poll(()=>gallery.getByRole('button').count()).toBeGreaterThan(count);
 await d.getByRole('button',{name:'Choose icon',exact:true}).click();await w.fill('110');
 await page.screenshot({path:`artifacts/ui/artwork-new-${width}.png`});
 await d.getByRole('button',{name:'Apply',exact:true}).click();await expect(d).not.toBeVisible();
 await edit.click();await expect(w).toHaveValue('110');await d.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.screenshot({path:`artifacts/ui/artwork-settings-new-${width}.png`});
});


for (const enabled of [true,false]) test(`discard confirmation ${enabled}`,async({page})=>{
 await page.goto('/#/instance/preview-1?tab=settings');
 await page.evaluate(async(enabled)=>{const {useAppStore}=await import('/src/stores/appStore.ts');useAppStore.setState(s=>({bootstrap:{...s.bootstrap,settings:{...s.bootstrap.settings,general:{...s.bootstrap.settings.general,confirmDestructiveActions:enabled}}}}));},enabled);
 await page.getByRole('button',{name:'Edit artwork',exact:true}).click();const d=page.getByRole('dialog',{name:'Edit artwork',exact:true});
 await d.getByLabel('Width (%)',{exact:true}).fill('95');await d.getByRole('button',{name:'Cancel',exact:true}).click();
 const confirmation=page.getByRole('dialog',{name:'Discard artwork changes?',exact:true});
 if(enabled){await expect(confirmation).toBeVisible();await confirmation.getByRole('button',{name:'Cancel',exact:true}).click();await expect(d).toBeVisible();await d.getByRole('button',{name:'Cancel',exact:true}).click();await confirmation.getByRole('button',{name:'Discard changes',exact:true}).click();}else{await expect(confirmation).not.toBeVisible();}
 await expect(d).not.toBeVisible();await page.getByRole('button',{name:'Edit artwork',exact:true}).click();await expect(d.getByLabel('Width (%)',{exact:true})).toHaveValue('80');
});

test('artwork keyboard, reduced motion and scaled layout',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/#/instance/preview-1?tab=settings');
 for(const scale of [0.75,1,1.5]){
  await page.setViewportSize({width:Math.round(1440/scale),height:Math.round(900/scale)});
  await page.getByRole('button',{name:'Edit artwork',exact:true}).click();const d=page.getByRole('dialog',{name:'Edit artwork',exact:true});
  expect(await d.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  const apply=d.getByRole('button',{name:'Apply',exact:true});const box=await apply.boundingBox();expect(box!.y+box!.height).toBeLessThanOrEqual(Math.round(900/scale)+1);
  await d.getByLabel('Width (%)',{exact:true}).fill('100');await apply.focus();await page.keyboard.press('Control+z');await expect(d.getByLabel('Width (%)',{exact:true})).toHaveValue('80');
  const button=d.getByRole('button',{name:'Undo',exact:true});
  await page.emulateMedia({reducedMotion:'reduce'});expect(await button.evaluate(el=>getComputedStyle(el).transform)).toBe('none');
  await d.getByRole('button',{name:'Cancel',exact:true}).click();await expect(d).not.toBeVisible();
 }
 expect(errors).toEqual([]);
});

test('artwork help and top rotation handle',async({page})=>{
 await page.goto('/#/instance/preview-1?tab=settings');await page.getByRole('button',{name:'Edit artwork',exact:true}).click();const d=page.getByRole('dialog',{name:'Edit artwork',exact:true});
 await d.getByRole('button',{name:'Help',exact:true}).click();await expect(d.getByRole('note')).toContainText('Ctrl + Z');await d.getByRole('button',{name:'Help',exact:true}).click();
 await d.locator('[data-artwork-stage]').click();const h=await d.locator('[data-rotate-handle=top]').boundingBox();expect(h).toBeTruthy();await page.mouse.move(h!.x+h!.width/2,h!.y+h!.height/2);await page.mouse.down();await page.mouse.move(h!.x+h!.width/2+25,h!.y+h!.height/2+10,{steps:4});await page.mouse.up();await expect(d.getByLabel('Rotation (°)',{exact:true})).not.toHaveValue('0');
});

test('Cyrillic shortcuts and stretched icon rendering',async({page})=>{
 await page.goto('/#/instance/preview-1?tab=settings');await page.getByRole('button',{name:'Edit artwork',exact:true}).click();const d=page.getByRole('dialog',{name:'Edit artwork',exact:true});const w=d.getByLabel('Width (%)',{exact:true});await w.fill('140');await w.dispatchEvent('keydown',{key:'я',code:'KeyZ',ctrlKey:true,bubbles:true});await expect(w).toHaveValue('80');await w.dispatchEvent('keydown',{key:'н',code:'KeyY',ctrlKey:true,bubbles:true});await expect(w).toHaveValue('140');await d.getByLabel('Height (%)',{exact:true}).fill('40');const svg=d.locator('[data-artwork-stage] > div:first-child > span > svg');await expect(svg).toHaveAttribute('preserveAspectRatio','none');const box=await svg.boundingBox();expect(box!.width/box!.height).toBeGreaterThan(3);
});
