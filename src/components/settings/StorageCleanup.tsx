import { ErrorText } from "../common/ErrorText";
import { markStorageChanged } from "../../lib/storageUsage";
import { useState } from "react";
import { useUiText } from "../../i18n/UiText";
import { command } from "../../lib/tauri";
import { formatBytes } from "../../lib/formatters";
import type { CleanupEntry, CleanupResult, CleanupScan } from "../../lib/localServers";
import { Dialog } from "../common/Dialog";
import { Button, Progress } from "../common/Controls";
import styles from "../server/Servers.module.css";

const categories = ["metadata", "previews", "archives", "browserArchives", "temporary", "logs", "versions", "libraries", "derived"];
export function StorageCleanup() {
  const t = useUiText();
  const [scan, setScan] = useState<CleanupScan | null>(null); const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [result, setResult] = useState<CleanupResult | null>(null); const [confirm, setConfirm] = useState<"cleanup" | "database" | null>(null);
  const analyze = async () => {
    setBusy(true); setError(""); setResult(null); setSelected(new Set());
    try {
      const data = await command<CleanupScan>("scan_storage_cleanup");
      const { portraitCacheInfo } = await import("../../lib/homePortrait"); const preview = await portraitCacheInfo();
      if (!data.busy && preview.size) data.entries.push({ id: "home-portrait", kind: "preview", category: "previews", path: t("storageCleanup.previewCache"), size: preview.size, fingerprint: preview.key });
      setScan(data);
    } catch (reason) { setError(String((reason as Error).message ?? reason)); }
    finally { setBusy(false); }
  };
  const checked = scan?.entries.filter(e => selected.has(e.id)) ?? [];
  const bytes = checked.reduce((total, e) => total + e.size, 0);
  const toggle = (entries: CleanupEntry[], value: boolean) => setSelected(previous => { const next = new Set(previous); for (const entry of entries) if (value) next.add(entry.id); else next.delete(entry.id); return next; });
  const execute = async () => {
    const mode = confirm; setConfirm(null); setBusy(true); setError("");
    try {
      const value = mode === "database" ? await command<CleanupResult>("optimize_storage_database") : await command<CleanupResult>("execute_storage_cleanup", { scanId: scan?.id, entryIds: checked.filter(e => e.kind !== "preview").map(e => e.id) });
      const preview = checked.find(e => e.kind === "preview");
      if (mode === "cleanup" && preview) {
        const { portraitCacheInfo, clearHomePortraitCache } = await import("../../lib/homePortrait"); const now = await portraitCacheInfo();
        if (now.key === preview.fingerprint) { await clearHomePortraitCache(); value.removedFiles++; value.removedBytes += now.size; } else value.skipped++;
      }
      setResult(value); setSelected(new Set()); setScan(null); markStorageChanged();
    } catch (reason) { setError(String((reason as Error).message ?? reason)); }
    finally { setBusy(false); }
  };
  return <section className={styles.cleanup}>
    <h3>{t("storageCleanup.title")}</h3><p className={styles.note}>{t("storageCleanup.hint")}</p>
    <div className={styles.actions}><Button busy={busy} onClick={() => void analyze()}>{t("storageCleanup.scan")}</Button><Button disabled={busy || scan?.busy} onClick={() => setConfirm("database")}>{t("storageCleanup.optimize")}</Button></div>
    {busy ? <Progress label={t("storageCleanup.working")} /> : null}
    {scan?.busy ? <p className={styles.note} role="status">{t("storageCleanup.busy")}</p> : null}
    {scan && !scan.busy ? categories.map(category => {
      const entries = scan.entries.filter(e => e.category === category); const size = entries.reduce((sum, e) => sum + e.size, 0);
      return <div className={styles.cleanupCategory} key={category}><label><input type="checkbox" disabled={busy || !entries.length} checked={Boolean(entries.length && entries.every(e => selected.has(e.id)))} ref={element => { if (element) element.indeterminate = entries.some(e => selected.has(e.id)) && !entries.every(e => selected.has(e.id)); }} onChange={e => toggle(entries, e.target.checked)} /><span><strong>{t(`storageCleanup.categories.${category}`)}</strong><small>{t(`storageCleanup.hints.${category}`)}</small></span><small className={styles.stat}>{entries.length} · {formatBytes(size)}</small></label>{entries.length ? <details><summary>{t("storageCleanup.showFiles")}</summary><div className={styles.cleanupFiles}>{entries.map(entry => <label className={styles.cleanupFile} key={entry.id}><input type="checkbox" checked={selected.has(entry.id)} disabled={busy} onChange={e => toggle([entry], e.target.checked)} /><span>{entry.path}</span><b>{formatBytes(entry.size)}</b></label>)}</div></details> : null}</div>;
    }) : null}
    {scan && !scan.busy ? <div className={styles.actions}><span className={styles.stat}>{t("storageCleanup.selected", undefined, { count: checked.length, size: formatBytes(bytes) })}</span><Button variant="danger" disabled={!checked.length || busy} onClick={() => setConfirm("cleanup")}>{t("storageCleanup.remove")}</Button></div> : null}
    {result ? <div role="status"><p className={styles.note}>{t("storageCleanup.result", undefined, { count: result.removedFiles, size: formatBytes(result.removedBytes), skipped: result.skipped })}</p>{result.errors.slice(0, 20).map((message, i) => <p className={styles.error} key={i}>{message}</p>)}</div> : null}
    {error ? <p className={styles.error} role="alert"><ErrorText message={error} /></p> : null}
    {confirm ? <Dialog open title={t(confirm === "database" ? "storageCleanup.optimize" : "storageCleanup.confirmTitle")} description={t(confirm === "database" ? "storageCleanup.optimizeHint" : "storageCleanup.confirmHint")} onClose={() => setConfirm(null)} footer={<><Button onClick={() => setConfirm(null)}>{t("common.close")}</Button><Button variant={confirm === "database" ? "primary" : "danger"} onClick={() => void execute()}>{t(confirm === "database" ? "storageCleanup.optimize" : "storageCleanup.remove")}</Button></>}>
      {confirm === "cleanup" ? <><p className={styles.note}>{t("storageCleanup.selected", undefined, { count: checked.length, size: formatBytes(bytes) })}</p><div className={styles.cleanupFiles}>{checked.map(entry => <div className={styles.cleanupFile} key={entry.id}><span>{t(`storageCleanup.categories.${entry.category}`)} · {entry.path}</span><b>{formatBytes(entry.size)}</b></div>)}</div></> : null}
    </Dialog> : null}
  </section>;
}
