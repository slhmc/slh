import { expect, test } from "@playwright/test";

test("startup warms server library and reentry remains immediate while refresh is blocked", async ({ page }) => {
  await page.goto("/#/library");
  await expect.poll(() => page.evaluate(async () => {
    const { useServerLibraryStore } = await import("/src/stores/serverLibraryStore.ts");
    return useServerLibraryStore.getState().data?.servers.some(server => server.name === "Weekend") ?? false;
  })).toBe(true);
  await page.evaluate(async () => {
    const { useServerLibraryStore } = await import("/src/stores/serverLibraryStore.ts");
    const blocked = new Promise<never>(() => {});
    useServerLibraryStore.setState({ refresh: () => blocked });
  });
  // First visit also uses the overview already fetched on another launcher page.
  await page.getByRole("link", { name: "Local servers", exact: true }).click();
  const library = page.locator("[data-server-library]");
  const card = library.getByRole("button", { name: "Weekend", exact: true });
  await expect(card).toBeVisible();
  await card.click();
  await library.getByRole("button", { name: "List view", exact: true }).click();
  const search = library.getByRole("textbox");
  await search.fill("Weekend");
  const panel = library.locator("aside").filter({ has: page.getByRole("heading", { name: "Weekend", exact: true }) });
  await expect(panel).toBeVisible();
  for (let visit = 0; visit < 3; visit++) {
    await page.getByRole("link", { name: "Library", exact: true }).click();
    await page.getByRole("link", { name: "Local servers", exact: true }).click();
    await expect(card).toBeVisible();
    await expect(search).toHaveValue("Weekend");
    await expect(panel).toBeVisible();
    await expect(library.getByRole("button", { name: "List view", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(library.locator('[class*="busyIndicator"]')).toHaveCount(0);
  }
});
