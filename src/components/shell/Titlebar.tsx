import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  DownloadSimple,
  MagnifyingGlass,
  Minus,
  Plus,
  Square,
  X,
} from "../icons";
import { command, isTauri } from "../../lib/tauri";
import type { ArchiveInspection, Instance } from "../../lib/types";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n/I18nProvider";
import common from "../common/Common.module.css";
import styles from "./Titlebar.module.css";
import launcherLogo from "../../assets/brand/Smile_LauncHer_logo.png";

export function Titlebar() {
  const { t, tr } = useI18n();
  const search = useAppStore((state) => state.search);
  const setSearch = useAppStore((state) => state.setSearch);
  const openWizard = useAppStore((state) => state.setCreateWizardOpen);
  const pushToast = useAppStore((state) => state.pushToast);
  const refresh = useAppStore((state) => state.refresh);
  const selectInstance = useAppStore((state) => state.selectInstance);
  const searchRef = useRef<HTMLInputElement>(null);
  const importMenuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      // `code` is the physical key, unlike `key` which becomes "л" on a Russian layout.
      if ((event.ctrlKey || event.metaKey) && event.code === "KeyK") {
        event.preventDefault();
        event.stopPropagation();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

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
      pushToast({ tone: "info", title: tr("Desktop action"), message: tr("Archive selection is available in the desktop application.") });
      return;
    }
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Minecraft and SLH archives", extensions: ["zip", "mrpack"] }],
    });
    if (!selected) return;
    try {
      const inspection = await command<ArchiveInspection>("inspect_archive", { archivePath: selected });
      if (!inspection.canImport) {
        pushToast({
          tone: inspection.archiveType === "unknown" ? "error" : "info",
          title: tr(inspection.archiveType === "unknown" ? "Unsupported archive" : "Archive cannot be imported"),
          message: tr(inspection.message),
        });
        return;
      }
      const commandName = inspection.archiveType === "modrinth"
        ? "import_modrinth_pack"
        : inspection.archiveType === "curseforge"
          ? "import_curseforge_pack"
          : "import_slh_archive";
      const instance = await command<Instance>(commandName, { request: { archivePath: selected, name: null } });
      await refresh();
      selectInstance(instance.id);
      pushToast({ tone: "success", title: tr("Instance {name} imported", { name: instance.name }), message: "" });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Archive could not be imported"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  const importFolder = async () => {
    importMenuRef.current?.removeAttribute("open");
    if (!isTauri) {
      pushToast({ tone: "info", title: tr("Desktop action"), message: tr("Folder selection is available in the desktop application.") });
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
      pushToast({ tone: "success", title: tr("Folder {name} imported", { name: instance.name }), message: "" });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Folder could not be imported"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  return (
    <header className={styles.titlebar} data-tauri-drag-region>
      <div className={styles.title} data-tauri-drag-region>
        <img className={styles.appLogo} src={launcherLogo} alt="Smile LauncHer logo" />
        <span className={styles.appName}>Smile LauncHer</span>
        {!isTauri ? <span className={styles.preview}>{t("titlebar.browserPreview", "Browser preview")}</span> : null}
      </div>
      <div className={styles.searchWrap}>
        <MagnifyingGlass size={16} weight="bold" aria-hidden="true" />
        <input
          ref={searchRef}
          data-global-search
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={tr("Search instances")}
          aria-label={tr("Search instances")}
        />
        <kbd>Ctrl K</kbd>
      </div>
      <div className={styles.actions}>
        <button className={common.secondaryButton} type="button" onClick={() => openWizard(true)}>
          <Plus size={16} weight="bold" />
          {tr("New instance")}
        </button>
        <details name="slh-action-menu" data-action-menu className={styles.importMenu} ref={importMenuRef}>
          <summary className={common.ghostButton} data-minimal-compact aria-label={tr("Import")}>
            <DownloadSimple size={16} weight="bold" />
            <span data-minimal-text>{tr("Import")}</span>
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
        <button type="button" onClick={() => void windowAction("minimize")} aria-label="Minimize">
          <Minus size={15} />
        </button>
        <button type="button" onClick={() => void windowAction("maximize")} aria-label="Maximize">
          <Square size={12} />
        </button>
        <button className={styles.close} type="button" onClick={() => void windowAction("close")} aria-label="Close">
          <X size={15} />
        </button>
      </div>
    </header>
  );
}
