import { expect, test } from "@playwright/test";

test("portable shell and library navigation render in the required order", async ({ page }) => {
  await page.goto("/#/library");

  await expect(page.getByRole("heading", { name: "Your Minecraft worlds, separated and ready" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link")).toHaveText([
    "Home",
    "Library",
    "Discover",
  ]);
  await expect(page.getByText("No active downloads")).toBeVisible();
  await expect(page.getByAltText("Smile LauncHer logo")).toBeVisible();
  await page.getByRole("button", { name: "Actions for Latest release" }).click();
  await expect(page.getByRole("button", { name: "Open folder" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete" }).first()).toBeVisible();

  await page.getByRole("button", { name: "New instance" }).click();
  await expect(page.getByRole("heading", { name: "Choose Minecraft" })).toBeVisible();
  await expect(page.getByText("1.21.8", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Fetching version manifest")).toHaveCount(0);
});

test("Discover installs supported content and keeps CurseForge personal keys optional", async ({ page }) => {
  await page.goto("/#/discover");
  await expect(page.getByRole("heading", { name: "Fabulously Optimized" })).toBeVisible();
  await page.getByRole("button", { name: "Install", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Install Fabulously Optimized" })).toBeVisible();
  await expect(page.getByLabel("Instance name")).toHaveValue("Fabulously Optimized");
  await expect(page.getByRole("button", { name: "Download and install" })).toBeDisabled();
  await page.getByRole("button", { name: "Minecraft version", exact: true }).click();
  await page.getByRole("dialog").getByRole("option", { name: "1.21.7", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download and install" })).toBeEnabled();
  await page.getByRole("button", { name: "Close dialog" }).click();

  await page.goto("/#/discover?instance=preview-2&type=mod");
  await expect(page.getByRole("heading", { name: "Sodium" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fabulously Optimized" })).toHaveCount(0);
  await page.getByRole("button", { name: "Install", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Install Sodium" })).toBeVisible();
  await expect(page.getByText("files including dependencies")).toBeVisible();
  await expect(page.getByRole("button", { name: "Install verified files" })).toBeEnabled();
  await page.getByRole("button", { name: "Close dialog" }).click();

  await page.getByRole("button", { name: "Resource packs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Stay True" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Install", exact: true }).first()).toBeEnabled();

  await page.getByRole("button", { name: "Shaders", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Complementary Unbound" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Install", exact: true }).first()).toBeEnabled();

  await page.getByRole("button", { name: "CurseForge" }).click();
  await expect(page.getByRole("button", { name: "Resource packs", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Shaders", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Mods", exact: true })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Complementary Unbound" })).toBeVisible();

  await page.getByRole("button", { name: "Worlds", exact: true }).click();
  await expect(page.getByRole("button", { name: "Modrinth" })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "SkyBlock World" })).toBeVisible();
});

test("Appearance presets, instance deletion, and the WebView menu boundary are exposed", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/#/settings/appearance");
  await expect(page.getByRole("button", { name: /Graphite Orange/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Light Orange/ })).toBeVisible();
  await expect(page.getByPlaceholder("Preset name")).toBeVisible();

  const contextMenuAllowed = await page.evaluate(() => document.body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  expect(contextMenuAllowed).toBe(true);

  await page.goto("/#/instance/preview-1?tab=settings");
  await expect(page.getByRole("heading", { name: "Delete instance" })).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/#\/library$/);
  await expect(page.getByRole("heading", { name: "Your Minecraft worlds, separated and ready" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Actions for Latest release" })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("missing instance navigation preserves React hooks and recovers to the library", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/#/instance/preview-2?tab=settings");
  await expect(page.getByRole("heading", { name: "Name and artwork" })).toBeVisible();
  await page.evaluate(() => { window.location.hash = "/instance/missing-instance"; });
  await expect(page.getByRole("heading", { name: "Instance not found" })).toBeVisible();
  await page.getByRole("button", { name: "Back to Library" }).click();
  await expect(page.getByRole("heading", { name: "Your Minecraft worlds, separated and ready" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("Instance identity, content browsing, scale, and notifications are configurable", async ({ page }) => {
  await page.goto("/#/instance/preview-2?tab=settings");
  await expect(page.getByRole("heading", { name: "Name and artwork" })).toBeVisible();
  await expect(page.getByLabel("Instance name")).toHaveValue("Cobblemon expedition");
  await expect(page.getByRole("radio", { name: "Sword" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeEnabled();

  await page.goto("/#/instance/preview-2?tab=mods");
  await page.getByRole("button", { name: "Download mods", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mods", exact: true }).last()).toHaveClass(/active/);
  await expect(page.getByRole("heading", { name: "Sodium" })).toBeVisible();

  await page.goto("/#/settings/appearance");
  await expect(page.getByText("100%", { exact: true })).toBeVisible();
  await expect(page.getByRole("slider").first()).toHaveAttribute("min", "50");
  await expect(page.getByRole("slider").first()).toHaveAttribute("max", "200");

  await page.goto("/#/settings/notifications");
  await expect(page.getByText("Maximum visible", { exact: true })).toBeVisible();
  await expect(page.getByText("Display time", { exact: true })).toBeVisible();
});

test("Automatic shared sync and the Minecraft console are configurable", async ({ page }) => {
  await page.goto("/#/settings/sync");
  await expect(page.getByRole("option", { name: "Shared library" })).toBeAttached();
  await expect(page.getByText("All current and future instances", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable automatic sync" })).toBeEnabled();

  await page.goto("/#/settings/console");
  await expect(page.getByRole("heading", { name: "Console", exact: true })).toBeVisible();
  await expect(page.getByText("Open on launch", { exact: true })).toBeVisible();
  await expect(page.getByText("Example warning message", { exact: false })).toBeVisible();

  await page.goto("/#/instance/preview-2?tab=logs");
  await expect(page.getByText("Minecraft output will appear here when the game starts.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear view" })).toBeVisible();
});

test("Servers and diagnostics routes expose real controls and honest empty history", async ({ page }) => {
  await page.goto("/#/servers");
  await expect(page.getByRole("heading", { name: "Servers", exact: true })).toBeVisible();
  await expect(page.getByText("Local realm")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to servers.dat" })).toBeDisabled();

  await page.goto("/#/settings/storage");
  await expect(page.getByText("data in use")).toBeVisible();
  await expect(page.getByText("Runtime cache", { exact: true })).toBeVisible();

  await page.goto("/#/settings/downloads");
  await expect(page.getByText("Recent verified transfers")).toBeVisible();
  await expect(page.getByText("No queued or completed content downloads.")).toBeVisible();
  await expect(page.getByText("SLH relay", { exact: true })).toBeVisible();
  await expect(page.getByText("Available", { exact: true }).last()).toBeVisible();
  await expect(page.getByPlaceholder("Paste approved key locally")).toHaveAttribute("type", "password");
});
