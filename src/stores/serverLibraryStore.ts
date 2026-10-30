import { create } from "zustand";
import { command } from "../lib/tauri";
import type { ServerLibraryView, ServerOverview } from "../lib/localServers";
import { primeServerIcons } from "../lib/serverIconCache";

interface ServerLibraryStore {
  data: ServerOverview | null;
  search: string;
  setSearch: (search: string) => void;
  saveView: (view: ServerLibraryView) => Promise<void>;
  removeServer: (id: string) => void;
  refresh: () => Promise<ServerOverview>;
  synchronize: (directory?: string) => Promise<ServerOverview>;
  scanIfStale: () => Promise<ServerOverview | null>;
}

// Keep the last usable overview in memory, including while the route is unmounted.
export const useServerLibraryStore = create<ServerLibraryStore>((set, get) => {
  let requestSequence = 0;
  let appliedSequence = 0;
  let viewRevision = 0;
  let pendingViewWrites = 0;
  let viewWrites = Promise.resolve();
  let lastScan = 0;
  let scanRequest: Promise<ServerOverview> | null = null;
  const read = async (scan: boolean, directory?: string) => {
    const sequence = ++requestSequence;
    const revision = viewRevision;
    const savingView = pendingViewWrites > 0;
    const value = await command<ServerOverview>(scan ? "sync_server_library" : "get_local_servers", scan ? { directory: directory ?? null } : {});
    if (sequence < appliedSequence && get().data) {
      // A scan can discover files after a newer status read has already completed.
      return scan ? get().refresh() : get().data!;
    }
    appliedSequence = sequence;
    const data = (revision !== viewRevision || savingView || pendingViewWrites > 0) && get().data
      ? { ...value, view: get().data!.view }
      : value;
    set({ data });
    primeServerIcons(data.servers);
    return data;
  };
  return {
    data: null,
    search: "",
    setSearch: search => set({ search }),
    saveView: view => {
      ++viewRevision;
      ++pendingViewWrites;
      set(state => state.data ? { data: { ...state.data, view } } : {});
      const write = viewWrites.catch(() => undefined).then(() => command<void>("save_server_library_view", { value: view }));
      viewWrites = write;
      return write.finally(() => { --pendingViewWrites; });
    },
    removeServer: id => {
      // Invalidate reads started before deletion, so a late response cannot restore it.
      appliedSequence = ++requestSequence;
      ++viewRevision;
      set(state => state.data ? { data: { ...state.data, servers: state.data.servers.filter(server => server.id !== id), view: { ...state.data.view, selected: state.data.view?.selected === id ? "" : state.data.view?.selected } } } : {});
    },
    refresh: () => read(false),
    synchronize: directory => {
      const request = read(true, directory).then(value => { lastScan = Date.now(); return value; });
      scanRequest = request;
      void request.finally(() => { if (scanRequest === request) scanRequest = null; }).catch(() => undefined);
      return request;
    },
    scanIfStale: () => scanRequest ?? (Date.now() - lastScan >= 30_000 ? get().synchronize() : Promise.resolve(get().data)),
  };
});
