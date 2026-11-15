import { expect, test } from "@playwright/test";

for (const width of [800, 1440]) test(`creation lists, EULA and names at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 800 ? 560 : 900 });
  await page.goto("/#/local-servers");
  await page.getByRole("button", { name: "Create server", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create server", exact: true });
  const create = dialog.getByRole("button", { name: "Create server", exact: true });
  await expect(create).toBeDisabled();
  const eula = dialog.getByRole("checkbox", { name: /I accept the Minecraft EULA/ });
  await eula.check(); await expect(create).toBeEnabled(); await create.click();
  const name = dialog.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toBeFocused(); await expect(name).toHaveAttribute("aria-invalid", "true");
  await name.fill("Private world");
  await dialog.getByRole("tab", { name: "Players and access", exact: true }).click();
  await dialog.getByRole("switch", { name: "Whitelist", exact: true }).check();
  const player = dialog.getByRole("textbox", { name: "Player name", exact: true });
  for (const [kind, action, value] of [["Whitelist", "Add to whitelist", "Alex"], ["Administrators (OP)", "Add administrator", "Admin"], ["Banned players", "Ban player", "Griefer"], ["Banned IP addresses", "Ban IP address", "192.0.2.12"]]) {
    await dialog.getByRole("button", { name: kind, exact: true }).click();
    await (kind === "Banned IP addresses" ? dialog.getByRole("textbox", { name: "IP address", exact: true }) : player).fill(value);
    await dialog.getByRole("button", { name: action, exact: true }).click();
    await expect(dialog.getByRole("listitem")).toContainText(value);
  }
  await eula.scrollIntoViewIfNeeded();
  const difference = await eula.evaluate(node => {
    const label = node.parentElement!; const input = node.getBoundingClientRect(); const text = label.querySelector("span")!.getBoundingClientRect();
    return Math.abs(input.y + input.height / 2 - text.y - text.height / 2);
  });
  expect(difference).toBeLessThan(2);
  await page.screenshot({ path: `artifacts/ui/server-create-access-${width}.png` });
  await eula.uncheck(); await expect(create).toBeDisabled(); await eula.check();
  await expect(create).toBeEnabled(); await create.click();
  await expect(dialog).not.toBeVisible();
  const lists = await page.evaluate(() => JSON.parse(localStorage.getItem("slh.previewPlayerLists") ?? "{}"));
  expect(Object.values(lists).some((item: any) => item.bannedPlayers.some((row: any) => row.name === "Griefer") && item.operators.some((row: any) => row.name === "Admin"))).toBe(true);
});

test("defaults have both ban lists and preserve them after save", async ({ page }) => {
  await page.goto("/#/settings/servers");
  for (const [kind, action, value] of [["Banned players", "Ban player", "Griefer"], ["Banned IP addresses", "Ban IP address", "192.0.2.25"]]) {
    await page.getByRole("button", { name: kind, exact: true }).click();
    await page.getByRole("textbox", { name: kind === "Banned players" ? "Player name" : "IP address", exact: true }).fill(value);
    await page.getByRole("button", { name: action, exact: true }).click();
  }
  await page.getByRole("button", { name: "Save", exact: true }).click(); await page.reload();
  await page.getByRole("button", { name: "Banned players", exact: true }).click();
  await expect(page.getByRole("listitem")).toContainText("Griefer");
});

test("legacy versions do not offer JSON player edits or newer world commands", async ({ page }) => {
  await page.goto("/#/local-servers");
  const id = await page.evaluate(async () => {
    const { command } = await import("/src/lib/tauri.ts");
    const overview: any = await command("get_local_servers");
    const server = overview.servers[0];
    await command("update_local_server", { serverId: server.id, name: server.name, config: { ...server.config, core: "vanilla", minecraftVersion: "1.6.4" } });
    return server.id;
  });
  await page.goto(`/#/local-servers/${id}?tab=settings`);
  await expect(page.getByText(/Standard access lists require/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Whitelist", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "World commands", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "World border diameter", exact: true })).toBeDisabled();
});
