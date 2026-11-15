import { defaultArtworkColors } from "../../components/instance/InstanceArtwork";
import { ArtworkEditor } from "../../components/instance/ArtworkEditor";
import identity from "../Instance/InstancePage.module.css";
import { ColorInput } from "../../components/common/ColorInput";
import { SettingLayout, SettingRow } from "../../components/settings/SettingControls";
import { useServerStart } from "../../components/server/useServerStart";
import { useServerLibraryStore } from "../../stores/serverLibraryStore";
import { ServerLaunchButton } from "../../components/server/ServerLaunchButton";
import { ServerMetricsPanel } from "../../components/server/ServerMetricsPanel";
import { DeleteServerDialog } from "../../components/server/DeleteServerDialog";
import { ServerTabs } from "../../components/server/ServerTabs";
import { normalizeServerTabs } from "../../lib/serverPresentation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { useUiText } from "../../i18n/UiText";
import { command } from "../../lib/tauri";
import {
  serverReady,
  stoppedServer,
  type LocalServer,
  type ServerLibraryView,
  type ServerSnapshot,
} from "../../lib/localServers";
import { useWindowActivity } from "../../lib/windowActivity";
import { ServerArtwork } from "../../components/server/ServerArtwork";
import { ServerConsolePanel } from "../../components/server/ServerConsoleDialog";
import { ServerConfigFields } from "../../components/server/ServerConfigFields";
import { ServerPluginsPanel } from "../../components/server/ServerPluginsPanel";
import { Button, BusyIndicator } from "../../components/common/Controls";
import { ErrorText } from "../../components/common/ErrorText";
import { Dialog } from "../../components/common/Dialog";
import {
  FileText,
  Wrench,
  FolderOpen,
  ArrowLeft,
  PuzzlePiece,
} from "../../components/icons";
import { useAppStore } from "../../stores/appStore";
import { DetailFrame } from "../../components/common/LibraryChrome";
import { instanceIconChoices } from "../../components/instance/InstanceArtwork";
import detail from "../Instance/InstancePage.module.css";
import extra from "./ServerLibrary.module.css";

import styles from "../../components/server/Servers.module.css";
import common from "../../components/common/Common.module.css";

export function ServerWorkspacePage() {
  const { serverId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const t = useUiText();
  const { startServer, recoveryDialog } = useServerStart();
  const active = useWindowActivity();
  const tab = ["overview", "console", "plugins", "settings"].includes(
    params.get("tab") ?? "",
  )
    ? params.get("tab")!
    : "overview";
  const bootstrap = useAppStore((s) => s.bootstrap);
  const FolderActionIcon = tab === "plugins" ? PuzzlePiece : tab === "console" ? FileText : FolderOpen;
  const [view, setView] = useState<ServerLibraryView>({});
  const viewLoaded = useRef(false);
  const viewRef = useRef(view);
  const viewWrites = useRef(Promise.resolve());
  const [icon, setIcon] = useState<{
    key?: string;
    background?: string;
    foreground?: string;
  }>({});
  const [diagnostic, setDiagnostic] = useState("");
  const [server, setServer] = useState<LocalServer | null>(null);
  const [draft, setDraft] = useState<LocalServer | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [coreConfirm, setCoreConfirm] = useState(false);
  const dirty = useRef(false);
  const configEpoch = useRef(0);
  const [deleting, setDeleting] = useState(false);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const [confirm, setConfirm] = useState<"kill" | "overwrite" | null>(null);
  const [iconRevision, setIconRevision] = useState(0);
  const load = useCallback(async () => {
    try {
      const value = await useServerLibraryStore.getState().refresh();
      const next = value.servers.find((s) => s.id === serverId);
      if (!next) throw Error(t("serverWorkspace.notFound"));
      setServer(next);
      if (!viewLoaded.current) {
        viewLoaded.current = true;
        viewRef.current = value.view ?? {};
        setView(viewRef.current);
        setIcon(next.presentation?.icon ?? {});
      }
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    }
  }, [serverId, t]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [load, active]);
  useEffect(() => { dirty.current = false; setDraft(null); }, [serverId]);
  useEffect(() => {
    if (tab !== "settings" || !serverId || !active) return;
    let alive = true; let pending = false;
    const refreshConfig = async () => {
      if (pending || dirty.current) return;
      pending = true;
      const epoch = configEpoch.current;
      try {
        const value = await command<LocalServer>("get_local_server_config", { serverId });
        if (alive && !dirty.current && epoch === configEpoch.current) { setDraft(value); setError(""); }
      } catch (reason) { if (alive) setError(String((reason as Error).message ?? reason)); }
      finally { pending = false; }
    };
    void refreshConfig();
    const timer = window.setInterval(() => void refreshConfig(), 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [tab, serverId, active]);
  const reloadConfig = async () => {
    ++configEpoch.current;
    try { const value = await command<LocalServer>("get_local_server_config", { serverId }); dirty.current = false; setDraft(value); setSaved(false); setError(""); setReloadConfirm(false); }
    catch (reason) { setError(String((reason as Error).message ?? reason)); }
  };
  const action = async (op: string) => {
    if (!server) return;
    setBusy(true);
    setError("");
    try {
      if (op === "start") {
        if (!await startServer(server)) return;
        if (server.config.console === "builtin") {
          const { visible } = normalizeServerTabs(view);
          if (!visible.includes("console")) saveView({ visibleTabs: [...visible, "console"] });
          setParams({ tab: "console" });
        }
        if (server.config.console === "external")
          await command("open_local_server_console", { serverId });
      } else if (op === "folder")
        await command("open_local_server_folder", { serverId, section: tab });
      else if (op === "script" || op === "overwrite")
        await command("export_local_server_script", {
          serverId,
          overwrite: op === "overwrite",
        });
      else await command("control_local_server", { serverId, action: op });
      await load();
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };
  const coreChanged = !!server && !!draft && ["core", "minecraftVersion", "coreVersion", "customJar"].some(key => server.config[key as keyof typeof server.config] !== draft.config[key as keyof typeof draft.config]);
  const save = async (confirmedCore = false) => {
    if (!draft || !server || !stoppedServer(server)) return;
    if (coreChanged && !confirmedCore) { setCoreConfirm(true); return; }
    setCoreConfirm(false);
    ++configEpoch.current;
    setBusy(true);
    setError("");
    try {
      let updated = await command<LocalServer>(coreChanged ? "change_local_server_core" : "update_local_server", {
        serverId, name: draft.name, config: draft.config,
        expectedPropertiesRevision: draft.propertiesRevision ?? null,
      });
      if (coreChanged && updated.name !== draft.name) updated = await command<LocalServer>("update_local_server", {
        serverId, name: draft.name, config: updated.config,
        expectedPropertiesRevision: updated.propertiesRevision ?? null,
      });
      setDraft(updated);
      dirty.current = false;
      setSaved(true);
      await load();
    } catch (reason) {
      const message = String((reason as Error).message ?? reason);
      setError(message.includes("Server properties changed on disk") ? "serverWorkspace.settingsChangedOnDisk" : message);
    } finally {
      setBusy(false);
    }
  };
  const chooseIcon = async () => {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (typeof path !== "string") return;
      setBusy(true);
      await command("set_local_server_icon", { serverId, path });
      setIconRevision((v) => v + 1);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    } finally {
      setBusy(false);
    }
  };
  const saveView = useCallback((patch: Partial<ServerLibraryView>) => {
    const value = { ...viewRef.current, ...patch };
    viewRef.current = value;
    setView(value);
    viewWrites.current = useServerLibraryStore.getState().saveView(value).catch(reason => { setError(String(reason.message ?? reason)); });
  }, []);
  const { visible: visibleTabs } = normalizeServerTabs(view);
  useEffect(() => {
    if (viewLoaded.current && !visibleTabs.includes(tab as typeof visibleTabs[number])) setParams({ tab: visibleTabs[0] }, { replace: true });
  }, [tab, visibleTabs.join("|"), setParams]);
  useEffect(() => {
    if (!serverId || tab !== "overview") return;
    let alive = true;
    void command<ServerSnapshot>("get_local_server_console", {
      serverId,
      cursor: 0,
    })
      .then((value) => {
        if (alive) setDiagnostic(value.error ?? "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [serverId, tab]);
  const saveIcon = async () => {
    setBusy(true);
    try {
      await command("save_server_artwork", {
        serverId,
        icon,
        name: draft?.name ?? server?.name,
      });
      await load();
      setSaved(true);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    } finally {
      setBusy(false);
    }
  };
  const position =
    bootstrap?.settings.general.instanceTabsPosition ??
    "top";
  const status =
    server && !serverReady(server)
      ? t(
          server.presentation?.readiness === "missing"
            ? "serverLibrary.missing"
            : "serverLibrary.needsSetup",
        )
      : server
        ? t(`localServers.states.${server.status}`)
        : "";
  const cardSection = (title: string, body: React.ReactNode) => (
    <section className={extra.settingsCard}>
      <h2>{title}</h2>
      <div className={extra.settingsBody}>{body}</div>
    </section>
  );
  return !server ? (
    <div className={extra.settings}>
      {error ? <ErrorText message={error} /> : <BusyIndicator />}
    </div>
  ) : (
    <DetailFrame position={position}>
      {recoveryDialog}
      <header className={`${detail.header} ${extra.workspaceHeader}`}>
        <Button variant="ghost" title={t("serverWorkspace.back")} onClick={() => navigate("/local-servers")}><ArrowLeft size={17} />{t("serverWorkspace.backShort")}</Button>
        <ServerArtwork
          id={server.id}
          size="small"
          presentation={server.presentation}
          revision={iconRevision}
        />
        <div className={`${detail.identity} ${extra.workspaceIdentity}`}>
          <h1>
            <bdi>{server.name}</bdi>
          </h1>
          <p data-minimal-text>
            {server.config.minecraftVersion} ·{" "}
            {t(`localServers.cores.${server.config.core}`)}
          </p>
        </div>
        <span className={detail.headerMeta}><span className={server.status === "running" ? common.successBadge : server.status === "failed" ? common.errorBadge : common.badge}>{status}</span></span>
        <Button title={t(tab === "plugins" ? "serverWorkspace.openPluginsFolder" : tab === "console" ? "serverWorkspace.openLogsFolder" : "localServers.openFolder")} onClick={() => void action("folder")}>
          <FolderActionIcon size={17} />
          {t("common.folder")}
        </Button>
        <ServerLaunchButton server={server} busy={busy} onClick={() => void action(stoppedServer(server) ? "start" : "stop")} />
      </header>
      <ServerTabs view={view} current={tab} position={position} onChange={saveView} onSelect={key => setParams({ tab: key })} />
      <section
        className={`${detail.content} ${tab === "console" ? extra.consoleContent : ""}`}
        data-server-console={tab === "console" ? "true" : undefined}
      >
        {error ? (
          <p role="alert" className={styles.error}>
            <ErrorText message={error} />
          </p>
        ) : null}
        {tab === "overview" ? (
          <div className={`${detail.overview} ${extra.overview}`}>
            <ServerMetricsPanel server={server} />
            <section>
              <h2>{t("serverLibrary.overview")}</h2>
              <dl>
                {[
                  [
                    t("localServers.minecraftVersion"),
                    server.config.minecraftVersion,
                  ],
                  [
                    t("localServers.core"),
                    t(`localServers.cores.${server.config.core}`),
                  ],
                  [
                    t("serverWorkspace.address"),
                    `${server.config.properties["server-ip"] || "localhost"}:${server.config.properties["server-port"]}`,
                  ],
                  [
                    t("localServers.automaticJava"),
                    server.config.javaPath ?? t("localServers.automaticJava"),
                  ],
                  [
                    t("serverLive.memoryOverview"),
                    server.config.core === "horizon" ? t("serverLive.nativeMemory") : `${server.config.memoryMinMb}–${server.config.memoryMaxMb} MiB`,
                  ],
                  [t("localServers.folder"), server.path],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>
                      <bdi>{value}</bdi>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
            <section>
              <h2>{t("serverLibrary.diagnostics")}</h2>
              <div className={detail.health}>
                <p>{status}</p>
                {!serverReady(server) ? (
                  <>
                    <p>
                      {t(
                        server.presentation?.readiness === "missing"
                          ? "serverLibrary.missingHint"
                          : "serverLibrary.setupHint",
                      )}
                    </p>
                    {server.presentation?.note ? (
                      <ErrorText message={server.presentation.note} />
                    ) : null}
                  </>
                ) : null}
                {diagnostic ? <ErrorText message={diagnostic} /> : null}
                <div className={detail.healthActions}>
                  <Button onClick={() => setParams({ tab: "settings" })}>
                    <Wrench size={16} />
                    {t("navigation.settings")}
                  </Button>
                  <Button onClick={() => setParams({ tab: "console" })}>
                    <FileText size={16} />
                    {t("localServers.console")}
                  </Button>
                  {["running", "starting"].includes(server.status) ? (
                    <Button onClick={() => void action("restart")}>
                      {t("localServers.restart")}
                    </Button>
                  ) : null}
                  {!stoppedServer(server) ? (
                    <Button variant="danger" onClick={() => setConfirm("kill")}>
                      {t("localServers.forceStop")}
                    </Button>
                  ) : null}
                </div>
              </div>
            </section>
          </div>
        ) : tab === "console" ? (
          <ServerConsolePanel key={server.id} server={server} showStatus={false} />
        ) : tab === "plugins" ? (
          <ServerPluginsPanel key={server.id} server={server} />
        ) : draft ? (
          <SettingLayout><div className={extra.settings}>
            <fieldset
              className={styles.config}
              disabled={busy}
            >
              <ServerConfigFields
                server={server}
                onMemorySaved={next => {
                  ++configEpoch.current;
                  setServer(next);
                  setDraft(previous => previous ? { ...previous, config: { ...previous.config, memoryMinMb: next.config.memoryMinMb, memoryMaxMb: next.config.memoryMaxMb } } : previous);
                }}
                mode="tabs"
                value={draft.config}
                pinned={server.installed && server.config.core === "horizon"}
                onChange={(config) => {
                  ++configEpoch.current;
                  dirty.current = true;
                  setDraft({ ...draft, config });
                  setSaved(false);
                }}
              />
              {!draft.config.eulaAccepted ? (
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    disabled={!stoppedServer(server)}
                    checked={draft.config.eulaAccepted}
                    onChange={(e) => {
                      ++configEpoch.current; dirty.current = true; setSaved(false);
                      setDraft({
                        ...draft,
                        config: {
                          ...draft.config,
                          eulaAccepted: e.target.checked,
                        },
                      });
                    }}
                  />
                  {t("localServers.acceptEula")}
                </label>
              ) : null}
              <div className={styles.saveBar}>
                <Button disabled={busy} onClick={() => { if (dirty.current) setReloadConfirm(true); else void reloadConfig(); }}>{t("serverWorkspace.reloadSettings")}</Button>
                {saved ? (
                  <span role="status" className={styles.note}>
                    {t("localServers.saved")}
                  </span>
                ) : null}
                <Button
                  variant="primary"
                  busy={busy}
                  disabled={!stoppedServer(server) || coreChanged && (!draft.config.minecraftVersion || !draft.config.coreVersion || draft.config.core === "custom" && !draft.config.customJar)}
                  onClick={() => void save()}
                >
                  {t(coreChanged ? "serverTemplates.changeCore" : "common.save")}
                </Button>
              </div>
            </fieldset>
            {cardSection(
              t("serverLibrary.identity"),
              <>
                <SettingRow wide title={t("localServers.name")}>
                  <input
                    className={common.input}
                    disabled={!stoppedServer(server)}
                    value={draft.name}
                    onChange={(e) =>
                      (++configEpoch.current, dirty.current = true, setSaved(false), setDraft({ ...draft, name: e.target.value }))
                    }
                  />
                </SettingRow>
                <div className={identity.appearanceTools}><div className={identity.instanceColors}>{(["background","foreground"] as const).map(key=><label key={key}><span>{t(`serverLibrary.${key}`)}</span><ColorInput value={icon[key]??(key==="background"?defaultArtworkColors.background:defaultArtworkColors.foreground)} onChange={e=>setIcon({...icon,[key]:e.target.value})}/></label>)}</div><div className={identity.basicIcons}>{instanceIconChoices.slice(0,8).map(choice=><Button key={choice.key} aria-pressed={icon.key===choice.key} aria-label={t(`serverLibrary.icons.${choice.key}`)} onClick={()=>setIcon({...icon,key:choice.key})}><choice.Icon size={24}/></Button>)}</div><ArtworkEditor iconKey={icon.key??"server"} background={icon.background??defaultArtworkColors.background} foreground={icon.foreground??defaultArtworkColors.foreground} onChange={async(key,background,foreground)=>{const next={key,background,foreground};await command("save_server_artwork",{serverId,icon:next});setIcon(next);await load();}}/></div>
                <div className={styles.actions}>
                  <Button
                    variant="primary"
                    busy={busy}
                    onClick={() => void saveIcon()}
                  >
                    {t("serverLibrary.saveArtwork")}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setIcon({});
                      void command("save_server_artwork", {
                        serverId,
                        icon: {},
                      }).then(() => load());
                    }}
                  >
                    {t("serverLibrary.originalIcon")}
                  </Button>
                  <Button
                    disabled={!stoppedServer(server) || busy}
                    onClick={() => void chooseIcon()}
                  >
                    {t("serverWorkspace.changeIcon")}
                  </Button>
                </div>
              </>,
            )}
            {cardSection(
              t("serverWorkspace.scripts"),
              <div className={styles.actions}>
                <Button
                  disabled={
                    busy || !stoppedServer(server) || !serverReady(server)
                  }
                  onClick={() => void action("script")}
                >
                  {t("localServers.generateScript")}
                </Button>
                <Button
                  disabled={
                    busy || !stoppedServer(server) || !serverReady(server)
                  }
                  onClick={() => setConfirm("overwrite")}
                >
                  {t("localServers.replaceScript")}
                </Button>
              </div>,
            )}
            {cardSection(t("serverWorkspace.deleteServer"), <><p className={styles.note}>{t("serverWorkspace.deleteServerWarning", undefined, { name: server.name })}</p><Button variant="danger" disabled={busy || !stoppedServer(server)} onClick={() => setDeleting(true)}>{t("serverWorkspace.deleteServer")}</Button>{!stoppedServer(server) ? <p className={styles.note}>{t("serverWorkspace.stopToDelete")}</p> : null}</>)}
          </div></SettingLayout>
        ) : (
          <BusyIndicator />
        )}
      </section>
      <Dialog open={coreConfirm} title={t("serverTemplates.changeCore")} description={t("serverTemplates.changeCoreHint")} onClose={() => setCoreConfirm(false)} footer={<><Button onClick={() => setCoreConfirm(false)}>{t("common.cancel")}</Button><Button variant="primary" disabled={busy || !stoppedServer(server)} onClick={() => void save(true)}>{t("serverTemplates.changeCore")}</Button></>}>
        <p>{t(`localServers.cores.${server.config.core}`)} {server.config.minecraftVersion} → {t(`localServers.cores.${draft?.config.core ?? server.config.core}`)} {draft?.config.minecraftVersion}</p>
      </Dialog>
      {deleting ? <DeleteServerDialog server={server} onClose={() => setDeleting(false)} onDeleted={() => navigate("/local-servers")} /> : null}
      <Dialog open={reloadConfirm} title={t("serverWorkspace.reloadSettings")} description={t("serverWorkspace.reloadWarning")} onClose={() => setReloadConfirm(false)} footer={<><Button onClick={() => setReloadConfirm(false)}>{t("common.cancel")}</Button><Button variant="primary" onClick={() => void reloadConfig()}>{t("serverWorkspace.reloadSettings")}</Button></>}>{null}</Dialog>
      {confirm ? (
        <Dialog
          open
          title={t(
            confirm === "kill"
              ? "localServers.forceStop"
              : "localServers.replaceScript",
          )}
          description={t(
            confirm === "kill"
              ? "localServers.forceStopHint"
              : "localServers.replaceScriptHint",
          )}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>
                {t("common.close")}
              </Button>
              <Button
                variant="danger"
                busy={busy}
                onClick={() => void action(confirm)}
              >
                {t("localServers.confirm")}
              </Button>
            </>
          }
        >
          <p>{server.name}</p>
        </Dialog>
      ) : null}
    </DetailFrame>
  );
}
