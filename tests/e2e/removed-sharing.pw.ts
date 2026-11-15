import { expect, test } from "@playwright/test";

for (const [width, height] of [[800, 560], [1440, 900]]) {
  test(`removed sharing stays absent with legacy settings at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.route("**/src/lib/tauri.ts*", async route => {
      const response = await route.fetch();
      const body = await response.text();
      const marker = "export async function command(name, args) {";
      expect(body).toContain(marker);
      await route.fulfill({ response, body: body.replace(marker, `${marker}
        if (/^(friends_|internet_sharing)/.test(name)) throw new Error("Removed networking command called");
        previewBootstrap.settings.general.internetSharing = true;
        previewBootstrap.settings.general.sharingP2p = true;
        previewBootstrap.settings.general.sharingUpnp = true;
        previewBootstrap.settings.general.navigationOrder = ["friends", "home", "library", "settings"];
        previewBootstrap.settings.general.visibleNavigation = ["friends", "home", "library", "settings"];
        previewBootstrap.settings.general.lastSection = "friends";
        if (!previewBootstrap.settings.general.settingsNavigationOrder.includes("internet")) {
          previewBootstrap.settings.general.settingsNavigationOrder.push("internet");
          previewBootstrap.settings.general.settingsNavigationVisible.push("internet");
        }
      `) });
    });
    await page.goto("/#/settings/internet");
    const general = page.getByRole("switch", { name: "Remember last section", exact: true });
    await expect(general).toBeVisible();
    await expect(page.getByRole("link", { name: "Play with friends", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Friends", exact: true })).toHaveCount(0);
    await expect(page.getByText(/P2P|UPnP|Join a friend/)).toHaveCount(0);
    await general.focus();
    await expect(general).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("settings-without-sharing.png") });
    await page.goto("/#/settings/servers");
    await expect(page.getByRole("heading", { name: "Servers", exact: true })).toBeVisible();
    await page.goto("/#/friends");
    await expect(page).toHaveURL(/#\/library$/);
    await expect(page.getByRole("button", { name: "Add friend", exact: true })).toHaveCount(0);
  });
}
