import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import { useUiText } from "../../i18n/UiText";
import { WarningCircle } from "../icons";
import { Dialog } from "./Dialog";
import { Button, StatusPanel } from "./Controls";
import { FailureReportLink } from "./FailureReportLink";
import type { GameDiagnosis } from "../../lib/types";
import styles from "./LaunchDiagnosisDialog.module.css";

const knownKinds = new Set<GameDiagnosis["kind"]>(["java", "memory", "dependencies", "duplicateMods", "graphics", "mods", "jvmArguments"]);

export function LaunchDiagnosisDialog() {
  const t = useUiText();
  const navigate = useNavigate();
  const failure = useAppStore(state => state.activeLaunchFailure);
  const instance = useAppStore(state => state.bootstrap?.instances.find(item => item.id === failure?.instanceId));
  const close = () => useAppStore.getState().showLaunchFailure(null);
  // Unknown future rule IDs still get an honest fallback with the saved report.
  const kind = failure?.diagnosis && knownKinds.has(failure.diagnosis.kind) ? failure.diagnosis.kind : "unknown";
  const destination = kind === "java" || kind === "memory" ? "settings"
    : kind === "dependencies" || kind === "duplicateMods" || kind === "mods" ? "mods" : "logs";
  const go = (tab: string) => {
    if (!instance) return;
    close();
    navigate(`/instance/${encodeURIComponent(instance.id)}?tab=${tab}`, { state: { diagnosisTab: tab } });
  };
  return <Dialog open={failure !== null} title={t("launchDiagnosis.title")} description={instance?.name} onClose={close} className={styles.dialog}
    footer={<>
      <Button onClick={close}>{t("common.close", "Close")}</Button>
      {instance && destination !== "logs" ? <Button onClick={() => go("logs")}>{t("launchDiagnosis.logs")}</Button> : null}
      {instance ? <Button variant="primary" onClick={() => go(destination)}>{t(`launchDiagnosis.actions.${destination}`)}</Button> : null}
    </>}>
    {failure ? <div className={styles.content} data-launch-diagnosis={kind}>
      <StatusPanel tone="error" title={<><WarningCircle size={18} aria-hidden="true" />{t(`launchDiagnosis.causes.${kind}.title`)}</>}>
        <p>{t(`launchDiagnosis.causes.${kind}.advice`)}</p>
      </StatusPanel>
      <details className={styles.details} key={`${failure.launchId}:${failure.instanceId}`}>
        <summary>{t("common.texts.technicalDetails", "Technical details")}</summary>
        <div className={styles.technical}>
          {failure.exitCode != null ? <p>{t("launchDiagnosis.exitCode", "Exit code: {code}", { code: failure.exitCode })}</p> : null}
          {failure.diagnosis?.evidence.length ? <pre className={styles.evidence} tabIndex={0} aria-label={t("launchDiagnosis.evidence")}>{failure.diagnosis.evidence.join("\n")}</pre> : null}
          {failure.reportPath ? <FailureReportLink path={failure.reportPath} /> : null}
        </div>
      </details>
    </div> : null}
  </Dialog>;
}
