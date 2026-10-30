import { ServerSidePanel } from "../../components/server/ServerSidePanel";
import { useServerStart } from "../../components/server/useServerStart";
import { moveBefore, normalizeServerTabs } from "../../lib/serverPresentation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useUiText } from "../../i18n/UiText";
import { useAppStore } from "../../stores/appStore";
import { useServerLibraryStore } from "../../stores/serverLibraryStore";
import { command } from "../../lib/tauri";
import {
  serverReady,
  stoppedServer,
  type LocalServer,
  type ServerCollection,
  type ServerLibraryView,
} from "../../lib/localServers";
import { useWindowActivity } from "../../lib/windowActivity";
import {
  LibraryFrame,
  LibraryToolbar,
  LibraryViews,
  LibraryCardSurface,
  LibraryGroupHeader,
} from "../../components/common/LibraryChrome";
import { ServerArtwork } from "../../components/server/ServerArtwork";
import { ServerProfileDialog } from "../../components/server/ServerProfileDialog";
import { Button, BusyIndicator } from "../../components/common/Controls";
import { Dialog } from "../../components/common/Dialog";
import { ErrorText } from "../../components/common/ErrorText";
import {
  ArrowRight,
  Info,
  Wrench,
  Pencil,
  Trash,
  X,
  Plus,
  FolderOpen,
  GearSix,
  DotsThreeVertical,
  Check,
  ArrowsClockwise,
} from "../../components/icons";
import common from "../../components/common/Common.module.css";
import styles from "../Library/LibraryPage.module.css";
import card from "../../components/instance/InstanceCard.module.css";
import extra from "./ServerLibrary.module.css";
import forms from "../../components/server/Servers.module.css";

type Menu = {
  x: number;
  y: number;
  server?: LocalServer;
  group?: ServerCollection;
};
type Drag = {
  id: string;
  kind: "server" | "group";
  x: number;
  y: number;
  active: boolean;
  node: HTMLElement;
  pointerId: number;
};
export function LocalServersPage() {
  const t = useUiText();
  const { startServer, recoveryDialog } = useServerStart();
  const navigate = useNavigate();
  const active = useWindowActivity();
  const bootstrap = useAppStore((s) => s.bootstrap);
  const data = useServerLibraryStore(s => s.data);
  const [view, setView] = useState<ServerLibraryView>(() => ({
    view: "grid",
    sort: "manual",
    collection: "",
    ...data?.view,
  }));
  const viewWrites = useRef(Promise.resolve());
  const viewRef = useRef(view);
  viewRef.current = view;
  const search = useServerLibraryStore(s => s.search);
  const setSearch = useServerLibraryStore(s => s.setSearch);
  const [selected, setSelected] = useState<string | null>(() => data?.view?.selected || null);
  const [panelSelection, setPanelSelection] = useState<string | null>(() => data?.view?.selected || null);
  useEffect(() => {
    // Keep the clicked card in place until a possible double click completes.
    // Selection feedback is immediate; only the panel's layout change waits.
    const timer = window.setTimeout(() => setPanelSelection(selected), 250);
    return () => window.clearTimeout(timer);
  }, [selected]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [groupDialog, setGroupDialog] = useState<{
    action: "create" | "rename" | "delete";
    group?: ServerCollection;
  } | null>(null);
  const [groupName, setGroupName] = useState("");
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const node = menuRef.current;
    const place = () => {
      const { width, height } = node.getBoundingClientRect();
      node.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - width - 8))}px`;
      node.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - height - 8))}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [menu]);
  const [confirm, setConfirm] = useState<LocalServer | null>(null);
  const initialized = useRef(Boolean(data));
  const drag = useRef<Drag | null>(null);
  const suppress = useRef(false);
  const [dragPreview, setDragPreview] = useState<{
    name: string;
    x: number;
    y: number;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dropAfter, setDropAfter] = useState(false);
  useLayoutEffect(() => {
    if (data && !initialized.current) {
      initialized.current = true;
      setView({ view: "grid", sort: "manual", collection: "", ...data.view });
      setSelected(data.view?.selected || null);
      setPanelSelection(data.view?.selected || null);
    }
  }, [data]);
  const load = useCallback(
    async (sync = false, directory?: string) => {
      try {
        const store = useServerLibraryStore.getState();
        const value = await (sync ? store.synchronize(directory) : store.refresh());
        if (value.issues?.length) setError(value.issues.join("\n"));
      } catch (reason) {
        setError(String((reason as Error).message ?? reason));
        if (sync)
          try {
            await useServerLibraryStore.getState().refresh();
          } catch {
            /* Keep the original error. */
          }
      }
    },
    [],
  );
  useEffect(() => {
    void load();
    void useServerLibraryStore.getState().scanIfStale().catch(() => undefined);
  }, [load]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), 2500);
    return () => clearInterval(timer);
  }, [load, active]);
  const persist = useCallback((patch: Partial<ServerLibraryView>) => {
    const value = { ...viewRef.current, ...patch };
    viewRef.current = value;
    setView(value);
    viewWrites.current = useServerLibraryStore.getState().saveView(value).catch(reason => { setError(String(reason.message ?? reason)); });
  }, []);
  const groups = data?.collections ?? [];
  const all = data?.servers ?? [];
  const current = groups.find((g) => g.id === view.collection);
  const chosen = all.find((s) => s.id === panelSelection);
  const mode = view.view ?? "grid";
  const open = (s: LocalServer, tab = "overview") =>
    navigate(`/local-servers/${s.id}?tab=${tab}`);
  const state = (s: LocalServer) =>
    !serverReady(s)
      ? t(
          `serverLibrary.${s.presentation?.readiness === "missing" ? "missing" : "needsSetup"}`,
        )
      : t(`localServers.states.${s.status}`);
  const groupOf = (s: LocalServer) =>
    s.presentation?.collectionId ??
    (!s.presentation?.manualGroup &&
    data &&
    !s.path
      .split("\\")
      .join("/")
      .toLowerCase()
      .startsWith(
        data.directory.split("\\").join("/").replace(/\/$/, "").toLowerCase() +
          "/",
      )
      ? "other"
      : null);
  const select = (s: LocalServer) => {
    if (suppress.current) {
      suppress.current = false;
      return;
    }
    setSelected(s.id);
    persist({ selected: s.id });
  };
  const action = async (s: LocalServer, operation: string) => {
    setBusy(true);
    setError("");
    try {
      if (operation === "start") {
        if (!await startServer(s)) return;
        if (s.config.console === "builtin") {
          const { visible } = normalizeServerTabs(viewRef.current);
          if (!visible.includes("console")) {
            persist({ visibleTabs: [...visible, "console"] });
            await viewWrites.current;
          }
          open(s, "console");
        }
        if (s.config.console === "external")
          await command("open_local_server_console", { serverId: s.id });
      } else if (operation === "folder")
        await command("open_local_server_folder", { serverId: s.id });
      else
        await command("control_local_server", {
          serverId: s.id,
          action: operation,
        });
      await load();
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    } finally {
      setBusy(false);
    }
  };
  const organize = useCallback(
    async (
      id: string,
      collection: string | null,
      before: string | null = null,
    ) => {
      try {
        await command("organize_server_library", {
          serverId: id,
          collectionId: collection,
          before,
        });
        persist({ sort: "manual" });
        await load();
      } catch (reason) {
        setError(String((reason as Error).message ?? reason));
      }
    },
    [persist, load],
  );
  const begin = (
    event: ReactPointerEvent<HTMLElement>,
    id: string,
    kind: "server" | "group",
  ) => {
    if (
      event.button !== 0 ||
      (event.target as HTMLElement).closest("button,input,select,summary,a")
    )
      return;
    if (kind === "server" && all.find(server => server.id === id)?.status === "installing") return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    suppress.current = false;
    drag.current = {
      id,
      kind,
      x: event.clientX,
      y: event.clientY,
      active: false,
      node: event.currentTarget,
      pointerId: event.pointerId,
    };
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const value = drag.current;
      if (!value) return;
      if (
        !value.active &&
        Math.hypot(e.clientX - value.x, e.clientY - value.y) < 8
      )
        return;
      value.active = true;
      const label =
        value.kind === "server"
          ? all.find((s) => s.id === value.id)?.name
          : groups.find((g) => g.id === value.id)?.name;
      setDragPreview({
        name: label ?? "",
        x: e.clientX + 12,
        y: e.clientY + 12,
      });
      const scroll = document.querySelector<HTMLElement>(
        "[data-library-scroll]",
      );
      if (scroll) {
        const r = scroll.getBoundingClientRect();
        if (e.clientY > r.bottom - 48) scroll.scrollTop += 24;
        else if (e.clientY < r.top + 48) scroll.scrollTop -= 24;
      }
      const target = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>("[data-server-card],[data-server-group]");
      const rect = target?.getBoundingClientRect();
      setDropAfter(Boolean(rect && (mode === "list" || !target?.dataset.serverCard ? e.clientY > rect.y + rect.height / 2 : e.clientX > rect.x + rect.width / 2)));
      setDropTarget(
        target?.dataset.serverCard ?? target?.dataset.serverGroup ?? null,
      );
    };
    const finish = (e: PointerEvent) => {
      const value = drag.current;
      drag.current = null;
      if (value?.node.hasPointerCapture(value.pointerId)) value.node.releasePointerCapture(value.pointerId);
      setDragPreview(null);
      setDropTarget(null);
      if (!value?.active) return;
      suppress.current = true;
      window.setTimeout(() => { suppress.current = false; }, 0);
      const target = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>("[data-server-card],[data-server-group]");
      if (!target) return;
      if (value.kind === "server") {
        const s = all.find((s) => s.id === target.dataset.serverCard);
        const group = s ? groupOf(s) : target.dataset.serverGroup;
        if (group === "other" || s?.id === value.id) return;
        const rect = target.getBoundingClientRect();
        const after = mode === "list" ? e.clientY > rect.y + rect.height / 2 : e.clientX > rect.x + rect.width / 2;
        const siblings = sorted(all.filter(item => groupOf(item) === (group || null) && item.id !== value.id));
        const before = s && after ? siblings[siblings.findIndex(item => item.id === s.id) + 1]?.id ?? null : s?.id ?? null;
        void organize(value.id, group || null, before);
      } else {
        const targetGroup = target.dataset.serverGroup;
        if (!targetGroup || targetGroup === value.id) return;
        const source = groups.find((g) => g.id === value.id);
        const dest = groups.find((g) => g.id === targetGroup);
        if (!source || !dest || source.parentId !== dest.parentId) return;
        const rect = target.getBoundingClientRect();
        const ids = moveBefore(groups.map(g => g.id), value.id, targetGroup, e.clientY > rect.y + rect.height / 2);
        void command("reorder_server_collections", { ids })
          .then(() => load())
          .catch((reason) => setError(String(reason.message ?? reason)));
      }
    };
    const cancel = () => {
      const value = drag.current;
      if (value?.node.hasPointerCapture(value.pointerId)) value.node.releasePointerCapture(value.pointerId);
      suppress.current = false;
      drag.current = null;
      setDragPreview(null);
      setDropTarget(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, [all, groups, organize, load, data, mode, view.sort]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  }, [menu]);
  const context = (
    event: { preventDefault: () => void; clientX: number; clientY: number },
    details: Partial<Menu>,
  ) => {
    event.preventDefault();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      ...details,
    });
  };
  const sorted = (list: LocalServer[]) =>
    [...list].sort((a, b) =>
      view.sort === "name"
        ? a.name.localeCompare(b.name)
        : view.sort === "version"
          ? b.config.minecraftVersion.localeCompare(
              a.config.minecraftVersion,
              undefined,
              { numeric: true },
            )
          : view.sort === "running"
            ? Number(stoppedServer(a)) - Number(stoppedServer(b)) ||
              a.name.localeCompare(b.name)
            : view.sort === "recent"
              ? b.createdAt.localeCompare(a.createdAt)
              : (a.presentation?.sortOrder ?? 0) -
                (b.presentation?.sortOrder ?? 0),
    );
  const matching = all.filter((s) =>
    `${s.name} ${s.config.core} ${s.config.minecraftVersion}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase()),
  );
  const visibleGroups = search
    ? groups.filter(
        (g) =>
          g.id !== current?.id && matching.some((s) => groupOf(s) === g.id),
      )
    : groups.filter((g) => g.parentId === (view.collection || null));
  const renderServer = (s: LocalServer) => (
    <LibraryCardSurface
      key={s.id}
      view={mode}
      selected={selected === s.id}
      role="button"
      aria-pressed={selected === s.id}
      aria-label={s.name}
      title={s.name}
      tabIndex={0}
      data-server-card={s.id}
      data-insert-position={dropTarget === s.id ? dropAfter ? "after" : "before" : undefined}
      className={mode === "list" ? extra.serverList : mode === "icons" ? extra.serverIconCard : extra.serverCard}
      onPointerDown={(e) => begin(e, s.id, "server")}
      onClick={(event) => { if (!(event.target as HTMLElement).closest("button")) select(s); }}
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        if (!suppress.current) open(s);
      }}
      onContextMenu={(e) => context(e, { server: s })}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select(s);
        }
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          const r = e.currentTarget.getBoundingClientRect();
          context(
            {
              preventDefault: () => e.preventDefault(),
              clientX: r.x,
              clientY: r.bottom,
            },
            { server: s },
          );
        }
      }}
    >
      <ServerArtwork
        id={s.id}
        presentation={s.presentation}
        size={mode === "list" ? "small" : mode === "icons" ? "icon" : "card"}
      />
      <span className={mode === "list" ? card.name : card.cardBody}>
        <strong data-minimal-title>
          <bdi>{s.name}</bdi>
        </strong>
        {mode !== "list" ? (
          <small>
            {s.config.minecraftVersion || t("serverLibrary.needsSetup")} ·{" "}
            {t(`localServers.cores.${s.config.core}`)}
          </small>
        ) : null}
      </span>
      {mode === "list" ? (
        <>
          <span>{s.config.minecraftVersion}</span>
          <span>{t(`localServers.cores.${s.config.core}`)}</span>
          <span>
            {groups.find((g) => g.id === s.presentation?.collectionId)?.name ??
              t("library.ungrouped")}
          </span>
        </>
      ) : null}
      {s.status !== "stopped" || mode === "list" ? (
        <span className={`${mode === "grid" ? extra.cardStatus : extra.listStatus} ${s.status === "failed" ? extra.failedStatus : s.status === "running" ? extra.runningStatus : ""}`}>
          {s.status === "stopped" ? null : <><Info size={13} /><span>{state(s)}</span></>}
        </span>
      ) : null}
      {selected === s.id ? (
        <span className={mode === "list" ? card.check : card.selection}>
          <Check size={12} />
        </span>
      ) : null}
      <Button
        className={`${card.actionMenu} ${extra.cardMenu}`}
        variant="ghost"
        aria-label={t("installation.actionsNamed", undefined, { name: s.name })}
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          context({ preventDefault: () => e.preventDefault(), clientX: rect.right, clientY: rect.bottom + 5 }, { server: s });
        }}
      >
        <DotsThreeVertical size={17} />
      </Button>
    </LibraryCardSurface>
  );
  const renderSection = (
    id: string | null,
    name: string,
    list: LocalServer[],
    group?: ServerCollection,
  ) => (
    <section
      key={id ?? "root"}
      className={`${styles.group} ${dropTarget === (id ?? "") ? styles.dropTarget : ""}`}
      data-server-group={id ?? ""}
    >
      <LibraryGroupHeader
        className={drag.current?.kind === "group" && dropTarget === id ? dropAfter ? styles.groupInsertAfter : styles.groupInsertBefore : ""}
        data-server-group={id ?? ""}
        onPointerDown={group ? (e) => begin(e, group.id, "group") : undefined}
        onDoubleClick={() => group && persist({ collection: group.id })}
        onContextMenu={group ? (e) => context(e, { group }) : undefined}
      >
        <button
          type="button"
          aria-expanded={
            !(group?.collapsed ?? view.collapsedGroups?.includes(id ?? "root"))
          }
          aria-label={t("serverLibrary.toggleGroup", undefined, { name })}
          onClick={() => {
            if (group)
              void command("edit_server_collection", {
                action: "collapse",
                id: group.id,
                name: null,
                parent: null,
              }).then(() => load());
            else {
              const key = id ?? "root";
              const collapsed = view.collapsedGroups ?? [];
              persist({
                collapsedGroups: collapsed.includes(key)
                  ? collapsed.filter((v) => v !== key)
                  : [...collapsed, key],
              });
            }
          }}
        >
          <ArrowRight
            size={15}
            className={
              (group?.collapsed ?? view.collapsedGroups?.includes(id ?? "root"))
                ? styles.collapsedArrow
                : styles.expandedArrow
            }
          />
        </button>
        <h2 data-minimal-title>
          <bdi>{name}</bdi>
        </h2>
        <span>{list.length}</span>
        {group ? (
          <>
            <Button
              variant="ghost"
              onClick={() => persist({ collection: group.id })}
              aria-label={t("serverLibrary.openGroup", undefined, { name })}
            >
              <FolderOpen size={16} />
            </Button>
            <Button
              variant="ghost"
              aria-label={t("serverWorkspace.more")}
              onClick={(e) => context(e, { group })}
            >
              <DotsThreeVertical size={16} />
            </Button>
          </>
        ) : null}
      </LibraryGroupHeader>
      {!(group?.collapsed ?? view.collapsedGroups?.includes(id ?? "root")) ? (
        <div
          className={
            mode === "icons"
              ? styles.iconsGrid
              : mode === "list"
                ? styles.list
                : styles.grid
          }
        >
          {list.length ? (
            sorted(list).map(renderServer)
          ) : (
            <p className={styles.emptyGroup}>{t("serverLibrary.emptyGroup")}</p>
          )}
        </div>
      ) : null}
    </section>
  );
  const chooseRoot = async () => {
    try {
      const path = await openDialog({ directory: true, multiple: false });
      if (typeof path !== "string") return;
      setBusy(true);
      setError("");
      await load(true, path);
      persist({ collection: "" });
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    } finally {
      setBusy(false);
    }
  };
  const saveGroup = async () => {
    if (!groupDialog) return;
    setBusy(true);
    try {
      await command("edit_server_collection", {
        action: groupDialog.action,
        id: groupDialog.group?.id ?? null,
        name: groupName,
        parent: current?.id ?? null,
      });
      if (
        groupDialog.action === "delete" &&
        view.collection === groupDialog.group?.id
      )
        persist({ collection: groupDialog.group?.parentId ?? "" });
      setGroupDialog(null);
      await load();
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    } finally {
      setBusy(false);
    }
  };
  const panelPosition =
    view.panelPosition ??
    bootstrap?.settings.general.instancePanelPosition ??
    "right";
  return (
    <LibraryFrame
      data-server-library
      className={
        chosen
          ? `${styles.withPanel} ${panelPosition === "left" ? styles.panelLeft : styles.panelRight}`
          : ""
      }
    >
      {recoveryDialog}
      <section className={styles.library}>
        <div className={styles.pageHeader}>
          <div>
            <p className={styles.eyebrow}>{t("navigation.localServers")}</p>
            <h1>{t("serverLibrary.heading")}</h1>
            <span>
              {t("localServers.counts", undefined, {
                total: all.length,
                running: all.filter((s) => s.status === "running").length,
              })}
            </span>
          </div>
          <LibraryToolbar>
            <Button
              variant="ghost"
              onClick={() => {
                setGroupName("");
                setGroupDialog({ action: "create" });
              }}
            >
              <Plus size={16} />
              {t("library.group")}
            </Button>

            <Button
              variant="ghost"
              onClick={() => navigate("/settings/servers")}
            >
              <GearSix size={16} />
              {t("settings.servers")}
            </Button>
            <Button
              variant="primary"
              disabled={!data || busy}
              onClick={() => setCreating(true)}
            >
              <Plus size={16} />
              {t("localServers.createServer")}
            </Button>
            <LibraryViews value={mode} onChange={(view) => persist({ view })} />
          </LibraryToolbar>
        </div>
        <div
          data-library-scroll
          className={`${styles.scrollArea} ${extra.scrollArea}`}
        >
          <div className={extra.controls}>
            <Button disabled={busy} onClick={() => void chooseRoot()}><FolderOpen size={16} />{t("serverLibrary.chooseRoot")}</Button>
            <input
              className={common.input}
              aria-label={t("localServers.search")}
              placeholder={t("localServers.search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className={common.select}
              aria-label={t("serverWorkspace.sort")}
              value={view.sort ?? "manual"}
              onChange={(e) => persist({ sort: e.target.value })}
            >
              {["manual", "name", "recent", "version", "running"].map((key) => (
                <option value={key} key={key}>
                  {t(
                    key === "manual"
                      ? "serverLibrary.manual"
                      : `serverWorkspace.sorts.${key}`,
                  )}
                </option>
              ))}
            </select>
            <Button
              busy={busy}
              aria-label={t("serverWorkspace.refresh")}
              onClick={() => {
                setBusy(true);
                void load(true).finally(() => setBusy(false));
              }}
            >
              <ArrowsClockwise size={18} />
            </Button>
          </div>
          <div className={extra.breadcrumb}>
            <Button variant="ghost" onClick={() => persist({ collection: "" })}>
              <FolderOpen size={15} />
              {t("serverLibrary.root")}
            </Button>
            {(() => {
              const chain: ServerCollection[] = [];
              let g = current;
              const visited = new Set<string>();
              while (g && !visited.has(g.id)) {
                chain.unshift(g);
                visited.add(g.id);
                g = groups.find((p) => p.id === g!.parentId);
              }
              return chain.map((g) => (
                <Button
                  variant="ghost"
                  key={g.id}
                  onClick={() => persist({ collection: g.id })}
                >
                  <ArrowRight size={13} />
                  {g.name}
                </Button>
              ));
            })()}
            <span className={extra.rootPath}>
              <bdi>{data?.directory}</bdi>
            </span>
          </div>
          {error ? (
            <p role="alert" className={forms.error}>
              <ErrorText message={error} />
            </p>
          ) : null}
          {!data ? (
            <BusyIndicator size={28} />
          ) : (
            <>
              {renderSection(
                current?.id ?? null,
                current?.name ?? t("library.ungrouped"),
                matching.filter((s) => groupOf(s) === (current?.id ?? null)),
              )}
              {visibleGroups.map((g) =>
                renderSection(
                  g.id,
                  g.name,
                  matching.filter((s) => groupOf(s) === g.id),
                  g,
                ),
              )}
              {!current && matching.some((s) => groupOf(s) === "other")
                ? renderSection(
                    "other",
                    t("serverLibrary.otherLocations"),
                    matching.filter((s) => groupOf(s) === "other"),
                  )
                : null}
            </>
          )}
        </div>
      </section>
      {chosen ? (
        <div className={styles.panelSlot}>
          <ServerSidePanel key={chosen.id} server={chosen} view={view} groups={groups} busy={busy} status={state(chosen)} onChange={persist} onOpen={tab => open(chosen, tab)} onAction={operation => void action(chosen, operation)} onGroup={id => void organize(chosen.id, id)} onDeleted={() => { setSelected(null); persist({ selected: "" }); void load(true); }} />
        </div>
      ) : null}
      {dragPreview ? (
        <div
          className={styles.dragPreview}
          style={{ left: dragPreview.x, top: dragPreview.y }}
          aria-hidden="true"
        >
          {dragPreview.name}
        </div>
      ) : null}
      {menu ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={menu.server?.name ?? menu.group?.name}
          className={`${card.actionPopup} ${extra.cardContextMenu}`}
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
          data-slh-context-menu="true"
        >
            {menu.server ? (
              <>
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    open(menu.server!);
                    setMenu(null);
                  }}
                >
                  <Info size={16} /> {t("serverLibrary.overview")}
                </button>
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    open(menu.server!, "settings");
                    setMenu(null);
                  }}
                >
                  <Wrench size={16} /> {t("navigation.settings")}
                </button>
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    void action(menu.server!, "folder");
                    setMenu(null);
                  }}
                >
                  <FolderOpen size={16} /> {t("localServers.openFolder")}
                </button>
                {!stoppedServer(menu.server) ? (
                  <button
                  role="menuitem"
                    type="button"
                    onClick={() => {
                      setConfirm(menu.server!);
                      setMenu(null);
                    }}
                  >
                    <X size={16} /> {t("localServers.forceStop")}
                  </button>
                ) : null}
              </>
            ) : null}
            {menu.group ? (
              <>
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    persist({ collection: menu.group!.id });
                    setMenu(null);
                  }}
                >
                  <FolderOpen size={16} /> {t("serverLibrary.openGroup", undefined, {
                    name: menu.group.name,
                  })}
                </button>
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setGroupName(menu.group!.name);
                    setGroupDialog({ action: "rename", group: menu.group });
                    setMenu(null);
                  }}
                >
                  <Pencil size={16} /> {t("localServers.renameFolder")}
                </button>
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setGroupDialog({ action: "delete", group: menu.group });
                    setMenu(null);
                  }}
                >
                  <Trash size={16} /> {t("serverLibrary.deleteGroup")}
                </button>
                {menu.group.sourcePath ? (
                  <button
                  role="menuitem"
                    type="button"
                    onClick={() => {
                      void command("open_server_collection_folder", {
                        id: menu.group!.id,
                      }).catch((reason) =>
                        setError(String(reason.message ?? reason)),
                      );
                      setMenu(null);
                    }}
                  >
                    <FolderOpen size={16} /> {t("localServers.openFolder")}
                  </button>
                ) : null}
              </>
            ) : null}
        </div>, document.body
      ) : null}
      {groupDialog ? (
        <Dialog
          open
          title={t(
            groupDialog.action === "delete"
              ? "serverLibrary.deleteGroup"
              : groupDialog.action === "rename"
                ? "localServers.renameFolder"
                : "localServers.createFolder",
          )}
          description={
            groupDialog.action === "delete"
              ? t("serverLibrary.deleteGroupHint")
              : undefined
          }
          onClose={() => setGroupDialog(null)}
          footer={
            <>
              <Button onClick={() => setGroupDialog(null)}>
                {t("common.close")}
              </Button>
              <Button
                variant={groupDialog.action === "delete" ? "danger" : "primary"}
                busy={busy}
                disabled={groupDialog.action !== "delete" && !groupName.trim()}
                onClick={() => void saveGroup()}
              >
                {t(
                  groupDialog.action === "delete"
                    ? "serverLibrary.deleteGroup"
                    : "common.save",
                )}
              </Button>
            </>
          }
        >
          <label className={forms.field}>
            <span>{t("localServers.name")}</span>
            {groupDialog.action === "delete" ? (
              <strong>{groupDialog.group?.name}</strong>
            ) : (
              <input
                className={common.input}
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
              />
            )}
          </label>
        </Dialog>
      ) : null}
      {data && creating ? (
        <ServerProfileDialog
          overview={data}
          groupId={null}
          collectionId={current?.id ?? null}
          onClose={() => setCreating(false)}
          onChanged={() => void load()}
        />
      ) : null}
      {confirm ? (
        <Dialog
          open
          title={t("localServers.forceStop")}
          description={t("localServers.forceStopHint")}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>
                {t("common.close")}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  void action(confirm, "kill");
                  setConfirm(null);
                }}
              >
                {t("localServers.confirm")}
              </Button>
            </>
          }
        >
          <p>{confirm.name}</p>
        </Dialog>
      ) : null}
    </LibraryFrame>
  );
}
