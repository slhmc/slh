import { expect, test } from "@playwright/test";
test("instance statuses are described in every library view", async ({ page }) => {
  await page.goto("/#/library");
  await expect(page.getByRole("button", { name: "Latest release", exact: true })).toBeVisible();
  for (const status of ["running", "error", "installing", "launching"] as const) {
    await page.evaluate(async status => {
      const { useAppStore } = await import("/src/stores/appStore.ts");
      useAppStore.setState(state => ({ bootstrap: { ...state.bootstrap, instances: state.bootstrap.instances.map(instance => instance.name === "Latest release" ? { ...instance, status } : instance) } }));
    }, status);
    for (const view of ["Grouped icons", "Grid view", "List view"]) {
      await page.getByRole("button", { name: view, exact: true }).click();
      const card = page.locator('[data-slh-instance]').filter({ hasText: "Latest release" }).first();
      const id = await card.getAttribute("aria-describedby");
      expect(id).toBeTruthy();
      await expect(page.locator(`[id="${id}"]`)).toBeVisible();
      if (status === "running" && view === "Grouped icons") {
        for (const width of [800, 1440]) {
          await page.setViewportSize({ width, height: width === 800 ? 560 : 900 });
          await page.screenshot({ path: `artifacts/ui/instance-status-${width}.png` });
        }
      }
    }
  }
});
