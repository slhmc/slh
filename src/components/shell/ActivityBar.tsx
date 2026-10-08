import { ArrowsClockwise, CheckCircle, CloudArrowDown } from "../icons";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n/I18nProvider";
import styles from "./ActivityBar.module.css";

export function ActivityBar() {
  const { tr } = useI18n();
  const activities = useAppStore((state) => state.activities);
  // A full-disk Java scan is an explicit Settings operation, not a download.
  // Keep its progress in the Java settings page without making the global
  // download bar look permanently busy after the scan is interrupted.
  const latest = activities.find((activity) => !(activity.operation === "java" && activity.operationId === "java-disk-scan"));
  const complete = latest?.stage === "complete";
  const progress = latest?.total && latest.total > 0 ? Math.min(100, (latest.completed / latest.total) * 100) : null;
  return (
    <footer className={styles.bar}>
      <div className={styles.status}>
        {latest ? (
          <>
            {complete ? <CheckCircle size={15} weight="fill" /> : <ArrowsClockwise className={styles.spin} size={15} weight="bold" />}
            <span data-minimal-text>{tr(latest.message)}</span>
            {latest.total ? <small data-minimal-text>{latest.completed} / {latest.total}</small> : null}
          </>
        ) : (
          <>
            <CloudArrowDown size={15} />
            <span data-minimal-text>{tr("No active downloads")}</span>
          </>
        )}
      </div>
      {progress !== null ? (
        <div className={styles.progress} aria-label={`${Math.round(progress)} percent`}>
          <span style={{ width: `${progress}%` }} />
        </div>
      ) : null}
    </footer>
  );
}
