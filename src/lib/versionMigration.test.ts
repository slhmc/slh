import { describe, expect, it } from "vitest";
import type { VersionMigrationContent } from "./types";
import { migrationContentSelected, migrationIssues, migrationSelected, migrationUpdates, setMigrationRule } from "./versionMigration";

function file(path: string, updateStatus: VersionMigrationContent["updateStatus"], isDirectory = false): VersionMigrationContent {
  return {
    path, isDirectory, updateStatus,
    provider: updateStatus === "unknown" ? null : "modrinth",
    projectId: "project", projectType: path.startsWith("mods/") ? "mod" : "resourcepack",
    displayName: path, currentVersionId: "old", candidateVersion: null,
  };
}

const content = [
  file("mods/missing.jar", "incompatible"),
  file("mods/local.jar", "unknown"),
  file("mods/updatable.jar", "available"),
  file("resourcepacks/missing.zip", "incompatible"),
];
const copyRules = { mods: true, resourcepacks: true };

describe("build adaptation choices", () => {
  it("copies by default without update warnings or update requests", () => {
    expect(migrationIssues(content, copyRules, {})).toEqual([]);
    expect(migrationUpdates(content, copyRules, {})).toEqual([]);
  });

  it("only shows warnings for selected files with updating enabled", () => {
    const updates = { mods: true };
    expect(migrationIssues(content, copyRules, updates).map((item) => item.path))
      .toEqual(["mods/missing.jar", "mods/local.jar"]);
    expect(migrationUpdates(content, copyRules, updates).map((item) => item.path))
      .toEqual(["mods/updatable.jar"]);
    expect(migrationIssues(content, { ...copyRules, "mods/local.jar": false }, updates).map((item) => item.path))
      .toEqual(["mods/missing.jar"]);
  });

  it("removes a file warning when its updating switch is turned off", () => {
    const updates = setMigrationRule({ mods: true }, "mods/missing.jar", false);
    expect(migrationIssues(content, copyRules, updates).map((item) => item.path))
      .toEqual(["mods/local.jar"]);
    expect(migrationSelected("mods/missing.jar", copyRules)).toBe(true);
  });

  it("resets child overrides when a folder switch is changed", () => {
    const off = setMigrationRule({ mods: true, "mods/local.jar": false }, "mods", false);
    expect(off).toEqual({ mods: false });
    expect(migrationIssues(content, copyRules, off)).toEqual([]);
    expect(migrationIssues(content, copyRules, setMigrationRule(off, "mods", true))).toHaveLength(2);
  });

  it("allows a selected child inside an unchecked unpacked resource pack", () => {
    const pack = file("resourcepacks/local", "unknown", true);
    const selection = { resourcepacks: false, "resourcepacks/local/pack.mcmeta": true };
    expect(migrationContentSelected(pack, selection)).toBe(true);
    expect(migrationIssues([pack], selection, { resourcepacks: true })).toHaveLength(1);
    expect(migrationIssues([pack], selection, { resourcepacks: true, "resourcepacks/local": false })).toEqual([]);
  });
});
