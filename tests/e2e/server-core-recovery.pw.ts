import { expect, test, type Page } from "@playwright/test";

async function missingCore(page: Page, count = 1) {
  await page.goto("/#/local-servers");
  await expect(page.getByRole("button", { name: "Weekend", exact: true })).toBeVisible();
  await page.evaluate(count => {
    const saved = JSON.parse(localStorage.getItem("slh.previewServerLibrary")!);
    const server = saved.servers.find((value: { name: string }) => value.name === "Weekend");
    localStorage.setItem("slh.previewServerCoreFiles", JSON.stringify({ [server.id]: { candidates: Array.from({ length: count }, (_, index) => ({ path: `${server.path}\\purpur-26.${index + 3}.jar`, filename: `purpur-26.${index + 3}.jar`, minecraftVersion: `26.${index + 3}`, core: "purpur", requiredJava: 25, fingerprint: `candidate-${index}` })) } }));
  }, count);
}
test("missing core asks before changing a profile and No cancels launch", async ({ page }) => {
  await missingCore(page);
  await page.getByRole("button", { name: "Weekend", exact: true }).click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("server-old.jar");
  await expect(dialog).toContainText("purpur-26.3.jar");
  await dialog.getByRole("button", { name: "No", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem("slh.previewServerCoreFiles"))).toContain("candidate-0");
});
test("Yes replaces the selected core, preserves JVM settings and continues the requested start", async ({ page }) => {
  await missingCore(page, 2);
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem("slh.previewServerLibrary")!).servers.find((value: { name: string }) => value.name === "Weekend").config);
  await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Replacement core", exact: true }).selectOption({ label: "purpur-26.4.jar · 26.4" });
  await expect(dialog).toContainText("purpur-26.4.jar");
  await dialog.getByRole("button", { name: "Yes", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem("slh.previewServerLibrary")!).servers.find((value: { name: string }) => value.name === "Weekend").config);
  expect(after.minecraftVersion).toBe("26.4"); expect(after.customJar).toContain("purpur-26.4.jar");
  expect(after.jvmArgs).toEqual(before.jvmArgs); expect(after.memoryMaxMb).toBe(before.memoryMaxMb);
});
test("missing candidates allow browsing without enabling an empty confirmation", async ({ page }) => {
  await missingCore(page, 0);
  await page.getByRole("button", { name: "Weekend", exact: true }).click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Yes", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Choose JAR…", exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(dialog).not.toBeVisible();
});
for (const [locale, no] of [["en-US", "No"], ["ru-RU", "Нет"], ["de-DE", "Nein"]]) {
  test(`${locale}: core confirmation fits narrow windows and restores launch controls`, async ({ page }) => {
    await page.goto("/#/settings/general"); await page.locator("[data-language-selector]").selectOption(locale);
    await missingCore(page);
    await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
    await page.locator('button[class*="launchButton"]').click();
    const dialog = page.getByRole("dialog"); await expect(dialog).toContainText("26.3");
    for (const width of [1440, 800, 400]) {
      await page.setViewportSize({ width, height: 560 });
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }
    await page.screenshot({ path: `artifacts/server-core-recovery-${locale}.png` });
    await dialog.getByRole("button", { name: no, exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('button[class*="launchButton"]')).toBeEnabled();
  });
}
