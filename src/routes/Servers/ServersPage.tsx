import { GlobeHemisphereWest, HardDrives as ServerIcon, Plus, Trash } from "../../components/icons";
import { useEffect, useState } from "react";
import common from "../../components/common/Common.module.css";
import { command } from "../../lib/tauri";
import type { ServerEntry } from "../../lib/types";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n/I18nProvider";
import page from "../shared/Page.module.css";
import styles from "./ServersPage.module.css";

export function ServersPage() {
  const bootstrap = useAppStore((state) => state.bootstrap);
  const pushToast = useAppStore((state) => state.pushToast);
  const { tr } = useI18n();
  const [instanceId, setInstanceId] = useState("");
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!bootstrap || instanceId) return;
    setInstanceId(bootstrap.instances[0]?.id ?? "");
  }, [bootstrap, instanceId]);

  useEffect(() => {
    if (!instanceId) {
      setServers([]);
      return;
    }
    let active = true;
    setLoading(true);
    command<ServerEntry[]>("list_servers", { instanceId })
      .then((items) => { if (active) setServers(items); })
      .catch((error) => {
        if (active) pushToast({ tone: "error", title: tr("Server list could not be read"), message: String((error as { message?: string }).message ?? error) });
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [instanceId, pushToast, tr]);

  if (!bootstrap) return null;

  const addServer = async () => {
    if (!instanceId || !name.trim() || !address.trim()) return;
    setSaving(true);
    try {
      const updated = await command<ServerEntry[]>("add_server", {
        request: { instanceId, name: name.trim(), address: address.trim() },
      });
      setServers(updated);
      setName("");
      setAddress("");
      pushToast({ tone: "success", title: tr("Server added"), message: tr("servers.dat was updated atomically. Existing data was backed up.") });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Server was not added"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setSaving(false);
    }
  };

  const removeServer = async (server: ServerEntry) => {
    if (!window.confirm(`${tr("Remove")} ${server.name} ${tr("from this instance? The current servers.dat will be backed up.")}`)) return;
    try {
      setServers(await command<ServerEntry[]>("remove_server", { instanceId, index: server.index }));
    } catch (error) {
      pushToast({ tone: "error", title: tr("Server was not removed"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  return (
    <div className={page.page}>
      <header className={page.header}>
        <div><h1>{tr("Servers")}</h1><p>{tr("Edit each instance&apos;s real `servers.dat`. Writes are NBT-safe, blocked while the game runs, and backed up before replacement.")}</p></div>
        {bootstrap.instances.length > 0 ? (
          <select className={common.select} value={instanceId} onChange={(event) => setInstanceId(event.target.value)} aria-label={tr("Minecraft instance")}>
            {bootstrap.instances.map((instance) => <option value={instance.id} key={instance.id}>{instance.name} · {instance.minecraftVersion}</option>)}
          </select>
        ) : null}
      </header>

      {bootstrap.instances.length === 0 ? (
        <div className={page.emptyState}><div><GlobeHemisphereWest size={40} weight="duotone" /><h2>{tr("No instances yet")}</h2><p>{tr("Create or import an instance before managing its multiplayer server list.")}</p></div></div>
      ) : (
        <div className={styles.layout}>
          <section className={styles.listPanel}>
            <header><span><strong>{tr("Saved servers")}</strong><small>{loading ? tr("Reading NBT…") : `${servers.length} ${tr("entries")}`}</small></span></header>
            {servers.length === 0 && !loading ? <div className={styles.empty}><ServerIcon size={30} /><p>{tr("This instance has no saved servers.")}</p></div> : servers.map((server) => (
              <div className={styles.serverRow} key={`${server.index}-${server.name}-${server.address}`}>
                <span className={styles.serverIcon}>{server.name.slice(0, 1).toUpperCase()}</span>
                <span><strong>{server.name}</strong><small>{server.address}</small></span>
                {server.acceptTextures !== null ? <span className={common.badge}>{tr("Textures")} {server.acceptTextures ? tr("on") : tr("off")}</span> : null}
                <button className={common.iconButton} type="button" aria-label={`${tr("Remove")} ${server.name}`} onClick={() => void removeServer(server)}><Trash size={16} /></button>
              </div>
            ))}
          </section>
          <aside className={styles.addPanel}>
            <div><Plus size={22} /><span><strong>{tr("Add server")}</strong><small>{tr("Saved only to the selected instance")}</small></span></div>
            <label><span>{tr("Name")}</span><input className={common.input} value={name} maxLength={128} onChange={(event) => setName(event.target.value)} placeholder={tr("Community server")} /></label>
            <label><span>{tr("Address")}</span><input className={common.input} value={address} maxLength={255} onChange={(event) => setAddress(event.target.value)} placeholder="play.example.net:25565" /></label>
            <button className={common.button} type="button" disabled={saving || !name.trim() || !address.trim()} onClick={() => void addServer()}>{saving ? tr("Saving…") : tr("Add to servers.dat")}</button>
            <p>{tr("Cross-instance copying remains off until you explicitly create a Servers mapping in Settings → Sync.")}</p>
          </aside>
        </div>
      )}
    </div>
  );
}
