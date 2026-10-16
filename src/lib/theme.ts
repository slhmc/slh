import type { CSSProperties } from "react";
import type { AppearanceColors, AppearanceSettings } from "./types";

export function mixHex(a: string, b: string, ratio: number): string {
  return "#" + [1, 3, 5].map((offset) => Math.round(parseInt(a.slice(offset, offset + 2), 16) * ratio + parseInt(b.slice(offset, offset + 2), 16) * (1 - ratio)).toString(16).padStart(2, "0")).join("");
}
export function normalizeColors<T extends AppearanceColors>(value: T): T {
  return { ...value, success: value.success ?? mixHex(value.accentHover, value.text, .68), warning: value.warning ?? mixHex(value.accent, value.text, .78), error: value.error ?? mixHex(value.accentPressed, value.text, .70), info: value.info ?? mixHex(value.accentHover, value.text, .42) };
}
export function contrastRatio(a: string, b: string) {
  const luminance = (hex: string) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const first = luminance(a), second = luminance(b);
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
}
export function isLightColor(color: string): boolean { return contrastRatio(color, "#000000") > contrastRatio(color, "#ffffff"); }
function accentContrast(hex: string, dark: string, light: string) {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 > 165 ? dark : light;
}


export function buildTheme(appearance: AppearanceSettings, fontFamily: string): CSSProperties {
  return {
    "--color-bg": appearance.background,
    "--color-sidebar": `color-mix(in srgb, ${appearance.background} 86%, ${appearance.surface})`,
    "--color-surface": appearance.surface,
    "--color-surface-2": appearance.surface2,
    // A tertiary surface must remain a surface in dark themes. Mixing it with
    // white text made every secondary button unexpectedly grey.
    "--color-surface-3": `color-mix(in srgb, ${appearance.surface2} 68%, ${appearance.background})`,
    "--color-border": appearance.border,
    "--color-border-strong": `color-mix(in srgb, ${appearance.border} 64%, ${appearance.text})`,
    "--color-text": appearance.text,
    "--color-text-muted": appearance.textMuted,
    "--color-text-subtle": `color-mix(in srgb, ${appearance.textMuted} 68%, ${appearance.surface})`,
    "--color-accent": appearance.accent,
    "--color-accent-hover": appearance.accentHover,
    "--color-accent-pressed": appearance.accentPressed,
    "--color-accent-contrast": accentContrast(appearance.accent, appearance.background, appearance.text),
    "--color-focus": appearance.accentHover,
    "--color-on-surface": appearance.text,
    "--color-surface-deep": `color-mix(in srgb, ${appearance.background} 72%, ${appearance.surface})`,
    "--color-surface-deeper": `color-mix(in srgb, ${appearance.background} 84%, ${appearance.surface})`,
    "--color-surface-hover": `color-mix(in srgb, ${appearance.surface2} 78%, ${appearance.text})`,
    "--color-accent-soft": `color-mix(in srgb, ${appearance.accent} 16%, transparent)`,
    "--color-accent-border": `color-mix(in srgb, ${appearance.accent} 55%, ${appearance.border})`,
    // Status colors are derived from the active palette, so custom themes do
    // not fall back to unrelated fixed green/yellow/red UI colors.
    "--color-success": `color-mix(in srgb, ${appearance.success ?? mixHex(appearance.accentHover, appearance.text, .68)} 100%, transparent)`,
    "--color-warning": `color-mix(in srgb, ${appearance.warning ?? mixHex(appearance.accent, appearance.text, .78)} 100%, transparent)`,
    "--color-error": `color-mix(in srgb, ${appearance.error ?? mixHex(appearance.accentPressed, appearance.text, .70)} 100%, transparent)`,
    "--color-success-soft": `color-mix(in srgb, color-mix(in srgb, ${appearance.success ?? mixHex(appearance.accentHover, appearance.text, .68)} 100%, transparent) 15%, ${appearance.surface})`,
    "--color-warning-soft": `color-mix(in srgb, color-mix(in srgb, ${appearance.warning ?? mixHex(appearance.accent, appearance.text, .78)} 100%, transparent) 15%, ${appearance.surface})`,
    "--color-error-soft": `color-mix(in srgb, color-mix(in srgb, ${appearance.error ?? mixHex(appearance.accentPressed, appearance.text, .70)} 100%, transparent) 15%, ${appearance.surface})`,
    "--color-danger": `color-mix(in srgb, ${appearance.error ?? mixHex(appearance.accentPressed, appearance.text, .70)} 100%, transparent)`,
    "--color-link": `color-mix(in srgb, ${appearance.accentHover} 42%, ${appearance.text})`,
    "--color-overlay": `color-mix(in srgb, ${appearance.background} 68%, transparent)`,
    "--color-overlay-strong": `color-mix(in srgb, ${appearance.background} 86%, transparent)`,
    "--color-shadow": `color-mix(in srgb, ${appearance.background} 84%, transparent)`,
    "--color-highlight": `color-mix(in srgb, ${appearance.text} 12%, transparent)`,
    "--color-scrollbar": `color-mix(in srgb, ${appearance.border} 72%, ${appearance.text})`,
    "--shadow-panel": `0 16px 44px color-mix(in srgb, ${appearance.background} 28%, transparent)`,
    "--shadow-dialog": `0 28px 90px color-mix(in srgb, ${appearance.background} 52%, transparent)`,
    "--color-info": appearance.info ?? mixHex(appearance.accentHover, appearance.text, .42),
    "--color-info-soft": `color-mix(in srgb, ${appearance.info ?? appearance.accentHover} 15%, ${appearance.surface})`,
    "--radius-xs": `${Math.max(0, appearance.radius - 5)}px`,
    "--radius-sm": `${Math.max(0, appearance.radius - 3)}px`,
    "--radius-md": `${appearance.radius}px`,
    "--radius-lg": `${appearance.radius === 0 ? 0 : appearance.radius + 4}px`,
    "--control-height": appearance.density === "compact" ? "32px" : "38px",
    "--panel-padding": appearance.density === "compact" ? "12px" : "20px",
    "--font-ui": fontFamily,
    colorScheme: isLightColor(appearance.background) ? "light" : "dark",
  } as CSSProperties;
}
