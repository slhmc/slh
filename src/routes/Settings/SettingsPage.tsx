import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  BellSimple,
  Code,
  Coffee,
  GearSix,
  Database,
  DownloadSimple,
  GameController,
  HardDrives,
  Palette,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Trash,
  UserCircle,
  Wrench,
} from "../../components/icons";
import { NavLink, useParams } from "react-router-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { command } from "../../lib/tauri";
import { useWindowActivity } from "../../lib/windowActivity";
import type { Account, AppearanceColors, AppearancePreset, AppearanceSettings, BedrockSettings, ConsoleSettings, CurseForgeKeyStatus, DownloadRecord, GeneralSettings, JavaInstallation, JavaSettings, LauncherUpdateInfo, NotificationSettings, ProviderAvailability, StorageSummary, SyncMapping, SyncRunResult } from "../../lib/types";
import { useAppStore } from "../../stores/appStore";
import common from "../../components/common/Common.module.css";
import styles from "./SettingsPage.module.css";
import { AccountAvatar } from "../../components/account/AccountAvatar";
import { HomeCharacterFpsControl } from "../../components/account/HomeCharacterFpsControl";
import { AccountAppearanceDialog } from "../../components/account/AccountAppearanceDialog";
import { movedAccountOrder, orderedAccounts } from "../../lib/accountOrder";
import { useI18n } from "../../i18n/I18nProvider";
import menuStyles from "../../components/shell/NavigationContextMenu.module.css";

const sections = [
  { id: "general", label: "General", labelKey: "settings.general", icon: SlidersHorizontal },
  { id: "appearance", label: "Appearance", labelKey: "settings.appearance", icon: Palette },
  { id: "minecraft", label: "Minecraft", labelKey: "settings.minecraft", icon: GameController },
  { id: "java", label: "Java", labelKey: "settings.java", icon: Coffee },
  { id: "bedrock", label: "Bedrock", labelKey: "settings.bedrock", icon: GameController },
  { id: "accounts", label: "Accounts", labelKey: "settings.accounts", icon: UserCircle },
  { id: "storage", label: "Storage", labelKey: "settings.storage", icon: HardDrives },
  { id: "downloads", label: "Downloads", labelKey: "settings.downloads", icon: DownloadSimple },
  { id: "notifications", label: "Notifications", labelKey: "settings.notifications", icon: BellSimple },
  { id: "sync", label: "Sync", labelKey: "settings.sync", icon: Database },
  { id: "console", label: "Console", labelKey: "settings.console", icon: Code },
  { id: "privacy", label: "Privacy", labelKey: "settings.privacy", icon: ShieldCheck },
  { id: "advanced", label: "Advanced", labelKey: "settings.advanced", icon: Wrench },
];

type SettingsNavigationPosition = NonNullable<GeneralSettings["settingsNavigationPosition"]>;

function settingsDockPosition(x: number): SettingsNavigationPosition {
  return x < window.innerWidth / 2 ? "left" : "right";
}

function dockArrowRotation(position: string): number {
  return position === "left" ? 180 : position === "top" ? 270 : position === "bottom" ? 90 : 0;
}

function PositionArrow({ position }: { position: string }) {
  return <ArrowRight className={styles.positionArrow} size={17} style={{ transform: `rotate(${dockArrowRotation(position)}deg)` }} aria-hidden="true" />;
}

/**
 * Older builds could append the default settings list to an already complete
 * persisted order on every render.  Normalize at the boundary so malformed
 * or duplicated values can never produce duplicate sidebar entries again.
 */
function normalizeSettingsOrder(stored: string[] | undefined): string[] {
  const defaults = sections.map((item) => item.id);
  const valid = new Set(defaults);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of [...(stored ?? []), ...defaults]) {
    if (!valid.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  if (!(stored ?? []).includes("bedrock")) {
    const bedrock = result.indexOf("bedrock");
    if (bedrock >= 0) result.splice(bedrock, 1);
    result.splice(result.indexOf("java") + 1, 0, "bedrock");
  }
  return result;
}

const consoleColors: Array<[keyof Pick<ConsoleSettings, "background" | "foreground" | "info" | "warning" | "error" | "debug" | "timestamp">, string]> = [
  ["background", "Background"],
  ["foreground", "Text"],
  ["info", "Information"],
  ["warning", "Warnings"],
  ["error", "Errors"],
  ["debug", "Debug"],
  ["timestamp", "Timestamps"],
];

const defaultConsoleSettings: Pick<ConsoleSettings, "background" | "foreground" | "info" | "warning" | "error" | "debug" | "timestamp"> = {
  background: "#111417", foreground: "#d8dee9", info: "#8fb8de", warning: "#e6b85c", error: "#f06a6a", debug: "#85909c", timestamp: "#66717d",
};

const builtInAppearancePresets: AppearancePreset[] = [
  {
    id: "slh-orange",
    name: "Graphite Orange",
    colors: {
      background: "#1f2226",
      surface: "#292d32",
      surface2: "#343a40",
      border: "#454c54",
      text: "#ffffff",
      textMuted: "#aeb6bf",
      accent: "#cd491e",
      accentHover: "#e15828",
      accentPressed: "#ae3916",
    },
  },
  {
    id: "light",
    name: "Light Orange",
    colors: {
      background: "#ffffff",
      surface: "#f4f6f8",
      surface2: "#e6eaf0",
      border: "#bcc5d0",
      text: "#111827",
      textMuted: "#4b5563",
      accent: "#d44b1e",
      accentHover: "#b83b13",
      accentPressed: "#91300f",
    },
  },
];

function appearanceColors(settings: AppearanceSettings): AppearanceColors {
  return {
    background: settings.background,
    surface: settings.surface,
    surface2: settings.surface2,
    border: settings.border,
    text: settings.text,
    textMuted: settings.textMuted,
    accent: settings.accent,
    accentHover: settings.accentHover,
    accentPressed: settings.accentPressed,
  };
}

export function SettingsPage() {
  const { section = "general" } = useParams();
  const { t, tr, locale } = useI18n();
  const bootstrap = useAppStore((state) => state.bootstrap);
  const refresh = useAppStore((state) => state.refresh);
  const refreshLocales = useAppStore((state) => state.refreshLocales);
  const pushToast = useAppStore((state) => state.pushToast);
  const activities = useAppStore((state) => state.activities);
  const [appearance, setAppearance] = useState<AppearanceSettings | null>(null);
  const [consoleSettings, setConsoleSettings] = useState<ConsoleSettings | null>(null);
  const consoleSaveTimer = useRef<number | null>(null);
  const [presetName, setPresetName] = useState("");
  const [java, setJava] = useState<JavaInstallation[]>([]);
  const [javaLoading, setJavaLoading] = useState(false);
  const [managedJavaBusy, setManagedJavaBusy] = useState<number | null>(null);
  const [showBuildTime, setShowBuildTime] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [syncMappings, setSyncMappings] = useState<SyncMapping[]>([]);
  const [syncCategory, setSyncCategory] = useState<SyncMapping["category"]>("options");
  const [syncInitialSource, setSyncInitialSource] = useState("shared");
  const [syncAllInstances, setSyncAllInstances] = useState(true);
  const [syncInstances, setSyncInstances] = useState<string[]>([]);
  const [syncSources, setSyncSources] = useState<Record<string, string>>({});
  const [syncBusy, setSyncBusy] = useState(false);
  const [storageSummary, setStorageSummary] = useState<StorageSummary | null>(null);
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [contentProviders, setContentProviders] = useState<ProviderAvailability[]>([]);
  const [curseForgeKey, setCurseForgeKey] = useState("");
  const [curseForgeKeyStatus, setCurseForgeKeyStatus] = useState<CurseForgeKeyStatus | null>(null);
  const [curseForgeKeyBusy, setCurseForgeKeyBusy] = useState(false);
  const [appearanceAccount, setAppearanceAccount] = useState<Account | null>(null);
  const [notificationMaxInput, setNotificationMaxInput] = useState("");
  const [notificationDurationInput, setNotificationDurationInput] = useState("");
  const [settingsNavigationMenuPosition, setSettingsNavigationMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [settingsDockDrag, setSettingsDockDrag] = useState<{ x: number; y: number; position: SettingsNavigationPosition; width: number; top: number; height: number } | null>(null);
  const settingsDockDragRef = useRef<{ startX: number; startY: number; active: boolean } | null>(null);
  const settingsNavRef = useRef<HTMLElement | null>(null);
  const [launcherUpdate, setLauncherUpdate] = useState<LauncherUpdateInfo | null>(null);
  const [launcherUpdateBusy, setLauncherUpdateBusy] = useState(false);
  const windowActive = useWindowActivity();
  const settingsNavigationPosition: SettingsNavigationPosition = bootstrap?.settings.general.settingsNavigationPosition === "right" ? "right" : "left";

  useEffect(() => {
    if (section !== "general" || !windowActive) return;
    let active = true;
    const scan = () => {
      if (active) void refreshLocales();
    };
    scan();
    const interval = window.setInterval(scan, 1500);
    window.addEventListener("focus", scan);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", scan);
    };
  }, [refreshLocales, section, windowActive]);

  useEffect(() => {
    if (bootstrap) {
      const previous = bootstrap.settings.appearance;
      const removedWhitePreset = previous.activePresetId === "slh-mono";
      const normalized = {
        ...previous,
        ...(removedWhitePreset ? builtInAppearancePresets[0].colors : {}),
        activePresetId: removedWhitePreset ? "slh-orange" : previous.activePresetId ?? "slh-orange",
        presets: previous.presets ?? [],
        fontFamily: previous.fontFamily ?? "pixeloid",
        customFontPath: previous.customFontPath ?? null,
        minimalism: previous.minimalism === true,
      };
      setAppearance(normalized);
      setConsoleSettings(bootstrap.settings.console);
      if (removedWhitePreset) void command("update_setting", { key: "appearance", value: normalized }).then(() => refresh()).catch(() => undefined);
    }
  }, [bootstrap]);

  useEffect(() => () => {
    if (consoleSaveTimer.current !== null) window.clearTimeout(consoleSaveTimer.current);
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = settingsDockDragRef.current;
      if (!drag) return;
      if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 7) drag.active = true;
      if (!drag.active) return;
      event.preventDefault();
      const rect = settingsNavRef.current?.getBoundingClientRect();
      setSettingsDockDrag({ x: event.clientX, y: event.clientY, position: settingsDockPosition(event.clientX), width: rect?.width ?? 216, top: rect?.top ?? 0, height: rect?.height ?? window.innerHeight });
    };
    const onEnd = (event: PointerEvent) => {
      const drag = settingsDockDragRef.current;
      settingsDockDragRef.current = null;
      setSettingsDockDrag(null);
      if (!drag?.active || !bootstrap) return;
      event.preventDefault();
      const nextPosition = settingsDockPosition(event.clientX);
      if (nextPosition === settingsNavigationPosition) return;
      void command("update_setting", { key: "general", value: { ...bootstrap.settings.general, settingsNavigationPosition: nextPosition } satisfies GeneralSettings })
        .then(() => refresh())
        .catch((error) => pushToast({ tone: "error", title: tr("Settings navigation position was not saved"), message: String((error as { message?: string }).message ?? error) }));
    };
    const cancel = () => { settingsDockDragRef.current = null; setSettingsDockDrag(null); };
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
  }, [bootstrap, pushToast, refresh, settingsNavigationPosition, tr]);

  const beginSettingsDockDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (!event.ctrlKey || event.button !== 0) return;
    event.preventDefault();
    settingsDockDragRef.current = { startX: event.clientX, startY: event.clientY, active: false };
  };

  useEffect(() => {
    if (!bootstrap) return;
    setNotificationMaxInput(String(bootstrap.settings.notifications.maxVisible));
    setNotificationDurationInput(String(bootstrap.settings.notifications.durationMs));
  }, [bootstrap?.settings.notifications.durationMs, bootstrap?.settings.notifications.maxVisible]);

  useEffect(() => {
    if (section !== "sync") return;
    let active = true;
    command<SyncMapping[]>("list_sync_mappings")
      .then((items) => {
        if (active) setSyncMappings(items);
      })
      .catch((error) => {
        if (active) pushToast({ tone: "error", title: tr("Sync mappings could not be loaded"), message: String((error as { message?: string }).message ?? error) });
      });
    return () => { active = false; };
  }, [pushToast, section, tr]);

  useEffect(() => {
    if (section !== "sync") return;
    const instances = bootstrap?.instances ?? [];
    setSyncInstances((current) => current.length === 0 ? instances.map((instance) => instance.id) : current);
    setSyncInitialSource((current) => current === "shared" || instances.some((instance) => instance.id === current) ? current : "shared");
  }, [bootstrap?.instances, section]);

  useEffect(() => {
    if (section !== "storage" && section !== "downloads") return;
    let active = true;
    setDiagnosticsLoading(true);
    const request = section === "storage"
      ? command<StorageSummary>("get_storage_summary").then((value) => { if (active) setStorageSummary(value); })
      : Promise.all([
          command<DownloadRecord[]>("list_downloads", { limit: 50 }),
          command<ProviderAvailability[]>("list_content_providers"),
          command<CurseForgeKeyStatus>("get_curseforge_key_status"),
        ]).then(([history, providers, keyStatus]) => { if (active) { setDownloads(history); setContentProviders(providers); setCurseForgeKeyStatus(keyStatus); } });
    request
      .catch((error) => {
        if (active) pushToast({ tone: "error", title: tr("Diagnostics could not be loaded"), message: String((error as { message?: string }).message ?? error) });
      })
      .finally(() => { if (active) setDiagnosticsLoading(false); });
    return () => { active = false; };
  }, [pushToast, section, tr]);
  if (!bootstrap) return null;
  if (!appearance) return <div className={styles.content}><div className={styles.inlineEmpty}><SlidersHorizontal size={30} /><p>{tr("Preparing settings")}</p></div></div>;
  const defaultSettingsOrder = sections.map((item) => item.id);
  const settingsNavigationOrder = normalizeSettingsOrder(bootstrap.settings.general.settingsNavigationOrder);
  const visibleSettings = new Set(bootstrap.settings.general.settingsNavigationVisible ?? defaultSettingsOrder);
  const orderedSettings = settingsNavigationOrder
    .map((id) => sections.find((item) => item.id === id))
    .filter((item): item is (typeof sections)[number] => Boolean(item));

  const save = async (key: string, value: unknown, success?: string) => {
    try {
      await command("update_setting", { key, value });
      await refresh();
      if (success) pushToast({ tone: "success", title: tr(success), message: tr("The settings database was updated.") });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Settings were not saved"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  const checkLauncherUpdates = async () => {
    if (launcherUpdateBusy) return;
    setLauncherUpdateBusy(true);
    try {
      const result = await command<LauncherUpdateInfo>("check_launcher_updates");
      setLauncherUpdate(result);
      if (result.updateAvailable) {
        pushToast({ tone: "info", title: tr("Launcher update available"), message: `${result.latestVersion} — ${tr("Open the release page to download it.")}`, action: { label: tr("Open release"), url: result.releaseUrl } });
      } else {
        pushToast({ tone: "success", title: tr("Launcher is up to date"), message: `${tr("Current version")}: ${result.currentVersion}` });
      }
    } catch (error) {
      pushToast({ tone: "error", title: tr("Update check failed"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setLauncherUpdateBusy(false);
    }
  };

  const saveCurseForgeKey = async () => {
    if (!curseForgeKey.trim()) return;
    setCurseForgeKeyBusy(true);
    try {
      const status = await command<CurseForgeKeyStatus>("save_curseforge_api_key", { apiKey: curseForgeKey });
      setCurseForgeKey("");
      setCurseForgeKeyStatus(status);
      setContentProviders(await command<ProviderAvailability[]>("list_content_providers"));
      pushToast({ tone: "success", title: tr("CurseForge connected"), message: tr("The approved key was verified and encrypted for this Windows profile.") });
    } catch (error) {
      pushToast({ tone: "error", title: tr("CurseForge key was not saved"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setCurseForgeKeyBusy(false);
    }
  };

  const clearCurseForgeKey = async () => {
    if (!window.confirm(tr("Remove the locally encrypted CurseForge API key from this launcher?"))) return;
    setCurseForgeKeyBusy(true);
    try {
      const status = await command<CurseForgeKeyStatus>("clear_curseforge_api_key");
      setCurseForgeKeyStatus(status);
      setContentProviders(await command<ProviderAvailability[]>("list_content_providers"));
      pushToast({ tone: "success", title: tr("CurseForge disconnected"), message: tr("The local encrypted key file was removed.") });
    } catch (error) {
      pushToast({ tone: "error", title: tr("CurseForge key was not removed"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setCurseForgeKeyBusy(false);
    }
  };

  const updateGeneral = (patch: Partial<GeneralSettings>) => {
    void save("general", { ...bootstrap.settings.general, ...patch });
  };

  const deleteAccount = async (account: Account) => {
    try {
      await command("delete_account", { accountId: account.id });
      const accountOrder = (bootstrap.settings.general.accountOrder ?? []).filter((id) => id !== account.id);
      await command("update_setting", { key: "general", value: { ...bootstrap.settings.general, accountOrder } });
      await refresh();
      pushToast({ tone: "success", title: tr("Account removed"), message: `${account.username} ${tr("was removed from this launcher.")}` });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Account was not removed"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  const moveAccount = async (account: Account, direction: -1 | 1) => {
    const accountOrder = movedAccountOrder(bootstrap.accounts, bootstrap.settings.general.accountOrder, account.id, direction);
    try {
      await command("update_setting", { key: "general", value: { ...bootstrap.settings.general, accountOrder } });
      await refresh();
    } catch (error) {
      pushToast({ tone: "error", title: tr("Account order was not saved"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  const updateNotifications = (patch: Partial<NotificationSettings>) => {
    void save("notifications", { ...bootstrap.settings.notifications, ...patch });
  };
  const updateBedrock = (patch: Partial<BedrockSettings>) => {
    void save("bedrock", { ...bootstrap.settings.bedrock, ...patch });
  };

  const changeNotificationDestination = async (destination: "launcher" | "windows") => {
    if (destination === "windows") {
      try {
        await command("prepare_windows_notifications");
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
        if (!granted) {
          pushToast({ tone: "error", title: tr("Windows notifications were not enabled"), message: tr("Allow notifications for SLH in Windows settings, then choose Windows again.") });
          return;
        }
      } catch (error) {
        pushToast({ tone: "error", title: tr("Windows notifications could not be enabled"), message: String((error as { message?: string }).message ?? error) });
        return;
      }
    }
    updateNotifications({ destination });
  };

  const commitNotificationNumber = (value: string, minimum: number, maximum: number, fallback: number, update: (next: number) => void, setValue: (next: string) => void) => {
    const parsed = Number(value);
    const next = Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.round(parsed))) : fallback;
    setValue(String(next));
    if (next !== fallback) update(next);
  };

  const updateConsole = (patch: Partial<ConsoleSettings>) => {
    const next = { ...(consoleSettings ?? bootstrap.settings.console), ...patch };
    setConsoleSettings(next);
    if (consoleSaveTimer.current !== null) window.clearTimeout(consoleSaveTimer.current);
    consoleSaveTimer.current = window.setTimeout(() => {
      void save("console", next);
      consoleSaveTimer.current = null;
    }, 350);
  };

  const applyAppearancePreset = (preset: AppearancePreset) => {
    const next = { ...appearance, ...preset.colors, activePresetId: preset.id };
    setAppearance(next);
    void save("appearance", next);
  };

  const saveAppearancePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    if (appearance.presets.length >= 12) {
      pushToast({ tone: "error", title: tr("Preset limit reached"), message: tr("Remove a custom preset before saving another one.") });
      return;
    }
    const preset: AppearancePreset = {
      id: `custom-${crypto.randomUUID()}`,
      name: name.slice(0, 40),
      colors: appearanceColors(appearance),
    };
    const next = { ...appearance, activePresetId: preset.id, presets: [...appearance.presets, preset] };
    setAppearance(next);
    setPresetName("");
    void save("appearance", next, "Appearance preset saved");
  };

  const removeAppearancePreset = (preset: AppearancePreset) => {
    const presets = appearance.presets.filter((item) => item.id !== preset.id);
    const next = {
      ...appearance,
      activePresetId: appearance.activePresetId === preset.id ? "custom" : appearance.activePresetId,
      presets,
    };
    setAppearance(next);
    void save("appearance", next, "Appearance preset removed");
  };

  const selectInterfaceFont = (fontFamily: NonNullable<AppearanceSettings["fontFamily"]>) => {
    const next = { ...appearance, fontFamily };
    setAppearance(next);
    void save("appearance", next, "Interface font saved");
  };

  const importInterfaceFont = async () => {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Font files", extensions: ["ttf", "otf", "woff", "woff2"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    try {
      const customFontPath = await command<string>("import_local_font", { sourcePath: selected });
      const next = { ...appearance, fontFamily: "local" as const, customFontPath };
      setAppearance(next);
      await save("appearance", next, "Local interface font imported");
    } catch (error) {
      pushToast({ tone: "error", title: tr("Font was not imported"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  const detectJava = async () => {
    setJavaLoading(true);
    try {
      setJava(await command<JavaInstallation[]>("discover_java", { requiredMajor: null, scanAll: true }));
    } catch (error) {
      pushToast({ tone: "error", title: tr("Java detection failed"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setJavaLoading(false);
    }
  };

  const installManagedJava = async (majorVersion: number) => {
    setManagedJavaBusy(majorVersion);
    try {
      await command<JavaInstallation>("install_managed_java", { majorVersion });
      setJava(await command<JavaInstallation[]>("discover_java", { requiredMajor: null }));
      pushToast({ tone: "success", title: tr("Java {version} installed", { version: majorVersion }), message: "" });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Java {version} installation failed", { version: majorVersion }), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setManagedJavaBusy(null);
    }
  };

  const chooseManagedJavaDirectory = async () => {
    const selected = await openDialog({ multiple: false, directory: true, title: tr("Choose managed Java folder") });
    if (!selected || Array.isArray(selected)) return;
    await save("java", { installDirectory: selected } satisfies JavaSettings, "Java download location saved");
    await detectJava();
  };

  const resetManagedJavaDirectory = async () => {
    await save("java", { installDirectory: null } satisfies JavaSettings, "Java download location reset");
    await detectJava();
  };

  const createGroup = async () => {
    try {
      await command("create_group", { request: { name: groupName } });
      setGroupName("");
      await refresh();
      pushToast({ tone: "success", title: tr("Group created"), message: tr("It is now available in the instance wizard.") });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Group was not created"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  const reloadSyncMappings = async () => {
    setSyncMappings(await command<SyncMapping[]>("list_sync_mappings"));
  };

  const createSyncMapping = async () => {
    if ((!syncAllInstances && syncInstances.length === 0) || !syncInitialSource) return;
    if (syncCategory === "worlds") {
      if (!bootstrap.settings.sync.worldsEnabled) {
        pushToast({ tone: "error", title: tr("World sync is locked"), message: tr("Enable the world-sync safety switch before creating this mapping.") });
        return;
      }
      if (!window.confirm(tr("World synchronization can overwrite saves. SLH will back up every replaced file. Continue?"))) return;
    }
    setSyncBusy(true);
    try {
      await command<SyncMapping>("create_sync_mapping", {
        request: {
          category: syncCategory,
          instanceIds: syncAllInstances ? ["*"] : syncInstances,
          direction: "bidirectional",
          initialSource: syncInitialSource,
          acknowledgeWorldRisk: syncCategory === "worlds",
        },
      });
      await reloadSyncMappings();
      pushToast({ tone: "success", title: tr("Sync mapping created"), message: tr("The initial source was copied and a hash snapshot was recorded.") });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Sync mapping was not created"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setSyncBusy(false);
    }
  };

  const syncNow = async (mapping: SyncMapping) => {
    const source = syncSources[mapping.id] ?? bootstrap.instances.find((instance) => mapping.instanceIds.includes("*") || mapping.instanceIds.includes(instance.id))?.id;
    if (!source) return;
    setSyncBusy(true);
    try {
      const results = await command<SyncRunResult[]>("run_sync_mapping_now", { mappingId: mapping.id, sourceInstanceId: source });
      await reloadSyncMappings();
      const copied = results.reduce((total, result) => total + result.copiedFiles, 0);
      const backups = results.reduce((total, result) => total + result.backupsCreated, 0);
      pushToast({ tone: "success", title: tr("Sync complete"), message: `${copied} ${tr(copied === 1 ? "file" : "files")} ${tr("copied")}${backups ? `, ${backups} ${tr(backups === 1 ? "backup" : "backups")} ${tr("created")}` : ""}.` });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Sync failed"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setSyncBusy(false);
    }
  };

  const toggleSyncMapping = async (mapping: SyncMapping) => {
    try {
      await command("set_sync_mapping_enabled", { mappingId: mapping.id, enabled: !mapping.enabled });
      await reloadSyncMappings();
    } catch (error) {
      pushToast({ tone: "error", title: tr("Sync mapping was not updated"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  const removeSyncMapping = async (mapping: SyncMapping) => {
    if (!window.confirm(`${tr("Remove the")} ${mapping.category} ${tr("mapping? Shared files and backups will be kept.")}`)) return;
    try {
      await command("delete_sync_mapping", { mappingId: mapping.id });
      await reloadSyncMappings();
    } catch (error) {
      pushToast({ tone: "error", title: tr("Sync mapping was not removed"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  return (
    <div className={`${styles.layout} ${settingsNavigationPosition === "right" ? styles.navRight : ""}`}>
      <aside ref={settingsNavRef} className={styles.nav} onPointerDown={beginSettingsDockDrag} onContextMenu={(event) => {
        event.preventDefault();
        window.dispatchEvent(new Event("slh-context-menu-open"));
        setSettingsNavigationMenuPosition({ x: event.clientX, y: event.clientY });
      }}>
        <div className={styles.navHeader}><h1>{t("navigation.settings", "Settings")}</h1><p data-minimal-text>{t("settings.preferences", "Launcher preferences")}</p></div>
        {orderedSettings.filter(({ id }) => visibleSettings.has(id)).map(({ id, label, labelKey, icon: Icon }) => (
          <NavLink key={id} to={`/settings/${id}`} data-minimal-navigation aria-label={t(labelKey, label)} className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ""}`}>
            <Icon size={18} weight="duotone" /><span data-minimal-text>{t(labelKey, label)}</span>
          </NavLink>
        ))}
      </aside>
      <section className={styles.content}>
        {section === "general" ? (
          <SettingsSection title={t("settings.general", "General")} description={t("settings.generalDescription", "Language, library behavior, and launcher lifecycle.")}>
            <SettingRow title={t("settings.language", "Language")} description={t("settings.languageDescription", "Installed locale files are loaded from launcher resources.")}>
              <select className={common.select} value={bootstrap.settings.general.language} onChange={(event) => updateGeneral({ language: event.target.value })}>
                {bootstrap.locales.map((locale) => <option value={locale.code} key={locale.code}>{locale.name}</option>)}
              </select>
            </SettingRow>
            <SettingRow title={t("settings.rememberLast", "Remember last section")} description={t("settings.rememberLastDescription", "Return to your previous main view after restart.")}>
              <Toggle checked={bootstrap.settings.general.rememberSection} onChange={(checked) => updateGeneral({ rememberSection: checked })} />
            </SettingRow>
            <SettingRow title={t("settings.hideOnLaunch", "Hide while Minecraft runs")} description={t("settings.hideOnLaunchDescription", "Keep SLH available by default while capturing launch state.")}>
              <Toggle checked={bootstrap.settings.general.hideOnLaunch} onChange={(checked) => updateGeneral({ hideOnLaunch: checked })} />
            </SettingRow>
            <SettingRow title={tr("Offline fallback for online accounts")} description={tr("When there is no internet connection, launch Microsoft or Ely.by with a temporary offline identity using the same nickname. Turn this off to choose a nickname for each offline launch.")}>
              <Toggle checked={bootstrap.settings.general.offlineFallbackWhenOffline !== false} onChange={(checked) => updateGeneral({ offlineFallbackWhenOffline: checked })} />
            </SettingRow>
            <SettingRow title={tr("Keyboard interface scaling")} description={tr("Use Ctrl + and Ctrl - to change the interface scale by 5%.")}>
              <Toggle checked={bootstrap.settings.general.keyboardZoom !== false} onChange={(checked) => updateGeneral({ keyboardZoom: checked })} />
            </SettingRow>
            <SettingRow title={tr("Show ungrouped instances")} description={tr("Keep the Ungrouped section visible in the library. You can also change this from its context menu.")}>
              <Toggle checked={bootstrap.settings.general.hideUngrouped !== true} onChange={(checked) => updateGeneral({ hideUngrouped: !checked })} />
            </SettingRow>
            <SettingRow title={tr("Instance panel position")} description={tr("Choose where the selected instance panel appears in the library.")}>
              <div className={styles.positionControl}><PositionArrow position={bootstrap.settings.general.instancePanelPosition ?? "right"} /><select className={common.select} value={bootstrap.settings.general.instancePanelPosition ?? "right"} onChange={(event) => updateGeneral({ instancePanelPosition: event.target.value as GeneralSettings["instancePanelPosition"] })}>
                <option value="left">{tr("Left")}</option>
                <option value="right">{tr("Right")}</option>
              </select></div>
            </SettingRow>
            <SettingRow title={tr("Instance tabs position")} description={tr("Choose where the Overview, Mods, and other instance tabs are shown.")}>
              <div className={styles.positionControl}><PositionArrow position={bootstrap.settings.general.instanceTabsPosition ?? "top"} /><select className={common.select} value={bootstrap.settings.general.instanceTabsPosition ?? "top"} onChange={(event) => updateGeneral({ instanceTabsPosition: event.target.value as GeneralSettings["instanceTabsPosition"] })}>
                <option value="top">{tr("Top")}</option>
                <option value="bottom">{tr("Bottom")}</option>
                <option value="left">{tr("Left")}</option>
                <option value="right">{tr("Right")}</option>
              </select></div>
            </SettingRow>
            <SettingRow title={tr("Navigation position")} description={tr("Choose where the main launcher navigation is docked.")}>
              <div className={styles.positionControl}><PositionArrow position={bootstrap.settings.general.navigationPosition ?? "left"} /><select className={common.select} value={bootstrap.settings.general.navigationPosition ?? "left"} onChange={(event) => updateGeneral({ navigationPosition: event.target.value as GeneralSettings["navigationPosition"] })}>
                <option value="left">{tr("Left")}</option>
                <option value="right">{tr("Right")}</option>
                <option value="top">{tr("Top")}</option>
                <option value="bottom">{tr("Bottom")}</option>
              </select></div>
            </SettingRow>
            <SettingRow title={tr("Settings navigation position")} description={tr("Choose where settings sections are shown.")}>
              <div className={styles.positionControl}><PositionArrow position={settingsNavigationPosition} /><select className={common.select} value={settingsNavigationPosition} onChange={(event) => updateGeneral({ settingsNavigationPosition: event.target.value as SettingsNavigationPosition })}>
                <option value="left">{tr("Left")}</option>
                <option value="right">{tr("Right")}</option>
              </select></div>
            </SettingRow>
          </SettingsSection>
        ) : null}

        {section === "appearance" ? (
          <SettingsSection title={t("settings.appearance", "Appearance")} description={t("settings.appearanceDescription", "Dark launcher palettes with reusable built-in and custom presets.")}>
            <div className={styles.presetHeader}>
              <div><strong>{t("settings.themePresets", "Theme presets")}</strong><p data-minimal-text>{t("settings.themePresetsDescription", "Applying a preset saves it immediately.")}</p></div>
              <div className={styles.presetSave}><input className={common.input} maxLength={40} value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder={t("settings.presetName", "Preset name")} /><button className={common.secondaryButton} type="button" disabled={!presetName.trim()} onClick={saveAppearancePreset}>{t("settings.saveCurrent", "Save current")}</button></div>
            </div>
            <div className={styles.presetGrid}>
              {[...builtInAppearancePresets, ...appearance.presets].map((preset) => {
                const custom = preset.id.startsWith("custom-");
                return (
                  <div className={`${styles.presetCard} ${appearance.activePresetId === preset.id ? styles.presetActive : ""}`} key={preset.id}>
                    <button type="button" className={styles.presetMain} onClick={() => applyAppearancePreset(preset)}>
                      <span className={styles.presetSwatches}><i style={{ background: preset.colors.background }} /><i style={{ background: preset.colors.surface2 }} /><i style={{ background: preset.colors.accent }} /></span>
                      <span><strong>{preset.name}</strong><small data-minimal-text>{custom ? "Custom preset" : "Built-in preset"}</small></span>
                      {appearance.activePresetId === preset.id ? <Check size={16} /> : null}
                    </button>
                    {custom ? <button type="button" className={styles.presetDelete} aria-label={`Delete ${preset.name}`} onClick={() => removeAppearancePreset(preset)}><Trash size={15} /></button> : null}
                  </div>
                );
              })}
            </div>
            <SettingRow title={t("settings.interfaceScale", "Interface scale")} description={t("settings.interfaceScaleDescription", "Changes the whole launcher without changing the Minecraft resolution.")}>
              <div className={styles.scaleControl}>
                <input
                  type="range"
                  min={50}
                  max={200}
                  step={5}
                  value={appearance.scalePercent}
                  onChange={(event) => setAppearance({ ...appearance, scalePercent: Number(event.target.value) })}
                  onPointerUp={() => void save("appearance", appearance, "Launcher scale saved")}
                  onKeyUp={() => void save("appearance", appearance, "Launcher scale saved")}
                />
                <strong>{appearance.scalePercent}%</strong>
              </div>
            </SettingRow>
            <SettingRow title={tr("Beautiful Home Menu")} description={tr("Show an interactive character and quick launch on the home page.")}>
              <Toggle checked={appearance.beautifulHome !== false} onChange={(checked) => {
                const next = { ...appearance, beautifulHome: checked };
                setAppearance(next);
                void save("appearance", next, "Appearance saved");
              }} />
            </SettingRow>
            {appearance.beautifulHome !== false ? <SettingRow className={styles.homeSubsetting} title={tr("Player FPS")} description={tr("1–60 FPS or unlimited. The slider snaps to 30 FPS. Rendering pauses when the window is minimized.")}>
              <HomeCharacterFpsControl value={appearance.homeCharacterFps} onCommit={(fps) => {
                const next = { ...appearance, homeCharacterFps: fps };
                setAppearance(next);
                void save("appearance", next);
              }} />
            </SettingRow> : null}
            <SettingRow title={t("settings.minimalism", "Minimalism")} description={t("settings.minimalismDescription", "Hide secondary labels and descriptions while keeping essential controls and icons.")}>
              <Toggle checked={appearance.minimalism === true} onChange={(checked) => {
                const next = { ...appearance, minimalism: checked };
                setAppearance(next);
                void save("appearance", next, "Appearance saved");
              }} />
            </SettingRow>
            <SettingRow className={styles.fontSettingRow} title={t("settings.interfaceFont", "Interface font")} description={t("settings.interfaceFontDescription", "The selected face is applied instantly. Local files are copied into data/fonts and loaded without restarting.")}>
              <div className={styles.fontControl}>
                <select className={common.select} value={appearance.fontFamily ?? "pixeloid"} onChange={(event) => selectInterfaceFont(event.target.value as NonNullable<AppearanceSettings["fontFamily"]>)}>
                  <option value="pixeloid">Pixeloid Sans (default)</option>
                  <option value="system">System UI</option>
                  <option value="monospace">Cascadia Mono</option>
                  <option value="local" disabled={!appearance.customFontPath}>Local font{appearance.customFontPath ? "" : " (choose a file)"}</option>
                </select>
                <button className={common.secondaryButton} type="button" onClick={() => void importInterfaceFont()}>Choose local font</button>
                <small className={styles.fontPreview} data-minimal-text>Preview: Aa Bb 0123</small>
              </div>
            </SettingRow>
            <div className={styles.colorGrid}>
              {([
                ["background", "Background"], ["surface", "Surface"], ["surface2", "Raised surface"], ["border", "Border"],
                ["text", "Text"], ["textMuted", "Muted text"], ["accent", "Accent"], ["accentHover", "Accent hover"],
              ] as Array<[keyof AppearanceColors, string]>).map(([key, label]) => (
                <label className={styles.colorField} key={key}>
                  <span>{label}</span>
                  <span><input type="color" value={String(appearance[key])} onChange={(event) => setAppearance({ ...appearance, [key]: event.target.value, activePresetId: "custom" })} /><code>{String(appearance[key])}</code></span>
                </label>
              ))}
            </div>
            <div className={styles.saveBar}>
              <p data-minimal-text>{t("settings.appearanceNote", "Theme mode follows the selected palette. Background images and animated wallpaper are intentionally unsupported.")}</p>
              <button className={common.button} type="button" onClick={() => void save("appearance", appearance, "Appearance saved")}>Save palette</button>
            </div>
          </SettingsSection>
        ) : null}

        {section === "minecraft" ? (
          <SettingsSection title="Minecraft" description="Global launch defaults and instance organization.">
            <SettingRow title="Default memory" description="New instances inherit this maximum RAM value.">
              <div className={styles.numeric}><input className={common.input} type="number" min={1024} max={32768} step={512} value={bootstrap.settings.minecraft.memoryMaxMb} onChange={(event) => void save("minecraft", { ...bootstrap.settings.minecraft, memoryMaxMb: Number(event.target.value) })} /><span>MB</span></div>
            </SettingRow>
            <SettingRow title="Instance groups" description={`${bootstrap.groups.length} ${tr("custom groups in this library.")}`}>
              <div className={styles.inlineForm}><input className={common.input} value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder={tr("New group")} /><button className={common.secondaryButton} type="button" disabled={!groupName.trim()} onClick={() => void createGroup()}><Plus size={16} /> {tr("Add")}</button></div>
            </SettingRow>
            <div className={styles.groupTags}>{bootstrap.groups.map((group) => <span className={common.badge} key={group.id}>{group.name}</span>)}</div>
          </SettingsSection>
        ) : null}

        {section === "java" ? (
          <SettingsSection title="Java" description="SLH inspects runtime version output and validates compatibility before launch.">
            <SettingRow className={styles.javaLocationRow} title="Managed Java download location" description="Choose where SLH stores downloaded Temurin runtimes. Existing managed Java installations remain detectable.">
              <div className={styles.javaLocation}><code title={bootstrap.settings.java?.installDirectory ?? `${bootstrap.portableRoot}\\data\\java`}>{bootstrap.settings.java?.installDirectory ?? `${bootstrap.portableRoot}\\data\\java`}</code><button className={common.secondaryButton} type="button" disabled={managedJavaBusy !== null} onClick={() => void chooseManagedJavaDirectory()}>Choose folder</button>{bootstrap.settings.java?.installDirectory ? <button className={common.ghostButton} type="button" disabled={managedJavaBusy !== null} onClick={() => void resetManagedJavaDirectory()}>Use default</button> : null}</div>
            </SettingRow>
            <div className={styles.actionHeader}><div><strong>Detected runtimes</strong><p>{activities.find((item) => item.operationId === "java-disk-scan")?.message ?? "Searches managed Java, JAVA_HOME, PATH and all local fixed disks without modifying system settings."}</p></div>{javaLoading ? <button className={common.secondaryButton} type="button" onClick={() => void command("cancel_java_discovery")}>Cancel scan</button> : <button className={common.secondaryButton} type="button" onClick={() => void detectJava()}>Detect Java</button>}</div>
            <div className={styles.javaInstallBar}><span><strong>Managed Temurin</strong><small>Verified JREs from Adoptium for this Windows architecture</small></span>{[8, 17, 21, 25].map((major) => <button className={common.secondaryButton} type="button" key={major} disabled={managedJavaBusy !== null} onClick={() => void installManagedJava(major)}><DownloadSimple size={15} /> {managedJavaBusy === major ? "Installing" : `Java ${major}`}</button>)}</div>
            <div className={styles.runtimeList}>
              {java.length === 0 ? <div className={styles.inlineEmpty}><Coffee size={28} /><p>Run detection to inspect available Java executables.</p></div> : java.map((runtime) => (
                <div className={styles.runtime} key={runtime.path}><Coffee size={20} /><span><strong>Java {runtime.majorVersion}</strong><small>{runtime.path}</small></span><span className={runtime.compatible ? common.successBadge : common.errorBadge}>{runtime.source}</span></div>
              ))}
            </div>
          </SettingsSection>
        ) : null}

        {section === "bedrock" ? (
          <SettingsSection title="Bedrock" description="Bedrock support is W.I.P. and has not been fully verified on every Windows installation and Minecraft version.">
            <div className={styles.bedrockWarning} role="note">{tr(bootstrap.capabilities?.bedrock === false ? "Bedrock is available only on Windows" : "Bedrock support is W.I.P. and has not been fully verified on every Windows installation and Minecraft version.")}</div>
            <SettingRow title="Enable Bedrock" description="Allow creating, installing, and launching Bedrock profiles. Existing profiles and game data are kept when disabled.">
              <Toggle checked={bootstrap.settings.bedrock.enabled} disabled={bootstrap.capabilities?.bedrock === false} onChange={(enabled) => updateBedrock({ enabled })} />
            </SettingRow>
            <SettingRow title="Default profile mode" description="Shared Store data makes pack imports available through Minecraft. Isolated profiles keep their own worlds and packs.">
              <select className={common.select} value={bootstrap.settings.bedrock.defaultProfileMode} onChange={(event) => updateBedrock({ defaultProfileMode: event.target.value as BedrockSettings["defaultProfileMode"] })}>
                <option value="shared">{tr("Shared Store data")}</option><option value="isolated">{tr("Isolated profile")}</option>
              </select>
            </SettingRow>
            <SettingRow title="Show preview versions" description="Include experimental Bedrock versions by default when creating a new profile.">
              <Toggle checked={bootstrap.settings.bedrock.showPreviewVersions} onChange={(showPreviewVersions) => updateBedrock({ showPreviewVersions })} />
            </SettingRow>
            <SettingRow title="Bedrock card click" description="Choose what happens when you click an add-on, resource pack, or world in the catalog.">
              <select className={common.select} value={bootstrap.settings.bedrock.cardClickAction ?? "summary"} onChange={(event) => updateBedrock({ cardClickAction: event.target.value as BedrockSettings["cardClickAction"] })}>
                <option value="none">{tr("Do nothing")}</option>
                <option value="summary">{tr("Show short description")}</option>
                <option value="curseforge">{tr("Open CurseForge page")}</option>
              </select>
            </SettingRow>
          </SettingsSection>
        ) : null}

        {section === "accounts" ? (
          <SettingsSection title="Accounts" description="Account metadata is stored in SQLite; token material belongs only in DPAPI-encrypted files.">
            <div className={styles.accountList}>
              {bootstrap.accounts.length === 0 ? <div className={styles.inlineEmpty}><UserCircle size={28} /><p>Add an Offline account from the sidebar account switcher.</p></div> : orderedAccounts(bootstrap.accounts, bootstrap.settings.general.accountOrder).map((account, index, accounts) => (
                <div className={styles.accountRow} key={account.id}><AccountAvatar account={account} className={styles.accountAvatar} /><span><strong>{account.username}</strong><small>{account.provider} · {account.providerUuid}</small></span><span className={account.active ? common.successBadge : common.badge}>{account.active ? "Active" : account.authStatus}</span><span className={styles.accountActions}><button className={`${common.iconButton} ${account.provider === "offline" ? styles.disabledAppearanceAction : ""}`} type="button" aria-label={`${tr("Manage skin and cape")} ${account.username}`} disabled={account.provider === "offline"} onClick={() => { if (account.provider === "elyby") { void openUrl("https://ely.by/skins"); } else if (account.provider !== "offline") { setAppearanceAccount(account); } }}><Palette size={16} /></button><button className={common.iconButton} type="button" aria-label={`Move ${account.username} up`} disabled={index === 0} onClick={() => void moveAccount(account, -1)}>↑</button><button className={common.iconButton} type="button" aria-label={`Move ${account.username} down`} disabled={index === accounts.length - 1} onClick={() => void moveAccount(account, 1)}>↓</button><button className={`${common.iconButton} ${styles.removeAccount}`} type="button" aria-label={`Remove ${account.username}`} onClick={() => void deleteAccount(account)}><Trash size={16} /></button></span></div>
              ))}
            </div>
            <div className={styles.providerGrid}>
              {bootstrap.providers.map((provider) => <div key={provider.provider}><strong>{provider.provider === "elyby" ? "Ely.by" : provider.provider[0].toUpperCase() + provider.provider.slice(1)}</strong><span className={provider.available ? common.successBadge : common.warningBadge}>{provider.available ? "Available" : "Unavailable"}</span><p>{provider.message ?? "Ready to add from the account switcher."}</p></div>)}
            </div>
          </SettingsSection>
        ) : null}

        {section === "storage" ? (
          <SettingsSection title="Storage" description="Every mutable SLH file stays beside the executable.">
            <div className={styles.pathBlock}><HardDrives size={25} /><span><small>Data folder</small><code>{bootstrap.portableRoot}</code></span></div>
            {storageSummary ? (
              <div className={styles.storageDetails}>
                <div className={styles.storageTotal}><span><strong>{formatBytes(storageSummary.totalBytes)}</strong><small>data in use</small></span><span>{bootstrap.instances.length} instances</span></div>
                <div className={styles.storageGrid}>
                  <StorageCell label="Instances" bytes={storageSummary.instancesBytes} />
                  <StorageCell label="Runtime cache" bytes={storageSummary.cacheBytes} />
                  <StorageCell label="Managed Java" bytes={storageSummary.javaBytes} />
                  <StorageCell label="Shared" bytes={storageSummary.sharedBytes} />
                  <StorageCell label="Backups" bytes={storageSummary.backupsBytes} />
                  <StorageCell label="Downloads" bytes={storageSummary.downloadsBytes} />
                  <StorageCell label="Logs" bytes={storageSummary.logsBytes} />
                  <StorageCell label="Database" bytes={storageSummary.databaseBytes} />
                </div>
              </div>
            ) : <div className={styles.inlineEmpty}><HardDrives size={28} /><p>{diagnosticsLoading ? "Calculating storage…" : "Storage summary is unavailable."}</p></div>}
            <p className={styles.notice}>Runtime cache is retained because installed instances can depend on its verified assets and libraries. Worlds, accounts, and shared files are never treated as disposable cache.</p>
          </SettingsSection>
        ) : null}

        {section === "downloads" ? (
          <SettingsSection title="Downloads" description="Verified downloads use retry, temporary files, and atomic rename.">
            <SettingRow title="Concurrent downloads" description="Applied to library, asset, loader, and modpack batches."><input className={common.input} type="number" min={1} max={32} value={bootstrap.settings.downloads.concurrency} onChange={(event) => void save("downloads", { ...bootstrap.settings.downloads, concurrency: Number(event.target.value) })} /></SettingRow>
            <SettingRow title="Retry count" description="Transient failures use exponential backoff."><input className={common.input} type="number" min={0} max={8} value={bootstrap.settings.downloads.retries} onChange={(event) => void save("downloads", { ...bootstrap.settings.downloads, retries: Number(event.target.value) })} /></SettingRow>
            <div className={styles.apiKeyPanel}>
              <div className={styles.apiKeyHeader}><span><strong>Personal CurseForge API key (optional)</strong><small>{curseForgeKeyStatus?.message ?? "Checking local configuration"}</small></span><span className={curseForgeKeyStatus?.configured ? common.successBadge : common.badge}>{curseForgeKeyStatus?.configured ? "Direct API" : "SLH relay"}</span></div>
              {curseForgeKeyStatus?.source !== "environment" ? <div className={styles.apiKeyForm}><input className={common.input} type="password" autoComplete="off" spellCheck={false} value={curseForgeKey} onChange={(event) => setCurseForgeKey(event.target.value)} placeholder="Paste approved key locally" /><button className={common.secondaryButton} type="button" disabled={curseForgeKeyBusy || !curseForgeKey.trim()} onClick={() => void saveCurseForgeKey()}>{curseForgeKeyBusy ? "Checking" : "Verify and save"}</button>{curseForgeKeyStatus?.configured ? <button className={common.ghostButton} type="button" disabled={curseForgeKeyBusy} onClick={() => void clearCurseForgeKey()}>Remove</button> : null}</div> : null}
              <p>The value never enters SQLite, logs, exports, or UI state after saving. Windows DPAPI ties it to your current Windows profile.</p>
            </div>
            {contentProviders.map((provider) => <SettingRow key={provider.provider} title={provider.provider === "modrinth" ? "Modrinth" : "CurseForge"} description={provider.message ?? "Content provider is configured."}><span className={provider.available ? common.successBadge : common.warningBadge}>{provider.available ? "Available" : "API key required"}</span></SettingRow>)}
            <div className={styles.downloadList}>
              <div className={styles.listHeading}><strong>Recent verified transfers</strong><span>{downloads.length} records</span></div>
              {downloads.length === 0 ? <div className={styles.inlineEmpty}><DownloadSimple size={28} /><p>{diagnosticsLoading ? "Loading download history…" : "No queued or completed content downloads."}</p></div> : downloads.map((download) => (
                <div className={styles.downloadRow} key={download.id}>
                  <span><strong>{download.destination.split(/[\\/]/).filter(Boolean).pop() ?? "Download"}</strong><small>{download.source} · {new Date(download.updatedAt).toLocaleString(locale)}</small>{download.errorMessage ? <em>{download.errorMessage}</em> : null}</span>
                  <span><small>{formatBytes(download.downloadedBytes)}{download.totalBytes ? ` / ${formatBytes(download.totalBytes)}` : ""}</small><b className={download.status === "complete" ? common.successBadge : download.status === "failed" ? common.errorBadge : common.warningBadge}>{download.status}</b></span>
                </div>
              ))}
            </div>
          </SettingsSection>
        ) : null}

        {section === "notifications" ? (
          <SettingsSection title="Notifications" description="Choose which launcher messages appear and how long they stay visible.">
            <SettingRow title="Show notifications" description="Disabling this hides all toast messages. Activity progress remains available in the bottom bar."><Toggle checked={bootstrap.settings.notifications.enabled} onChange={(checked) => updateNotifications({ enabled: checked })} /></SettingRow>
            <SettingRow title="Notification location" description="Choose between launcher pop-ups and standard Windows notifications."><select className={common.select} value={bootstrap.settings.notifications.destination ?? "launcher"} onChange={(event) => void changeNotificationDestination(event.target.value as "launcher" | "windows")}><option value="launcher">{tr("In the launcher")}</option><option value="windows">Windows</option></select></SettingRow>
            <SettingRow title="Maximum visible" description="Older messages close automatically when this limit is reached."><input className={common.input} type="number" value={notificationMaxInput} onChange={(event) => setNotificationMaxInput(event.target.value)} onBlur={() => commitNotificationNumber(notificationMaxInput, 1, 8, bootstrap.settings.notifications.maxVisible, (maxVisible) => updateNotifications({ maxVisible }), setNotificationMaxInput)} /></SettingRow>
            <SettingRow title="Display time" description="How long each message remains visible."><div className={styles.numeric}><input className={common.input} type="number" value={notificationDurationInput} onChange={(event) => setNotificationDurationInput(event.target.value)} onBlur={() => commitNotificationNumber(notificationDurationInput, 1500, 30000, bootstrap.settings.notifications.durationMs, (durationMs) => updateNotifications({ durationMs }), setNotificationDurationInput)} /><span>ms</span></div></SettingRow>
            <SettingRow title="Information" description="Setup hints and non-critical status messages."><Toggle checked={bootstrap.settings.notifications.showInfo} onChange={(checked) => updateNotifications({ showInfo: checked })} /></SettingRow>
            <SettingRow title="Success" description="Completed installs, repairs, imports, and saves."><Toggle checked={bootstrap.settings.notifications.showSuccess} onChange={(checked) => updateNotifications({ showSuccess: checked })} /></SettingRow>
            <SettingRow title="Errors" description="Failures that may require your attention."><Toggle checked={bootstrap.settings.notifications.showErrors} onChange={(checked) => updateNotifications({ showErrors: checked })} /></SettingRow>
          </SettingsSection>
        ) : null}

        {section === "sync" ? (
          <SettingsSection title="Sync" description="Shared folders automatically feed current instances and every instance created later.">
            <div className={styles.safetyCallout}><ShieldCheck size={25} weight="duotone" /><div><strong>World synchronization is off</strong><p>World overwrites require explicit acknowledgement, a backup, and a check that Minecraft is not running.</p></div></div>
            <SettingRow title="Allow world mappings" description="Still requires confirmation for every newly created mapping."><Toggle checked={bootstrap.settings.sync.worldsEnabled} onChange={(checked) => void save("sync", { ...bootstrap.settings.sync, worldsEnabled: checked }, checked ? "World mapping gate enabled" : "World mapping gate disabled")} /></SettingRow>
            <div className={styles.sharedLibrary}><span><strong>{tr("Shared library")}</strong><small>{tr("options, servers, resourcepacks, screenshots, mod-configs, and worlds")}</small></span><button className={common.secondaryButton} type="button" onClick={() => void command("reveal_shared_path").catch((error) => pushToast({ tone: "error", title: tr("Shared folder could not be opened"), message: String((error as { message?: string }).message ?? error) }))}>{tr("Open shared folder")}</button></div>
            <div className={styles.syncForm}>
              <div className={styles.syncFields}>
                <label><span>Content</span><select className={common.select} value={syncCategory} onChange={(event) => setSyncCategory(event.target.value as SyncMapping["category"])}><option value="options">Options</option><option value="servers">Servers</option><option value="resourcepacks">Resource packs</option><option value="screenshots">Screenshots</option><option value="mod-configs">Mod configs</option><option value="worlds">Worlds</option></select></label>
                <label><span>Initial source</span><select className={common.select} value={syncInitialSource} onChange={(event) => setSyncInitialSource(event.target.value)}><option value="shared">Shared library</option>{bootstrap.instances.filter((instance) => syncAllInstances || syncInstances.includes(instance.id)).map((instance) => <option value={instance.id} key={instance.id}>{instance.name}</option>)}</select></label>
              </div>
              <div className={styles.syncInstances}>
                <strong>Destination instances</strong>
                <label><input type="checkbox" checked={syncAllInstances} onChange={(event) => setSyncAllInstances(event.target.checked)} /><span>All current and future instances</span><small>Recommended</small></label>
                {!syncAllInstances ? bootstrap.instances.map((instance) => <label key={instance.id}><input type="checkbox" checked={syncInstances.includes(instance.id)} onChange={(event) => { const next = event.target.checked ? [...syncInstances, instance.id] : syncInstances.filter((id) => id !== instance.id); setSyncInstances(next); if (syncInitialSource !== "shared" && !next.includes(syncInitialSource)) setSyncInitialSource("shared"); }} /><span>{instance.name}</span><small>{instance.minecraftVersion}</small></label>) : null}
                {!syncAllInstances && bootstrap.instances.length === 0 ? <p>No instances exist yet. Use the recommended all-instances scope to prepare shared content now.</p> : null}
              </div>
              <div className={styles.syncCreate}><p>After setup, SLH applies the shared copy when an instance is created or imported, before launch, and after Minecraft exits. Manual update remains optional.</p><button className={common.button} type="button" disabled={syncBusy || (!syncAllInstances && syncInstances.length === 0) || !syncInitialSource} onClick={() => void createSyncMapping()}>{syncBusy ? "Creating" : "Enable automatic sync"}</button></div>
            </div>
            <div className={styles.mappingList}>
              {syncMappings.length === 0 ? <div className={styles.inlineEmpty}><Database size={28} /><p>No sync mappings. Create one above to start sharing files.</p></div> : syncMappings.map((mapping) => {
                const available = bootstrap.instances.filter((instance) => mapping.instanceIds.includes("*") || mapping.instanceIds.includes(instance.id));
                const source = syncSources[mapping.id] ?? available[0]?.id ?? "";
                return <div className={styles.mappingRow} key={mapping.id}><span><strong>{mapping.category}</strong><small>{mapping.instanceIds.includes("*") ? "Automatic for all current and future instances" : `${mapping.instanceIds.length} selected instances`}{mapping.lastSyncAt ? ` · ${new Date(mapping.lastSyncAt).toLocaleString(locale)}` : ""}</small></span><select className={common.select} aria-label={`Source for ${mapping.category}`} value={source} onChange={(event) => setSyncSources((current) => ({ ...current, [mapping.id]: event.target.value }))}>{available.map((instance) => <option key={instance.id} value={instance.id}>{instance.name}</option>)}</select><button className={common.secondaryButton} type="button" disabled={syncBusy || !mapping.enabled || !source} onClick={() => void syncNow(mapping)}>Update now</button><Toggle checked={mapping.enabled} onChange={() => void toggleSyncMapping(mapping)} /><button className={common.iconButton} type="button" aria-label={`Remove ${mapping.category} mapping`} onClick={() => void removeSyncMapping(mapping)}><Trash size={16} /></button></div>;
              })}
            </div>
          </SettingsSection>
        ) : null}

        {section === "console" ? (
          <SettingsSection title="Console" description="Control how live Minecraft output is shown for every instance.">
            {consoleSettings ? <>
            <SettingRow title="Open on launch" description="Switch to the instance console as soon as Minecraft starts."><Toggle checked={consoleSettings.openOnLaunch} onChange={(checked) => updateConsole({ openOnLaunch: checked })} /></SettingRow>
            <SettingRow title="Open logs when launching from Home" description="Switch to logs after launching the last build from the beautiful Home screen."><Toggle checked={consoleSettings.openOnHomeLaunch === true} onChange={(checked) => updateConsole({ openOnHomeLaunch: checked })} /></SettingRow>
            <SettingRow title="Show timestamps" description="Display the recorded time before each console line."><Toggle checked={consoleSettings.showTimestamps} onChange={(checked) => updateConsole({ showTimestamps: checked })} /></SettingRow>
            <SettingRow title="Wrap long lines" description="Keep long log lines inside the console width."><Toggle checked={consoleSettings.wrapLines} onChange={(checked) => updateConsole({ wrapLines: checked })} /></SettingRow>
            <SettingRow title="Follow output" description="Scroll to new lines while the console is open."><Toggle checked={consoleSettings.autoScroll} onChange={(checked) => updateConsole({ autoScroll: checked })} /></SettingRow>
            <SettingRow title="Font size" description="Size of console text in pixels."><div className={styles.numeric}><input className={common.input} type="number" min={10} max={22} value={consoleSettings.fontSize} onChange={(event) => updateConsole({ fontSize: Number(event.target.value) })} /><span>px</span></div></SettingRow>
            <SettingRow title="Line history" description="Maximum number of recent lines kept in the interface."><input className={common.input} type="number" min={250} max={10000} step={250} value={consoleSettings.maxLines} onChange={(event) => updateConsole({ maxLines: Number(event.target.value) })} /></SettingRow>
            <div className={styles.consoleColors}>{consoleColors.map(([key, label]) => <label key={key}><span>{tr(label)}</span><span><input type="color" value={consoleSettings[key]} onChange={(event) => updateConsole({ [key]: event.target.value })} /><code>{consoleSettings[key]}</code></span></label>)}</div>
            <div className={styles.consoleActions}><button className={common.secondaryButton} type="button" onClick={() => updateConsole(defaultConsoleSettings)}>{tr("Restore default colors")}</button></div>
            <div className={styles.consolePreview} style={{ background: consoleSettings.background, color: consoleSettings.foreground, fontSize: `${consoleSettings.fontSize}px` }}>
              <span><time style={{ color: consoleSettings.timestamp }}>[20:45:10]</time><b style={{ color: consoleSettings.info }}> [INFO]</b> {tr("Minecraft client is starting")}</span>
              <span><time style={{ color: consoleSettings.timestamp }}>[20:45:12]</time><b style={{ color: consoleSettings.warning }}> [WARN]</b> {tr("Example warning message")}</span>
              <span><time style={{ color: consoleSettings.timestamp }}>[20:45:13]</time><b style={{ color: consoleSettings.error }}> [ERROR]</b> {tr("Example error message")}</span>
              <span><time style={{ color: consoleSettings.timestamp }}>[20:45:14]</time><b style={{ color: consoleSettings.debug }}> [DEBUG]</b> {tr("Diagnostic output")}</span>
            </div>
            </> : null}
          </SettingsSection>
        ) : null}

        {section === "privacy" ? (
          <SettingsSection title="Privacy" description="This personal build has no analytics, advertising, telemetry, or background data collection.">
            <SettingRow title={tr("Telemetry")} description={tr("No telemetry client exists in SLH.")}><span className={common.successBadge}>{tr("Always off")}</span></SettingRow>
            <SettingRow title={tr("Crash reporting")} description={tr("Crash data remains in local logs unless you copy it yourself.")}><span className={common.successBadge}>{tr("Local only")}</span></SettingRow>
            <div className={styles.networkList}><strong>{tr("Services contacted only when needed")}</strong><p>{tr("Mojang metadata and assets, Microsoft authentication when configured, Modrinth, CurseForge when configured, Ely.by when used, and the chosen managed Java source.")}</p></div>
          </SettingsSection>
        ) : null}

        {section === "advanced" ? (
          <SettingsSection title="Advanced" description="Diagnostics and developer controls remain explicit and non-destructive.">
            <SettingRow title="Launcher version" description="Click the version to view this build's local date and time."><button className={styles.buildVersion} type="button" onClick={() => setShowBuildTime((value) => !value)} title={tr("Show build time")}>{showBuildTime && bootstrap.buildUnix > 0 ? new Date(bootstrap.buildUnix * 1000).toLocaleString(locale) : `SLH ${bootstrap.version}`}</button></SettingRow>
            <SettingRow title={tr("Launcher updates")} description={tr("Check the official GitHub releases page for a newer launcher build.")}>
              <div className={styles.updateControl}>
                <button className={common.secondaryButton} type="button" disabled={launcherUpdateBusy} onClick={() => void checkLauncherUpdates()}>{launcherUpdateBusy ? tr("Checking") : tr("Check for updates")}</button>
                {launcherUpdate?.updateAvailable ? <button className={common.button} type="button" onClick={() => void openUrl(launcherUpdate.releaseUrl)}>{tr("Open release")}</button> : null}
              </div>
            </SettingRow>
            <SettingRow title={tr("Check for launcher updates automatically")} description={tr("Check GitHub for a newer SLH release once when the launcher starts.")}>
              <Toggle checked={bootstrap.settings.general.checkUpdatesAutomatically !== false} onChange={(checked) => updateGeneral({ checkUpdatesAutomatically: checked })} />
            </SettingRow>
            {launcherUpdate ? <p className={`${styles.notice} ${launcherUpdate.updateAvailable ? styles.updateNotice : ""}`}>{launcherUpdate.updateAvailable ? `${tr("New version available")}: ${launcherUpdate.latestVersion} · ${launcherUpdate.releaseName}` : `${tr("Launcher is up to date")}: ${launcherUpdate.currentVersion}`}</p> : null}
            <SettingRow title="Database" description="SQLite WAL, foreign keys, and forward-only migrations."><span className={common.successBadge}>Healthy</span></SettingRow>
            <SettingRow title="Logging" description="Daily log files with secret redaction boundaries."><span className={common.badge}>Info</span></SettingRow>
            <p className={styles.notice}>Database reset, forced metadata refresh, and instance repair are withheld until each action has preview and confirmation.</p>
          </SettingsSection>
        ) : null}
      </section>
      {settingsDockDrag ? <>
        <div className={`${styles.dockDropIndicator} ${settingsDockDrag.position === "left" ? styles.dockDropLeft : styles.dockDropRight}`} style={{ width: settingsDockDrag.width, top: settingsDockDrag.top, height: settingsDockDrag.height }} aria-hidden="true" />
        <div className={styles.dockDragPreview} style={{ left: settingsDockDrag.x, top: settingsDockDrag.y }} aria-hidden="true"><ArrowRight size={16} style={{ transform: `rotate(${dockArrowRotation(settingsDockDrag.position)}deg)` }} /><span>{tr("Settings")}</span></div>
      </> : null}
      <SettingsNavigationContextMenu
        position={settingsNavigationMenuPosition}
        onClose={() => setSettingsNavigationMenuPosition(null)}
        sections={sections}
      />
      <AccountAppearanceDialog account={appearanceAccount} onClose={() => setAppearanceAccount(null)} onChanged={refresh} />
    </div>
  );
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  const { tr } = useI18n();
  return <div className={styles.section}><header><h2>{tr(title)}</h2><p data-minimal-text>{tr(description)}</p></header><div className={styles.sectionBody}>{children}</div></div>;
}

function SettingRow({ title, description, children, className = "" }: { title: string; description: string; children: React.ReactNode; className?: string }) {
  const { tr } = useI18n();
  return <div className={`${styles.settingRow} ${className}`}><div><strong>{tr(title)}</strong><p data-minimal-text>{tr(description)}</p></div><div className={styles.settingControl}>{children}</div></div>;
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} disabled={disabled} className={`${styles.toggle} ${checked ? styles.checked : ""}`} onClick={() => onChange(!checked)}><span /></button>;
}

function StorageCell({ label, bytes }: { label: string; bytes: number }) {
  const { tr } = useI18n();
  return <div><strong>{tr(label)}</strong><span>{formatBytes(bytes)}</span></div>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

type SettingsNavigationContextMenuProps = {
  position: { x: number; y: number } | null;
  onClose: () => void;
  sections: typeof sections;
};

/** The settings sidebar uses the same pointer-based menu interaction as the
 * main navigation. Pointer dragging is intentional: native HTML DnD is
 * unreliable in the older WebView2 runtimes supported by SLH. */
function SettingsNavigationContextMenu({ position, onClose, sections: definitions }: SettingsNavigationContextMenuProps) {
  const { t } = useI18n();
  const bootstrap = useAppStore((state) => state.bootstrap);
  const refresh = useAppStore((state) => state.refresh);
  const pushToast = useAppStore((state) => state.pushToast);
  const menuRef = useRef<HTMLDivElement>(null);
  const pointerDragRef = useRef<{ id: string; startX: number; startY: number; dragging: boolean } | null>(null);
  const skipNextClickRef = useRef(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ label: string; x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!position || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8));
    menuRef.current.style.left = `${x}px`;
    menuRef.current.style.top = `${y}px`;
  }, [position]);

  useEffect(() => {
    if (!position) return undefined;
    const close = (event: PointerEvent) => {
      if (!(event.target as HTMLElement | null)?.closest(".slh-context-menu")) onClose();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const cancel = () => {
      pointerDragRef.current = null;
      skipNextClickRef.current = false;
      setDraggedId(null);
      setDropTarget(null);
      setDragPreview(null);
      onClose();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    window.addEventListener("slh-context-menu-open", onClose);
    window.addEventListener("slh-ui-cancel", cancel);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("slh-context-menu-open", onClose);
      window.removeEventListener("slh-ui-cancel", cancel);
    };
  }, [onClose, position]);

  const defaultOrder = definitions.map((item) => item.id);
  const order = bootstrap
    ? normalizeSettingsOrder(bootstrap.settings.general.settingsNavigationOrder)
    : defaultOrder;
  const visible = new Set(bootstrap?.settings.general.settingsNavigationVisible ?? defaultOrder);

  const saveNavigation = async (nextOrder: string[], nextVisible: Set<string>) => {
    if (!bootstrap) return;
    const visibleNavigation = nextOrder.filter((id) => nextVisible.has(id));
    try {
      await command("update_setting", {
        key: "general",
        value: {
          ...bootstrap.settings.general,
          settingsNavigationOrder: nextOrder,
          settingsNavigationVisible: visibleNavigation,
        } satisfies GeneralSettings,
      });
      await refresh();
    } catch (error) {
      pushToast({ tone: "error", title: t("settings.navigationSaveFailed", "Settings navigation was not saved"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  const toggle = (id: string) => {
    if (!bootstrap || skipNextClickRef.current) {
      skipNextClickRef.current = false;
      return;
    }
    const next = new Set(visible);
    if (next.has(id)) next.delete(id); else next.add(id);
    void saveNavigation(order, next);
  };

  const reorder = (id: string, targetId: string, after: boolean) => {
    if (!bootstrap || id === targetId) return;
    const next = order.filter((item) => item !== id);
    const target = next.indexOf(targetId);
    next.splice(target < 0 ? next.length : target + (after ? 1 : 0), 0, id);
    void saveNavigation(next, visible).finally(() => {
      setDraggedId(null);
      setDropTarget(null);
    });
  };

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag) return;
      if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 6) {
        drag.dragging = true;
        skipNextClickRef.current = true;
        setDraggedId(drag.id);
        const item = definitions.find((candidate) => candidate.id === drag.id);
        if (item) setDragPreview({ label: t(item.labelKey, item.label), x: event.clientX, y: event.clientY });
      }
      if (!drag.dragging) return;
      event.preventDefault();
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-slh-settings-order]");
      const targetId = target?.dataset.slhSettingsOrder;
      if (target && targetId && targetId !== drag.id) {
        const rect = target.getBoundingClientRect();
        setDropTarget({ id: targetId, after: event.clientY >= rect.top + rect.height / 2 });
      } else setDropTarget(null);
      setDragPreview((current) => current ? { ...current, x: event.clientX, y: event.clientY } : current);
    };
    const end = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      pointerDragRef.current = null;
      if (drag?.dragging) {
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-slh-settings-order]");
        const targetId = target?.dataset.slhSettingsOrder;
        if (target && targetId && targetId !== drag.id) {
          const rect = target.getBoundingClientRect();
          reorder(drag.id, targetId, event.clientY >= rect.top + rect.height / 2);
        }
      }
      setDraggedId(null);
      setDropTarget(null);
      setDragPreview(null);
    };
    const cancel = () => {
      pointerDragRef.current = null;
      skipNextClickRef.current = false;
      setDraggedId(null);
      setDropTarget(null);
      setDragPreview(null);
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, [definitions, order.join("|"), t, visible.size]);

  if (!bootstrap || !position) return null;
  const ordered = order.map((id) => definitions.find((item) => item.id === id)).filter((item): item is (typeof definitions)[number] => Boolean(item));
  return <>
    <div ref={menuRef} className={`${menuStyles.menu} slh-context-menu`} role="menu" aria-label={t("settings.navigationMenu", "Settings navigation")} style={{ left: position.x, top: position.y }} onPointerDown={(event) => event.stopPropagation()}>
      <header><GearSix size={17} /><strong>{t("settings.navigationMenu", "Settings navigation")}</strong></header>
      <div>{ordered.map(({ id, label, labelKey, icon: Icon }) => <div key={id} className={`${menuStyles.itemRow} ${draggedId === id ? menuStyles.dragging : ""} ${dropTarget?.id === id ? (dropTarget.after ? menuStyles.insertAfter : menuStyles.insertBefore) : ""}`} data-slh-settings-order={id} onPointerDown={(event) => { if (event.button === 0) pointerDragRef.current = { id, startX: event.clientX, startY: event.clientY, dragging: false }; }}>
        <button type="button" className={menuStyles.itemToggle} role="menuitemcheckbox" aria-checked={visible.has(id)} onClick={() => toggle(id)}><span className={menuStyles.check}>{visible.has(id) ? <Check size={16} /> : null}</span><Icon size={18} /><span>{t(labelKey, label)}</span></button>
      </div>)}</div>
    </div>
    {dragPreview ? <div className={menuStyles.dragPreview} style={{ left: dragPreview.x, top: dragPreview.y }} aria-hidden="true">{dragPreview.label}</div> : null}
  </>;
}
