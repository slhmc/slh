import type { VersionMigrationContent } from "./types";

export type MigrationRules = Record<string, boolean>;

export function migrationSelected(path: string, rules: MigrationRules): boolean {
  let selected = false;
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const ancestor = parts.slice(0, index + 1).join("/");
    if (ancestor in rules) selected = rules[ancestor];
  }
  return selected;
}

export function setMigrationRule(rules: MigrationRules, path: string, selected: boolean): MigrationRules {
  return {
    ...Object.fromEntries(Object.entries(rules).filter(([key]) => !key.startsWith(`${path}/`))),
    [path]: selected,
  };
}

export function migrationContentSelected(item: VersionMigrationContent, rules: MigrationRules): boolean {
  return migrationSelected(item.path, rules)
    || item.isDirectory && Object.entries(rules).some(([path, selected]) => selected && path.startsWith(`${item.path}/`));
}

export function migrationIssues(content: VersionMigrationContent[], copyRules: MigrationRules, updateRules: MigrationRules) {
  return content.filter((item) => migrationContentSelected(item, copyRules)
    && migrationSelected(item.path, updateRules)
    && ["incompatible", "unknown", "error"].includes(item.updateStatus));
}

export function migrationUpdates(content: VersionMigrationContent[], copyRules: MigrationRules, updateRules: MigrationRules) {
  return content.filter((item) => migrationContentSelected(item, copyRules)
    && migrationSelected(item.path, updateRules)
    && item.updateStatus === "available");
}
