import { describe, expect, it } from "vitest";
import { formatPlaytime } from "./formatters";

const identity = (source: string) => source;

describe("formatPlaytime", () => {
  it("uses locale-aware units and keeps minutes visible", () => {
    expect(formatPlaytime(3 * 3600 + 14 * 60, "ru-RU", identity)).toBe("3 ч. 14 м. played");
    expect(formatPlaytime(3 * 3600 + 14 * 60, "de-DE", identity)).toBe("3 Std. 14 Min. played");
    expect(formatPlaytime(14 * 60, "en-US", identity)).toBe("14 m played");
  });

  it("uses the translated empty state", () => {
    expect(formatPlaytime(0, "ru-RU", () => "Нет данных")).toBe("Нет данных");
  });
});
