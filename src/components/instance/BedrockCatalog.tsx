import { ErrorText } from "../common/ErrorText";
import { useUiText } from "../../i18n/UiText";
import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowClockwise, DownloadSimple, Funnel, MagnifyingGlass, X } from "../icons";
import { command } from "../../lib/tauri";
import type { ModrinthProject, ModrinthSearchResult } from "../../lib/types";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n/I18nProvider";
import common from "../common/Common.module.css";
import styles from "./BedrockCatalog.module.css";

type Category = "addons" | "resourcepacks" | "worlds";
type Sort = "downloads" | "updated" | "newest" | "relevance";
const labels: Record<Category, string> = { addons: "Add-ons", resourcepacks: "Resource packs", worlds: "Worlds" };
const paths: Record<Category, string> = { addons: "addons", resourcepacks: "texture-packs", worlds: "maps" };

export function BedrockCatalog({ category, minecraftVersion, sharedProfile, onClose, onImported, onCategoryChange }: {
  category: Category;
  minecraftVersion: string;
  sharedProfile: boolean;
  onClose: () => void;
  onImported: () => void;
  onCategoryChange: (category: Category) => void;
}) {
  const uiText = useUiText();
  const { tr } = useI18n();
  const pushToast = useAppStore((state) => state.pushToast);
  const clickAction = useAppStore((state) => state.bootstrap?.settings.bedrock.cardClickAction ?? "summary");
  const [query, setQuery] = useState("");
  const [gameVersion, setGameVersion] = useState("");
  const [versions, setVersions] = useState<string[]>([]);
  const [sort, setSort] = useState<Sort>("downloads");
  const [result, setResult] = useState<ModrinthSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyProject, setBusyProject] = useState<string | null>(null);
  const [selected, setSelected] = useState<ModrinthProject | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    command<ModrinthSearchResult>("search_bedrock_curseforge", { query: "", category, offset: 0, sort: "downloads" })
      .then((value) => {
        if (!active) return;
        const found = [...new Set(value.hits.flatMap((project) => project.versions))]
          .filter((version) => /^\d+(?:\.\d+)+$/.test(version))
          .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
        setVersions(found);
        const equivalent = minecraftVersion.startsWith("1.") ? minecraftVersion.slice(2) : minecraftVersion;
        setGameVersion(found.find((version) => version === minecraftVersion || version === equivalent) ?? "");
      }).catch(() => { if (active) setVersions([]); });
    return () => { active = false; };
  }, [category, minecraftVersion]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      command<ModrinthSearchResult>("search_bedrock_curseforge", { query, category, offset: 0, gameVersion: gameVersion || null, sort })
        .then((value) => { if (active) setResult(value); })
        .catch((reason) => { if (active) { setResult(null); setError(String((reason as { message?: string }).message ?? reason)); } })
        .finally(() => { if (active) setLoading(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [category, query, gameVersion, sort, revision]);

  const loadMore = async () => {
    if (!result || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await command<ModrinthSearchResult>("search_bedrock_curseforge", { query, category, offset: result.offset + result.limit, gameVersion: gameVersion || null, sort });
      setResult((current) => current ? { ...next, hits: [...current.hits, ...next.hits] } : next);
    } catch (reason) {
      setError(String((reason as { message?: string }).message ?? reason));
    } finally {
      setLoadingMore(false);
    }
  };

  const download = async (project: ModrinthProject) => {
    setBusyProject(project.projectId);
    try {
      const path = await command<string>("download_bedrock_curseforge", { projectId: project.projectId, gameVersion: gameVersion || null });
      if (sharedProfile) {
        await command("open_bedrock_content_file", { path });
        pushToast({ tone: "success", title: uiText("installation.texts.minecraftOpenedTheSelectedContent", "Minecraft opened the selected content"), message: uiText("installation.texts.confirmTheImportInMinecraftThenRefreshThisList", "Confirm the import in Minecraft, then refresh this list.") });
        onImported();
      } else {
        pushToast({ tone: "info", title: uiText("installation.texts.bedrockPackageDownloaded", "Bedrock package downloaded"), message: `${uiText("installation.texts.savedTo", "Saved to")} ${path}` });
      }
    } catch (reason) {
      pushToast({ tone: "error", title: uiText("installation.texts.bedrockDownloadFailed", "Bedrock download failed"), message: String((reason as { message?: string }).message ?? reason) });
    } finally {
      setBusyProject(null);
    }
  };

  const openProject = (project: ModrinthProject) => {
    if (clickAction === "none") return;
    if (clickAction === "summary") { setSelected(project); return; }
    if (!/^[a-z0-9-]+$/i.test(project.slug)) return;
    void openUrl(`https://www.curseforge.com/minecraft-bedrock/${paths[category]}/${project.slug}`)
      .catch((reason) => pushToast({ tone: "error", title: "CurseForge", message: String(reason) }));
  };

  return <section className={styles.catalog}>
    <header className={styles.header}>
      <div><h1>{uiText("installation.texts.contentFor", "Content for")}{" "}{uiText("settings.minecraft", "Minecraft")}{" "}{minecraftVersion}</h1><small>{uiText("installation.texts.curseforgeBedrock", "CurseForge · Bedrock ·")}{" "}{tr(labels[category])}</small></div>
      <button className={common.secondaryButton} type="button" onClick={onClose}><X size={16} /> {uiText("installation.texts.backToFiles", "Back to files")}</button>
    </header>
    <div className={styles.toolbar}>
      <label className={styles.search}><MagnifyingGlass size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`${uiText("installation.texts.search", "Search")} ${tr(labels[category]).toLowerCase()}`} /></label>
      <div className={styles.types}>{(["addons", "resourcepacks", "worlds"] as Category[]).map((item) => <button className={category === item ? styles.active : ""} type="button" key={item} onClick={() => onCategoryChange(item)}>{tr(labels[item])}</button>)}</div>
    </div>
    <div className={styles.filters}>
      <span className={styles.filterLabel}><Funnel size={16} /> {uiText("installation.texts.filters", "Filters")}</span>
      <label><span>{uiText("installation.texts.bedrockVersion", "Bedrock version")}</span><select value={gameVersion} onChange={(event) => setGameVersion(event.target.value)}><option value="">{uiText("installation.texts.allVersions", "All versions")}</option>{versions.map((version) => <option key={version} value={version}>{version}</option>)}</select></label>
      <label><span>{uiText("installation.texts.sortBy", "Sort by")}</span><select value={sort} onChange={(event) => setSort(event.target.value as Sort)}><option value="downloads">{uiText("installation.texts.mostDownloaded", "Most downloaded")}</option><option value="updated">{uiText("installation.texts.recentlyUpdated", "Recently updated")}</option><option value="newest">{uiText("installation.texts.newest", "Newest")}</option><option value="relevance">{uiText("installation.texts.relevance", "Relevance")}</option></select></label>
      <button className={common.secondaryButton} type="button" onClick={() => setRevision((value) => value + 1)}><ArrowClockwise size={16} /> {uiText("installation.texts.refresh", "Refresh")}</button>
    </div>
    {!gameVersion && versions.length ? <p className={styles.notice}>{uiText("installation.texts.chooseACurseforgeVersionTagToShowCompatibleFiles", "Choose a CurseForge version tag to show compatible files.")} {uiText("installation.texts.profileVersion", "Profile version")}: {minecraftVersion}.</p> : null}
    {!sharedProfile ? <p className={styles.notice}>{uiText("installation.texts.anIsolatedBedrockProfileCannotReceiveFilesThroughMinecraft", "An isolated Bedrock profile cannot receive files through Minecraft's shared file association. Downloads are saved to SLH's downloads folder.")}</p> : null}
    {error ? <p className={styles.error}><ErrorText message={error} /></p> : null}
    {loading ? <p className={styles.state}>{uiText("installation.texts.loadingProjectsFrom", "Loading projects from")}{" "}{uiText("installation.texts.curseforge", "CurseForge…")}</p> : null}
    {!loading && !error && result?.hits.length === 0 ? <p className={styles.state}>{uiText("installation.texts.noProjectsFound", "No projects found")}</p> : null}
    {result && !loading ? <div className={styles.resultSummary}>{result.totalHits.toLocaleString()} {uiText("installation.texts.matchingProjects", "matching projects")}</div> : null}
    <div className={styles.grid}>{!loading && result?.hits.map((project) => <article className={styles.card} key={project.projectId}>
      <div className={styles.artwork}>{project.iconUrl ? <img src={project.iconUrl} alt="" loading="lazy" /> : <DownloadSimple size={27} />}</div>
      <div className={styles.cardBody}>
        <button className={styles.summary} type="button" disabled={clickAction === "none"} onClick={() => openProject(project)}><strong>{project.title}</strong><small>{uiText("installation.texts.by", "by")} {project.author}</small></button>
        <p>{project.description}</p>
        <div className={styles.meta}><span><DownloadSimple size={13} /> {Intl.NumberFormat(undefined, { notation: "compact" }).format(project.downloads)}</span><span>{gameVersion || project.versions[0] || uiText("installation.texts.multipleVersions", "Multiple versions")}</span></div>
        <button className={common.secondaryButton} type="button" disabled={busyProject !== null} onClick={() => void download(project)}><DownloadSimple size={15} /> {busyProject === project.projectId ? uiText("library.downloading", "Downloading") : uiText("installation.texts.download", "Download")}</button>
      </div>
    </article>)}</div>
    {result && result.offset + result.limit < result.totalHits ? <button className={common.secondaryButton} type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? uiText("common.texts.loading", "Loading") : uiText("installation.texts.loadMore", "Load more")}</button> : null}
    {selected ? <div className={styles.backdrop} onClick={() => setSelected(null)}><div className={styles.detail} onClick={(event) => event.stopPropagation()}>
      <button className={common.iconButton} type="button" aria-label={uiText("common.close", "Close")} onClick={() => setSelected(null)}><X size={17} /></button>
      <h2>{selected.title}</h2><p>{selected.description}</p><small>{selected.author} · {selected.versions.slice(0, 5).join(", ")}</small>
      <button className={common.button} type="button" disabled={busyProject !== null} onClick={() => void download(selected)}><DownloadSimple size={16} /> {uiText("installation.texts.download", "Download")}</button>
    </div></div> : null}
  </section>;
}
