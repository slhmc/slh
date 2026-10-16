import { expect, test } from "@playwright/test";
test.use({deviceScaleFactor:1.75});

test("character switches between live 3D, a cached portrait and off without retaining WebGL",async ({page}) => {
  await page.setViewportSize({width:1450,height:767});
  await page.goto("/#/home");
  await page.waitForFunction(() => document.querySelector("canvas")?.height! > 400);
  await page.evaluate(() => { (window as any).__oldHomeCanvas = document.querySelector("canvas"); });
  const setMode = async (mode:number) => {
    await page.evaluate(async mode => {
      const {command} = await import("/src/lib/tauri.ts");
      const {useAppStore} = await import("/src/stores/appStore.ts");
      const store = useAppStore.getState();
      await command("update_setting",{key:"appearance",value:{...store.bootstrap.settings.appearance,homeCharacterMode:mode}});
      await store.refresh();
    },mode);
  };
  await setMode(1);
  const image = page.locator('[data-home-character="image"] img');
  await expect(image).toBeVisible();
  await image.evaluate((image:HTMLImageElement) => image.decode());
  expect(await image.evaluate(image => image.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  expect(await image.evaluate((image:HTMLImageElement) => image.naturalHeight)).toBeGreaterThan(500);
  await expect(page.locator("canvas")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__oldHomeCanvas.width)).toBe(1);
  await page.screenshot({path:"artifacts/performance/static-character.png"});
  await page.evaluate(() => { location.hash = "/settings/appearance"; });
  await page.getByRole("group",{name:"Home character",exact:true}).waitFor();
  await page.reload();
  // The browser preview resets mock settings on reload; restore image mode
  // before visiting Home. IndexedDB itself persists across that reload.
  await page.getByRole("group",{name:"Home character",exact:true}).waitFor();
  await setMode(1);
  await page.evaluate(() => { location.hash = "/home"; });
  await expect(image).toBeVisible();
  // A cached PNG must survive a restart without importing Three.js/the scene engine.
  expect(await page.evaluate(() => performance.getEntriesByType("resource").some(entry => /scene-loop|three\.module/.test(entry.name)))).toBe(false);
  await setMode(0);
  await expect(image).toHaveCount(0);
  await expect(page.locator("canvas")).toHaveCount(0);
  await setMode(2);
  await page.waitForFunction(() => document.querySelector("canvas")?.height! > 400);
});

test("appearance exposes 2-1-0 vertically in tiles and horizontally in rows",async ({page}) => {
  await page.goto("/#/settings/appearance");
  const control = page.getByRole("group",{name:"Home character",exact:true});
  await expect(control).toBeVisible();
  await expect(control.getByRole("button")).toHaveText(["2 · 3D","1 · Image","0 · Off"]);
  await control.getByRole("button",{name:"1 · Image",exact:true}).click();
  await expect(control.getByRole("button",{name:"1 · Image",exact:true})).toHaveAttribute("aria-pressed","true");
  const slider = control.getByRole("slider");
  await expect(slider).toHaveValue("1");
  await slider.focus();
  await slider.press("ArrowUp");
  await expect(slider).toHaveValue("2");
  await slider.press("End");
  await expect(slider).toHaveValue("0");
  await slider.press("ArrowLeft");
  await expect(slider).toHaveValue("1");
  await expect(page.getByRole("slider",{name:"Player FPS",exact:true})).toHaveCount(0);
  for (const rows of [false,true]) {
    await page.evaluate(async rows => {
      const {command} = await import("/src/lib/tauri.ts");
      const {useAppStore} = await import("/src/stores/appStore.ts");
      const store = useAppStore.getState();
      await command("update_setting",{key:"general",value:{...store.bootstrap.settings.general,compactSettings:rows}});
      await store.refresh();
    },rows);
    await expect.poll(() => control.evaluate(element => getComputedStyle(element).flexDirection)).toBe(rows ? "row" : "column");
    await slider.scrollIntoViewIfNeeded();
    const box = await slider.boundingBox();
    await slider.click({position:rows ? {x:box!.width-5,y:box!.height/2} : {x:box!.width/2,y:box!.height-5}});
    await expect(slider).toHaveValue("0");
    await slider.click({position:rows ? {x:5,y:box!.height/2} : {x:box!.width/2,y:5}});
    await expect(slider).toHaveValue("2");
    await slider.click({position:{x:box!.width/2,y:box!.height/2}});
    await expect(slider).toHaveValue("1");
    await page.screenshot({path:`artifacts/performance/character-setting-${rows ? "rows" : "tiles"}.png`});
  }
});

test("localized controls fit narrow and wide settings",async ({page}) => {
  await page.goto("/#/settings/appearance");
  for (const [locale,title] of [["ru-RU","Персонаж на главной"],["de-DE","Figur auf der Startseite"],["en-US","Home character"]]) {
    await page.evaluate(async locale => {
      const {command} = await import("/src/lib/tauri.ts");
      const {useAppStore} = await import("/src/stores/appStore.ts");
      const store = useAppStore.getState();
      await command("update_setting",{key:"general",value:{...store.bootstrap.settings.general,language:locale,compactSettings:true}});
      await store.refresh();
    },locale);
    await expect(page.locator("html")).toHaveAttribute("lang",locale);
    const control = page.getByRole("group",{name:title,exact:true});
    for (const width of [800,1440]) {
      await page.setViewportSize({width,height:560});
      await expect(control).toBeVisible();
      const fits = await control.evaluate(element => [...element.querySelectorAll("button")].every(button => button.scrollWidth <= button.clientWidth+1));
      expect(fits).toBe(true);
    }
    await page.screenshot({path:`artifacts/performance/character-setting-${locale}.png`});
  }
});
