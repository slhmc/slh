import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { HashRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useActionMenus } from "./lib/useActionMenus";
import { subscribeWindowActivity } from "./lib/windowActivity";
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

function accentContrast(hex: string, dark: string, light: string) {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 > 165 ? dark : light;
}

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
    void command("update_setting", {
      key: "general",
      value: { ...bootstrap.settings.general, lastSection: section },
    }).catch(() => undefined);
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
  useActionMenus();
  useEffect(() => {
    const released = (event: Event) => {
      const generation = (event as CustomEvent<number>).detail;
      queueMicrotask(() => { if (isTauri) void command("scenes_released", { generation }).catch(() => undefined); });
    };
    window.addEventListener("slh-release-scenes", released);
    return () => window.removeEventListener("slh-release-scenes", released);
  }, []);
  useEffect(() => subscribeWindowActivity((active) => {
    document.documentElement.dataset.slhWindowActive = String(active);
  }), []);
  const initialize = useAppStore((state) => state.initialize);
  const bootstrap = useAppStore((state) => state.bootstrap);
  const loading = useAppStore((state) => state.loading);
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
          pushToast({ tone: "info", title: tr("Launcher update available"), message: `${result.latestVersion} ${tr("is ready on GitHub.")}`, action: { label: tr("Open release"), url: result.releaseUrl } });
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
      }).then(() => refresh()).catch(() => undefined);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bootstrap?.settings.appearance, bootstrap?.settings.general.keyboardZoom, refresh]);
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

  if (loading) return <div className={styles.loading}><BrandLogo variant="icon" /><div className={styles.loadingBar}><span /></div><p>{tr("Preparing launcher data")}</p></div>;
  if (error || !bootstrap) return <div className={styles.error}><WarningCircle size={42} /><h1>{tr("SLH could not start")}</h1><p>{error?.message ?? tr("The launcher backend did not return startup data.")}</p><button className={common.secondaryButton} type="button" onClick={() => void initialize()}>{tr("Retry")}</button></div>;

  const appearance = bootstrap.settings.appearance;
  const fontFamily = appearance.fontFamily === "system"
    ? '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif'
    : appearance.fontFamily === "monospace"
      ? '"Cascadia Code", "Cascadia Mono", Consolas, monospace'
      : appearance.fontFamily === "local" && localFontReady
        ? '"SLH Local Font", "Pixeloid Sans", sans-serif'
        : '"Pixeloid Sans", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif';
  const theme = {
    "--color-bg": appearance.background,
    "--color-sidebar": `color-mix(in srgb, ${appearance.background} 86%, ${appearance.surface})`,
    "--color-surface": appearance.surface,
    "--color-surface-2": appearance.surface2,
    // A tertiary surface must remain a surface in dark themes. Mixing it with
    // white text made every secondary button unexpectedly grey.
    "--color-surface-3": `color-mix(in srgb, ${appearance.surface2} 68%, ${appearance.background})`,
    "--color-border": appearance.border,
    "--color-border-strong": `color-mix(in srgb, ${appearance.border} 64%, ${appearance.text})`,
    "--color-text": appearance.text,
    "--color-text-muted": appearance.textMuted,
    "--color-text-subtle": `color-mix(in srgb, ${appearance.textMuted} 68%, ${appearance.surface})`,
    "--color-accent": appearance.accent,
    "--color-accent-hover": appearance.accentHover,
    "--color-accent-pressed": appearance.accentPressed,
    "--color-accent-contrast": accentContrast(appearance.accent, appearance.background, appearance.text),
    "--color-focus": appearance.accentHover,
    "--color-on-surface": appearance.text,
    "--color-surface-deep": `color-mix(in srgb, ${appearance.background} 72%, ${appearance.surface})`,
    "--color-surface-deeper": `color-mix(in srgb, ${appearance.background} 84%, ${appearance.surface})`,
    "--color-surface-hover": `color-mix(in srgb, ${appearance.surface2} 78%, ${appearance.text})`,
    "--color-accent-soft": `color-mix(in srgb, ${appearance.accent} 16%, transparent)`,
    "--color-accent-border": `color-mix(in srgb, ${appearance.accent} 55%, ${appearance.border})`,
    // Status colors are derived from the active palette, so custom themes do
    // not fall back to unrelated fixed green/yellow/red UI colors.
    "--color-success": `color-mix(in srgb, ${appearance.accentHover} 68%, ${appearance.text})`,
    "--color-warning": `color-mix(in srgb, ${appearance.accent} 78%, ${appearance.text})`,
    "--color-error": `color-mix(in srgb, ${appearance.accentPressed} 70%, ${appearance.text})`,
    "--color-success-soft": `color-mix(in srgb, color-mix(in srgb, ${appearance.accentHover} 68%, ${appearance.text}) 15%, ${appearance.surface})`,
    "--color-warning-soft": `color-mix(in srgb, color-mix(in srgb, ${appearance.accent} 78%, ${appearance.text}) 15%, ${appearance.surface})`,
    "--color-error-soft": `color-mix(in srgb, color-mix(in srgb, ${appearance.accentPressed} 70%, ${appearance.text}) 15%, ${appearance.surface})`,
    "--color-danger": `color-mix(in srgb, ${appearance.accentPressed} 70%, ${appearance.text})`,
    "--color-link": `color-mix(in srgb, ${appearance.accentHover} 42%, ${appearance.text})`,
    "--color-overlay": `color-mix(in srgb, ${appearance.background} 68%, transparent)`,
    "--color-overlay-strong": `color-mix(in srgb, ${appearance.background} 86%, transparent)`,
    "--color-shadow": `color-mix(in srgb, ${appearance.background} 84%, transparent)`,
    "--color-highlight": `color-mix(in srgb, ${appearance.text} 12%, transparent)`,
    "--color-scrollbar": `color-mix(in srgb, ${appearance.border} 72%, ${appearance.text})`,
    "--shadow-panel": `0 16px 44px color-mix(in srgb, ${appearance.background} 28%, transparent)`,
    "--shadow-dialog": `0 28px 90px color-mix(in srgb, ${appearance.background} 52%, transparent)`,
    "--font-ui": fontFamily,
    colorScheme: isLightColor(appearance.background) ? "light" : "dark",
  } as CSSProperties;

  return (
    <div style={theme} className={styles.themeRoot} data-minimalism={appearance.minimalism === true ? "true" : "false"}>
        <HashRouter>
          <RememberSection />
          <Suspense fallback={<div role="status" aria-label="Loading" />}><Routes>
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
        </HashRouter>
    </div>
  );
}

function isLightColor(color: string): boolean {
  const hex = color.replace("#", "");
  if (hex.length !== 6) return false;
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000 > 155;
}
