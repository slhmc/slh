import { useEffect, useState } from "react";
import type { LocalServer } from "../../lib/localServers";
import { command } from "../../lib/tauri";
import { useUiText } from "../../i18n/UiText";
import { SettingGrid, SettingRow } from "../settings/SettingControls";
import { Button } from "../common/Controls";
import { ErrorText } from "../common/ErrorText";
import common from "../common/Common.module.css";
import styles from "./Servers.module.css";

export function ServerMemoryEditor({ server, onSaved }: { server: LocalServer; onSaved?: (server: LocalServer) => void }) {
  const t = useUiText();
  const [minimum, setMinimum] = useState(String(server.config.memoryMinMb));
  const [maximum, setMaximum] = useState(String(server.config.memoryMaxMb));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!dirty) { setMinimum(String(server.config.memoryMinMb)); setMaximum(String(server.config.memoryMaxMb)); }
  }, [server.config.memoryMinMb, server.config.memoryMaxMb, dirty]);
  const valid = minimum !== "" && maximum !== "" && Number.isInteger(Number(minimum)) && Number.isInteger(Number(maximum))
    && Number(minimum) >= 128 && Number(maximum) >= Number(minimum) && Number(maximum) <= 1_048_576;
  const save = async () => {
    if (!valid || busy) return;
    setBusy(true); setError(""); setSaved(false);
    try {
      const next = await command<LocalServer>("update_local_server_memory", { serverId: server.id, minimum: Number(minimum), maximum: Number(maximum) });
      onSaved?.(next); setDirty(false); setSaved(true);
    } catch (reason) { setError(String((reason as Error).message ?? reason)); }
    finally { setBusy(false); }
  };
  return <div className={styles.memoryEditor}>
    <p className={styles.note}>{t("serverLive.memoryHint")}</p>
    <SettingGrid fitContent>{(["min", "max"] as const).map(key => <SettingRow key={key} title={t(key === "min" ? "localServers.memoryMin" : "localServers.memoryMax")}>
      <input className={common.input} type="number" min={128} max={1048576} step={1} value={key === "min" ? minimum : maximum} disabled={busy} onChange={event => {
        (key === "min" ? setMinimum : setMaximum)(event.target.value); setDirty(true); setSaved(false);
      }} />
    </SettingRow>)}</SettingGrid>
    <div className={styles.memoryActions}>
      {dirty && !valid ? <p role="alert" className={styles.error}>{t("serverLive.memoryInvalid")}</p> : null}
      {error ? <p role="alert"><ErrorText message={error} /></p> : null}
      {saved ? <p role="status" className={styles.note}>{t("serverLive.memorySaved")}</p> : null}
      <Button disabled={!dirty || !valid} busy={busy} onClick={() => void save()}>{t("serverLive.saveMemory")}</Button>
    </div>
  </div>;
}
