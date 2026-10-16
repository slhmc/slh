import { LauncherUpdateDialog, requestLauncherUpdate } from "./components/common/LauncherUpdateDialog";
import { useUiText } from "./i18n/UiText";
import { buildTheme } from "./lib/theme";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { HashRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useActionMenus } from "./lib/useActionMenus";
import { subscribeWindowActivity } from "./lib/windowActivity";
import { useCurseForgeArchiveImport } from "./lib/useCurseForgeArchiveImport";
import { WarningCircle } from "./components/icons";
import { I18nProvider, useI18n } from "./i18n/I18nProvider";
import { command, isTauri } from "./lib/tauri";
import { subscribeUiEvents } from "./lib/uiEvents";
import { useAppStore } from "./stores/appStore";
import type { LauncherUpdateInfo, LaunchStateEvent, ProgressEvent } from "./lib/types";
import { BrandLogo } from "./components/brand/BrandLogo";
import { AppShell } from "./components/shell/AppShell";
import { FirstRun } from "./components/onboarding/FirstRun";
const HomePage = lazy(() => import("./routes/Home/HomePage").then((module) => ({ default: module.HomePage })));
const LibraryPage = lazy(() => import("./routes/Library/LibraryPage").then((module) => ({ default: module.LibraryPage })));
const DiscoverPage = lazy(() => import("./routes/Discover/DiscoverPage").then((module) => ({ default: module.DiscoverPage })));
const ServersPage = lazy(() => import("./routes/Servers/ServersPage").then((module) => ({ default: module.ServersPage })));
const SettingsPage = lazy(() => import("./routes/Settings/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const InstancePage = lazy(() => import("./routes/Instance/InstancePage").then((module) => ({ default: module.InstancePage })));
import common from "./components/common/Common.module.css";
import styles from "./App.module.css";

const mainSections = new Set(["home", "library", "discover", "servers"]);

function StartupRoute() {
  const bootstrap = useAppStore((state) => state.bootstrap);
  const remembered = bootstrap?.settings.general.lastSection;
  const destination = bootstrap?.settings.general.rememberSection && remembered && mainSections.has(remembered)
    ? remembered
    : "library";
  return <Navigate to={`/${destination}`} replace />;
}

function RememberSection() {
  const bootstrap = useAppStore((state) => state.bootstrap);
  const location = useLocation();

  useEffect(() => {
    if (!bootstrap?.settings.general.rememberSection) return;
    const section = location.pathname.split("/")[1]?.toLowerCase();
    if (!section || !mainSections.has(section) || bootstrap.settings.general.lastSection === section) return;
    void command("remember_section", { section }).catch(() => undefined);
  }, [bootstrap, location.pathname]);

  return null;
}

export default function App() {
  const locale = useAppStore((state) => state.bootstrap?.settings.general.language ?? "en-US");
  return (
    <I18nProvider locale={locale}>
      <AppContent />
    </I18nProvider>
  );
}

function AppContent() {
  const uiText = useUiText();
  useActionMenus();
  useEffect(() => {
    const released = (event: Event) => {
      const generation = (event as CustomEvent<number>).detail;
      queueMicrotask(() => { if (isTauri) void command("scenes_released", { generation }).catch(() => undefined); });
    };
    window.addEventListener("slh-release-scenes", released);
    const paused = (event: Event) => {
      const generation = (event as CustomEvent<number>).detail;
      queueMicrotask(() => { if (isTauri) void command("ui_paused", { generation }).catch(() => undefined); });
    };
    window.addEventListener("slh-ui-pause", paused);
    return () => { window.removeEventListener("slh-release-scenes", released); window.removeEventListener("slh-ui-pause", paused); };
  }, []);
  useEffect(() => subscribeWindowActivity((active) => {
    document.documentElement.dataset.slhWindowActive = String(active);
  }), []);
  const initialize = useAppStore((state) => state.initialize);
  const bootstrap = useAppStore((state) => state.bootstrap);
  const loading = useAppStore((state) => state.loading);
  useCurseForgeArchiveImport(bootstrap?.settings.downloads.curseforgeImportArchives === true,
    bootstrap?.settings.downloads.curseforgeDirectory);
  const error = useAppStore((state) => state.error);
  const receiveProgress = useAppStore((state) => state.receiveProgress);
  const receiveLaunchState = useAppStore((state) => state.receiveLaunchState);
  const refresh = useAppStore((state) => state.refresh);
  const pushToast = useAppStore((state) => state.pushToast);
  const { tr } = useI18n();
  const autoUpdateChecked = useRef("");
  const [localFontReady, setLocalFontReady] = useState(false);

  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => {
    if (!bootstrap || bootstrap.settings.general.checkUpdatesAutomatically === false) return;
    if (autoUpdateChecked.current === bootstrap.version) return;
    autoUpdateChecked.current = bootstrap.version;
    // A failed background check is intentionally silent: startup must remain
    // usable when GitHub or the local network is unavailable.
    void command<LauncherUpdateInfo>("check_launcher_updates")
      .then((result) => {
        if (result.updateAvailable) {
          requestLauncherUpdate(result);
        }
      })
      .catch(() => undefined);
  }, [bootstrap?.settings.general.checkUpdatesAutomatically, bootstrap?.version, pushToast, tr]);
  useEffect(() => {
    const cancelTransientUi = () => {
      window.dispatchEvent(new Event("slh-ui-cancel"));
      window.dispatchEvent(new Event("slh-context-menu-open"));
    };
    const onVisibilityChange = () => { if (document.visibilityState === "hidden") cancelTransientUi(); };
    const onScreenshotShortcut = (event: KeyboardEvent) => {
      const isWindowsScreenshot = event.key.toLowerCase() === "s"
        && event.shiftKey
        && (event.metaKey || event.getModifierState("OS") || event.getModifierState("Win"));
      if (isWindowsScreenshot) cancelTransientUi();
    };
    window.addEventListener("blur", cancelTransientUi);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("keydown", onScreenshotShortcut);
    return () => {
      window.removeEventListener("blur", cancelTransientUi);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("keydown", onScreenshotShortcut);
    };
  }, []);
  useEffect(() => {
    return subscribeUiEvents((event) => {
      if (event.name === "slh-operation-progress") receiveProgress(event.payload as ProgressEvent, event.notified);
      if (event.name === "slh-launch-state") receiveLaunchState(event.payload as LaunchStateEvent, event.notified);
      if (event.name === "slh-sync-error" && !event.notified) pushToast({ tone: "error", title: "Sync failed", message: (event.payload as { message: string }).message });
    }, () => { void refresh(); });
  }, [receiveLaunchState, receiveProgress, refresh, pushToast]);
  useEffect(() => {
    if (!isTauri) return;
    const current = getCurrentWindow();
    const cleanups: Array<() => void> = [];
    let active = true;
    let closing = false;
    let saveTimer: number | undefined;
    const save = () => command<void>("save_window_state").catch(() => undefined);
    const scheduleSave = () => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => void save(), 400);
    };
    void Promise.all([
      current.onMoved(scheduleSave),
      current.onResized(scheduleSave),
      current.onCloseRequested(async (event) => {
        if (closing) return;
        event.preventDefault();
        closing = true;
        window.clearTimeout(saveTimer);
        await save();
        await command("exit_app");
      }),
    ]).then((unlisteners) => {
      if (active) cleanups.push(...unlisteners);
      else unlisteners.forEach((unlisten) => unlisten());
    });
    return () => {
      active = false;
      window.clearTimeout(saveTimer);
      cleanups.forEach((unlisten) => unlisten());
    };
  }, []);
  useEffect(() => {
    if (!bootstrap || !isTauri) return;
    void getCurrentWebview().setZoom(bootstrap.settings.appearance.scalePercent / 100).catch(() => undefined);
  }, [bootstrap?.settings.appearance.scalePercent]);
  useEffect(() => {
    if (!bootstrap || bootstrap.settings.general.keyboardZoom === false) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const increase = event.code === "Equal" || event.code === "NumpadAdd";
      const decrease = event.code === "Minus" || event.code === "NumpadSubtract";
      if (!increase && !decrease) return;
      event.preventDefault();
      const current = bootstrap.settings.appearance.scalePercent;
      const next = Math.max(50, Math.min(200, current + (increase ? 5 : -5)));
      if (next === current) return;
      void command("update_setting", {
        key: "appearance",
        value: { ...bootstrap.settings.appearance, scalePercent: next },
      }).then(async () => { await refresh(); pushToast({ brief: true, tone: "info", title: "notifications.scaleChanged", params: { percent: next }, message: "" }); }).catch(() => undefined);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bootstrap?.settings.appearance, bootstrap?.settings.general.keyboardZoom, refresh, pushToast, uiText]);
  useEffect(() => {
    let active = true;
    let localFace: FontFace | undefined;
    setLocalFontReady(false);
    if (!bootstrap || bootstrap.settings.appearance.fontFamily !== "local" || !isTauri) return undefined;
    void command<string | null>("get_local_font_data")
      .then(async (data) => {
        if (!data || !active) return;
        localFace = new FontFace("SLH Local Font", `url(${data})`);
        await localFace.load();
        if (active) {
          document.fonts.add(localFace);
          setLocalFontReady(true);
        }
      })
      .catch(() => { if (active) setLocalFontReady(false); });
    return () => {
      active = false;
      if (localFace) document.fonts.delete(localFace);
    };
  }, [bootstrap?.settings.appearance.customFontPath, bootstrap?.settings.appearance.fontFamily]);

  useEffect(() => {
    const appearance = bootstrap?.settings.appearance;
    if (!appearance) return;
    const root = document.documentElement;
    root.dataset.themeChanging = "true";
    const family = appearance.fontFamily === "system" ? '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif'
      : appearance.fontFamily === "monospace" ? '"Cascadia Code", Consolas, monospace'
      : appearance.fontFamily === "local" && localFontReady ? '"SLH Local Font", "Pixeloid Sans", sans-serif'
      : '"Pixeloid Sans", "Segoe UI", system-ui, sans-serif';
    const theme = buildTheme(appearance, family);
    Object.entries(theme).forEach(([key, value]) => { if (key.startsWith("--")) root.style.setProperty(key, String(value)); });
    root.style.colorScheme = String(theme.colorScheme);
    void root.offsetHeight;
    const frame = requestAnimationFrame(() => { delete root.dataset.themeChanging; });
    return () => { cancelAnimationFrame(frame); delete root.dataset.themeChanging; };
  }, [bootstrap?.settings.appearance, localFontReady]);

  if (loading) return <div className={styles.loading}><BrandLogo variant="icon" /><div className={styles.loadingBar}><span /></div><p>{uiText("common.texts.preparingLauncherData", "Preparing launcher data")}</p></div>;
  if (error || !bootstrap) return <div className={styles.error}><WarningCircle size={42} /><h1>{uiText("common.texts.slhCouldNotStart", "SLH could not start")}</h1><p>{error?.message ?? uiText("common.texts.theLauncherBackendDidNotReturnStartupData", "The launcher backend did not return startup data.")}</p><button className={common.secondaryButton} type="button" onClick={() => void initialize()}>{uiText("common.retry", "Retry")}</button></div>;

  const appearance = bootstrap.settings.appearance;
  const fontFamily = appearance.fontFamily === "system"
    ? '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif'
    : appearance.fontFamily === "monospace"
      ? '"Cascadia Code", "Cascadia Mono", Consolas, monospace'
      : appearance.fontFamily === "local" && localFontReady
        ? '"SLH Local Font", "Pixeloid Sans", sans-serif'
        : '"Pixeloid Sans", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif';
  const theme = buildTheme(appearance, fontFamily);

  return (
    <div style={theme} className={styles.themeRoot} data-minimalism={appearance.minimalism === true ? "true" : "false"}>
        <HashRouter>
          <RememberSection />
          <Suspense fallback={<div role="status" aria-label={uiText("common.texts.loading", "Loading")} />}><Routes>
            <Route element={<AppShell />}>
              <Route index element={<StartupRoute />} />
              <Route path="home" element={<HomePage />} />
              <Route path="library" element={<LibraryPage />} />
              <Route path="discover" element={<DiscoverPage />} />
              <Route path="servers" element={<ServersPage />} />
              <Route path="settings/:section" element={<SettingsPage />} />
              <Route path="instance/:id" element={<InstancePage />} />
              <Route path="*" element={<Navigate to="/library" replace />} />
            </Route>
          </Routes></Suspense>
          <FirstRun />
          <LauncherUpdateDialog />
        </HashRouter>
    </div>
  );
}
