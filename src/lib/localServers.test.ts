import { expect, it } from "vitest";
import { defaultServerConfig, readServerProperties, withServerProperty } from "./localServers";

it("keeps form edits in the raw editor without removing unknown settings and comments", () => {
  const original = { ...defaultServerConfig(), propertiesText: "# personal settings\nmotd=Old\ncustom-plugin=true\ndifficulty=easy" };
  const next = withServerProperty(original, "motd", "New\\server\nline");
  expect(readServerProperties(next.propertiesText).motd).toBe("New\\server\nline");
  expect(next.properties.motd).toBe("New\\server\nline");
  expect(next.propertiesText).toContain("# personal settings");
  expect(next.propertiesText).toContain("custom-plugin=true");
  expect(readServerProperties(withServerProperty(next, "white-list", "true").propertiesText)["white-list"]).toBe("true");
  expect(original.propertiesText).toContain("motd=Old");
});
