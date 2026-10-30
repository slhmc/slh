import { command } from "./tauri";
import type { LocalServer } from "./localServers";

type Entry = { image: string | null; revision?: number; pending?: Promise<string | null> };
const icons = new Map<string, Entry>();

export const cachedServerIcon = (id: string) => icons.get(id)?.image ?? null;

export function refreshServerIcon(id: string, revision = 0): Promise<string | null> {
  const previous = icons.get(id);
  if (previous?.pending && previous.revision === revision) return previous.pending;
  const entry: Entry = { image: previous?.image ?? null, revision };
  const pending = command<string | null>("get_local_server_icon", { serverId: id }).then(image => {
    if (icons.get(id) === entry) entry.image = image;
    return image;
  }).finally(() => { if (icons.get(id) === entry) entry.pending = undefined; });
  entry.pending = pending;
  icons.set(id, entry);
  return pending;
}

export function primeServerIcons(servers: LocalServer[]) {
  const ids = new Set(servers.map(server => server.id));
  for (const id of icons.keys()) if (!ids.has(id)) icons.delete(id);
  for (const server of servers) {
    if (!server.presentation?.icon?.key && !icons.has(server.id)) void refreshServerIcon(server.id).catch(() => undefined);
  }
}
