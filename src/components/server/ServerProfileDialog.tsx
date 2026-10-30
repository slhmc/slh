import { ErrorText } from "../common/ErrorText";
import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useUiText } from "../../i18n/UiText";
import { command } from "../../lib/tauri";
import { safeServerFolder, type LocalServer, type ServerOverview } from "../../lib/localServers";
import { Dialog } from "../common/Dialog";
import { Button, Progress } from "../common/Controls";
import { ServerConfigFields } from "./ServerConfigFields";
import common from "../common/Common.module.css";
import styles from "./Servers.module.css";

export function ServerProfileDialog({ overview, server, groupId, collectionId, onClose, onChanged }: {
  overview: ServerOverview; server?: LocalServer; groupId: string | null; collectionId?: string | null; onClose: () => void; onChanged: () => void;
}) {
  const t = useUiText();
  const [name, setName] = useState(server?.name ?? "");
  const [folder, setFolder] = useState(server?.path.split(/[\\/]/).pop() ?? "");
  const group=server?.groupId??groupId;
  const [collection,setCollection]=useState(collectionId??null);
  const [config, setConfig] = useState(() => {
    const c = structuredClone(server?.config ?? overview.defaults.config);
    if (!server) {
      c.eulaAccepted = false;
      const ports = new Set(overview.servers.map(s => Number(s.config.properties["server-port"])));
      let port = Number(c.properties["server-port"]) || 25565;
      while (ports.has(port) && port < 65535) port++;
      c.properties["server-port"] = String(port);
    }
    return c;
  });
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chosenParent=overview.groups.find(g=>g.id===group)?.path ?? overview.directory;
  const compatibleJavaPath=!(server?.path ?? `${chosenParent}/${folder}`).split(/[\\/]/).some(part=>part.endsWith("!"));
  const compatibleFolder=!["paper","purpur","leaf","spigot","bukkit"].includes(config.core) || !/[!+]/.test(server?.path ?? `${chosenParent}/${folder}`);
  const valid = compatibleJavaPath && compatibleFolder && name.trim() && (server || folder.trim()) && config.minecraftVersion && config.coreVersion && config.eulaAccepted && config.memoryMinMb >= 256 && config.memoryMaxMb >= config.memoryMinMb && (config.core !== "custom" || config.customJar);
  const save = async () => {
    if (!valid) return; setBusy(true); setError("");
    try {
      if (server) await command("update_local_server", { serverId: server.id, name, config });
      else {
        let id = createdId;
        if (!id) {
          const created = await command<LocalServer>("create_local_server", { request: { name, folder, groupId: null, config } });
          id = created.id; setCreatedId(id); await command("organize_server_library",{serverId:id,collectionId:collection,before:null}); onChanged();
        } else await command("update_local_server", { serverId: id, name, config });
        await command("install_local_server", { serverId: id });
      }
      onChanged(); onClose();
    } catch (reason) { setError(String((reason as Error).message ?? reason)); onChanged(); }
    finally { setBusy(false); }
  };
  return <Dialog open className={styles.profileDialog} title={t(server ? "localServers.editServer" : "localServers.createServer")} description={t("localServers.profileHint")} width="xlarge" onClose={() => { if (!busy) onClose(); }} footer={<><Button disabled={busy} onClick={onClose}>{t("common.close")}</Button><Button variant="primary" busy={busy} disabled={!valid} onClick={() => void save()}>{t(server ? "common.save" : createdId ? "localServers.retryInstallation" : "localServers.createServer")}</Button></>}>
    <fieldset disabled={busy} className={styles.config}>
      <div className={`${styles.grid} ${styles.identity}`}>
        <label className={styles.field}><span>{t("localServers.name")}</span><input className={common.input} value={name} maxLength={128} onChange={e => { setName(e.target.value); if (!server && !createdId && (!folder || folder === safeServerFolder(name))) setFolder(safeServerFolder(e.target.value)); }} /></label>
        {!server ? <><label className={styles.field}><span>{t("localServers.folder")}</span><input className={common.input} disabled={Boolean(createdId)} value={folder} onChange={e => setFolder(e.target.value)} /></label><label className={styles.field}><span>{t("localServers.group")}</span><select className={common.select} disabled={Boolean(createdId)} value={collection ?? ""} onChange={e => setCollection(e.target.value || null)}><option value="">{t("localServers.rootFolder")}</option>{overview.collections?.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label></> : null}
      </div>
      {!compatibleFolder ? <p className={styles.error} role="alert">{t("localServers.paperPath")}</p> : null}
      {!compatibleJavaPath ? <p className={styles.error} role="alert">{t("localServers.javaResourcePath")}</p> : null}
      <ServerConfigFields value={config} onChange={setConfig} pinned={Boolean(server?.installed)} />
      {!server ? <label className={styles.check}><input type="checkbox" checked={config.eulaAccepted} onChange={e => setConfig({ ...config, eulaAccepted: e.target.checked })} /><span>{t("localServers.acceptEula")} <Button variant="ghost" onClick={() => void openUrl("https://www.minecraft.net/eula")}>{t("localServers.readEula")}</Button></span></label> : null}
      {busy ? <Progress label={t(server ? "localServers.saving" : "localServers.installing")} /> : null}
      {error ? <p className={styles.error} role="alert"><ErrorText message={error} /></p> : null}
    </fieldset>
  </Dialog>;
}
