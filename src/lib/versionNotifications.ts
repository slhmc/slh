import type { Instance, ToastParams } from "./types";

export type VersionNotificationAction = "installed" | "deleted";

export function versionNotification(instance: Instance, action: VersionNotificationAction) {
  const edition = instance.loaderType === "bedrock" ? "Bedrock" : "Java";
  const verb = action === "installed" ? "installed" : "deleted";
  const params: ToastParams = { edition, version: instance.minecraftVersion };

  return {
    tone: "success" as const,
    title: `Version {edition} {version} ${verb}`,
    message: "",
    params,
  };
}
