import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lowerColorMixes, type ColorMixRegistry } from "./src/lib/colorMix";
const paletteMixes: ColorMixRegistry = {};
function scanPalette(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) scanPalette(path);
    else if (entry.name.endsWith(".css")) lowerColorMixes(readFileSync(path, "utf8"), paletteMixes);
  }
}
scanPalette("src");

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  define: { __SLH_COLOR_MIXES__: JSON.stringify(paletteMixes) },
  css: { postcss: { plugins: [{ postcssPlugin: "slh-compatible-palette", Declaration(declaration: { value: string }) {
    declaration.value = lowerColorMixes(declaration.value, paletteMixes);
  } }] } },
  // Only the launcher is an entry point; vendored projects are reference sources.
  build: { target: ["es2021", "safari15"] },
  optimizeDeps: { entries: ["index.html"] },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**", "**/target/**", "**/artifacts/**", "**/release/**", "**/test-results/**"],
    },
  },
}));
