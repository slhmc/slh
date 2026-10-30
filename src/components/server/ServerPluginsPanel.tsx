import { useCallback, useEffect, useRef, useState } from "react";
import { command } from "../../lib/tauri";
import { useUiText } from "../../i18n/UiText";
import { stoppedServer, type LocalServer, type ServerPluginFile, type ServerPluginVersion, type ServerPluginPlan } from "../../lib/localServers";
import type { ModrinthProject, ModrinthSearchResult } from "../../lib/types";
import { useAppStore } from "../../stores/appStore";
import { formatBytes } from "../../lib/formatters";
import { Button } from "../common/Controls";
import { ContentProjectCard, ContentProjectSummary, ContentProviders, ContentSearch, ContentLoading, ContentPagination, ContentEmpty } from "../common/ContentCatalog";
import { DownloadSimple, File, X } from "../icons";
import { Dialog } from "../common/Dialog";
import { ErrorText } from "../common/ErrorText";
import common from "../common/Common.module.css";
import styles from "./Servers.module.css";
import detail from "../../routes/Instance/InstancePage.module.css";
import catalog from "../../routes/Discover/DiscoverPage.module.css";

export function ServerPluginsPanel({ server }: { server: LocalServer }) {
  const t = useUiText();
  const fitTitle = useAppStore(s => s.bootstrap?.settings.appearance.fitProjectTitles);
  const [files, setFiles] = useState<ServerPluginFile[]>([]);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [provider, setProvider] = useState<"modrinth" | "curseforge">("modrinth");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<ModrinthSearchResult | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filesLoading, setFilesLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [supported, setSupported] = useState(true);
  const [project, setProject] = useState<ModrinthProject | null>(null);
  const [versions, setVersions] = useState<ServerPluginVersion[]>([]);
  const [version, setVersion] = useState("");
  const [plan, setPlan] = useState<ServerPluginPlan | null>(null);
  const [remove, setRemove] = useState<ServerPluginFile | null>(null);
  const [notice, setNotice] = useState("");
  const request = useRef(0);
  const idle = stoppedServer(server);
  const load = useCallback(async () => {
    setFilesLoading(true);
    try {
      setFiles(await command<ServerPluginFile[]>("list_server_plugins", { serverId: server.id }));
      setSupported(true);
    } catch (reason) {
      const message = String((reason as Error).message ?? reason);
      setError(message);
      if (message.includes("does not support Bukkit plugins")) setSupported(false);
    } finally { setFilesLoading(false); }
  }, [server.id]);
  useEffect(() => { void load(); return () => { ++request.current; }; }, [load]);
  useEffect(() => {
    if (!browserOpen || !supported) return;
    let alive = true;
    setLoading(true); setResult(null); setError("");
    const timer = window.setTimeout(() => {
      void command<ModrinthSearchResult>("search_server_plugins", { serverId: server.id, provider, query, offset })
        .then(value => { if (alive) setResult(value); })
        .catch(reason => { if (alive) setError(String(reason.message ?? reason)); })
        .finally(() => { if (alive) setLoading(false); });
    }, 300);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [server.id, browserOpen, provider, query, offset, supported]);
  const closeProject = () => { ++request.current; setProject(null); setBusy(false); setError(""); };
  const choose = async (item: ModrinthProject) => {
    const ticket = ++request.current;
    setProject(item); setVersions([]); setVersion(""); setPlan(null); setBusy(true); setError("");
    try {
      const values = await command<ServerPluginVersion[]>("server_plugin_versions", { serverId: server.id, provider, projectId: item.projectId });
      if (ticket !== request.current) return;
      setVersions(values); setVersion(values[0]?.id ?? "");
    } catch (reason) { if (ticket === request.current) setError(String((reason as Error).message ?? reason)); }
    finally { if (ticket === request.current) setBusy(false); }
  };
  const review = async () => {
    if (!project || !idle) return;
    const ticket = ++request.current;
    setBusy(true); setError("");
    try {
      const value = await command<ServerPluginPlan>("plan_server_plugin", { serverId: server.id, provider, projectId: project.projectId, versionId: version });
      if (ticket === request.current) setPlan(value);
    } catch (reason) { if (ticket === request.current) setError(String((reason as Error).message ?? reason)); }
    finally { if (ticket === request.current) setBusy(false); }
  };
  const install = async () => {
    if (!project || !plan || !idle) return;
    setBusy(true); setError("");
    try {
      const count = await command<number>("install_server_plugin", { serverId: server.id, provider, projectId: project.projectId, versionId: version });
      setProject(null); setNotice(t("serverWorkspace.installedCount", undefined, { count })); await load();
    } catch (reason) { setError(String((reason as Error).message ?? reason)); }
    finally { setBusy(false); }
  };
  const manage = async (file: ServerPluginFile, action: string) => {
    if (!idle) return;
    setBusy(true); setError("");
    try { await command("manage_server_plugin", { serverId: server.id, filename: file.filename, action }); setRemove(null); await load(); }
    catch (reason) { setError(String((reason as Error).message ?? reason)); }
    finally { setBusy(false); }
  };
  return <section className={styles.plugins}>
    <header className={styles.pluginHeader}>
      <div><h2>{t("serverWorkspace.plugins")}</h2><p className={styles.note}>{t("serverWorkspace.pluginHint", undefined, { version: server.config.minecraftVersion })}</p></div>
      <div className={styles.actions}>
        {browserOpen ? <>
          <ContentProviders value={provider} onChange={value => { ++request.current; setProvider(value); setOffset(0); setProject(null); setBusy(false); setResult(null); }} />
          <Button onClick={() => { setBrowserOpen(false); closeProject(); }}><X size={16} />{t("installation.texts.backToFiles")}</Button>
        </> : <>
          <Button variant="primary" disabled={!supported} onClick={() => setBrowserOpen(true)}><DownloadSimple size={16} />{t("serverWorkspace.browsePlugins")}</Button>
        </>}
      </div>
    </header>
    {!idle ? <p className={styles.note}>{t("serverWorkspace.stopToEdit")}</p> : null}
    {!supported ? <p className={styles.note}>{t("serverWorkspace.unsupportedPlugins")}</p> : browserOpen ? <>
      <div className={catalog.searchRow}><ContentSearch value={query} onChange={value => { setQuery(value); setOffset(0); }} label={t("serverWorkspace.searchPlugins")} /></div>
      <div className={catalog.fixedTarget}><strong>{t("localServers.minecraftVersion")}</strong><span>{server.config.minecraftVersion} · {t(`localServers.cores.${server.config.core}`)}</span></div>
      {loading ? <ContentLoading /> : result ? <>
        <div className={catalog.resultSummary}>{result.totalHits.toLocaleString()} {t("installation.texts.matchingProjects")}</div>
        {!result.hits.length ? <ContentEmpty /> : <div className={catalog.projectGrid}>
          {result.hits.map(item => <ContentProjectCard key={`${provider}:${item.projectId}`}><ContentProjectSummary project={item} fitTitle={fitTitle} typeLabel={t("serverWorkspace.plugin")}><div className={catalog.cardActions}><Button disabled={!idle || busy} onClick={() => void choose(item)}>{t("serverWorkspace.chooseVersion")}</Button></div></ContentProjectSummary></ContentProjectCard>)}
        </div>}
        <ContentPagination><Button disabled={!offset || loading} onClick={() => setOffset(Math.max(0, offset - 20))}>{t("serverWorkspace.previous")}</Button><Button disabled={offset + result.hits.length >= result.totalHits || loading} onClick={() => setOffset(offset + 20)}>{t("serverWorkspace.next")}</Button></ContentPagination>
      </> : null}
    </> : filesLoading ? <ContentLoading /> : files.length ? <div className={detail.fileList}>{files.map(file => <div key={file.filename} className={`${detail.fileRow} ${styles.pluginFile}`}>
      <span className={detail.fileIcon}><File size={19} /></span>
      <span className={styles.pluginIdentity}><strong><bdi>{file.name}</bdi></strong><small><bdi>{file.filename}</bdi></small></span>
      <span className={file.enabled ? common.successBadge : common.badge}>{t(file.enabled ? "serverWorkspace.enabled" : "serverWorkspace.disabled")}</span>
      <span className={styles.stat}>{formatBytes(file.size)}</span>
      <div className={styles.actions}><Button busy={busy} disabled={!idle} onClick={() => void manage(file, "toggle")}>{t(file.enabled ? "serverWorkspace.disable" : "serverWorkspace.enable")}</Button><Button variant="danger" disabled={!idle || busy} onClick={() => setRemove(file)}>{t("serverWorkspace.remove")}</Button></div>
    </div>)}</div> : <div className={detail.tabEmpty}><File size={34} /><h2>{t("serverWorkspace.noPlugins")}</h2><p>{t("serverWorkspace.pluginHint", undefined, { version: server.config.minecraftVersion })}</p></div>}
    {notice ? <p role="status" className={styles.note}>{notice}</p> : null}
    {error && !project && !remove ? <div role="alert"><ErrorText message={error} /></div> : null}
    {project ? <Dialog open title={t("installation.installNamed", undefined, { name: project.title })} description={t("serverWorkspace.reviewPlugins")} onClose={() => { if (!busy) closeProject(); }} footer={<><Button disabled={busy} onClick={closeProject}>{t("common.close")}</Button><Button variant="primary" busy={busy} disabled={!version || !idle} onClick={() => void (plan ? install() : review())}>{t(plan ? "serverWorkspace.install" : "serverWorkspace.review")}</Button></>}>
      <div className={catalog.installDialog}>
        <div className={catalog.fixedTarget}><strong>{server.name}</strong><span>{server.config.minecraftVersion} · {t(`localServers.cores.${server.config.core}`)}</span></div>
        <label className={common.field}><span className={common.label}>{t("serverWorkspace.chooseVersion")}</span><select className={common.select} disabled={busy} value={version} onChange={event => { ++request.current; setVersion(event.target.value); setPlan(null); }}>{versions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {busy ? <ContentLoading>{t(plan ? "installation.texts.installing" : "common.loading")}</ContentLoading> : !versions.length ? <p className={styles.note}>{t("localServers.noBuilds")}</p> : null}
        {plan ? <><p className={styles.note}>{t("serverWorkspace.backupHint")}</p><div className={catalog.planItems}>{plan.items.map(item => <div key={item.projectId}><span><strong><bdi>{item.version.name}</bdi></strong><small><bdi>{item.version.filename}</bdi></small></span><span className={common.badge}>{t("installation.texts.install")}</span></div>)}</div></> : null}
        {error ? <div role="alert"><ErrorText message={error} /></div> : null}
      </div>
    </Dialog> : null}
    {remove ? <Dialog open title={t("serverWorkspace.remove")} description={t("serverWorkspace.backupHint")} onClose={() => { if (!busy) setRemove(null); }} footer={<><Button disabled={busy} onClick={() => setRemove(null)}>{t("common.close")}</Button><Button variant="danger" busy={busy} disabled={!idle} onClick={() => void manage(remove, "remove")}>{t("serverWorkspace.remove")}</Button></>}><p><bdi>{remove.filename}</bdi></p>{error ? <ErrorText message={error} /> : null}</Dialog> : null}
  </section>;
}
