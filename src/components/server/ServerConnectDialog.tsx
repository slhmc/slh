import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { command } from "../../lib/tauri";
import type { DiscoveredServer, LocalServer } from "../../lib/localServers";
import { useUiText } from "../../i18n/UiText";
import { Dialog } from "../common/Dialog";
import { Button } from "../common/Controls";
import { ErrorText } from "../common/ErrorText";
import common from "../common/Common.module.css";
import styles from "./Servers.module.css";

export function ServerConnectDialog({candidate,onClose,onConnected}:{candidate:DiscoveredServer;onClose:()=>void;onConnected:(server:LocalServer)=>void}) {
  const t=useUiText(); const [config,setConfig]=useState(candidate.config);const [busy,setBusy]=useState(false);const [error,setError]=useState("");
  const connect=async()=>{setBusy(true);setError("");try{onConnected(await command<LocalServer>("connect_local_server",{path:candidate.path,config}));}catch(reason){setError(String((reason as Error).message??reason));}finally{setBusy(false);}};
  return <Dialog open title={t("serverWorkspace.connect")} description={t("serverWorkspace.connectHint")} onClose={()=>{if(!busy)onClose();}} footer={<><Button disabled={busy} onClick={onClose}>{t("common.close")}</Button><Button variant="primary" busy={busy} disabled={!config.minecraftVersion||(!candidate.entry.length&&!config.customJar)} onClick={()=>void connect()}>{t("serverWorkspace.connect")}</Button></>}>
    <div className={styles.config}><strong><bdi>{candidate.name}</bdi></strong><p className={styles.note}><bdi>{candidate.path}</bdi></p><label className={styles.field}><span>{t("localServers.minecraftVersion")}</span><input className={common.input} value={config.minecraftVersion} placeholder="1.21.4" onChange={e=>setConfig({...config,minecraftVersion:e.target.value})}/></label>
    {!candidate.entry.length?<div className={styles.path}><code>{config.customJar??t("localServers.chooseJar")}</code><Button onClick={()=>void open({multiple:false,filters:[{name:"JAR",extensions:["jar"]}]}).then(path=>{if(typeof path==="string")setConfig({...config,customJar:path});})}>{t("localServers.chooseJar")}</Button></div>:<pre className={styles.command}>{candidate.entry.join(" ")}</pre>}
    <p className={styles.note}>{t("serverWorkspace.importSettings")}</p>{error?<p role="alert" className={styles.error}><ErrorText message={error}/></p>:null}</div>
  </Dialog>;
}
