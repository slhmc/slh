import type { Instance } from "./types";

export function orderedInstances(instances: Instance[], order: string[] = []) {
  const ranks = new Map(order.map((id, index) => [id, index]));
  return [...instances].sort((a, b) => {
    const rank = (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity);
    return Number.isNaN(rank) ? a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id) : rank;
  });
}

export function moveInstanceOrder(instances: Instance[], order: string[] | undefined, id: string, targetId: string, after: boolean) {
  const ids = orderedInstances(instances, order).map(instance => instance.id);
  if (id === targetId || !ids.includes(id) || !ids.includes(targetId)) return ids;
  const next = ids.filter(value => value !== id);
  next.splice(next.indexOf(targetId) + Number(after), 0, id);
  return next;
}
