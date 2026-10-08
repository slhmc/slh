import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, CloudSlash, DownloadSimple, Funnel, MagnifyingGlass, SpinnerGap, Stack, Star, X } from "../../components/icons";
import { command } from "../../lib/tauri";
import { RequestCache } from "../../lib/requestCache";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ContentInstallPlan, ContentInstallResult, InstalledContentRecord, Instance, MinecraftVersionSummary, ModpackVersionOption, ModrinthProject, ModrinthProjectDetails, ModrinthSearchResult, ProjectGalleryImage, ProviderAvailability } from "../../lib/types";
import common from "../../components/common/Common.module.css";
import { useI18n } from "../../i18n/I18nProvider";
import { Dialog } from "../../components/common/Dialog";
import { useAppStore } from "../../stores/appStore";
import modrinthIcon from "../../assets/provider-icons/modrinth.png";
import curseforgeIcon from "../../assets/provider-icons/curseforge.png";
import page from "../shared/Page.module.css";
import styles from "./DiscoverPage.module.css";

const discoverCache = new RequestCache<ModrinthSearchResult>(60_000);
const providerCache = new RequestCache<ProviderAvailability[]>(60_000);
const minecraftCache = new RequestCache<MinecraftVersionSummary[]>(60_000);
type DiscoverFilters = { source: "modrinth" | "curseforge"; query: string; gameVersion: string; loader: string; sort: string };
const rememberedFilters = new Map<string, DiscoverFilters>();
const searchKey = (source: string, args: Record<string, unknown>) => JSON.stringify([source, args]);
const searchDiscover = (source: string, args: Record<string, unknown>) =>
  discoverCache.load(searchKey(source, args), () => command<ModrinthSearchResult>(source === "modrinth" ? "search_modrinth" : "search_curseforge", args));

const types = [
  { id: "modpack", label: "Modpacks" },
  { id: "mod", label: "Mods" },
  { id: "resourcepack", label: "Resource packs" },
  { id: "shader", label: "Shaders" },
  { id: "world", label: "Worlds" },
];

const contentTypeLabels: Record<string, string> = {
  modpack: "modpack",
  mod: "mod",
  resourcepack: "resourcepack",
  shader: "shader",
  world: "world",
};

function compact(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function safeInstanceName(title: string) {
  const sanitized = title
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 80);
  return sanitized || "Minecraft pack";
}

function matchesLoaderFilter(projectType: string) {
  return projectType === "mod" || projectType === "modpack";
}

function compareMinecraftVersions(left: string, right: string) {
  const leftParts = left.split(/[.-]/).map((part) => Number.parseInt(part, 10)).map((part) => Number.isNaN(part) ? -1 : part);
  const rightParts = right.split(/[.-]/).map((part) => Number.parseInt(part, 10)).map((part) => Number.isNaN(part) ? -1 : part);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (rightParts[index] ?? -1) - (leftParts[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return right.localeCompare(left);
}

function compareModpackVersions(left: ModpackVersionOption, right: ModpackVersionOption) {
  const compare = right.versionNumber.localeCompare(left.versionNumber, undefined, { numeric: true, sensitivity: "base" });
  return compare !== 0 ? compare : right.name.localeCompare(left.name, undefined, { numeric: true, sensitivity: "base" });
}

function safeExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function projectPageUrl(provider: "modrinth" | "curseforge", project: ModrinthProject) {
  return provider === "modrinth"
    ? `https://modrinth.com/modpack/${project.slug}`
    : `https://www.curseforge.com/minecraft/modpacks/${project.slug}`;
}

interface MarkdownRendererProps {
  markdown: string;
  onImage: (image: ProjectGalleryImage) => void;
}

interface VersionPickerProps {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}

function VersionPicker({ label, value, options, onChange }: VersionPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    const closeWhenClickingOutside = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeWhenClickingOutside);
    return () => document.removeEventListener("mousedown", closeWhenClickingOutside);
  }, []);

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  return <div className={styles.versionPicker} ref={ref}>
    <span>{label}</span>
    <button className={styles.versionPickerTrigger} type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}><strong>{selected?.label ?? "---"}</strong><span aria-hidden="true">⌄</span></button>
    {open ? <div className={styles.versionPickerMenu} role="listbox" aria-label={label}>
      <button type="button" role="option" aria-selected={!value} className={!value ? styles.versionPickerSelected : ""} onClick={() => choose("")}>---</button>
      {options.map((option) => <button type="button" role="option" aria-selected={value === option.value} className={value === option.value ? styles.versionPickerSelected : ""} onClick={() => choose(option.value)} key={option.value}>{option.label}</button>)}
    </div> : null}
  </div>;
}

function MarkdownRenderer({ markdown, onImage }: MarkdownRendererProps) {
  return <div className={styles.markdown}><ReactMarkdown
    remarkPlugins={[remarkGfm]}
    rehypePlugins={[rehypeRaw, rehypeSanitize]}
    components={{
      a: ({ href, children }) => href && safeExternalUrl(href)
        ? <a className={styles.markdownLink} href={href} onClick={(event) => { event.preventDefault(); void openUrl(href); }}>{children}</a>
        : <span>{children}</span>,
      img: ({ src, alt }) => src && safeExternalUrl(src)
        ? <img className={styles.markdownImage} src={src} alt={alt ?? ""} loading="lazy" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onImage({ url: src, thumbnailUrl: null, title: alt || null, description: null }); }} />
        : null,
      details: ({ children }) => <details className={styles.markdownDetails}>{children}</details>,
      summary: ({ children }) => <summary>{children}</summary>,
    }}
  >{markdown}</ReactMarkdown></div>;
}

function ProjectArtwork({ iconUrl }: { iconUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  return iconUrl && !failed
    ? <img src={iconUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
    : <DownloadSimple size={34} weight="duotone" />;
}

interface DiscoverPageProps {
  embeddedInstanceId?: string;
  initialType?: string;
  initialSource?: "modrinth" | "curseforge";
  onClose?: () => void;
  onInstalled?: () => void;
  hideProviderTabs?: boolean;
}

interface QueuedContentInstall {
  project: ModrinthProject;
  provider: "modrinth" | "curseforge";
}

type InstalledProjectStatus = "checking" | "current" | "update" | "error";

async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

const sortOptions = [
  { id: "relevance", label: "Relevance" },
  { id: "downloads", label: "Most downloaded" },
  { id: "follows", label: "Most followed" },
  { id: "updated", label: "Recently updated" },
  { id: "newest", label: "Newest" },
];

export function DiscoverPage({ embeddedInstanceId, initialType, initialSource, onClose, onInstalled, hideProviderTabs = false }: DiscoverPageProps = {}) {
  const { tr } = useI18n();
  const location = useLocation();
  const parameters = new URLSearchParams(location.search);
  const requestedType = initialType ?? parameters.get("type");
  const requestedInstance = embeddedInstanceId ?? parameters.get("instance");
  const filterKey = `${requestedInstance ?? "global"}:${requestedType ?? "modpack"}:${initialSource ?? "any"}`;
  const remembered = rememberedFilters.get(filterKey);
  const [source, setSource] = useState<"modrinth" | "curseforge">(initialSource ?? remembered?.source ?? "modrinth");
  const [providers, setProviders] = useState<ProviderAvailability[]>(() => providerCache.peek("providers") ?? []);
  const [query, setQuery] = useState(remembered?.query ?? "");
  const [projectType, setProjectType] = useState(types.some((type) => type.id === requestedType) ? requestedType! : "modpack");
  const [gameVersion, setGameVersion] = useState(remembered?.gameVersion ?? "");
  const [loader, setLoader] = useState(remembered?.loader ?? "");
  const [sort, setSort] = useState(remembered?.sort ?? "relevance");
  const [minecraftVersions, setMinecraftVersions] = useState<MinecraftVersionSummary[]>([]);
  const [includeSnapshots, setIncludeSnapshots] = useState(false);
  const [installedContent, setInstalledContent] = useState<InstalledContentRecord[]>([]);
  const [installedStatuses, setInstalledStatuses] = useState<Record<string, InstalledProjectStatus>>({});
  const [installedRevision, setInstalledRevision] = useState(0);
  const initialSearch = { query, projectType, gameVersion: gameVersion || null, loader: matchesLoaderFilter(projectType) ? loader || null : null, sort, offset: 0, limit: 24 };
  const [result, setResult] = useState<ModrinthSearchResult | null>(() => discoverCache.peek(searchKey(source, initialSearch), true) ?? null);
  const [loading, setLoading] = useState(!result);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<ModrinthProject | null>(null);
  const [detailsProject, setDetailsProject] = useState<ModrinthProject | null>(null);
  const [detailsProvider, setDetailsProvider] = useState<"modrinth" | "curseforge">("modrinth");
  const [details, setDetails] = useState<ModrinthProjectDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [mediaPreview, setMediaPreview] = useState<{ images: ProjectGalleryImage[]; index: number } | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<"modrinth" | "curseforge">("modrinth");
  const [targetInstance, setTargetInstance] = useState("");
  const [modpackName, setModpackName] = useState("");
  const [modpackGameVersion, setModpackGameVersion] = useState("");
  const [modpackVersionId, setModpackVersionId] = useState("");
  const [modpackVersions, setModpackVersions] = useState<ModpackVersionOption[]>([]);
  const [modpackVersionsLoading, setModpackVersionsLoading] = useState(false);
  const [plan, setPlan] = useState<ContentInstallPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [queuedInstalls, setQueuedInstalls] = useState<Record<string, QueuedContentInstall>>({});
  const [batchInstalling, setBatchInstalling] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const selectedProjectRef = useRef<ModrinthProject | null>(null);
  const installStartRef = useRef(false);
  const bootstrap = useAppStore((state) => state.bootstrap);
  const refresh = useAppStore((state) => state.refresh);
  const pushToast = useAppStore((state) => state.pushToast);
  const navigate = useNavigate();
  const scopedInstance = bootstrap?.instances.find((instance) => instance.id === requestedInstance);
  const scoped = Boolean(scopedInstance);

  useEffect(() => {
    rememberedFilters.set(filterKey, { source, query, gameVersion, loader, sort });
  }, [filterKey, source, query, gameVersion, loader, sort]);

  useEffect(() => { if (initialSource) setSource(initialSource); }, [initialSource]);

  useEffect(() => {
    minecraftCache.load("versions", () => command<MinecraftVersionSummary[]>("list_minecraft_versions"))
      .then((versions) => setMinecraftVersions(versions.filter((version) => version.versionType === "release" || version.versionType === "snapshot")))
      .catch(() => setMinecraftVersions([]));
  }, []);

  useEffect(() => {
    if (!scopedInstance) {
      setInstalledContent([]);
      return;
    }
    let active = true;
    command<InstalledContentRecord[]>("reconcile_installed_content", { instanceId: scopedInstance.id, projectType })
      .then((items) => { if (active) setInstalledContent(items); })
      .catch(() => { if (active) setInstalledContent([]); });
    return () => { active = false; };
  }, [installedRevision, projectType, scopedInstance]);

  useEffect(() => {
    if (!scopedInstance || !result) {
      setInstalledStatuses({});
      return;
    }
    const projects = result.hits.filter((project) => installedContent.some((item) => item.provider === source && item.projectId === project.projectId));
    if (projects.length === 0) {
      setInstalledStatuses({});
      return;
    }
    let active = true;
    setInstalledStatuses(Object.fromEntries(projects.map((project) => [project.projectId, "checking"] as const)));
    mapWithConcurrency(projects, 6, async (project) => {
      try {
        const resolved = await command<ContentInstallPlan>(source === "modrinth" ? "plan_modrinth_install" : "plan_curseforge_install", { instanceId: scopedInstance.id, projectId: project.projectId });
        const rootItem = resolved.items.find((item) => item.projectId === resolved.rootProjectId);
        const hasUpdate = Boolean(rootItem && rootItem.action !== "unchanged");
        return [project.projectId, hasUpdate ? "update" : "current"] as const;
      } catch {
        return [project.projectId, "error"] as const;
      }
    }).then((entries) => { if (active) setInstalledStatuses(Object.fromEntries(entries)); });
    return () => { active = false; };
  }, [installedContent, result, scopedInstance, source]);

  useEffect(() => {
    if (!scopedInstance) return;
    setGameVersion(scopedInstance.minecraftVersion);
    setLoader(["vanilla", "bedrock"].includes(scopedInstance.loaderType) ? "" : scopedInstance.loaderType);
    if (projectType === "modpack") setProjectType("mod");
  }, [projectType, scopedInstance]);

  useEffect(() => {
    if (!scoped && projectType !== "modpack") setProjectType("modpack");
  }, [projectType, scoped]);

  useEffect(() => {
    setQueuedInstalls({});
  }, [projectType, requestedInstance]);

  useEffect(() => {
    providerCache.load("providers", () => command<ProviderAvailability[]>("list_content_providers"))
      .then(setProviders)
      .catch(() => setProviders([
        { provider: "modrinth", available: true, message: null },
        { provider: "curseforge", available: true, message: tr("SLH relay configured; the first request verifies availability.") },
      ]));
  }, [tr]);

  useEffect(() => {
    if (projectType === "world") setSource("curseforge");
  }, [projectType]);

  useEffect(() => {
    let active = true;
    const args = { query, projectType, gameVersion: gameVersion || null,
      loader: matchesLoaderFilter(projectType) ? loader || null : null, sort, offset: 0, limit: 24 };
    const key = searchKey(source, args);
    const cached = discoverCache.peek(key);
    if (cached) {
      setResult(cached);
      setHasMore(cached.hits.length > 0 && cached.hits.length < cached.totalHits);
      setLoading(false);
      setError(null);
      return;
    }
    const stale = discoverCache.peek(key, true);
    if (stale) { setResult(stale); setHasMore(stale.hits.length > 0 && stale.hits.length < stale.totalHits); setLoading(false); }
    const timer = window.setTimeout(() => {
      setLoading(!stale);
      setError(null);
      const availability = providers.find((provider) => provider.provider === source);
      if (availability && !availability.available) {
        setError(availability.message ?? `${source} ${tr("is unavailable")}`);
        setLoading(false);
        return;
      }
      searchDiscover(source, args)
        .then((value) => {
          if (active) {
            setResult(value);
            setHasMore(value.hits.length > 0 && value.offset + value.limit < value.totalHits);
          }
        })
        .catch((reason) => {
          if (active && !stale) setError(String((reason as { message?: string }).message ?? reason));
        })
        .finally(() => {
          if (active) {
            setLoading(false);
            setLoadingMore(false);
          }
        });
    }, 260);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [gameVersion, loader, projectType, providers, query, sort, source]);

  const loadMore = async () => {
    if (!result || loading || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const next = await searchDiscover(source, {
        query,
        projectType,
        gameVersion: gameVersion || null,
        loader: matchesLoaderFilter(projectType) ? loader || null : null,
        sort,
        offset: result.hits.length,
        limit: 24,
      });
      setResult((current) => current ? {
        ...current,
        hits: [...current.hits, ...next.hits],
        totalHits: next.totalHits,
      } : next);
      setHasMore(next.hits.length > 0 && next.offset + next.limit < next.totalHits);
    } catch (reason) {
      setError(String((reason as { message?: string }).message ?? reason));
    } finally {
      setLoadingMore(false);
    }
  };

  const compatibleInstances = (project: ModrinthProject | null) => {
    if (!project || !bootstrap) return [];
    return bootstrap.instances.filter((instance) => instance.status === "installed" && instance.minecraftVersion === (gameVersion || instance.minecraftVersion) && (
      project.projectType === "resourcepack"
      || project.projectType === "shader"
      || project.projectType === "world"
      || (project.projectType === "mod" && !["vanilla", "bedrock"].includes(instance.loaderType) && (!loader || instance.loaderType === loader))
    ));
  };

  const selectTarget = (project: ModrinthProject) => {
    if (installing || batchInstalling || installStartRef.current) {
      pushToast({ tone: "info", title: tr("Installation in progress"), message: tr("Wait for the current installation to finish.") });
      return;
    }
    const targets = compatibleInstances(project);
    selectedProjectRef.current = project;
    setSelectedProject(project);
    setSelectedProvider(source);
    setTargetInstance(targets.find((instance) => instance.id === requestedInstance)?.id ?? targets[0]?.id ?? "");
    setModpackName(safeInstanceName(project.title));
    setModpackGameVersion(gameVersion || "");
    setModpackVersionId("");
    setModpackVersions([]);
    setPlan(null);
    setPlanError(null);
  };

  const openDetails = (project: ModrinthProject) => {
    setDetailsProject(project);
    setDetailsProvider(source);
    setDetails(null);
  };

  useEffect(() => {
    if (!detailsProject) return;
    let active = true;
    setDetailsLoading(true);
    command<ModrinthProjectDetails>(detailsProvider === "modrinth" ? "get_modrinth_project_details" : "get_curseforge_project_details", { projectId: detailsProject.projectId })
      .then((value) => { if (active) setDetails(value); })
      .catch(() => { if (active) setDetails(null); })
      .finally(() => { if (active) setDetailsLoading(false); });
    return () => { active = false; };
  }, [detailsProject, detailsProvider]);

  const installFromDetails = () => {
    if (!detailsProject) return;
    const project = detailsProject;
    const provider = detailsProvider;
    setDetailsProject(null);
    if (provider !== source) setSource(provider);
    selectTarget(project);
  };

  const closeInstallDialog = () => {
    selectedProjectRef.current = null;
    setSelectedProject(null);
  };

  const showMediaPreview = (images: ProjectGalleryImage[], index: number) => {
    if (images[index] && safeExternalUrl(images[index].url)) setMediaPreview({ images, index });
  };

  useEffect(() => {
    if (!selectedProject || selectedProject.projectType === "modpack" || !targetInstance) return;
    let active = true;
    setPlanning(true);
    setPlan(null);
    setPlanError(null);
    command<ContentInstallPlan>(selectedProvider === "modrinth" ? "plan_modrinth_install" : "plan_curseforge_install", { instanceId: targetInstance, projectId: selectedProject.projectId })
      .then((value) => { if (active) setPlan(value); })
      .catch((reason) => { if (active) setPlanError(String((reason as { message?: string }).message ?? reason)); })
      .finally(() => { if (active) setPlanning(false); });
    return () => { active = false; };
  }, [selectedProject, selectedProvider, targetInstance]);

  useEffect(() => {
    if (!selectedProject || selectedProject.projectType !== "modpack" || selectedProvider !== "modrinth") return;
    let active = true;
    setModpackVersionsLoading(true);
    command<ModrinthProjectDetails>("get_modrinth_project_details", { projectId: selectedProject.projectId })
      .then((value) => {
        if (!active) return;
        const versions = value.modpackVersions.filter((version) => version.gameVersions.length > 0);
        setModpackVersions(versions);
        if (gameVersion) {
          const latest = versions.find((version) => version.gameVersions.includes(gameVersion) && (!loader || version.loaders.some((item) => item.toLowerCase() === loader)));
          if (latest) {
            setModpackGameVersion(gameVersion);
            setModpackVersionId(latest.id);
          }
        }
      })
      .catch(() => { if (active) setModpackVersions([]); })
      .finally(() => { if (active) setModpackVersionsLoading(false); });
    return () => { active = false; };
  }, [gameVersion, loader, selectedProject, selectedProvider]);

  const install = async () => {
    if (!selectedProject || installStartRef.current) return;
    const project = selectedProject;
    const provider = selectedProvider;
    const instanceId = targetInstance;
    const instanceName = modpackName.trim();
    if (project.projectType === "modpack" && selectedProvider === "modrinth" && (!modpackGameVersion || !modpackVersionId)) {
      pushToast({ tone: "info", title: tr("Choose a version"), message: tr("Select a Minecraft and modpack version before downloading this modpack.") });
      return;
    }
    installStartRef.current = true;
    setInstalling(true);
    try {
      if (project.projectType === "modpack") {
        if (!instanceName) return;
        const created = await command<Instance>(provider === "modrinth" ? "install_modrinth_modpack" : "install_curseforge_modpack", {
          projectId: project.projectId,
          name: instanceName,
          minecraftVersion: provider === "modrinth" ? modpackGameVersion || null : null,
          loader: provider === "modrinth" ? loader || null : null,
          versionId: provider === "modrinth" ? modpackVersionId || null : null,
        });
        await refresh();
        pushToast({ tone: "success", title: tr("{name} installed", { name: created.name }), message: "" });
        if (selectedProjectRef.current?.projectId === project.projectId) {
          closeInstallDialog();
          navigate(`/instance/${created.id}`);
        }
        return;
      }
      if (!instanceId || !plan) return;
      await command<ContentInstallResult>(provider === "modrinth" ? "install_modrinth_project" : "install_curseforge_project", { instanceId, projectId: project.projectId });
      await refresh();
      onInstalled?.();
      setInstalledRevision((value) => value + 1);
      pushToast({ tone: "success", title: tr("{name} installed", { name: project.title }), message: "" });
      if (selectedProjectRef.current?.projectId === project.projectId) {
        closeInstallDialog();
        const targetTab = project.projectType === "resourcepack" ? "resourcepacks" : project.projectType === "shader" ? "shaders" : project.projectType === "world" ? "worlds" : "mods";
        if (!embeddedInstanceId) navigate(`/instance/${instanceId}?tab=${targetTab}`);
      }
    } catch (reason) {
      pushToast({ tone: "error", title: tr("Content installation failed"), message: String((reason as { message?: string }).message ?? reason) });
    } finally {
      setInstalling(false);
      installStartRef.current = false;
    }
  };

  const queueKey = (provider: "modrinth" | "curseforge", project: ModrinthProject) => `${provider}:${project.projectId}`;
  const toggleQueuedInstall = (project: ModrinthProject) => {
    const key = queueKey(source, project);
    setQueuedInstalls((current) => {
      const next = { ...current };
      if (next[key]) delete next[key];
      else next[key] = { project, provider: source };
      return next;
    });
  };
  const queuedItems = Object.values(queuedInstalls);

  const installQueued = async () => {
    if (!scopedInstance || queuedItems.length === 0 || batchInstalling) return;
    setBatchInstalling(true);
    setBatchProgress({ current: 0, total: queuedItems.length });
    const failures: string[] = [];
    let installedFiles = 0;
    let unchangedFiles = 0;
    for (const [index, item] of queuedItems.entries()) {
      try {
        const result = await command<ContentInstallResult>(item.provider === "modrinth" ? "install_modrinth_project" : "install_curseforge_project", {
          instanceId: scopedInstance.id,
          projectId: item.project.projectId,
        });
        installedFiles += result.installedFiles;
        unchangedFiles += result.unchangedFiles;
      } catch (reason) {
        failures.push(item.project.title);
      }
      setBatchProgress({ current: index + 1, total: queuedItems.length });
    }
    await refresh();
    onInstalled?.();
    setInstalledRevision((value) => value + 1);
    setQueuedInstalls({});
    setBatchInstalling(false);
    if (failures.length) {
      pushToast({ tone: "error", title: tr("Some installs failed"), message: `${failures.length} ${tr("projects could not be installed")}: ${failures.join(", ")}` });
    } else {
      pushToast({ tone: "success", title: tr("Content installed"), message: `${installedFiles} ${tr("files installed")}; ${unchangedFiles} ${tr("already current")}.` });
    }
  };

  const visibleMinecraftVersions = minecraftVersions.filter((version) => (
    includeSnapshots || version.versionType === "release" || version.id === gameVersion
  ));
  const isInstalled = (project: ModrinthProject) => installedContent.some((item) => item.provider === source && item.projectId === project.projectId);
  const compatibleModpackVersions = modpackVersions.filter((version) => !loader || version.loaders.some((item) => item.toLowerCase() === loader));
  const selectableModpackVersions = compatibleModpackVersions.filter((version) => !modpackGameVersion || version.gameVersions.includes(modpackGameVersion)).sort(compareModpackVersions);
  const selectableModpackMinecraftVersions = [...new Set(compatibleModpackVersions.flatMap((version) => version.gameVersions))].sort(compareMinecraftVersions);
  const chooseModpackMinecraftVersion = (version: string) => {
    const latest = modpackVersions
      .filter((item) => item.gameVersions.includes(version) && (!loader || item.loaders.some((loaderName) => loaderName.toLowerCase() === loader)))
      .sort(compareModpackVersions)[0];
    setModpackGameVersion(version);
    setModpackVersionId(latest?.id ?? "");
  };
  const chooseModpackVersion = (version: ModpackVersionOption) => {
    setModpackVersionId(version.id);
    const compatibleGameVersion = version.gameVersions.includes(modpackGameVersion) ? modpackGameVersion : [...version.gameVersions].sort(compareMinecraftVersions)[0] ?? "";
    setModpackGameVersion(compatibleGameVersion);
  };

  return (
    <div className={`${page.page} ${embeddedInstanceId ? styles.embedded : ""}`}>
      <header className={page.header}>
        <div>
          <h1>{scopedInstance ? `${tr("Content for")} ${scopedInstance.name}` : tr("Discover something worth playing")}</h1>
          <p>{scopedInstance ? `${tr("Only content compatible with")} Minecraft ${scopedInstance.minecraftVersion}${["vanilla", "bedrock"].includes(scopedInstance.loaderType) ? "" : ` · ${scopedInstance.loaderType}`} ${tr("is shown.")}` : tr("Browse current projects with compatibility metadata, required dependencies, and installation decisions kept explicit.")}</p>
        </div>
        <div className={styles.headerActions}>
        {!hideProviderTabs ? <div className={styles.sourceStatus} aria-label={tr("Content provider")}>
          {(["modrinth", "curseforge"] as const).map((providerName) => {
            const availability = providers.find((provider) => provider.provider === providerName);
            const available = availability?.available ?? providerName === "modrinth";
            const supportsType = !(projectType === "world" && providerName === "modrinth");
            return <button type="button" key={providerName} disabled={!supportsType} title={supportsType ? (availability?.message ? tr(availability.message) : undefined) : tr("World downloads are provided by CurseForge")} className={`${source === providerName ? styles.sourceActive : ""} ${available ? styles.sourceAvailable : styles.sourceUnavailable}`} onClick={() => { if (supportsType) { setSource(providerName); setSelectedProject(null); } }}><img className={styles.providerIcon} src={providerName === "modrinth" ? modrinthIcon : curseforgeIcon} alt="" /><span />{providerName === "modrinth" ? "Modrinth" : "CurseForge"}{available ? "" : ` (${tr("key required")})`}</button>;
          })}
        </div> : null}
        {onClose ? <button className={common.secondaryButton} type="button" onClick={onClose}><X size={16} /> {tr("Back to files")}</button> : null}
        </div>
      </header>
      <div className={styles.searchRow}>
        <label className={styles.searchBox}>
          <MagnifyingGlass size={19} weight="bold" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`${tr("Search")} ${tr(types.find((type) => type.id === projectType)?.label.toLowerCase() ?? "")}`} />
        </label>
        <div className={styles.types}>
          {scoped ? types.filter((type) => type.id !== "modpack").map((type) => <button type="button" className={projectType === type.id ? styles.active : ""} key={type.id} onClick={() => setProjectType(type.id)}>{tr(type.label)}</button>) : null}
        </div>
      </div>
      <div className={styles.filters}>
        <span className={styles.filterLabel}><Funnel size={16} /> {tr("Filters")}</span>
        <label><span>{tr("Minecraft version")}</span><select value={gameVersion} disabled={scoped} onChange={(event) => setGameVersion(event.target.value)}><option value="">{tr("All versions")}</option>{visibleMinecraftVersions.map((version) => <option key={version.id} value={version.id}>{version.id}</option>)}</select></label>
        <label><span>{tr("Loader")}</span><select value={loader} disabled={scoped || !matchesLoaderFilter(projectType)} onChange={(event) => setLoader(event.target.value)}><option value="">{tr("All loaders")}</option><option value="fabric">Fabric</option><option value="forge">Forge</option><option value="neoforge">NeoForge</option><option value="quilt">Quilt</option></select></label>
        <label><span>{tr("Sort by")}</span><select value={sort} onChange={(event) => setSort(event.target.value)}>{sortOptions.map((option) => <option key={option.id} value={option.id}>{tr(option.label)}</option>)}</select></label>
        <label className={styles.snapshotToggle}><input type="checkbox" checked={includeSnapshots} disabled={scoped} onChange={(event) => { setIncludeSnapshots(event.target.checked); if (!event.target.checked && minecraftVersions.some((version) => version.id === gameVersion && version.versionType === "snapshot")) setGameVersion(""); }} /><span>{tr("Snapshots")}</span></label>
      </div>
      {scopedInstance && ["vanilla", "bedrock"].includes(scopedInstance.loaderType) && projectType === "mod" ? <div className={styles.scopedNotice}>{tr("Mods require Fabric, Forge, NeoForge, or Quilt. Change this instance loader in Settings first.")}</div> : null}
      {!scoped && source === "curseforge" ? <div className={styles.curseforgeWip}>W.I.P.</div> : null}
      {scopedInstance && ["vanilla", "bedrock"].includes(scopedInstance.loaderType) && projectType === "mod" ? null : loading ? (
        <div className={styles.loading}><SpinnerGap size={25} className={styles.spin} /> {tr("Loading projects from")} {source === "modrinth" ? "Modrinth" : "CurseForge"}</div>
      ) : error ? (
        <div className={page.emptyState}><div><CloudSlash size={35} /><h2>{tr("Discover is offline")}</h2><p>{error}</p></div></div>
      ) : result ? (
        <>
          <div className={styles.resultSummary}>{result.totalHits.toLocaleString()} {tr("matching projects")}</div>
          {scoped && queuedItems.length ? <div className={styles.batchInstallBar}>
            <span><strong>{batchInstalling ? `${batchProgress.current} / ${batchProgress.total}` : queuedItems.length}</strong><small>{batchInstalling ? tr("Installing selected content") : tr("content items selected")}</small></span>
            <div><button className={common.secondaryButton} type="button" disabled={batchInstalling} onClick={() => setQueuedInstalls({})}>{tr("Clear selection")}</button><button className={common.button} type="button" disabled={batchInstalling} onClick={() => void installQueued()}>{batchInstalling ? <SpinnerGap className={styles.spin} size={16} /> : <DownloadSimple size={16} />} {tr("Install selected")}</button></div>
          </div> : null}
          <div className={styles.projectGrid}>
            {result.hits.map((project) => {
              const installed = scoped && isInstalled(project);
              const installedStatus = installed ? installedStatuses[project.projectId] ?? "checking" : null;
              const updateAvailable = installedStatus === "update";
              const alreadyCurrent = installedStatus === "current";
              const canInstallIntoScoped = Boolean(scoped && project.projectType !== "modpack" && compatibleInstances(project).length > 0);
              const queued = Boolean(queuedInstalls[queueKey(source, project)]);
              return (
              <article className={`${styles.projectCard} ${styles.clickableCard} ${alreadyCurrent ? styles.installedCard : updateAvailable ? styles.updateAvailableCard : ""}`} key={`${source}-${project.projectId}`} role="button" tabIndex={0} onClick={() => openDetails(project)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDetails(project); } }}>
                <div className={styles.artwork}>
                  <ProjectArtwork iconUrl={project.iconUrl} />
                </div>
                <div className={styles.projectBody} data-content-provider="true">
                  <div className={styles.projectTitle}><div><h2>{project.title}</h2><span>{tr("by")} {project.author}</span></div><span className={common.badge}>{tr(contentTypeLabels[project.projectType] ?? project.projectType)}</span></div>
                  <p>{project.description}</p>
                  <div className={styles.projectMeta}><span><DownloadSimple size={14} /> {compact(project.downloads)}</span><span><Star size={14} /> {compact(project.follows)}</span><span>{project.versions[0] ?? tr("Multiple versions")}</span></div>
                  {(() => {
                    const hasTarget = project.projectType === "modpack" || compatibleInstances(project).length > 0;
                    const label = installedStatus === "checking" ? tr("Checking") : installedStatus === "current" ? tr("Installed") : installedStatus === "update" ? tr("Update") : installedStatus === "error" ? tr("Could not check") : scoped && project.projectType !== "modpack" ? tr("Install") : project.projectType === "modpack" ? tr("Install") : tr("Choose target instance");
                    const actionable = !installed || updateAvailable;
                    const title = hasTarget
                        ? label
                        : tr("No installed compatible instance is available");
                    return <div className={styles.cardActions}>
                      {canInstallIntoScoped && actionable ? <label className={styles.queueToggle} title={tr("Select for batch installation")} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}><input type="checkbox" checked={queued} disabled={batchInstalling} onChange={() => toggleQueuedInstall(project)} /><span>{tr("Select")}</span></label> : null}
                      <button className={`${common.secondaryButton} ${alreadyCurrent ? styles.installedButton : updateAvailable ? styles.updateButton : ""}`} type="button" disabled={!hasTarget || batchInstalling || !actionable} title={updateAvailable ? tr("Update this content") : title} onClick={(event) => { event.stopPropagation(); selectTarget(project); }}>{label}</button>
                    </div>;
                  })()}
                </div>
              </article>
            );})}
          </div>
          {hasMore ? (
            <div className={styles.loadMore}>
              <button className={common.secondaryButton} type="button" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? <SpinnerGap className={styles.spin} size={16} /> : null}
                {tr(loadingMore ? "Loading" : "Load more")}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      <Dialog open={Boolean(selectedProject)} title={selectedProject ? `${tr("Install")} ${selectedProject.title}` : `${tr("Install from")} ${selectedProvider === "modrinth" ? "Modrinth" : "CurseForge"}`} description={selectedProject?.projectType === "modpack" ? `${selectedProvider === "modrinth" ? "Modrinth" : "CurseForge"}: ${tr("the archive defines Minecraft, its loader, files, and overrides for a new isolated instance.")}` : tr("SLH resolves a compatible version, required dependencies, distribution permission, and conflicts before downloading.")} onClose={closeInstallDialog}>
        {selectedProject ? <div className={styles.installDialog} data-install-dialog>
          {selectedProject.projectType === "modpack" ? <>
            <div className={styles.modpackNotice}><Stack size={28} /><span><strong>{tr("New isolated instance")}</strong><small>{tr("The verified archive remains in downloads for repair or re-import.")}</small></span></div>
            <label className={common.field}><span className={common.label}>{tr("Instance name")}</span><input className={common.input} maxLength={80} value={modpackName} onChange={(event) => setModpackName(event.target.value)} /></label>
            {selectedProvider === "modrinth" ? <div className={styles.modpackVersionSelectors}>
              {modpackVersionsLoading ? <div className={styles.detailsLoading}><SpinnerGap className={styles.spin} size={17} /> {tr("Loading versions")}</div> : <>
                <VersionPicker label={tr("Minecraft version")} value={modpackGameVersion} options={selectableModpackMinecraftVersions.map((version) => ({ value: version, label: version }))} onChange={chooseModpackMinecraftVersion} />
                <VersionPicker label={tr("Modpack version")} value={modpackVersionId} options={selectableModpackVersions.map((version) => ({ value: version.id, label: version.versionNumber }))} onChange={(value) => { const version = modpackVersions.find((item) => item.id === value); if (version) chooseModpackVersion(version); else setModpackVersionId(""); }} />
              </>}
              {!modpackGameVersion || !modpackVersionId ? <small className={styles.versionHint}>{tr("Choose a Minecraft version to continue")}</small> : null}
            </div> : null}
          </> : <>
            {scopedInstance ? <div className={styles.fixedTarget}><strong>{tr("Target instance")}</strong><span>{scopedInstance.name} · Minecraft {scopedInstance.minecraftVersion} · {scopedInstance.loaderType}</span></div> : <label className={common.field}><span className={common.label}>{tr("Target instance")}</span><select className={common.select} value={targetInstance} onChange={(event) => setTargetInstance(event.target.value)}>{compatibleInstances(selectedProject).map((instance) => <option value={instance.id} key={instance.id}>{instance.name} / {instance.minecraftVersion} / {instance.loaderType}</option>)}</select></label>}
            {planning ? <div className={styles.planState}><SpinnerGap className={styles.spin} size={21} /> {tr("Checking compatibility and dependencies")}</div> : planError ? <div className={styles.planError}>{planError}</div> : plan ? <>
              <div className={styles.planSummary}><span><strong>{plan.items.length}</strong><small>{tr("files including dependencies")}</small></span><span><strong>{formatBytes(plan.totalBytes)}</strong><small>{tr("verified download")}</small></span><span><strong>{plan.conflicts.length}</strong><small>{tr("conflicts")}</small></span></div>
              <div className={styles.planItems} data-content-provider="true">{plan.items.map((item) => <div key={item.versionId}><span><strong>{item.displayName}</strong><small>{item.fileName} / {item.versionNumber}</small></span><span className={item.action === "unchanged" ? common.successBadge : item.action === "update" ? common.warningBadge : common.badge}>{tr(item.action === "unchanged" ? "Unchanged" : item.action === "update" ? "Update" : "Install")}</span></div>)}</div>
              {plan.conflicts.length ? <div className={styles.planError}>{plan.conflicts.join("; ")}</div> : null}
            </> : null}
          </>}
          {installing ? <div className={styles.backgroundInstall}><SpinnerGap className={styles.spin} size={20} /><span><strong>{tr("Installation is running")}</strong><small>{tr("You can close this window. SLH will notify you when it finishes.")}</small></span></div> : null}
          <div className={styles.installActions}><button className={common.secondaryButton} type="button" onClick={closeInstallDialog}>{installing ? tr("Close") : tr("Cancel")}</button><button className={`${common.button} ${styles.installPrimary}`} type="button" disabled={installing || (selectedProject.projectType === "modpack" ? !modpackName.trim() || (selectedProvider === "modrinth" && (!modpackGameVersion || !modpackVersionId)) : !plan || plan.conflicts.length > 0)} onClick={() => void install()}>{installing ? <><SpinnerGap className={styles.spin} size={16} /> {tr("Installing")}</> : selectedProject.projectType === "modpack" ? tr("Download and install") : tr("Install verified files")}</button></div>
        </div> : null}
      </Dialog>
      <Dialog open={Boolean(detailsProject)} title={detailsProject ? <button className={styles.dialogProjectTitle} type="button" onClick={() => void openUrl(projectPageUrl(detailsProvider, detailsProject))}>{detailsProject.title}</button> : tr("Project")} description={detailsProject ? `${detailsProvider === "modrinth" ? "Modrinth" : "CurseForge"} · ${detailsProject.projectType}` : ""} onClose={() => setDetailsProject(null)} width="large">
        {detailsProject ? <div className={styles.detailsDialog}>
          <div className={styles.detailsHero}>
            <div className={styles.detailsArtwork}><ProjectArtwork iconUrl={detailsProject.iconUrl} /></div>
            <div><h2>{detailsProject.title}</h2><span>{tr("by")} {detailsProject.author}</span><div className={styles.detailsStats}><span><DownloadSimple size={16} /> {compact(detailsProject.downloads)} {tr("downloads")}</span><span><Star size={16} /> {compact(detailsProject.follows)} {tr("followers")}</span></div><div className={styles.detailTags}>{detailsProject.categories.slice(0, 8).map((category) => <span key={category}>{category}</span>)}</div></div>
          </div>
          <section><h3>{tr("Description")}</h3>{detailsLoading ? <div className={styles.detailsLoading}><SpinnerGap className={styles.spin} size={18} /> {tr("Loading")}</div> : <MarkdownRenderer markdown={details?.body || detailsProject.description} onImage={(image) => showMediaPreview([image], 0)} />}</section>
          {details?.gallery.length ? <section><h3>{tr("Gallery")}</h3><div className={styles.gallery}>{details.gallery.map((image, index) => <button type="button" className={styles.galleryItem} onClick={() => showMediaPreview(details.gallery, index)} title={image.title ?? tr("Open image")} key={image.url}><img src={image.thumbnailUrl ?? image.url} alt={image.title ?? ""} loading="lazy" /></button>)}</div></section> : null}
          <section><h3>{tr("Versions")}</h3><div className={styles.detailTags}>{[...detailsProject.versions].sort(compareMinecraftVersions).slice(0, 12).map((version) => <span key={version}>{version}</span>)}</div></section>
          <div className={styles.detailsActions}><button className={common.secondaryButton} type="button" onClick={() => setDetailsProject(null)}>{tr("Close")}</button><button className={common.button} type="button" onClick={installFromDetails}><DownloadSimple size={17} /> {tr("Install")}</button></div>
        </div> : null}
      </Dialog>
      <Dialog open={Boolean(mediaPreview)} title={mediaPreview?.images[mediaPreview.index]?.title ?? tr("Image preview")} onClose={() => setMediaPreview(null)} width="xlarge">
        {mediaPreview ? <div className={styles.lightbox}>
          <img src={mediaPreview.images[mediaPreview.index].url} alt={mediaPreview.images[mediaPreview.index].title ?? ""} />
          {mediaPreview.images.length > 1 ? <div className={styles.lightboxControls}><button className={common.iconButton} type="button" aria-label={tr("Previous image")} disabled={mediaPreview.index === 0} onClick={() => setMediaPreview((current) => current ? { ...current, index: current.index - 1 } : current)}><ArrowLeft size={19} /></button><span>{mediaPreview.index + 1} / {mediaPreview.images.length}</span><button className={common.iconButton} type="button" aria-label={tr("Next image")} disabled={mediaPreview.index === mediaPreview.images.length - 1} onClick={() => setMediaPreview((current) => current ? { ...current, index: current.index + 1 } : current)}><ArrowRight size={19} /></button></div> : null}
        </div> : null}
      </Dialog>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
