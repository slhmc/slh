import { LogViewer } from "../common/LogViewer";
import { appendConsoleLines } from "../../lib/consolePresentation";
import { useAppStore } from "../../stores/appStore";
import type { ConsoleSettings } from "../../lib/types";
import { ErrorText } from "../common/ErrorText";
import { useEffect, useRef, useState } from "react";
import { useUiText } from "../../i18n/UiText";
import { command } from "../../lib/tauri";
import { useWindowActivity } from "../../lib/windowActivity";
import type { LocalServer, ServerLine, ServerSnapshot } from "../../lib/localServers";
import { Dialog } from "../common/Dialog";
import { Button } from "../common/Controls";
import common from "../common/Common.module.css";
import styles from "./Servers.module.css";

export function ServerConsolePanel({ server, showStatus = true }: { server: LocalServer; showStatus?: boolean }) {
  const t = useUiText(); const active = useWindowActivity();
  const [lines, setLines] = useState<ServerLine[]>([]);
  const [state, setState] = useState(server.status);
  const [input, setInput] = useState(""); const [error, setError] = useState("");
  const settings = useAppStore(s => s.bootstrap?.settings.console);
  const cursor = useRef(0);
  const runId = useRef<string | null>(null);
  useEffect(() => { cursor.current = 0; runId.current = null; setLines([]); setInput(""); }, [server.id]);
  useEffect(() => {
    if (!active) return;
    let alive = true; let timer: number | undefined;
    const poll = async () => {
      try {
        let snapshot = await command<ServerSnapshot>("get_local_server_console", { serverId: server.id, cursor: cursor.current });
        if (!alive) return;
        const newRun = snapshot.runId != null && runId.current != null && snapshot.runId !== runId.current;
        if (newRun || snapshot.lastSeq < cursor.current) {
          cursor.current = 0;
          setLines([]);
          setInput("");
          snapshot = await command<ServerSnapshot>("get_local_server_console", { serverId: server.id, cursor: 0 });
        }
        if (!alive) return; setState(snapshot.state); setError(snapshot.error ?? "");
        if (snapshot.runId != null) runId.current = snapshot.runId;
        if (snapshot.lines.length) {
          const previousCursor = cursor.current;
          // The host total may exceed the current response page.
          cursor.current = Math.max(cursor.current, ...snapshot.lines.map(line => line.seq));
          setLines(previous => appendConsoleLines(previous, snapshot.lines, previousCursor, settings?.maxLines ?? 2000));
        }
      } catch (reason) { if (alive) setError(String((reason as Error).message ?? reason)); }
      finally { if (alive) timer = window.setTimeout(() => void poll(), 1000); }
    };
    void poll(); return () => { alive = false; clearTimeout(timer); };
  }, [server.id, active, settings?.maxLines]);

  const send = async () => {
    if (!input.trim()) return;
    try { await command("control_local_server", { serverId: server.id, action: "command", command: input }); setInput(""); }
    catch (reason) { setError(String((reason as Error).message ?? reason)); }
  };
  const updateSettings = async (patch: Partial<ConsoleSettings>) => {
    if (!settings) return;
    try {
      await command("update_setting", { key: "console", value: { ...settings, ...patch } });
      await useAppStore.getState().refresh();
    } catch (reason) { setError(String((reason as Error).message ?? reason)); }
  };
  return <div className={`${styles.console} ${styles.consolePage}`}>
      {showStatus ? <span className={styles.status}>{t(`localServers.states.${state}`)}</span> : null}
      {settings ? <LogViewer compact lines={lines} settings={settings} onSettingsChange={patch => void updateSettings(patch)} onClear={() => setLines([])} label={t("localServers.serverOutput")} emptyText={t("localServers.waitingOutput")} actions={<>
        <Button onClick={() => { const blob = new Blob([lines.map(line => line.text).join("\n")], { type: "text/plain;charset=utf-8" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "server-console.log"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>{t("serverWorkspace.exportLogs")}</Button>
        <Button onClick={() => void command("open_local_server_console", { serverId: server.id }).catch(reason => setError(String(reason.message ?? reason)))}>{t("localServers.externalConsole")}</Button>
      </>} /> : null}
      <form onSubmit={e => { e.preventDefault(); void send(); }}><input className={common.input} aria-label={t("localServers.serverCommand")} value={input} onChange={e => setInput(e.target.value)} disabled={!["starting", "running", "stopping"].includes(state)} /><Button type="submit" disabled={!input.trim() || !["starting", "running", "stopping"].includes(state)}>{t("localServers.send")}</Button></form>
      {error ? <p className={styles.error} role="alert"><ErrorText message={error} /></p> : null}
    </div>
  ;
}

export function ServerConsoleDialog({server,onClose}:{server:LocalServer;onClose:()=>void}) { const t=useUiText();return <Dialog open title={`${t("localServers.console")} · ${server.name}`} onClose={onClose} width="xlarge"><ServerConsolePanel server={server}/></Dialog>; }
