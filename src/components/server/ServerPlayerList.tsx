import { useEffect, useState } from "react";
import { command } from "../../lib/tauri";
import { stoppedServer, type LocalServer } from "../../lib/localServers";
import { useUiText } from "../../i18n/UiText";
import { Button } from "../common/Controls";
import { Dialog } from "../common/Dialog";
import { ErrorText } from "../common/ErrorText";
import { Plus, Trash, ArrowsClockwise } from "../icons";
import common from "../common/Common.module.css";
import styles from "./ServerPlayerList.module.css";

export type PlayerListKind = "whitelist" | "operators" | "bannedPlayers" | "bannedIps";
export interface PlayerEntry { name?: string; uuid?: string; ip?: string; level?: number; reason?: string; expires?: string }
export type PlayerLists = Record<PlayerListKind, PlayerEntry[]> & { revisions: Record<PlayerListKind, string> };
interface Edit { action: "add" | "remove"; name: string; uuid?: string; level?: number; reason?: string }

export function ServerPlayerList({ server, kind }: { server: LocalServer; kind: PlayerListKind }) {
  const t = useUiText();
  const [data, setData] = useState<PlayerLists | null>(null);
  const [name, setName] = useState("");
  const [uuid, setUuid] = useState("");
  const [level, setLevel] = useState(4);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Edit | null>(null);
  const [reload, setReload] = useState(0);
  const editable = stoppedServer(server);
  useEffect(() => {
    let alive = true;
    setBusy(true); setError("");
    void command<PlayerLists>("get_server_players", { serverId: server.id }).then(value => {
      if (alive) setData(value);
    }).catch(value => { if (alive) setError(String(value.message ?? value)); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [server.id, server.status, reload]);
  const apply = async () => {
    if (!data || !pending || !editable || busy) return;
    setBusy(true); setError("");
    try {
      const value = await command<PlayerLists>("edit_server_players", { serverId: server.id,
        request: { ...pending, kind, uuid: pending.uuid || null, expectedRevision: data.revisions[kind] } });
      setData(value); setPending(null);
      if (pending.action === "add") { setName(""); setUuid(""); setReason(""); }
    } catch (value) { setPending(null); setError(String((value as Error).message ?? value)); }
    finally { setBusy(false); }
  };
  return <section className={styles.list} aria-label={t(`serverPlayers.${kind}`)}>
    <header><h4>{t(`serverPlayers.${kind}`)}</h4><Button variant="ghost" disabled={busy} onClick={() => setReload(value => value + 1)} aria-label={t("serverPlayers.refresh")}><ArrowsClockwise size={16} /></Button></header>
    <p className={styles.note}>{t("serverPlayers.standardHint")}</p>
    {error ? <p role="alert"><ErrorText message={error} /></p> : null}
    {!data && busy ? <p>{t("common.loading")}</p> : null}
    {data ? <>
      <ul>{data[kind].map((row, index) => <li key={row.uuid ?? row.ip ?? index}>
        <div><strong><bdi>{row.name ?? row.ip}</bdi></strong>
          {row.uuid ? <code>{row.uuid}</code> : null}
          {kind === "operators" ? <span>{t("serverPlayers.levelValue", undefined, { level: row.level ?? 4 })}</span> : null}
          {row.reason ? <span><bdi>{row.reason}</bdi></span> : null}
          {row.expires ? <span>{t("serverPlayers.expiresValue", undefined, { expires: row.expires === "forever" ? t("serverPlayers.forever") : row.expires })}</span> : null}
        </div>
        <Button variant="ghost" disabled={!editable || busy} aria-label={t("serverPlayers.removeNamed", undefined, { name: row.name ?? row.ip ?? "" })} onClick={() => setPending({ action: "remove", name: row.name ?? row.ip ?? "", uuid: row.uuid })}><Trash size={16} /></Button>
      </li>)}</ul>
      {data[kind].length === 0 ? <p className={styles.note}>{t("serverPlayers.empty")}</p> : null}
      <div className={styles.fields}>
        <label><span>{t(kind === "bannedIps" ? "serverPlayers.ip" : "serverPlayers.name")}</span><input className={common.input} value={name} maxLength={kind === "bannedIps" ? 45 : 16} disabled={!editable || busy} onChange={event => setName(event.target.value)} /></label>
        {kind !== "bannedIps" ? <label><span>{t("serverPlayers.uuid")}</span><input className={common.input} value={uuid} maxLength={36} disabled={!editable || busy} onChange={event => setUuid(event.target.value)} /></label> : null}
        {kind === "operators" ? <label><span>{t("serverPlayers.level")}</span><select className={common.select} value={level} disabled={!editable || busy} onChange={event => setLevel(Number(event.target.value))}>{[1, 2, 3, 4].map(value => <option value={value} key={value}>{value}</option>)}</select></label> : null}
        {kind.startsWith("banned") ? <label><span>{t("serverPlayers.reason")}</span><input className={common.input} value={reason} maxLength={256} disabled={!editable || busy} onChange={event => setReason(event.target.value)} /></label> : null}
      </div>
      {kind !== "bannedIps" ? <p className={styles.note}>{t("serverPlayers.identityHint")}</p> : null}
      <Button disabled={!editable || busy || !name.trim()} onClick={() => setPending({ action: "add", name: name.trim(), uuid: uuid.trim(), level, reason })}><Plus size={16} />{t(kind === "bannedIps" ? "serverPlayers.addIp" : "serverPlayers.add")}</Button>
      <p className={styles.note}>{t("serverPlayers.saveHint")}</p>
    </> : null}
    {pending ? <Dialog open title={t(pending.action === "add" ? "serverPlayers.confirmAdd" : "serverPlayers.confirmRemove")} width="small" onClose={() => { if (!busy) setPending(null); }} footer={<><Button variant="ghost" disabled={busy} onClick={() => setPending(null)}>{t("common.cancel")}</Button><Button disabled={busy || !editable} onClick={() => void apply()}>{t("localServers.confirm")}</Button></>}>
      <p>{t("serverPlayers.confirmChange", undefined, { name: pending.name, list: t(`serverPlayers.${kind}`) })}</p>
      {kind === "operators" && pending.action === "add" ? <p>{t("serverPlayers.operatorWarning", undefined, { level: pending.level ?? 4 })}</p> : null}
      {kind.startsWith("banned") && pending.action === "add" ? <p>{t("serverPlayers.banWarning")}</p> : null}
    </Dialog> : null}
  </section>;
}
