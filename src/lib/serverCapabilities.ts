import type { ServerConfig } from "./localServers";

const javaCores = new Set(["vanilla", "fabric", "forge", "quilt", "neoforge", "paper", "purpur", "leaf", "spigot", "bukkit"]);
/** Unknown snapshots and custom runtimes need inspection rather than assumed parity. */
export function knownJavaRelease(config: Pick<ServerConfig, "core" | "minecraftVersion">) {
  const release = /^(\d+)\.\d+(?:\.\d+)?$/.exec(config.minecraftVersion);
  return javaCores.has(config.core) && !!release && (Number(release[1]) === 1 || Number(release[1]) >= 26);
}
export function releaseAtLeast(version: string, minor: number, patch = 0) {
  const parts = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(version);
  return !!parts && (Number(parts[1]) >= 26 || Number(parts[1]) === 1 && (Number(parts[2]) > minor || Number(parts[2]) === minor && Number(parts[3] ?? 0) >= patch));
}
export function supportsPlayerLists(config: Pick<ServerConfig, "core" | "minecraftVersion">, latestTemplate = false) {
  return javaCores.has(config.core) && (latestTemplate && !config.minecraftVersion || knownJavaRelease(config) && releaseAtLeast(config.minecraftVersion, 7, 6));
}
export function supportsLiveCommand(config: Pick<ServerConfig, "core" | "minecraftVersion">, kind: string) {
  if (!knownJavaRelease(config)) return false;
  if (kind === "save") return releaseAtLeast(config.minecraftVersion, 0);
  if (kind === "worldBorder") return releaseAtLeast(config.minecraftVersion, 8);
  if (kind === "idleTimeout") return releaseAtLeast(config.minecraftVersion, 7, 2);
  return releaseAtLeast(config.minecraftVersion, 4, 2);
}
