import { expect, it } from "vitest";
import { animationConfig, animationSpeed } from "./animationSettings";

it("inherits overall speed, allows per-kind overrides and preserves the master switch", () => {
  expect(animationConfig(undefined, "icons")).toEqual({ enabled: true, speed: 1 });
  const appearance = { animationSpeed: 2, animationSettings: { icons: { speed: 0.5 }, buttons: { enabled: false } } };
  expect(animationConfig(appearance, "icons")).toEqual({ enabled: true, speed: 0.5 });
  expect(animationConfig(appearance, "dialogs")).toEqual({ enabled: true, speed: 2 });
  expect(animationConfig(appearance, "buttons")).toEqual({ enabled: false, speed: 2 });
  expect(animationConfig({ ...appearance, iconMorphing: false }, "icons")).toEqual({ enabled: false, speed: 0.5 });
});
it("rejects invalid persisted speed values while retaining valid boundary values", () => {
  for (const value of [0, 0.09, 10.01, NaN, Infinity, "1", null]) expect(animationSpeed(value)).toBe(1);
  expect(animationSpeed(0.1)).toBe(0.1);
  expect(animationSpeed(10)).toBe(10);
});
