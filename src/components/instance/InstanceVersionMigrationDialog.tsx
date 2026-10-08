import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, FolderOpen, SpinnerGap, WarningCircle } from "../icons";
import { Dialog } from "../common/Dialog";
import common from "../common/Common.module.css";
import type { CreateInstanceVersionCopyResult, Instance, InstanceVersionMigrationPreview, MinecraftVersionSummary, VersionMigrationContent, VersionMigrationEntry, VersionMigrationFallbackAction } from "../../lib/types";
import { migrationContentSelected, migrationIssues, migrationSelected, migrationUpdates, setMigrationRule } from "../../lib/versionMigration";
import { command } from "../../lib/tauri";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n/I18nProvider";
import styles from "./InstanceVersionMigrationDialog.module.css";

const kindLabels: Record<string, string> = { mod: "Mod", resourcepack: "Resource pack", shader: "Shader pack" };
const fallbackLabels: Record<VersionMigrationFallbackAction, string> = {
  copy: "Transfer as-is",
  disable: "Transfer disabled (.off)",
  skip: "Do not transfer",
};

export function InstanceVersionMigrationDialog({ instance, onClose, onCreated }: {
  instance: Instance;
  onClose: () => void;
  onCreated: (result: CreateInstanceVersionCopyResult) => void;
}) {
  const { tr } = useI18n();
  const refresh = useAppStore((state) => state.refresh);
  const pushToast = useAppStore((state) => state.pushToast);
  const [versions, setVersions] = useState<MinecraftVersionSummary[]>([]);
  const [entries, setEntries] = useState<VersionMigrationEntry[]>([]);
  const [children, setChildren] = useState<Record<string, VersionMigrationEntry[]>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [loadingPaths, setLoadingPaths] = useState<string[]>([]);
  const [selections, setSelections] = useState<Record<string, boolean>>({});
  const [content, setContent] = useState<VersionMigrationContent[]>([]);
  const [updateSelections, setUpdateSelections] = useState<Record<string, boolean>>({});
  const [fallbackAction, setFallbackAction] = useState<VersionMigrationFallbackAction>("copy");
  const [fallbackOverrides, setFallbackOverrides] = useState<Record<string, VersionMigrationFallbackAction>>({});
  const [targetVersion, setTargetVersion] = useState("");
  const [initialLoading, setInitialLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [loaderVersion, setLoaderVersion] = useState<string | null>(null);
  const [loaderError, setLoaderError] = useState<string | null>(null);
  const [lookupWarnings, setLookupWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      command<MinecraftVersionSummary[]>("list_minecraft_versions"),
      command<InstanceVersionMigrationPreview>("inspect_instance_version_migration", { request: { instanceId: instance.id, targetMinecraftVersion: null } }),
    ]).then(([releases, preview]) => {
      if (!active) return;
      setVersions(releases.filter((version) => version.versionType === "release"));
      setEntries(preview.entries);
      setSelections(Object.fromEntries(preview.entries.filter((entry) => entry.selectedByDefault).map((entry) => [entry.path, true])));
    }).catch((cause) => { if (active) setError(String(cause?.message ?? cause)); })
      .finally(() => { if (active) setInitialLoading(false); });
    return () => { active = false; };
  }, [instance.id]);

  useEffect(() => {
    if (!targetVersion) { setContent([]); setLoaderVersion(null); setLoaderError(null); setLookupWarnings([]); setChecking(false); return; }
    let active = true;
    setChecking(true);
    setError(null);
    setContent([]);
    setLoaderError(null);
    setLoaderVersion(null);
    setLookupWarnings([]);
    void command<InstanceVersionMigrationPreview>("inspect_instance_version_migration", {
      request: { instanceId: instance.id, targetMinecraftVersion: targetVersion },
    }).then((preview) => {
      if (!active) return;
      setContent(preview.content);
      setLoaderVersion(preview.targetLoaderVersion);
      setLoaderError(preview.loaderError);
      setLookupWarnings(preview.lookupWarnings);
    }).catch((cause) => { if (active) { setContent([]); setError(String(cause?.message ?? cause)); } })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [instance.id, targetVersion]);

  const selected = (path: string) => migrationSelected(path, selections);
  const setSelected = (path: string) => {
    const next = !selected(path);
    setSelections((current) => setMigrationRule(current, path, next));
  };
  const toggleExpand = async (path: string) => {
    if (expanded.includes(path)) { setExpanded((current) => current.filter((item) => item !== path)); return; }
    setExpanded((current) => [...current, path]);
    if (path in children || loadingPaths.includes(path)) return;
    setLoadingPaths((current) => [...current, path]);
    try {
      const result = await command<VersionMigrationEntry[]>("list_instance_version_migration_entries", { request: { instanceId: instance.id, path } });
      setChildren((current) => ({ ...current, [path]: result }));
    } catch (cause) { setError(String((cause as Error)?.message ?? cause)); }
    finally { setLoadingPaths((current) => current.filter((item) => item !== path)); }
  };
  const issues = useMemo(() => migrationIssues(content, selections, updateSelections), [content, selections, updateSelections]);
  const updates = useMemo(() => migrationUpdates(content, selections, updateSelections), [content, selections, updateSelections]);
  const relevantLookupWarnings = lookupWarnings.filter((warning) => issues.some((item) =>
    ["unknown", "error"].includes(item.updateStatus) && warning.startsWith(`${item.projectType}:`)));
  const contentByPath = useMemo(() => new Map(content.map((item) => [item.path.toLowerCase(), item])), [content]);
  const toggleUpdate = (path: string) => setUpdateSelections((current) => setMigrationRule(current, path, !migrationSelected(path, current)));
  const statusText = (item: VersionMigrationContent) => {
    if (item.updateStatus === "available") return `${tr("Compatible update")}: ${item.candidateVersion ?? ""}`;
    if (item.updateStatus === "current") return tr("Already compatible");
    const reason = item.updateStatus === "incompatible" ? "No version for selected Minecraft release"
      : item.updateStatus === "unknown" ? "Source unknown; compatibility not verified" : "Compatibility check failed";
    return `${tr(kindLabels[item.projectType])}: ${tr(reason)}`;
  };
  const renderEntry = (entry: VersionMigrationEntry, depth = 0): React.ReactNode => {
    const checked = selected(entry.path);
    const item = contentByPath.get(entry.path.toLowerCase());
    const updating = migrationSelected(entry.path, updateSelections);
    const containsSelected = checked || entry.isDirectory && Object.entries(selections).some(([path, enabled]) => enabled && path.startsWith(`${entry.path}/`));
    const supportsUpdates = Boolean(item) || entry.isDirectory && ["mods", "resourcepacks", "shaderpacks"].includes(entry.path.toLowerCase())
      || entry.isDirectory && content.some((candidate) => candidate.path.startsWith(`${entry.path}/`));
    const partialUpdates = entry.isDirectory && content.some((candidate) => candidate.path.startsWith(`${entry.path}/`)
      && migrationContentSelected(candidate, selections) && migrationSelected(candidate.path, updateSelections) !== updating);
    return <div className={styles.treeGroup} key={entry.path}>
      <div data-content-provider className={`${styles.treeRow} ${checked ? styles.treeSelected : ""}`} style={{ paddingLeft: 10 + depth * 20 }}>
        <button type="button" className={styles.expand} onClick={() => entry.isDirectory && void toggleExpand(entry.path)} disabled={!entry.isDirectory || creating} aria-label={`${expanded.includes(entry.path) ? tr("Collapse") : tr("Expand")} ${entry.name}`}>{entry.isDirectory ? (expanded.includes(entry.path) ? "▾" : "▸") : ""}</button>
        <input type="checkbox" checked={checked} disabled={creating} onChange={() => setSelected(entry.path)} aria-label={`${tr("Copy")} ${entry.name}`} />
        {entry.isDirectory ? <FolderOpen className={styles.treeIcon} size={18} /> : <span className={styles.fileIcon}>▤</span>}
        <span className={styles.treeDetails}><strong title={entry.name}>{entry.name}</strong><small>{item && updating ? statusText(item) : entry.isDirectory ? `${entry.fileCount} ${tr(entry.fileCount === 1 ? "file" : "files")}` : tr("Copy as-is")}</small></span>
        <span className={styles.treeSize}>{formatBytes(entry.sizeBytes)}</span>
        {supportsUpdates ? <button type="button" role="switch" aria-checked={updating} aria-label={`${tr("Updating")} ${entry.name}`} disabled={creating || !containsSelected} className={`${styles.updateSwitch} ${updating ? styles.updateSwitchOn : ""}`} onClick={() => toggleUpdate(entry.path)}><span>{tr("Updating")}{partialUpdates ? <small>{tr("Some files")}</small> : null}</span><span className={styles.switchTrack}><span /></span></button> : null}
      </div>
      {entry.isDirectory && expanded.includes(entry.path) ? <div className={styles.treeChildren}>{loadingPaths.includes(entry.path) ? <div className={styles.childLoading}><SpinnerGap className={styles.spin} size={15} /> {tr("Reading files")}</div> : (children[entry.path] ?? []).map((child) => renderEntry(child, depth + 1))}</div> : null}
    </div>;
  };
  const createCopy = async () => {
    if (!targetVersion || creating || checking || loaderError) return;
    setCreating(true); setError(null);
    try {
      const result = await command<CreateInstanceVersionCopyResult>("create_instance_version_copy", {
        request: {
          instanceId: instance.id, targetMinecraftVersion: targetVersion,
          selections: Object.entries(selections).map(([path, selected]) => ({ path, selected })),
          updateSelections: Object.entries(updateSelections).map(([path, selected]) => ({ path, selected })),
          fallbackAction,
          fallbackOverrides: Object.entries(fallbackOverrides).filter(([path]) => content.some((item) => item.path === path)).map(([path, action]) => ({ path, action })),
        },
      });
      await refresh();
      pushToast({ tone: result.issues.length || result.warnings.length ? "info" : "success",
        title: result.issues.length || result.warnings.length ? tr("Copy created with warnings") : tr("Version copy created"),
        message: result.issues.length ? `${result.issues.length} ${tr("files need attention")}` : result.warnings.slice(0, 2).join(" · ") || tr("Selected files were copied") });
      onCreated(result);
    } catch (cause) { setError(String((cause as Error)?.message ?? cause)); }
    finally { setCreating(false); }
  };
  return <Dialog open title={tr("Adapt build")} description={tr("Create a new copy of this build. The original and its worlds stay unchanged.")} onClose={() => { if (!creating) onClose(); }} width="xlarge">
    <div className={styles.dialog}>
      <section className={styles.filesColumn}>
      <div className={styles.listHeader}><div><h2>{tr("Build files")}</h2><p>{tr("Check files to copy. Expand folders to choose individual files. Updates are optional.")}</p></div><span>{entries.filter((entry) => selected(entry.path)).length} / {entries.length} {tr("root items selected")}</span></div>
      {initialLoading ? <div className={styles.loading}><SpinnerGap className={styles.spin} size={20} /> {tr("Reading build folders")}</div> : <div className={styles.folderList}>{entries.map((entry) => renderEntry(entry))}{entries.length === 0 ? <div className={styles.empty}>{tr("No build files found")}</div> : null}</div>}
      <div className={styles.note}><WarningCircle size={16} /><span>{tr("The checkbox selects what to transfer. The Updating switch controls version changes. When it is off, files are copied as-is and update warnings are hidden.")}</span></div>
      </section>
      <aside className={styles.detailsColumn}>
      <div className={styles.versionDock}><div className={styles.versionSide}><span>{tr("Current build")}</span><strong>{instance.minecraftVersion}</strong></div><span className={styles.versionArrow}><ArrowRight size={22} /></span><label className={styles.versionSide}><span>{tr("New Minecraft version")}</span><select className={`${common.select} ${!targetVersion ? styles.versionPlaceholder : ""}`} value={targetVersion} disabled={initialLoading || creating} onChange={(event) => setTargetVersion(event.target.value)}><option value="">{versions[0] ? `${tr("Latest release")}: ${versions[0].id}` : tr("Select a release")}</option>{versions.map((version) => <option key={version.id} value={version.id} disabled={version.id === instance.minecraftVersion}>{version.id}</option>)}</select></label></div>
      {checking ? <div className={styles.inlineState}><SpinnerGap className={styles.spin} size={16} /> {tr("Checking compatible content")}</div> : null}
      {!checking && loaderVersion ? <div className={styles.loaderInfo}>{tr("Compatible loader selected")}: {instance.loaderType} {loaderVersion}</div> : null}
      {!checking && targetVersion && issues.length > 0 ? <div className={styles.warningPanel}>
        <strong><WarningCircle size={17} /> {issues.length} {tr("files could not be updated")}</strong>
        <p>{tr("Choose how to transfer files without a compatible update. You can override the choice for each file.")}</p>
        <div className={styles.fallbackChoices} role="group" aria-label={tr("Files without a compatible update")}>
          {(Object.keys(fallbackLabels) as VersionMigrationFallbackAction[]).map((action) => <label key={action}><input type="radio" name="migration-fallback" checked={fallbackAction === action} disabled={creating} onChange={() => setFallbackAction(action)} /><span>{tr(fallbackLabels[action])}</span></label>)}
        </div>
        <div className={styles.warningList}>{issues.map((item) => <div data-content-provider className={styles.warningItem} key={item.path}>
          <span className={styles.warningDetails}><b title={item.displayName}>{item.displayName}</b><small>{statusText(item)}</small></span>
          <select value={fallbackOverrides[item.path] ?? ""} disabled={creating} aria-label={`${tr("Action for")} ${item.displayName}`} onChange={(event) => setFallbackOverrides((current) => {
            const next = { ...current };
            if (event.target.value) next[item.path] = event.target.value as VersionMigrationFallbackAction;
            else delete next[item.path];
            return next;
          })}><option value="">{tr("Use general choice")}</option>{(Object.keys(fallbackLabels) as VersionMigrationFallbackAction[]).map((action) => <option key={action} value={action}>{tr(fallbackLabels[action])}</option>)}</select>
        </div>)}</div>
      </div> : null}
      {relevantLookupWarnings.length > 0 ? <div className={styles.error}>{tr("Source lookup failed for some files")}: {relevantLookupWarnings.join(" · ")}</div> : null}
      {[loaderError, error].filter(Boolean).map((message) => <div className={styles.error} key={message}><WarningCircle size={16} /> {message}</div>)}
      </aside>
      <div className={styles.footer}><span>{targetVersion ? `${updates.length} ${tr("compatible updates selected")}` : tr("Choose a release to check installed content.")}</span><div><button className={common.secondaryButton} type="button" disabled={creating} onClick={onClose}>{tr("Cancel")}</button><button className={common.button} type="button" disabled={!targetVersion || initialLoading || checking || creating || Boolean(loaderError)} onClick={() => void createCopy()}>{creating ? <SpinnerGap className={styles.spin} size={16} /> : <Check size={16} />}{creating ? tr("Creating copy") : tr("Create version copy")}</button></div></div>
    </div>
  </Dialog>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}
