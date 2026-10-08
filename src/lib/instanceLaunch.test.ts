import { beforeEach, expect, it, vi } from "vitest";
import { launchOrInstallInstance } from "./instanceLaunch";
import { command } from "./tauri";
import type { Instance } from "./types";
vi.mock("./tauri", () => ({ command: vi.fn().mockResolvedValue({}) }));
beforeEach(() => vi.clearAllMocks());
it.each(["fabric", "bedrock"])("uses the shared launch command for %s", async (loaderType) => {
  await launchOrInstallInstance({ id: "test", status: "installed", loaderType } as Instance, "OfflineUser");
  expect(command).toHaveBeenCalledWith("launch_instance", { instanceId: "test", offlineUsername: "OfflineUser" });
});
it("installs a build that has not been prepared", async () => {
  await launchOrInstallInstance({ id: "test", status: "created" } as Instance);
  expect(command).toHaveBeenCalledWith("install_instance", { instanceId: "test", offlineUsername: undefined });
});
