import type { Account } from "./types";

/** Keeps the account switcher in the order chosen in Settings, even after activation. */
export function orderedAccounts(accounts: Account[], configuredOrder?: string[]): Account[] {
  const order = new Map((configuredOrder ?? []).map((id, index) => [id, index]));
  return [...accounts].sort((left, right) => {
    const leftIndex = order.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = order.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  });
}

export function movedAccountOrder(accounts: Account[], configuredOrder: string[] | undefined, accountId: string, direction: -1 | 1): string[] {
  const order = orderedAccounts(accounts, configuredOrder).map((account) => account.id);
  const index = order.indexOf(accountId);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return order;
  [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
  return order;
}
