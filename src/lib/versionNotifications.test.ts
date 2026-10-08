import { describe, expect, it } from "vitest";
import type { Instance } from "./types";
import { versionNotification } from "./versionNotifications";

const instance = (loaderType: Instance["loaderType"]): Instance => ({
  id: "test-instance",
  name: "Test",
  groupId: null,
  iconPath: null,
  folderName: "test",
  iconKey: "grass",
  iconBackground: null,
  iconForeground: null,
  minecraftVersion: "1.18.12",
  loaderType,
  loaderVersion: null,
  status: "installed",
  createdAt: "2026-09-22T00:00:00Z",
  lastPlayedAt: null,
  playtimeSeconds: 0,
  javaPath: null,
  memoryMinMb: 512,
  memoryMaxMb: 4096,
  gameDir: "",
  configSchemaVersion: 1,
  bedrockProfileMode: "shared",
});

describe("versionNotification", () => {
  it("uses concise, parameterized install and delete text for Bedrock", () => {
    expect(versionNotification(instance("bedrock"), "installed")).toMatchObject({
      tone: "success",
      title: "Version {edition} {version} installed",
      message: "",
      params: { edition: "Bedrock", version: "1.18.12" },
    });
    expect(versionNotification(instance("bedrock"), "deleted").title).toBe(
      "Version {edition} {version} deleted",
    );
  });

  it("labels every Java loader as the Java edition", () => {
    expect(versionNotification(instance("fabric"), "installed").params).toEqual({
      edition: "Java",
      version: "1.18.12",
    });
  });
});
