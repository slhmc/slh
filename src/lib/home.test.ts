import { describe, expect, it } from "vitest";
import { defaultHomeSkin, lastLaunchedInstance } from "./home";
import type { Instance } from "./types";

const instance = (id: string, extra: Partial<Instance> = {}) => ({ id, name: id, lastPlayedAt: null, lastLaunchedAt: null, createdAt: "2099-01-01", ...extra } as Instance);
describe("beautiful home history and defaults", () => {
  it("does not mistake creation time for a launch", () => expect(lastLaunchedInstance([instance("new")])).toBeUndefined());
  it("includes Bedrock and prefers launch time to completion time", () => {
    const java = instance("java", { lastLaunchedAt: "2026-10-01T10:00:00Z", lastPlayedAt: "2026-10-01T15:00:00Z" });
    const bedrock = instance("bedrock", { loaderType: "bedrock", lastLaunchedAt: "2026-10-01T12:00:00Z" });
    expect(lastLaunchedInstance([java, bedrock])?.id).toBe("bedrock");
  });
  it("supports old history and removed builds", () => {
    expect(lastLaunchedInstance([instance("legacy", { lastPlayedAt: "2026-10-01" }), instance("new")])?.id).toBe("legacy");
    expect(lastLaunchedInstance([])).toBeUndefined();
  });
  it("uses a stable local default for dashed and undashed UUIDs", () => {
    expect(defaultHomeSkin("f0000000-0000-0000-0000-000000000001")).toEqual(defaultHomeSkin("f0000000000000000000000000000001"));
    expect(defaultHomeSkin("bad")).toEqual(defaultHomeSkin());
    expect(defaultHomeSkin("ffffffff-ffff-ffff-ffff-ffffffffffff").dataUrl).toBeTruthy();
  });
});
