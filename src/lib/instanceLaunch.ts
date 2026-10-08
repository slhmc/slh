import { command } from "./tauri";
import type { Instance } from "./types";

/** One operation entry point for the instance page and quick launch. */
export function launchOrInstallInstance(instance: Instance, offlineUsername?: string) {
  return command<{ usedOfflineFallback?: boolean }>(instance.status === "installed" ? "launch_instance" : "install_instance", { instanceId: instance.id, offlineUsername });
}
