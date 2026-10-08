import type { Instance } from "./types";
import steve from "../assets/skins/Steve.png?inline";
import alex from "../assets/skins/Alex.png?inline";
import sunny from "../assets/skins/Sunny.png?inline";
import noor from "../assets/skins/Noor.png?inline";
import efe from "../assets/skins/Efe.png?inline";
import ari from "../assets/skins/Ari.png?inline";
import kai from "../assets/skins/Kai.png?inline";
import makena from "../assets/skins/Makena.png?inline";
import zuri from "../assets/skins/Zuri.png?inline";

export interface HomeSkin { dataUrl: string | null; model: "classic" | "slim" }
const defaults: HomeSkin[] = [steve, alex, sunny, noor, efe, ari, kai, makena, zuri].map((dataUrl, index) => ({ dataUrl, model: index === 1 ? "slim" : "classic" }));

/** Java UUID.hashCode, followed by floorMod, stable across sessions and devices. */
export function defaultHomeSkin(uuid?: string): HomeSkin {
  const normalized = uuid?.replace(/-/g, "") ?? "";
  if (!/^[a-f\d]{32}$/i.test(normalized)) return defaults[0];
  let hash = 0;
  for (let index = 0; index < 32; index += 8) hash ^= Number.parseInt(normalized.slice(index, index + 8), 16);
  return defaults[((hash % defaults.length) + defaults.length) % defaults.length];
}

export function lastLaunchedInstance(instances: Instance[]): Instance | undefined {
  return instances.filter((instance) => instance.lastLaunchedAt || instance.lastPlayedAt)
    .sort((left, right) => Date.parse(right.lastLaunchedAt ?? right.lastPlayedAt!) - Date.parse(left.lastLaunchedAt ?? left.lastPlayedAt!))[0];
}

export const homeEmotes = ["wave", "pose", "victory", "dance", "look", "sneak", "run", "sad", "glide"] as const;
