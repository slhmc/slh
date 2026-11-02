import { describe, expect, it } from "vitest";
import { lowerColorMixes, resolveColorMixes } from "./colorMix";
import { desktopPlatform, windowAppearance } from "./platformAppearance";
describe("portable palette and system chrome", () => {
  it("mixes translucent colors using premultiplied alpha and preserves shadow syntax", () => {
    expect(resolveColorMixes("0 2px 4px color-mix(in srgb, var(--shadow) 50%, transparent)", { "--shadow": "rgba(20, 40, 60, 0.8)" })).toBe("0 2px 4px rgba(20, 40, 60, 0.4)");
    expect(resolveColorMixes("color-mix(in srgb, color-mix(in srgb, #ff0000 50%, transparent) 50%, #0000ff)", {})).toBe("rgba(85, 0, 170, 0.75)");
  });
  it("uses the same dynamic token for repeated expressions and rejects invalid expressions", () => {
    const registry = {};
    const source = "color-mix(in srgb, var(--accent) 20%, transparent)";
    expect(lowerColorMixes(source, registry)).toBe(lowerColorMixes(source, registry));
    expect(Object.keys(registry)).toHaveLength(1);
    expect(resolveColorMixes(source, { "--accent": "#ff0000" })).toBe("rgba(255, 0, 0, 0.2)");
    expect(resolveColorMixes(source, { "--accent": "#0000ff" })).toBe("rgba(0, 0, 255, 0.2)");
    expect(() => lowerColorMixes("color-mix(", registry)).toThrow();
  });
  it("defaults to the host and ignores stored overrides when customization is disabled", () => {
    expect(desktopPlatform("MacIntel", "")).toBe("macos");
    expect(desktopPlatform("Linux x86_64", "")).toBe("linux");
    const appearance = { windowControlsStyle: "macos" as const, windowControlsSide: "right" as const };
    expect(windowAppearance(appearance as never, false, "windows")).toEqual({ style: "windows", side: "right" });
    expect(windowAppearance(undefined, false, "macos")).toEqual({ style: "macos", side: "left" });
    expect(windowAppearance(appearance as never, true, "windows")).toEqual({ style: "macos", side: "right" });
  });
});
