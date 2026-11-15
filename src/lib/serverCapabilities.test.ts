import { expect, it } from "vitest";
import { knownJavaRelease, supportsLiveCommand, supportsPlayerLists } from "./serverCapabilities";
import { serverCores } from "./localServers";

it("gates JSON lists at the same release boundary for known Java cores", () => {
  for (const core of serverCores) {
    const known = !["custom", "horizon"].includes(core);
    expect(supportsPlayerLists({ core, minecraftVersion: "1.7.6" })).toBe(known);
    expect(supportsPlayerLists({ core, minecraftVersion: "1.7.5" })).toBe(false);
    expect(supportsPlayerLists({ core, minecraftVersion: "26.3" })).toBe(known);
    expect(supportsPlayerLists({ core, minecraftVersion: "" }, true)).toBe(known);
    expect(knownJavaRelease({ core, minecraftVersion: "25w44a" })).toBe(false);
  }
});
it("does not offer newer world commands to old releases or unknown runtimes", () => {
  const config = { core: "vanilla" as const, minecraftVersion: "1.7.6" };
  expect(supportsLiveCommand(config, "worldBorder")).toBe(false);
  expect(supportsLiveCommand(config, "idleTimeout")).toBe(true);
  expect(supportsLiveCommand({ ...config, minecraftVersion: "1.4.1" }, "difficulty")).toBe(false);
  expect(supportsLiveCommand({ ...config, minecraftVersion: "1.4.2" }, "difficulty")).toBe(true);
  expect(supportsLiveCommand({ ...config, core: "horizon" }, "save")).toBe(false);
});
