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
          title: tr("Open Microsoft Store"),
          message: tr("Install Minecraft from Microsoft Store."),
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
        title: tr("Microsoft Store versions could not be loaded"),
        message: String((error as { message?: string }).message ?? error),
      });
    } finally {
      setStoreLookupBusy(false);
    }
  };
  const useStoreVersion = async (version: MinecraftVersionSummary) => {
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
        title: tr("Store version could not be selected"),
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
          pushToast({ tone: "error", title: tr("No internet connection"), message: tr("Minecraft was launched with a temporary offline identity.") });
        } else {
          pushToast({ tone: "success", title: tr("Minecraft started"), message: `${instance.name} ${tr("is running.")}` });
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
        title: installable ? tr("Installation failed") : tr("Launch failed"),
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
      pushToast({ tone: "info", title: tr("Minecraft stopped"), message: `${instance.name} ${tr("was stopped")}.` });
      await refresh();
    } catch (error) {
      pushToast({ tone: "error", title: tr("Stop failed"), message: String((error as { message?: string }).message ?? error) });
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
      pushToast({ tone: "error", title: tr("Group was not updated"), message: String((error as { message?: string }).message ?? error) });
    }
  };
  const actionButtons: Record<string, ReactNode> = {
    mods: <button type="button" data-minimal-compact aria-label={tr(instance.loaderType === "bedrock" ? "Add-ons" : "Mods")} onClick={() => navigate(`/instance/${instance.id}?tab=mods`)}><PuzzlePiece size={19} /><span data-minimal-text>{tr(instance.loaderType === "bedrock" ? "Add-ons" : "Mods")}</span></button>,
    resourcepacks: instance.loaderType === "bedrock" ? <button type="button" data-minimal-compact aria-label={tr("Resource packs")} onClick={() => navigate(`/instance/${instance.id}?tab=resourcepacks`)}><Stack size={19} /><span data-minimal-text>{tr("Resource packs")}</span></button> : null,
    worlds: <button type="button" data-minimal-compact aria-label={tr("Worlds")} onClick={() => navigate(`/instance/${instance.id}?tab=worlds`)}><Worlds size={19} /><span data-minimal-text>{tr("Worlds")}</span></button>,
    screenshots: instance.loaderType === "bedrock" ? null : <button type="button" data-minimal-compact aria-label={tr("Screenshots")} onClick={() => navigate(`/instance/${instance.id}?tab=screenshots`)}><Image size={19} /><span data-minimal-text>{tr("Screenshots")}</span></button>,
    folder: <button type="button" data-minimal-compact aria-label={tr("Folder")} onClick={() => void revealInstancePath(instance.id, instance.gameDir).catch((error) => pushToast({ tone: "error", title: tr("Folder could not be opened"), message: String((error as { message?: string }).message ?? error) }))}><FolderOpen size={19} /><span data-minimal-text>{tr("Folder")}</span></button>,
    logs: <button type="button" data-minimal-compact aria-label={tr("Logs")} onClick={() => navigate(`/instance/${instance.id}?tab=logs`)}><FileText size={19} /><span data-minimal-text>{tr("Logs")}</span></button>,
    settings: <button type="button" data-minimal-compact aria-label={tr("Settings")} onClick={() => navigate(`/instance/${instance.id}?tab=settings`)}><Wrench size={19} /><span data-minimal-text>{tr("Settings")}</span></button>,
    group: <button type="button" data-minimal-compact aria-label={tr("Group")} onClick={() => setGroupDialogOpen(true)}><Stack size={19} /><span data-minimal-text>{tr("Group")}</span></button>,
    export: <button type="button" data-minimal-compact aria-label={tr("Export")} onClick={() => navigate(`/instance/${instance.id}?tab=settings&export=1`)}><Export size={19} /><span data-minimal-text>{tr("Export")}</span></button>,
    delete: <button className={styles.deleteAction} type="button" data-minimal-compact aria-label={tr("Delete instance")} disabled={!onDelete || operationActive || busy || instance.status === "running" || instance.status === "installing" || instance.status === "launching"} onClick={() => onDelete?.()}><Trash size={19} /><span data-minimal-text>{tr("Delete instance")}</span></button>,
  };
  const actionOrder = panelOptions.actionOrder?.length ? panelOptions.actionOrder : Object.keys(actionButtons);

  return (
    <aside
      className={styles.panel}
      onContextMenu={(event) => { event.preventDefault(); onContextMenu?.(event); }}
      onPointerDown={(event) => {
        if (event.button === 2) { event.preventDefault(); onContextMenu?.(event); }
      }}
    >
      <div className={styles.scroll}>
        {panelOptions.showArtwork ? <InstanceArtwork instance={instance} size="large" /> : null}
        <div className={styles.identity}>
          <h2>{instance.name}</h2>
          <p data-minimal-text>Minecraft {instance.minecraftVersion} · {instance.loaderType === "neoforge" ? "NeoForge" : instance.loaderType === "bedrock" ? "Bedrock" : instance.loaderType}</p>
        </div>
        <button
          type="button"
          className={`${styles.playButton} ${instance.status === "running" ? styles.killButton : ""}`}
          disabled={busy || storeLookupBusy || operationActive || instance.status === "installing" || instance.status === "launching" || (instance.loaderType === "bedrock" && bootstrap?.settings.bedrock.enabled === false && instance.status !== "running")}
          title={instance.loaderType === "bedrock" && bootstrap?.settings.bedrock.enabled === false ? tr("Enable Bedrock in Settings first") : undefined}
          onClick={() => void (instance.status === "running" ? kill() : play())}
        >
          {busy || storeLookupBusy || operationActive || instance.status === "installing" || instance.status === "launching" ? <SpinnerGap className={styles.spin} size={20} weight="bold" /> : instance.status === "running" ? <X size={20} weight="bold" /> : <Play size={20} weight="fill" />}
          {instance.status === "running" ? tr("Kill") : instance.status === "launching" ? tr("Launching") : instance.status === "installing" ? tr("Installing") : storeLookupBusy ? tr("Checking Microsoft Store") : installable ? tr(instance.status === "error" ? "Retry installation" : "Install") : tr("Play")}
        </button>
        {instance.loaderType === "bedrock" && installable ? <button className={common.secondaryButton} type="button" disabled={busy || storeLookupBusy || operationActive} onClick={() => void openBedrockStorePicker()}>{tr("Use Store version")}</button> : null}
        <div className={styles.quickGrid}>
          {actionOrder.filter((id) => !panelOptions.hiddenActions.includes(id) && actionButtons[id]).map((id) => <span key={id}>{actionButtons[id]}</span>)}
        </div>
        {panelOptions.showMetadata ? <div className={styles.metadata}>
          <div><Clock size={16} /><span>{formatPlaytime(instance.playtimeSeconds, locale, tr)}</span></div>
          <div><span>{tr("Status")}</span><span className={instance.status === "error" ? common.errorBadge : instance.status === "installed" ? common.successBadge : common.badge}>{tr(instance.status)}</span></div>
          {instance.loaderType === "bedrock" ? <><div><span>{tr("Bedrock version")}</span><strong>{instance.minecraftVersion}</strong></div><div><span>{tr("Profile")}</span><strong>{tr(instance.bedrockProfileMode === "isolated" ? "Isolated profile" : "Shared Store data")}</strong></div></> : <><div><span>{tr("Memory")}</span><strong>{instance.memoryMaxMb / 1024} GB</strong></div><div><span>{tr("Loader")}</span><strong>{instance.loaderVersion ?? instance.loaderType}</strong></div></>}
        </div> : null}
      </div>
      <Dialog open={groupDialogOpen} title={tr("Assign group")} description={tr("Choose where this instance appears in the library.")} onClose={() => setGroupDialogOpen(false)} width="small">
        <div className={styles.groupDialog}>
          <button className={instance.groupId === null ? common.button : common.secondaryButton} type="button" onClick={() => void assignGroup(null)}>{tr("Ungrouped")}</button>
          {bootstrap?.groups.map((group) => <button key={group.id} className={instance.groupId === group.id ? common.button : common.secondaryButton} type="button" onClick={() => void assignGroup(group.id)}>{group.name}</button>)}
        </div>
      </Dialog>
      <Dialog open={offlineNameDialogOpen} title={tr("Offline launch")} description={tr("No internet connection is available. The selected online account will remain selected; this launch uses a temporary offline identity only.")} onClose={() => setOfflineNameDialogOpen(false)} width="small">
        <form className={styles.offlineLaunchForm} onSubmit={(event) => {
          event.preventDefault();
          const username = offlineName.trim();
          if (!username) return;
          setOfflineNameDialogOpen(false);
          void play(username);
        }}>
          <label><span>{tr("Minecraft nickname")}</span><input className={common.input} autoFocus maxLength={16} value={offlineName} onChange={(event) => setOfflineName(event.target.value)} placeholder="Player" /></label>
          <small>{tr("Use 3–16 Latin letters, numbers, or underscores.")}</small>
          <div><button className={common.secondaryButton} type="button" onClick={() => setOfflineNameDialogOpen(false)}>{tr("Cancel")}</button><button className={common.button} type="submit" disabled={!offlineName.trim()}><Play size={16} /> {tr("Launch offline")}</button></div>
        </form>
      </Dialog>
      <Dialog open={storeDialogOpen} title={tr("Select installed Store version")} description={tr("Choose a version already installed by Microsoft Store. SLH launches it directly, without downloading or Developer Mode.")} onClose={() => setStoreDialogOpen(false)} width="small">
        <div className={styles.groupDialog}>
          {storeVersions.map((version) => (
            <button className={common.secondaryButton} type="button" key={`${version.packageFamilyName ?? "store"}-${version.id}`} onClick={() => void useStoreVersion(version)}>
              Minecraft {version.id} · {version.channel === "preview" ? tr("Preview") : tr("Release")}
            </button>
          ))}
          <button className={common.ghostButton} type="button" onClick={() => setStoreDialogOpen(false)}>{tr("Cancel")}</button>
        </div>
      </Dialog>
    </aside>
  );
}
