import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { command } from "../../lib/tauri";
import type { LocalServer, ServerCoreCandidate, ServerLaunchCheck } from "../../lib/localServers";
import { useUiText } from "../../i18n/UiText";
import { useServerLibraryStore } from "../../stores/serverLibraryStore";
import { Dialog } from "../common/Dialog";
import { Button } from "../common/Controls";
import { ErrorText } from "../common/ErrorText";
import common from "../common/Common.module.css";

export function useServerStart() {
  const t = useUiText();
  const [request, setRequest] = useState<{ server: LocalServer; check: ServerLaunchCheck } | null>(null);
  const [selected, setSelected] = useState<ServerCoreCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const resolve = useRef<((accepted: boolean) => void) | null>(null);
  const alive = useRef(true);
  const starting = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; resolve.current?.(false); resolve.current = null; }; }, []);
  const finish = (accepted: boolean) => {
    resolve.current?.(accepted); resolve.current = null; setRequest(null);
  };
  const startServer = async (server: LocalServer) => {
    if (starting.current) return false;
    starting.current = true;
    try {
      const check = await command<ServerLaunchCheck>("check_local_server_launch", { serverId: server.id });
      if (!alive.current) return false;
      if (check.needsRepair) {
        setSelected(check.candidates[0] ?? null); setError(""); setRequest({ server, check });
        const accepted = await new Promise<boolean>(done => { resolve.current = done; });
        if (!accepted || !alive.current) return false;
      }
      await command("start_local_server", { serverId: server.id });
      return true;
    } finally { starting.current = false; }
  };
  const choose = async () => {
    if (!request) return;
    setBusy(true); setError("");
    try {
      const path = await open({ defaultPath: request.server.path, multiple: false, filters: [{ name: "JAR", extensions: ["jar"] }] });
      if (typeof path === "string") setSelected(await command<ServerCoreCandidate>("inspect_local_server_core_candidate", { serverId: request.server.id, path }));
    } catch (reason) { setError(String((reason as Error).message ?? reason)); }
    finally { setBusy(false); }
  };
  const accept = async () => {
    if (!request || !selected || busy) return;
    setBusy(true); setError("");
    try {
      await command("repair_local_server_core", { serverId: request.server.id, path: selected.path, expectedRevision: request.check.revision, expectedFingerprint: selected.fingerprint });
      await useServerLibraryStore.getState().refresh().catch(() => undefined);
      finish(true);
    } catch (reason) { setError(String((reason as Error).message ?? reason)); }
    finally { setBusy(false); }
  };
  const dialog = request ? <Dialog open title={t("serverCoreRepair.title")} description={t(selected ? request.check.missing ? "serverCoreRepair.question" : "serverCoreRepair.updated" : "serverCoreRepair.notFound", undefined, { old: request.check.oldTarget, name: selected?.filename ?? "" })} onClose={() => { if (!busy) finish(false); }} footer={<><Button disabled={busy} onClick={() => finish(false)}>{t("serverCoreRepair.no")}</Button><Button variant="primary" busy={busy} disabled={!selected} onClick={() => void accept()}>{t("serverCoreRepair.yes")}</Button></>}>
    {request.check.candidates.length > 1 ? <label className={common.field}><span>{t("serverCoreRepair.candidate")}</span><select className={common.select} disabled={busy} value={selected?.path ?? ""} onChange={event => setSelected(request.check.candidates.find(value => value.path === event.target.value) ?? null)}>{request.check.candidates.map(value => <option key={value.path} value={value.path}>{value.filename} · {value.minecraftVersion}</option>)}</select></label> : null}
    {selected ? <p>{t("serverCoreRepair.version", undefined, { old: request.check.oldVersion, version: selected.minecraftVersion, java: selected.requiredJava })}</p> : null}
    <Button disabled={busy} onClick={() => void choose()}>{t("serverCoreRepair.choose")}</Button>
    {error ? <div role="alert"><ErrorText message={error} /></div> : null}
  </Dialog> : null;
  return { startServer, recoveryDialog: dialog };
}
