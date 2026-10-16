import { expect, test } from "@playwright/test";

test("CurseForge download settings save independently in both layouts", async ({page}) => {
  await page.goto("/#/settings/downloads");
  const archive = page.getByRole("switch", {name:"Import CurseForge archives automatically",exact:true});
  const cleanup = page.getByRole("switch", {name:"Delete downloads after installation",exact:true});
  await expect(archive).toHaveAttribute("aria-checked","false");
  await expect(cleanup).toHaveAttribute("aria-checked","false");
  await archive.click();
  await expect(archive).toHaveAttribute("aria-checked","true");
  await expect(cleanup).toHaveAttribute("aria-checked","false");
  await cleanup.click();
  await expect(cleanup).toHaveAttribute("aria-checked","true");
  for(const width of [800,1440]) {
    await page.setViewportSize({width,height:1000});
    await expect(page.getByRole("button",{name:"Choose folder",exact:true})).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({path:"artifacts/performance/curseforge-download-settings.png",fullPage:true});
  await page.evaluate(async () => {
    const {command} = await import("/src/lib/tauri.ts");
    const {useAppStore} = await import("/src/stores/appStore.ts");
    const state=useAppStore.getState();
    await command("update_setting",{key:"general",value:{...state.bootstrap!.settings.general,compactSettings:true}});
    await state.refresh();
  });
  await expect(archive).toHaveAttribute("aria-checked","true");
  await archive.click();
  await expect(archive).toHaveAttribute("aria-checked","false");
  await expect(cleanup).toHaveAttribute("aria-checked","true");
});
