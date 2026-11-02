import { expect, test } from "@playwright/test";

test("switching instances clears the old server list and locks mutations", async ({ page }) => {
  await page.route("**/src/lib/tauri.ts*", async route => {
    const response = await route.fetch();
    const body = await response.text();
    const marker = 'if (name === "list_servers" || name === "add_server" || name === "remove_server") {';
    expect(body).toContain(marker);
    const replacement = `if (name === "list_servers") { if (args?.instanceId === "preview-2") await new Promise(resolve => setTimeout(resolve, 1800)); return [{ index: 0, name: args?.instanceId === "preview-2" ? "Second realm" : "First realm", address: "example.org", acceptTextures: null, hasIcon: false }]; }\n    if (name === "remove_server") { await new Promise(resolve => setTimeout(resolve, 800)); return []; }\n    ${marker}`;
    await route.fulfill({ response, body: body.replace(marker, replacement) });
  });
  await page.goto("/#/servers");
  const selector = page.getByRole("combobox", { name: "Minecraft instance" });
  await expect(page.getByText("First realm")).toBeVisible();
  await page.getByPlaceholder("Community server").fill("New");
  await page.getByPlaceholder("play.example.net:25565").fill("example.org");
  await selector.selectOption("preview-2");
  await expect(page.getByText("First realm")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add to servers.dat" })).toBeDisabled();
  await expect(page.getByText("Second realm")).toBeVisible();
  await page.getByRole("button", { name: "Remove Second realm" }).click();
  await expect(page.getByRole("dialog")).toContainText("Second realm");
  await expect(selector).toBeDisabled();
  for (const width of [800, 1440]) {
    await page.setViewportSize({ width, height: width === 800 ? 560 : 900 });
    await page.screenshot({ path: `artifacts/ui/network-server-dialog-${width}.png` });
  }
  await page.keyboard.press("Escape");
  await expect(selector).toBeEnabled();
  await expect(page.getByText("Second realm")).toBeVisible();
  await page.getByRole("button", { name: "Remove Second realm" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(selector).toBeDisabled();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Second realm")).toHaveCount(0);
  await expect(selector).toBeEnabled();
  await selector.selectOption("preview-1");
  await expect(page.getByText("First realm")).toBeVisible();
  await selector.selectOption("preview-2");
  await selector.selectOption("preview-1");
  await expect(page.getByText("First realm")).toBeVisible();
  await page.waitForTimeout(2000);
  await expect(page.getByText("Second realm")).toHaveCount(0);
});

