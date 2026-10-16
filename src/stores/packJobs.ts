import { create } from "zustand";
import { command } from "../lib/tauri";
import type { Instance, ProgressEvent } from "../lib/types";
import { useAppStore } from "./appStore";

export interface PackInstallSpec {
  key: string;
  name: string;
  minecraftVersion: string;
  loaderType: Instance["loaderType"];
  commandName: string;
  args: Record<string, unknown>;
  showDialog?: boolean;
  onSuccess?: (instance: Instance) => Promise<void>;
}
import type { CommandFailure } from "../lib/types";

export interface PackJob extends PackInstallSpec {
  phase: "running" | "cancelling" | "cancelled" | "waiting" | "error";
  error: string | null;
  failure?: CommandFailure;
  startedAt: string;
  progress?: ProgressEvent;
}
export const usePackJobs = create<{
  jobs: PackJob[];
  activeKey: string | null;
  show: (key: string | null) => void;
  dismiss: (key: string) => void;
}>((set) => ({
  jobs: [], activeKey: null,
  show: (activeKey) => set({ activeKey }),
  dismiss: (key) => set((state) => ({
    jobs: state.jobs.filter((job) => job.key !== key || job.phase === "running" || job.phase === "cancelling"),
    activeKey: state.activeKey === key ? null : state.activeKey,
  })),
}));

const running = new Map<string, Promise<Instance>>();

export function isPackCancellation(reason: unknown) {
  return (reason as { code?: string })?.code === "cancelled" || String((reason as { message?: string })?.message ?? reason).includes("Installation cancelled");
}

export async function cancelPackInstall(key: string) {
  const job = usePackJobs.getState().jobs.find((item) => item.key === key);
  if (!job || job.phase !== "running") return;
  usePackJobs.setState((state) => ({ jobs: state.jobs.map((item) => item.key === key ? { ...item, phase: "cancelling" } : item) }));
  try {
    await command<boolean>("cancel_pack_install", { key });
    await running.get(key)?.catch(() => undefined);
  } catch (reason) {
    usePackJobs.setState((state) => ({ jobs: state.jobs.map((item) => item.key === key && item.phase === "cancelling" ? { ...item, phase: "running" } : item) }));
    throw reason;
  }
}

export function receivePackProgress(progress: ProgressEvent) {
  usePackJobs.setState((state) => ({ jobs: state.jobs.map((job) =>
    (job.phase === "running" || job.phase === "cancelling") && (progress.operationId === job.key
      || Boolean(progress.instanceId && progress.instanceId === job.progress?.instanceId))
      ? { ...job, progress } : job) }));
}

export function packJobProgress(job?: PackJob) {
  const event = job?.progress;
  const message = job?.phase === "cancelled" ? "Installation cancelled"
    : job?.phase === "cancelling" ? "Cancelling installation"
    : job?.phase === "waiting" ? "Waiting for downloads"
    : job?.phase === "error" ? "Installation failed"
    : event?.operation === "install" ? "Installing Minecraft"
    : event?.stage === "pack-metadata" ? "Preparing files"
    : event?.stage === "pack-files" ? "Installing modpack files"
    : event?.stage === "download" ? "Downloading modpack"
    : "Preparing modpack";
  const total = event?.totalBytes ?? event?.total;
  const completed = event?.totalBytes != null ? event.downloadedBytes : event?.completed;
  return { message, percentage: total && completed != null ? Math.min(100, Math.max(0, completed / total * 100)) : null,
    counter: event?.total && !event.totalBytes ? `${event.completed} / ${event.total}` : null };
}

export function runPackInstall(spec: PackInstallSpec): Promise<Instance> {
  const current = running.get(spec.key);
  if (current) return current;
  const previous = usePackJobs.getState().jobs.find((job) => job.key === spec.key);
  const job: PackJob = { ...spec, progress: undefined, phase: "running", error: null, startedAt: previous?.startedAt ?? new Date().toISOString() };
  usePackJobs.setState((state) => ({
    jobs: [...state.jobs.filter((item) => item.key !== spec.key), job],
    activeKey: spec.showDialog ? spec.key : state.activeKey,
  }));
  const request = (async () => {
    try {
      const tracked = ["install_curseforge_modpack", "import_curseforge_pack", "install_modrinth_modpack", "import_modrinth_pack"].includes(spec.commandName);
      const instance = await command<Instance>(tracked ? "run_pack_install" : spec.commandName, tracked ? { key: spec.key, commandName: spec.commandName, args: spec.args } : spec.args);
      await useAppStore.getState().refresh();
      usePackJobs.setState((state) => ({
        jobs: state.jobs.filter((item) => item.key !== spec.key),
        activeKey: state.activeKey === spec.key ? null : state.activeKey,
      }));
      await spec.onSuccess?.(instance);
      return instance;
    } catch (reason) {
      const error = String((reason as { message?: string }).message ?? reason);
      usePackJobs.setState((state) => ({
        jobs: state.jobs.map((item) => item.key === spec.key ? { ...item, failure: reason as CommandFailure, error: isPackCancellation(reason) ? null : error, phase: isPackCancellation(reason) ? "cancelled" : ((reason as CommandFailure).code === "manual_downloads_required" || error.includes("curseforge-manual")) ? "waiting" : "error" } : item),
        activeKey: spec.showDialog ? spec.key : state.activeKey,
      }));
      await useAppStore.getState().refresh().catch(() => undefined);
      throw reason;
    } finally { running.delete(spec.key); }
  })();
  running.set(spec.key, request);
  return request;
}

export function packJobInstance(job: PackJob): Instance {
  return {
    id: `pack-job:${job.key}`, name: job.name, minecraftVersion: job.minecraftVersion,
    loaderType: job.loaderType, loaderVersion: null, status: job.phase === "cancelled" ? "error" : "installing", groupId: null,
    folderName: "", gameDir: "", iconPath: null, iconKey: "cube", iconBackground: "#3f493c", iconForeground: "#f0f4ed",
    createdAt: job.startedAt, lastPlayedAt: null, lastLaunchedAt: null, playtimeSeconds: 0,
    javaPath: null, memoryMinMb: 512, memoryMaxMb: 4096, configSchemaVersion: 1, bedrockProfileMode: "shared",
  };
}
