import { useUiText } from "../../i18n/UiText";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { CommandFailure, ManualDownloadFile } from "../../lib/types";
import { ActionGroup, StatusPanel } from "./Controls";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { command } from "../../lib/tauri";
import { useI18n } from "../../i18n/I18nProvider";
import common from "./Common.module.css";
import styles from "./PackInstallError.module.css";

const observedDownloads = new Map<string, string>();

function missingFiles(message: string) {
  return [...message.matchAll(/\[[^\]]*\]\((https:\/\/www\.curseforge\.com\/[^\s)]+)\) — `([^`]+)`/g)]
    .map((match) => ({ url: approvedLink(match[1])?.replace(/\/files\/(\d+)$/, "/download/$1") ?? null, name: match[2] })).filter((file) => file.url);
}

function approvedLink(href: string | undefined): string | null {
  try {
    const url = new URL(href ?? "");
    return url.protocol === "https:" && url.hostname === "www.curseforge.com" ? url.href : null;
  } catch { return null; }
}

export function useCurseForgeDownloads(message: string, busy: boolean, onRetry: () => Promise<void>, structuredFiles?: ManualDownloadFile[]) {
  const files = structuredFiles ? structuredFiles.map((file) => ({ name: file.fileName, url: approvedLink(file.url) })) : missingFiles(message);
  const retryRef = useRef(onRetry);
  retryRef.current = onRetry;
  const fileKey = JSON.stringify(files.map((file) => file.name).sort());
  useEffect(() => {
    if (busy || fileKey === "[]") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const scan = async () => {
      try {
        const signatures = await command<string[]>("scan_curseforge_downloads", { fileNames: JSON.parse(fileKey) });
        if (!active || !Array.isArray(signatures)) return;
        const signature = JSON.stringify(signatures);
        const previous = observedDownloads.get(fileKey);
        if (observedDownloads.size > 128) observedDownloads.clear();
        observedDownloads.set(fileKey, signature);
        const complete = (JSON.parse(fileKey) as string[]).every((name) => signatures.some((entry) => entry.startsWith(`${name}\0`)));
        if (complete && previous !== signature) await retryRef.current();
      } catch { /* A browser can temporarily lock a download; check again on the next scan. */ }
      finally { if (active) timer = setTimeout(() => void scan(), 3000); }
    };
    void scan();
    return () => { active = false; clearTimeout(timer); };
  }, [busy, fileKey, message]);
}

export function PackInstallError({ message, busy, onRetry, onError, showRetry = false, failure, monitor = true }: {
  message: string; busy: boolean; onRetry: () => Promise<void>; onError: (message: string, failure?: CommandFailure) => void; showRetry?: boolean; failure?: CommandFailure; monitor?: boolean;
}) {
  const uiText = useUiText();
  const { t } = useI18n();
  const [choosing, setChoosing] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const files = failure?.details?.files ? failure.details.files.map((file) => ({ name: file.fileName, displayName: file.name, url: approvedLink(file.url)?.replace(/\/files\/(\d+)$/, "/download/$1") })) : missingFiles(message).map((file) => ({ ...file, displayName: file.name }));
  const manual = failure?.code === "manual_downloads_required" || message.includes("curseforge-manual");
  useCurseForgeDownloads(message, busy || choosing || !monitor, onRetry, failure?.details?.files);
  const openDownloads = async () => {
    setOpening(true);
    setOpenError(null);
    try {
      for (const url of new Set(files.map((file) => file.url!))) await openUrl(url);
    } catch (reason) { setOpenError(String((reason as { message?: string }).message ?? reason)); }
    finally { setOpening(false); }
  };
  const rateLimit = message.match(/CurseForge is temporarily rate limited \(HTTP 429\). Retry in (\d+) seconds\./);
  const translated = rateLimit
    ? uiText("common.texts.curseforgeHasTemporarilyLimitedRequestsPleaseRetryInSeconds", "CurseForge has temporarily limited requests. Please retry in {seconds} seconds.", { seconds: rateLimit[1] })
    : failure?.messageKey ? t(failure.messageKey, uiText("common.texts.installationFailedTryAgainOrCheckTheDetails", "Installation failed. Try again or check the details."), failure.params)
    : uiText("common.texts.installationFailedTryAgainOrCheckTheDetails", "Installation failed. Try again or check the details.");
  const addFiles = async () => {
    setChoosing(true);
    try {
      const selected = await open({ multiple: true, filters: [{ name: "CurseForge", extensions: ["jar", "zip"] }] });
      if (!selected || (Array.isArray(selected) && selected.length === 0)) return;
      await command("add_curseforge_manual_files", { paths: Array.isArray(selected) ? selected : [selected] });
      await onRetry();
    } catch (reason) {
      onError(String((reason as { message?: string }).message ?? reason), reason as CommandFailure);
    } finally { setChoosing(false); }
  };
  return <StatusPanel tone={manual ? "warning" : "error"} title={manual ? uiText("common.texts.filesNeeded", "Files needed") : uiText("common.texts.installationFailed", "Installation failed")}>
    {manual ? <>
      <p>{uiText("common.texts.someAuthorsOnlyAllowDownloadsFromCurseforgeDownloadThe", "Some authors only allow downloads from CurseForge. Download the listed files; SLH verifies them before continuing.")}</p>
      {files.length ? <ul className={styles.files}>{files.map((file) => <li key={file.name}><a href={file.url ?? undefined} onClick={(event) => { event.preventDefault(); if (file.url) void openUrl(file.url).catch((error) => setOpenError(String(error))); }}>{file.displayName}</a><code>{file.name}</code></li>)}</ul> : <div className={styles.message}><ReactMarkdown components={{ a: ({ href, children }) => <a href={approvedLink(href) ?? undefined} onClick={(event) => { event.preventDefault(); const url = approvedLink(href); if (url) void openUrl(url.replace(/\/files\/(\d+)$/, "/download/$1")); }}>{children}</a> }}>{message}</ReactMarkdown></div>}
      <p>{uiText("installation.curseforgeSaveFilesHint", "Save files to the CurseForge downloads folder selected in Settings → Downloads. SLH checks it automatically.")}</p>
      <ActionGroup>
        {files.length ? <button type="button" className={common.button} disabled={busy || opening} onClick={() => void openDownloads()}>{uiText("common.texts.openDownloadPages", "Open download pages")}</button> : null}
        <button type="button" className={common.secondaryButton} disabled={busy || choosing} onClick={() => void addFiles()}>{uiText("common.texts.chooseDownloadedFiles", "Choose downloaded files")}</button>
        {showRetry ? <button type="button" className={common.secondaryButton} disabled={busy || choosing} onClick={() => void onRetry()}>{uiText("common.retry", "Retry")}</button> : null}
      </ActionGroup>
      {failure?.details?.directory ? <details><summary>{uiText("common.texts.manualDownloadsFolder", "Manual downloads folder")}</summary><code>{failure.details.directory}</code></details> : null}
    </> : <>
      <p>{translated}</p>
      <details><summary>{uiText("common.texts.technicalDetails", "Technical details")}</summary><pre className={styles.message}>{message}</pre></details>
      {showRetry ? <button type="button" className={common.secondaryButton} disabled={busy || choosing} onClick={() => void onRetry()}>{uiText("common.retry", "Retry")}</button> : null}
    </>}
    {openError ? <p role="alert">{uiText("common.texts.couldNotOpenDownloadPagesTryOpeningTheFile", "Could not open download pages. Try opening the file links individually.")}<br /><code>{openError}</code></p> : null}
  </StatusPanel>;
}
