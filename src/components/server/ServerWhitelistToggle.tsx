import { useEffect, useRef, useState } from "react";
import { command } from "../../lib/tauri";
import type { LocalServer } from "../../lib/localServers";
import { useUiText } from "../../i18n/UiText";
import { SettingRow, Toggle } from "../settings/SettingControls";
import { ErrorText } from "../common/ErrorText";
import type { PlayerLists } from "./ServerPlayerList";
import styles from "./Servers.module.css";
import { useWindowActivity } from "../../lib/windowActivity";

export function ServerWhitelistToggle({ server, enabled, visible = true }: { server: LocalServer; enabled: boolean; visible?: boolean }) {
  const t = useUiText();
  const [data, setData] = useState<PlayerLists | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingChecked, setPendingChecked] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const active = useWindowActivity() && visible;
  const revision = useRef(0);
  const runtimeState = data?.runtimeState ?? server.status;
  useEffect(() => {
    setData(previous => previous ? { ...previous, whitelistEnabled: enabled } : previous);
  }, [enabled]);
  useEffect(() => {
    let alive = true;
    const requestRevision = revision.current;
    void command<PlayerLists>("get_server_players", { serverId: server.id })
      .then(value => { if (alive && requestRevision === revision.current) setData(value); })
      .catch(reason => { if (alive) setError(String(reason.message ?? reason)); });
    return () => { alive = false; };
  }, [server.id, server.status]);
  useEffect(() => {
    if (!active || busy) return;
    let alive = true;
    const timer = window.setInterval(() => {
      const requestRevision = revision.current;
      void command<PlayerLists>("get_server_players", { serverId: server.id }).then(value => { if (alive && requestRevision === revision.current) setData(value); }).catch(() => {});
    }, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [server.id, active, busy]);
  const apply = async (checked: boolean) => {
    if (busy) return;
    ++revision.current;
    setPendingChecked(checked); setBusy(true); setError("");
    try {
      setData(await command<PlayerLists>("edit_server_players", { serverId: server.id,
        request: { kind: "whitelistState", action: checked ? "add" : "remove", name: "", expectedRevision: "" } }));
    } catch (reason) { setError(String((reason as Error).message ?? reason)); }
    finally { setBusy(false); setPendingChecked(null); }
  };
  return <>
    <SettingRow wide title={t("localServers.properties.white-list")} description={t("serverPlayers.liveWhitelistHint")}>
      <Toggle role="checkbox" checked={pendingChecked ?? data?.whitelistEnabled ?? false} disabled={!data || busy || !["starting", "running"].includes(runtimeState)} onChange={checked => void apply(checked)} />
    </SettingRow>
    {busy ? <p className={styles.note} role="status">{t(runtimeState === "starting" ? "serverLive.waiting" : "serverPlayers.applying")}</p> : null}
    {error ? <p role="alert" className={styles.error}><ErrorText message={error} /></p> : null}
  </>;
}
