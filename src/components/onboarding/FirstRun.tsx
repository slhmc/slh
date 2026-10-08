import { useState } from "react";
import { ArrowRight, ShieldCheck, SignIn, WarningCircle } from "../icons";
import { command } from "../../lib/tauri";
import { useAppStore } from "../../stores/appStore";
import { BrandLogo } from "../brand/BrandLogo";
import common from "../common/Common.module.css";
import styles from "./FirstRun.module.css";
import { useI18n } from "../../i18n/I18nProvider";

type View = "choice" | "warning" | "offline" | "elyby";
type SecondaryProvider = "offline" | "elyby";

export function FirstRun() {
  const bootstrap = useAppStore((state) => state.bootstrap);
  const refresh = useAppStore((state) => state.refresh);
  const pushToast = useAppStore((state) => state.pushToast);
  const { t, tr } = useI18n();
  const [view, setView] = useState<View>("choice");
  const [pendingProvider, setPendingProvider] = useState<SecondaryProvider>("offline");
  const [acceptedMicrosoftLater, setAcceptedMicrosoftLater] = useState(false);
  const [username, setUsername] = useState("");
  const [allowInvalidUsername, setAllowInvalidUsername] = useState(false);
  const [elyUsername, setElyUsername] = useState("");
  const [elyPassword, setElyPassword] = useState("");
  const [elyTotp, setElyTotp] = useState("");
  const [elyNeedsTotp, setElyNeedsTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [changingLanguage, setChangingLanguage] = useState(false);
  if (!bootstrap?.firstRun) return null;

  const microsoft = bootstrap.providers.find((provider) => provider.provider === "microsoft");
  const finish = async () => {
    await command("update_setting", { key: "onboarding", value: { completed: true } });
    await refresh();
  };
  const requestSecondaryProvider = (provider: SecondaryProvider) => {
    setPendingProvider(provider);
    // Consent is valid only for the current warning flow. Re-opening an
    // account form must always require an explicit confirmation and Continue.
    setAcceptedMicrosoftLater(false);
    setView("warning");
  };
  const backToChoice = () => {
    setAcceptedMicrosoftLater(false);
    setView("choice");
  };
  const continueToSecondaryProvider = () => {
    if (!acceptedMicrosoftLater) return;
    const provider = pendingProvider;
    // Do not retain the checkbox state after the warning has served its
    // purpose. Every later request starts with a fresh confirmation.
    setAcceptedMicrosoftLater(false);
    setView(provider);
  };
  const changeLanguage = async (language: string) => {
    if (language === bootstrap.settings.general.language) return;
    setChangingLanguage(true);
    try {
      await command("update_setting", { key: "general", value: { ...bootstrap.settings.general, language } });
      await refresh();
    } catch (error) {
      pushToast({ tone: "error", title: tr("Language could not be changed"), message: String((error as { message?: string }).message ?? error) });
    } finally { setChangingLanguage(false); }
  };
  const addOffline = async () => {
    setBusy(true);
    try {
      await command("create_offline_account", { request: { username, allowInvalidUsername } });
      await finish();
    } catch (error) {
      pushToast({ tone: "error", title: tr("Account could not be added"), message: String((error as { message?: string }).message ?? error) });
    } finally { setBusy(false); }
  };
  const loginElyBy = async () => {
    setBusy(true);
    try {
      await command("login_elyby", { request: { username: elyUsername, password: elyPassword, totp: elyTotp.trim() || null } });
      await finish();
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      if (failure.code === "two_factor_required") {
        setElyNeedsTotp(true);
        pushToast({ tone: "info", title: tr("Two-factor code required"), message: tr("Enter the current code, then try again.") });
      } else {
        pushToast({ tone: "error", title: tr("Ely.by sign-in failed"), message: String(failure.message ?? error) });
      }
    } finally { setBusy(false); }
  };
  const loginMicrosoft = async () => {
    setBusy(true);
    pushToast({ tone: "info", title: tr("Continue in your browser"), message: tr("Finish signing in in your browser.") });
    try {
      await command("login_microsoft");
      await finish();
    } catch (error) {
      pushToast({ tone: "error", title: tr("Microsoft sign-in failed"), message: String((error as { message?: string }).message ?? error) });
    } finally { setBusy(false); }
  };

  return <div className={styles.backdrop}>
    <section className={styles.panel} aria-label={tr("Welcome to Smile LauncHer")}>
      <div className={styles.artwork}><BrandLogo variant="icon" /><BrandLogo variant="wordmark" /><span>{tr("Minecraft, on your terms.")}</span></div>
      <div className={styles.content}>
        <div className={styles.security}><ShieldCheck size={19} weight="duotone" /><span>{tr("No telemetry, no ads, no cloud account requirement.")}</span></div>
        <h1>{tr("Welcome to Smile LauncHer")}</h1>
        <p>{tr("Build isolated Minecraft instances and keep every launcher-owned file in one place.")}</p>
        {view === "choice" || view === "warning" ? <div className={styles.actions}>
          <button className={`${common.button} ${styles.microsoftAction}`} type="button" onClick={() => void loginMicrosoft()} disabled={busy || !microsoft?.available} title={microsoft?.available ? undefined : tr("Microsoft client ID is not configured")}>
            <SignIn size={20} weight="bold" /><span><strong>{t("onboarding.continueMicrosoft", "Continue with Microsoft")}</strong><small>{t("onboarding.microsoftRecommendation", "Recommended for Minecraft: Java Edition")}</small></span><ArrowRight size={18} />
          </button>
          <div className={styles.secondaryActions}>
            <button className={common.secondaryButton} type="button" onClick={() => requestSecondaryProvider("elyby")} disabled={busy}>{t("onboarding.addElyBy", "Add Ely.by account")}</button>
            <button className={common.secondaryButton} type="button" onClick={() => requestSecondaryProvider("offline")} disabled={busy}>{t("onboarding.createOffline", "Create Offline account")}</button>
          </div>
          <label className={styles.languagePicker}><span>{t("settings.language", "Language")}</span><select className={common.select} value={bootstrap.settings.general.language} onChange={(event) => void changeLanguage(event.target.value)} disabled={busy || changingLanguage}>{bootstrap.locales.map((locale) => <option key={locale.code} value={locale.code}>{locale.name}</option>)}</select></label>
        </div> : null}
        {view === "offline" ? <form onSubmit={(event) => { event.preventDefault(); void addOffline(); }} className={styles.offlineForm}>
          <h2>{t("onboarding.createOffline", "Create Offline account")}</h2>
          <label className={common.field}><span className={common.label}>{tr("Offline username")}</span><input className={common.input} value={username} onChange={(event) => setUsername(event.target.value)} autoFocus placeholder={tr("Player name")} /><span className={common.hint}>{tr(allowInvalidUsername ? "Any nickname is accepted locally. Online-mode servers may reject this identity." : "3 to 16 letters, numbers, or underscores. Online-mode servers will reject this identity.")}</span></label>
          <label className={common.checkLabel}><input type="checkbox" checked={allowInvalidUsername} onChange={(event) => setAllowInvalidUsername(event.target.checked)} /> {tr("Allow invalid usernames")}</label>
          <div className={styles.formActions}><button className={common.ghostButton} type="button" onClick={backToChoice}>{tr("Back")}</button><button className={common.button} type="submit" disabled={busy || (allowInvalidUsername ? !username.trim() : username.trim().length < 3)}>{tr("Add and continue")} <ArrowRight size={16} /></button></div>
        </form> : null}
        {view === "elyby" ? <form onSubmit={(event) => { event.preventDefault(); void loginElyBy(); }} className={styles.offlineForm}>
          <h2>{t("onboarding.addElyBy", "Add Ely.by account")}</h2>
          <label className={common.field}><span className={common.label}>{tr("Username")}</span><input className={common.input} value={elyUsername} onChange={(event) => setElyUsername(event.target.value)} autoFocus autoComplete="username" /></label>
          <label className={common.field}><span className={common.label}>{tr("Password")}</span><input className={common.input} value={elyPassword} onChange={(event) => setElyPassword(event.target.value)} type="password" autoComplete="current-password" /></label>
          {elyNeedsTotp ? <label className={common.field}><span className={common.label}>{tr("Two-factor code")}</span><input className={common.input} value={elyTotp} onChange={(event) => setElyTotp(event.target.value)} inputMode="numeric" autoComplete="one-time-code" /></label> : null}
          <div className={styles.formActions}><button className={common.ghostButton} type="button" onClick={backToChoice}>{tr("Back")}</button><button className={common.button} type="submit" disabled={busy || !elyUsername.trim() || !elyPassword}>{tr("Add and continue")} <ArrowRight size={16} /></button></div>
        </form> : null}
      </div>
    </section>
    {view === "warning" ? <div className={styles.warningOverlay}>
      <section className={styles.warning} role="dialog" aria-modal="true" aria-labelledby="microsoft-warning-title">
        <div className={styles.warningHeading}><WarningCircle size={25} weight="fill" /><h2 id="microsoft-warning-title">{t("onboarding.microsoftRecommended", "Microsoft account recommended")}</h2></div>
        <p>{t("onboarding.warning", "Please sign in to Microsoft before adding an Offline or Ely.by account.")}</p>
        <label className={styles.commitment}><input type="checkbox" checked={acceptedMicrosoftLater} onChange={(event) => setAcceptedMicrosoftLater(event.target.checked)} /><span>{t("onboarding.commitment", "I commit to sign in to a Microsoft account later.")}</span></label>
        <div className={styles.formActions}><button className={common.ghostButton} type="button" onClick={backToChoice}>{tr("Back")}</button><button className={common.button} type="button" disabled={!acceptedMicrosoftLater} onClick={continueToSecondaryProvider}>{t("onboarding.continue", "Continue")} <ArrowRight size={16} /></button></div>
      </section>
    </div> : null}
  </div>;
}
