import { useEffect, useRef, useState } from "react";
import { command } from "../../lib/tauri";
import { type LocalServer } from "../../lib/localServers";
import { useUiText } from "../../i18n/UiText";
import { useWindowActivity } from "../../lib/windowActivity";
import { Button } from "../common/Controls";
import { Dialog } from "../common/Dialog";
import { ErrorText } from "../common/ErrorText";
import { Plus, Trash, ArrowsClockwise, UserCircle } from "../icons";
import common from "../common/Common.module.css";
import styles from "./ServerPlayerList.module.css";

export type PlayerListKind = "whitelist" | "operators" | "bannedPlayers" | "bannedIps";
export interface PlayerEntry { name?: string; uuid?: string; ip?: string; level?: number; reason?: string; expires?: string }
export type PlayerLists = Record<PlayerListKind, PlayerEntry[]> & { revisions: Record<PlayerListKind, string>; whitelistEnabled: boolean; operatorLevel: number; runtimeState: string };
interface Edit { action: "add" | "remove"; name: string; uuid?: string; level?: number; reason?: string }

function PlayerHead({ entry }: { entry: PlayerEntry }) {
  const [failed, setFailed] = useState(false);
  const identity = entry.uuid?.replace(/-/g, "") || entry.name || "";
  const valid = /^[a-fA-F0-9]{32}$/.test(identity) || /^[A-Za-z0-9_]{1,16}$/.test(identity);
  return <span className={styles.head} aria-hidden="true">{valid && !failed ? <img src={`https://mc-heads.net/avatar/${encodeURIComponent(identity)}/32`} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <UserCircle size={24} />}</span>;
}

export function ServerPlayerList({ server, kind, visible = true }: { server: LocalServer; kind: PlayerListKind; visible?: boolean }) {
  const t = useUiText();
  const [data, setData] = useState<PlayerLists | null>(null);
  const [name, setName] = useState("");
  const [level, setLevel] = useState(4);
  const [reason, setReason] = useState("");
  const [applying, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const busy = applying || loading;
  const revision = useRef(0);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Edit | null>(null);
  const [reload, setReload] = useState(0);
  const active = useWindowActivity() && visible;
  const runtimeState = data?.runtimeState ?? server.status;
  const live = ["starting", "running"].includes(runtimeState);
  const editable = ["created", "stopped", "failed"].includes(runtimeState) || live;
  const liveLevel = data?.operatorLevel ?? 4;
  useEffect(() => {
    let alive = true;
    const requestRevision = revision.current;
    setLoading(true); setError("");
    void command<PlayerLists>("get_server_players", { serverId: server.id }).then(value => {
      if (alive && requestRevision === revision.current) setData(value);
    }).catch(value => { if (alive) setError(String(value.message ?? value)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [server.id, server.status, reload]);
  useEffect(() => {
    if (!active || busy) return;
    let alive = true;
    const timer = window.setInterval(() => {
      const requestRevision = revision.current;
      void command<PlayerLists>("get_server_players", { serverId: server.id }).then(value => { if (alive && requestRevision === revision.current) setData(value); }).catch(() => {});
    }, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [server.id, active, busy]);
  const apply = async (acceptedEdit: Edit) => {
    if (!data || !editable || busy) return;
    setPending(null);
    ++revision.current;
    setBusy(true); setError("");
    try {
      const value = await command<PlayerLists>("edit_server_players", { serverId: server.id,
        request: { ...acceptedEdit, identityProvider: "auto", kind, level: live ? liveLevel : acceptedEdit.level, uuid: live ? null : acceptedEdit.uuid || null, expectedRevision: data.revisions[kind] } });
      setData(value); setPending(null);
      if (acceptedEdit.action === "add") { setName(""); setReason(""); }
    } catch (value) { setPending(null); setError(String((value as Error).message ?? value)); }
    finally { setBusy(false); }
  };
  return <section className={styles.list} aria-label={t(`serverPlayers.${kind}`)}>
    <header><Button variant="ghost" disabled={busy} onClick={() => setReload(value => value + 1)} aria-label={t("serverPlayers.refresh")}><ArrowsClockwise size={16} /></Button></header>

    {error ? <p role="alert"><ErrorText message={error} /></p> : null}
    {!editable ? <p className={styles.note}>{t("serverPlayers.liveUnavailable")}</p> : null}
    {busy && data ? <p className={styles.note} role="status">{t(runtimeState === "starting" ? "serverLive.waiting" : "serverPlayers.applying")}</p> : null}
    {runtimeState === "starting" && !busy ? <p className={styles.note}>{t("serverLive.startingHint")}</p> : null}
    {!data && busy ? <p>{t("common.loading")}</p> : null}
    {data ? <>
      <ul>{data[kind].map((row, index) => <li key={row.uuid ?? row.ip ?? index}>
        {kind !== "bannedIps" ? <PlayerHead entry={row} /> : null}
        <div><strong><bdi>{row.name ?? row.ip}</bdi></strong>
          {row.uuid ? <code title={row.uuid}>{row.uuid}</code> : null}
          {kind === "operators" ? <span>{t("serverPlayers.levelValue", undefined, { level: row.level ?? 4 })}</span> : null}
          {row.reason ? <span><bdi>{row.reason}</bdi></span> : null}
          {row.expires ? <span>{t("serverPlayers.expiresValue", undefined, { expires: row.expires === "forever" ? t("serverPlayers.forever") : row.expires })}</span> : null}
        </div>
        <Button variant="ghost" disabled={!editable || busy} aria-label={t("serverPlayers.removeNamed", undefined, { name: row.name ?? row.ip ?? "" })} onClick={() => setPending({ action: "remove", name: row.name ?? row.ip ?? "", uuid: row.uuid })}><Trash size={16} /></Button>
      </li>)}</ul>
      {data[kind].length === 0 ? <p className={styles.note}>{t("serverPlayers.empty")}</p> : null}
      <details className={styles.addForm}>
      <summary><Plus size={16} />{t(`serverPlayers.addActions.${kind}`)}</summary>
      <div className={styles.fields}>
        <label><span>{t(kind === "bannedIps" ? "serverPlayers.ip" : "serverPlayers.name")}</span><input className={common.input} value={name} maxLength={kind === "bannedIps" ? 45 : 16} disabled={!editable || busy} onChange={event => setName(event.target.value)} /></label>
        {kind === "operators" ? <label><span>{t("serverPlayers.level")}</span><select className={common.select} value={live ? liveLevel : level} disabled={!editable || busy || live} onChange={event => setLevel(Number(event.target.value))}>{[1, 2, 3, 4].map(value => <option value={value} key={value}>{value}</option>)}</select></label> : null}
        {kind.startsWith("banned") ? <label><span>{t("serverPlayers.reason")}</span><input className={common.input} value={reason} maxLength={256} disabled={!editable || busy} onChange={event => setReason(event.target.value)} /></label> : null}
      </div>
      <Button disabled={!editable || busy || !name.trim()} onClick={() => { const edit: Edit = { action: "add", name: name.trim(), level: live ? liveLevel : level, reason }; if (kind === "operators") void apply(edit); else setPending(edit); }}><Plus size={16} />{t(kind === "bannedIps" ? "serverPlayers.addIp" : "serverPlayers.add")}</Button>
      </details>
    </> : null}
    {pending ? <Dialog open title={t(pending.action === "add" ? "serverPlayers.confirmAdd" : "serverPlayers.confirmRemove")} width="small" onClose={() => { if (!busy) setPending(null); }} footer={<><Button variant="ghost" disabled={busy} onClick={() => setPending(null)}>{t("common.cancel")}</Button><Button disabled={busy || !editable} onClick={() => void apply(pending)}>{t("localServers.confirm")}</Button></>}>
      <p>{t("serverPlayers.confirmChange", undefined, { name: pending.name, list: t(`serverPlayers.${kind}`) })}</p>
      {kind.startsWith("banned") && pending.action === "add" ? <p>{t("serverPlayers.banWarning")}</p> : null}
    </Dialog> : null}
  </section>;
}
