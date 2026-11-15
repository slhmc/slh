import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

// Run the audit's browser fixtures against an already running isolated preview.
export default defineConfig({
  ...config,
  testDir: "./tests",
  webServer: { ...config.webServer as object, reuseExistingServer: true },
});
