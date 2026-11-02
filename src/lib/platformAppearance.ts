import type { AppearanceSettings } from "./types";
export type DesktopPlatform = "windows" | "macos" | "linux";
export function desktopPlatform(platform = navigator.platform, userAgent = navigator.userAgent): DesktopPlatform {
  if (/Mac|iPhone|iPad/i.test(platform)) return "macos";
  if (/Linux|X11/i.test(platform + userAgent)) return "linux";
  return "windows";
}
export function windowAppearance(appearance: AppearanceSettings | undefined, enabled: boolean, platform: DesktopPlatform) {
  const style = enabled && appearance?.windowControlsStyle && appearance.windowControlsStyle !== "auto" ? appearance.windowControlsStyle : platform;
  const side = enabled && appearance?.windowControlsSide && appearance.windowControlsSide !== "auto" ? appearance.windowControlsSide : style === "macos" ? "left" : "right";
  return { style, side };
}
