import type { ServerLibraryView } from "./localServers";

export const serverTabs = ["overview", "settings", "console", "plugins"] as const;
export type ServerTab = typeof serverTabs[number];
export function normalizeServerTabs(view: ServerLibraryView) {
  const order = [...new Set([...(view.tabOrder ?? []), ...serverTabs])].filter((id): id is ServerTab => serverTabs.includes(id as ServerTab));
  const visible = view.visibleTabs === undefined ? order : order.filter(id => view.visibleTabs!.includes(id));
  return { order, visible: visible.length ? visible : [order[0]] };
}
export function toggleServerTab(view: ServerLibraryView, id: ServerTab, current: string) {
  const { order, visible } = normalizeServerTabs(view);
  const next = visible.includes(id) ? visible.filter(key => key !== id) : order.filter(key => key === id || visible.includes(key));
  if (!next.length) return { view, current };
  return { view: { ...view, visibleTabs: next }, current: next.includes(current as ServerTab) ? current : next[0] };
}
export function moveBefore<T>(items: T[], source: T, target: T, after = false) {
  if (source === target || !items.includes(source) || !items.includes(target)) return items;
  const next = items.filter(item => item !== source);
  next.splice(next.indexOf(target) + Number(after), 0, source);
  return next;
}
