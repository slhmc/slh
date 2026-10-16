import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

export default defineConfig({
  ...config,
  use: { ...config.use, baseURL: "http://127.0.0.1:1421" },
  webServer: {
    command: "npm run preview -- --port 1421 --host 127.0.0.1",
    url: "http://127.0.0.1:1421",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
