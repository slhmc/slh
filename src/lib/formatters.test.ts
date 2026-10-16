import { describe, expect, it } from "vitest";
import { formatBytes, formatPlaytime } from "./formatters";

const identity = (source: string) => source;

describe("formatPlaytime", () => {
  it("formats sizes with the selected language", () => {
    expect(formatBytes(1536, "de-DE")).toBe("1,5 kB");
    expect(formatBytes(1536, "en-US")).toBe("1.5 kB");
  });
  it("uses locale-aware units and keeps minutes visible", () => {
    expect(formatPlaytime(3 * 3600 + 14 * 60, "ru-RU", identity)).toBe("3 ч 14 мин played");
    expect(formatPlaytime(3 * 3600 + 14 * 60, "de-DE", identity)).toBe("3 Std. 14 Min. played");
    expect(formatPlaytime(14 * 60, "en-US", identity)).toBe("14 min played");
  });

  it("uses the translated empty state", () => {
    expect(formatPlaytime(0, "ru-RU", () => "Нет данных")).toBe("Нет данных");
  });
});
