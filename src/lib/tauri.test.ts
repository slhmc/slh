import { describe, expect, it } from "vitest";
import { command, isTauri } from "./tauri";
import type { BootstrapData, MinecraftVersionSummary } from "./types";

describe("browser preview command boundary", () => {
  it("returns typed read-only preview data", async () => {
    expect(isTauri).toBe(false);
    const bootstrap = await command<BootstrapData>("get_bootstrap");
    const versions = await command<MinecraftVersionSummary[]>("list_minecraft_versions");
    expect(bootstrap.settings.privacy.telemetry).toBe(false);
    expect(versions.some((version) => version.versionType === "release")).toBe(true);
  });

  it("never pretends a desktop mutation succeeded", async () => {
    await expect(
      command("create_instance", {
        request: { name: "Preview mutation" },
      }),
    ).rejects.toMatchObject({ code: "desktop_backend_unavailable" });
  });
});
