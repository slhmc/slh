import { describe, expect, it } from "vitest";
import { moveInstanceOrder, orderedInstances } from "./instanceOrder";
import type { Instance } from "./types";
const instances = [{ id: "a", createdAt: "2026-01-01" }, { id: "b", createdAt: "2026-01-02" }, { id: "c", createdAt: "2026-01-03" }] as Instance[];
describe("instance order", () => {
  it("keeps a saved order and appends newly created instances", () => {
    expect(orderedInstances(instances, ["b", "a", "deleted"]).map(i => i.id)).toEqual(["b", "a", "c"]);
  });
  it("inserts on either side without losing other instances or mutating input", () => {
    expect(moveInstanceOrder(instances, undefined, "a", "b", true)).toEqual(["b", "a", "c"]);
    expect(moveInstanceOrder(instances, ["b", "a", "c"], "c", "a", false)).toEqual(["b", "c", "a"]);
    expect(instances.map(i => i.id)).toEqual(["a", "b", "c"]);
  });
});
