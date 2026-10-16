import { useUiText } from "../../i18n/UiText";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  DownloadSimple,
  Minus,
  Plus,
  Square,
  X,
} from "../icons";
import { command, isTauri } from "../../lib/tauri";
import type { Instance } from "../../lib/types";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n/I18nProvider";
import common from "../common/Common.module.css";
import styles from "./Titlebar.module.css";
import { ArchiveImportDialog } from "../instance/ArchiveImportDialog";
import launcherLogo from "../../assets/brand/Smile_LauncHer_logo.png";

export function Titlebar({ navigation }: { navigation?: ReactNode }) {
  const uiText = useUiText();
  const { t, tr } = useI18n();
  const openWizard = useAppStore((state) => state.setCreateWizardOpen);
  const pushToast = useAppStore((state) => state.pushToast);
  const refresh = useAppStore((state) => state.refresh);
  const selectInstance = useAppStore((state) => state.selectInstance);
  const [archivePath, setArchivePath] = useState<string | null>(null);
  const onArchiveImported = useCallback(async (instance: Instance, path: string) => {
    await refresh();
    selectInstance(instance.id);
    pushToast({ tone: "success", title: uiText("shell.texts.instanceImported", "Instance {name} imported", { name: instance.name }), message: "" });
    setArchivePath((current) => current === path ? null : current);
  }, [refresh, selectInstance, pushToast, tr]);
  const importMenuRef = useRef<HTMLDetailsElement>(null);


  const windowAction = async (action: "minimize" | "maximize" | "close") => {
    if (!isTauri) return;
    const current = getCurrentWindow();
    if (action === "minimize") await current.minimize();
    if (action === "maximize") await current.toggleMaximize();
    if (action === "close") await current.close();
  };

  const importArchive = async () => {
    importMenuRef.current?.removeAttribute("open");
    if (!isTauri) {
      pushToast({ tone: "info", title: uiText("shell.texts.desktopAction", "Desktop action"), message: uiText("shell.texts.archiveSelectionIsAvailableInTheDesktopApplication", "Archive selection is available in the desktop application.") });
      return;
    }
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Minecraft and SLH archives", extensions: ["zip", "mrpack"] }],
    });
    if (!selected) return;
    setArchivePath(typeof selected === "string" ? selected : selected[0]);
  };

  const importFolder = async () => {
    importMenuRef.current?.removeAttribute("open");
    if (!isTauri) {
      pushToast({ tone: "info", title: uiText("shell.texts.desktopAction", "Desktop action"), message: uiText("shell.texts.folderSelectionIsAvailableInTheDesktopApplication", "Folder selection is available in the desktop application.") });
      return;
    }
    const selected = await open({ multiple: false, directory: true });
    if (!selected) return;
    try {
      const instance = await command<Instance>("import_instance_folder", {
        request: { sourcePath: selected },
      });
      await refresh();
      selectInstance(instance.id);
      pushToast({ tone: "success", title: uiText("shell.texts.folderImported", "Folder {name} imported", { name: instance.name }), message: "" });
    } catch (error) {
      pushToast({ tone: "error", title: uiText("shell.texts.folderCouldNotBeImported", "Folder could not be imported"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  return (
    <>
    <header className={`${styles.titlebar} ${navigation ? styles.compact : ""}`} data-tauri-drag-region>
      <div className={styles.title} data-tauri-drag-region>
        <img className={styles.appLogo} src={launcherLogo} alt={uiText("shell.texts.smileLauncherLogo", "Smile LauncHer logo")} />
        <span className={styles.appName}>{uiText("common.texts.smileLauncher", "Smile LauncHer")}</span>
        {!isTauri ? <span className={styles.preview}>{t("titlebar.browserPreview", "Browser preview")}</span> : null}
      </div>
      {navigation}
      <div className={styles.actions}>
        <button className={common.secondaryButton} type="button" aria-label={uiText("titlebar.newInstance", "New instance")} onClick={() => openWizard(true)}>
          <Plus size={16} weight="bold" />
          <span>{uiText("titlebar.newInstance", "New instance")}</span>
        </button>
        <details name="slh-action-menu" data-action-menu className={styles.importMenu} ref={importMenuRef}>
          <summary className={common.ghostButton} data-minimal-compact aria-label={uiText("common.import", "Import")}>
            <DownloadSimple size={16} weight="bold" />
            <span data-minimal-text>{uiText("common.import", "Import")}</span>
          </summary>
          <div className={styles.importOptions}>
            <button type="button" onClick={() => void importArchive()}>
              <strong>{t("titlebar.archive", "Archive")}</strong>
              <span>{t("titlebar.archiveDescription", "Modrinth or CurseForge pack")}</span>
            </button>
            <button type="button" onClick={() => void importFolder()}>
              <strong>{t("titlebar.existingFolder", "Existing folder")}</strong>
              <span>{t("titlebar.folderDescription", "Worlds, mods, configs, and local settings")}</span>
            </button>
          </div>
        </details>
      </div>
      <div className={styles.windowControls}>
        <button type="button" onClick={() => void windowAction("minimize")} aria-label={uiText("shell.texts.minimize", "Minimize")}>
          <Minus size={15} />
        </button>
        <button type="button" onClick={() => void windowAction("maximize")} aria-label={uiText("shell.texts.maximize", "Maximize")}>
          <Square size={12} />
        </button>
        <button className={styles.close} type="button" onClick={() => void windowAction("close")} aria-label={uiText("common.close", "Close")}>
          <X size={15} />
        </button>
      </div>
    </header>
    <ArchiveImportDialog archivePath={archivePath} onClose={() => setArchivePath(null)} onImported={onArchiveImported} />
    </>
  );
}
