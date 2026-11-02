import { useI18n } from "../../i18n/I18nProvider";
import { useState } from "react";
import { ActionVisibilityMenu } from "../common/ActionVisibilityMenu";
import { LibrarySidePanelSurface } from "../common/LibraryChrome";
import { Dialog } from "../common/Dialog";
import { ServerArtwork } from "./ServerArtwork";
import { ServerLaunchButton } from "./ServerLaunchButton";
import { DeleteServerDialog } from "./DeleteServerDialog";
import { Info, PuzzlePiece, FileText, FolderOpen, Wrench, Stack, Trash, Image } from "../icons";
import { useUiText } from "../../i18n/UiText";
import { serverReady, stoppedServer, type LocalServer, type ServerCollection, type ServerLibraryView } from "../../lib/localServers";
import panel from "../instance/InstanceSidePanel.module.css";
import common from "../common/Common.module.css";

const actions = [ "plugins", "folder", "console", "settings", "group", "delete"];
const icons = { plugins: PuzzlePiece, folder: FolderOpen, console: FileText, settings: Wrench, group: Stack, delete: Trash };
const labels = { plugins: "serverWorkspace.plugins", folder: "common.folder", console: "localServers.console", settings: "navigation.settings", group: "library.group", delete: "serverWorkspace.deleteServer" };
export function ServerSidePanel({ server, view, groups, busy, status, onChange, onOpen, onAction, onGroup, onDeleted }: {
  server: LocalServer; view: ServerLibraryView; groups: ServerCollection[]; busy: boolean; status: string;
  onChange: (patch: Partial<ServerLibraryView>) => void; onOpen: (tab?: string) => void; onAction: (action: string) => void;
  onGroup: (id: string | null) => void; onDeleted: () => void;
}) {
  const t = useUiText();
  const { locale } = useI18n();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const options = view.panel ?? {};
  const order = [...new Set([...(options.actionOrder ?? actions), ...actions])].filter(id => actions.includes(id));
  const hidden = options.hiddenActions ?? [];
  const patchPanel = (patch: NonNullable<ServerLibraryView["panel"]>) => onChange({ panel: { ...options, ...patch } });
  const run = (id: string) => {
    if (id === "folder") onAction("folder");
    else if (id === "group") setGroupOpen(true);
    else if (id === "delete") setDeleting(true);
    else onOpen(id);
  };
  return <LibrarySidePanelSurface data-slh-context-menu="true" onContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); }}
    onKeyDown={event => { if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") { event.preventDefault(); const rect = (event.target as HTMLElement).getBoundingClientRect(); setMenu({ x: rect.x, y: rect.bottom }); } }}>
    <div className={panel.scroll}>
      {options.showArtwork !== false ? <ServerArtwork id={server.id} presentation={server.presentation} size="large" /> : null}
      <div className={panel.identity}><h2><bdi>{server.name}</bdi></h2><p data-minimal-text>{t("settings.minecraft")} {server.config.minecraftVersion} · {t(`localServers.cores.${server.config.core}`)}</p></div>
      <ServerLaunchButton server={server} busy={busy} onClick={() => onAction(stoppedServer(server) ? "start" : "stop")} />
      {!serverReady(server) ? <p>{t(server.presentation?.readiness === "missing" ? "serverLibrary.missingHint" : "serverLibrary.setupHint")}</p> : null}
      <div className={panel.quickGrid}>{order.filter(id => !hidden.includes(id)).map(id => {
        const key = id as keyof typeof icons; const Icon = icons[key];
        return <span key={id}><button type="button" data-minimal-compact aria-label={t(labels[key])} className={id === "delete" ? panel.deleteAction : undefined} disabled={busy || id === "delete" && !stoppedServer(server)} onClick={() => run(id)}><Icon size={19} /><span data-minimal-text>{t(labels[key])}</span></button></span>;
      })}</div>
      {options.showMetadata !== false ? <div className={panel.metadata}>
        <div><span>{t("installation.texts.status")}</span><span className={server.status === "running" ? common.successBadge : server.status === "failed" ? common.errorBadge : common.badge}>{status}</span></div>
        <div><span>{t("installation.texts.memory")}</span><strong>{server.config.core === "horizon" ? t("serverLive.nativeMemory") : `${new Intl.NumberFormat(locale).format(server.config.memoryMaxMb / 1024)} ${t("installation.texts.gb")}`}</strong></div>
        <div><span>{t("localServers.core")}</span><strong>{t(`localServers.cores.${server.config.core}`)}</strong></div>
        <div><span>{t("library.group")}</span><strong>{groups.find(group => group.id === server.presentation?.collectionId)?.name ?? t("library.ungrouped")}</strong></div>
      </div> : null}
    </div>
    {menu ? <ActionVisibilityMenu variant="panel" at={menu} title={t("serverLibrary.serverPanel")} items={[
      { id: "artwork", label: t("library.texts.iconArtwork"), Icon: Image, checked: options.showArtwork !== false },
      { id: "metadata", label: t("library.texts.information"), Icon: Info, checked: options.showMetadata !== false },
      ...order.map((id, index) => ({ id, label: t(labels[id as keyof typeof labels]), Icon: icons[id as keyof typeof icons], checked: !hidden.includes(id), reorderable: true, separator: index === 0 })),
    ]} onClose={() => setMenu(null)} onReorder={actionOrder => patchPanel({ actionOrder })} onToggle={id => {
      if (id === "artwork") patchPanel({ showArtwork: options.showArtwork === false });
      else if (id === "metadata") patchPanel({ showMetadata: options.showMetadata === false });
      else patchPanel({ hiddenActions: hidden.includes(id) ? hidden.filter(key => key !== id) : [...hidden, id] });
    }} /> : null}
    <Dialog open={groupOpen} title={t("installation.texts.assignGroup")} onClose={() => setGroupOpen(false)} width="small" footer={<button type="button" className={common.secondaryButton} onClick={() => setGroupOpen(false)}>{t("common.close")}</button>}><div className={panel.groupDialog}>
      <button type="button" className={!server.presentation?.collectionId ? common.button : common.secondaryButton} onClick={() => { onGroup(null); setGroupOpen(false); }}>{t("library.ungrouped")}</button>
      {groups.map(group => <button key={group.id} type="button" className={server.presentation?.collectionId === group.id ? common.button : common.secondaryButton} onClick={() => { onGroup(group.id); setGroupOpen(false); }}>{group.name}</button>)}
    </div></Dialog>
    {deleting ? <DeleteServerDialog server={server} onClose={() => setDeleting(false)} onDeleted={() => { setDeleting(false); onDeleted(); }} /> : null}
  </LibrarySidePanelSurface>;
}
