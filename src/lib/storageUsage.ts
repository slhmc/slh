import { RequestCache } from "./requestCache";

export const storageUsageCache = new RequestCache<number>(60_000, 4);

/** Also invalidate while Home is unmounted; a later visit must see file changes. */
export function markStorageChanged(): void {
  storageUsageCache.clear();
  window.dispatchEvent(new Event("slh-storage-changed"));
}
