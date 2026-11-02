import type { ProviderAvailability } from "./types";
export function providerMessage(provider: ProviderAvailability, t: (key: string) => string): string {
  const message = provider.message ?? "";
  if (provider.provider === "microsoft" && !provider.available && /not configured/i.test(message)) return t("audit.microsoftUnavailable");
  if (provider.provider === "elyby" && /2FA|authentication agent/i.test(message)) return t("audit.elybyHint");
  if (provider.provider === "modrinth" && /Public API/i.test(message)) return t("audit.modrinthHint");
  if (provider.provider === "curseforge" && /relay|Personal API key configured/i.test(message)) return t(/Personal API key configured/i.test(message) ? "audit.curseforgeDirect" : "audit.curseforgeRelay");
  return message;
}
