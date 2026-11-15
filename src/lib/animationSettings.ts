import type { AppearanceSettings } from "./types";

export const animationKinds = ["icons", "buttons", "switches", "dialogs"] as const;
export type AnimationKind = typeof animationKinds[number];
export function animationSpeed(value: unknown, fallback = 1): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.1 && value <= 10 ? value : fallback;
}
export function animationConfig(appearance: Partial<AppearanceSettings> | undefined, kind: AnimationKind) {
  const individual = appearance?.animationSettings?.[kind];
  return {
    enabled: appearance?.iconMorphing !== false && individual?.enabled !== false,
    speed: animationSpeed(individual?.speed, animationSpeed(appearance?.animationSpeed)),
  };
}
