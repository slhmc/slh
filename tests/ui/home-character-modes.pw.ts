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

test("appearance exposes three direct mode choices in tiles and rows", async ({ page }) => {
  await page.goto("/#/settings/appearance");
  const control = page.getByRole("group", { name: "Home character", exact: true });
  for (const tiles of [true, false]) {
    await page.getByRole("switch", { name: "Compact settings menu (beta)", exact: true }).setChecked(tiles);
    await expect(control.getByRole("button")).toHaveText(["3D", "Image", "Off"]);
    const image = control.getByRole("button", { name: "Image", exact: true });
    await image.click();
    await expect(image).toHaveAttribute("aria-pressed", "true");
    const fps = page.getByRole("slider", { name: "Player FPS", exact: true });
    await expect(fps).toBeDisabled();
    await control.getByRole("button", { name: "3D", exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(fps).toBeEnabled();
    await page.keyboard.press("Tab");
    await expect(image).toBeFocused();
    await page.keyboard.press("Tab");
    const off = control.getByRole("button", { name: "Off", exact: true });
    await expect(off).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(off).toHaveAttribute("aria-pressed", "true");
    await expect(fps).toBeDisabled();
    await expect(control.getByRole("slider")).toHaveCount(0);
    await page.screenshot({ path: `artifacts/performance/character-setting-${tiles ? "tiles" : "rows"}.png` });
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
