import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, GearSix, Plus, SignIn, UserCircle } from "../icons";
import { command } from "../../lib/tauri";
import type { Account } from "../../lib/types";
import { useAppStore } from "../../stores/appStore";
import common from "../common/Common.module.css";
import styles from "./AccountPopover.module.css";
import { AccountAvatar } from "../account/AccountAvatar";
import { orderedAccounts } from "../../lib/accountOrder";
import { useI18n } from "../../i18n/I18nProvider";
import { accountPopoverPosition } from "../../lib/accountPopoverPosition";

export function AccountPopover() {
  const open = useAppStore((state) => state.accountPopoverOpen);
  const setOpen = useAppStore((state) => state.setAccountPopoverOpen);
  const bootstrap = useAppStore((state) => state.bootstrap);
  const refresh = useAppStore((state) => state.refresh);
  const pushToast = useAppStore((state) => state.pushToast);
  const { tr } = useI18n();
  const [addingOffline, setAddingOffline] = useState(false);
  const [addingElyBy, setAddingElyBy] = useState(false);
  const [username, setUsername] = useState("");
  const [allowInvalidUsername, setAllowInvalidUsername] = useState(false);
  const [elyUsername, setElyUsername] = useState("");
  const [elyPassword, setElyPassword] = useState("");
  const [elyTotp, setElyTotp] = useState("");
  const [elyNeedsTotp, setElyNeedsTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const scrimRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const navigationPosition = bootstrap?.settings.general.navigationPosition ?? "left";
  const [placement, setPlacement] = useState<ReturnType<typeof accountPopoverPosition> | null>(null);
  const navigate = useNavigate();
  useLayoutEffect(() => {
    if (!open) { setPlacement(null); return; }
    const scrim = scrimRef.current;
    const popover = popoverRef.current;
    const anchor = document.querySelector<HTMLElement>("[data-account-popover-anchor]");
    if (!scrim || !popover || !anchor) return;
    const position = () => {
      const bounds = scrim.getBoundingClientRect();
      const rect = popover.getBoundingClientRect();
      // scrollHeight includes clipped contents when a form grows in a short window.
      const next = accountPopoverPosition(anchor.getBoundingClientRect(), bounds,
        { width: Math.min(350, bounds.width - 16), height: Math.max(rect.height, popover.scrollHeight) }, navigationPosition);
      setPlacement((current) => current && Object.keys(next).every((key) => current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next);
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(anchor); observer.observe(scrim); observer.observe(popover);
    window.addEventListener("resize", position);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); };
  }, [open, navigationPosition, bootstrap?.settings.appearance.scalePercent, addingOffline, addingElyBy, elyNeedsTotp, bootstrap?.accounts.length]);
  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [open, setOpen]);
  useEffect(() => {
    if (open) return;
    setElyPassword("");
    setElyTotp("");
    setElyNeedsTotp(false);
    setAddingElyBy(false);
  }, [open]);
  if (!open || !bootstrap) return null;

  const activate = async (account: Account) => {
    if (account.active) return;
    setBusy(true);
    try {
      await command("activate_account", { accountId: account.id });
      await refresh();
      setOpen(false);
    } catch (error) {
      pushToast({ tone: "error", title: tr("Account was not selected"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setBusy(false);
    }
  };

  const createOffline = async () => {
    setBusy(true);
    try {
      await command("create_offline_account", { request: { username, allowInvalidUsername } });
      await refresh();
      setUsername("");
      setAllowInvalidUsername(false);
      setAddingOffline(false);
      setOpen(false);
      pushToast({ tone: "success", title: tr("Offline account added"), message: tr("The new identity is now active.") });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Account could not be added"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setBusy(false);
    }
  };

  const loginElyBy = async () => {
    setBusy(true);
    try {
      await command("login_elyby", { request: { username: elyUsername, password: elyPassword, totp: elyTotp.trim() || null } });
      await refresh();
      setElyUsername("");
      setElyPassword("");
      setElyTotp("");
      setElyNeedsTotp(false);
      setAddingElyBy(false);
      setOpen(false);
      pushToast({ tone: "success", title: tr("Ely.by account added"), message: tr("Only a DPAPI-encrypted access token was saved; the password was discarded.") });
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      if (failure.code === "two_factor_required") {
        setElyNeedsTotp(true);
        pushToast({ tone: "info", title: tr("Two-factor code required"), message: tr("Enter the current code, then try again.") });
      } else {
        pushToast({ tone: "error", title: tr("Ely.by sign-in failed"), message: String(failure.message ?? error) });
      }
    } finally {
      setBusy(false);
    }
  };

  const loginMicrosoft = async () => {
    setBusy(true);
    pushToast({ tone: "info", title: tr("Continue in your browser"), message: tr("Finish signing in in your browser.") });
    try {
      await command("login_microsoft");
      await refresh();
      setOpen(false);
      pushToast({ tone: "success", title: tr("Microsoft account added"), message: tr("Minecraft profile verified. Refresh tokens are protected with Windows DPAPI.") });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Microsoft sign-in failed"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setBusy(false);
    }
  };

  const microsoft = bootstrap.providers.find((provider) => provider.provider === "microsoft");

  return (
    <div ref={scrimRef} className={styles.scrim} onMouseDown={() => setOpen(false)}>
      <section ref={popoverRef} className={styles.popover} style={placement ?? { visibility: "hidden" }} onMouseDown={(event) => event.stopPropagation()} aria-label={tr("Account switcher")}>
        <div className={styles.heading}>
          <div>
            <strong>{tr("Accounts")}</strong>
            <span data-minimal-text>{tr("Choose the identity used by Play")}</span>
          </div>
          <UserCircle size={24} weight="duotone" />
        </div>
        <div className={styles.accountList}>
          {bootstrap.accounts.length === 0 ? (
            <p className={styles.empty}>{tr("No accounts have been added.")}</p>
          ) : orderedAccounts(bootstrap.accounts, bootstrap.settings.general.accountOrder).map((account) => (
            <button key={account.id} type="button" className={styles.accountRow} onClick={() => void activate(account)} disabled={busy}>
              <AccountAvatar account={account} className={styles.avatar} />
              <span className={styles.accountText}>
                <strong>{account.username}</strong>
                <small data-minimal-text>{account.provider === "elyby" ? "Ely.by" : account.provider[0].toUpperCase() + account.provider.slice(1)}</small>
              </span>
              {account.active ? <Check size={18} weight="bold" aria-label={tr("Active account")} /> : null}
            </button>
          ))}
        </div>
        {addingOffline ? (
          <form className={styles.offlineForm} onSubmit={(event) => { event.preventDefault(); void createOffline(); }}>
            <label className={common.field}>
              <span className={common.label}>{tr("Offline username")}</span>
              <input className={common.input} value={username} onChange={(event) => setUsername(event.target.value)} placeholder={tr("Player name")} autoFocus />
              <span className={common.hint}>{tr(allowInvalidUsername ? "Any nickname is accepted locally. Online-mode servers may reject this identity." : "3 to 16 letters, numbers, or underscores. Online-mode servers will reject this identity.")}</span>
            </label>
            <label className={common.checkLabel}><input type="checkbox" checked={allowInvalidUsername} onChange={(event) => setAllowInvalidUsername(event.target.checked)} /> {tr("Allow invalid usernames")}</label>
            <div className={styles.formActions}>
              <button className={common.ghostButton} type="button" onClick={() => setAddingOffline(false)}>{tr("Cancel")}</button>
              <button className={common.button} type="submit" disabled={busy || (allowInvalidUsername ? !username.trim() : username.trim().length < 3)}>{tr("Add account")}</button>
            </div>
          </form>
        ) : addingElyBy ? (
          <form className={styles.offlineForm} onSubmit={(event) => { event.preventDefault(); void loginElyBy(); }}>
            <label className={common.field}><span className={common.label}>{tr("Ely.by username or email")}</span><input className={common.input} value={elyUsername} onChange={(event) => setElyUsername(event.target.value)} autoComplete="username" autoFocus /></label>
            <label className={common.field}><span className={common.label}>{tr("Password")}</span><input className={common.input} type="password" value={elyPassword} onChange={(event) => setElyPassword(event.target.value)} autoComplete="current-password" /><span className={common.hint}>{tr("Used only for this request and never written to disk.")}</span></label>
            {elyNeedsTotp ? <label className={common.field}><span className={common.label}>{tr("Two-factor code")}</span><input className={common.input} inputMode="numeric" pattern="[0-9]*" value={elyTotp} onChange={(event) => setElyTotp(event.target.value)} autoComplete="one-time-code" autoFocus /></label> : null}
            <div className={styles.formActions}><button className={common.ghostButton} type="button" onClick={() => { setAddingElyBy(false); setElyPassword(""); setElyTotp(""); }}>{tr("Cancel")}</button><button className={common.button} type="submit" disabled={busy || !elyUsername.trim() || !elyPassword || (elyNeedsTotp && !elyTotp.trim())}>{busy ? tr("Signing in") : tr("Sign in")}</button></div>
          </form>
        ) : (
          <div className={styles.addActions}>
            <button className={common.secondaryButton} type="button" data-minimal-compact aria-label="Offline" onClick={() => setAddingOffline(true)}>
              <Plus size={16} weight="bold" /><span data-minimal-text>Offline</span>
            </button>
            <button className={common.secondaryButton} type="button" data-minimal-compact aria-label="Microsoft" disabled={!microsoft?.available || busy} title={microsoft?.message ?? "Sign in with the system browser"} onClick={() => void loginMicrosoft()}>
              <SignIn size={16} weight="bold" /><span data-minimal-text>Microsoft</span>
            </button>
            <button className={common.secondaryButton} type="button" data-minimal-compact aria-label="Ely.by" onClick={() => setAddingElyBy(true)}>
              <SignIn size={16} weight="bold" /><span data-minimal-text>Ely.by</span>
            </button>
          </div>
        )}
        <button
          className={styles.manage}
          type="button"
          data-minimal-compact
          aria-label={tr("Manage accounts")}
          onClick={() => {
            setOpen(false);
            navigate("/settings/accounts");
          }}
        >
          <GearSix size={16} /><span data-minimal-text>{tr("Manage accounts")}</span>
        </button>
      </section>
    </div>
  );
}
