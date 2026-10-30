import { useEffect, useState } from "react";
import { useUiText } from "../../i18n/UiText";
import { command } from "../../lib/tauri";
import { formatBytes } from "../../lib/formatters";
import type { DownloadRecord } from "../../lib/types";
import { Button, BusyIndicator } from "../common/Controls";
import { Minus, Plus } from "../icons";
import common from "../common/Common.module.css";
import styles from "../server/Servers.module.css";

export function ParallelDownloadsControl({ value, onChange }: { value: number; onChange: (value: number) => Promise<unknown> }) {
  const t = useUiText(); const [draft, setDraft] = useState(String(value)); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = async (raw: string) => {
    if (busy) return;
    if (!raw.trim() || !Number.isFinite(Number(raw))) { setDraft(String(value)); return; }
    const next = Math.max(1, Math.min(32, Math.trunc(Number(raw)))); setDraft(String(next));
    if (next === value) return; setBusy(true); setError("");
    try { await onChange(next); } catch (reason) { setDraft(String(value)); setError(String((reason as Error).message ?? reason)); } finally { setBusy(false); }
  };
  return <div><div className={styles.actions}>
    <Button aria-label={t("downloadsControls.decrease")} disabled={busy || Number(draft) <= 1} onMouseDown={e => e.preventDefault()} onClick={() => void commit(String(Number(draft || value) - 1))}><Minus size={16} /></Button>
    <input className={common.input} aria-label={t("settings.texts.concurrentDownloads")} type="number" min={1} max={32} step={1} value={draft} disabled={busy} style={{ width: "6rem" }} onChange={e => setDraft(e.target.value)} onBlur={() => void commit(draft)} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />
    <Button aria-label={t("downloadsControls.increase")} disabled={busy || Number(draft) >= 32} onMouseDown={e => e.preventDefault()} onClick={() => void commit(String(Number(draft || value) + 1))}><Plus size={16} /></Button>
  </div>{error ? <p className={styles.error} role="alert">{error}</p> : null}</div>;
}

export function DownloadHistory() {
  const t = useUiText(); const [open, setOpen] = useState(false); const [history, setHistory] = useState<DownloadRecord[] | null>(null); const [error, setError] = useState("");
  useEffect(() => { if (!open || history) return; let alive = true; void command<DownloadRecord[]>("list_downloads", { limit: 50 }).then(rows => { if (alive) setHistory(rows); }).catch(reason => { if (alive) setError(String(reason.message ?? reason)); }); return () => { alive = false; }; }, [open, history]);
  return <details onToggle={e => setOpen(e.currentTarget.open)}><summary>{t("settings.texts.recentVerifiedTransfers")}</summary>{open ? <div className={styles.list}>
    {error ? <p className={styles.error} role="alert">{error}</p> : !history ? <BusyIndicator /> : !history.length ? <p className={styles.note}>{t("settings.texts.noQueuedOrCompletedContentDownloads")}</p> : history.map(row => <article className={styles.row} key={row.id}><div className={styles.rowInfo}><strong>{row.destination.split(/[\\/]/).pop()}</strong><small>{row.source} · {new Date(row.updatedAt).toLocaleString()}</small>{row.errorMessage ? <p className={styles.error}>{row.errorMessage}</p> : null}</div><span className={styles.stat}>{formatBytes(row.downloadedBytes)}{row.totalBytes ? ` / ${formatBytes(row.totalBytes)}` : ""}</span><span className={styles.status}>{t(`downloadsControls.states.${row.status}`)}</span></article>)}
  </div> : null}</details>;
}
