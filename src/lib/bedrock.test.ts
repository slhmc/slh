import { expect, it } from "vitest";
import { bedrockContentVersion, bedrockPackageMatchesVersion } from "./bedrock";

it.each([
  ["1.20.31.1", "1.20.31"],
  ["1.21.80", "1.21.80"],
  ["26.51.01", "1.26.51"],
])("uses a game version rather than a Windows revision for %s", (version, tag) => {
  expect(bedrockContentVersion(version)).toBe(tag);
});

it("does not treat an unrelated installed Store package as this profile's runtime", () => {
  expect(bedrockPackageMatchesVersion("1.20.31.1", "1.26.6301.0")).toBe(false);
  expect(bedrockPackageMatchesVersion("1.20.31.1", "1.20.3101.0")).toBe(true);
  expect(bedrockPackageMatchesVersion("26.51.01", "1.26.5101.0")).toBe(true);
});
