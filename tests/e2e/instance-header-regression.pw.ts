import {test, expect} from "@playwright/test";
test("default instance actions remain buttons in one grid", async ({page}) => {
  await page.goto("/#/library");
  await page.getByRole("button", {name:"Latest release",exact:true}).click();
  for (const width of [800, 1440]) {
    await page.setViewportSize({width, height: width === 800 ? 560 : 900});
    await expect(page.getByRole("button", {name:"Delete instance",exact:true})).toBeAttached();
    await expect(page.getByText("More actions", {exact:true})).toHaveCount(0);
    await page.screenshot({path:`artifacts/ui/instance-actions-${width}.png`});
  }
});
test("instance header keeps artwork, identity and launch action visible", async ({page}) => {
  await page.goto("/#/instance/preview-2?tab=mods");
  const header = page.locator('header[class*="header"]').first();
  await expect(header.getByRole("button", {name: "Library", exact: true})).toBeVisible();
  const play = header.getByRole("button", {name: /Play|Install|Repair/});
  await expect(play).toBeVisible();
  for (const width of [800,1440]) {
    await page.setViewportSize({width, height: width === 800 ? 560 : 900});
    const boxes = await header.locator(':scope > *').evaluateAll(nodes => nodes.map(node => { const r=node.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,width:r.width,height:r.height}; }));
    expect(boxes).toHaveLength(6);
    expect(boxes[0].width).toBeGreaterThan(50);
    expect(boxes[5].width).toBeGreaterThan(65);
    for (const box of boxes) { expect(box.x).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width); }
    if (width === 1440) expect(Math.abs(boxes[0].y - boxes[5].y)).toBeLessThan(30);
    await page.screenshot({path:`artifacts/ui/instance-header-fix-${width}.png`});
  }
  await header.getByRole("button", {name:"Library",exact:true}).click();
  await expect(page).toHaveURL(/library/);
});

test("configured side actions do not show an empty More menu", async ({page}) => {
  await page.goto("/#/library");
  await expect(page.getByRole("button", {name:"Latest release",exact:true})).toBeVisible();
  await page.evaluate(async () => {
    const {command} = await import("/src/lib/tauri.ts");
    const {useAppStore} = await import("/src/stores/appStore.ts");
    const general = useAppStore.getState().bootstrap.settings.general;
    await command("update_setting", {key:"general",value:{...general,instancePanel:{showArtwork:true,showMetadata:true,hiddenActions:[],actionOrder:["mods","worlds","folder","screenshots","logs","settings","group","export","delete"]}}});
    await useAppStore.getState().refresh();
  });
  await page.getByRole("button", {name:"Latest release",exact:true}).click();
  await expect(page.getByRole("button", {name:"Delete instance",exact:true})).toBeVisible();
  await expect(page.getByText("More actions", {exact:true})).toHaveCount(0);
  await expect(page.getByText("Multiplayer servers", {exact:true})).toHaveCount(0);
});

test("Russian instance header remains usable at small and large sizes", async ({page}) => {
  await page.goto("/#/settings/general");
  await page.locator('[data-language-selector]').selectOption("ru-RU");
  await page.goto("/#/instance/preview-2?tab=mods");
  const header = page.locator('header[class*="header"]').first();
  const play = header.getByRole("button", {name:"Играть",exact:true});
  await expect(play).toBeVisible();
  for (const width of [800,1440]) {
    await page.setViewportSize({width,height:width === 800 ? 560 : 900});
    const rect = await play.boundingBox();
    expect(rect!.width).toBeGreaterThan(75);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
    await page.screenshot({path:`artifacts/ui/instance-header-ru-${width}.png`});
  }
});

test("header remains aligned with instance tabs on the right", async ({page}) => {
  await page.goto("/#/settings/general");
  await page.getByRole("combobox", {name:"Instance and server tabs position",exact:true}).selectOption("right");
  await page.goto("/#/instance/preview-2?tab=mods");
  await page.setViewportSize({width:1440,height:900});
  const header=page.locator('header[class*="header"]').first();
  const play=header.getByRole("button", {name:"Play",exact:true});
  await expect(play).toBeVisible();
  const all=await header.locator(':scope > *').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,width:r.width}}));
  expect(all).toHaveLength(6);
  expect(all[5].width).toBeGreaterThan(65);
  expect(all[5].right).toBeLessThanOrEqual(1440);
  expect(Math.abs(all[0].y-all[5].y)).toBeLessThan(30);
  await page.screenshot({path:"artifacts/ui/instance-header-right-tabs.png"});
});
