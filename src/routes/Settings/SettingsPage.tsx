import { requestLauncherUpdate } from "../../components/common/LauncherUpdateDialog";
import { formatBytes } from "../../lib/formatters";
import { useUiText } from "../../i18n/UiText";
import { normalizeColors, contrastRatio } from "../../lib/theme";
import { Children, Fragment, isValidElement, createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { command } from "../../lib/tauri";
import type { Account, AppearanceColors, AppearancePreset, AppearanceSettings, BedrockSettings, ConsoleSettings, CurseForgeKeyStatus, DownloadRecord, GeneralSettings, JavaInstallation, JavaSettings, LauncherUpdateInfo, NotificationSettings, ProviderAvailability, StorageSummary, SyncMapping, SyncRunResult } from "../../lib/types";
import { useAppStore } from "../../stores/appStore";
import common from "../../components/common/Common.module.css";
import styles from "./SettingsPage.module.css";
import { AccountAvatar } from "../../components/account/AccountAvatar";
import { HomeCharacterModeControl } from "../../components/account/HomeCharacterModeControl";
import { homeCharacterMode } from "../../lib/homeCharacterMode";
import { HomeCharacterFpsControl } from "../../components/account/HomeCharacterFpsControl";
import { DeferredAccountAppearanceDialog as AccountAppearanceDialog } from "../../components/account/DeferredAccountAppearanceDialog";
import { movedAccountOrder, orderedAccounts } from "../../lib/accountOrder";
import { useI18n } from "../../i18n/I18nProvider";
import menuStyles from "../../components/shell/NavigationContextMenu.module.css";

import { BusyIndicator, Button, Progress } from "../../components/common/Controls";

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
      success: "#78c48c", warning: "#e6b85c", error: "#f08078", info: "#9bc8ff",
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
      success: "#28703d", warning: "#805800", error: "#ae302a", info: "#2869a4",
    },
  },
];

function appearanceColors(settings: AppearanceSettings): AppearanceColors {
  return normalizeColors({
    background: settings.background,
    surface: settings.surface,
    surface2: settings.surface2,
    border: settings.border,
    text: settings.text,
    textMuted: settings.textMuted,
    accent: settings.accent,
    accentHover: settings.accentHover,
    accentPressed: settings.accentPressed,
    success: settings.success, warning: settings.warning, error: settings.error, info: settings.info,
  });
}

export function SettingsPage() {
  const uiText = useUiText();
  const { section = "general" } = useParams();
  const { t, tr, locale, diagnostics = [] } = useI18n();
  const bootstrap = useAppStore((state) => state.bootstrap);
  const refresh = useAppStore((state) => state.refresh);
  const pushToast = useAppStore((state) => state.pushToast);
  const activities = useAppStore((state) => state.activities);
  const javaDownload = activities.find((activity) => activity.operation === "java" && activity.operationId !== "java-disk-scan");
  const [appearance, setAppearance] = useState<AppearanceSettings | null>(null);
  const [consoleSettings, setConsoleSettings] = useState<ConsoleSettings | null>(null);
  const consoleSaveTimer = useRef<number | null>(null);
  const [presetName, setPresetName] = useState("");
  const [java, setJava] = useState<JavaInstallation[]>([]);
  const [javaLoading, setJavaLoading] = useState(false);
  const [javaSearched, setJavaSearched] = useState(false);
  const [javaFullScan, setJavaFullScan] = useState(false);
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
  const settingsNavigationPosition: SettingsNavigationPosition = bootstrap?.settings.general.settingsNavigationPosition === "right" ? "right" : "left";


  useEffect(() => {
    if (bootstrap) {
      const previous = bootstrap.settings.appearance;
      const removedWhitePreset = previous.activePresetId === "slh-mono";
      const normalized = {
        ...normalizeColors(previous),
        ...(removedWhitePreset ? builtInAppearancePresets[0].colors : {}),
        activePresetId: removedWhitePreset ? "slh-orange" : previous.activePresetId ?? "slh-orange",
        presets: (previous.presets ?? []).map((preset) => ({ ...preset, colors: normalizeColors(preset.colors) })),
        fontFamily: previous.fontFamily ?? "pixeloid",
        customFontPath: previous.customFontPath ?? null,
        minimalism: previous.minimalism === true,
      };
      setAppearance(normalized);
      setConsoleSettings(bootstrap.settings.console);
      if (removedWhitePreset) void command("update_setting", { key: "appearance", value: normalized }).then(() => refresh()).catch(() => undefined);
    }
  // Locale refreshes clone bootstrap; only saved values should reset editable drafts.
  }, [JSON.stringify(bootstrap?.settings.appearance), JSON.stringify(bootstrap?.settings.console)]);

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
        .catch((error) => pushToast({ tone: "error", title: uiText("settings.texts.settingsNavigationPositionWasNotSaved", "Settings navigation position was not saved"), message: String((error as { message?: string }).message ?? error) }));
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
        if (active) pushToast({ tone: "error", title: uiText("settings.texts.syncMappingsCouldNotBeLoaded", "Sync mappings could not be loaded"), message: String((error as { message?: string }).message ?? error) });
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
        if (active) pushToast({ tone: "error", title: uiText("settings.texts.diagnosticsCouldNotBeLoaded", "Diagnostics could not be loaded"), message: String((error as { message?: string }).message ?? error) });
      })
      .finally(() => { if (active) setDiagnosticsLoading(false); });
    return () => { active = false; };
  }, [pushToast, section, tr]);
  if (!bootstrap) return null;
  if (!appearance) return <div className={styles.content}><div className={styles.inlineEmpty}><SlidersHorizontal size={30} /><p>{uiText("settings.texts.preparingSettings", "Preparing settings")}</p></div></div>;
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
      if (success) pushToast({ tone: "success", title: tr(success), message: uiText("settings.texts.theSettingsDatabaseWasUpdated", "The settings database was updated.") });
    } catch (error) {
      pushToast({ tone: "error", title: uiText("settings.texts.settingsWereNotSaved", "Settings were not saved"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  const checkLauncherUpdates = async () => {
    if (launcherUpdateBusy) return;
    setLauncherUpdateBusy(true);
    try {
      const result = await command<LauncherUpdateInfo>("check_launcher_updates");
      setLauncherUpdate(result);
      if (result.updateAvailable) {
        requestLauncherUpdate(result);
      } else {
        pushToast({ tone: "success", title: uiText("settings.texts.launcherIsUpToDate", "Launcher is up to date"), message: `${uiText("settings.texts.currentVersion", "Current version")}: ${result.currentVersion}` });
      }
    } catch (error) {
      pushToast({ tone: "error", title: uiText("settings.texts.updateCheckFailed", "Update check failed"), message: String((error as { message?: string }).message ?? error) });
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
      pushToast({ tone: "success", title: uiText("settings.texts.curseforgeConnected", "CurseForge connected"), message: uiText("settings.texts.theApprovedKeyWasVerifiedAndEncryptedForThis", "The approved key was verified and encrypted for this Windows profile.") });
    } catch (error) {
      pushToast({ tone: "error", title: uiText("settings.texts.curseforgeKeyWasNotSaved", "CurseForge key was not saved"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setCurseForgeKeyBusy(false);
    }
  };

  const clearCurseForgeKey = async () => {
    if (!window.confirm(uiText("settings.texts.removeTheLocallyEncryptedCurseforgeApiKeyFromThis", "Remove the locally encrypted CurseForge API key from this launcher?"))) return;
    setCurseForgeKeyBusy(true);
    try {
      const status = await command<CurseForgeKeyStatus>("clear_curseforge_api_key");
      setCurseForgeKeyStatus(status);
      setContentProviders(await command<ProviderAvailability[]>("list_content_providers"));
      pushToast({ tone: "success", title: uiText("settings.texts.curseforgeDisconnected", "CurseForge disconnected"), message: uiText("settings.texts.theLocalEncryptedKeyFileWasRemoved", "The local encrypted key file was removed.") });
    } catch (error) {
      pushToast({ tone: "error", title: uiText("settings.texts.curseforgeKeyWasNotRemoved", "CurseForge key was not removed"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setCurseForgeKeyBusy(false);
    }
  };

  const updateMinecraft = (patch: Partial<import("../../lib/types").MinecraftSettings>) => {
    const next={...bootstrap.settings.minecraft,...patch};
    if (patch.memoryMaxMb !== undefined) next.memoryMinMb=Math.min(next.memoryMinMb,next.memoryMaxMb);
    if (patch.memoryMinMb !== undefined) next.memoryMaxMb=Math.max(next.memoryMinMb,next.memoryMaxMb);
    void save("minecraft",next);
  };
  const updateJavaPreferences = (patch: Partial<import("../../lib/types").JavaSettings>) => void save("java",{...bootstrap.settings.java,...patch});
  const chooseJavaExecutable = async () => {
    const path=await openDialog({multiple:false,filters:[{name:"Java",extensions:["exe"]}]});
    if(typeof path === "string") updateMinecraft({javaPath:path,javaMode:"custom"});
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
      pushToast({ tone: "success", title: uiText("settings.texts.accountRemoved", "Account removed"), message: `${account.username} ${uiText("settings.texts.wasRemovedFromThisLauncher", "was removed from this launcher.")}` });
    } catch (error) {
      pushToast({ tone: "error", title: uiText("settings.texts.accountWasNotRemoved", "Account was not removed"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  const moveAccount = async (account: Account, direction: -1 | 1) => {
    const accountOrder = movedAccountOrder(bootstrap.accounts, bootstrap.settings.general.accountOrder, account.id, direction);
    try {
      await command("update_setting", { key: "general", value: { ...bootstrap.settings.general, accountOrder } });
      await refresh();
    } catch (error) {
      pushToast({ tone: "error", title: uiText("settings.texts.accountOrderWasNotSaved", "Account order was not saved"), message: String((error as { message?: string }).message ?? error) });
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
          pushToast({ tone: "error", title: uiText("settings.texts.systemNotificationsWereNotEnabled", "System notifications were not enabled"), message: uiText("settings.texts.allowNotificationsForSlhInSystemSettingsThenChoose", "Allow notifications for SLH in system settings, then choose In the system again.") });
          return;
        }
      } catch (error) {
        pushToast({ tone: "error", title: uiText("settings.texts.systemNotificationsCouldNotBeEnabled", "System notifications could not be enabled"), message: String((error as { message?: string }).message ?? error) });
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
      pushToast({ tone: "error", title: uiText("settings.texts.presetLimitReached", "Preset limit reached"), message: uiText("settings.texts.removeACustomPresetBeforeSavingAnotherOne", "Remove a custom preset before saving another one.") });
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
      pushToast({ tone: "error", title: uiText("settings.texts.fontWasNotImported", "Font was not imported"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  const detectJava = async (scanAll = false) => {
    if (javaLoading || managedJavaBusy !== null) return;
    setJavaLoading(true);
    setJavaFullScan(false);
    try {
      // Keep quick results visible while the optional disk search continues.
      setJava(await command<JavaInstallation[]>("discover_java", { requiredMajor: null }));
      setJavaSearched(true);
      if (scanAll) {
        setJavaFullScan(true);
        setJava(await command<JavaInstallation[]>("discover_java", { requiredMajor: null, scanAll: true }));
      }
    } catch (error) {
      pushToast({ tone: "error", title: uiText("settings.texts.javaDetectionFailed", "Java detection failed"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setJavaLoading(false);
      setJavaFullScan(false);
    }
  };

  const installManagedJava = async (majorVersion: number) => {
    setManagedJavaBusy(majorVersion);
    try {
      await command<JavaInstallation>("install_managed_java", { majorVersion });
      setJava(await command<JavaInstallation[]>("discover_java", { requiredMajor: null }));
      setJavaSearched(true);
      pushToast({ tone: "success", title: uiText("settings.texts.javaInstalled", "Java {version} installed", { version: majorVersion }), message: "" });
    } catch (error) {
      pushToast({ tone: "error", title: uiText("settings.texts.javaInstallationFailed", "Java {version} installation failed", { version: majorVersion }), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setManagedJavaBusy(null);
    }
  };

  const chooseManagedJavaDirectory = async () => {
    const selected = await openDialog({ multiple: false, directory: true, title: uiText("settings.texts.chooseManagedJavaFolder", "Choose managed Java folder") });
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
      pushToast({ tone: "success", title: uiText("library.texts.groupCreated", "Group created"), message: uiText("settings.texts.itIsNowAvailableInTheInstanceWizard", "It is now available in the instance wizard.") });
    } catch (error) {
      pushToast({ tone: "error", title: uiText("library.texts.groupWasNotCreated", "Group was not created"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  const reloadSyncMappings = async () => {
    setSyncMappings(await command<SyncMapping[]>("list_sync_mappings"));
  };

  const createSyncMapping = async () => {
    if ((!syncAllInstances && syncInstances.length === 0) || !syncInitialSource) return;
    if (syncCategory === "worlds") {
      if (!bootstrap.settings.sync.worldsEnabled) {
        pushToast({ tone: "error", title: uiText("settings.texts.worldSyncIsLocked", "World sync is locked"), message: uiText("settings.texts.enableTheWorldSyncSafetySwitchBeforeCreatingThis", "Enable the world-sync safety switch before creating this mapping.") });
        return;
      }
      if (!window.confirm(uiText("settings.texts.worldSynchronizationCanOverwriteSavesSlhWillBackUp", "World synchronization can overwrite saves. SLH will back up every replaced file. Continue?"))) return;
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
      pushToast({ tone: "success", title: uiText("settings.texts.syncMappingCreated", "Sync mapping created"), message: uiText("settings.texts.theInitialSourceWasCopiedAndAHashSnapshot", "The initial source was copied and a hash snapshot was recorded.") });
    } catch (error) {
      pushToast({ tone: "error", title: uiText("settings.texts.syncMappingWasNotCreated", "Sync mapping was not created"), message: String((error as { message?: string }).message ?? error) });
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
      pushToast({ tone: "success", title: uiText("settings.texts.syncComplete", "Sync complete"), message: uiText("settings.syncSummary", "Copied {copied} files; created {backups} backups.", { copied, backups }) });
    } catch (error) {
      pushToast({ tone: "error", title: uiText("settings.texts.syncFailed", "Sync failed"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setSyncBusy(false);
    }
  };

  const toggleSyncMapping = async (mapping: SyncMapping) => {
    try {
      await command("set_sync_mapping_enabled", { mappingId: mapping.id, enabled: !mapping.enabled });
      await reloadSyncMappings();
    } catch (error) {
      pushToast({ tone: "error", title: uiText("settings.texts.syncMappingWasNotUpdated", "Sync mapping was not updated"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  const removeSyncMapping = async (mapping: SyncMapping) => {
    if (!window.confirm(`${uiText("settings.texts.removeThe", "Remove the")} ${mapping.category} ${uiText("settings.texts.mappingSharedFilesAndBackupsWillBeKept", "mapping? Shared files and backups will be kept.")}`)) return;
    try {
      await command("delete_sync_mapping", { mappingId: mapping.id });
      await reloadSyncMappings();
    } catch (error) {
      pushToast({ tone: "error", title: uiText("settings.texts.syncMappingWasNotRemoved", "Sync mapping was not removed"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  return (
    <div data-minimalism={bootstrap.settings.appearance.minimalism === true} className={`${styles.layout} ${settingsNavigationPosition === "right" ? styles.navRight : ""} ${bootstrap.settings.general.compactSettings === true ? styles.compactSettings : ""}`}>
      <aside ref={settingsNavRef} className={styles.nav} onPointerDown={beginSettingsDockDrag} data-slh-context-menu="true" onContextMenu={(event) => {
        event.preventDefault();
        window.dispatchEvent(new Event("slh-context-menu-open"));
        setSettingsNavigationMenuPosition({ x: event.clientX, y: event.clientY });
      }}>
        <div className={styles.navHeader}><h1>{t("navigation.settings", "Settings")}</h1><p data-minimal-text>{t("settings.preferences", "Launcher preferences")}</p></div>
        {orderedSettings.filter(({ id }) => visibleSettings.has(id)).map(({ id, label, labelKey, icon: Icon }) => (
          <NavLink key={id} to={`/settings/${id}`} data-minimal-navigation aria-label={t(labelKey, label)} title={t(labelKey, label)} className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ""}`}>
            <Icon size={18} weight="duotone" /><span data-minimal-text>{t(labelKey, label)}</span>
          </NavLink>
        ))}
      </aside>
      <section className={styles.content}>
        {section === "general" ? (
          <SettingsSection title={t("settings.general", "General")} description={t("settings.generalDescription", "Language, library behavior, and launcher lifecycle.")}>
            <SettingRow title={t("settings.language", "Language")} description={t("settings.languageDescription", "Installed locale files are loaded from launcher resources.")}>
              <select data-language-selector aria-label={t("settings.language", "Language")} className={common.select} value={locale} onChange={(event) => updateGeneral({ language: event.target.value })}>
                {bootstrap.locales.map((locale) => <option value={locale.code} key={locale.code}>{locale.name}</option>)}
              </select>
            </SettingRow>
            <div className={styles.languageTools}>
              <button className={common.secondaryButton} type="button" onClick={() => void command("open_languages_folder").catch((error) => pushToast({ tone: "error", title: "Could not open languages folder", message: error.message }))}>{uiText("settings.texts.openLanguagesFolder", "Open languages folder")}</button>
              <button className={common.secondaryButton} type="button" onClick={() => window.dispatchEvent(new Event("slh-refresh-languages"))}>{uiText("settings.texts.refreshLanguages", "Refresh languages")}</button>
              <button className={common.secondaryButton} type="button" onClick={() => void (async () => {
                try {
                  const path = await saveDialog({ defaultPath: "fr-FR.json", filters: [{ name: "JSON", extensions: ["json"] }] });
                  if (path) { await command("export_language_template", { path }); window.dispatchEvent(new Event("slh-refresh-languages")); }
                } catch (error) { pushToast({ tone: "error", title: "Could not export language template", message: String((error as { message?: string }).message ?? error) }); }
              })()}>{uiText("settings.texts.exportLanguageTemplate", "Export language template")}</button>
              <p>{uiText("settings.texts.addAJsonTranslationToDataLanguagesSavedChanges", "Add a JSON translation to data/languages. Saved changes appear automatically without restarting SLH.")}</p>
              {diagnostics.map((item) => <p role="alert" key={item.path}><strong>{item.path}</strong><br />{uiText("settings.texts.couldNotReadLanguageFileCheckItsJsonSyntax", "Could not read language file. Check its JSON syntax and translation values.")}<br /><code>{item.reason}</code></p>)}
            </div>
            <div className={styles.tileGrid}>
            <SettingRow title={t("settings.rememberLast", "Remember last section")} description={t("settings.rememberLastDescription", "Return to your previous main view after restart.")}>
              <Toggle checked={bootstrap.settings.general.rememberSection} onChange={(checked) => updateGeneral({ rememberSection: checked })} />
            </SettingRow>
            <SettingRow title={t("settings.hideOnLaunch", "Hide while Minecraft runs")} description={t("settings.hideOnLaunchDescription", "Keep SLH available by default while capturing launch state.")}>
              <Toggle checked={bootstrap.settings.general.hideOnLaunch} onChange={(checked) => updateGeneral({ hideOnLaunch: checked })} />
            </SettingRow>
            <SettingRow title={uiText("settings.texts.offlineFallbackForOnlineAccounts", "Offline fallback for online accounts")} description={uiText("settings.texts.whenThereIsNoInternetConnectionLaunchMicrosoftOr", "When there is no internet connection, launch Microsoft or Ely.by with a temporary offline identity using the same nickname. Turn this off to choose a nickname for each offline launch.")}>
              <Toggle checked={bootstrap.settings.general.offlineFallbackWhenOffline !== false} onChange={(checked) => updateGeneral({ offlineFallbackWhenOffline: checked })} />
            </SettingRow>
            <SettingRow title={uiText("settings.texts.keyboardInterfaceScaling", "Keyboard interface scaling")} description={uiText("settings.texts.useCtrlAndCtrlToChangeTheInterfaceScale", "Use Ctrl + and Ctrl - to change the interface scale by 5%.")}>
              <Toggle checked={bootstrap.settings.general.keyboardZoom !== false} onChange={(checked) => updateGeneral({ keyboardZoom: checked })} />
            </SettingRow>
            <SettingRow title={uiText("settings.texts.showUngroupedInstances", "Show ungrouped instances")} description={uiText("settings.texts.keepTheUngroupedSectionVisibleInTheLibraryYou", "Keep the Ungrouped section visible in the library. You can also change this from its context menu.")}>
              <Toggle checked={bootstrap.settings.general.hideUngrouped !== true} onChange={(checked) => updateGeneral({ hideUngrouped: !checked })} />
            </SettingRow>
            </div>
            <div className={styles.tileGrid}>
            <SettingRow title={uiText("settings.texts.instancePanelPosition", "Instance panel position")} description={uiText("settings.texts.chooseWhereTheSelectedInstancePanelAppearsInThe", "Choose where the selected instance panel appears in the library.")}>
              <div className={styles.positionControl}><PositionArrow position={bootstrap.settings.general.instancePanelPosition ?? "right"} /><select className={common.select} value={bootstrap.settings.general.instancePanelPosition ?? "right"} onChange={(event) => updateGeneral({ instancePanelPosition: event.target.value as GeneralSettings["instancePanelPosition"] })}>
                <option value="left">{uiText("settings.texts.left", "Left")}</option>
                <option value="right">{uiText("settings.texts.right", "Right")}</option>
              </select></div>
            </SettingRow>
            <SettingRow title={uiText("settings.texts.instanceTabsPosition", "Instance tabs position")} description={uiText("settings.texts.chooseWhereTheOverviewModsAndOtherInstanceTabs", "Choose where the Overview, Mods, and other instance tabs are shown.")}>
              <div className={styles.positionControl}><PositionArrow position={bootstrap.settings.general.instanceTabsPosition ?? "top"} /><select className={common.select} value={bootstrap.settings.general.instanceTabsPosition ?? "top"} onChange={(event) => updateGeneral({ instanceTabsPosition: event.target.value as GeneralSettings["instanceTabsPosition"] })}>
                <option value="top">{uiText("settings.texts.top", "Top")}</option>
                <option value="bottom">{uiText("instance.texts.bottom", "Bottom")}</option>
                <option value="left">{uiText("settings.texts.left", "Left")}</option>
                <option value="right">{uiText("settings.texts.right", "Right")}</option>
              </select></div>
            </SettingRow>
            <SettingRow title={uiText("settings.texts.navigationPosition", "Navigation position")} description={uiText("settings.texts.chooseWhereTheMainLauncherNavigationIsDocked", "Choose where the main launcher navigation is docked.")}>
              <div className={styles.positionControl}><PositionArrow position={bootstrap.settings.general.navigationPosition ?? "left"} /><select className={common.select} value={bootstrap.settings.general.navigationPosition ?? "left"} onChange={(event) => updateGeneral({ navigationPosition: event.target.value as GeneralSettings["navigationPosition"] })}>
                <option value="left">{uiText("settings.texts.left", "Left")}</option>
                <option value="right">{uiText("settings.texts.right", "Right")}</option>
                <option value="top">{uiText("settings.texts.top", "Top")}</option>
                <option value="bottom">{uiText("instance.texts.bottom", "Bottom")}</option>
              </select></div>
            </SettingRow>
            <SettingRow title={uiText("settings.texts.settingsNavigationPosition", "Settings navigation position")} description={uiText("settings.texts.chooseWhereSettingsSectionsAreShown", "Choose where settings sections are shown.")}>
              <div className={styles.positionControl}><PositionArrow position={settingsNavigationPosition} /><select className={common.select} value={settingsNavigationPosition} onChange={(event) => updateGeneral({ settingsNavigationPosition: event.target.value as SettingsNavigationPosition })}>
                <option value="left">{uiText("settings.texts.left", "Left")}</option>
                <option value="right">{uiText("settings.texts.right", "Right")}</option>
              </select></div>
            </SettingRow>
            </div>
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
                      <span><strong data-minimal-title>{custom ? preset.name : uiText(preset.id === "slh-orange" ? "settings.presetGraphite" : "settings.presetLight", preset.name)}</strong><small data-minimal-text>{custom ? uiText("settings.texts.customPreset", "Custom preset") : uiText("settings.texts.builtInPreset", "Built-in preset")}</small></span>
                      {appearance.activePresetId === preset.id ? <Check size={16} /> : null}
                    </button>
                    {custom ? <button type="button" className={styles.presetDelete} aria-label={uiText("common.deleteNamed", "Delete {name}", { name: preset.name })} onClick={() => removeAppearancePreset(preset)}><Trash size={15} /></button> : null}
                  </div>
                );
              })}
            </div>
            <div className={styles.tileGrid}>
            <SettingRow title={t("settings.interfaceScale", "Interface scale")} description={t("settings.interfaceScaleDescription", "Changes the whole launcher without changing the Minecraft resolution.")}>
              <div className={styles.scaleControl}>
                <input
                  type="range"
                  aria-label={t("settings.interfaceScale", "Interface scale")}
                  min={50}
                  max={200}
                  step={5}
                  value={appearance.scalePercent}
                  onChange={(event) => setAppearance({ ...appearance, scalePercent: Number(event.target.value) })}
                  onPointerUp={() => { if (appearance.scalePercent !== bootstrap.settings.appearance.scalePercent) void save("appearance", appearance).then(() => pushToast({ brief: true, tone: "info", title: "notifications.scaleChanged", params: { percent: appearance.scalePercent }, message: "" })); }}
                  onKeyUp={() => { if (appearance.scalePercent !== bootstrap.settings.appearance.scalePercent) void save("appearance", appearance).then(() => pushToast({ brief: true, tone: "info", title: "notifications.scaleChanged", params: { percent: appearance.scalePercent }, message: "" })); }}
                />
                <strong>{appearance.scalePercent}%</strong>
              </div>
            </SettingRow>
            <SettingRow title={uiText("settings.texts.beautifulHomeMenu", "Beautiful Home Menu")} description={uiText("settings.texts.showAnInteractiveCharacterAndQuickLaunchOnThe", "Show an interactive character and quick launch on the home page.")}>
              <Toggle checked={appearance.beautifulHome !== false} onChange={(checked) => {
                const next = { ...appearance, beautifulHome: checked };
                setAppearance(next);
                void save("appearance", next, "Appearance saved");
              }} />
            </SettingRow>
            {appearance.beautifulHome !== false ? <SettingRow className={styles.homeSubsetting} title={t("settings.character.title")} description={t("settings.character.description")}>
              <HomeCharacterModeControl value={appearance.homeCharacterMode} vertical={bootstrap.settings.general.compactSettings !== true} onChange={mode => {
                const next = {...appearance,homeCharacterMode:mode};
                setAppearance(next);
                void save("appearance",next);
              }} />
            </SettingRow> : null}
            {appearance.beautifulHome !== false && homeCharacterMode(appearance.homeCharacterMode) === 2 ? <SettingRow className={styles.homeSubsetting} title={uiText("accounts.texts.playerFps", "Player FPS")} description={uiText("settings.texts.160FpsOrUnlimitedTheSliderSnapsTo", "1–60 FPS or unlimited. The slider snaps to 30 FPS. Rendering pauses when the window is minimized.")}>
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
            </div>
            <div className={styles.tileGrid}>
            <SettingRow title={uiText("settings.texts.compactMenuBeta", "Compact settings menu (beta)")} description={uiText("settings.texts.compactMenuDescription", "Show settings as tiles. Turn off to use rows. Text size stays the same.")}>
              <Toggle checked={bootstrap.settings.general.compactSettings !== true} onChange={(checked) => updateGeneral({ compactSettings: !checked })} />
            </SettingRow>
            <SettingRow title={uiText("settings.texts.compactTopBarExperimental", "Compact top bar (beta)")} description={uiText("settings.texts.combineNavigationAccountAndLauncherActionsInOneThin", "Combine navigation, account, and launcher actions in one thin top bar.")}>
              <Toggle checked={bootstrap.settings.general.compactHeader === true} onChange={(checked) => updateGeneral({ compactHeader: checked })} label={uiText("settings.texts.compactTopBarExperimental", "Compact top bar (beta)")} />
            </SettingRow>
            </div>
            <SettingRow title={uiText("settings.fitTitles", "Fit project names")} description={uiText("settings.fitTitlesHint", "Reduce the font by one pixel at a time to keep complete words on a line in Discover.")}><Toggle checked={appearance.fitProjectTitles === true} onChange={fitProjectTitles => { const next={...appearance,fitProjectTitles}; setAppearance(next); void save("appearance",next); }} /></SettingRow>
            <SettingRow className={styles.fontSettingRow} title={t("settings.interfaceFont", "Interface font")} description={t("settings.interfaceFontDescription", "The selected face is applied instantly. Local files are copied into data/fonts and loaded without restarting.")}>
              <div className={styles.fontControl}>
                <select className={common.select} value={appearance.fontFamily ?? "pixeloid"} onChange={(event) => selectInterfaceFont(event.target.value as NonNullable<AppearanceSettings["fontFamily"]>)}>
                  <option value="pixeloid">{uiText("settings.texts.pixeloidSansDefault", "Pixeloid Sans (default)")}</option>
                  <option value="system">{uiText("settings.texts.systemUi", "System UI")}</option>
                  <option value="monospace">{uiText("settings.texts.cascadiaMono", "Cascadia Mono")}</option>
                  <option value="local" disabled={!appearance.customFontPath}>{uiText("settings.texts.localFont", "Local font")}{appearance.customFontPath ? "" : " (choose a file)"}</option>
                </select>
                <button className={common.secondaryButton} type="button" onClick={() => void importInterfaceFont()}>{uiText("settings.texts.chooseLocalFont", "Choose local font")}</button>
                <small className={styles.fontPreview} data-minimal-text>{uiText("settings.texts.previewAaBb0123", "Preview: Aa Bb 0123")}</small>
              </div>
            </SettingRow>
            <div className={styles.tileGrid}>
            <SettingRow title={uiText("settings.texts.cornerRadius", "Corner radius")} description={uiText("settings.texts.adjustRoundedCornersThroughoutTheLauncher", "Adjust rounded corners throughout the launcher.")}><input className={common.input} type="number" min={0} max={24} value={appearance.radius} aria-label={uiText("settings.texts.cornerRadius", "Corner radius")} onChange={(event) => { const next = { ...appearance, radius: Math.max(0, Math.min(24, Number(event.target.value))) }; setAppearance(next); void save("appearance", next); }} /></SettingRow>
            <SettingRow title={uiText("settings.texts.interfaceDensity", "Interface density")} description={uiText("settings.texts.chooseComfortableOrCompactSpacing", "Choose comfortable or compact spacing.")}><select className={common.select} value={appearance.density} aria-label={uiText("settings.texts.interfaceDensity", "Interface density")} onChange={(event) => { const next = { ...appearance, density: event.target.value }; setAppearance(next); void save("appearance", next); }}><option value="comfortable">{uiText("settings.texts.comfortable", "Comfortable")}</option><option value="compact">{uiText("settings.texts.compact", "Compact")}</option></select></SettingRow>
            </div>
            {contrastRatio(appearance.text, appearance.surface) < 4.5 || contrastRatio(appearance.textMuted, appearance.surface) < 4.5 ? <p className={styles.notice} role="status">{uiText("settings.texts.someTextColorsAreDifficultToReadOnThis", "Some text colors are difficult to read on this surface. Increase the contrast or choose another palette.")}</p> : null}
            <div className={styles.colorGrid}>
              {([
                ["background", uiText("installation.texts.background", "Background")], ["surface", uiText("settings.texts.surface", "Surface")], ["surface2", uiText("settings.texts.raisedSurface", "Raised surface")], ["border", uiText("settings.texts.border", "Border")],
                ["text", uiText("settings.texts.text", "Text")], ["textMuted", uiText("settings.texts.mutedText", "Muted text")], ["accent", uiText("settings.texts.accent", "Accent")], ["accentHover", uiText("settings.texts.accentHover", "Accent hover")],
                ["accentPressed", "Pressed accent"], ["success", uiText("settings.texts.success", "Success")], ["warning", "Warning"], ["error", "Error"], ["info", uiText("library.texts.information", "Information")],
              ] as Array<[keyof AppearanceColors, string]>).map(([key, label]) => (
                <label className={styles.colorField} key={key}>
                  <span>{uiText(label)}</span>
                  <span><input type="color" value={String(appearance[key])} onChange={(event) => setAppearance({ ...appearance, [key]: event.target.value, activePresetId: "custom" })} /><code>{String(appearance[key])}</code></span>
                </label>
              ))}
            </div>
            <div className={styles.saveBar}>
              <p data-minimal-text>{t("settings.appearanceNote", "Theme mode follows the selected palette. Background images and animated wallpaper are intentionally unsupported.")}</p>
              <button className={common.button} type="button" onClick={() => void save("appearance", appearance, "Appearance saved")}>{uiText("settings.texts.savePalette", "Save palette")}</button>
            </div>
          </SettingsSection>
        ) : null}

        {section === "minecraft" ? (
          <SettingsSection title={uiText("settings.minecraft", "Minecraft")} description={uiText("settings.texts.globalLaunchDefaultsAndInstanceOrganization", "Global launch defaults and instance organization.")}>
            <SettingRow title={uiText("settings.texts.defaultMemory", "Default memory")} description={uiText("settings.texts.newInstancesInheritThisMaximumRamValue", "New instances inherit this maximum RAM value.")}>
              <div className={styles.numeric}><input className={common.input} type="number" min={256} max={1048576} step={256} defaultValue={bootstrap.settings.minecraft.memoryMaxMb} key={bootstrap.settings.minecraft.memoryMaxMb} onBlur={(event) => updateMinecraft({ memoryMaxMb: Math.min(1048576, Math.max(256, Number(event.target.value))) })} /><span>{uiText("installation.texts.mb", "MB")}</span></div>
            </SettingRow>
            <SettingRow className={styles.formSettingRow} title={uiText("settings.texts.instanceGroups", "Instance groups")} description={`${bootstrap.groups.length} ${uiText("settings.texts.customGroupsInThisLibrary", "custom groups in this library.")}`}>
              <div className={styles.inlineForm}><input className={common.input} value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder={uiText("library.newGroup", "New group")} /><button className={common.secondaryButton} type="button" disabled={!groupName.trim()} onClick={() => void createGroup()}><Plus size={16} /> {uiText("settings.texts.add", "Add")}</button></div>
            </SettingRow>
            <div className={styles.groupTags}>{bootstrap.groups.map((group) => <span className={common.badge} key={group.id}>{group.name}</span>)}</div>
          
            <SettingRow title={uiText("settings.gameFullscreen", "Start in fullscreen")} description={uiText("settings.gameFullscreenHint", "Open Minecraft Java Edition in fullscreen mode.")}><Toggle checked={bootstrap.settings.minecraft.fullscreen === true} onChange={fullscreen => updateMinecraft({fullscreen})} /></SettingRow>
            <SettingRow title={uiText("settings.gameResolution", "Game window size")} description={uiText("settings.gameResolutionHint", "Window width and height in pixels. Interface scale does not change these values.")}><div className={`${styles.inlineForm} ${styles.resolutionControl}`}><input aria-label={uiText("settings.gameWidth", "Window width")} className={common.input} type="number" min={320} max={16384} defaultValue={bootstrap.settings.minecraft.resolutionWidth} key={bootstrap.settings.minecraft.resolutionWidth} onBlur={e => updateMinecraft({resolutionWidth:Math.max(320,Math.min(16384,Number(e.target.value)))})} /><input aria-label={uiText("settings.gameHeight", "Window height")} className={common.input} type="number" min={240} max={16384} defaultValue={bootstrap.settings.minecraft.resolutionHeight} key={bootstrap.settings.minecraft.resolutionHeight} onBlur={e => updateMinecraft({resolutionHeight:Math.max(240,Math.min(16384,Number(e.target.value)))})} /></div></SettingRow>
            <SettingRow title={uiText("settings.gameHide", "Hide the launcher during play")} description={uiText("settings.gameHideHint", "Hide SLH after Minecraft starts. Uses the same preference as General.")}><Toggle checked={bootstrap.settings.general.hideOnLaunch} onChange={hideOnLaunch => updateGeneral({hideOnLaunch})} /></SettingRow>
            <SettingRow title={uiText("settings.gameExit", "Close SLH after the game exits")} description={uiText("settings.gameExitHint", "Close SLH when the last running Java instance exits.")}><Toggle checked={bootstrap.settings.minecraft.closeLauncherOnExit === true} onChange={closeLauncherOnExit => updateMinecraft({closeLauncherOnExit})} /></SettingRow>
</SettingsSection>
        ) : null}

        {section === "java" ? (
          <SettingsSection title={uiText("settings.java", "Java")} description={uiText("settings.texts.slhInspectsRuntimeVersionOutputAndValidatesCompatibilityBefore", "SLH inspects runtime version output and validates compatibility before launch.")}>

            <SettingRow className={styles.formSettingRow} title={uiText("settings.javaExecutable", "Java executable")} description={uiText("settings.javaExecutableHint", "Choose Java for instances without their own executable override.")}><div className={styles.inlineForm}><input className={common.input} aria-label={uiText("settings.javaExecutable", "Java executable")} defaultValue={bootstrap.settings.minecraft.javaPath ?? ""} key={bootstrap.settings.minecraft.javaPath ?? ""} onBlur={event => updateMinecraft({javaPath:event.target.value.trim() || null,javaMode:event.target.value.trim() ? "custom" : "auto"})} /><button className={common.secondaryButton} type="button" onClick={() => void chooseJavaExecutable()}>{uiText("common.browse", "Browse")}</button><button className={common.secondaryButton} type="button" onClick={() => void detectJava()}>{uiText("settings.texts.detectJava", "Detect Java")}</button></div></SettingRow>
            <SettingRow title={uiText("settings.javaAutoDetect", "Detect Java automatically")} description={uiText("settings.javaAutoDetectHint", "Find a compatible installed runtime when no executable is selected.")}><Toggle checked={bootstrap.settings.java.autoDetect !== false} onChange={autoDetect => updateJavaPreferences({autoDetect})} /></SettingRow>
            <SettingRow title={uiText("settings.javaAutoDownload", "Download Java automatically")} description={uiText("settings.javaAutoDownloadHint", "Download a verified Temurin runtime when no compatible Java is installed.")}><Toggle checked={bootstrap.settings.java.autoDownload !== false} onChange={autoDownload => updateJavaPreferences({autoDownload})} /></SettingRow>
            <SettingRow title={uiText("settings.javaSkipCheck", "Skip the Java compatibility check")} description={uiText("settings.javaSkipCheckHint", "Allow the chosen executable even if it is older than Minecraft requires. The game may fail to start.")}><Toggle checked={bootstrap.settings.java.skipCompatibilityCheck === true} onChange={skipCompatibilityCheck => updateJavaPreferences({skipCompatibilityCheck})} /></SettingRow>
            <SettingRow title={uiText("settings.javaMinMemory", "Default minimum memory")} description={uiText("settings.javaMemoryHint", "Memory defaults for newly created instances; maximum memory is shared with Minecraft settings.")}><input className={common.input} aria-label={uiText("settings.javaMinMemory", "Default minimum memory")} type="number" min={256} step={256} defaultValue={bootstrap.settings.minecraft.memoryMinMb} key={bootstrap.settings.minecraft.memoryMinMb} onBlur={e => updateMinecraft({memoryMinMb:Math.max(256,Number(e.target.value))})} /></SettingRow>
            <SettingRow title={uiText("settings.javaMaxMemory", "Default maximum memory")} description={uiText("settings.javaMemoryHint", "Memory defaults for newly created instances; maximum memory is shared with Minecraft settings.")}><input className={common.input} aria-label={uiText("settings.javaMaxMemory", "Default maximum memory")} type="number" min={256} step={256} defaultValue={bootstrap.settings.minecraft.memoryMaxMb} key={bootstrap.settings.minecraft.memoryMaxMb} onBlur={e => updateMinecraft({memoryMaxMb:Math.max(256,Number(e.target.value))})} /></SettingRow>
            <SettingRow title={uiText("settings.javaPermGen", "PermGen size (Java 7 and earlier)")} description={uiText("settings.javaPermGenHint", "Used only with legacy Java. Java 8 and newer ignore this preference.")}><input className={common.input} type="number" min={0} max={4096} defaultValue={bootstrap.settings.java.permGenMb ?? 128} onBlur={e => updateJavaPreferences({permGenMb:Math.max(0,Math.min(4096,Number(e.target.value)))})} /></SettingRow>
            <SettingRow title={uiText("settings.javaWarnMemory", "Warn when available memory is low")} description={uiText("settings.javaWarnMemoryHint", "Show a warning at launch if instance memory exceeds currently available RAM.")}><Toggle checked={bootstrap.settings.java.warnLowMemory !== false} onChange={warnLowMemory => updateJavaPreferences({warnLowMemory})} /></SettingRow>
            <SettingRow className={styles.formSettingRow} title={uiText("settings.javaArguments", "JVM arguments")} description={uiText("settings.javaArgumentsHint", "One argument per line. An argument containing spaces stays together. Applied to all Java instances.")}><textarea className={common.textarea} aria-label={uiText("settings.javaArguments", "JVM arguments")} defaultValue={bootstrap.settings.minecraft.jvmArgs.join("\n")} onBlur={e => updateMinecraft({jvmArgs:e.target.value.split("\n").map(v=>v.trim()).filter(Boolean)})} /></SettingRow>
            <SettingRow className={styles.javaLocationRow} title={uiText("settings.texts.managedJavaDownloadLocation", "Managed Java download location")} description={uiText("settings.texts.chooseWhereSlhStoresDownloadedTemurinRuntimesExistingManaged", "Choose where SLH stores downloaded Temurin runtimes. Existing managed Java installations remain detectable.")}>
              <div className={styles.javaLocation}><code title={bootstrap.settings.java?.installDirectory ?? `${bootstrap.portableRoot}\\data\\java`}>{bootstrap.settings.java?.installDirectory ?? `${bootstrap.portableRoot}\\data\\java`}</code><button className={common.secondaryButton} type="button" disabled={managedJavaBusy !== null} onClick={() => void chooseManagedJavaDirectory()}>{uiText("settings.texts.chooseFolder", "Choose folder")}</button>{bootstrap.settings.java?.installDirectory ? <button className={common.ghostButton} type="button" disabled={managedJavaBusy !== null} onClick={() => void resetManagedJavaDirectory()}>{uiText("settings.texts.useDefault", "Use default")}</button> : null}</div>
            </SettingRow>
            <div className={styles.actionHeader}><div><strong>{uiText("settings.texts.detectedRuntimes", "Detected runtimes")}</strong><p role="status">{javaLoading ? <><BusyIndicator /> {uiText(javaFullScan ? "settings.texts.javaFullScanBusy" : "settings.texts.javaQuickScanBusy")}</> : uiText("settings.texts.javaQuickScanHint")}</p></div><div className={styles.javaScanActions}>{javaLoading ? <button className={common.secondaryButton} type="button" disabled={!javaFullScan} onClick={() => void command("cancel_java_discovery")}>{uiText("settings.texts.cancelScan", "Cancel scan")}</button> : <><Button disabled={managedJavaBusy !== null} onClick={() => void detectJava()}>{uiText("settings.texts.detectJava", "Detect Java")}</Button><Button disabled={managedJavaBusy !== null} onClick={() => void detectJava(true)}>{uiText("settings.texts.javaFullScan")}</Button></>}</div></div>
            <div className={styles.javaInstallBar}><span><strong>{uiText("settings.texts.managedTemurin", "Managed Temurin")}</strong><small>{uiText("settings.texts.verifiedJresFromAdoptiumForThisWindowsArchitecture", "Verified JREs from Adoptium for this Windows architecture")}</small></span>{[8, 17, 21, 25].map((major) => <Button key={major} busy={managedJavaBusy === major} disabled={managedJavaBusy !== null || javaLoading} onClick={() => void installManagedJava(major)}>{managedJavaBusy === major ? null : <DownloadSimple size={15} />} {managedJavaBusy === major ? uiText("installation.texts.installing", "Installing") : `Java ${major}`}</Button>)}</div>
            {javaDownload ? <div className={styles.javaProgress}><Progress label={uiText(javaDownload.messageKey ?? "installation.texts.installing", javaDownload.message, javaDownload.params)} value={javaDownload.total && javaDownload.total > 0 ? Math.min(100, javaDownload.completed / javaDownload.total * 100) : null} /></div> : null}
            <div className={styles.runtimeList} aria-busy={javaLoading}>
              {java.length === 0 ? <div className={styles.inlineEmpty}>{javaLoading ? <BusyIndicator size={28} /> : <Coffee size={28} />}<p>{javaLoading ? uiText("settings.texts.javaQuickScanBusy") : javaSearched ? uiText("settings.texts.javaNotFound") : uiText("settings.texts.runDetectionToInspectAvailableJavaExecutables", "Run detection to inspect available Java executables.")}</p></div> : java.map((runtime) => (
                <div className={styles.runtime} key={runtime.path}><Coffee size={20} /><span><strong>{uiText("settings.java", "Java")}{" "}{runtime.majorVersion} · {runtime.version}{runtime.architecture ? ` · ${runtime.architecture}` : ""}</strong><small title={runtime.path}>{runtime.path}</small></span><span className={runtime.compatible ? common.successBadge : common.errorBadge}>{uiText(({ "disk scan": "settings.texts.javaSourceDisk", managed: "settings.texts.javaSourceManaged", PATH: "settings.texts.javaSourcePath", JAVA_HOME: "settings.texts.javaSourceHome", saved: "settings.texts.javaSourceSaved", custom: "settings.texts.javaSourceCustom" } as Record<string, string>)[runtime.source] ?? "settings.texts.javaSourceSystem")}</span></div>
              ))}
            </div>
          </SettingsSection>
        ) : null}

        {section === "bedrock" ? (
          <SettingsSection title={uiText("installation.texts.bedrock", "Bedrock")} description={uiText("settings.texts.bedrockSupportIsWIPAndHasNot", "Bedrock support is W.I.P. and has not been fully verified on every Windows installation and Minecraft version.")}>
            <div className={styles.bedrockWarning} role="note">{tr(bootstrap.capabilities?.bedrock === false ? uiText("settings.texts.bedrockIsAvailableOnlyOnWindows", "Bedrock is available only on Windows") : "Bedrock support is W.I.P. and has not been fully verified on every Windows installation and Minecraft version.")}</div>
            <SettingRow title={uiText("settings.texts.enableBedrock", "Enable Bedrock")} description={uiText("settings.texts.allowCreatingInstallingAndLaunchingBedrockProfilesExistingProfiles", "Allow creating, installing, and launching Bedrock profiles. Existing profiles and game data are kept when disabled.")}>
              <Toggle checked={bootstrap.settings.bedrock.enabled} disabled={bootstrap.capabilities?.bedrock === false} onChange={(enabled) => updateBedrock({ enabled })} />
            </SettingRow>
            <SettingRow title={uiText("settings.texts.defaultProfileMode", "Default profile mode")} description={uiText("settings.texts.sharedStoreDataMakesPackImportsAvailableThroughMinecraft", "Shared Store data makes pack imports available through Minecraft. Isolated profiles keep their own worlds and packs.")}>
              <select className={common.select} value={bootstrap.settings.bedrock.defaultProfileMode} onChange={(event) => updateBedrock({ defaultProfileMode: event.target.value as BedrockSettings["defaultProfileMode"] })}>
                <option value="shared">{uiText("installation.texts.sharedStoreData", "Shared Store data")}</option><option value="isolated">{uiText("installation.texts.isolatedProfile", "Isolated profile")}</option>
              </select>
            </SettingRow>
            <SettingRow title={uiText("settings.texts.showPreviewVersions", "Show preview versions")} description={uiText("settings.texts.includeExperimentalBedrockVersionsByDefaultWhenCreatingA", "Include experimental Bedrock versions by default when creating a new profile.")}>
              <Toggle checked={bootstrap.settings.bedrock.showPreviewVersions} onChange={(showPreviewVersions) => updateBedrock({ showPreviewVersions })} />
            </SettingRow>
            <SettingRow title={uiText("settings.texts.bedrockCardClick", "Bedrock card click")} description={uiText("settings.texts.chooseWhatHappensWhenYouClickAnAddOn", "Choose what happens when you click an add-on, resource pack, or world in the catalog.")}>
              <select className={common.select} value={bootstrap.settings.bedrock.cardClickAction ?? "summary"} onChange={(event) => updateBedrock({ cardClickAction: event.target.value as BedrockSettings["cardClickAction"] })}>
                <option value="none">{uiText("settings.texts.doNothing", "Do nothing")}</option>
                <option value="summary">{uiText("settings.texts.showShortDescription", "Show short description")}</option>
                <option value="curseforge">{uiText("settings.texts.openCurseforgePage", "Open CurseForge page")}</option>
              </select>
            </SettingRow>
          </SettingsSection>
        ) : null}

        {section === "accounts" ? (
          <SettingsSection title={uiText("settings.accounts", "Accounts")} description={uiText("settings.texts.accountMetadataIsStoredInSqliteTokenMaterialBelongs", "Account metadata is stored in SQLite; token material belongs only in DPAPI-encrypted files.")}>
            <div className={styles.accountList}>
              {bootstrap.accounts.length === 0 ? <div className={styles.inlineEmpty}><UserCircle size={28} /><p>{uiText("settings.texts.addAnOfflineAccountFromTheSidebarAccountSwitcher", "Add an Offline account from the sidebar account switcher.")}</p></div> : orderedAccounts(bootstrap.accounts, bootstrap.settings.general.accountOrder).map((account, index, accounts) => (
                <div className={styles.accountRow} key={account.id}><AccountAvatar account={account} className={styles.accountAvatar} /><span><strong>{account.username}</strong><small>{account.provider} · {account.providerUuid}</small></span><span className={account.active ? common.successBadge : common.badge}>{account.active ? uiText("accounts.texts.active", "Active") : account.authStatus}</span><span className={styles.accountActions}><button className={`${common.iconButton} ${account.provider === "offline" ? styles.disabledAppearanceAction : ""}`} type="button" aria-label={`${uiText("settings.texts.manageSkinAndCape", "Manage skin and cape")} ${account.username}`} disabled={account.provider === "offline"} onClick={() => { if (account.provider === "elyby") { void openUrl("https://ely.by/skins"); } else if (account.provider !== "offline") { setAppearanceAccount(account); } }}><Palette size={16} /></button><button className={common.iconButton} type="button" aria-label={`Move ${account.username} up`} disabled={index === 0} onClick={() => void moveAccount(account, -1)}>↑</button><button className={common.iconButton} type="button" aria-label={`Move ${account.username} down`} disabled={index === accounts.length - 1} onClick={() => void moveAccount(account, 1)}>↓</button><button className={`${common.iconButton} ${styles.removeAccount}`} type="button" aria-label={`Remove ${account.username}`} onClick={() => void deleteAccount(account)}><Trash size={16} /></button></span></div>
              ))}
            </div>
            <div className={styles.providerGrid}>
              {bootstrap.providers.map((provider) => <div key={provider.provider}><strong>{provider.provider === "elyby" ? "Ely.by" : provider.provider[0].toUpperCase() + provider.provider.slice(1)}</strong><span className={provider.available ? common.successBadge : common.warningBadge}>{provider.available ? uiText("instance.texts.available", "Available") : uiText("instance.texts.unavailable", "Unavailable")}</span><p>{provider.message ?? uiText("settings.texts.readyToAddFromTheAccountSwitcher", "Ready to add from the account switcher.")}</p></div>)}
            </div>
          </SettingsSection>
        ) : null}

        {section === "storage" ? (
          <SettingsSection title={uiText("settings.storage", "Storage")} description={uiText("settings.texts.everyMutableSlhFileStaysBesideTheExecutable", "Every mutable SLH file stays beside the executable.")}>
            <div className={styles.pathBlock}><HardDrives size={25} /><span><small>{uiText("accounts.texts.dataFolder", "Data folder")}</small><code>{bootstrap.portableRoot}</code></span></div>
            {storageSummary ? (
              <div className={styles.storageDetails}>
                <div className={styles.storageTotal}><span><strong>{formatBytes(storageSummary.totalBytes)}</strong><small>{uiText("settings.texts.dataInUse", "data in use")}</small></span><span>{bootstrap.instances.length}{" "}{uiText("settings.texts.instances", "instances")}</span></div>
                <div className={styles.storageGrid}>
                  <StorageCell label={uiText("settings.texts.instancesaa8c18", "Instances")} bytes={storageSummary.instancesBytes} />
                  <StorageCell label={uiText("settings.texts.runtimeCache", "Runtime cache")} bytes={storageSummary.cacheBytes} />
                  <StorageCell label={uiText("settings.texts.managedJava", "Managed Java")} bytes={storageSummary.javaBytes} />
                  <StorageCell label={uiText("settings.texts.shared", "Shared")} bytes={storageSummary.sharedBytes} />
                  <StorageCell label={uiText("settings.texts.backups", "Backups")} bytes={storageSummary.backupsBytes} />
                  <StorageCell label={uiText("settings.downloads", "Downloads")} bytes={storageSummary.downloadsBytes} />
                  <StorageCell label={uiText("installation.texts.logs", "Logs")} bytes={storageSummary.logsBytes} />
                  <StorageCell label={uiText("settings.texts.database", "Database")} bytes={storageSummary.databaseBytes} />
                </div>
              </div>
            ) : <div className={styles.inlineEmpty}><HardDrives size={28} /><p>{diagnosticsLoading ? uiText("settings.texts.calculatingStorage", "Calculating storage…") : uiText("settings.texts.storageSummaryIsUnavailable", "Storage summary is unavailable.")}</p></div>}
            <p className={styles.notice}>{uiText("settings.texts.runtimeCacheIsRetainedBecauseInstalledInstancesCanDepend", "Runtime cache is retained because installed instances can depend on its verified assets and libraries. Worlds, accounts, and shared files are never treated as disposable cache.")}</p>
          </SettingsSection>
        ) : null}

        {section === "downloads" ? (
          <SettingsSection title={uiText("settings.downloads", "Downloads")} description={uiText("settings.texts.verifiedDownloadsUseRetryTemporaryFilesAndAtomicRename", "Verified downloads use retry, temporary files, and atomic rename.")}>
            <SettingRow title={uiText("settings.texts.concurrentDownloads", "Concurrent downloads")} description={uiText("settings.texts.appliedToLibraryAssetLoaderAndModpackBatches", "Applied to library, asset, loader, and modpack batches.")}><input className={common.input} type="number" min={1} max={32} value={bootstrap.settings.downloads.concurrency} onChange={(event) => void save("downloads", { ...bootstrap.settings.downloads, concurrency: Number(event.target.value) })} /></SettingRow>
            <SettingRow title={uiText("settings.texts.retryCount", "Retry count")} description={uiText("settings.texts.transientFailuresUseExponentialBackoff", "Transient failures use exponential backoff.")}><input className={common.input} type="number" min={0} max={8} value={bootstrap.settings.downloads.retries} onChange={(event) => void save("downloads", { ...bootstrap.settings.downloads, retries: Number(event.target.value) })} /></SettingRow>
            <SettingRow className={styles.formSettingRow} title={uiText("settings.curseforge.folder", "CurseForge downloads folder")} description={uiText("settings.curseforge.folderHint", "SLH looks here for files downloaded from CurseForge in your browser.")}>
              <div className={styles.javaLocation}><code>{bootstrap.settings.downloads.curseforgeDirectory ?? uiText("settings.curseforge.defaultFolder", "Windows Downloads folder")}</code><button className={common.secondaryButton} type="button" onClick={() => void (async () => {
                const selected = await openDialog({ directory: true, multiple: false });
                if (typeof selected === "string") await save("downloads", { ...bootstrap.settings.downloads, curseforgeDirectory: selected });
              })()}>{uiText("settings.texts.chooseFolder", "Choose folder")}</button>{bootstrap.settings.downloads.curseforgeDirectory ? <button className={common.ghostButton} type="button" onClick={() => void save("downloads", { ...bootstrap.settings.downloads, curseforgeDirectory: null })}>{uiText("settings.texts.useDefault", "Use default")}</button> : null}</div>
            </SettingRow>
            <SettingRow title={uiText("settings.curseforge.importArchives", "Import CurseForge archives automatically")} description={uiText("settings.curseforge.importArchivesHint", "Import CurseForge modpack ZIPs downloaded to this folder into your library.")}><Toggle checked={bootstrap.settings.downloads.curseforgeImportArchives === true} onChange={checked => void save("downloads", { ...bootstrap.settings.downloads, curseforgeImportArchives: checked })} /></SettingRow>
            <SettingRow title={uiText("settings.curseforge.deleteAfterInstall", "Delete downloads after installation")} description={uiText("settings.curseforge.deleteAfterInstallHint", "Delete verified mods, resource packs, shaders and the ZIP only after the modpack installs successfully.")}><Toggle checked={bootstrap.settings.downloads.curseforgeDeleteAfterInstall === true} onChange={checked => void save("downloads", { ...bootstrap.settings.downloads, curseforgeDeleteAfterInstall: checked })} /></SettingRow>
            <div className={styles.apiKeyPanel}>
              <div className={styles.apiKeyHeader}><span><strong>{uiText("settings.texts.personalCurseforgeApiKeyOptional", "Personal CurseForge API key (optional)")}</strong><small>{curseForgeKeyStatus?.message ?? uiText("settings.texts.checkingLocalConfiguration", "Checking local configuration")}</small></span><span className={curseForgeKeyStatus?.configured ? common.successBadge : common.badge}>{curseForgeKeyStatus?.configured ? uiText("settings.texts.directApi", "Direct API") : uiText("settings.texts.slhRelay", "SLH relay")}</span></div>
              {curseForgeKeyStatus?.source !== "environment" ? <div className={styles.apiKeyForm}><input className={common.input} type="password" autoComplete="off" spellCheck={false} value={curseForgeKey} onChange={(event) => setCurseForgeKey(event.target.value)} placeholder={uiText("settings.texts.pasteApprovedKeyLocally", "Paste approved key locally")} /><button className={common.secondaryButton} type="button" disabled={curseForgeKeyBusy || !curseForgeKey.trim()} onClick={() => void saveCurseForgeKey()}>{curseForgeKeyBusy ? <BusyIndicator /> : null}{curseForgeKeyBusy ? uiText("discover.texts.checking", "Checking") : uiText("settings.texts.verifyAndSave", "Verify and save")}</button>{curseForgeKeyStatus?.configured ? <button className={common.ghostButton} type="button" disabled={curseForgeKeyBusy} onClick={() => void clearCurseForgeKey()}>{uiText("servers.texts.remove", "Remove")}</button> : null}</div> : null}
              <p>{uiText("settings.texts.theValueNeverEntersSqliteLogsExportsOrUi", "The value never enters SQLite, logs, exports, or UI state after saving. Windows DPAPI ties it to your current Windows profile.")}</p>
            </div>
            {contentProviders.map((provider) => <SettingRow key={provider.provider} title={provider.provider === "modrinth" ? "Modrinth" : "CurseForge"} description={provider.message ?? uiText("settings.texts.contentProviderIsConfigured", "Content provider is configured.")}><span className={provider.available ? common.successBadge : common.warningBadge}>{provider.available ? uiText("instance.texts.available", "Available") : uiText("settings.texts.apiKeyRequired", "API key required")}</span></SettingRow>)}
            <div className={styles.downloadList}>
              <div className={styles.listHeading}><strong>{uiText("settings.texts.recentVerifiedTransfers", "Recent verified transfers")}</strong><span>{downloads.length}{" "}{uiText("settings.texts.records", "records")}</span></div>
              {downloads.length === 0 ? <div className={styles.inlineEmpty}>{diagnosticsLoading ? <BusyIndicator size={28} /> : <DownloadSimple size={28} />}<p>{diagnosticsLoading ? uiText("settings.texts.loadingDownloadHistory", "Loading download history…") : uiText("settings.texts.noQueuedOrCompletedContentDownloads", "No queued or completed content downloads.")}</p></div> : downloads.map((download) => (
                <div className={styles.downloadRow} key={download.id}>
                  <span><strong>{download.destination.split(/[\\/]/).filter(Boolean).pop() ?? uiText("installation.texts.download", "Download")}</strong><small>{download.source} · {new Date(download.updatedAt).toLocaleString(locale)}</small>{download.errorMessage ? <em>{download.errorMessage}</em> : null}</span>
                  <span><small>{formatBytes(download.downloadedBytes)}{download.totalBytes ? ` / ${formatBytes(download.totalBytes)}` : ""}</small><b className={download.status === "complete" ? common.successBadge : download.status === "failed" ? common.errorBadge : common.warningBadge}>{download.status}</b></span>
                </div>
              ))}
            </div>
          </SettingsSection>
        ) : null}

        {section === "notifications" ? (
          <SettingsSection title={uiText("settings.notifications", "Notifications")} description={uiText("settings.texts.chooseWhichLauncherMessagesAppearAndHowLongThey", "Choose which launcher messages appear and how long they stay visible.")}>
            <SettingRow title={uiText("notifications.brief", "Brief notifications")} description={uiText("notifications.briefHint", "Show small interface-scale messages for two seconds inside SLH.")}><Toggle checked={bootstrap.settings.notifications.briefEnabled !== false} onChange={briefEnabled => updateNotifications({briefEnabled})} /></SettingRow>
            <SettingRow title={uiText("settings.texts.showNotifications", "Show notifications")} description={uiText("settings.texts.disablingThisHidesAllToastMessagesActivityProgressRemains", "Disabling this hides all toast messages. Activity progress remains available in the bottom bar.")}><Toggle checked={bootstrap.settings.notifications.enabled} onChange={(checked) => updateNotifications({ enabled: checked })} /></SettingRow>
            <SettingRow title={uiText("settings.texts.notificationLocation", "Notification location")} description={uiText("settings.texts.chooseBetweenLauncherPopUpsAndSystemNotifications", "Choose between launcher pop-ups and system notifications.")}><select className={common.select} value={bootstrap.settings.notifications.destination ?? "launcher"} onChange={(event) => void changeNotificationDestination(event.target.value as "launcher" | "windows")}><option value="launcher">{uiText("settings.texts.inTheLauncher", "In the launcher")}</option><option value="windows">{uiText("settings.texts.inTheSystem", "In the system")}</option></select></SettingRow>
            <SettingRow title={uiText("settings.texts.maximumVisible", "Maximum visible")} description={uiText("settings.texts.olderMessagesCloseAutomaticallyWhenThisLimitIsReached", "Older messages close automatically when this limit is reached.")}><input className={common.input} type="number" value={notificationMaxInput} onChange={(event) => setNotificationMaxInput(event.target.value)} onBlur={() => commitNotificationNumber(notificationMaxInput, 1, 8, bootstrap.settings.notifications.maxVisible, (maxVisible) => updateNotifications({ maxVisible }), setNotificationMaxInput)} /></SettingRow>
            <SettingRow title={uiText("settings.texts.displayTime", "Display time")} description={uiText("settings.texts.howLongEachMessageRemainsVisible", "How long each message remains visible.")}><div className={styles.numeric}><input className={common.input} type="number" value={notificationDurationInput} onChange={(event) => setNotificationDurationInput(event.target.value)} onBlur={() => commitNotificationNumber(notificationDurationInput, 1500, 30000, bootstrap.settings.notifications.durationMs, (durationMs) => updateNotifications({ durationMs }), setNotificationDurationInput)} /><span>{uiText("settings.texts.ms", "ms")}</span></div></SettingRow>
            <SettingRow title={uiText("library.texts.information", "Information")} description={uiText("settings.texts.setupHintsAndNonCriticalStatusMessages", "Setup hints and non-critical status messages.")}><Toggle checked={bootstrap.settings.notifications.showInfo} onChange={(checked) => updateNotifications({ showInfo: checked })} /></SettingRow>
            <SettingRow title={uiText("settings.texts.success", "Success")} description={uiText("settings.texts.completedInstallsRepairsImportsAndSaves", "Completed installs, repairs, imports, and saves.")}><Toggle checked={bootstrap.settings.notifications.showSuccess} onChange={(checked) => updateNotifications({ showSuccess: checked })} /></SettingRow>
            <SettingRow title={uiText("settings.texts.errors", "Errors")} description={uiText("settings.texts.failuresThatMayRequireYourAttention", "Failures that may require your attention.")}><Toggle checked={bootstrap.settings.notifications.showErrors} onChange={(checked) => updateNotifications({ showErrors: checked })} /></SettingRow>
          </SettingsSection>
        ) : null}

        {section === "sync" ? (
          <SettingsSection title={uiText("settings.sync", "Sync")} description={uiText("settings.texts.sharedFoldersAutomaticallyFeedCurrentInstancesAndEveryInstance", "Shared folders automatically feed current instances and every instance created later.")}>
            <div className={styles.safetyCallout}><ShieldCheck size={25} weight="duotone" /><div><strong>{uiText("settings.texts.worldSynchronizationIsOff", "World synchronization is off")}</strong><p>{uiText("settings.texts.worldOverwritesRequireExplicitAcknowledgementABackupAndA", "World overwrites require explicit acknowledgement, a backup, and a check that Minecraft is not running.")}</p></div></div>
            <SettingRow title={uiText("settings.texts.allowWorldMappings", "Allow world mappings")} description={uiText("settings.texts.stillRequiresConfirmationForEveryNewlyCreatedMapping", "Still requires confirmation for every newly created mapping.")}><Toggle checked={bootstrap.settings.sync.worldsEnabled} onChange={(checked) => void save("sync", { ...bootstrap.settings.sync, worldsEnabled: checked }, checked ? "World mapping gate enabled" : "World mapping gate disabled")} /></SettingRow>
            <div className={styles.sharedLibrary}><span><strong>{uiText("settings.texts.sharedLibrary", "Shared library")}</strong><small>{uiText("settings.texts.optionsServersResourcepacksScreenshotsModConfigsAndWorlds", "options, servers, resourcepacks, screenshots, mod-configs, and worlds")}</small></span><button className={common.secondaryButton} type="button" onClick={() => void command("reveal_shared_path").catch((error) => pushToast({ tone: "error", title: uiText("settings.texts.sharedFolderCouldNotBeOpened", "Shared folder could not be opened"), message: String((error as { message?: string }).message ?? error) }))}>{uiText("settings.texts.openSharedFolder", "Open shared folder")}</button></div>
            <div className={styles.syncForm}>
              <div className={styles.syncFields}>
                <label><span>{uiText("settings.texts.content", "Content")}</span><select className={common.select} value={syncCategory} onChange={(event) => setSyncCategory(event.target.value as SyncMapping["category"])}><option value="options">{uiText("settings.texts.options", "Options")}</option><option value="servers">{uiText("navigation.servers", "Servers")}</option><option value="resourcepacks">{uiText("installation.texts.resourcePacks", "Resource packs")}</option><option value="screenshots">{uiText("installation.texts.screenshots", "Screenshots")}</option><option value="mod-configs">{uiText("settings.texts.modConfigs", "Mod configs")}</option><option value="worlds">{uiText("installation.texts.worlds", "Worlds")}</option></select></label>
                <label><span>{uiText("settings.texts.initialSource", "Initial source")}</span><select className={common.select} value={syncInitialSource} onChange={(event) => setSyncInitialSource(event.target.value)}><option value="shared">{uiText("settings.texts.sharedLibrary", "Shared library")}</option>{bootstrap.instances.filter((instance) => syncAllInstances || syncInstances.includes(instance.id)).map((instance) => <option value={instance.id} key={instance.id}>{instance.name}</option>)}</select></label>
              </div>
              <div className={styles.syncInstances}>
                <strong>{uiText("settings.texts.destinationInstances", "Destination instances")}</strong>
                <label><input type="checkbox" checked={syncAllInstances} onChange={(event) => setSyncAllInstances(event.target.checked)} /><span>{uiText("settings.texts.allCurrentAndFutureInstances", "All current and future instances")}</span><small>{uiText("settings.texts.recommended", "Recommended")}</small></label>
                {!syncAllInstances ? bootstrap.instances.map((instance) => <label key={instance.id}><input type="checkbox" checked={syncInstances.includes(instance.id)} onChange={(event) => { const next = event.target.checked ? [...syncInstances, instance.id] : syncInstances.filter((id) => id !== instance.id); setSyncInstances(next); if (syncInitialSource !== "shared" && !next.includes(syncInitialSource)) setSyncInitialSource("shared"); }} /><span>{instance.name}</span><small>{instance.minecraftVersion}</small></label>) : null}
                {!syncAllInstances && bootstrap.instances.length === 0 ? <p>{uiText("settings.texts.noInstancesExistYetUseTheRecommendedAllInstances", "No instances exist yet. Use the recommended all-instances scope to prepare shared content now.")}</p> : null}
              </div>
              <div className={styles.syncCreate}><p>{uiText("settings.texts.afterSetupSlhAppliesTheSharedCopyWhenAn", "After setup, SLH applies the shared copy when an instance is created or imported, before launch, and after Minecraft exits. Manual update remains optional.")}</p><button className={common.button} type="button" disabled={syncBusy || (!syncAllInstances && syncInstances.length === 0) || !syncInitialSource} onClick={() => void createSyncMapping()}>{syncBusy ? <BusyIndicator /> : null}{syncBusy ? uiText("installation.texts.creating", "Creating") : uiText("settings.texts.enableAutomaticSync", "Enable automatic sync")}</button></div>
            </div>
            <div className={styles.mappingList}>
              {syncMappings.length === 0 ? <div className={styles.inlineEmpty}><Database size={28} /><p>{uiText("settings.texts.noSyncMappingsCreateOneAboveToStartSharing", "No sync mappings. Create one above to start sharing files.")}</p></div> : syncMappings.map((mapping) => {
                const available = bootstrap.instances.filter((instance) => mapping.instanceIds.includes("*") || mapping.instanceIds.includes(instance.id));
                const source = syncSources[mapping.id] ?? available[0]?.id ?? "";
                return <div className={styles.mappingRow} key={mapping.id}><span><strong>{mapping.category}</strong><small>{mapping.instanceIds.includes("*") ? uiText("settings.texts.automaticForAllCurrentAndFutureInstances", "Automatic for all current and future instances") : `${mapping.instanceIds.length} selected instances`}{mapping.lastSyncAt ? ` · ${new Date(mapping.lastSyncAt).toLocaleString(locale)}` : ""}</small></span><select className={common.select} aria-label={`Source for ${mapping.category}`} value={source} onChange={(event) => setSyncSources((current) => ({ ...current, [mapping.id]: event.target.value }))}>{available.map((instance) => <option key={instance.id} value={instance.id}>{instance.name}</option>)}</select><button className={common.secondaryButton} type="button" disabled={syncBusy || !mapping.enabled || !source} onClick={() => void syncNow(mapping)}>{syncBusy ? <BusyIndicator /> : null}{uiText("settings.texts.updateNow", "Update now")}</button><Toggle checked={mapping.enabled} onChange={() => void toggleSyncMapping(mapping)} /><button className={common.iconButton} type="button" aria-label={`Remove ${mapping.category} mapping`} onClick={() => void removeSyncMapping(mapping)}><Trash size={16} /></button></div>;
              })}
            </div>
          </SettingsSection>
        ) : null}

        {section === "console" ? (
          <SettingsSection title={uiText("settings.console", "Console")} description={uiText("settings.texts.controlHowLiveMinecraftOutputIsShownForEvery", "Control how live Minecraft output is shown for every instance.")}>
            {consoleSettings ? <>
            <SettingRow title={uiText("settings.texts.openOnLaunch", "Open on launch")} description={uiText("settings.texts.switchToTheInstanceConsoleAsSoonAsMinecraft", "Switch to the instance console as soon as Minecraft starts.")}><Toggle checked={consoleSettings.openOnLaunch} onChange={(checked) => updateConsole({ openOnLaunch: checked })} /></SettingRow>
            <SettingRow title={uiText("settings.texts.openLogsWhenLaunchingFromHome", "Open logs when launching from Home")} description={uiText("settings.texts.switchToLogsAfterLaunchingTheLastBuildFrom", "Switch to logs after launching the last build from the beautiful Home screen.")}><Toggle checked={consoleSettings.openOnHomeLaunch === true} onChange={(checked) => updateConsole({ openOnHomeLaunch: checked })} /></SettingRow>
            <SettingRow title={uiText("settings.texts.showTimestamps", "Show timestamps")} description={uiText("settings.texts.displayTheRecordedTimeBeforeEachConsoleLine", "Display the recorded time before each console line.")}><Toggle checked={consoleSettings.showTimestamps} onChange={(checked) => updateConsole({ showTimestamps: checked })} /></SettingRow>
            <SettingRow title={uiText("settings.texts.wrapLongLines", "Wrap long lines")} description={uiText("settings.texts.keepLongLogLinesInsideTheConsoleWidth", "Keep long log lines inside the console width.")}><Toggle checked={consoleSettings.wrapLines} onChange={(checked) => updateConsole({ wrapLines: checked })} /></SettingRow>
            <SettingRow title={uiText("settings.texts.followOutput", "Follow output")} description={uiText("settings.texts.scrollToNewLinesWhileTheConsoleIsOpen", "Scroll to new lines while the console is open.")}><Toggle checked={consoleSettings.autoScroll} onChange={(checked) => updateConsole({ autoScroll: checked })} /></SettingRow>
            <SettingRow title={uiText("settings.texts.fontSize", "Font size")} description={uiText("settings.texts.sizeOfConsoleTextInPixels", "Size of console text in pixels.")}><div className={styles.numeric}><input className={common.input} type="number" min={10} max={22} value={consoleSettings.fontSize} onChange={(event) => updateConsole({ fontSize: Number(event.target.value) })} /><span>{uiText("settings.texts.px", "px")}</span></div></SettingRow>
            <SettingRow title={uiText("settings.texts.lineHistory", "Line history")} description={uiText("settings.texts.maximumNumberOfRecentLinesKeptInTheInterface", "Maximum number of recent lines kept in the interface.")}><input className={common.input} type="number" min={250} max={10000} step={250} value={consoleSettings.maxLines} onChange={(event) => updateConsole({ maxLines: Number(event.target.value) })} /></SettingRow>
            <div className={styles.consoleColors}>{consoleColors.map(([key, label]) => <label key={key}><span>{tr(label)}</span><span><input type="color" value={consoleSettings[key]} onChange={(event) => updateConsole({ [key]: event.target.value })} /><code>{consoleSettings[key]}</code></span></label>)}</div>
            <div className={styles.consoleActions}><button className={common.secondaryButton} type="button" onClick={() => updateConsole(defaultConsoleSettings)}>{uiText("settings.texts.restoreDefaultColors", "Restore default colors")}</button></div>
            <div className={styles.consolePreview} style={{ background: consoleSettings.background, color: consoleSettings.foreground, fontSize: `${consoleSettings.fontSize}px` }}>
              <span><time style={{ color: consoleSettings.timestamp }}>[20:45:10]</time><b style={{ color: consoleSettings.info }}>{" "}{uiText("settings.texts.info", "[INFO]")}</b> {uiText("settings.texts.minecraftClientIsStarting", "Minecraft client is starting")}</span>
              <span><time style={{ color: consoleSettings.timestamp }}>[20:45:12]</time><b style={{ color: consoleSettings.warning }}>{" "}{uiText("settings.texts.warn", "[WARN]")}</b> {uiText("settings.texts.exampleWarningMessage", "Example warning message")}</span>
              <span><time style={{ color: consoleSettings.timestamp }}>[20:45:13]</time><b style={{ color: consoleSettings.error }}>{" "}{uiText("settings.texts.error411949", "[ERROR]")}</b> {uiText("settings.texts.exampleErrorMessage", "Example error message")}</span>
              <span><time style={{ color: consoleSettings.timestamp }}>[20:45:14]</time><b style={{ color: consoleSettings.debug }}>{" "}{uiText("settings.texts.debug", "[DEBUG]")}</b> {uiText("settings.texts.diagnosticOutput", "Diagnostic output")}</span>
            </div>
            </> : null}
          </SettingsSection>
        ) : null}

        {section === "privacy" ? (
          <SettingsSection title={uiText("settings.privacy", "Privacy")} description={uiText("settings.texts.thisPersonalBuildHasNoAnalyticsAdvertisingTelemetryOr", "This personal build has no analytics, advertising, telemetry, or background data collection.")}>
            <SettingRow title={uiText("settings.texts.telemetry", "Telemetry")} description={uiText("settings.texts.noTelemetryClientExistsInSlh", "No telemetry client exists in SLH.")}><span className={common.successBadge}>{uiText("settings.texts.alwaysOff", "Always off")}</span></SettingRow>
            <SettingRow title={uiText("settings.texts.crashReporting", "Crash reporting")} description={uiText("settings.texts.crashDataRemainsInLocalLogsUnlessYouCopy", "Crash data remains in local logs unless you copy it yourself.")}><span className={common.successBadge}>{uiText("settings.texts.localOnly", "Local only")}</span></SettingRow>
            <div className={styles.networkList}><strong>{uiText("settings.texts.servicesContactedOnlyWhenNeeded", "Services contacted only when needed")}</strong><p>{uiText("settings.texts.mojangMetadataAndAssetsMicrosoftAuthenticationWhenConfiguredModrinth", "Mojang metadata and assets, Microsoft authentication when configured, Modrinth, CurseForge when configured, Ely.by when used, and the chosen managed Java source.")}</p></div>
          </SettingsSection>
        ) : null}

        {section === "advanced" ? (
          <SettingsSection title={uiText("settings.advanced", "Advanced")} description={uiText("settings.texts.diagnosticsAndDeveloperControlsRemainExplicitAndNonDestructive", "Diagnostics and developer controls remain explicit and non-destructive.")}>
            <div className={styles.tileGrid}>
            <SettingRow title={uiText("settings.texts.checkForLauncherUpdatesAutomatically", "Check for launcher updates automatically")} description={uiText("settings.texts.checkGithubForANewerSlhReleaseOnceWhen", "Check GitHub for a newer SLH release once when the launcher starts.")}>
              <Toggle checked={bootstrap.settings.general.checkUpdatesAutomatically !== false} onChange={(checked) => updateGeneral({ checkUpdatesAutomatically: checked })} />
            </SettingRow>
            </div>
            <div className={styles.tileGrid}>
            <SettingRow title={uiText("settings.texts.launcherVersion", "Launcher version")} description={uiText("settings.texts.clickTheVersionToViewThisBuildSLocal", "Click the version to view this build's local date and time.")}><button className={styles.buildVersion} type="button" onClick={() => setShowBuildTime((value) => !value)} title={uiText("settings.texts.showBuildTime", "Show build time")}>{showBuildTime && bootstrap.buildUnix > 0 ? new Date(bootstrap.buildUnix * 1000).toLocaleString(locale) : `SLH ${bootstrap.version}`}</button></SettingRow>
            <SettingRow title={uiText("settings.texts.launcherUpdates", "Launcher updates")} description={uiText("settings.texts.checkTheOfficialGithubReleasesPageForANewer", "Check the official GitHub releases page for a newer launcher build.")}>
              <div className={styles.updateControl}>
                <button className={common.secondaryButton} type="button" disabled={launcherUpdateBusy} onClick={() => void checkLauncherUpdates()}>{launcherUpdateBusy ? <BusyIndicator /> : null}{launcherUpdateBusy ? uiText("discover.texts.checking", "Checking") : uiText("settings.texts.checkForUpdates", "Check for updates")}</button>
                {launcherUpdate?.updateAvailable ? <button className={common.button} type="button" onClick={() => requestLauncherUpdate(launcherUpdate)}>{t("updater.install")}</button> : null}
              </div>
            </SettingRow>
            </div>
            {launcherUpdate ? <p className={`${styles.notice} ${launcherUpdate.updateAvailable ? styles.updateNotice : ""}`}>{launcherUpdate.updateAvailable ? `${uiText("settings.texts.newVersionAvailable", "New version available")}: ${launcherUpdate.latestVersion} · ${launcherUpdate.releaseName}` : `${uiText("settings.texts.launcherIsUpToDate", "Launcher is up to date")}: ${launcherUpdate.currentVersion}`}</p> : null}
            <div className={styles.tileGrid}>
            <SettingRow title={uiText("settings.texts.database", "Database")} description={uiText("settings.texts.sqliteWalForeignKeysAndForwardOnlyMigrations", "SQLite WAL, foreign keys, and forward-only migrations.")}><span className={common.successBadge}>{uiText("settings.texts.healthy", "Healthy")}</span></SettingRow>
            <SettingRow title={uiText("settings.texts.logging", "Logging")} description={uiText("settings.texts.dailyLogFilesWithSecretRedactionBoundaries", "Daily log files with secret redaction boundaries.")}><span className={common.badge}>{uiText("settings.texts.info170322", "Info")}</span></SettingRow>
            </div>
            <p className={styles.notice}>{uiText("settings.texts.databaseResetForcedMetadataRefreshAndInstanceRepairAre", "Database reset, forced metadata refresh, and instance repair are withheld until each action has preview and confirmation.")}</p>
          </SettingsSection>
        ) : null}
      </section>
      {settingsDockDrag ? <>
        <div className={`${styles.dockDropIndicator} ${settingsDockDrag.position === "left" ? styles.dockDropLeft : styles.dockDropRight}`} style={{ width: settingsDockDrag.width, top: settingsDockDrag.top, height: settingsDockDrag.height }} aria-hidden="true" />
        <div className={styles.dockDragPreview} style={{ left: settingsDockDrag.x, top: settingsDockDrag.y }} aria-hidden="true"><ArrowRight size={16} style={{ transform: `rotate(${dockArrowRotation(settingsDockDrag.position)}deg)` }} /><span>{uiText("navigation.settings", "Settings")}</span></div>
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
  const layout: React.ReactNode[] = [];
  let rows: React.ReactNode[] = [];
  const flush = () => { if (rows.length) { layout.push(<div className={styles.tileGrid} key={layout.length}>{rows}</div>); rows=[]; } };
  const flatten = (nodes: React.ReactNode): React.ReactNode[] => Children.toArray(nodes).flatMap(child =>
    isValidElement<{children?: React.ReactNode}>(child) && child.type === Fragment ? flatten(child.props.children) : [child]);
  flatten(children).forEach(child => {
    if (isValidElement<{ className?: string }>(child) && child.type === SettingRow && !child.props.className) rows.push(child);
    else { flush(); layout.push(child); }
  });
  flush();
  return <div className={styles.section}><header><h2>{tr(title)}</h2><p data-minimal-text>{tr(description)}</p></header><div className={styles.sectionBody}>{layout}</div></div>;
}

const SettingLabel = createContext<string | undefined>(undefined);

function SettingRow({ title, description, children, className = "" }: { title: string; description: string; children: React.ReactNode; className?: string }) {
  const { tr } = useI18n();
  const toggle = Children.toArray(children).find(child => isValidElement(child) && child.type === Toggle);
  const clickable = Children.toArray(children).length === 1 && isValidElement<{disabled?:boolean}>(toggle) && !toggle.props.disabled;
  return <div className={`${styles.settingRow} ${className} ${clickable ? styles.switchRow : ""}`} onClick={clickable ? event => {
    if ((event.target as HTMLElement).closest('button,input,select,textarea,a,label,[role="button"],[role="switch"]')) return;
    if (isValidElement<{checked:boolean;onChange:(checked:boolean)=>void}>(toggle)) toggle.props.onChange(!toggle.props.checked);
  } : undefined}><div><strong data-minimal-title>{tr(title)}</strong><p data-minimal-text>{tr(description)}</p></div><div className={styles.settingControl}><SettingLabel.Provider value={tr(title)}>{children}</SettingLabel.Provider></div></div>;
}

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label?: string }) {
  const settingLabel = useContext(SettingLabel);
  return <button type="button" role="switch" aria-label={label ?? settingLabel} aria-checked={checked} disabled={disabled} className={`${styles.toggle} ${checked ? styles.checked : ""}`} onClick={() => onChange(!checked)}><span /></button>;
}

function StorageCell({ label, bytes }: { label: string; bytes: number }) {
  const { tr } = useI18n();
  return <div><strong>{tr(label)}</strong><span>{formatBytes(bytes)}</span></div>;
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
