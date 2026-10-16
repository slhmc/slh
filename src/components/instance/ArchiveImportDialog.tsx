import { useUiText } from "../../i18n/UiText";
import { useCallback, useEffect, useRef, useState } from "react";
import { command } from "../../lib/tauri";
import { runPackInstall, cancelPackInstall, isPackCancellation, usePackJobs } from "../../stores/packJobs";
import type { ArchiveInspection, Instance, CommandFailure } from "../../lib/types";
import { useI18n } from "../../i18n/I18nProvider";
import { Dialog } from "../common/Dialog";
import { PackInstallError } from "../common/PackInstallError";
import { SpinnerGap } from "../icons";
import common from "../common/Common.module.css";
import styles from "./ArchiveImportDialog.module.css";

export function ArchiveImportDialog({ archivePath, onClose, onImported }: {
  archivePath: string | null; onClose: () => void; onImported: (instance: Instance, archivePath: string) => Promise<void>;
}) {
  const uiText = useUiText();
  const { tr } = useI18n();
  const [inspection, setInspection] = useState<ArchiveInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<CommandFailure | undefined>();
  const [busy, setBusy] = useState(false);
  const packJob = usePackJobs((state) => state.jobs.find((job) => job.key === `archive:${archivePath}`));
  const activePath = useRef(archivePath);
  activePath.current = archivePath;
  const runningPath = useRef<string | null>(null);
  const runImport = useCallback(async () => {
    if (!archivePath || activePath.current !== archivePath || runningPath.current === archivePath) return;
    runningPath.current = archivePath;
    setBusy(true);
    setError(null);
    setFailure(undefined);
    try {
      const value = await command<ArchiveInspection>("inspect_archive", { archivePath });
      if (activePath.current === archivePath) setInspection(value);
      if (!value.canImport) throw new Error(value.message);
      const name = value.archiveType === "modrinth" ? "import_modrinth_pack" : value.archiveType === "curseforge" ? "import_curseforge_pack" : "import_slh_archive";
      await runPackInstall({
        key: `archive:${archivePath}`, name: value.name ?? "Minecraft pack",
        minecraftVersion: value.minecraftVersion ?? "", loaderType: (value.loaderType ?? "vanilla") as Instance["loaderType"],
        commandName: name, args: { request: { archivePath, name: null } },
        onSuccess: (instance) => onImported(instance, archivePath),
      });
    } catch (reason) {
      if (activePath.current === archivePath) { setFailure(reason as CommandFailure); setError(isPackCancellation(reason) ? null : String((reason as { message?: string }).message ?? reason)); }
    } finally {
      if (runningPath.current === archivePath) runningPath.current = null;
      if (activePath.current === archivePath) setBusy(false);
    }
  }, [archivePath, onImported]);
  useEffect(() => {
    setInspection(null);
    if (archivePath) void runImport();

  }, [archivePath, runImport]);
  return <Dialog open={Boolean(archivePath)} title={uiText("installation.texts.importArchive", "Import archive")} onClose={onClose} footer={<>
        <button type="button" className={common.secondaryButton} onClick={onClose}>{uiText("common.close", "Close")}</button>
        {packJob && (packJob.phase === "running" || packJob.phase === "cancelling") && inspection?.archiveType !== "slh" ? <button type="button" className={common.secondaryButton} disabled={packJob.phase === "cancelling"} onClick={() => void cancelPackInstall(packJob.key).catch((reason) => setError(String(reason)))}>{tr(packJob.phase === "cancelling" ? uiText("installation.texts.cancellingInstallation", "Cancelling installation") : uiText("installation.texts.cancelDownload", "Cancel download"))}</button> : null}
        {packJob?.phase === "cancelled" ? <button type="button" className={common.button} disabled={busy} onClick={() => void runImport()}>{uiText("installation.texts.retryImport", "Retry import")}</button> : null}
        {error ? <button type="button" className={common.button} disabled={busy} onClick={() => void runImport()}>{uiText("installation.texts.retryImport", "Retry import")}</button> : null}
      </>}>
    <div className={styles.body}>
      {inspection ? <div><strong>{inspection.name}</strong><p>{uiText("settings.minecraft", "Minecraft")}{" "}{inspection.minecraftVersion} · {inspection.loaderType} {inspection.loaderVersion}</p></div> : null}
      {busy ? <div className={styles.progress}><SpinnerGap size={22} className={styles.spin} /><span>{uiText("installation.texts.downloadingMissingFilesAndInstallingTheModpack", "Downloading missing files and installing the modpack.")}</span></div> : null}
      {packJob?.phase === "cancelled" ? <p role="status">{uiText("installation.texts.installationCancelled", "Installation cancelled")}</p> : null}
      {archivePath && error ? <PackInstallError failure={failure} message={error} busy={busy} onRetry={runImport} onError={(message, value) => { setError(message); setFailure(value); }} /> : null}

    </div>
  </Dialog>;
}
