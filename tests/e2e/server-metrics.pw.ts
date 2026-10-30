import { expect, test, type Page } from "@playwright/test";

async function overview(page: Page) {
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Weekend", exact: true }).dblclick();
}
async function fixture(page: Page, value: object) {
  await page.evaluate(value => localStorage.setItem("slh.previewServerMetrics", JSON.stringify({ "preview-Weekend": value })), value);
}

test("overview refreshes real process values and clears them on stop and restart", async ({ page }) => {
  await overview(page);
  const panel = page.locator("[data-server-metrics]");
  await expect(panel).toContainText("The server is stopped.");
  await expect(panel.locator("dd")).toHaveText(["—", "—", "—"]);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.locator('[data-server-tab="overview"]').click();
  await expect(panel.locator("dd")).toHaveText(["700 MiB", "6.4%", "1 h 5 min"]);
  await fixture(page, { memoryBytes: 943718400, cpuPercent: 15, uptimeSeconds: 7380 });
  await expect(panel.locator("dd")).toHaveText(["900 MiB", "15%", "2 h 3 min"]);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(panel.locator("dd")).toHaveText(["—", "—", "—"]);
  await fixture(page, { memoryBytes: 104857600, cpuPercent: null, uptimeSeconds: 1 });
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.locator('[data-server-tab="overview"]').click();
  await expect(panel.locator("dd")).toHaveText(["100 MiB", "—", "0 h 0 min"]);
  await fixture(page, { memoryBytes: null, cpuPercent: null, uptimeSeconds: null });
  await expect(panel).toContainText("Measurements are available for servers started through SLH.");
  await expect(panel.locator("dd")).toHaveText(["—", "—", "—"]);
});

for (const [locale, heading, memory] of [["en-US", "Server load", "700 MiB"], ["ru-RU", "Нагрузка сервера", "700 МиБ"], ["de-DE", "Serverauslastung", "700 MiB"]]) {
  test(`${locale}: metrics fit desktop, narrow windows and scaled text`, async ({ page }) => {
    await page.goto("/#/settings/general");
    await page.locator("[data-language-selector]").selectOption(locale);
    await overview(page);
    // Start from the library-independent workspace action and return to overview.
    const startLabel = locale === "ru-RU" ? "Запустить" : locale === "de-DE" ? "Starten" : "Start";
    await page.getByRole("button", { name: startLabel, exact: true }).click();
    await page.locator('[data-server-tab="overview"]').click();
    const panel = page.locator("[data-server-metrics]");
    await expect(panel.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(panel).toContainText(memory);
    await page.screenshot({ path: `artifacts/server-metrics-${locale}-desktop.png` });
    for (const [width, scale] of [[1440, 1], [800, 1.5], [400, 1]]) {
      await page.setViewportSize({ width, height: 700 });
      await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
      expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      expect(await panel.evaluate(node => node.parentElement!.scrollWidth <= node.parentElement!.clientWidth + 1)).toBe(true);
      for (const item of await panel.locator("dd").all()) {
        expect(await item.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      }
    }
    await page.screenshot({ path: `artifacts/server-metrics-${locale}-narrow.png`, fullPage: true });
  });
}
