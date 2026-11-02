import { useEffect, useState } from "react";
import type { LocalServer, ServerSnapshot } from "../../lib/localServers";
import { command } from "../../lib/tauri";
import { serverGameRules, type LiveServerEdit, type LiveServerResult } from "../../lib/serverLive";
import { useWindowActivity } from "../../lib/windowActivity";
import { useUiText } from "../../i18n/UiText";
import { SettingRow } from "../settings/SettingControls";
import { Button } from "../common/Controls";
import { Dialog } from "../common/Dialog";
import { ErrorText } from "../common/ErrorText";
import common from "../common/Common.module.css";
import styles from "./Servers.module.css";

export function ServerLiveSettings({ server, visible = true }: { server: LocalServer; visible?: boolean }) {
  const t = useUiText();
  const active = useWindowActivity() && visible;
  const [state, setState] = useState(server.status);
  const [values, setValues] = useState<Record<string, string>>({});
  const [rule, setRule] = useState("");
  const [customRule, setCustomRule] = useState("");
  const [ruleValue, setRuleValue] = useState("");
  const [pending, setPending] = useState<LiveServerEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LiveServerResult | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const refresh = () => command<ServerSnapshot>("get_local_server_console", { serverId: server.id, cursor: Number.MAX_SAFE_INTEGER })
      .then(value => { if (alive) setState(value.state); }).catch(() => { if (alive) setState("unmanaged"); });
    void refresh(); const timer = window.setInterval(() => void refresh(), 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [server.id, active]);
  const available = ["starting", "running"].includes(state);
  const rules = serverGameRules(server.config.minecraftVersion);
  const selectedRule = rules.find(item => item.key === rule);
  const ruleName = rule === "custom" ? customRule.trim() : selectedRule?.command ?? "";
  const booleanRule = selectedRule?.type === "boolean";
  const apply = async () => {
    if (!pending || busy) return;
    const acceptedEdit = pending;
    setPending(null); setBusy(true); setError(""); setResult(null);
    try { setResult(await command<LiveServerResult>("apply_local_server_live", { serverId: server.id, request: acceptedEdit })); setPending(null); }
    catch (reason) { setError(String((reason as Error).message ?? reason)); setPending(null); }
    finally { setBusy(false); }
  };
  const field = (kind: string, options?: readonly string[], min = 0, max = 2147483647) => <SettingRow key={kind} wide title={t(`serverLive.fields.${kind}`)} description={kind === "gamemode" ? t("serverLive.defaultModeHint") : kind === "worldBorder" ? t("serverLive.borderHint") : undefined}>
    <div className={styles.path}>
      {options ? <select className={common.select} aria-label={t(`serverLive.fields.${kind}`)} disabled={!available || busy} value={values[kind] ?? ""} onChange={event => setValues({ ...values, [kind]: event.target.value })}>
        <option value="">{t("serverLive.chooseValue")}</option>{options.map(value => <option key={value} value={value}>{t(["difficulty", "gamemode"].includes(kind) ? `localServers.values.${value}` : `serverLive.values.${value}`)}</option>)}
      </select> : <input className={common.input} aria-label={t(`serverLive.fields.${kind}`)} type="number" min={min} max={max} step={1} disabled={!available || busy} value={values[kind] ?? ""} onChange={event => setValues({ ...values, [kind]: event.target.value })} />}
      <Button disabled={!available || busy || !values[kind] || !options && (!Number.isInteger(Number(values[kind])) || Number(values[kind]) < min || Number(values[kind]) > max)} onClick={() => setPending({ kind, value: values[kind] })}>{t("serverLive.apply")}</Button>
    </div>
  </SettingRow>;
  return <>
    <p className={styles.note}>{t("serverLive.hint")}</p>
    {!available ? <p className={styles.note}>{t("serverLive.unavailable")}</p> : state === "starting" ? <p className={styles.note}>{t("serverLive.startingHint")}</p> : null}
    {error ? <p className={styles.error} role="alert"><ErrorText message={error} /></p> : null}
    {busy ? <p role="status" className={styles.note}>{t(state === "starting" ? "serverLive.waiting" : "serverPlayers.applying")}</p> : null}
    {field("difficulty", ["peaceful", "easy", "normal", "hard"])}
    {field("gamemode", ["survival", "creative", "adventure", "spectator"])}
    {field("idleTimeout", undefined, 0, 100000)}
    {field("time", ["day", "noon", "night", "midnight"])}
    {field("weather", ["clear", "rain", "thunder"])}
    {field("worldBorder", undefined, 1, 59999968)}
    <SettingRow wide title={t("serverLive.gamerules")} description={t("serverLive.gamerulesHint")}>
      <div className={styles.liveRuleFields}>
        <select className={common.select} aria-label={t("serverLive.rule")} value={rule} disabled={!available || busy} onChange={event => { setRule(event.target.value); setRuleValue(""); }}>
          <option value="">{t("serverLive.chooseRule")}</option>{rules.map(item => <option key={item.key} value={item.key}>{t(`serverLive.rules.${item.key}`)}</option>)}<option value="custom">{t("serverLive.customRule")}</option>
        </select>
        {rule === "custom" ? <input className={common.input} aria-label={t("serverLive.ruleId")} placeholder={t("serverLive.ruleExample")} value={customRule} disabled={busy} onChange={event => setCustomRule(event.target.value)} /> : ruleName ? <code>{ruleName}</code> : null}
        {booleanRule ? <select className={common.select} aria-label={t("serverLive.ruleValue")} value={ruleValue} disabled={!available || busy} onChange={event => setRuleValue(event.target.value)}><option value="">{t("serverLive.chooseValue")}</option><option value="true">{t("serverLive.values.true")}</option><option value="false">{t("serverLive.values.false")}</option></select> : <input className={common.input} aria-label={t("serverLive.ruleValue")} value={ruleValue} disabled={!available || busy} onChange={event => setRuleValue(event.target.value)} />}
        {selectedRule?.key === "doFireTick" && selectedRule.type === "number" ? <p className={styles.note}>{t("serverLive.fireHint")}</p> : null}
        <Button disabled={!available || busy || !/^[A-Za-z0-9_:./-]{1,128}$/.test(ruleName) || !/^(true|false|-?\d+)$/.test(ruleValue)} onClick={() => setPending({ kind: "gamerule", rule: ruleName, value: ruleValue })}>{t("serverLive.apply")}</Button>
      </div>
    </SettingRow>
    <SettingRow wide title={t("serverLive.fields.save")}><Button disabled={!available || busy} onClick={() => setPending({ kind: "save", value: "" })}>{t("serverLive.saveWorld")}</Button></SettingRow>
    {result ? <div className={styles.liveResponse} role="status"><strong>{t("serverLive.sent")}</strong><code>{result.command}</code><pre>{result.lines.length ? result.lines.join("\n") : t("serverLive.noReply")}</pre></div> : null}
    {pending ? <Dialog open width="small" title={t("serverLive.confirm")} onClose={() => { if (!busy) setPending(null); }} footer={<><Button disabled={busy} onClick={() => setPending(null)}>{t("common.cancel")}</Button><Button busy={busy} onClick={() => void apply()}>{t("serverLive.apply")}</Button></>}>
      <p>{t("serverLive.confirmHint")}</p><p>{t(pending.kind === "gamerule" ? "serverLive.gamerules" : `serverLive.fields.${pending.kind}`)}</p><code>{pending.rule ? `${pending.rule} = ` : ""}{pending.value}</code>
      {pending.kind === "worldBorder" ? <p>{t("serverLive.borderHint")}</p> : null}
      {busy ? <p role="status">{t(state === "starting" ? "serverLive.waiting" : "serverPlayers.applying")}</p> : null}
    </Dialog> : null}
  </>;
}
