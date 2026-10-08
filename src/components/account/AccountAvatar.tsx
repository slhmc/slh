import { useEffect, useState } from "react";
import noAccountAvatar from "../../assets/NoAcc.png";
import type { Account } from "../../lib/types";
import { command } from "../../lib/tauri";
import styles from "./AccountAvatar.module.css";

export function AccountAvatar({ account, className = "" }: { account: Account | null; className?: string }) {
  const [skin, setSkin] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let retryTimer: number | undefined;
    let attempts = 0;

    const scheduleRetry = () => {
      if (!active || attempts >= 10) return;
      attempts += 1;
      retryTimer = window.setTimeout(() => void loadAvatar(), 800);
    };

    const loadAvatar = async () => {
      setSkin(null);
      if (!account || account.provider === "offline") return;
      try {
        const value = await command<string | null>("get_account_avatar", { accountId: account.id });
        if (!active) return;
        if (value) setSkin(value);
        else scheduleRetry();
      } catch {
        if (active) scheduleRetry();
      }
    };
    const refresh = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== account?.id) return;
      window.clearTimeout(retryTimer);
      attempts = 0;
      void loadAvatar();
    };
    void loadAvatar();
    window.addEventListener("slh-account-avatar-updated", refresh);
    return () => {
      active = false;
      window.clearTimeout(retryTimer);
      window.removeEventListener("slh-account-avatar-updated", refresh);
    };
  }, [account?.id, account?.provider]);

  return (
    <span className={`${styles.avatar} ${className}`} role="img" aria-label={account ? `${account.username} skin` : "No account selected"}>
      {!account || account.provider === "offline" ? (
        <img className={styles.offlineFallback} src={noAccountAvatar} alt="" aria-hidden="true" />
      ) : skin ? (
        <>
          <span className={styles.face} style={{ backgroundImage: `url(${skin})` }} />
          <span className={styles.hat} style={{ backgroundImage: `url(${skin})` }} />
        </>
      ) : (
        <svg className={styles.fallback} viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden="true">
          <path fill="var(--color-text-muted)" d="M3 1h2v1H3zM2 2h4v3H2zM1 6h6v2H1z" />
          <path fill="var(--color-text-subtle)" d="M3 3h2v2H3zM0 7h1v1H0zM7 7h1v1H7z" />
        </svg>
      )}
    </span>
  );
}
