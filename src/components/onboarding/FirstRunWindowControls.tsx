import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUiText } from "../../i18n/UiText";
import { desktopPlatform, windowAppearance } from "../../lib/platformAppearance";
import { isTauri } from "../../lib/tauri";
import { useAppStore } from "../../stores/appStore";
import { Minus, Square, X } from "../icons";
import titlebar from "../shell/Titlebar.module.css";
import styles from "./FirstRun.module.css";

export function FirstRunWindowControls() {
  const t = useUiText();
  const settings = useAppStore(state => state.bootstrap?.settings);
  const platform = desktopPlatform();
  const controls = windowAppearance(settings?.appearance, settings?.general.platformCustomization === true, platform);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    const window = getCurrentWindow();
    let disposed = false;
    const update = async () => { const value = platform === "macos" ? await window.isFullscreen() : await window.isMaximized(); if (!disposed) setMaximized(value); };
    void update();
    const listener = window.onResized(() => void update());
    return () => { disposed = true; void listener.then(stop => stop()); };
  }, [platform]);
  const action = async (name: "minimize" | "maximize" | "close") => {
    if (!isTauri) return;
    const window = getCurrentWindow();
    if (name === "minimize") await window.minimize();
    if (name === "maximize") { if (platform === "macos") await window.setFullscreen(!await window.isFullscreen()); else await window.toggleMaximize(); }
    if (name === "close") await window.close();
  };
  return <div className={styles.windowBar} data-tauri-drag-region data-first-run-window-bar>
    <div className={`${titlebar.windowControls} ${titlebar[controls.style]} ${styles.firstRunControls} ${controls.side === "left" ? styles.left : styles.right}`} data-window-style={controls.style} data-window-side={controls.side}>
      <button className={titlebar.minimize} type="button" aria-label={t("shell.texts.minimize", "Minimize")} onClick={() => void action("minimize")}><Minus size={15} /></button>
      <button className={titlebar.maximize} type="button" aria-label={maximized ? t("audit.restoreWindow") : platform === "macos" ? t("audit.fullscreen") : t("shell.texts.maximize", "Maximize")} onClick={() => void action("maximize")}><Square size={12} /></button>
      <button className={titlebar.close} type="button" aria-label={t("common.close", "Close")} onClick={() => void action("close")}><X size={15} /></button>
    </div>
  </div>;
}
