import { useUiText } from "../../i18n/UiText";
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
  const uiText = useUiText();
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
        if (active) pushToast({ tone: "error", title: uiText("servers.texts.serverListCouldNotBeRead", "Server list could not be read"), message: String((error as { message?: string }).message ?? error) });
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
      pushToast({ tone: "success", title: uiText("servers.texts.serverAdded", "Server added"), message: uiText("servers.texts.serversDatWasUpdatedAtomicallyExistingDataWasBacked", "servers.dat was updated atomically. Existing data was backed up.") });
    } catch (error) {
      pushToast({ tone: "error", title: uiText("servers.texts.serverWasNotAdded", "Server was not added"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setSaving(false);
    }
  };

  const removeServer = async (server: ServerEntry) => {
    if (!window.confirm(`${uiText("servers.texts.remove", "Remove")} ${server.name} ${uiText("servers.texts.fromThisInstanceTheCurrentServersDatWillBe", "from this instance? The current servers.dat will be backed up.")}`)) return;
    try {
      setServers(await command<ServerEntry[]>("remove_server", { instanceId, index: server.index }));
    } catch (error) {
      pushToast({ tone: "error", title: uiText("servers.texts.serverWasNotRemoved", "Server was not removed"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  return (
    <div className={page.page}>
      <header className={page.header}>
        <div><h1>{uiText("navigation.servers", "Servers")}</h1><p>{uiText("servers.texts.editEachInstanceAposSRealServersDatWrites", "Edit each instance&apos;s real `servers.dat`. Writes are NBT-safe, blocked while the game runs, and backed up before replacement.")}</p></div>
        {bootstrap.instances.length > 0 ? (
          <select className={common.select} value={instanceId} onChange={(event) => setInstanceId(event.target.value)} aria-label={uiText("servers.texts.minecraftInstance", "Minecraft instance")}>
            {bootstrap.instances.map((instance) => <option value={instance.id} key={instance.id}>{instance.name} · {instance.minecraftVersion}</option>)}
          </select>
        ) : null}
      </header>

      {bootstrap.instances.length === 0 ? (
        <div className={page.emptyState}><div><GlobeHemisphereWest size={40} weight="duotone" /><h2>{uiText("library.emptyTitle", "No instances yet")}</h2><p>{uiText("servers.texts.createOrImportAnInstanceBeforeManagingItsMultiplayer", "Create or import an instance before managing its multiplayer server list.")}</p></div></div>
      ) : (
        <div className={styles.layout}>
          <section className={styles.listPanel}>
            <header><span><strong>{uiText("servers.texts.savedServers", "Saved servers")}</strong><small>{loading ? uiText("servers.texts.readingNbt", "Reading NBT…") : `${servers.length} ${uiText("servers.texts.entries", "entries")}`}</small></span></header>
            {servers.length === 0 && !loading ? <div className={styles.empty}><ServerIcon size={30} /><p>{uiText("servers.texts.thisInstanceHasNoSavedServers", "This instance has no saved servers.")}</p></div> : servers.map((server) => (
              <div className={styles.serverRow} key={`${server.index}-${server.name}-${server.address}`}>
                <span className={styles.serverIcon}>{server.name.slice(0, 1).toUpperCase()}</span>
                <span><strong>{server.name}</strong><small>{server.address}</small></span>
                {server.acceptTextures !== null ? <span className={common.badge}>{uiText("servers.texts.textures", "Textures")} {server.acceptTextures ? uiText("instance.texts.on", "on") : uiText("instance.texts.off", "off")}</span> : null}
                <button className={common.iconButton} type="button" aria-label={`${uiText("servers.texts.remove", "Remove")} ${server.name}`} onClick={() => void removeServer(server)}><Trash size={16} /></button>
              </div>
            ))}
          </section>
          <aside className={styles.addPanel}>
            <div><Plus size={22} /><span><strong>{uiText("servers.texts.addServer", "Add server")}</strong><small>{uiText("servers.texts.savedOnlyToTheSelectedInstance", "Saved only to the selected instance")}</small></span></div>
            <label><span>{uiText("library.name", "Name")}</span><input className={common.input} value={name} maxLength={128} onChange={(event) => setName(event.target.value)} placeholder={uiText("servers.texts.communityServer", "Community server")} /></label>
            <label><span>{uiText("servers.texts.address", "Address")}</span><input className={common.input} value={address} maxLength={255} onChange={(event) => setAddress(event.target.value)} placeholder={uiText("servers.texts.playExampleNet25565", "play.example.net:25565")} /></label>
            <button className={common.button} type="button" disabled={saving || !name.trim() || !address.trim()} onClick={() => void addServer()}>{saving ? uiText("servers.texts.saving", "Saving…") : uiText("servers.texts.addToServersDat", "Add to servers.dat")}</button>
            <p>{uiText("servers.texts.crossInstanceCopyingRemainsOffUntilYouExplicitlyCreate", "Cross-instance copying remains off until you explicitly create a Servers mapping in Settings → Sync.")}</p>
          </aside>
        </div>
      )}
    </div>
  );
}
