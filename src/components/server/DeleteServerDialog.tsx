import { useState } from "react";
import { Dialog } from "../common/Dialog";
import { Button } from "../common/Controls";
import { ErrorText } from "../common/ErrorText";
import { command } from "../../lib/tauri";
import { stoppedServer, type LocalServer } from "../../lib/localServers";
import { useUiText } from "../../i18n/UiText";
import { useServerLibraryStore } from "../../stores/serverLibraryStore";
export function DeleteServerDialog({ server, onClose, onDeleted }: { server: LocalServer; onClose: () => void; onDeleted: () => void }) {
  const t = useUiText(); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const remove = async () => {
    if (busy || !stoppedServer(server)) return;
    setBusy(true); setError("");
    try { await command("delete_local_server", { serverId: server.id, expectedPath: server.path }); useServerLibraryStore.getState().removeServer(server.id); onDeleted(); }
    catch (reason) { setError(String((reason as Error).message ?? reason)); }
    finally { setBusy(false); }
  };
  return <Dialog open title={t("serverWorkspace.deleteServer")} description={t("serverWorkspace.deleteServerWarning", undefined, { name: server.name })} onClose={() => { if (!busy) onClose(); }} footer={<><Button disabled={busy} onClick={onClose}>{t("common.cancel")}</Button><Button variant="danger" busy={busy} disabled={!stoppedServer(server)} onClick={() => void remove()}>{t("serverWorkspace.deleteServer")}</Button></>}>
    <p><bdi>{server.path}</bdi></p>{!stoppedServer(server) ? <p>{t("serverWorkspace.stopToDelete")}</p> : null}{error ? <div role="alert"><ErrorText message={error} /></div> : null}
  </Dialog>;
}
