import { expect, it } from "vitest";
import { namespacedGameRules, serverGameRules } from "./serverLive";

it("uses explicit gamerule names for old releases, snapshots and new versions", () => {
  expect(namespacedGameRules("1.21.10")).toBe(false);
  expect(serverGameRules("1.21.10").find(rule => rule.key === "doFireTick")?.type).toBe("boolean");
  expect(serverGameRules("26.3").find(rule => rule.key === "doFireTick")).toMatchObject({ command: "minecraft:fire_spread_radius_around_player", type: "number" });
  expect(namespacedGameRules("25w43a")).toBe(false);
  for (const version of ["25w44a", "1.21.11", "1.21.11-pre1", "26.3"]) {
    const rules = serverGameRules(version);
    expect(rules.find(rule => rule.key === "doDaylightCycle")?.command).toBe("minecraft:advance_time");
    expect(rules.find(rule => rule.key === "keepInventory")?.command).toBe("minecraft:keep_inventory");
  }
  expect(serverGameRules("1.21.4").find(rule => rule.key === "keepInventory")?.command).toBe("keepInventory");
  expect(serverGameRules("1.21.4").some(rule => rule.key === "pvp")).toBe(false);
  expect(serverGameRules("1.16.5").some(rule => rule.key === "playersSleepingPercentage")).toBe(false);
});
