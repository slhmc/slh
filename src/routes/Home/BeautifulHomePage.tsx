import { useUiText } from "../../i18n/UiText";
import { homeCharacterMode } from "../../lib/homeCharacterMode";
import { HomeDiscoverSearch } from "./HomeDiscoverSearch";
import { lazy, Suspense, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { Clock, Cube, DotsThreeVertical, FolderOpen, Palette, Play, SpinnerGap, Stack, X, UserCircle, WarningCircle, Wrench } from "../../components/icons";
import { HomeStatusPanel } from "../../components/account/HomeStatusPanel";
import launchStyles from "../../components/instance/InstanceSidePanel.module.css";
import { AccountAvatar } from "../../components/account/AccountAvatar";
import { DeferredAccountAppearanceDialog as AccountAppearanceDialog } from "../../components/account/DeferredAccountAppearanceDialog";
import { InstanceArtwork } from "../../components/instance/InstanceArtwork";
import { Dialog } from "../../components/common/Dialog";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n/I18nProvider";
import { command } from "../../lib/tauri";
import { lastLaunchedInstance } from "../../lib/home";
import { launchOrInstallInstance } from "../../lib/instanceLaunch";
import type { Account, BedrockRuntimeStatus, InstanceFileEntry, Instance } from "../../lib/types";
import common from "../../components/common/Common.module.css";
import styles from "./BeautifulHomePage.module.css";

const StaticHomeCharacter = lazy(() => import("../../components/account/StaticHomeCharacter").then(module => ({default:module.StaticHomeCharacter})));
const HomeCharacter = lazy(() => import("../../components/account/HomeCharacter").then((module) => ({ default: module.HomeCharacter })));

export function BeautifulHomePage() {
  const uiText = useUiText();
  const { tr, locale } = useI18n();
  const navigate = useNavigate();
  const bootstrap = useAppStore((state) => state.bootstrap);
  const operations = useAppStore((state) => state.instanceOperationIds);
  const openWizard = useAppStore((state) => state.setCreateWizardOpen);
  const openAccounts = useAppStore((state) => state.setAccountPopoverOpen);
  const selectInstance = useAppStore((state) => state.selectInstance);
  const refresh = useAppStore((state) => state.refresh);
  const pushToast = useAppStore((state) => state.pushToast);
  const begin = useAppStore((state) => state.beginInstanceOperation);
  const end = useAppStore((state) => state.endInstanceOperation);
  const [appearanceAccount, setAppearanceAccount] = useState<Account | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [modCount, setModCount] = useState<number | null>(null);
  const [offlineInstance, setOfflineInstance] = useState<Instance | null>(null);
  const [offlineName, setOfflineName] = useState("");
  const [setupInstance, setSetupInstance] = useState<Instance | null>(null);
  const [setupError, setSetupError] = useState("");
  const [setupBusy, setSetupBusy] = useState(false);
  const active = bootstrap?.accounts.find((account) => account.active) ?? null;
  const recent = lastLaunchedInstance(bootstrap?.instances ?? []);
  const instance = bootstrap?.instances.find((item) => item.id === choice) ?? recent;

  useEffect(() => {
    let alive = true;
    setModCount(null);
    if (instance && instance.loaderType !== "bedrock") {
      void command<InstanceFileEntry[]>("list_instance_files", { instanceId: instance.id, category: "mods" }).then((records) => {
        if (alive) setModCount(records.filter((record) => /\.jar(?:\.off)?$/i.test(record.name)).length);
      }).catch(() => undefined);
    }
    return () => { alive = false; };
  }, [instance?.id, instance?.loaderType]);

  if (!bootstrap) return null;
  const busy = Boolean(instance && (operations.includes(instance.id) || ["installing", "launching"].includes(instance.status)));
  const provider = active?.provider === "elyby" ? "Ely.by" : active?.provider === "microsoft" ? "Microsoft" : uiText("accounts.texts.offline", "Offline");
  const openInstance = (tab: string) => {
    if (!instance) return;
    selectInstance(instance.id); navigate(`/instance/${instance.id}?tab=${tab}`);
  };
  const launch = async (target: Instance, offlineUsername?: string) => {
    if (useAppStore.getState().instanceOperationIds.includes(target.id)) return;
    begin(target.id);
    try {
      const result = await launchOrInstallInstance(target, offlineUsername);
      setOfflineInstance(null);
      if (target.status === "installed") {
        setChoice(null);
        if (result.usedOfflineFallback) pushToast({ tone: "info", title: uiText("installation.texts.noInternetConnection", "No internet connection"), message: uiText("installation.texts.minecraftWasLaunchedWithATemporaryOfflineIdentity", "Minecraft was launched with a temporary offline identity.") });
        if (bootstrap.settings.console.openOnHomeLaunch === true) navigate(`/instance/${target.id}?tab=logs`);
      }
      await refresh();
    } catch (cause) {
      const error = cause as { code?: string; message?: string };
      if (error.code === "offline_account_name_required") { setOfflineName(active?.username ?? ""); setOfflineInstance(target); return; }
      const message = String(error.message ?? cause);
      if (target.loaderType === "bedrock" && /bedrock|gameinput|gaming services|microsoft store|xbox|license|wdapp|developer mode|windows package/i.test(message) && !/already running/i.test(message)) {
        setSetupInstance(target); setSetupError(message); return;
      }
      pushToast({ tone: "error", title: uiText("installation.texts.launchFailed", "Launch failed"), message });
    } finally { end(target.id); }
  };
  const stop = async (target: Instance) => {
    if (useAppStore.getState().instanceOperationIds.includes(target.id)) return;
    begin(target.id);
    try {
      await command("kill_instance", { instanceId: target.id });
      pushToast({ tone: "info", title: uiText("installation.texts.minecraftStopped", "Minecraft stopped"), message: `${target.name} ${uiText("installation.texts.wasStopped", "was stopped")}.` });
    } catch (cause) {
      pushToast({ tone: "error", title: uiText("installation.texts.stopFailed", "Stop failed"), message: String((cause as { message?: string }).message ?? cause) });
    } finally { try { await refresh(); } finally { end(target.id); } }
  };
  const prepareBedrock = async () => {
    if (!setupInstance || setupBusy) return;
    const target = setupInstance;
    setSetupBusy(true);
    try {
      const result = await command<BedrockRuntimeStatus>("prepare_bedrock_runtime", { instanceId: target.id });
      await refresh();
      if (result.launchReady) { setSetupInstance(null); await launch(target); }
      else setSetupError(result.message ?? uiText("home.texts.bedrockIsNotReady", "Bedrock is not ready"));
    } catch (cause) { setSetupError(String((cause as Error).message ?? cause)); }
    finally { setSetupBusy(false); }
  };
  const customize = () => {
    if (active?.provider === "microsoft") setAppearanceAccount(active);
    else if (active?.provider === "elyby") void openUrl("https://ely.by/skins");
    else pushToast({ tone: "info", title: uiText("home.texts.offlineSkin", "Offline skin"), message: uiText("home.texts.theStandardSkinIsSelectedByTheOfflineAccount", "The standard skin is selected by the offline account UUID.") });
  };
  const playedAt = instance?.lastLaunchedAt ?? instance?.lastPlayedAt;
  const days = playedAt ? Math.round((Date.parse(playedAt) - Date.now()) / 86400000) : null;

  return <div className={styles.home}>
    <aside className={styles.left}>
      <section className={styles.accountCard}>
        <AccountAvatar account={active} className={styles.avatar} />
        <div className={styles.accountDetails}><strong>{active?.username ?? uiText("home.texts.notSelected", "Not selected")}</strong><span><i className={active?.authStatus === "ready" ? styles.ready : styles.neutral} />{provider} · {active ? tr(active.authStatus === "ready" ? uiText("home.texts.ready", "Ready") : uiText("home.texts.authenticationRequired", "Authentication required")) : uiText("shell.texts.noAccount", "No account")}</span>
          <div className={styles.accountActions}><button className={common.secondaryButton} onClick={() => openAccounts(true)} type="button"><UserCircle size={15} />{uiText("home.texts.switchAccount", "Switch account")}</button><button className={common.iconButton} type="button" onClick={customize} title={uiText("home.texts.customizeSkin", "Customize skin")} aria-label={uiText("home.texts.customizeSkin", "Customize skin")}><Palette size={18} /></button></div></div>
        <button className={`${common.iconButton} ${styles.accountMenu}`} type="button" aria-label={uiText("shell.texts.manageAccounts", "Manage accounts")} onClick={() => navigate("/settings/accounts")}><DotsThreeVertical size={18} /></button>
      </section>
      <HomeStatusPanel />
    </aside>
    <section className={styles.character} aria-label={uiText("home.texts.playerCharacter", "Player character")}>
      <header><div><strong><UserCircle size={22} />{active?.username ?? uiText("accounts.texts.offline", "Offline")}</strong><small>{provider}{active ? ` · ${tr(active.authStatus === "ready" ? uiText("home.texts.ready", "Ready") : uiText("home.texts.authenticationRequired", "Authentication required"))}` : ""}</small></div></header>
      <div className={styles.stage}><Suspense fallback={<div className={styles.loading}><SpinnerGap size={24} /></div>}>{homeCharacterMode(bootstrap.settings.appearance.homeCharacterMode) === 2 ? <HomeCharacter account={active} frameRate={bootstrap.settings.appearance.homeCharacterFps} /> : homeCharacterMode(bootstrap.settings.appearance.homeCharacterMode) === 1 ? <StaticHomeCharacter account={active} /> : null}</Suspense></div>
    </section>
    <aside className={styles.right}>
      <section className={styles.discoverCard}>
        <h2>{uiText("navigation.discover", "Discover")}</h2>
        <HomeDiscoverSearch />
      </section>
      <section className={styles.lastBuild}>
        <header><h2>{tr(choice && instance?.id === choice ? uiText("home.texts.selectedBuild", "Selected build") : uiText("home.texts.lastLaunchedBuild", "Last launched build"))}</h2></header>
        {instance ? <>
          <div className={styles.buildInfo}><InstanceArtwork instance={instance} size="small" /><div><strong>{instance.name}</strong><small>{uiText("settings.minecraft", "Minecraft")}{" "}{instance.minecraftVersion} · {instance.loaderType === "bedrock" ? uiText("installation.texts.bedrock", "Bedrock") : instance.loaderType}</small><span><Clock size={14} />{days === null ? uiText("home.texts.notPlayed", "Not played") : new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day")}{modCount !== null ? <><Stack size={14} />{modCount} {uiText("home.texts.mods", "mods")}</> : null}</span></div>
            <details name="slh-action-menu" data-action-menu className={styles.buildMenu}><summary aria-label={uiText("home.texts.buildActions", "Build actions")}><DotsThreeVertical size={18} /></summary><div><button type="button" onClick={() => openInstance("overview")}><Cube size={16} />{uiText("home.texts.openBuild", "Open build")}</button><button type="button" onClick={() => openInstance("settings")}><Wrench size={16} />{uiText("navigation.settings", "Settings")}</button><button type="button" onClick={() => void openPath(instance.gameDir).catch((error) => pushToast({ tone: "error", title: uiText("common.folder", "Folder"), message: String(error) }))}><FolderOpen size={16} />{uiText("common.folder", "Folder")}</button></div></details>
          </div>
          <div className={instance.status === "running" ? styles.stopRow : styles.launchRow}><button className={instance.status === "running" ? `${launchStyles.playButton} ${launchStyles.killButton}` : undefined} type="button" disabled={busy} onClick={() => void (instance.status === "running" ? stop(instance) : launch(instance))}>{busy ? <SpinnerGap size={22} /> : instance.status === "running" ? <X size={20} weight="bold" /> : <Play size={23} />}{tr(instance.status === "running" ? uiText("installation.texts.kill", "Kill") : instance.status === "installed" ? uiText("common.play", "Play") : uiText("installation.texts.install", "Install"))}</button></div>
        </> : <div className={styles.empty}><p>{uiText("home.texts.chooseABuildForYourFirstLaunch", "Choose a build for your first launch.")}</p><select className={common.select} value="" onChange={(event) => setChoice(event.target.value)}><option value="">{uiText("home.texts.chooseABuild", "Choose a build")}</option>{bootstrap.instances.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button className={common.secondaryButton} type="button" onClick={() => openWizard(true)}>{uiText("titlebar.newInstance", "New instance")}</button></div>}
      </section>
    </aside>
    <AccountAppearanceDialog account={appearanceAccount} onClose={() => setAppearanceAccount(null)} onChanged={refresh} />
    <Dialog open={Boolean(offlineInstance)} title={uiText("common.texts.offlineUsername", "Offline username")} onClose={() => setOfflineInstance(null)} width="small"><form onSubmit={(event) => { event.preventDefault(); if (offlineInstance) void launch(offlineInstance, offlineName); }}><input className={common.input} value={offlineName} onChange={(event) => setOfflineName(event.target.value)} autoComplete="off" aria-label={uiText("common.texts.offlineUsername", "Offline username")} /><button className={common.button} type="submit" disabled={!offlineName.trim() || Boolean(offlineInstance && operations.includes(offlineInstance.id))}>{uiText("common.play", "Play")}</button></form></Dialog>
    <Dialog open={Boolean(setupInstance)} title={uiText("home.texts.prepareBedrock", "Prepare Bedrock")} onClose={() => { if (!setupBusy) setSetupInstance(null); }} width="medium"><p><WarningCircle size={17} /> {setupError}</p><button className={common.button} type="button" disabled={setupBusy} onClick={() => void prepareBedrock()}>{setupBusy ? <SpinnerGap size={17} /> : null}{uiText("home.texts.prepareBedrock", "Prepare Bedrock")}</button><button className={common.secondaryButton} type="button" disabled={setupBusy} onClick={() => { if (setupInstance) navigate(`/instance/${setupInstance.id}?tab=logs`); }}>{uiText("home.texts.openBuild", "Open build")}</button></Dialog>
  </div>;
}
