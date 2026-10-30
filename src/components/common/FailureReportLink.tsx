import { useState } from "react";
import { useUiText } from "../../i18n/UiText";
import { command } from "../../lib/tauri";
import styles from "./ErrorText.module.css";

export function FailureReportLink({ path }: { path: string }) {
  const t = useUiText();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const open = async () => {
    setBusy(true);
    setFailed(false);
    try { await command("open_crash_report", { path }); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };
  return <span className={styles.error}>
    <button className={styles.disclosure} type="button" disabled={busy} onClick={() => void open()}>{t("errors.openReport", "Open error report")}</button>
    <code className={styles.diagnostic}>{path}</code>
    {failed ? <span role="alert">{t("errors.reportOpenFailed", "Could not open the report. Open the file at the path above.")}</span> : null}
  </span>;
}
