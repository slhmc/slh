import { expect, test } from "@playwright/test";

test("server creation uses explicit EULA, pinned builds and an independent console", async ({ page }) => {
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto("/#/local-servers");
  await page.getByRole("button",{name:"Create server",exact:true}).click();
  const dialog=page.getByRole("dialog");
  await expect(dialog.getByRole("combobox",{name:"Minecraft version",exact:true})).toHaveValue("1.21.4");
  await expect(dialog.getByRole("combobox",{name:"Core version / build",exact:true})).toHaveValue("1.21.4");
  await dialog.getByLabel("Name",{exact:true}).fill("Weekend server");
  const create=dialog.getByRole("button",{name:"Create server",exact:true});
  await expect(create).toBeDisabled();
  await dialog.getByRole("checkbox",{name:/I accept the Minecraft EULA/}).check();
  await expect(create).toBeEnabled();await create.click();await expect(dialog).not.toBeVisible();
  await page.getByRole("button",{name:"Weekend server",exact:true}).click();
  await page.getByRole("button",{name:"Start",exact:true}).click();
  await expect(page.getByLabel("Server output",{exact:true})).toContainText("SLH browser preview");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button",{name:"Stop",exact:true}).click();
  await expect(page.getByRole("button",{name:"Start",exact:true})).toBeEnabled();expect(errors).toEqual([]);

});

test("cleanup starts unchecked and requires review; download history starts collapsed",async({page})=>{
  await page.goto("/#/settings/storage");await page.getByRole("button",{name:"Analyze files",exact:true}).click();
  await expect(page.getByRole("button",{name:"Delete selected",exact:true})).toBeDisabled();
  await page.getByRole("checkbox",{name:/Metadata cache/}).check();
  await page.getByRole("button",{name:"Delete selected",exact:true}).click();
  const dialog=page.getByRole("dialog");await expect(dialog).toContainText("modrinth:search");
  await dialog.getByRole("button",{name:"Close",exact:true}).click();
  await expect(page.getByRole("button",{name:"Delete selected",exact:true})).toBeEnabled();
  await page.evaluate(()=>{window.location.hash="/settings/downloads";});
  const history=page.locator("details").filter({has:page.getByText("Recent verified transfers",{exact:true})});
  await expect(history).not.toHaveAttribute("open");await history.locator("summary").click();
  await expect(history).toContainText("No queued or completed content downloads.");
  const parallel=page.getByRole("spinbutton",{name:"Concurrent downloads",exact:true});
  await parallel.fill("7");await parallel.press("Enter");await expect(parallel).toHaveValue("7");
});

for (const [locale,title,create] of [["en-US","Your Minecraft servers","Create server"],["ru-RU","Ваши серверы Minecraft","Создать сервер"],["de-DE","Deine Minecraft-Server","Server erstellen"]]) {
  test(`${locale} server form fits narrow and enlarged viewports`,async({page})=>{
    await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/#/settings/general");
    await page.locator("[data-language-selector]").selectOption(locale);
    await page.evaluate(()=>{window.location.hash="/local-servers";});
    await expect(page.getByRole("heading",{name:title,exact:true})).toBeVisible();
    await page.getByRole("button",{name:create,exact:true}).click();const dialog=page.getByRole("dialog");
    for(const [width,height] of [[1440,900],[800,560],[400,280]]) {
      await page.setViewportSize({width,height});
      const action=dialog.getByRole("button",{name:create,exact:true});await expect(action).toBeVisible();
      const box=await action.boundingBox();expect(box).not.toBeNull();expect(box!.x+box!.width).toBeLessThanOrEqual(width+1);expect(box!.y+box!.height).toBeLessThanOrEqual(height+1);
      expect(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
      await page.screenshot({path:`artifacts/servers-${locale}-${width}.png`});
    }
    await page.keyboard.press("Escape");await expect(dialog).not.toBeVisible();
  });
}

test("light theme keeps server settings and cleanup keyboard accessible", async ({page}) => {
  await page.emulateMedia({reducedMotion:"reduce"});
  await page.goto("/#/settings/appearance");
  await page.getByRole("button",{name:/Light Orange/}).click();
  await page.evaluate(()=>{location.hash="/settings/servers";});
  const save=page.getByRole("button",{name:"Save",exact:true});
  await expect(save).toBeVisible(); await save.focus(); await expect(save).toBeFocused();
  await page.setViewportSize({width:800,height:560});
  expect(await page.locator("main").evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
  await page.screenshot({path:"artifacts/servers-light-settings.png"});
  await page.evaluate(()=>{location.hash="/settings/storage";});
  const analyze=page.getByRole("button",{name:"Analyze files",exact:true});
  await analyze.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("checkbox",{name:/Metadata cache/})).not.toBeChecked();
  await page.screenshot({path:"artifacts/servers-light-cleanup.png"});
});

test("Bukkit path limitations are explained before installation",async({page})=>{
  await page.goto("/#/local-servers");await page.getByRole("button",{name:"Create server",exact:true}).click();
  const dialog=page.getByRole("dialog");
  await dialog.getByLabel("Name",{exact:true}).fill("Server path check");
  await dialog.getByRole("combobox",{name:"Core",exact:true}).selectOption("spigot");
  await dialog.getByRole("checkbox",{name:/I accept the Minecraft EULA/}).check();
  const create=dialog.getByRole("button",{name:"Create server",exact:true});
  await expect(create).toBeEnabled();
  await dialog.getByLabel("Folder name",{exact:true}).fill("blocked+name");
  await expect(dialog.getByRole("alert")).toContainText("require a path without ! or +");
  await expect(create).toBeDisabled();
  await dialog.getByLabel("Folder name",{exact:true}).fill("Кириллица & 100% works");
  await expect(create).toBeEnabled();
});


test("persistent server library opens nested gdz and uses the instance detail frame",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await page.goto("/#/local-servers");
 await expect(page.getByRole("button",{name:"Weekend",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Open group gdz",exact:true}).click();await expect(page.getByRole("button",{name:"gdzserver",exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"Weekend",exact:true})).toHaveCount(0);
 await page.reload();await expect(page.getByRole("button",{name:"gdzserver",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"gdzserver",exact:true}).dblclick();
 await expect(page.getByRole("navigation",{name:"Server sections"})).toBeVisible();await expect(page.getByRole("heading",{name:"Overview",exact:true})).toBeVisible();
 const nav=page.getByRole("navigation",{name:"Server sections"});await nav.getByRole("button",{name:"Settings",exact:true}).click();
 await expect(page.getByRole("heading",{name:"Name and appearance",exact:true})).toBeVisible();await expect(page.getByRole("heading",{name:"Java and launch",exact:true})).toBeVisible();
 await page.getByRole("combobox",{name:"Tab position",exact:true}).selectOption("right");await page.screenshot({path:"artifacts/server-library-settings-v2.png"});
 await page.getByRole("button",{name:"Start",exact:true}).click();await expect(page.getByLabel("Server output")).toContainText("SLH browser preview");
 await expect(page.getByRole("dialog")).toHaveCount(0);await page.getByRole("button",{name:"Stop",exact:true}).click();
 await page.screenshot({path:"artifacts/server-library-console-v2.png"});expect(errors).toEqual([]);
});

test("server plugins use explicit review and stopped-server controls",async({page})=>{
 await page.goto("/#/local-servers");await page.getByRole("button",{name:"Weekend",exact:true}).click();await page.getByRole("button",{name:"Plugins",exact:true}).click();
 await page.getByRole("button",{name:"Browse plugins",exact:true}).click();await page.getByRole("button",{name:"Modrinth",exact:true}).click();await page.getByRole("button",{name:"Choose version",exact:true}).click();const dialog=page.getByRole("dialog");await dialog.getByRole("button",{name:"Review installation",exact:true}).click();await expect(dialog).toContainText("ExamplePlugin-1.0.jar");await dialog.getByRole("button",{name:"Install",exact:true}).click();await expect(dialog).not.toBeVisible();
 await page.getByRole("button",{name:"Back to files",exact:true}).click();await expect(page.getByText("Example Plugin",{exact:true})).toBeVisible();await page.getByRole("button",{name:"Disable",exact:true}).click();await expect(page.getByText(/ExamplePlugin-1.0.jar.disabled/)).toBeVisible();await page.getByRole("button",{name:"Enable",exact:true}).click();
 await page.getByRole("button",{name:"Start",exact:true}).click();await page.getByRole("navigation",{name:"Server sections"}).getByRole("button",{name:"Plugins",exact:true}).click();await expect(page.getByRole("button",{name:"Disable",exact:true})).toBeDisabled();await page.getByRole("button",{name:"Stop",exact:true}).click();
 await page.getByRole("button",{name:"Browse plugins",exact:true}).click();await page.getByRole("button",{name:"CurseForge",exact:true}).click();await expect(page.getByText("Example Plugin",{exact:true})).toBeVisible();
});


test("configuration sections keep labels aligned and readable at effective 200 percent scale",async({page})=>{
 await page.goto("/#/local-servers");await page.getByRole("button",{name:"Create server",exact:true}).click();const dialog=page.getByRole("dialog");
 for(const [width,height] of [[1440,900],[800,560],[400,280]]){
  await page.setViewportSize({width,height});
  for(const section of ["Core and version","Java and launch","World","Network","Access and rules","Advanced"]){
   await dialog.getByRole("tab",{name:section,exact:true}).click();
   const panel=dialog.getByRole("tabpanel",{name:section,exact:true});await expect(panel).toBeVisible();
   expect(await panel.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
   expect(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
  }
 }
 await page.setViewportSize({width:1440,height:900});await dialog.getByRole("tab",{name:"Network",exact:true}).click();await page.screenshot({path:"artifacts/server-workspace-network-form.png"});
});


test("logical group drag, manual order, collapse and appearance survive reload",async({page})=>{
 await page.goto("/#/local-servers");await page.getByRole("button",{name:"Group",exact:true}).click();const dialog=page.getByRole("dialog");await dialog.getByLabel("Name",{exact:true}).fill("My servers");await dialog.getByRole("button",{name:"Save",exact:true}).click();
 await page.getByRole("button",{name:"Expand or collapse gdz",exact:true}).click();
 const source=page.getByRole("button",{name:"Weekend",exact:true});const target=page.locator("[data-server-group]").filter({has:page.getByRole("heading",{name:"My servers",exact:true})}).first();
 const a=await source.boundingBox();const b=await target.boundingBox();expect(a).not.toBeNull();expect(b).not.toBeNull();await page.mouse.move(a!.x+a!.width/2,a!.y+a!.height/2);await page.mouse.down();await page.mouse.move(b!.x+40,b!.y+16,{steps:15});await page.mouse.up();
 await expect(target.getByRole("button",{name:"Weekend",exact:true})).toBeVisible();await expect(page.getByRole("combobox",{name:"Sort servers",exact:true})).toHaveValue("manual");
 await page.reload();const group=page.locator("section[data-server-group]").filter({has:page.getByRole("heading",{name:"My servers",exact:true})});await expect(group.getByRole("button",{name:"Weekend",exact:true})).toBeVisible();
 await group.getByRole("button",{name:"Expand or collapse My servers",exact:true}).click();await expect(group.getByRole("button",{name:"Weekend",exact:true})).toHaveCount(0);await page.reload();await expect(group.getByRole("button",{name:"Weekend",exact:true})).toHaveCount(0);await group.getByRole("button",{name:"Expand or collapse My servers",exact:true}).click();
 await group.getByRole("button",{name:"Weekend",exact:true}).dblclick();await page.getByRole("navigation",{name:"Server sections"}).getByRole("button",{name:"Settings",exact:true}).click();await page.getByRole("button",{name:"Java",exact:true}).click();await page.getByRole("button",{name:"Save appearance",exact:true}).click();await page.reload();await expect(page.getByRole("button",{name:"Java",exact:true})).toHaveAttribute("aria-pressed","true");
});


test("shared server workspace remains usable at small viewports and effective 200 percent scale",async({page})=>{
 await page.goto("/#/local-servers");await page.getByRole("button",{name:"Weekend",exact:true}).dblclick();const nav=page.getByRole("navigation",{name:"Server sections"});
 for(const [width,height] of [[1440,900],[800,560],[400,280]]){await page.setViewportSize({width,height});await nav.getByRole("button",{name:"Settings",exact:true}).click();await expect(page.getByRole("heading",{name:"Name and appearance",exact:true})).toBeVisible();expect(await page.locator("main").first().evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
 await nav.getByRole("button",{name:"Console",exact:true}).click();const input=page.getByLabel("Server command",{exact:true});await input.scrollIntoViewIfNeeded();expect(await page.getByLabel("Server output",{exact:true}).evaluate(e=>e.clientHeight)).toBeGreaterThanOrEqual(100);const box=await input.boundingBox();expect(box).not.toBeNull();expect(box!.y+box!.height).toBeLessThanOrEqual(height+1);expect(box!.y).toBeGreaterThanOrEqual(0);await page.screenshot({path:`artifacts/server-library-workspace-${width}.png`});}
});
