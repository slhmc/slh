import { useEffect, useState } from "react";
import type { Account } from "./types";
import type { HomeSkin } from "./home";
import { command } from "./tauri";
import { homeSkinCache, homeSkinKey, initialHomeSkin } from "./homeCharacterState";

export function useHomeSkin(account: Account | null): HomeSkin {
  const [skin, setSkin] = useState<HomeSkin>(() => initialHomeSkin(account));
  useEffect(() => {
    let alive = true;
    const fallback = initialHomeSkin(account);
    let ticket = 0;
    setSkin(fallback);
    const load = async () => {
      const current = ++ticket;
      if (!account || account.provider === "offline") return;
      try {
        const result = await homeSkinCache.load(homeSkinKey(account), () => command<HomeSkin>("get_home_account_skin", { accountId: account.id }));
        if (alive && current === ticket && result.dataUrl) setSkin(result);
      } catch { /* The bundled default remains usable without a network. */ }
    };
    const refresh = (event: Event) => {
      if (account && (event as CustomEvent<string>).detail === account.id) {
        homeSkinCache.invalidate(homeSkinKey(account));
        void load();
      }
    };
    void load();
    window.addEventListener("slh-account-avatar-updated", refresh);
    return () => { alive = false; window.removeEventListener("slh-account-avatar-updated", refresh); };
  }, [account?.id, account?.provider, account?.providerUuid]);

  return skin;
}
