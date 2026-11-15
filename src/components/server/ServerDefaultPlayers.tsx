import { useState } from "react";
import type { ServerDefaultPlayers } from "../../lib/localServers";
import { useUiText } from "../../i18n/UiText";
import { Button } from "../common/Controls";
import { Plus, Trash } from "../icons";
import common from "../common/Common.module.css";
import styles from "./Servers.module.css";

export function ServerDefaultPlayersEditor({ value, onChange, disabled = false, creation = false }: { value: ServerDefaultPlayers; disabled?: boolean; creation?: boolean; onChange: (value: ServerDefaultPlayers) => void }) {
  const t = useUiText();
  const [kind, setKind] = useState<"whitelist" | "operators" | "bannedPlayers" | "bannedIps">("whitelist");
  const [name, setName] = useState("");
  const [level, setLevel] = useState(4);
  const [reason, setReason] = useState("");
  const rawRows = value[kind] ?? [];
  const rows = rawRows.map(row => "ip" in row ? { ...row, name: row.ip } : row);
  const valid = !disabled && (kind === "bannedIps" ? /^[0-9a-fA-F:.]{3,45}$/.test(name.trim()) : /^[A-Za-z0-9_]{1,16}$/.test(name.trim())) && !rows.some(row => row.name.toLowerCase() === name.trim().toLowerCase());
  return <div className={styles.defaultPlayers}>
    <div className={styles.playerNavigation}>
      {(["whitelist", "operators", "bannedPlayers", "bannedIps"] as const).map(key => <Button key={key} variant="ghost" aria-pressed={kind === key} onClick={() => setKind(key)}>{t(`serverPlayers.${key}`)}</Button>)}
    </div>
    <p className={styles.note}>{t(creation ? "serverTemplates.creationPlayersHint" : "serverTemplates.playersHint")}</p>
    {disabled ? <p role="status" className={styles.note}>{t("serverPlayers.unsupportedCompatibility")} {creation ? t("serverTemplates.clearUnsupported") : null}</p> : null}
    {rows.length ? <ul className={styles.templatePlayers}>{rows.map((row, index) => <li key={row.name.toLowerCase()}><strong><bdi>{row.name}</bdi></strong>{kind === "operators" ? <span>{t("serverPlayers.levelValue", undefined, { level: ("level" in row ? row.level : undefined) ?? 4 })}</span> : null}<Button variant="ghost" aria-label={t("serverPlayers.removeNamed", undefined, { name: row.name })} onClick={() => onChange({ ...value, [kind]: rawRows.filter((_, at) => at !== index) })} icon={<Trash size={16} />} /></li>)}</ul> : <p className={styles.note}>{t("serverPlayers.empty")}</p>}
    <div className={styles.templatePlayerForm}>
      <label className={styles.field}><span>{t(kind === "bannedIps" ? "serverPlayers.ip" : "serverPlayers.name")}</span><input disabled={disabled} className={common.input} value={name} maxLength={kind === "bannedIps" ? 45 : 16} onChange={event => setName(event.target.value)} /></label>
      {kind === "operators" ? <label className={styles.field}><span>{t("serverPlayers.level")}</span><select disabled={disabled} className={common.select} value={level} onChange={event => setLevel(Number(event.target.value))}>{[1, 2, 3, 4].map(value => <option value={value} key={value}>{value}</option>)}</select></label> : null}
      {kind.startsWith("banned") ? <label className={styles.field}><span>{t("serverPlayers.reason")}</span><input disabled={disabled} className={common.input} value={reason} maxLength={256} onChange={event => setReason(event.target.value)} /></label> : null}
      <Button disabled={!valid} icon={<Plus size={16} />} onClick={() => { onChange({ ...value, [kind]: [...rawRows, { ...(kind === "bannedIps" ? { ip: name.trim() } : { name: name.trim() }), ...(kind === "operators" ? { level } : {}), ...(kind.startsWith("banned") ? { reason } : {}) }] }); setName(""); setReason(""); }}>{t(`serverPlayers.addActions.${kind}`)}</Button>
    </div>
  </div>;
}
