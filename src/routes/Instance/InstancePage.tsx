import { subscribeWindowActivity } from "../../lib/windowActivity";
import launchStyles from "../../components/instance/InstanceSidePanel.module.css";
import { launchOrInstallInstance } from "../../lib/instanceLaunch";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowClockwise, Check, Clock, DownloadSimple, Export, File, FileText, FolderOpen, Funnel, GearSix, Image as ImageIcon, Info, Palette, Play, PuzzlePiece, SpinnerGap, Square, Stack, Trash, WarningCircle, Worlds, Wrench, X } from "../../components/icons";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { command, listenConsoleLine, listenLaunchState, revealInstancePath } from "../../lib/tauri";
import type { BedrockRuntimeStatus, ConsoleLine, ConsoleSettings, ContentInstallPlan, ExportEntry, ExportResult, GeneralSettings, Instance, InstanceFileEntry, LoaderVersion, MinecraftVersionSummary, UpdateInstanceRequest } from "../../lib/types";
import { useAppStore } from "../../stores/appStore";
import { versionNotification } from "../../lib/versionNotifications";
import common from "../../components/common/Common.module.css";
import { InstanceArtwork, instanceArtworkColors, instanceIconChoices } from "../../components/instance/InstanceArtwork";
import styles from "./InstancePage.module.css";
import { useI18n } from "../../i18n/I18nProvider";
import { formatPlaytime } from "../../lib/formatters";
import { bedrockToastAction } from "../../lib/bedrock";
const DiscoverPage = lazy(() => import("../Discover/DiscoverPage").then((module) => ({ default: module.DiscoverPage })));
import { Dialog } from "../../components/common/Dialog";
import { BedrockCatalog } from "../../components/instance/BedrockCatalog";
import { InstanceVersionMigrationDialog } from "../../components/instance/InstanceVersionMigrationDialog";
import type { ContentInstallResult, InstalledContentRecord } from "../../lib/types";
import menuStyles from "../../components/shell/NavigationContextMenu.module.css";

const tabs = ["overview", "mods", "resourcepacks", "shaders", "worlds", "screenshots", "settings", "logs"] as const;
type InstanceTab = (typeof tabs)[number];
type InstanceTabsPosition = NonNullable<GeneralSettings["instanceTabsPosition"]>;

const instanceTabsPositionOptions: Array<[InstanceTabsPosition, string]> = [
  ["top", "Top"],
  ["bottom", "Bottom"],
  ["left", "Left"],
  ["right", "Right"],
];

const tabLabels: Record<InstanceTab, string> = {
  overview: "Overview",
  mods: "Mods",
  resourcepacks: "Resource packs",
  shaders: "Shaders",
  worlds: "Worlds",
  screenshots: "Screenshots",
  settings: "Settings",
  logs: "Logs",
};

const tabIcons = {
  overview: Info,
  mods: PuzzlePiece,
  resourcepacks: Stack,
  shaders: Palette,
  worlds: Worlds,
  screenshots: ImageIcon,
  settings: Wrench,
  logs: FileText,
} satisfies Record<InstanceTab, typeof Info>;

function normalizeInstanceTabOrder(stored: string[] | undefined): InstanceTab[] {
  const valid = new Set<string>(tabs);
  const seen = new Set<InstanceTab>();
  const result: InstanceTab[] = [];
  for (const id of [...(stored ?? []), ...tabs]) {
    if (!valid.has(id) || seen.has(id as InstanceTab)) continue;
    seen.add(id as InstanceTab);
    result.push(id as InstanceTab);
  }
  return result;
}

const contentProjectTypes: Record<string, InstalledContentRecord["projectType"]> = {
  mods: "mod",
  resourcepacks: "resourcepack",
  shaders: "shader",
  worlds: "world",
};

const contentDownloadLabels: Record<string, string> = {
  mods: "Download mods",
  resourcepacks: "Download resource packs",
  shaders: "Download shaders",
  worlds: "Download worlds",
};

type UpdateCheck = { record: InstalledContentRecord; status: "current" | "update" | "error"; nextVersion?: string };

async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function InstancePage() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const bootstrap = useAppStore((state) => state.bootstrap);
  const refresh = useAppStore((state) => state.refresh);
  const selectInstance = useAppStore((state) => state.selectInstance);
  const pushToast = useAppStore((state) => state.pushToast);
  const instanceOperationIds = useAppStore((state) => state.instanceOperationIds);
  const beginInstanceOperation = useAppStore((state) => state.beginInstanceOperation);
  const endInstanceOperation = useAppStore((state) => state.endInstanceOperation);
  const { tr, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<InstanceFileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [selectedContentPaths, setSelectedContentPaths] = useState<string[]>([]);
  const [contentContextMenu, setContentContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [tabDraggedId, setTabDraggedId] = useState<InstanceTab | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<{ id: InstanceTab; after: boolean } | null>(null);
  const [tabDragPreview, setTabDragPreview] = useState<{ label: string; x: number; y: number } | null>(null);
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]);
  const [consoleLoading, setConsoleLoading] = useState(false);
  const [consoleQuery, setConsoleQuery] = useState("");
  const consoleScrollRef = useRef<HTMLDivElement>(null);
  const contentContextMenuRef = useRef<HTMLDivElement>(null);
  const tabContextMenuRef = useRef<HTMLDivElement>(null);
  const tabMenuMoveRef = useRef<{ lastX: number; lastY: number } | null>(null);
  const tabPointerDragRef = useRef<{ id: InstanceTab; source: "bar" | "menu"; startX: number; startY: number; dragging: boolean } | null>(null);
  const suppressTabClickRef = useRef(false);
  const instance = bootstrap?.instances.find((item) => item.id === id);
  const isBedrock = instance?.loaderType === "bedrock";
  const [instanceName, setInstanceName] = useState("");
  const [iconKey, setIconKey] = useState("cube");
  const [iconBackground, setIconBackground] = useState("#3f493c");
  const [iconForeground, setIconForeground] = useState("#f0f4ed");
  const [identityBusy, setIdentityBusy] = useState(false);
  const [memoryMinMb, setMemoryMinMb] = useState(512);
  const [memoryMaxMb, setMemoryMaxMb] = useState(4096);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [settingsLoader, setSettingsLoader] = useState<Instance["loaderType"]>("vanilla");
  const [settingsMinecraftVersion, setSettingsMinecraftVersion] = useState("");
  const [settingsMinecraftVersions, setSettingsMinecraftVersions] = useState<MinecraftVersionSummary[]>([]);
  const [settingsLoaderVersion, setSettingsLoaderVersion] = useState<string | null>(null);
  const [settingsLoaderVersions, setSettingsLoaderVersions] = useState<LoaderVersion[]>([]);
  const [loaderLoading, setLoaderLoading] = useState(false);
  const [loaderError, setLoaderError] = useState<string | null>(null);
  const [loaderBusy, setLoaderBusy] = useState(false);
  const [bedrockProfileMode, setBedrockProfileMode] = useState<"isolated" | "shared">("shared");
  const [bedrockRuntime, setBedrockRuntime] = useState<BedrockRuntimeStatus | null>(null);
  const [bedrockRuntimeBusy, setBedrockRuntimeBusy] = useState(false);
  const [bedrockRuntimeError, setBedrockRuntimeError] = useState<string | null>(null);
  const [bedrockSetupDialogOpen, setBedrockSetupDialogOpen] = useState(false);
  const [bedrockSetupBusy, setBedrockSetupBusy] = useState(false);
  const [bedrockSetupError, setBedrockSetupError] = useState<string | null>(null);
  const [screenshotsNewestFirst, setScreenshotsNewestFirst] = useState(true);
  const [contentBrowserOpen, setContentBrowserOpen] = useState(false);
  const preserveBedrockBrowserRef = useRef(false);
  const [contentRevision, setContentRevision] = useState(0);
  const [contentActionBusy, setContentActionBusy] = useState(false);
  const [offlineNameDialogOpen, setOfflineNameDialogOpen] = useState(false);
  const [offlineName, setOfflineName] = useState("");
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updateRecords, setUpdateRecords] = useState<InstalledContentRecord[]>([]);
  const [updateChecks, setUpdateChecks] = useState<UpdateCheck[]>([]);
  const [updateLoading, setUpdateLoading] = useState(false);
  const [updateRunning, setUpdateRunning] = useState(false);
  const [updateProgress, setUpdateProgress] = useState({ current: 0, total: 0 });
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportEntries, setExportEntries] = useState<ExportEntry[]>([]);
  const [exportSelected, setExportSelected] = useState<string[]>([]);
  const [exportFormat, setExportFormat] = useState<"zip" | "curseforge" | "mrpack">("zip");
  const [exportLoading, setExportLoading] = useState(false);
  const [exportRunning, setExportRunning] = useState(false);
  const [versionMigrationOpen, setVersionMigrationOpen] = useState(false);
  const exportShortcutHandled = useRef(false);
  const tab = new URLSearchParams(location.search).get("tab") ?? "overview";
  const configuredTabsPosition = bootstrap?.settings.general.instanceTabsPosition;
  const tabsPositionClass = configuredTabsPosition === "left"
    ? styles.tabsLeft
    : configuredTabsPosition === "right"
      ? styles.tabsRight
      : configuredTabsPosition === "bottom"
        ? styles.tabsBottom
        : "";
  const tabOrder = normalizeInstanceTabOrder(bootstrap?.settings.general.instanceTabs?.order);
  const supportedTabs: readonly InstanceTab[] = isBedrock ? tabs.filter((item) => item !== "shaders" && item !== "screenshots") : tabs;
  const configuredVisibleTabs = bootstrap?.settings.general.instanceTabs?.visible;
  const visibleTabIds = new Set<InstanceTab>(
    (configuredVisibleTabs?.length ? configuredVisibleTabs : tabs)
      .filter((id): id is InstanceTab => tabs.includes(id as InstanceTab)),
  );
  if (visibleTabIds.size === 0) tabs.forEach((item) => visibleTabIds.add(item));
  if (!supportedTabs.some((item) => visibleTabIds.has(item))) supportedTabs.forEach((item) => visibleTabIds.add(item));
  const orderedVisibleTabs = tabOrder.filter((item) => supportedTabs.includes(item) && visibleTabIds.has(item));
  const tabOrderKey = tabOrder.join("|");
  const visibleTabKey = supportedTabs.filter((item) => visibleTabIds.has(item)).join("|");

  useEffect(() => {
    if (preserveBedrockBrowserRef.current) preserveBedrockBrowserRef.current = false;
    else setContentBrowserOpen(false);
    setContentContextMenu(null);
    setTabContextMenu(null);
    tabMenuMoveRef.current = null;
  }, [tab]);
  useEffect(() => {
    if (!bootstrap || !id || orderedVisibleTabs.length === 0 || orderedVisibleTabs.includes(tab as InstanceTab)) return;
    navigate(`/instance/${id}?tab=${orderedVisibleTabs[0]}`, { replace: true });
  }, [bootstrap, id, navigate, orderedVisibleTabs.join("|"), tab]);
  useLayoutEffect(() => {
    if (!contentContextMenu || !contentContextMenuRef.current) return;
    const rect = contentContextMenuRef.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(contentContextMenu.x, window.innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(contentContextMenu.y, window.innerHeight - rect.height - 8));
    if (x !== contentContextMenu.x || y !== contentContextMenu.y) {
      setContentContextMenu((current) => current ? { ...current, x, y } : null);
    }
  }, [contentContextMenu]);
  useLayoutEffect(() => {
    if (!tabContextMenu || !tabContextMenuRef.current) return;
    const rect = tabContextMenuRef.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(tabContextMenu.x, window.innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(tabContextMenu.y, window.innerHeight - rect.height - 8));
    if (x !== tabContextMenu.x || y !== tabContextMenu.y) {
      setTabContextMenu((current) => current ? { ...current, x, y } : null);
    }
  }, [tabContextMenu]);
  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".slh-content-context-menu")) setContentContextMenu(null);
      if (!target?.closest(".slh-instance-tab-context-menu")) {
        setTabContextMenu(null);
        tabMenuMoveRef.current = null;
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedContentPaths([]);
        setContentContextMenu(null);
        setTabContextMenu(null);
        tabMenuMoveRef.current = null;
        tabPointerDragRef.current = null;
        setTabDraggedId(null);
        setTabDropTarget(null);
        setTabDragPreview(null);
      }
    };
    const closeForAnotherMenu = () => {
      setContentContextMenu(null);
      setTabContextMenu(null);
      tabMenuMoveRef.current = null;
    };
    const cancelTransientUi = () => {
      setContentContextMenu(null);
      setTabContextMenu(null);
      tabMenuMoveRef.current = null;
      tabPointerDragRef.current = null;
      setTabDraggedId(null);
      setTabDropTarget(null);
      setTabDragPreview(null);
    };
    window.addEventListener("pointerdown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("slh-context-menu-open", closeForAnotherMenu);
    window.addEventListener("slh-ui-cancel", cancelTransientUi);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("slh-context-menu-open", closeForAnotherMenu);
      window.removeEventListener("slh-ui-cancel", cancelTransientUi);
    };
  }, []);
  useEffect(() => {
    if (!updateDialogOpen || !instance || !contentProjectTypes[tab]) return;
    let active = true;
    setUpdateLoading(true);
    setUpdateRecords([]);
    setUpdateChecks([]);
    command<InstalledContentRecord[]>("reconcile_installed_content", { instanceId: instance.id, projectType: contentProjectTypes[tab] })
      .then(async (items) => {
        if (!active) return;
        setUpdateRecords(items);
        const checks = await mapWithConcurrency(items, 4, async (record): Promise<UpdateCheck> => {
          try {
            const plan = await command<ContentInstallPlan>(record.provider === "modrinth" ? "plan_modrinth_install" : "plan_curseforge_install", { instanceId: instance.id, projectId: record.projectId });
            const rootItem = plan.items.find((item) => item.projectId === plan.rootProjectId);
            const hasUpdate = Boolean(rootItem && rootItem.action !== "unchanged");
            return { record, status: hasUpdate ? "update" : "current", nextVersion: rootItem?.versionNumber };
          } catch {
            return { record, status: "error" };
          }
        });
        if (active) setUpdateChecks(checks);
      })
      .catch((error) => { if (active) pushToast({ tone: "error", title: tr("Content could not be indexed"), message: String((error as { message?: string }).message ?? error) }); })
      .finally(() => { if (active) setUpdateLoading(false); });
    return () => { active = false; };
  }, [instance, pushToast, tab, updateDialogOpen]);
  useEffect(() => {
    if (!instance) return;
    const colors = instanceArtworkColors(instance);
    setInstanceName(instance.name);
    setIconKey(instance.iconKey || "cube");
    setIconBackground(colors.background);
    setIconForeground(colors.foreground);
    setMemoryMinMb(instance.memoryMinMb);
    setMemoryMaxMb(instance.memoryMaxMb);
    setSettingsLoader(instance.loaderType);
    setSettingsMinecraftVersion(instance.minecraftVersion);
    setSettingsLoaderVersion(instance.loaderVersion);
    setBedrockProfileMode(instance.bedrockProfileMode ?? "shared");
  }, [instance?.id, instance?.name, instance?.iconKey, instance?.iconBackground, instance?.iconForeground, instance?.memoryMinMb, instance?.memoryMaxMb, instance?.minecraftVersion, instance?.loaderType, instance?.loaderVersion, instance?.bedrockProfileMode]);
  useEffect(() => {
    if (!instance || instance.loaderType !== "bedrock") {
      setBedrockRuntime(null);
      setBedrockRuntimeError(null);
      return;
    }
    let active = true;
    setBedrockRuntimeBusy(true);
    command<BedrockRuntimeStatus>("get_bedrock_runtime_status")
      .then((status) => {
        if (active) setBedrockRuntime(status);
      })
      .catch((error) => {
        if (active) setBedrockRuntimeError(String((error as { message?: string }).message ?? error));
      })
      .finally(() => {
        if (active) setBedrockRuntimeBusy(false);
      });
    return () => {
      active = false;
    };
  }, [instance?.id, instance?.loaderType]);
  useEffect(() => {
    if (tab !== "settings") return;
    command<MinecraftVersionSummary[]>(settingsLoader === "bedrock" ? "list_bedrock_versions" : "list_minecraft_versions")
      .then((versions) => setSettingsMinecraftVersions(versions.filter((version) => version.versionType === "release")))
      .catch(() => setSettingsMinecraftVersions([]));
  }, [settingsLoader, tab]);
  useEffect(() => {
    if (!instance || tab !== "settings" || settingsLoader === "vanilla" || settingsLoader === "bedrock") {
      setSettingsLoaderVersions([]);
      setLoaderError(null);
      return;
    }
    let active = true;
    setLoaderLoading(true);
    setLoaderError(null);
    command<LoaderVersion[]>("list_loader_versions", { loaderType: settingsLoader, minecraftVersion: settingsMinecraftVersion })
      .then((versions) => {
        if (!active) return;
        setSettingsLoaderVersions(versions);
        setSettingsLoaderVersion((current) => current && versions.some((version) => version.id === current) ? current : versions[0]?.id ?? null);
      })
      .catch((error) => {
        if (active) {
          setSettingsLoaderVersions([]);
          setSettingsLoaderVersion(null);
          setLoaderError(String((error as { message?: string }).message ?? error));
        }
      })
      .finally(() => { if (active) setLoaderLoading(false); });
    return () => { active = false; };
  }, [settingsMinecraftVersion, settingsLoader, tab]);
  useEffect(() => {
    const fileCategories = isBedrock
      ? ["mods", "resourcepacks", "worlds", "logs"]
      : ["mods", "resourcepacks", "shaders", "worlds", "screenshots"];
    if (!id || !fileCategories.includes(tab)) {
      setFiles([]);
      setSelectedContentPaths([]);
      return;
    }
    let active = true;
    setSelectedContentPaths([]);
    setFilesLoading(true);
    command<InstanceFileEntry[]>("list_instance_files", { instanceId: id, category: tab })
      .then((items) => { if (active) setFiles(items); })
      .catch((error) => { if (active) pushToast({ tone: "error", title: tr("Files could not be indexed"), message: String((error as { message?: string }).message ?? error) }); })
      .finally(() => { if (active) setFilesLoading(false); });
    return () => { active = false; };
  }, [contentRevision, id, instance?.loaderType, pushToast, tab]);
  useEffect(() => {
    if (!id || tab !== "logs" || isBedrock) return;
    let active = true;
    const limit = bootstrap?.settings.console.maxLines ?? 2000;
    let windowVisible = true;
    let request = 0;
    const reloadConsole = () => {
      if (!active || !windowVisible) return;
      const ticket = ++request;
      setConsoleLoading(true);
      void command<ConsoleLine[]>("get_instance_console", { instanceId: id, limit })
      .then((lines) => { if (active && ticket === request) setConsoleLines(lines); })
      .catch((error) => { if (active) pushToast({ tone: "error", title: tr("Console could not be loaded"), message: String((error as { message?: string }).message ?? error) }); })
      .finally(() => { if (active && ticket === request) setConsoleLoading(false); });
    };
    const stopActivity = subscribeWindowActivity((visible) => {
      windowVisible = visible;
      if (visible) reloadConsole(); else ++request;
    });
    const subscription = listenConsoleLine((line) => {
      if (!active || !windowVisible || line.instanceId !== id) return;
      setConsoleLines((current) => [...current, line].slice(-limit));
    });
    const launchSubscription = listenLaunchState((event) => {
      if (!active || event.instanceId !== id || event.state === "running") return;
      reloadConsole();
    });
    return () => {
      active = false;
      stopActivity();
      void subscription.then((unlisten) => unlisten());
      void launchSubscription.then((unlisten) => unlisten());
    };
  }, [bootstrap?.settings.console.maxLines, id, instance?.loaderType, isBedrock, pushToast, tab]);
  useEffect(() => {
    if (tab !== "logs" || !bootstrap?.settings.console.autoScroll) return;
    const target = consoleScrollRef.current;
    if (target) target.scrollTop = target.scrollHeight;
  }, [bootstrap?.settings.console.autoScroll, consoleLines.length, tab]);

  const saveInstanceTabSettings = useCallback(async (order: InstanceTab[], visible: Set<InstanceTab>) => {
    if (!bootstrap) return;
    const nextVisible = order.filter((item) => visible.has(item));
    if (nextVisible.length === 0) return;
    try {
      await command("update_setting", {
        key: "general",
        value: {
          ...bootstrap.settings.general,
          instanceTabs: { order, visible: nextVisible },
        },
      });
      await refresh();
    } catch (error) {
      pushToast({ tone: "error", title: tr("Instance tabs were not saved"), message: String((error as { message?: string }).message ?? error) });
    }
  }, [bootstrap, pushToast, refresh, tr]);

  const saveInstanceTabsPosition = useCallback(async (position: InstanceTabsPosition) => {
    if (!bootstrap) return;
    try {
      await command("update_setting", {
        key: "general",
        value: { ...bootstrap.settings.general, instanceTabsPosition: position },
      });
      await refresh();
    } catch (error) {
      pushToast({ tone: "error", title: tr("Instance tabs position was not saved"), message: String((error as { message?: string }).message ?? error) });
    }
  }, [bootstrap, pushToast, refresh, tr]);

  const reorderInstanceTabs = useCallback(async (id: InstanceTab, targetId: InstanceTab, after: boolean) => {
    if (id === targetId) return;
    const nextOrder = tabOrder.filter((item) => item !== id);
    const targetIndex = nextOrder.indexOf(targetId);
    nextOrder.splice(targetIndex < 0 ? nextOrder.length : targetIndex + (after ? 1 : 0), 0, id);
    await saveInstanceTabSettings(nextOrder, visibleTabIds);
  }, [saveInstanceTabSettings, tabOrderKey, visibleTabKey]);

  const toggleInstanceTab = async (id: InstanceTab) => {
    const nextVisible = new Set(visibleTabIds);
    if (nextVisible.has(id)) {
      if (nextVisible.size <= 1) return;
      nextVisible.delete(id);
      if (tab === id && instance) {
        const nextTab = tabOrder.find((item) => nextVisible.has(item));
        if (nextTab) navigate(`/instance/${instance.id}?tab=${nextTab}`, { replace: true });
      }
    } else {
      nextVisible.add(id);
    }
    await saveInstanceTabSettings(tabOrder, nextVisible);
  };

  const openTabContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    window.dispatchEvent(new Event("slh-context-menu-open"));
    setTabContextMenu({ x: event.clientX, y: event.clientY });
  };

  const beginTabPointerDrag = (event: React.PointerEvent<HTMLElement>, id: InstanceTab, source: "bar" | "menu") => {
    if (event.button !== 0 || (source === "menu" && (event.target as HTMLElement).closest("input"))) return;
    if (source === "bar" && !event.ctrlKey) return;
    if (source === "bar") event.preventDefault();
    suppressTabClickRef.current = false;
    tabPointerDragRef.current = { id, source, startX: event.clientX, startY: event.clientY, dragging: false };
  };

  const beginTabMenuMove = (event: React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0 && event.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
    tabMenuMoveRef.current = { lastX: event.clientX, lastY: event.clientY };
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = tabPointerDragRef.current;
      if (!drag) return;
      if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 6) {
        drag.dragging = true;
        suppressTabClickRef.current = true;
        setTabDraggedId(drag.id);
        setTabDragPreview({ label: tr(tabLabels[drag.id]), x: event.clientX, y: event.clientY });
      }
      if (!drag.dragging) return;
      event.preventDefault();
      const selector = drag.source === "menu" ? "[data-slh-instance-tab-menu]" : "[data-slh-instance-tab]";
      const targetElement = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(selector);
      const target = targetElement?.dataset.slhInstanceTabMenu ?? targetElement?.dataset.slhInstanceTab;
      if (target && tabs.includes(target as InstanceTab) && target !== drag.id && targetElement) {
        const rect = targetElement.getBoundingClientRect();
        const after = drag.source === "menu"
          ? event.clientY >= rect.top + rect.height / 2
          : (configuredTabsPosition === "left" || configuredTabsPosition === "right")
            ? event.clientY >= rect.top + rect.height / 2
            : event.clientX >= rect.left + rect.width / 2;
        setTabDropTarget({ id: target as InstanceTab, after });
      } else {
        setTabDropTarget(null);
      }
      setTabDragPreview((current) => current ? { ...current, x: event.clientX, y: event.clientY } : current);
    };
    const onEnd = (event: PointerEvent) => {
      const drag = tabPointerDragRef.current;
      tabPointerDragRef.current = null;
      if (drag?.dragging) {
        const selector = drag.source === "menu" ? "[data-slh-instance-tab-menu]" : "[data-slh-instance-tab]";
        const targetElement = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(selector);
        const target = targetElement?.dataset.slhInstanceTabMenu ?? targetElement?.dataset.slhInstanceTab;
        if (target && tabs.includes(target as InstanceTab) && target !== drag.id && targetElement) {
          const rect = targetElement.getBoundingClientRect();
          const after = drag.source === "menu"
            ? event.clientY >= rect.top + rect.height / 2
            : (configuredTabsPosition === "left" || configuredTabsPosition === "right")
              ? event.clientY >= rect.top + rect.height / 2
              : event.clientX >= rect.left + rect.width / 2;
          void reorderInstanceTabs(drag.id, target as InstanceTab, after);
        }
      }
      setTabDraggedId(null);
      setTabDropTarget(null);
      setTabDragPreview(null);
    };
    const cancel = () => {
      tabPointerDragRef.current = null;
      setTabDraggedId(null);
      setTabDropTarget(null);
      setTabDragPreview(null);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, [configuredTabsPosition, reorderInstanceTabs, tr]);
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const move = tabMenuMoveRef.current;
      if (!move || !tabContextMenuRef.current) return;
      event.preventDefault();
      const deltaX = event.clientX - move.lastX;
      const deltaY = event.clientY - move.lastY;
      move.lastX = event.clientX;
      move.lastY = event.clientY;
      setTabContextMenu((current) => {
        if (!current) return current;
        const rect = tabContextMenuRef.current?.getBoundingClientRect();
        const width = rect?.width ?? 236;
        const height = rect?.height ?? 300;
        const maxX = Math.max(8, window.innerWidth - width - 8);
        const maxY = Math.max(8, window.innerHeight - height - 8);
        return {
          x: Math.max(8, Math.min(current.x + deltaX, maxX)),
          y: Math.max(8, Math.min(current.y + deltaY, maxY)),
        };
      });
    };
    const end = () => { tabMenuMoveRef.current = null; };
    window.addEventListener("mousemove", onMove, { passive: false });
    window.addEventListener("mouseup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, []);
  if (!bootstrap) return null;
  if (!instance) return <div className={styles.notFound}><WarningCircle size={36} /><h1>{tr("Instance not found")}</h1><button className={common.secondaryButton} type="button" onClick={() => navigate("/library")}>{tr("Back to Library")}</button></div>;
  const displayedFiles = tab === "screenshots"
    ? [...files].sort((left, right) => {
      const leftTime = left.modifiedAt ? Date.parse(left.modifiedAt) : 0;
      const rightTime = right.modifiedAt ? Date.parse(right.modifiedAt) : 0;
      return screenshotsNewestFirst ? rightTime - leftTime : leftTime - rightTime;
    })
    : files;

  const openScreenshot = async (entry: InstanceFileEntry) => {
    try {
      await command("open_instance_screenshot", { instanceId: instance.id, path: entry.path });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Screenshot could not be opened"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  const launch = async (offlineUsername?: string) => {
    if (instanceOperationIds.includes(instance.id)) return;
    setBusy(true);
    beginInstanceOperation(instance.id);
    const action = instance.status === "installed" ? "launch_instance" : "install_instance";
    try {
      const result = await launchOrInstallInstance(instance, offlineUsername);
      if (action === "launch_instance" && result.usedOfflineFallback) {
        pushToast({ tone: "error", title: tr("No internet connection"), message: tr("Minecraft was launched with a temporary offline identity.") });
      }
      if (action === "launch_instance" && bootstrap?.settings.console.openOnLaunch) {
        navigate(`/instance/${instance.id}?tab=logs`);
      }
      await refresh();
    } catch (error) {
      const commandError = error as { code?: string; message?: string };
      if (action === "launch_instance" && commandError.code === "offline_account_name_required") {
        setOfflineName(bootstrap?.accounts.find((account) => account.active)?.username ?? "");
        setOfflineNameDialogOpen(true);
        return;
      }
      const message = String(commandError.message ?? error);
      const setupFailure = /bedrock|gameinput|gaming services|microsoft store|xbox|license|wdapp|developer mode|windows package/i.test(message)
        && !/already running/i.test(message);
      if (action === "launch_instance" && instance.loaderType === "bedrock" && setupFailure) {
        setBedrockSetupError(message);
        setBedrockSetupDialogOpen(true);
        void command<BedrockRuntimeStatus>("get_bedrock_runtime_status")
          .then(setBedrockRuntime)
          .catch(() => undefined);
        return;
      }
      pushToast({
        tone: "error",
        title: tr(action === "launch_instance" ? "Launch failed" : "Installation failed"),
        message,
        action: bedrockToastAction(tr, message),
      });
    } finally {
      setBusy(false);
      endInstanceOperation(instance.id);
    }
  };

  const prepareBedrockRuntime = async () => {
    if (bedrockSetupBusy) return;
    setBedrockSetupBusy(true);
    setBedrockSetupError(null);
    try {
      const status = await command<BedrockRuntimeStatus>("prepare_bedrock_runtime", { instanceId: instance.id });
      setBedrockRuntime(status);
      if (status.launchReady) {
        setBedrockSetupDialogOpen(false);
        pushToast({ tone: "success", title: tr("Bedrock is ready"), message: tr("The official Windows components are ready. SLH will start Bedrock now.") });
        await refresh();
        void launch();
      } else {
        setBedrockSetupError(status.message ?? tr("Bedrock still needs a Microsoft Store license or Windows component."));
      }
    } catch (error) {
      setBedrockSetupError(String((error as { message?: string }).message ?? error));
    } finally {
      setBedrockSetupBusy(false);
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
    } finally { setBusy(false); }
  };

  const repair = async () => {
    setBusy(true);
    try {
      await command("repair_instance", { instanceId: instance.id });
      await refresh();
      pushToast({ tone: "success", title: tr("Repair complete"), message: tr("Metadata, checksums, libraries, assets, natives, and loader files were revalidated.") });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Repair failed"), message: String((error as { message?: string }).message ?? error) });
      await refresh();
    } finally { setBusy(false); }
  };

  const deleteInstance = async () => {
    setBusy(true);
    try {
      await command("delete_instance", { instanceId: instance.id });
      selectInstance(null);
      await refresh();
      pushToast(versionNotification(instance, "deleted"));
      navigate("/library", { replace: true });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Instance was not deleted"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setBusy(false);
    }
  };

  const openExportDialog = async () => {
    if (isBedrock) setExportFormat("zip");
    setExportDialogOpen(true);
    setExportLoading(true);
    try {
      const entries = await command<ExportEntry[]>("list_instance_export_entries", { instanceId: instance.id });
      setExportEntries(entries);
      setExportSelected(entries.map((entry) => entry.relativePath));
    } catch (error) {
      setExportDialogOpen(false);
      pushToast({ tone: "error", title: tr("Export failed"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setExportLoading(false);
    }
  };

  const importBedrockFiles = async (extensions: string[], label: string) => {
    const selection = await openDialog({
      multiple: true,
      filters: [{ name: label, extensions }],
    });
    if (!selection) return;
    const selected = Array.isArray(selection) ? selection : [selection];
    const failures: string[] = [];
    for (const path of selected) {
      try {
        await command("open_bedrock_content_file", { path });
      } catch (error) {
        failures.push(String((error as { message?: string }).message ?? error));
      }
    }
    if (failures.length) {
      pushToast({ tone: "error", title: tr("Bedrock content could not be imported"), message: failures[0] });
    } else {
      pushToast({ tone: "success", title: tr("Minecraft opened the selected content"), message: tr("Confirm the import in Minecraft, then refresh this list.") });
      window.setTimeout(() => setContentRevision((value) => value + 1), 1800);
    }
  };

  const exportArchive = async () => {
    const selectedFormat = isBedrock ? "zip" : exportFormat;
    const extension = selectedFormat === "mrpack" ? "mrpack" : "zip";
    const suffix = selectedFormat === "curseforge" ? "-curseforge" : "";
    const destination = await saveDialog({
      defaultPath: `${instance.name.replace(/[<>:\"/\\|?*]/g, "-")}${suffix}.${extension}`,
      filters: [{ name: selectedFormat === "mrpack" ? "Modrinth pack" : selectedFormat === "curseforge" ? "CurseForge pack" : "ZIP archive", extensions: [extension] }],
    });
    if (!destination) return;
    setExportRunning(true);
    try {
      const result = await command<ExportResult>("export_instance", { instanceId: instance.id, request: { destination, format: selectedFormat, entries: exportSelected } });
      setExportDialogOpen(false);
      pushToast({ tone: "success", title: tr("Instance exported"), message: `${result.filesWritten} ${tr("files")} · ${formatBytes(result.sizeBytes)}` });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Export failed"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setExportRunning(false);
    }
  };

  useEffect(() => {
    const requested = new URLSearchParams(location.search).get("export") === "1";
    if (!requested || !instance || exportShortcutHandled.current) return;
    exportShortcutHandled.current = true;
    void openExportDialog();
    const params = new URLSearchParams(location.search);
    params.delete("export");
    navigate({ search: params.toString() ? `?${params.toString()}` : "" }, { replace: true });
  }, [instance, location.search]);

  const saveIdentity = async () => {
    const name = instanceName.trim();
    if (!name) return;
    setIdentityBusy(true);
    try {
      const request: UpdateInstanceRequest = {
        instanceId: instance.id,
        name,
        iconKey,
        iconBackground,
        iconForeground,
        memoryMinMb: instance.memoryMinMb,
        memoryMaxMb: instance.memoryMaxMb,
      };
      const updated = await command<Instance>("update_instance", { request });
      await refresh();
      pushToast({ tone: "success", title: tr("Instance updated"), message: `${tr("The library entry and folder now use")} ${updated.name}.` });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Instance was not updated"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setIdentityBusy(false);
    }
  };

  const saveMemory = async () => {
    if (memoryMinMb < 256 || memoryMaxMb < memoryMinMb) {
      pushToast({ tone: "error", title: tr("Memory values are invalid"), message: tr("Minimum memory must be at least 256 MB and cannot exceed maximum memory.") });
      return;
    }
    setMemoryBusy(true);
    try {
      const request: UpdateInstanceRequest = {
        instanceId: instance.id,
        name: instance.name,
        iconKey: instance.iconKey,
        iconBackground: instanceArtworkColors(instance).background,
        iconForeground: instanceArtworkColors(instance).foreground,
        memoryMinMb,
        memoryMaxMb,
      };
      await command<Instance>("update_instance", { request });
      await refresh();
      pushToast({ tone: "success", title: tr("Memory saved"), message: `${memoryMinMb}–${memoryMaxMb} ${tr("MB")} ${tr("will be used on the next launch.")}` });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Memory was not saved"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setMemoryBusy(false);
    }
  };

  const saveLoader = async () => {
    if (settingsLoader !== "vanilla" && settingsLoader !== "bedrock" && !settingsLoaderVersion) return;
    setLoaderBusy(true);
    try {
      const updated = await command<Instance>("update_instance", { request: {
        instanceId: instance.id,
        name: instance.name,
        iconKey: instance.iconKey,
        iconBackground: instanceArtworkColors(instance).background,
        iconForeground: instanceArtworkColors(instance).foreground,
        memoryMinMb: instance.memoryMinMb,
        memoryMaxMb: instance.memoryMaxMb,
        minecraftVersion: settingsMinecraftVersion,
        loaderType: settingsLoader,
        loaderVersion: settingsLoader === "vanilla" || settingsLoader === "bedrock" ? null : settingsLoaderVersion,
        bedrockProfileMode: settingsLoader === "bedrock" ? bedrockProfileMode : "shared",
      } satisfies UpdateInstanceRequest });
      await refresh();
      pushToast({ tone: "success", title: tr("Version and loader saved"), message: updated.status === "created" ? tr("Install the instance again to apply the new Minecraft version and loader.") : tr("The version and loader were updated.") });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Loader was not saved"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setLoaderBusy(false);
    }
  };

  const updateConsole = async (patch: Partial<ConsoleSettings>) => {
    try {
      await command("update_setting", { key: "console", value: { ...bootstrap.settings.console, ...patch } });
      await refresh();
    } catch (error) {
      pushToast({ tone: "error", title: tr("Console setting was not saved"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  const copyConsole = async () => {
    try {
      await navigator.clipboard.writeText(consoleLines.map((line) => line.text).join("\n"));
      pushToast({ tone: "success", title: tr("Console copied"), message: `${consoleLines.length} ${tr("visible lines were copied.")}` });
    } catch {
      pushToast({ tone: "error", title: tr("Console could not be copied"), message: tr("Windows did not grant clipboard access.") });
    }
  };

  const updateTrackedContent = async () => {
    if (!instance) return;
    const records = updateChecks.filter((item) => item.status === "update").map((item) => item.record);
    if (records.length === 0) return;
    setUpdateRunning(true);
    setUpdateProgress({ current: 0, total: records.length });
    let updatedFiles = 0;
    let unchangedFiles = 0;
    const failures: string[] = [];
    for (const [index, record] of records.entries()) {
      try {
        const result = await command<ContentInstallResult>(record.provider === "modrinth" ? "install_modrinth_project" : "install_curseforge_project", { instanceId: instance.id, projectId: record.projectId });
        updatedFiles += result.installedFiles;
        unchangedFiles += result.unchangedFiles;
      } catch (error) {
        failures.push(`${record.displayName}: ${String((error as { message?: string }).message ?? error)}`);
      }
      setUpdateProgress({ current: index + 1, total: records.length });
    }
    await refresh();
    setContentRevision((value) => value + 1);
    setUpdateRunning(false);
    if (failures.length > 0) {
      pushToast({ tone: "error", title: tr("Some updates failed"), message: `${updatedFiles} ${tr("files updated")}; ${failures.length} ${tr("failed")}. ${failures[0]}` });
    } else {
      pushToast({ tone: "success", title: tr("Content update complete"), message: `${updatedFiles} ${tr("files updated")}, ${unchangedFiles} ${tr("already current")}.` });
      setUpdateDialogOpen(false);
    }
  };

  const updateContentNow = async () => {
    const projectType = contentProjectTypes[tab];
    if (!instance || !projectType || contentActionBusy) return;
    setContentActionBusy(true);
    try {
      const records = await command<InstalledContentRecord[]>("reconcile_installed_content", { instanceId: instance.id, projectType });
      const checks = await mapWithConcurrency(records, 4, async (record): Promise<UpdateCheck> => {
        try {
          const plan = await command<ContentInstallPlan>(record.provider === "modrinth" ? "plan_modrinth_install" : "plan_curseforge_install", { instanceId: instance.id, projectId: record.projectId });
          const rootItem = plan.items.find((item) => item.projectId === plan.rootProjectId);
          return { record, status: rootItem && rootItem.action !== "unchanged" ? "update" : "current", nextVersion: rootItem?.versionNumber };
        } catch {
          return { record, status: "error" };
        }
      });
      const candidates = checks.filter((item) => item.status === "update").map((item) => item.record);
      let updated = 0;
      const failures: string[] = [];
      for (const record of candidates) {
        try {
          const result = await command<ContentInstallResult>(record.provider === "modrinth" ? "install_modrinth_project" : "install_curseforge_project", { instanceId: instance.id, projectId: record.projectId });
          updated += result.installedFiles;
        } catch (error) {
          failures.push(`${record.displayName}: ${String((error as { message?: string }).message ?? error)}`);
        }
      }
      setContentRevision((value) => value + 1);
      if (failures.length) {
        pushToast({ tone: "error", title: tr("Some updates failed"), message: failures[0] });
      } else {
        pushToast({ tone: "success", title: tr("Content update complete"), message: candidates.length ? `${updated} ${tr("files updated")}.` : tr("Everything is up to date") });
      }
    } catch (error) {
      pushToast({ tone: "error", title: tr("Update failed"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setContentActionBusy(false);
    }
  };

  const deleteContentEntry = async (entry: InstanceFileEntry) => {
    if (!instance || !["mods", "resourcepacks", "shaders", "worlds", "screenshots"].includes(tab) || contentActionBusy) return;
    setContentActionBusy(true);
    try {
      await command("delete_instance_content", { instanceId: instance.id, category: tab, path: entry.path });
      setFiles((current) => current.filter((item) => item.path !== entry.path));
      setSelectedContentPaths((current) => current.filter((path) => path !== entry.path));
      pushToast({ tone: "success", title: tr("Content removed"), message: entry.name });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Content was not removed"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setContentActionBusy(false);
    }
  };

  const selectedContent = files.filter((entry) => selectedContentPaths.includes(entry.path));
  const contentCanBeToggled = !isBedrock && ["mods", "resourcepacks", "shaders"].includes(tab);
  const selectContent = (path: string, additive = false) => setSelectedContentPaths((current) => {
    if (!additive) return [path];
    return current.includes(path)
      ? current.filter((item) => item !== path)
      : [...current, path];
  });
  const setContentEntryEnabled = async (entry: InstanceFileEntry, enabled: boolean) => {
    if (!instance || !contentCanBeToggled || contentActionBusy) return;
    const isDisabled = entry.name.toLocaleLowerCase().endsWith(".off") || entry.name.toLocaleLowerCase().endsWith(".disabled");
    if (isDisabled === !enabled) return;
    setContentActionBusy(true);
    try {
      const target = await command<string>("set_instance_content_enabled", { instanceId: instance.id, category: tab, path: entry.path, enabled });
      setFiles((current) => current.map((item) => item.path === entry.path ? { ...item, path: target, name: target.replace(/^.*[\\/]/, "") } : item));
      setSelectedContentPaths((current) => current.map((path) => path === entry.path ? target : path));
      pushToast({ tone: "success", title: enabled ? tr("Content enabled") : tr("Content disabled"), message: entry.name });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Content could not be updated"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setContentActionBusy(false);
    }
  };
  const contentSelectionControl = (entry: InstanceFileEntry) => {
    const isDisabled = entry.name.toLocaleLowerCase().endsWith(".off") || entry.name.toLocaleLowerCase().endsWith(".disabled");
    return contentCanBeToggled ? <label className={styles.contentSelect} title={isDisabled ? tr("Enable") : tr("Disable")}><input type="checkbox" checked={!isDisabled} onChange={() => void setContentEntryEnabled(entry, isDisabled)} aria-label={`${isDisabled ? tr("Enable") : tr("Disable")} ${entry.name}`} /></label>
      : <label className={styles.contentSelect}><input type="checkbox" checked={selectedContentPaths.includes(entry.path)} onChange={(event) => { const native = event.nativeEvent as MouseEvent; selectContent(entry.path, native.ctrlKey || native.metaKey); }} aria-label={`${tr("Select")} ${entry.name}`} /></label>;
  };
  const screenshotSelectionControl = (entry: InstanceFileEntry) => {
    const selected = selectedContentPaths.includes(entry.path);
    return <button
      className={`${styles.screenshotSelectButton} ${selected ? styles.screenshotSelectButtonActive : ""}`}
      type="button"
      aria-label={`${selected ? tr("Deselect") : tr("Select")} ${entry.name}`}
      aria-pressed={selected}
      title={selected ? tr("Deselect") : tr("Select")}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        selectContent(entry.path, true);
      }}
    >{selected ? <Check size={15} weight="bold" /> : <Square size={15} />}</button>;
  };
  const deleteSelectedContent = async () => {
    if (!instance || selectedContent.length === 0 || contentActionBusy) return;
    setContentActionBusy(true);
    const failed: string[] = [];
    for (const entry of selectedContent) {
      try {
        await command("delete_instance_content", { instanceId: instance.id, category: tab, path: entry.path });
      } catch (error) {
        failed.push(`${entry.name}: ${String((error as { message?: string }).message ?? error)}`);
      }
    }
    const removed = selectedContent.filter((entry) => !failed.some((message) => message.startsWith(`${entry.name}:`)));
    setFiles((current) => current.filter((entry) => !removed.some((item) => item.path === entry.path)));
    setSelectedContentPaths([]);
    setContentActionBusy(false);
    if (failed.length > 0) {
      pushToast({ tone: "error", title: tr("Some items could not be removed"), message: failed[0] });
    } else {
      pushToast({ tone: "success", title: tr("Content removed"), message: `${removed.length} ${tr("items removed")}` });
    }
  };
  const setSelectedContentEnabled = async (enabled: boolean) => {
    if (!instance || !contentCanBeToggled || selectedContent.length === 0 || contentActionBusy) return;
    setContentActionBusy(true);
    const renamed = new Map<string, string>();
    const failed: string[] = [];
    for (const entry of selectedContent) {
      const isDisabled = entry.name.toLocaleLowerCase().endsWith(".off") || entry.name.toLocaleLowerCase().endsWith(".disabled");
      if (isDisabled === !enabled) continue;
      try {
        const target = await command<string>("set_instance_content_enabled", { instanceId: instance.id, category: tab, path: entry.path, enabled });
        renamed.set(entry.path, target);
      } catch (error) {
        failed.push(`${entry.name}: ${String((error as { message?: string }).message ?? error)}`);
      }
    }
    setFiles((current) => current.map((entry) => {
      const target = renamed.get(entry.path);
      return target ? { ...entry, path: target, name: target.replace(/^.*[\\/]/, "") } : entry;
    }));
    setSelectedContentPaths((current) => current.map((path) => renamed.get(path) ?? path));
    setContentActionBusy(false);
    if (failed.length > 0) {
      pushToast({ tone: "error", title: tr("Some items could not be updated"), message: failed[0] });
    } else if (renamed.size > 0) {
      pushToast({ tone: "success", title: enabled ? tr("Content enabled") : tr("Content disabled"), message: `${renamed.size} ${tr("items updated")}` });
    }
  };
  const openContentContextMenu = (event: React.MouseEvent<HTMLElement>, entry: InstanceFileEntry) => {
    event.preventDefault();
    if (!selectedContentPaths.includes(entry.path)) setSelectedContentPaths([entry.path]);
    window.dispatchEvent(new Event("slh-context-menu-open"));
    setContentContextMenu({ x: event.clientX, y: event.clientY });
  };
  const selectedEnabledCount = selectedContent.filter((entry) => {
    const name = entry.name.toLocaleLowerCase();
    return !name.endsWith(".off") && !name.endsWith(".disabled");
  }).length;
  const selectedDisabledCount = selectedContent.length - selectedEnabledCount;

  const normalizedPath = (path: string) => path.replace(/\\/g, "/").toLocaleLowerCase();
  const trackedFilePaths = new Set(updateRecords.map((record) => normalizedPath(record.filePath)));
  const fileEntries = files.filter((entry) => entry.entryType === "file");
  const untrackedFileCount = fileEntries.filter((entry) => !trackedFilePaths.has(normalizedPath(entry.path))).length;
  const updateCandidates = updateChecks.filter((item) => item.status === "update");
  const currentContentCount = updateChecks.filter((item) => item.status === "current").length;
  const failedUpdateChecks = updateChecks.filter((item) => item.status === "error").length;
  const hasStoreBedrockPackage = bedrockRuntime?.installedPackages.some((packageInfo) => packageInfo.signatureKind?.toLocaleLowerCase() === "store") ?? false;
  const hasLinkedStoreAccount = bedrockRuntime?.microsoftAuthenticated === true && Boolean(bedrockRuntime.storeAccountXuid);
  const nativeInstallerReady = bedrockRuntime?.nativeInstallerAvailable === true || hasStoreBedrockPackage;
  const bedrockSetupChecks = bedrockRuntime ? [
    { label: tr("Microsoft/Xbox account"), ready: hasLinkedStoreAccount, detail: hasLinkedStoreAccount ? tr("Linked") : tr("Required") },
    { label: tr("Native Bedrock installer"), ready: nativeInstallerReady, detail: bedrockRuntime.nativeInstallerAvailable ? tr("Available") : hasStoreBedrockPackage ? tr("Store package detected") : tr("Unavailable") },
    { label: tr("License"), ready: bedrockRuntime.storeAccountStatus === "ready" || bedrockRuntime.minecraftLicense === "release" || bedrockRuntime.minecraftLicense === "preview", detail: bedrockRuntime.minecraftLicense === "unknown" ? tr("Checked during native installation") : bedrockRuntime.minecraftLicense },
    { label: tr("Gaming Services"), ready: bedrockRuntime.gamingServicesInstalled, detail: bedrockRuntime.gamingServicesInstalled ? tr("Installed") : tr("Required") },
    { label: tr("GameInput"), ready: bedrockRuntime.gameInputInstalled, detail: bedrockRuntime.gameInputInstalled ? tr("Installed") : tr("Required") },
    { label: tr("Store/Xbox entitlement"), ready: bedrockRuntime.storeAccountStatus === "ready" || hasLinkedStoreAccount, detail: bedrockRuntime.storeAccountStatus === "ready" ? tr("Verified") : hasLinkedStoreAccount ? tr("Verified during installation") : tr("Required") },
  ] : [];

  return (
    <div className={`${styles.page} ${tabsPositionClass}`}>
      <header className={styles.header}>
        <InstanceArtwork instance={instance} size="small" />
        <div className={styles.identity}><h1>{instance.name}</h1><p>Minecraft {instance.minecraftVersion} · {instance.loaderType === "bedrock" ? "Bedrock" : instance.loaderType}</p></div>
        <div className={styles.headerMeta}><span><Clock size={15} /> {formatPlaytime(instance.playtimeSeconds, locale, tr)}</span><span className={instance.status === "installed" ? common.successBadge : common.badge}>{tr(instance.status)}</span></div>
        <button className={common.secondaryButton} type="button" onClick={() => void revealInstancePath(instance.id, instance.gameDir).catch((error) => pushToast({ tone: "error", title: tr("Folder could not be opened"), message: String((error as { message?: string }).message ?? error) }))}><FolderOpen size={17} /> {tr(isBedrock ? "Game data" : "Folder")}</button>
        <button className={instance.status === "running" ? `${launchStyles.playButton} ${launchStyles.killButton}` : common.button} type="button" disabled={busy || instanceOperationIds.includes(instance.id) || instance.status === "installing" || instance.status === "launching" || (isBedrock && bootstrap?.settings.bedrock.enabled === false && instance.status !== "running")} title={isBedrock && bootstrap?.settings.bedrock.enabled === false ? tr("Enable Bedrock in Settings first") : undefined} onClick={() => void (instance.status === "running" ? kill() : launch())}>{busy || instanceOperationIds.includes(instance.id) || instance.status === "launching" ? <SpinnerGap className={styles.spin} size={17} /> : instance.status === "running" ? <X size={20} weight="bold" /> : <Play size={17} weight="fill" />} {instance.status === "running" ? tr("Kill") : instance.status === "launching" ? tr("Launching") : instance.status === "installed" ? tr("Play") : instance.status === "error" ? tr("Repair") : tr("Install")}</button>
      </header>
      <nav className={styles.tabs} onContextMenu={openTabContextMenu}>
        {orderedVisibleTabs.map((item) => {
          const Icon = tabIcons[item];
          return <button
            type="button"
            className={`${tab === item ? styles.active : ""} ${tabDraggedId === item ? styles.tabDragging : ""} ${tabDropTarget?.id === item ? (tabDropTarget.after ? styles.tabInsertAfter : styles.tabInsertBefore) : ""}`}
            key={item}
            data-slh-instance-tab={item}
            data-minimal-compact
            aria-label={tr(isBedrock && item === "mods" ? "Add-ons" : tabLabels[item])}
            aria-current={tab === item ? "page" : undefined}
            onPointerDown={(event) => beginTabPointerDrag(event, item, "bar")}
            onClick={() => {
              if (suppressTabClickRef.current) {
                suppressTabClickRef.current = false;
                return;
              }
              navigate(`/instance/${instance.id}?tab=${item}`);
            }}
          ><Icon size={15} /><span data-minimal-text>{tr(isBedrock && item === "mods" ? "Add-ons" : tabLabels[item])}</span></button>;
        })}
      </nav>
      <main className={styles.content}>
        {tab === "overview" ? (
          <div className={styles.overview}>
            <section><h2>{tr("Instance")}</h2>{isBedrock ? <><dl><div><dt>{tr("Bedrock version")}</dt><dd>{instance.minecraftVersion}</dd></div><div><dt>{tr("Profile")}</dt><dd>{tr(instance.bedrockProfileMode === "isolated" ? "Isolated profile" : "Shared Store data")}</dd></div><div><dt>{tr("Java")}</dt><dd>{tr("Not used by Bedrock")}</dd></div></dl><p>{tr("Worlds, add-ons, and resource packs are managed in Minecraft's Bedrock data folders.")}</p></> : <dl><div><dt>{tr("Version")}</dt><dd>{instance.minecraftVersion}</dd></div><div><dt>{tr("Loader")}</dt><dd>{instance.loaderVersion ?? instance.loaderType}</dd></div><div><dt>{tr("Memory")}</dt><dd>{instance.memoryMinMb} {tr("to")} {instance.memoryMaxMb} {tr("MB")}</dd></div><div><dt>{tr("Java")}</dt><dd>{instance.javaPath ?? tr("Automatic")}</dd></div><div><dt>{tr("Game directory")}</dt><dd>{instance.gameDir}</dd></div></dl>}</section>
            <section><h2>{tr("Health and portability")}</h2><div className={styles.health}><span className={instance.status === "installed" ? common.successBadge : common.warningBadge}>{instance.status === "installed" ? tr("Ready") : tr("Attention")}</span><p>{instance.status === "installed" ? tr("Verified metadata and game files are installed.") : tr("Install or repair this instance before launching.")}</p><div className={styles.healthActions}><button className={common.secondaryButton} type="button" disabled={busy || instance.status === "running"} onClick={() => void repair()}><ArrowClockwise size={16} /> {tr("Repair")}</button><button className={common.secondaryButton} type="button" disabled={busy || instance.status === "running"} onClick={() => void openExportDialog()}><Export size={16} /> {tr("Export")}</button></div></div></section>
          </div>
        ) : (["mods", "resourcepacks", "shaders", "worlds", "screenshots"].includes(tab) || (isBedrock && tab === "logs")) ? (
          contentBrowserOpen && isBedrock && ["mods", "resourcepacks", "worlds"].includes(tab) ? <div className={styles.embeddedBrowser}><BedrockCatalog category={tab === "mods" ? "addons" : tab === "resourcepacks" ? "resourcepacks" : "worlds"} minecraftVersion={instance.minecraftVersion} sharedProfile={instance.bedrockProfileMode !== "isolated"} onClose={() => setContentBrowserOpen(false)} onImported={() => setContentRevision((value) => value + 1)} onCategoryChange={(category) => { const nextTab = category === "addons" ? "mods" : category; if (nextTab === tab) return; preserveBedrockBrowserRef.current = true; navigate(`/instance/${instance.id}?tab=${nextTab}`); }} /></div>
          : contentBrowserOpen && !isBedrock && tab !== "screenshots" ? <div className={styles.embeddedBrowser}><Suspense fallback={<div role="status">{tr("Loading")}</div>}><DiscoverPage embeddedInstanceId={instance.id} initialType={tab === "mods" ? "mod" : tab === "resourcepacks" ? "resourcepack" : tab === "shaders" ? "shader" : "world"} onClose={() => setContentBrowserOpen(false)} onInstalled={() => setContentRevision((value) => value + 1)} /></Suspense></div> : <div className={styles.fileIndex}>
            <header><div><h2>{tr(isBedrock && tab === "mods" ? "Add-ons" : isBedrock && tab === "logs" ? "Bedrock logs" : tabLabels[tab as InstanceTab])}</h2>{isBedrock && tab === "resourcepacks" ? <p>{tr("Bedrock visuals use resource packs and Vibrant Visuals; Java shader packs are not compatible.")}</p> : null}{isBedrock && instance.bedrockProfileMode === "isolated" && ["mods", "resourcepacks", "worlds"].includes(tab) ? <p>{tr("File imports open Minecraft's shared app profile. Switch to Shared Store data before importing to this instance.")}</p> : null}</div><div className={styles.fileActions}>
              {isBedrock ? <>
                {tab === "mods" || tab === "resourcepacks" || tab === "worlds" ? <button className={common.secondaryButton} type="button" onClick={() => setContentBrowserOpen(true)}><DownloadSimple size={16} /> {tr(tab === "mods" ? "Add-ons" : tab === "resourcepacks" ? "Resource packs" : "Worlds")}</button> : null}
                {tab === "mods" || tab === "resourcepacks" ? <button className={common.secondaryButton} type="button" disabled={instance.bedrockProfileMode === "isolated"} onClick={() => void importBedrockFiles(["mcpack", "mcaddon"], tr("Bedrock add-ons and resource packs"))}><DownloadSimple size={16} /> {tr("Import pack")}</button> : null}
                {tab === "worlds" ? <button className={common.secondaryButton} type="button" disabled={instance.bedrockProfileMode === "isolated"} onClick={() => void importBedrockFiles(["mcworld"], tr("Bedrock worlds"))}><DownloadSimple size={16} /> {tr("Import world")}</button> : null}
                {tab === "logs" ? <button className={common.secondaryButton} type="button" onClick={() => void revealInstancePath(instance.id, instanceLogDirectory(instance.gameDir)).catch((error) => pushToast({ tone: "error", title: tr("Log folder could not be opened"), message: String((error as { message?: string }).message ?? error) }))}><FolderOpen size={16} /> {tr("Log folder")}</button> : null}
                {tab !== "logs" ? <button className={common.secondaryButton} type="button" onClick={() => setContentRevision((value) => value + 1)}><ArrowClockwise size={16} /> {tr("Refresh")}</button> : null}
              </> : contentProjectTypes[tab] ? <><button className={common.secondaryButton} type="button" disabled={contentActionBusy} onClick={() => setContentBrowserOpen(true)}><DownloadSimple size={16} /> {tr(contentDownloadLabels[tab])}</button><button className={common.secondaryButton} type="button" disabled={contentActionBusy} onClick={() => void updateContentNow()}>{contentActionBusy ? <SpinnerGap className={styles.spin} size={16} /> : <ArrowClockwise size={16} />} {tr("Update")}</button></> : null}
              {tab === "screenshots" ? <button className={common.secondaryButton} type="button" aria-pressed={screenshotsNewestFirst} onClick={() => setScreenshotsNewestFirst((current) => !current)}><Funnel size={16} /> {screenshotsNewestFirst ? tr("Newest first") : tr("Oldest first")}</button> : null}<span className={common.badge}>{files.length} {tr(files.length === 1 ? "item" : "items")}</span></div></header>
            {selectedContent.length > 0 && !(isBedrock && tab === "logs") ? <div className={styles.selectionBar}>
              <span><strong>{selectedContent.length}</strong> {tr(selectedContent.length === 1 ? "item selected" : "items selected")}</span>
              <div>
                {contentCanBeToggled ? <>
                  <button className={common.secondaryButton} type="button" disabled={contentActionBusy || !selectedContent.some((entry) => { const name = entry.name.toLocaleLowerCase(); return !name.endsWith(".off") && !name.endsWith(".disabled"); })} onClick={() => void setSelectedContentEnabled(false)}>{tr("Disable")}</button>
                  <button className={common.secondaryButton} type="button" disabled={contentActionBusy || !selectedContent.some((entry) => { const name = entry.name.toLocaleLowerCase(); return name.endsWith(".off") || name.endsWith(".disabled"); })} onClick={() => void setSelectedContentEnabled(true)}>{tr("Enable")}</button>
                </> : null}
                <button className={common.dangerButton} type="button" disabled={contentActionBusy} onClick={() => void deleteSelectedContent()}><Trash size={16} /> {tr("Delete")}</button>
                <button className={common.ghostButton} type="button" disabled={contentActionBusy} onClick={() => setSelectedContentPaths([])}>{tr("Clear selection")}</button>
              </div>
            </div> : null}
            {filesLoading ? <div className={styles.tabEmpty}><SpinnerGap className={styles.spin} size={30} /><p>{tr("Indexing files")}</p></div> : files.length === 0 ? <div className={styles.tabEmpty}><File size={34} weight="duotone" /><h2>{tr(isBedrock && tab === "logs" ? "No Bedrock logs found" : "No compatible content found")}</h2><p>{tr(isBedrock && tab === "mods" ? "Import a Bedrock pack or browse CurseForge to get started." : isBedrock && tab === "resourcepacks" ? "Import a Bedrock resource pack or browse the catalog. Bedrock uses resource packs for visual changes." : isBedrock && tab === "worlds" ? "Import a .mcworld file or choose a world in Minecraft." : isBedrock && tab === "screenshots" ? "Windows captures are shown here when they are saved in the standard Captures or Screenshots folder." : isBedrock && tab === "logs" ? "Bedrock log files appear here when Minecraft creates them." : "Install content matched to this instance or place files in its folder.")}</p></div> : tab === "screenshots" ? <div className={styles.screenshotGrid}>{displayedFiles.map((entry) => <div className={`${styles.screenshotItem} ${selectedContentPaths.includes(entry.path) ? styles.contentSelected : ""}`} key={entry.path} onContextMenu={(event) => openContentContextMenu(event, entry)}>{screenshotSelectionControl(entry)}<button className={styles.screenshotOpenButton} type="button" aria-label={`${tr("Open")} ${entry.name}`} onClick={(event) => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); selectContent(entry.path, true); return; } void openScreenshot(entry); }}><ScreenshotPreview instanceId={instance.id} entry={entry} /><span><strong>{entry.name}</strong><small>{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString(locale) : formatBytes(entry.sizeBytes)}</small></span></button></div>)}</div> : <div className={styles.fileList}>{displayedFiles.map((entry) => <div className={`${styles.fileRow} ${selectedContentPaths.includes(entry.path) ? styles.contentSelected : ""}`} key={entry.path} onContextMenu={isBedrock && tab === "logs" ? undefined : (event) => openContentContextMenu(event, entry)}>{isBedrock && tab === "logs" ? <button className={styles.fileOpen} type="button" onClick={() => void revealInstancePath(instance.id, entry.path).catch((error) => pushToast({ tone: "error", title: tr("Log could not be opened"), message: String((error as { message?: string }).message ?? error) }))}><span className={styles.fileIcon}><FileText size={19} /></span><span><strong>{entry.name}</strong><small>{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString(locale) : tr("Modified time unavailable")}</small></span><span>{formatBytes(entry.sizeBytes)}</span></button> : <>{contentSelectionControl(entry)}<button className={styles.fileOpen} type="button" aria-pressed={selectedContentPaths.includes(entry.path)} onClick={(event) => selectContent(entry.path, event.ctrlKey || event.metaKey)}><span className={`${styles.fileIcon} ${entry.iconDataUrl ? styles.fileArtwork : ""}`}>{entry.iconDataUrl ? <img src={entry.iconDataUrl} alt="" /> : entry.entryType === "directory" ? <FolderOpen size={19} /> : <File size={19} />}</span><span><strong>{entry.name}</strong><small>{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString(locale) : tr("Modified time unavailable")}</small></span><span>{formatBytes(entry.sizeBytes)}</span></button><button className={`${common.iconButton} ${styles.contentDelete}`} type="button" disabled={contentActionBusy} aria-label={`${tr("Delete")} ${entry.name}`} title={tr("Delete without confirmation")} onClick={() => void deleteContentEntry(entry)}><Trash size={16} /></button></>}</div>)}</div>}
          </div>
        ) : tab === "logs" ? (
          <div className={styles.consolePanel}>
            <header><h2>{tr("Minecraft log")}</h2><div className={styles.fileActions}><button className={common.secondaryButton} type="button" aria-pressed={bootstrap.settings.console.autoScroll} onClick={() => void updateConsole({ autoScroll: !bootstrap.settings.console.autoScroll })}>{tr("Follow")}: {bootstrap.settings.console.autoScroll ? tr("on") : tr("off")}</button><button className={common.secondaryButton} type="button" aria-pressed={bootstrap.settings.console.wrapLines} onClick={() => void updateConsole({ wrapLines: !bootstrap.settings.console.wrapLines })}>{tr("Wrap")}: {bootstrap.settings.console.wrapLines ? tr("on") : tr("off")}</button><button className={common.secondaryButton} type="button" onClick={() => void copyConsole()}>{tr("Copy")}</button><button className={common.secondaryButton} type="button" onClick={() => setConsoleLines([])}>{tr("Clear view")}</button><button className={common.secondaryButton} type="button" onClick={() => void revealInstancePath(instance.id, instanceLogDirectory(instance.gameDir)).catch((error) => pushToast({ tone: "error", title: tr("Log folder could not be opened"), message: String((error as { message?: string }).message ?? error) }))}><FolderOpen size={16} /> {tr("Log folder")}</button></div></header>
            <div className={styles.consoleSearch}><input className={common.input} value={consoleQuery} onChange={(event) => setConsoleQuery(event.target.value)} placeholder={tr("Find in log")} /><span>{filteredConsoleLines(consoleLines, consoleQuery).length} {tr("shown")}</span><button className={common.secondaryButton} type="button" onClick={() => { const target = consoleScrollRef.current; if (target) target.scrollTop = target.scrollHeight; }}>{tr("Bottom")}</button></div>
            {consoleLoading ? <div className={styles.tabEmpty}><SpinnerGap className={styles.spin} size={30} /><p>{tr("Loading console")}</p></div> : <div ref={consoleScrollRef} className={`${styles.consoleOutput} ${bootstrap.settings.console.wrapLines ? styles.consoleWrap : ""}`} style={{ background: bootstrap.settings.console.background, color: bootstrap.settings.console.foreground, fontSize: `${bootstrap.settings.console.fontSize}px` }}>{consoleLines.length === 0 ? <div className={styles.consoleEmpty}>{tr("Minecraft output will appear here when the game starts.")}</div> : filteredConsoleLines(consoleLines, consoleQuery).map((line, index) => <div className={styles.consoleLine} key={`${line.timestamp ?? "line"}-${index}`}><span style={{ color: consoleLineColor(line.level, bootstrap.settings.console) }}>{formatConsoleText(line.text, bootstrap.settings.console.showTimestamps)}</span></div>)}</div>}
          </div>
        ) : tab === "settings" ? (
          <div className={styles.instanceSettings}>
            <section>
              <header><h2>{tr("Instance layout")}</h2></header>
              <div className={styles.interfaceSettingsBody}>
                <label className={common.field}>
                  <span className={common.label}>{tr("Tabs position")}</span>
                  <select className={common.select} value={configuredTabsPosition ?? "top"} onChange={(event) => void saveInstanceTabsPosition(event.target.value as InstanceTabsPosition)}>
                    {instanceTabsPositionOptions.map(([position, label]) => <option value={position} key={position}>{tr(label)}</option>)}
                  </select>
                </label>
              </div>
            </section>
            <section className={styles.identitySettings}>
              <header><h2>{tr("Name and artwork")}</h2></header>
              <div className={styles.identityForm}>
                <label className={common.field}><span className={common.label}>{tr("Instance name")}</span><input className={common.input} maxLength={80} value={instanceName} onChange={(event) => setInstanceName(event.target.value)} /></label>
                <div className={styles.artworkEditor}>
                  <InstanceArtwork instance={{ ...instance, iconKey, iconBackground, iconForeground }} size="small" />
                  <div><strong>{tr("Instance icon")}</strong><small>{tr("Choose a pixel icon and two custom colors.")}</small></div>
                </div>
                <div className={styles.iconPicker} role="radiogroup" aria-label={tr("Instance icon")}>
                  {instanceIconChoices.map(({ key, label, Icon }) => <button key={key} type="button" className={iconKey === key ? styles.iconSelected : ""} role="radio" aria-checked={iconKey === key} title={label} onClick={() => setIconKey(key)}><Icon size={20} /><span>{label}</span></button>)}
                </div>
                <div className={styles.instanceColors}>
                  <label><span>{tr("Background")}</span><span><input type="color" value={iconBackground} onChange={(event) => setIconBackground(event.target.value)} /><code>{iconBackground}</code></span></label>
                  <label><span>{tr("Icon")}</span><span><input type="color" value={iconForeground} onChange={(event) => setIconForeground(event.target.value)} /><code>{iconForeground}</code></span></label>
                </div>
                <div className={styles.identityActions}><span>{tr("Folder")}: <code>{instance.folderName}</code></span><button className={common.button} type="button" disabled={identityBusy || !instanceName.trim()} onClick={() => void saveIdentity()}>{identityBusy ? <SpinnerGap className={styles.spin} size={16} /> : <Check size={16} />} {tr("Save changes")}</button></div>
              </div>
            </section>
            <section>
              <header><h2>{tr(isBedrock ? "Bedrock version" : "Minecraft version and loader")}</h2></header>
              {isBedrock ? <div className={styles.loaderEditor}>
                <label className={common.field}><span className={common.label}>{tr("Bedrock version")}</span><select className={common.select} value={settingsMinecraftVersion} onChange={(event) => setSettingsMinecraftVersion(event.target.value)}>{settingsMinecraftVersions.map((version) => <option value={version.id} key={version.id}>{version.id}</option>)}</select></label>
                {loaderError ? <p className={styles.loaderError}>{loaderError}</p> : null}
                <div className={styles.memoryActions}><span>{tr("Choose the Bedrock release used by this launcher profile.")}</span><button className={common.button} type="button" disabled={loaderBusy || loaderLoading || !settingsMinecraftVersion} onClick={() => void saveLoader()}>{loaderBusy ? <SpinnerGap className={styles.spin} size={16} /> : <Check size={16} />} {tr("Save Bedrock version")}</button></div>
              </div> : <div className={styles.loaderEditor}>
                <label className={common.field}><span className={common.label}>{tr("Minecraft version")}</span><select className={common.select} value={settingsMinecraftVersion} onChange={(event) => { setSettingsMinecraftVersion(event.target.value); setSettingsLoaderVersion(null); }}>{settingsMinecraftVersions.map((version) => <option value={version.id} key={version.id}>{version.id}</option>)}</select></label>
                <label className={common.field}><span className={common.label}>{tr("Loader type")}</span><select className={common.select} value={settingsLoader} onChange={(event) => { setSettingsLoader(event.target.value as Instance["loaderType"]); setSettingsLoaderVersion(null); }}><option value="vanilla">Vanilla</option><option value="bedrock">Bedrock</option><option value="fabric">Fabric</option><option value="forge">Forge</option><option value="neoforge">NeoForge</option><option value="quilt">Quilt</option></select></label>
                {settingsLoader !== "vanilla" && settingsLoader !== "bedrock" ? <label className={common.field}><span className={common.label}>{tr(settingsLoader)} {tr("version")}</span><select className={common.select} value={settingsLoaderVersion ?? ""} disabled={loaderLoading || settingsLoaderVersions.length === 0} onChange={(event) => setSettingsLoaderVersion(event.target.value || null)}><option value="">{loaderLoading ? tr("Loading compatible versions") : tr("Select a compatible version")}</option>{settingsLoaderVersions.map((item) => <option value={item.id} key={item.id}>{item.id}{item.recommended ? ` (${tr("recommended")})` : ""}</option>)}</select></label> : null}
                {loaderError ? <p className={styles.loaderError}>{loaderError}</p> : null}
                <div className={styles.memoryActions}><span>Minecraft {instance.minecraftVersion} · {instance.loaderType}{instance.loaderVersion ? ` ${instance.loaderVersion}` : ""}</span><div className={styles.loaderActions}>{!isBedrock ? <button className={common.secondaryButton} type="button" disabled={loaderBusy || loaderLoading || instance.status === "running" || instance.status === "launching" || instance.status === "installing" || instanceOperationIds.includes(instance.id)} onClick={() => setVersionMigrationOpen(true)}><ArrowClockwise size={16} /> {tr("Adapt build")}</button> : null}<button className={common.button} type="button" disabled={loaderBusy || loaderLoading || !settingsMinecraftVersion || (settingsLoader !== "vanilla" && settingsLoader !== "bedrock" && !settingsLoaderVersion)} onClick={() => void saveLoader()}>{loaderBusy ? <SpinnerGap className={styles.spin} size={16} /> : <Check size={16} />} {tr("Save version and loader")}</button></div></div>
              </div>}
            </section>
            <section>
              <header><h2>{instance.loaderType === "bedrock" ? tr("Bedrock runtime") : tr("Runtime and memory")}</h2></header>
              {instance.loaderType !== "bedrock" ? <dl><div><dt>{tr("Java")}</dt><dd>{instance.javaPath ?? tr("Automatic")}</dd></div></dl> : null}
              {instance.loaderType === "bedrock" ? (
                <div className={styles.memoryEditor}>
                  {!hasStoreBedrockPackage ? (
                    <label className={common.field}>
                      <span className={common.label}>{tr("Bedrock profile")}</span>
                      <select className={common.select} value={bedrockProfileMode} onChange={(event) => setBedrockProfileMode(event.target.value as "isolated" | "shared")}>
                        <option value="isolated">{tr("Isolated profile")}</option>
                        <option value="shared">{tr("Shared Store data")}</option>
                      </select>
                    </label>
                  ) : null}
              <div className={styles.memoryActions}>
                    <span>{bedrockRuntimeBusy
                      ? tr("Checking Bedrock runtime")
                      : hasStoreBedrockPackage
                        ? tr("Using the registered Microsoft Store package. Developer Mode is not used.")
                        : bedrockRuntime?.message ?? (bedrockRuntime?.launchReady ? tr("Bedrock ready to launch") : tr("Bedrock needs Microsoft Store/Xbox setup"))}</span>
                    <div className={styles.bedrockRuntimeActions}>
                      {!hasStoreBedrockPackage ? <>
                        <button className={common.button} type="button" disabled={bedrockSetupBusy} onClick={() => { setBedrockSetupError(bedrockRuntime?.message ?? null); setBedrockSetupDialogOpen(true); }}>{bedrockSetupBusy ? <SpinnerGap className={styles.spin} size={16} /> : <DownloadSimple size={16} />} {tr("Prepare Bedrock")}</button>
                        <button className={common.secondaryButton} type="button" onClick={() => { setBedrockRuntimeBusy(true); void command<BedrockRuntimeStatus>("bind_bedrock_store_account").then(setBedrockRuntime).catch((error) => setBedrockRuntimeError(String((error as { message?: string }).message ?? error))).finally(() => setBedrockRuntimeBusy(false)); }}>{tr("Bind Store/Xbox account")}</button>
                      </> : null}
                      <button className={common.secondaryButton} type="button" onClick={() => void command("open_bedrock_store").catch((error) => pushToast({ tone: "error", title: tr("Microsoft Store could not be opened"), message: String((error as { message?: string }).message ?? error) }))}>{tr("Microsoft Store")}</button>
                      <button className={common.secondaryButton} type="button" onClick={() => void command("open_bedrock_xbox").catch((error) => pushToast({ tone: "error", title: tr("Xbox could not be opened"), message: String((error as { message?: string }).message ?? error) }))}>{tr("Xbox app")}</button>
                    </div>
                  </div>
                  {bedrockRuntimeError ? <p className={styles.loaderError}>{bedrockRuntimeError}</p> : null}
                  {hasStoreBedrockPackage ? (
                    <dl>
                      <div><dt>{tr("Bound Xbox gamertag")}</dt><dd>{bedrockRuntime?.storeAccountGamertag ?? (bedrockRuntime?.microsoftAuthenticated ? tr("Authenticated") : tr("Required"))}</dd></div>
                      <div><dt>{tr("Microsoft Store")}</dt><dd>{tr("Store package detected")}</dd></div>
                      <div><dt>{tr("License")}</dt><dd>{tr("Checked by Windows at launch")}</dd></div>
                    </dl>
                  ) : (
                    <dl><div><dt>{tr("Bound Xbox gamertag")}</dt><dd>{bedrockRuntime?.storeAccountGamertag ?? (bedrockRuntime?.storeAccountXuid ? tr("Linked") : tr("Required"))}</dd></div><div><dt>{tr("Native installer")}</dt><dd>{bedrockRuntime?.nativeInstallerAvailable ? tr("Available") : tr("Unavailable")}</dd></div><div><dt>{tr("License")}</dt><dd>{bedrockRuntime?.minecraftLicense !== "unknown" ? bedrockRuntime?.minecraftLicense : bedrockRuntime?.storeAccountStatus === "ready" ? tr("Verified") : tr("Checked during installation")}</dd></div><div><dt>{tr("Gaming Services")}</dt><dd>{bedrockRuntime?.gamingServicesInstalled ? tr("Installed") : tr("Required")}</dd></div><div><dt>{tr("GameInput")}</dt><dd>{bedrockRuntime?.gameInputInstalled ? tr("Installed") : tr("Required")}</dd></div>{bedrockRuntime?.developerMode ? <div><dt>{tr("Windows Developer Mode")}</dt><dd>{tr("Available for package registration")}</dd></div> : null}{bedrockRuntime?.wdappAvailable ? <div><dt>{tr("wdapp")}</dt><dd>{tr("Development tool available")}</dd></div> : null}</dl>
                  )}
                  {!hasStoreBedrockPackage ? <div className={styles.memoryActions}><span>{tr("Save profile mode before launching.")}</span><button className={common.button} type="button" disabled={loaderBusy || loaderLoading || !settingsMinecraftVersion} onClick={() => void saveLoader()}>{loaderBusy ? <SpinnerGap className={styles.spin} size={16} /> : <Check size={16} />} {tr("Save Bedrock settings")}</button></div> : null}
                </div>
              ) : null}
              {instance.loaderType !== "bedrock" ? <div className={styles.memoryEditor}>
                <label className={common.field}><span className={common.label}>{tr("Minimum memory (MB)")}</span><input className={common.input} type="number" min={256} step={256} value={memoryMinMb} onChange={(event) => setMemoryMinMb(Number(event.target.value) || 0)} /></label>
                <label className={common.field}><span className={common.label}>{tr("Maximum memory (MB)")}</span><input className={common.input} type="number" min={256} step={256} value={memoryMaxMb} onChange={(event) => setMemoryMaxMb(Number(event.target.value) || 0)} /></label>
          <div className={styles.memoryActions}><span>{(memoryMaxMb / 1024).toFixed(memoryMaxMb % 1024 === 0 ? 0 : 1)} {tr("GB")} {tr("maximum")}</span><button className={common.button} type="button" disabled={memoryBusy} onClick={() => void saveMemory()}>{memoryBusy ? <SpinnerGap className={styles.spin} size={16} /> : <Check size={16} />} {tr("Save memory")}</button></div>
              </div> : null}
            </section>
            <section className={styles.dangerZone}>
              <header><h2>{tr("Delete instance")}</h2></header>
              <div><span><strong>{instance.name}</strong><small>{isBedrock ? tr(instance.bedrockProfileMode === "isolated" ? "Deleting this instance also removes its isolated Bedrock worlds and packs." : "Shared Minecraft worlds and packs stay on this PC when deleting the launcher profile.") : instance.gameDir}</small></span><button className={common.dangerButton} type="button" disabled={busy || instance.status === "running"} onClick={() => void deleteInstance()}><Trash size={16} /> {tr("Delete")}</button></div>
            </section>
          </div>
        ) : (
          <div className={styles.tabEmpty}><WarningCircle size={34} weight="duotone" /><h2>{tr(tab[0].toUpperCase() + tab.slice(1))} {tr("indexing is not active yet")}</h2><p>{tr("SLH leaves existing files untouched until this view has a safe reader, preview, and confirmed write path.")}</p></div>
        )}
      </main>
      {tabContextMenu ? (
        <div ref={tabContextMenuRef} className={`${menuStyles.menu} ${menuStyles.instanceTabsMenu} slh-instance-tab-context-menu slh-context-menu`} role="menu" aria-label={tr("Instance tabs")} style={{ left: tabContextMenu.x, top: tabContextMenu.y }} onPointerDown={(event) => { event.stopPropagation(); if (event.button === 2) beginTabMenuMove(event); }} onMouseDown={(event) => { if (event.button === 2) beginTabMenuMove(event); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}>
            <header onPointerDown={beginTabMenuMove} onMouseDown={(event) => { if (event.button === 2) beginTabMenuMove(event); }}><GearSix size={17} /><strong>{tr("Instance tabs")}</strong></header>
            <div>{tabOrder.filter((item) => !isBedrock || (item !== "shaders" && item !== "screenshots")).map((item) => {
              const Icon = tabIcons[item];
              const visible = visibleTabIds.has(item);
              const target = tabDropTarget?.id === item;
              return <div key={item}>
                {item === "settings" ? <div className={menuStyles.separator} aria-hidden="true" /> : null}
                <div className={`${menuStyles.itemRow} ${tabDraggedId === item ? menuStyles.dragging : ""} ${target ? (tabDropTarget?.after ? menuStyles.insertAfter : menuStyles.insertBefore) : ""}`} data-slh-instance-tab-menu={item} aria-grabbed={tabDraggedId === item} onPointerDown={(event) => beginTabPointerDrag(event, item, "menu")}>
                  <button type="button" className={menuStyles.itemToggle} role="menuitemcheckbox" aria-checked={visible} onClick={() => {
                    if (suppressTabClickRef.current) {
                      suppressTabClickRef.current = false;
                      return;
                    }
                    void toggleInstanceTab(item);
                  }}>
                    <span className={menuStyles.check}>{visible ? <Check size={16} /> : null}</span><Icon size={18} /><span>{tr(isBedrock && item === "mods" ? "Add-ons" : tabLabels[item])}</span>
                  </button>
                </div>
              </div>;
            })}</div>
        </div>
      ) : null}
      {tabDragPreview ? <div className={menuStyles.dragPreview} style={{ left: tabDragPreview.x, top: tabDragPreview.y }} aria-hidden="true">{tabDragPreview.label}</div> : null}
      {contentContextMenu && selectedContent.length > 0 ? (
        <div ref={contentContextMenuRef} className={`${styles.contentContextMenu} slh-content-context-menu slh-context-menu`} style={{ left: contentContextMenu.x, top: contentContextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <header><strong>{selectedContent.length} {tr(selectedContent.length === 1 ? "item selected" : "items selected")}</strong></header>
          {contentCanBeToggled ? <>
            <button type="button" disabled={contentActionBusy || selectedEnabledCount === 0} onClick={() => { setContentContextMenu(null); void setSelectedContentEnabled(false); }}>{tr("Disable")}</button>
            <button type="button" disabled={contentActionBusy || selectedDisabledCount === 0} onClick={() => { setContentContextMenu(null); void setSelectedContentEnabled(true); }}>{tr("Enable")}</button>
          </> : null}
          <button className={styles.contentContextDanger} type="button" disabled={contentActionBusy} onClick={() => { setContentContextMenu(null); void deleteSelectedContent(); }}><Trash size={15} /> {tr("Delete")}</button>
          <button type="button" disabled={contentActionBusy} onClick={() => { setSelectedContentPaths([]); setContentContextMenu(null); }}>{tr("Clear selection")}</button>
        </div>
      ) : null}
      <Dialog open={exportDialogOpen} title={tr("Export instance")} description={tr(isBedrock ? "Export selected Bedrock worlds and packs as a ZIP archive." : "Choose an archive format and the files to include.")} onClose={() => { if (!exportRunning) setExportDialogOpen(false); }} width="medium">
        <div className={styles.exportDialog}>
          <section className={styles.exportSection}>
            {!isBedrock ? <><h3>{tr("Export format")}</h3><div className={styles.exportFormats}>
              {([
                ["zip", "ZIP archive", "A regular archive with the selected game files."],
                ["curseforge", "CurseForge ZIP", "A CurseForge manifest with selected files in overrides."],
                ["mrpack", "Modrinth mrpack", "A Modrinth index with selected files in overrides."],
              ] as const).map(([value, label, description]) => <button type="button" key={value} className={exportFormat === value ? styles.exportFormatActive : ""} onClick={() => setExportFormat(value)}><span className={styles.exportRadio}>{exportFormat === value ? <Check size={13} /> : null}</span><span><strong>{tr(label)}</strong><small>{tr(description)}</small></span></button>)}
            </div></> : <><h3>{tr("Bedrock ZIP export")}</h3><p>{tr("Only the selected Bedrock worlds, add-ons, and resource packs are included.")}</p></>}
          </section>
          <section className={styles.exportSection}>
            <header><span><h3>{tr("Files and folders")}</h3><small>{tr(isBedrock ? "Bedrock logs and account data are excluded." : "Logs, crash reports, and account data are always excluded.")}</small></span><span className={styles.exportSelectionActions}><button type="button" onClick={() => setExportSelected([])}>{tr("Clear selection")}</button><button type="button" onClick={() => setExportSelected(exportEntries.map((entry) => entry.relativePath))}>{tr("Select all")}</button></span></header>
            {exportLoading ? <div className={styles.exportState}><SpinnerGap className={styles.spin} size={18} /> {tr("Indexing files")}</div> : <div className={styles.exportEntries}>{exportEntries.map((entry) => { const checked = exportSelected.includes(entry.relativePath); return <label key={entry.relativePath}><input type="checkbox" checked={checked} onChange={() => setExportSelected((current) => checked ? current.filter((item) => item !== entry.relativePath) : [...current, entry.relativePath])} /><span className={styles.exportEntryIcon}>{entry.isDirectory ? <FolderOpen size={17} /> : <File size={17} />}</span><span><strong>{entry.relativePath}</strong><small>{entry.files} {tr(entry.files === 1 ? "file" : "files")}</small></span><b>{formatBytes(entry.sizeBytes)}</b></label>; })}</div>}
          </section>
          <div className={styles.exportFooter}><span>{exportSelected.length} / {exportEntries.length} {tr("selected")}</span><div><button className={common.secondaryButton} type="button" disabled={exportRunning} onClick={() => setExportDialogOpen(false)}>{tr("Cancel")}</button><button className={common.button} type="button" disabled={exportLoading || exportRunning || exportSelected.length === 0} onClick={() => void exportArchive()}>{exportRunning ? <SpinnerGap className={styles.spin} size={16} /> : <Export size={16} />} {tr("Export")}</button></div></div>
        </div>
      </Dialog>
      <Dialog open={updateDialogOpen} title={tr("Update installed content")} description={tr("Review compatible updates before changing files in this instance.")} onClose={() => { if (!updateRunning) setUpdateDialogOpen(false); }} width="medium">
        <div className={styles.updateDialog}>
          <div className={styles.updateFeature}><ArrowClockwise size={28} /><span><strong>{tr("Verified content updates")}</strong><small>{tr("Only files matched to their exact project are replaced. Unknown files remain untouched.")}</small></span></div>
          <div className={styles.updateOverview}>
            <span><strong>{updateCandidates.length}</strong><small>{tr("updates available")}</small></span>
            <span><strong>{currentContentCount}</strong><small>{tr("already up to date")}</small></span>
            <span><strong>{untrackedFileCount}</strong><small>{tr("files without a known source")}</small></span>
          </div>
          {updateCandidates.length > 0 ? <div className={styles.updateCandidateList}>{updateCandidates.map(({ record, nextVersion }) => <div key={`${record.provider}:${record.projectId}`}><span><strong>{record.displayName}</strong><small>{nextVersion ? `${tr("New version")}: ${nextVersion}` : tr("Compatible update available")}</small></span><span className={common.warningBadge}>{tr("Update")}</span></div>)}</div> : !updateLoading ? <div className={styles.updateEmpty}><Check size={20} /><span><strong>{tr("Everything is up to date")}</strong><small>{failedUpdateChecks > 0 ? tr("Some files could not be checked.") : tr("No compatible updates were found.")}</small></span></div> : null}
          {updateLoading ? <div className={styles.updateState}><SpinnerGap className={styles.spin} size={18} /> {tr("Indexing installed content")}</div> : updateRunning ? <div className={styles.updateState}><SpinnerGap className={styles.spin} size={18} /> {tr("Updating")} {updateProgress.current} / {updateProgress.total}</div> : null}
          <div className={styles.updateActions}><button className={common.secondaryButton} type="button" disabled={updateRunning} onClick={() => setUpdateDialogOpen(false)}>{tr("Cancel")}</button><button className={common.button} type="button" disabled={updateLoading || updateRunning || updateCandidates.length === 0} onClick={() => void updateTrackedContent()}><ArrowClockwise size={16} /> {tr("Update all")}</button></div>
        </div>
      </Dialog>
      <Dialog open={bedrockSetupDialogOpen} title={tr("Prepare Bedrock")} description={tr("SLH will download official Microsoft components. Windows may show one UAC confirmation.")} onClose={() => { if (!bedrockSetupBusy) setBedrockSetupDialogOpen(false); }} width="medium">
        <div className={styles.bedrockSetupDialog}>
          <div className={styles.bedrockSetupFeature}><DownloadSimple size={28} /><span><strong>{tr("Automatic Bedrock setup")}</strong><small>{tr("SLH downloads and checks the required Windows components, then retries the launch automatically.")}</small></span></div>
          <div className={styles.bedrockSetupChecks}>
            {bedrockRuntime ? bedrockSetupChecks.map((check) => <div className={styles.bedrockSetupCheck} key={check.label}><span className={check.ready ? styles.bedrockSetupCheckReady : styles.bedrockSetupCheckMissing}>{check.ready ? <Check size={15} /> : <WarningCircle size={15} />}</span><span><strong>{check.label}</strong><small>{check.detail}</small></span></div>) : <div className={styles.bedrockSetupState}><SpinnerGap className={styles.spin} size={18} /> {tr("Checking Bedrock runtime")}</div>}
          </div>
          <p className={styles.bedrockSetupHint}>{tr("The Xbox player inside Bedrock can differ from the Store account. Check the Xbox app gamertag, then sign out and back in inside Minecraft if it shows the wrong player.")}</p>
          {bedrockSetupError ? <p className={styles.loaderError}>{bedrockSetupError}</p> : null}
          <div className={styles.bedrockSetupActions}><button className={common.secondaryButton} type="button" disabled={bedrockSetupBusy} onClick={() => setBedrockSetupDialogOpen(false)}>{tr("Cancel")}</button><button className={common.secondaryButton} type="button" disabled={bedrockSetupBusy} onClick={() => void command("open_bedrock_store").catch((error) => setBedrockSetupError(String((error as { message?: string }).message ?? error)))}>{tr("Microsoft Store")}</button><button className={common.secondaryButton} type="button" disabled={bedrockSetupBusy} onClick={() => void command("open_bedrock_xbox").catch((error) => setBedrockSetupError(String((error as { message?: string }).message ?? error)))}>{tr("Xbox app")}</button><button className={common.button} type="button" disabled={bedrockSetupBusy} onClick={() => void prepareBedrockRuntime()}>{bedrockSetupBusy ? <SpinnerGap className={styles.spin} size={16} /> : <DownloadSimple size={16} />} {bedrockSetupBusy ? tr("Preparing Bedrock") : tr("Download and prepare")}</button></div>
        </div>
      </Dialog>
      <Dialog open={offlineNameDialogOpen} title={tr("Offline launch")} description={tr("No internet connection is available. The selected online account will remain selected; this launch uses a temporary offline identity only.")} onClose={() => setOfflineNameDialogOpen(false)} width="small">
        <form className={styles.offlineLaunchForm} onSubmit={(event) => { event.preventDefault(); const username = offlineName.trim(); if (!username) return; setOfflineNameDialogOpen(false); void launch(username); }}>
          <label><span>{tr("Minecraft nickname")}</span><input className={common.input} autoFocus maxLength={16} value={offlineName} onChange={(event) => setOfflineName(event.target.value)} placeholder={tr("Player")} /></label>
          <small>{tr("Use 3–16 Latin letters, numbers, or underscores.")}</small>
          <div><button className={common.secondaryButton} type="button" onClick={() => setOfflineNameDialogOpen(false)}>{tr("Cancel")}</button><button className={common.button} type="submit" disabled={!offlineName.trim()}><Play size={16} /> {tr("Launch offline")}</button></div>
        </form>
      </Dialog>
      {versionMigrationOpen ? <InstanceVersionMigrationDialog
        instance={instance}
        onClose={() => setVersionMigrationOpen(false)}
        onCreated={(result) => {
          setVersionMigrationOpen(false);
          navigate(`/instance/${result.instance.id}`);
        }}
      /> : null}
    </div>
  );
}

function ScreenshotPreview({ instanceId, entry }: { instanceId: string; entry: InstanceFileEntry }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const target = imageRef.current;
    if (!target || nearViewport) return;
    if (!("IntersectionObserver" in window)) {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(([observed]) => {
      if (observed?.isIntersecting) {
        setNearViewport(true);
        observer.disconnect();
      }
    }, { rootMargin: "360px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [nearViewport]);

  useEffect(() => {
    if (!nearViewport || source || failed) return;
    let active = true;
    void command<string>("get_screenshot_thumbnail", { instanceId, path: entry.path })
      .then((thumbnail) => { if (active) setSource(thumbnail); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [entry.path, failed, instanceId, nearViewport, source]);

  if (failed) return <div className={styles.screenshotPlaceholder}><File size={28} weight="duotone" /><span>Preview unavailable</span></div>;
  return <img ref={imageRef} src={source ?? undefined} alt={entry.name} decoding="async" onError={() => setFailed(true)} />;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function instanceLogDirectory(gameDirectory: string) {
  return gameDirectory.replace(/[\\/]game$/, (match) => `${match[0]}logs`);
}

function filteredConsoleLines(lines: ConsoleLine[], query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return normalized ? lines.filter((line) => line.text.toLocaleLowerCase().includes(normalized)) : lines;
}

function formatConsoleText(text: string, showTimestamps: boolean) {
  return showTimestamps ? text : text.replace(/^\[[^\]]+\]\s*/, "");
}

function consoleLineColor(level: ConsoleLine["level"], settings: ConsoleSettings) {
  if (level === "error") return settings.error;
  if (level === "warning") return settings.warning;
  if (level === "debug") return settings.debug;
  return settings.info;
}
