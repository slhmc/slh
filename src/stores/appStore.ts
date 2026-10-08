import { create } from "zustand";
import { markStorageChanged } from "../lib/storageUsage";
import { command } from "../lib/tauri";
import type {
  BootstrapData,
  CommandFailure,
  LaunchStateEvent,
  LocaleDescriptor,
  ProgressEvent,
  ToastParams,
  ViewMode,
} from "../lib/types";
import { versionNotification } from "../lib/versionNotifications";

interface ToastMessage {
  id: string;
  tone: "info" | "success" | "error";
  title: string;
  message: string;
  params?: ToastParams;
  action?: { label: string; url?: string; title?: string; message?: string };
}

interface AppStore {
  bootstrap: BootstrapData | null;
  loading: boolean;
  error: CommandFailure | null;
  selectedInstanceId: string | null;
  search: string;
  viewMode: ViewMode;
  createWizardOpen: boolean;
  accountPopoverOpen: boolean;
  activities: ProgressEvent[];
  instanceOperationIds: string[];
  toasts: ToastMessage[];
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshLocales: () => Promise<void>;
  selectInstance: (id: string | null) => void;
  setSearch: (search: string) => void;
  setViewMode: (mode: ViewMode) => Promise<void>;
  setCreateWizardOpen: (open: boolean) => void;
  setAccountPopoverOpen: (open: boolean) => void;
  beginInstanceOperation: (instanceId: string) => void;
  endInstanceOperation: (instanceId: string) => void;
  receiveProgress: (event: ProgressEvent, silent?: boolean) => void;
  receiveLaunchState: (event: LaunchStateEvent, silent?: boolean) => void;
  pushToast: (toast: Omit<ToastMessage, "id">) => void;
  dismissToast: (id: string) => void;
}

function failure(error: unknown): CommandFailure {
  if (typeof error === "object" && error !== null && "message" in error) {
    const value = error as Partial<CommandFailure>;
    return { code: value.code ?? "command_error", message: String(value.message) };
  }
  return { code: "command_error", message: String(error) };
}

let startupRequest: Promise<void> | null = null;
let progressRefreshTimer: number | null = null;

export const useAppStore = create<AppStore>((set, get) => ({
  bootstrap: null,
  loading: true,
  error: null,
  selectedInstanceId: null,
  search: "",
  viewMode: "grid",
  createWizardOpen: false,
  accountPopoverOpen: false,
  activities: [],
  instanceOperationIds: [],
  toasts: [],
  initialize: () => {
    if (startupRequest) return startupRequest;
    startupRequest = (async () => {
      set({ loading: true, error: null });
      try {
        const bootstrap = await command<BootstrapData>("get_bootstrap");
        set({
          bootstrap,
          loading: false,
          viewMode: bootstrap.settings.general.viewMode,
        });
      } catch (error) {
        set({ loading: false, error: failure(error) });
      }
    })().finally(() => {
      startupRequest = null;
    });
    return startupRequest;
  },
  refresh: async () => {
    try {
      const bootstrap = await command<BootstrapData>("get_bootstrap");
      const selected = get().selectedInstanceId;
      set({
        bootstrap,
        selectedInstanceId: bootstrap.instances.some((instance) => instance.id === selected)
          ? selected
          : null,
      });
    } catch (error) {
      set({ error: failure(error) });
    }
  },
  refreshLocales: async () => {
    const bootstrap = get().bootstrap;
    if (!bootstrap) return;
    try {
      const locales = await command<LocaleDescriptor[]>("list_locales");
      const current = get().bootstrap;
      if (current) set({ bootstrap: { ...current, locales } });
    } catch {
      // A malformed user locale is ignored by the backend scanner. Keep the
      // current selector usable and let the normal locale load report errors.
    }
  },
  selectInstance: (selectedInstanceId) => set({ selectedInstanceId }),
  setSearch: (search) => set({ search }),
  setViewMode: async (viewMode) => {
    const bootstrap = get().bootstrap;
    set({ viewMode });
    if (!bootstrap) return;
    const general = { ...bootstrap.settings.general, viewMode };
    try {
      await command("update_setting", { key: "general", value: general });
      set({ bootstrap: { ...bootstrap, settings: { ...bootstrap.settings, general } } });
    } catch (error) {
      get().pushToast({ tone: "error", title: "View setting was not saved", message: failure(error).message });
    }
  },
  setCreateWizardOpen: (createWizardOpen) => set({ createWizardOpen }),
  setAccountPopoverOpen: (accountPopoverOpen) => set({ accountPopoverOpen }),
  beginInstanceOperation: (instanceId) => set((state) => state.instanceOperationIds.includes(instanceId)
    ? state
    : { instanceOperationIds: [...state.instanceOperationIds, instanceId] }),
  endInstanceOperation: (instanceId) => set((state) => ({
    instanceOperationIds: state.instanceOperationIds.filter((id) => id !== instanceId),
  })),
  receiveProgress: (event, silent = false) => {
    const previous = get().activities.find((item) => item.operationId === event.operationId);
    // Keep one live entry per operation. Backends emit a new stage as work
    // advances; retaining older stages makes completed downloads look stuck
    // in the library activity card.
    const remaining = get().activities.filter((item) => item.operationId !== event.operationId
      && !(event.operation === "import" && item.operation === "modpack"));
    const reachedTotal = event.total !== null && event.total > 0 && event.completed >= event.total;
    const terminal = event.stage === "complete" || event.stage === "failed"
      || (event.operation === "content" && event.stage === "install" && reachedTotal);
    // Progress events are also the source of truth for background imports
    // started from Discover. Lock the associated instance immediately, even
    // before the next bootstrap refresh changes its persisted status to
    // `installing`; this closes the stale Install-button race that could start
    // the same modpack twice.
    const instanceOperationIds = event.instanceId
      ? terminal
        ? get().instanceOperationIds.filter((id) => id !== event.instanceId)
        : get().instanceOperationIds.includes(event.instanceId)
          ? get().instanceOperationIds
          : [...get().instanceOperationIds, event.instanceId]
      : get().instanceOperationIds;
    set({
      activities: terminal ? remaining : [event, ...remaining].slice(0, 5),
      instanceOperationIds,
    });
    if (terminal) markStorageChanged();
    // Byte counters do not change persisted instance metadata. Refresh only
    // at stage boundaries and completion, rather than reading SQLite at 5 Hz.
    if (event.instanceId && (terminal || previous?.stage !== event.stage) && progressRefreshTimer === null) {
      progressRefreshTimer = window.setTimeout(() => {
        progressRefreshTimer = null;
        void get().refresh();
      }, 120);
    }
    if (silent) return;
    if (event.operation === "java" && event.stage === "metadata") {
      get().pushToast({ tone: "info", title: "Java download started", message: "" });
    }
    if (event.stage === "complete") {
      if (event.operation === "install") {
        const showInstalledVersion = () => {
          const instance = event.instanceId
            ? get().bootstrap?.instances.find((item) => item.id === event.instanceId)
            : undefined;
          if (instance) {
            get().pushToast(versionNotification(instance, "installed"));
          } else {
            get().pushToast({ tone: "success", title: "Installation complete", message: "" });
          }
        };
        const knownInstance = event.instanceId
          ? get().bootstrap?.instances.find((item) => item.id === event.instanceId)
          : undefined;
        if (knownInstance) {
          showInstalledVersion();
          void get().refresh();
        } else {
          void get().refresh().then(showInstalledVersion);
        }
        return;
      }
      void get().refresh();
      if (event.operation === "java") {
        get().pushToast({ tone: "success", title: "Java runtime ready", message: "" });
        return;
      }
      // Content dialogs already report their own result with file counts.
      if (event.operation !== "content") {
        get().pushToast({ tone: "success", title: "Instance ready", message: event.message });
      }
    }
  },
  receiveLaunchState: (event, silent = false) => {
    void get().refresh();
    if (!silent && event.state === "crashed") {
      get().pushToast({
        tone: "error",
        title: "Minecraft crashed",
        message: "Try again. If it continues, check the app log.",
      });
    }
  },
  pushToast: (toast) => {
    const preferences = get().bootstrap?.settings.notifications;
    if (preferences && (!preferences.enabled
      || (toast.tone === "info" && !preferences.showInfo)
      || (toast.tone === "success" && !preferences.showSuccess)
      || (toast.tone === "error" && !preferences.showErrors))) return;
    const isDuplicate = get().toasts.some((item) => item.tone === toast.tone
      && item.title === toast.title
      && item.message === toast.message
      && item.action?.label === toast.action?.label
      && item.action?.url === toast.action?.url);
    if (isDuplicate) return;
    const item = { ...toast, id: crypto.randomUUID() };
    const maxVisible = Math.max(1, Math.min(8, preferences?.maxVisible ?? 3));
    set({ toasts: [...get().toasts, item].slice(-maxVisible) });
    window.setTimeout(() => get().dismissToast(item.id), preferences?.durationMs ?? 5000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),
}));
