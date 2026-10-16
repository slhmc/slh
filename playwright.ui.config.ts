import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

export default defineConfig({
  ...config,
  testDir: "./tests/ui",
  webServer: { ...config.webServer as object, reuseExistingServer: true },
});
