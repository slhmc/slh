import { useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Dialog } from "./Dialog";
import { useI18n } from "../../i18n/I18nProvider";
import { useAppStore } from "../../stores/appStore";
import type { LauncherUpdateInfo } from "../../lib/types";
import common from "./Common.module.css";

export const requestLauncherUpdate = (release: LauncherUpdateInfo) =>
  window.dispatchEvent(new CustomEvent("slh-launcher-update", { detail: release }));

export function LauncherUpdateDialog() {
  const { t } = useI18n();
  const [release, setRelease] = useState<LauncherUpdateInfo | null>(null);
  const [phase, setPhase] = useState<"ready" | "download" | "installed">("ready");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const active = useAppStore(state => state.activities.length > 0 || state.bootstrap?.instances.some(instance => instance.status === "running"));
  useEffect(() => {
    const open = (event: Event) => {
      if (busy.current) return;
      setRelease((event as CustomEvent<LauncherUpdateInfo>).detail);
      setPhase("ready"); setError(""); setProgress(null);
    };
    window.addEventListener("slh-launcher-update", open);
    return () => window.removeEventListener("slh-launcher-update", open);
  }, []);
  const install = async () => {
    if (busy.current || active) return;
    busy.current = true; setPhase("download"); setError("");
    let update: Update | null = null;
    try {
      update = await check({ timeout: 30000 });
      if (!update) throw new Error(t("updater.unavailable"));
      let downloaded = 0; let total = 0;
      await update.downloadAndInstall(event => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") downloaded += event.data.chunkLength;
        setProgress(total ? Math.min(100, Math.round(downloaded * 100 / total)) : null);
      });
      setPhase("installed");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause)); setPhase("ready");
    } finally { busy.current = false; await update?.close().catch(() => undefined); }
  };
  return <Dialog open={release !== null} title={t("updater.title")} onClose={() => { if (!busy.current) setRelease(null); }}
    footer={<>
      {phase !== "installed" ? <button type="button" className={common.secondaryButton} disabled={phase === "download"} onClick={() => setRelease(null)}>{t("updater.later")}</button> : null}
      <button type="button" className={common.button} disabled={phase === "download" || !!active} onClick={() => { if (phase === "installed") void relaunch().catch(cause => setError(String(cause))); else void install(); }}>{t(phase === "installed" ? "updater.restart" : "updater.install")}</button>
    </>}>
    <p>{t("updater.offer").replace("{version}", release?.latestVersion ?? "")}</p>
    <p>{t("updater.preserve")}</p>
    {active ? <p role="status">{t("updater.active")}</p> : null}
    {phase === "download" ? <div role="status"><p>{t("updater.downloading")}</p><progress aria-label={t("updater.downloading")} max={100} value={progress ?? undefined} />{progress !== null ? <span> {progress}%</span> : null}</div> : null}
    {phase === "installed" ? <p role="status">{t("updater.installed")}</p> : null}
    {error ? <div role="alert"><p>{t("updater.failed")}</p><details><summary>{t("updater.details")}</summary><pre>{error}</pre></details></div> : null}
  </Dialog>;
}
