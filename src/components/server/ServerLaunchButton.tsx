import { Play, X } from "../icons";
import { BusyIndicator } from "../common/Controls";
import { useUiText } from "../../i18n/UiText";
import { serverReady, stoppedServer, type LocalServer } from "../../lib/localServers";
import panel from "../instance/InstanceSidePanel.module.css";
import styles from "./Servers.module.css";
export function ServerLaunchButton({ server, busy, onClick }: { server: LocalServer; busy: boolean; onClick: () => void }) {
  const t = useUiText(); const stopped = stoppedServer(server);
  return <button type="button" className={`${panel.playButton} ${styles.launchButton} ${!stopped ? panel.killButton : ""}`} disabled={busy || !serverReady(server) || ["installing", "stopping", "unmanaged"].includes(server.status)} aria-busy={busy || undefined} onClick={onClick}>
    {busy ? <BusyIndicator size={20} /> : stopped ? <Play size={20} weight="fill" /> : <X size={20} weight="bold" />}{t(stopped ? "localServers.start" : "localServers.stop")}
  </button>;
}
