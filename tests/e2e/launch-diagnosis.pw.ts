import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

async function crash(page: Page, kind = "java", silent = false) {
  await page.evaluate(async ({ kind, silent }) => {
    const { useAppStore } = await import("/src/stores/appStore.ts");
    useAppStore.getState().receiveLaunchState({
      instanceId: "preview-1", launchId: crypto.randomUUID(), state: "crashed", exitCode: 1,
      reportPath: "E:/SLH/crash/slh-test.txt",
      diagnosis: { kind, evidence: ["[ERROR] UnsupportedClassVersionError: example.Mod " + "long-file-name-".repeat(25)] },
    }, silent);
  }, { kind, silent });
}

test("known and unknown failures link to the appropriate instance tab without changing files", async ({ page }) => {
  await page.goto("/#/library");
  await page.getByRole("button", { name: "New instance", exact: true }).waitFor();
  for (const [kind, tab] of [["java", "settings"], ["memory", "settings"], ["dependencies", "mods"], ["duplicateMods", "mods"], ["mods", "mods"], ["graphics", "logs"], ["jvmArguments", "logs"], ["unknown", "logs"], ["futureRule", "logs"]]) {
    await crash(page, kind);
    const dialog = page.getByRole("dialog", { name: "Minecraft stopped unexpectedly" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("[data-launch-diagnosis]")).toHaveAttribute("data-launch-diagnosis", kind === "futureRule" ? "unknown" : kind);
    await dialog.locator("footer button").last().click();
    await expect(page).toHaveURL(new RegExp(`/instance/preview-1\\?tab=${tab}$`));
    await expect(dialog).not.toBeVisible();
  }
});

test("Escape closes diagnosis, notifications reopen it, and background failures remain in the overview", async ({ page }) => {
  await page.goto("/#/library");
  await page.getByRole("button", { name: "New instance", exact: true }).waitFor();
  await crash(page);
  const dialog = page.getByRole("dialog", { name: "Minecraft stopped unexpectedly" });
  await expect(dialog).toBeVisible();
  for (let index = 0; index < 9; index++) {
    await page.keyboard.press("Tab");
    // Browser chrome can take focus at the end of a native dialog's tab cycle.
    expect(await dialog.evaluate(element => !document.hasFocus() || element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Show diagnosis", exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await crash(page, "memory", true);
  await expect(dialog).not.toBeVisible();
  await page.goto("/#/instance/preview-1?tab=overview");
  await page.getByRole("button", { name: "Last launch error", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Memory allocation failed", exact: true })).toBeVisible();
});

test("diagnosis can open a hidden settings tab without changing the saved tab arrangement", async ({ page }) => {
  await page.goto("/#/library");
  await page.getByRole("button", { name: "New instance", exact: true }).waitFor();
  await page.evaluate(async () => {
    const { command } = await import("/src/lib/tauri.ts");
    const { useAppStore } = await import("/src/stores/appStore.ts");
    const general = useAppStore.getState().bootstrap.settings.general;
    await command("update_setting", { key: "general", value: { ...general, instanceTabs: { ...general.instanceTabs, visible: ["overview"] } } });
    await useAppStore.getState().refresh();
  });
  await crash(page, "memory");
  await page.getByRole("dialog").getByRole("button", { name: "Open instance settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/instance\/preview-1\?tab=settings$/);
  const visible = await page.evaluate(async () => (await import("/src/stores/appStore.ts")).useAppStore.getState().bootstrap.settings.general.instanceTabs.visible);
  expect(visible).toEqual(["overview"]);
});

for (const code of ["en-US", "ru-RU", "de-DE"]) {
  for (const light of [false, true]) {
    test(`${code} ${light ? "light" : "dark"}: diagnosis follows shared dialog geometry`, async ({ page }) => {
      const messages = JSON.parse(readFileSync(`resources/languages/${code}.json`, "utf8"));
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.route("**/src/lib/tauri.ts*", async route => {
        const response = await route.fetch();
        const body = (await response.text()).replace('if (name === "get_bootstrap") {', `if (name === "open_crash_report") { window.openedDiagnosisReport = args.path; return; } if (name === "get_bootstrap") {`);
        await route.fulfill({ response, body });
      });
      await page.goto("/#/settings/appearance");
      await page.getByRole("heading", { name: "Appearance", exact: true }).waitFor();
      if (light) await page.getByRole("button", { name: /Light Orange/ }).click();
      await page.evaluate(async code => {
        const { command } = await import("/src/lib/tauri.ts");
        const { useAppStore } = await import("/src/stores/appStore.ts");
        await command("update_setting", { key: "general", value: { ...useAppStore.getState().bootstrap.settings.general, language: code } });
        await useAppStore.getState().refresh();
      }, code);
      await expect(page.locator("html")).toHaveAttribute("lang", code);
      for (const [width, height] of [[1440, 900], [800, 560]]) {
        await page.setViewportSize({ width, height });
        await crash(page, "mods");
        const dialog = page.getByRole("dialog", { name: messages.launchDiagnosis.title });
        await expect(dialog).toBeVisible();
        await page.screenshot({ path: `artifacts/ui/diagnosis-${code}-${light ? "light" : "dark"}-${width}-collapsed.png` });
        await dialog.locator("summary").click();
        await expect(dialog.getByLabel(messages.launchDiagnosis.evidence)).toBeVisible();
        const geometry = await dialog.evaluate(element => {
          const rect = element.getBoundingClientRect();
          const body = element.children[1];
          const status = body.querySelector("section")!;
          const footer = element.querySelector("footer")!;
          return {
            inside: rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
            bodyPadding: parseFloat(getComputedStyle(body).paddingLeft),
            statusPadding: parseFloat(getComputedStyle(status).paddingLeft),
            footerGap: parseFloat(getComputedStyle(footer).gap),
            overflow: [element, body, status, footer, ...element.querySelectorAll("details, pre")].some(node => node.scrollWidth > node.clientWidth + 1),
            footerInside: [...footer.querySelectorAll("button")].every(button => {
              const box = button.getBoundingClientRect(); return box.left >= rect.left + 8 && box.right <= rect.right - 8 && box.bottom <= rect.bottom - 8;
            }),
          };
        });
        expect(geometry).toMatchObject({ inside: true, footerGap: 8, overflow: false, footerInside: true });
        expect(geometry.bodyPadding).toBeGreaterThanOrEqual(12);
        expect(geometry.statusPadding).toBeGreaterThanOrEqual(16);
        await page.screenshot({ path: `artifacts/ui/diagnosis-${code}-${light ? "light" : "dark"}-${width}-expanded.png` });
        if (code === "ru-RU" && !light && process.env.SLH_LAYOUT_DUMPER) {
          await page.addScriptTag({ content: readFileSync(process.env.SLH_LAYOUT_DUMPER, "utf8") });
          const dump = await page.evaluate(() => (window as any).betterDesignDumpLayout("dialog[open]"));
          writeFileSync(`artifacts/ui/diagnosis-layout-${width}.json`, JSON.stringify(dump, null, 2));
        }
        await dialog.getByRole("button", { name: messages.errors.openReport, exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as any).openedDiagnosisReport)).toBe("E:/SLH/crash/slh-test.txt");
        await page.keyboard.press("Escape");
        await expect(dialog).not.toBeVisible();
      }
    });
  }
}

test("200% text and square corners retain the footer and readable content", async ({ page }) => {
  await page.goto("/#/library");
  await page.getByRole("button", { name: "New instance", exact: true }).waitFor();
  await page.setViewportSize({ width: 800, height: 560 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
    const root = document.querySelector("#root > div") as HTMLElement;
    for (const key of ["--radius-xs", "--radius-sm", "--radius-md", "--radius-lg"]) root.style.setProperty(key, "0px");
  });
  await crash(page, "memory");
  const dialog = page.getByRole("dialog", { name: "Minecraft stopped unexpectedly" });
  await expect(dialog).toBeVisible();
  await dialog.locator("summary").click();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  for (const button of await dialog.locator("footer button").all()) {
    const box = await button.boundingBox();
    expect(box!.y + box!.height).toBeLessThan(560);
    expect(box!.x + box!.width).toBeLessThan(800);
  }
  await page.screenshot({ path: "artifacts/ui/diagnosis-200-percent-800.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});
