import { ErrorText } from "../common/ErrorText";
import { useServerLibraryStore } from "../../stores/serverLibraryStore";
import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useUiText } from "../../i18n/UiText";
import { command } from "../../lib/tauri";
import { type ServerDefaults } from "../../lib/localServers";
import { ServerConfigFields } from "./ServerConfigFields";
import { Button, Progress } from "../common/Controls";
import { SettingLayout, SettingRow } from "../settings/SettingControls";
import { Check, FolderOpen } from "../icons";
import styles from "./Servers.module.css";
import common from "../common/Common.module.css";

export function ServerDefaultsPanel() {
  const t = useUiText();
  const [defaults, setDefaults] = useState<ServerDefaults | null>(null);
  const [directory, setDirectory] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [saved, setSaved] = useState(false);
  useEffect(() => { let alive = true; void useServerLibraryStore.getState().refresh().then(data => { if (alive) { setDefaults(data.defaults); setDirectory(data.defaultDirectory); } }).catch(reason => { if (alive) setError(String(reason.message ?? reason)); }); return () => { alive = false; }; }, []);
  const chooseDirectory=async(path:string|null)=>{setBusy(true);setError("");try{const result=await useServerLibraryStore.getState().synchronize(path??directory);setDefaults(previous=>previous?{...previous,directory:result.defaults.directory}:result.defaults);setSaved(true);}catch(reason){setError(String((reason as Error).message??reason));}finally{setBusy(false);}};
  const save = async () => {
    if (!defaults) return; setBusy(true); setError("");
    try { await command("save_server_defaults", { value: defaults }); await useServerLibraryStore.getState().refresh().catch(() => undefined); setSaved(true); }
    catch (reason) { setError(String((reason as Error).message ?? reason)); }
    finally { setBusy(false); }
  };
  return <div className={styles.defaultsPanel}>
    {!defaults && !error ? <Progress label={t("common.loading")} /> : defaults ? <SettingLayout><fieldset disabled={busy} className={styles.config}>
      <SettingRow wide title={t("localServers.directory")}><div className={styles.path}><code>{defaults.directory ?? directory}</code><Button onClick={() => void openDialog({ directory: true, multiple: false }).then(path => { if (typeof path === "string") { void chooseDirectory(path); } })}><FolderOpen size={16} />{t("localServers.chooseFolder")}</Button>{defaults.directory ? <Button variant="ghost" onClick={() => { void chooseDirectory(null); }}>{t("localServers.defaultDirectory")}</Button> : null}</div></SettingRow>
      <SettingRow title={t("localServers.portAllocation")}><select className={common.select} value={defaults.portAllocation || "increment"} onChange={e => { setDefaults({...defaults,portAllocation:e.target.value as "shared" | "increment"}); setSaved(false); }}><option value="shared">{t("localServers.sharedPort")}</option><option value="increment">{t("localServers.incrementPort")}</option></select></SettingRow>
      <ServerConfigFields mode="cards" value={defaults.config} defaults onChange={config => { setDefaults({ ...defaults, config }); setSaved(false); }} />
      <div className={styles.saveBar}>{saved ? <span className={styles.note} role="status">{t("localServers.saved")}</span> : null}<Button variant="primary" busy={busy} onClick={() => void save()}><Check size={16} />{t("common.save")}</Button></div>
    </fieldset></SettingLayout> : null}
    {error ? <p className={styles.error} role="alert"><ErrorText message={error} /></p> : null}
  </div>;
}
