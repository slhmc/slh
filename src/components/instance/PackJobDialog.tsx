import { useUiText } from "../../i18n/UiText";
import { Button, Progress } from "../common/Controls";
import { usePackJobs, runPackInstall, cancelPackInstall, packJobProgress, type PackJob } from "../../stores/packJobs";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n/I18nProvider";
import { Dialog } from "../common/Dialog";
import { PackInstallError, useCurseForgeDownloads } from "../common/PackInstallError";

function PackJobMonitor({ job }: { job: PackJob }) {
  useCurseForgeDownloads(job.error ?? "", job.phase !== "waiting", async () => {
    try {
      const instance = await runPackInstall({ ...job, showDialog: false });
      useAppStore.getState().selectInstance(instance.id);
      useAppStore.getState().pushToast({ tone: "success", title: "{name} installed", params: { name: instance.name }, message: "" });
    } catch { /* A mismatched file stays pending until a new download arrives. */ }
  }, job.failure?.details?.files);
  return null;
}

export function PackJobDialog() {
  const uiText = useUiText();
  const jobs = usePackJobs((state) => state.jobs);
  const activeKey = usePackJobs((state) => state.activeKey);
  const show = usePackJobs((state) => state.show);
  const dismiss = usePackJobs((state) => state.dismiss);
  const { tr } = useI18n();
  const job = jobs.find((item) => item.key === activeKey);
  const progress = packJobProgress(job);
  const retry = async () => {
    if (!job) return;
    try {
      const instance = await runPackInstall({ ...job, showDialog: true });
      useAppStore.getState().selectInstance(instance.id);
      useAppStore.getState().pushToast({ tone: "success", title: "{name} installed", params: { name: instance.name }, message: "" });
    } catch { /* The job retains the complete error and retry controls. */ }
  };
  return <>
    {jobs.map((item) => <PackJobMonitor job={item} key={item.key} />)}
    <Dialog open={Boolean(job)} title={job ? uiText("installation.installNamed", "Install {name}", { name: job.name }) : uiText("installation.texts.install", "Install")} onClose={() => show(null)} footer={job ? <>
      <Button onClick={() => show(null)}>{uiText("common.close", "Close")}</Button>
      {job.commandName !== "import_slh_archive" && (job.phase === "running" || job.phase === "cancelling") ? <Button disabled={job.phase === "cancelling"} onClick={() => void cancelPackInstall(job.key).catch((error) => useAppStore.getState().pushToast({ tone: "error", title: "Could not cancel installation", message: String(error) }))}>{tr(job.phase === "cancelling" ? "Cancelling installation" : "Cancel download")}</Button> : null}
      {job.phase === "cancelled" ? <Button variant="primary" onClick={() => void retry()}>{uiText("installation.texts.retryInstallation", "Retry installation")}</Button> : null}
      {job.phase !== "running" && job.phase !== "cancelling" ? <Button onClick={() => dismiss(job.key)}>{uiText("installation.texts.removeFromList", "Remove from list")}</Button> : null}
    </> : null}>
    {job ? <>
      {job.phase === "running" || job.phase === "cancelling" || job.phase === "cancelled" ? <Progress label={tr(progress.message)} counter={progress.counter} value={job.phase === "cancelled" ? 0 : progress.percentage} /> : null}
      {job.error ? <PackInstallError failure={job.failure} monitor={false} message={job.error} busy={job.phase === "running"} onRetry={retry} showRetry onError={(error, failure) => usePackJobs.setState((state) => ({ jobs: state.jobs.map((item) => item.key === job.key ? { ...item, error, failure } : item) }))} /> : null}
      <p>{uiText("installation.texts.thisInstallationRemainsInTheLibraryOpenItsCard", "This installation remains in the Library. Open its card to view progress or continue.")}</p>
    </> : null}
  </Dialog></>;
}

