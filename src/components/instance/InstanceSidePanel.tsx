import { useUiText } from "../../i18n/UiText";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  Clock,
  FileText,
  FolderOpen,
  Export,
  Image,
  Play,
  PuzzlePiece,
  Stack,
  SpinnerGap,
  Trash,
  Wrench,
  Worlds,
  X,
} from "../icons";
import { command, revealInstancePath } from "../../lib/tauri";
import type { Instance, MinecraftVersionSummary } from "../../lib/types";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n/I18nProvider";
import common from "../common/Common.module.css";
import { InstanceArtwork } from "./InstanceArtwork";
import { Dialog } from "../common/Dialog";
import styles from "./InstanceSidePanel.module.css";
import { formatPlaytime } from "../../lib/formatters";
import { bedrockToastAction } from "../../lib/bedrock";

interface InstanceSidePanelProps {
  instance: Instance;
  onDelete?: () => void;
  onContextMenu?: (event: { preventDefault: () => void; clientX: number; clientY: number }) => void;
}

export function InstanceSidePanel({ instance, onDelete, onContextMenu }: InstanceSidePanelProps) {
  const uiText = useUiText();
  const [busy, setBusy] = useState(false);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [offlineNameDialogOpen, setOfflineNameDialogOpen] = useState(false);
  const [offlineName, setOfflineName] = useState("");
  const [storeDialogOpen, setStoreDialogOpen] = useState(false);
  const [storeVersions, setStoreVersions] = useState<MinecraftVersionSummary[]>([]);
  const [storeLookupBusy, setStoreLookupBusy] = useState(false);
  const refresh = useAppStore((state) => state.refresh);
  const pushToast = useAppStore((state) => state.pushToast);
  const instanceOperationIds = useAppStore((state) => state.instanceOperationIds);
  const beginInstanceOperation = useAppStore((state) => state.beginInstanceOperation);
  const endInstanceOperation = useAppStore((state) => state.endInstanceOperation);
  const navigate = useNavigate();
  const { locale, tr } = useI18n();
  const bootstrap = useAppStore((state) => state.bootstrap);
  const rawPanelOptions = bootstrap?.settings.general.instancePanel;
  const defaultActionOrder = ["mods", "worlds", "screenshots", "folder", "logs", "settings", "group", "export", "delete"];
  const normalizedActionOrder = [...new Set((rawPanelOptions?.actionOrder?.length ? rawPanelOptions.actionOrder : defaultActionOrder).map((id) => id === "shortcut" ? "delete" : id))];
  if (instance.loaderType === "bedrock" && !normalizedActionOrder.includes("resourcepacks")) normalizedActionOrder.splice(normalizedActionOrder.indexOf("mods") + 1, 0, "resourcepacks");
  if (!normalizedActionOrder.includes("delete")) normalizedActionOrder.push("delete");
  const panelOptions = {
    showArtwork: rawPanelOptions?.showArtwork ?? true,
    showMetadata: rawPanelOptions?.showMetadata ?? true,
    hiddenActions: (rawPanelOptions?.hiddenActions ?? []).map((id) => id === "shortcut" ? "delete" : id),
    actionOrder: normalizedActionOrder,
  };
  const installable = instance.status === "created" || instance.status === "error";
  const operationActive = instanceOperationIds.includes(instance.id);
  const openBedrockStorePicker = async () => {
    if (storeLookupBusy || operationActive) return;
    setStoreLookupBusy(true);
    try {
      const versions = await command<MinecraftVersionSummary[]>("list_bedrock_versions");
      const installed = versions.filter((version) => version.installMethod === "registered_store");
      if (installed.length === 0) {
        await command("open_bedrock_store");
        pushToast({
          tone: "info",
          title: uiText("installation.texts.openMicrosoftStore", "Open Microsoft Store"),
          message: uiText("installation.texts.installMinecraftFromMicrosoftStore", "Install Minecraft from Microsoft Store."),
        });
        return;
      }
      if (installed.some((version) => version.id === instance.minecraftVersion)) {
        await play();
        return;
      }
      setStoreVersions(installed);
      setStoreDialogOpen(true);
    } catch (error) {
      pushToast({
        tone: "error",
        title: uiText("installation.texts.microsoftStoreVersionsCouldNotBeLoaded", "Microsoft Store versions could not be loaded"),
        message: String((error as { message?: string }).message ?? error),
      });
    } finally {
      setStoreLookupBusy(false);
    }
  };
  const useStoreVersion = async (version: MinecraftVersionSummary) => {
  const uiText = useUiText();
    setStoreDialogOpen(false);
    try {
      await command<Instance>("update_instance", {
        request: {
          instanceId: instance.id,
          name: instance.name,
          iconKey: instance.iconKey,
          iconBackground: instance.iconBackground ?? "#3f493c",
          iconForeground: instance.iconForeground ?? "#f0f4ed",
          memoryMinMb: instance.memoryMinMb,
          memoryMaxMb: instance.memoryMaxMb,
          minecraftVersion: version.id,
          loaderType: "bedrock",
          loaderVersion: null,
          bedrockProfileMode: "shared",
        },
      });
      await refresh();
      await play();
    } catch (error) {
      pushToast({
        tone: "error",
        title: uiText("installation.texts.storeVersionCouldNotBeSelected", "Store version could not be selected"),
        message: String((error as { message?: string }).message ?? error),
      });
      await refresh();
    }
  };
  const play = async (offlineUsername?: string) => {
    if (operationActive) return;
    setBusy(true);
    beginInstanceOperation(instance.id);
    try {
      if (installable) {
        await command("install_instance", {
          instanceId: instance.id,
        });
      } else {
        const result = await command<{ usedOfflineFallback?: boolean }>("launch_instance", { instanceId: instance.id, offlineUsername });
        if (result.usedOfflineFallback) {
          pushToast({ tone: "error", title: uiText("installation.texts.noInternetConnection", "No internet connection"), message: uiText("installation.texts.minecraftWasLaunchedWithATemporaryOfflineIdentity", "Minecraft was launched with a temporary offline identity.") });
        } else {
          pushToast({ tone: "success", title: uiText("installation.texts.minecraftStarted", "Minecraft started"), message: `${instance.name} ${uiText("installation.texts.isRunning", "is running.")}` });
        }
      }
      await refresh();
    } catch (error) {
      const commandError = error as { code?: string; message?: string };
      if (!installable && commandError.code === "offline_account_name_required") {
        setOfflineName(bootstrap?.accounts.find((account) => account.active)?.username ?? "");
        setOfflineNameDialogOpen(true);
        return;
      }
      const message = String((error as { message?: string }).message ?? error);
      pushToast({
        tone: "error",
        title: installable ? uiText("common.texts.installationFailed", "Installation failed") : uiText("installation.texts.launchFailed", "Launch failed"),
        message,
        action: bedrockToastAction(tr, message),
      });
      await refresh();
    } finally {
      setBusy(false);
      endInstanceOperation(instance.id);
    }
  };
  const kill = async () => {
    setBusy(true);
    try {
      await command("kill_instance", { instanceId: instance.id });
      pushToast({ tone: "info", title: uiText("installation.texts.minecraftStopped", "Minecraft stopped"), message: `${instance.name} ${uiText("installation.texts.wasStopped", "was stopped")}.` });
      await refresh();
    } catch (error) {
      pushToast({ tone: "error", title: uiText("installation.texts.stopFailed", "Stop failed"), message: String((error as { message?: string }).message ?? error) });
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const assignGroup = async (groupId: string | null) => {
    try {
      await command("assign_instance_group", { request: { instanceId: instance.id, groupId } });
      await refresh();
      setGroupDialogOpen(false);
    } catch (error) {
      pushToast({ tone: "error", title: uiText("installation.texts.groupWasNotUpdated", "Group was not updated"), message: String((error as { message?: string }).message ?? error) });
    }
  };
  const actionButtons: Record<string, ReactNode> = {
    mods: <button type="button" data-minimal-compact aria-label={tr(instance.loaderType === "bedrock" ? uiText("installation.texts.addOns", "Add-ons") : uiText("navigation.mods", "Mods"))} onClick={() => navigate(`/instance/${instance.id}?tab=mods`)}><PuzzlePiece size={19} /><span data-minimal-text>{tr(instance.loaderType === "bedrock" ? uiText("installation.texts.addOns", "Add-ons") : uiText("navigation.mods", "Mods"))}</span></button>,
    resourcepacks: instance.loaderType === "bedrock" ? <button type="button" data-minimal-compact aria-label={uiText("installation.texts.resourcePacks", "Resource packs")} onClick={() => navigate(`/instance/${instance.id}?tab=resourcepacks`)}><Stack size={19} /><span data-minimal-text>{uiText("installation.texts.resourcePacks", "Resource packs")}</span></button> : null,
    worlds: <button type="button" data-minimal-compact aria-label={uiText("installation.texts.worlds", "Worlds")} onClick={() => navigate(`/instance/${instance.id}?tab=worlds`)}><Worlds size={19} /><span data-minimal-text>{uiText("installation.texts.worlds", "Worlds")}</span></button>,
    screenshots: instance.loaderType === "bedrock" ? null : <button type="button" data-minimal-compact aria-label={uiText("installation.texts.screenshots", "Screenshots")} onClick={() => navigate(`/instance/${instance.id}?tab=screenshots`)}><Image size={19} /><span data-minimal-text>{uiText("installation.texts.screenshots", "Screenshots")}</span></button>,
    folder: <button type="button" data-minimal-compact aria-label={uiText("common.folder", "Folder")} onClick={() => void revealInstancePath(instance.id, instance.gameDir).catch((error) => pushToast({ tone: "error", title: uiText("installation.texts.folderCouldNotBeOpened", "Folder could not be opened"), message: String((error as { message?: string }).message ?? error) }))}><FolderOpen size={19} /><span data-minimal-text>{uiText("common.folder", "Folder")}</span></button>,
    logs: <button type="button" data-minimal-compact aria-label={uiText("installation.texts.logs", "Logs")} onClick={() => navigate(`/instance/${instance.id}?tab=logs`)}><FileText size={19} /><span data-minimal-text>{uiText("installation.texts.logs", "Logs")}</span></button>,
    settings: <button type="button" data-minimal-compact aria-label={uiText("navigation.settings", "Settings")} onClick={() => navigate(`/instance/${instance.id}?tab=settings`)}><Wrench size={19} /><span data-minimal-text>{uiText("navigation.settings", "Settings")}</span></button>,
    group: <button type="button" data-minimal-compact aria-label={uiText("library.group", "Group")} onClick={() => setGroupDialogOpen(true)}><Stack size={19} /><span data-minimal-text>{uiText("library.group", "Group")}</span></button>,
    export: <button type="button" data-minimal-compact aria-label={uiText("installation.texts.export", "Export")} onClick={() => navigate(`/instance/${instance.id}?tab=settings&export=1`)}><Export size={19} /><span data-minimal-text>{uiText("installation.texts.export", "Export")}</span></button>,
    delete: <button className={styles.deleteAction} type="button" data-minimal-compact aria-label={uiText("installation.texts.deleteInstance", "Delete instance")} disabled={!onDelete || operationActive || busy || instance.status === "running" || instance.status === "installing" || instance.status === "launching"} onClick={() => onDelete?.()}><Trash size={19} /><span data-minimal-text>{uiText("installation.texts.deleteInstance", "Delete instance")}</span></button>,
  };
  const actionOrder = panelOptions.actionOrder?.length ? panelOptions.actionOrder : Object.keys(actionButtons);

  return (
    <aside
      className={styles.panel}
      data-slh-context-menu="true" onContextMenu={(event) => { event.preventDefault(); onContextMenu?.(event); }}
      onPointerDown={(event) => {
        if (event.button === 2) { event.preventDefault(); onContextMenu?.(event); }
      }}
    >
      <div className={styles.scroll}>
        {panelOptions.showArtwork ? <InstanceArtwork instance={instance} size="large" /> : null}
        <div className={styles.identity}>
          <h2>{instance.name}</h2>
          <p data-minimal-text>{uiText("settings.minecraft", "Minecraft")}{" "}{instance.minecraftVersion} · {instance.loaderType === "neoforge" ? "NeoForge" : instance.loaderType === "bedrock" ? uiText("installation.texts.bedrock", "Bedrock") : instance.loaderType}</p>
        </div>
        <button
          type="button"
          className={`${styles.playButton} ${instance.status === "running" ? styles.killButton : ""}`}
          disabled={busy || storeLookupBusy || operationActive || instance.status === "installing" || instance.status === "launching" || (instance.loaderType === "bedrock" && bootstrap?.settings.bedrock.enabled === false && instance.status !== "running")}
          title={instance.loaderType === "bedrock" && bootstrap?.settings.bedrock.enabled === false ? uiText("installation.texts.enableBedrockInSettingsFirst", "Enable Bedrock in Settings first") : undefined}
          onClick={() => void (instance.status === "running" ? kill() : play())}
        >
          {busy || storeLookupBusy || operationActive || instance.status === "installing" || instance.status === "launching" ? <SpinnerGap className={styles.spin} size={20} weight="bold" /> : instance.status === "running" ? <X size={20} weight="bold" /> : <Play size={20} weight="fill" />}
          {instance.status === "running" ? uiText("installation.texts.kill", "Kill") : instance.status === "launching" ? uiText("installation.texts.launching", "Launching") : instance.status === "installing" ? uiText("installation.texts.installing", "Installing") : storeLookupBusy ? uiText("installation.texts.checkingMicrosoftStore", "Checking Microsoft Store") : installable ? tr(instance.status === "error" ? "Retry installation" : uiText("installation.texts.install", "Install")) : uiText("common.play", "Play")}
        </button>
        {instance.loaderType === "bedrock" && installable ? <button className={common.secondaryButton} type="button" disabled={busy || storeLookupBusy || operationActive} onClick={() => void openBedrockStorePicker()}>{uiText("installation.texts.useStoreVersion", "Use Store version")}</button> : null}
        <div className={styles.quickGrid}>
          {actionOrder.filter((id) => !panelOptions.hiddenActions.includes(id) && actionButtons[id]).map((id) => <span key={id}>{actionButtons[id]}</span>)}
        </div>
        {panelOptions.showMetadata ? <div className={styles.metadata}>
          <div><Clock size={16} /><span>{formatPlaytime(instance.playtimeSeconds, locale, tr)}</span></div>
          <div><span>{uiText("installation.texts.status", "Status")}</span><span className={instance.status === "error" ? common.errorBadge : instance.status === "installed" ? common.successBadge : common.badge}>{tr(instance.status)}</span></div>
          {instance.loaderType === "bedrock" ? <><div><span>{uiText("installation.texts.bedrockVersion", "Bedrock version")}</span><strong>{instance.minecraftVersion}</strong></div><div><span>{uiText("installation.texts.profile", "Profile")}</span><strong>{tr(instance.bedrockProfileMode === "isolated" ? uiText("installation.texts.isolatedProfile", "Isolated profile") : uiText("installation.texts.sharedStoreData", "Shared Store data"))}</strong></div></> : <><div><span>{uiText("installation.texts.memory", "Memory")}</span><strong>{instance.memoryMaxMb / 1024}{" "}{uiText("installation.texts.gb", "GB")}</strong></div><div><span>{uiText("library.loader", "Loader")}</span><strong>{instance.loaderVersion ?? instance.loaderType}</strong></div></>}
        </div> : null}
      </div>
      <Dialog open={groupDialogOpen} title={uiText("installation.texts.assignGroup", "Assign group")} description={uiText("installation.texts.chooseWhereThisInstanceAppearsInTheLibrary", "Choose where this instance appears in the library.")} onClose={() => setGroupDialogOpen(false)} width="small">
        <div className={styles.groupDialog}>
          <button className={instance.groupId === null ? common.button : common.secondaryButton} type="button" onClick={() => void assignGroup(null)}>{uiText("library.ungrouped", "Ungrouped")}</button>
          {bootstrap?.groups.map((group) => <button key={group.id} className={instance.groupId === group.id ? common.button : common.secondaryButton} type="button" onClick={() => void assignGroup(group.id)}>{group.name}</button>)}
        </div>
      </Dialog>
      <Dialog open={offlineNameDialogOpen} title={uiText("installation.texts.offlineLaunch", "Offline launch")} description={uiText("installation.texts.noInternetConnectionIsAvailableTheSelectedOnlineAccount", "No internet connection is available. The selected online account will remain selected; this launch uses a temporary offline identity only.")} onClose={() => setOfflineNameDialogOpen(false)} width="small">
        <form className={styles.offlineLaunchForm} onSubmit={(event) => {
          event.preventDefault();
          const username = offlineName.trim();
          if (!username) return;
          setOfflineNameDialogOpen(false);
          void play(username);
        }}>
          <label><span>{uiText("installation.texts.minecraftNickname", "Minecraft nickname")}</span><input className={common.input} autoFocus maxLength={16} value={offlineName} onChange={(event) => setOfflineName(event.target.value)} placeholder={uiText("installation.texts.player", "Player")} /></label>
          <small>{uiText("installation.texts.use316LatinLettersNumbersOrUnderscores", "Use 3–16 Latin letters, numbers, or underscores.")}</small>
          <div><button className={common.secondaryButton} type="button" onClick={() => setOfflineNameDialogOpen(false)}>{uiText("common.cancel", "Cancel")}</button><button className={common.button} type="submit" disabled={!offlineName.trim()}><Play size={16} /> {uiText("installation.texts.launchOffline", "Launch offline")}</button></div>
        </form>
      </Dialog>
      <Dialog open={storeDialogOpen} title={uiText("installation.texts.selectInstalledStoreVersion", "Select installed Store version")} description={uiText("installation.texts.chooseAVersionAlreadyInstalledByMicrosoftStoreSlh", "Choose a version already installed by Microsoft Store. SLH launches it directly, without downloading or Developer Mode.")} onClose={() => setStoreDialogOpen(false)} width="small">
        <div className={styles.groupDialog}>
          {storeVersions.map((version) => (
            <button className={common.secondaryButton} type="button" key={`${version.packageFamilyName ?? "store"}-${version.id}`} onClick={() => void useStoreVersion(version)}>{uiText("settings.minecraft", "Minecraft")}{version.id} · {version.channel === "preview" ? uiText("installation.texts.preview", "Preview") : uiText("installation.texts.release", "Release")}
            </button>
          ))}
          <button className={common.ghostButton} type="button" onClick={() => setStoreDialogOpen(false)}>{uiText("common.cancel", "Cancel")}</button>
        </div>
      </Dialog>
    </aside>
  );
}
