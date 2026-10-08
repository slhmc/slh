import { RequestCache } from "./requestCache";
import { defaultHomeSkin, type HomeSkin } from "./home";
import type { Account } from "./types";

export const homeSkinCache = new RequestCache<HomeSkin>(5 * 60_000, 20);
export const homeSkinKey = (account: Account) => `${account.provider}:${account.id}:${account.providerUuid}`;
export const initialHomeSkin = (account: Account | null) =>
  account && account.provider !== "offline"
    ? homeSkinCache.peek(homeSkinKey(account), true) ?? defaultHomeSkin(account.providerUuid)
    : defaultHomeSkin(account?.providerUuid);

export interface HomeView { scale: number; yaw?: number }
const key = "slh.home.character.view";
export function readHomeView(): HomeView {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return {
      scale: Number.isFinite(value?.scale) ? Math.max(.2, Math.min(1, value.scale)) : 1,
      yaw: Number.isFinite(value?.yaw) ? value.yaw : undefined,
    };
  } catch { return { scale: 1 }; }
}
export function saveHomeView(view: HomeView): void {
  try { localStorage.setItem(key, JSON.stringify(view)); } catch { /* Storage can be unavailable. */ }
}
