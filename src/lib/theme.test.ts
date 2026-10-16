import { describe, expect, it } from "vitest";
import { buildTheme, contrastRatio, normalizeColors } from "./theme";
import type { AppearanceSettings } from "./types";
const old: AppearanceSettings = { background: "#1f2226", surface: "#292d32", surface2: "#343a40", border: "#454c54", text: "#ffffff", textMuted: "#aeb6bf", accent: "#cd491e", accentHover: "#e15828", accentPressed: "#ae3916", radius: 10, density: "comfortable", scalePercent: 100, activePresetId: "custom", presets: [] };
describe("launcher theme", () => {
  it("preserves original custom colors and derives missing status colors", () => {
    const normalized = normalizeColors(old);
    expect(normalized.accent).toBe(old.accent);
    expect(normalized.success).toMatch(/^#[a-f0-9]{6}$/);
    expect(normalizeColors({ ...normalized, error: "#123456" }).error).toBe("#123456");
  });
  it("propagates status colors, radius and density to shared tokens", () => {
    const theme = buildTheme({ ...old, error: "#123456", density: "compact", radius: 0 }, "Test");
    expect(theme).toMatchObject({ "--radius-md": "0px", "--control-height": "32px", "--font-ui": "Test" });
    expect(theme["--color-error" as keyof typeof theme]).toContain("#123456");
    expect(theme["--color-error-soft" as keyof typeof theme]).toContain("#123456");
  });
  it("measures readability for light and dark palettes", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBe(21);
    expect(contrastRatio("#aaaaaa", "#aaaaaa")).toBe(1);
    expect(buildTheme({ ...old, background: "#ffffff", text: "#111111" }, "Test").colorScheme).toBe("light");
  });
});
