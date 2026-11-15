import { MorphIcon } from "../common/MorphIcon";
import { Play, X, SpinnerGap } from "../icons";
import { useUiText } from "../../i18n/UiText";
import { serverReady, stoppedServer, type LocalServer } from "../../lib/localServers";
import panel from "../instance/InstanceSidePanel.module.css";
import styles from "./Servers.module.css";
export function ServerLaunchButton({ server, busy, onClick }: { server: LocalServer; busy: boolean; onClick: () => void }) {
  const t = useUiText(); const stopped = stoppedServer(server);
  const pending = ["stopping", "installing"].includes(server.status);
  return <button type="button" className={`${panel.playButton} ${styles.launchButton} ${!stopped ? panel.killButton : ""}`} disabled={busy || !serverReady(server) || ["installing", "stopping", "unmanaged"].includes(server.status)} aria-busy={busy || pending || undefined} onClick={onClick}>
    <MorphIcon size={20} icon={busy || pending ? <SpinnerGap size={20} /> : stopped ? <Play size={20} weight="fill" /> : <X size={20} weight="bold" />} />{t(pending ? `localServers.states.${server.status}` : stopped ? "localServers.start" : "localServers.stop")}
  </button>;
}
