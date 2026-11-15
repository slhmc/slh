import { expect, test } from "@playwright/test";

for (const width of [800, 1440]) test(`creation sources keep identical window bounds at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 800 ? 560 : 900 });
  await page.goto("/#/library");
  await page.getByRole("button", { name: "New instance", exact: true }).click();
  const dialog = page.getByRole("dialog").first();
  await expect(dialog).not.toHaveAttribute("data-motion");
  const initial = (await dialog.boundingBox())!;
  for (const name of ["Modrinth", "CurseForge", "Custom"]) {
    await dialog.getByRole("button", { name, exact: true }).click();
    if (name !== "Custom") await expect(dialog.getByRole("heading", { name: "Discover something worth playing", exact: true })).toBeVisible();
    const bounds = (await dialog.boundingBox())!;
    for (const key of ["x", "y", "width", "height"] as const) expect(bounds[key]).toBeCloseTo(initial[key], 0);
    expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `artifacts/ui/create-${name}-${width}.png` });
  }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("a stopping server has a concise Russian state and busy action", async ({ page }) => {
  await page.goto("/#/settings/general");
  await page.locator("[data-language-selector]").selectOption("ru-RU");
  await page.goto("/#/local-servers");
  await expect(page.getByRole("button", { name: "Weekend", exact: true })).toBeVisible();
  const name = await page.evaluate(async () => {
    const { useServerLibraryStore } = await import("/src/stores/serverLibraryStore.ts");
    const state = useServerLibraryStore.getState();
    const server = state.data!.servers[0];
    useServerLibraryStore.setState({ data: { ...state.data!, servers: state.data!.servers.map(item => item.id === server.id ? { ...item, status: "stopping" } : item), view: { ...state.data!.view, selected: server.id } } });
    useServerLibraryStore.setState({ refresh: async () => useServerLibraryStore.getState().data! });
    return server.name;
  });
  await page.getByRole("button", { name, exact: true }).click();
  const stop = page.getByRole("button", { name: "Останавливается", exact: true });
  await expect(stop).toBeDisabled();
  await expect(stop).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("Сохраняется и останавливается", { exact: true })).toHaveCount(0);
});

test("animation options persist per-kind speed and switches and drive actual morph duration", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/#/settings/appearance");
  const overall = page.getByRole("spinbutton", { name: "Animation speed", exact: true });
  await overall.fill("2");
  await overall.press("Tab");
  await page.getByRole("button", { name: "Animation settings", exact: true }).click();
  const options = page.getByRole("dialog", { name: "Animation settings", exact: true });
  const icons = options.getByRole("spinbutton", { name: "Icons: speed", exact: true });
  await icons.fill("0.5");
  await icons.press("Tab");
  await options.getByRole("switch", { name: "Buttons", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-button-animations", "false");
  await options.getByRole("button", { name: "Close", exact: true }).click();
  await page.goto("/#/instance/preview-1");
  const icon = page.locator('header[class*="header"]').first().locator("[data-morph-icon]");
  await expect(icon).toHaveCount(1);
  await page.evaluate(async () => {
    const { useAppStore } = await import("/src/stores/appStore.ts");
    const node = document.querySelector('header [data-morph-icon]')!;
    let start = 0;
    const observer = new MutationObserver(() => {
      if (node.hasAttribute("data-morphing")) start ||= performance.now();
      else if (start) { (window as any).morphElapsed = performance.now() - start; observer.disconnect(); }
    });
    observer.observe(node, { attributes: true, attributeFilter: ["data-morphing"] });
    useAppStore.setState(state => ({ bootstrap: { ...state.bootstrap!, instances: state.bootstrap!.instances.map(instance => instance.id === "preview-1" ? { ...instance, status: "running" } : instance) } }));
  });
  await expect.poll(() => page.evaluate(() => (window as any).morphElapsed ?? 0)).toBeGreaterThan(400);
  await page.goto("/#/settings/appearance");
  await expect(overall).toHaveValue("2");
  await page.getByRole("button", { name: "Animation settings", exact: true }).click();
  await expect(icons).toHaveValue("0.5");
  await expect(options.getByRole("switch", { name: "Buttons", exact: true })).toHaveAttribute("aria-checked", "false");
  await options.getByRole("switch", { name: "Icons", exact: true }).click();
  await expect(icons).toBeDisabled();
  await expect(page.locator("html")).toHaveAttribute("data-icon-animations", "false");
  await page.screenshot({ path: "artifacts/ui/animation-options.png" });
  await options.getByRole("button", { name: "Reset animations", exact: true }).click();
  await expect(icons).toHaveValue("1");
  await expect(icons).toBeEnabled();
});
