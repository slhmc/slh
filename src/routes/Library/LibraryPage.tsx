import {
  ArrowRight,
  Check,
  Export,
  FileText,
  FolderOpen,
  Funnel,
  Image,
  Info,
  ListBullets,
  Plus,
  PuzzlePiece,
  SquaresFour,
  Stack,
  Trash,
  Worlds,
  Wrench,
  X,
} from "../../components/icons";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Instance, InstanceGroup } from "../../lib/types";
import { command, revealInstancePath } from "../../lib/tauri";
import { useAppStore } from "../../stores/appStore";
import { versionNotification } from "../../lib/versionNotifications";
import common from "../../components/common/Common.module.css";
import { InstanceCard } from "../../components/instance/InstanceCard";
import { InstanceSidePanel } from "../../components/instance/InstanceSidePanel";
import { BrandLogo } from "../../components/brand/BrandLogo";
import { Dialog } from "../../components/common/Dialog";
import { useI18n } from "../../i18n/I18nProvider";
import styles from "./LibraryPage.module.css";
import menuStyles from "../../components/shell/NavigationContextMenu.module.css";

const panelActionLabels: Array<[string, string]> = [
  ["mods", "Mods"], ["resourcepacks", "Resource packs"], ["worlds", "Worlds"], ["screenshots", "Screenshots"],
  ["folder", "Folder"], ["logs", "Logs"], ["settings", "Settings"],
  ["group", "Group"], ["export", "Export"], ["delete", "Delete instance"],
];

function panelActionIcon(id: string) {
  switch (id) {
    case "mods": return <PuzzlePiece size={16} />;
    case "resourcepacks": return <Stack size={16} />;
    case "worlds": return <Worlds size={16} />;
    case "screenshots": return <Image size={16} />;
    case "folder": return <FolderOpen size={16} />;
    case "logs": return <FileText size={16} />;
    case "settings": return <Wrench size={16} />;
    case "group": return <Stack size={16} />;
    case "export": return <Export size={16} />;
    case "delete": return <Trash size={16} />;
    default: return <Info size={16} />;
  }
}

type ContextMenu =
  | { kind: "group"; group: InstanceGroup; x: number; y: number }
  | { kind: "ungrouped"; x: number; y: number }
  | { kind: "instance"; x: number; y: number };
type ContextMenuInput =
  | { kind: "group"; group: InstanceGroup }
  | { kind: "ungrouped" }
  | { kind: "instance" };

export function LibraryPage() {
  const { t, tr } = useI18n();
  const bootstrap = useAppStore((state) => state.bootstrap);
  const selectedId = useAppStore((state) => state.selectedInstanceId);
  const select = useAppStore((state) => state.selectInstance);
  const search = useAppStore((state) => state.search);
  const viewMode = useAppStore((state) => state.viewMode);
  const setViewMode = useAppStore((state) => state.setViewMode);
  const setWizardOpen = useAppStore((state) => state.setCreateWizardOpen);
  const pushToast = useAppStore((state) => state.pushToast);
  const refresh = useAppStore((state) => state.refresh);
  const activities = useAppStore((state) => state.activities);
  const navigate = useNavigate();
  const [groupName, setGroupName] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [draggedInstanceId, setDraggedInstanceId] = useState<string | null>(null);
  const draggedInstanceRef = useRef<string | null>(null);
  const pointerDragRef = useRef<{ instanceId: string; startX: number; startY: number; dragging: boolean } | null>(null);
  const [dropGroupId, setDropGroupId] = useState<string | null | undefined>(undefined);
  const [dragPreview, setDragPreview] = useState<{ instance: Instance; x: number; y: number } | null>(null);
  const [draggedGroupId, setDraggedGroupId] = useState<string | null>(null);
  const [groupReorderTarget, setGroupReorderTarget] = useState<{ id: string; after: boolean } | null>(null);
  const groupPointerDragRef = useRef<{ groupId: string; label: string; startX: number; startY: number; dragging: boolean } | null>(null);
  const panelActionPointerDragRef = useRef<{ actionId: string; label: string; startX: number; startY: number; dragging: boolean } | null>(null);
  const [groupDragPreview, setGroupDragPreview] = useState<{ label: string; x: number; y: number } | null>(null);
  const [panelActionDragPreview, setPanelActionDragPreview] = useState<{ label: string; x: number; y: number } | null>(null);
  const [panelActionReorderTarget, setPanelActionReorderTarget] = useState<{ id: string; after: boolean } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuMoveRef = useRef<{ lastX: number; lastY: number } | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<InstanceGroup | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingInstanceId, setDeletingInstanceId] = useState<string | null>(null);
  const [ungroupedHidden, setUngroupedHidden] = useState(false);
  const [ungroupedCollapsed, setUngroupedCollapsed] = useState(false);
  const [ungroupedPosition, setUngroupedPosition] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!bootstrap) return;
    setUngroupedHidden(bootstrap.settings.general.hideUngrouped === true);
    setUngroupedCollapsed(bootstrap.settings.general.ungroupedCollapsed === true);
    setUngroupedPosition(bootstrap.settings.general.ungroupedPosition);
  }, [bootstrap?.settings.general.hideUngrouped, bootstrap?.settings.general.ungroupedCollapsed, bootstrap?.settings.general.ungroupedPosition]);
  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(contextMenu.x, window.innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(contextMenu.y, window.innerHeight - rect.height - 8));
    if (x !== contextMenu.x || y !== contextMenu.y) setContextMenu((current) => current ? { ...current, x, y } : null);
  }, [contextMenu]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!(event.target as HTMLElement | null)?.closest(".slh-context-menu")) {
        setContextMenu(null);
        contextMenuMoveRef.current = null;
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
        contextMenuMoveRef.current = null;
      }
    };
    const anotherMenu = () => {
      setContextMenu(null);
      contextMenuMoveRef.current = null;
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    window.addEventListener("slh-context-menu-open", anotherMenu);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("slh-context-menu-open", anotherMenu);
    };
  }, []);
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const move = contextMenuMoveRef.current;
      if (!move || !contextMenuRef.current) return;
      event.preventDefault();
      const deltaX = event.clientX - move.lastX;
      const deltaY = event.clientY - move.lastY;
      move.lastX = event.clientX;
      move.lastY = event.clientY;
      setContextMenu((current) => {
        if (!current) return current;
        const rect = contextMenuRef.current?.getBoundingClientRect();
        const width = rect?.width ?? 236;
        const height = rect?.height ?? 300;
        const maxX = Math.max(8, window.innerWidth - width - 8);
        const maxY = Math.max(8, window.innerHeight - height - 8);
        return {
          ...current,
          x: Math.max(8, Math.min(current.x + deltaX, maxX)),
          y: Math.max(8, Math.min(current.y + deltaY, maxY)),
        };
      });
    };
    const end = () => { contextMenuMoveRef.current = null; };
    // Mouse events are used here in addition to pointer events elsewhere in
    // the launcher because WebView2 can suppress pointermove while the
    // context-menu button is held.  A plain mouse drag keeps right-button
    // dragging reliable without changing the menu's native context-menu
    // behaviour.
    window.addEventListener("mousemove", onMove, { passive: false });
    window.addEventListener("mouseup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, []);

  const filtered = useMemo(() => {
    if (!bootstrap) return [];
    const term = search.trim().toLocaleLowerCase();
    return bootstrap.instances.filter((instance) => {
      if (!term) return true;
      return [instance.name, instance.minecraftVersion, instance.loaderType]
        .some((value) => value.toLocaleLowerCase().includes(term));
    }).sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true }));
  }, [bootstrap, search]);
  const pendingModpack = activities.find((activity) => activity.operation === "modpack" && activity.stage === "download");
  const pendingInstance = useMemo<Instance | null>(() => {
    if (!pendingModpack) return null;
    const name = pendingModpack.message
      .replace(/^(Downloading|Загрузка)\s+/i, "")
      .trim() || tr("Minecraft pack");
    return {
      id: `pending-${pendingModpack.operationId}`,
      name,
      groupId: null,
      iconPath: null,
      folderName: "",
      iconKey: "cube",
      iconBackground: "#3f493c",
      iconForeground: "#f0f4ed",
      minecraftVersion: tr("Unknown"),
      loaderType: "vanilla",
      loaderVersion: null,
      status: "installing",
      createdAt: new Date().toISOString(),
      lastPlayedAt: null,
      lastLaunchedAt: null,
      playtimeSeconds: 0,
      javaPath: null,
      memoryMinMb: 512,
      memoryMaxMb: 4096,
      gameDir: "",
      configSchemaVersion: 1,
      bedrockProfileMode: "shared",
    };
  }, [pendingModpack, tr]);

  if (!bootstrap) return null;

  const selected = bootstrap.instances.find((instance) => instance.id === selectedId) ?? null;
  const configuredPanelPosition = bootstrap.settings.general.instancePanelPosition;
  const panelPositionClass = configuredPanelPosition === "left" ? styles.panelLeft : styles.panelRight;

  const deleteInstance = async (instance: Instance) => {
    if (deletingInstanceId || instance.status === "running" || instance.status === "installing" || instance.status === "launching") return;
    setDeletingInstanceId(instance.id);
    try {
      await command("delete_instance", { instanceId: instance.id });
      if (selectedId === instance.id) select(null);
      setContextMenu(null);
      await refresh();
      pushToast(versionNotification(instance, "deleted"));
    } catch (error) {
      pushToast({
        tone: "error",
        title: tr("Instance was not deleted"),
        message: String((error as { message?: string }).message ?? error),
      });
    } finally {
      setDeletingInstanceId(null);
    }
  };

  const createGroup = async () => {
    const name = groupName.trim();
    if (!name || creatingGroup) return;
    setCreatingGroup(true);
    try {
      await command("create_group", { request: { name } });
      setGroupName("");
      await refresh();
      pushToast({ tone: "success", title: tr("Group created"), message: `${name} ${tr("is ready for your instances.")}` });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Group was not created"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setCreatingGroup(false);
    }
  };
  const openContextMenu = (event: { preventDefault: () => void; clientX: number; clientY: number }, menu: ContextMenuInput) => {
    event.preventDefault();
    window.dispatchEvent(new Event("slh-context-menu-open"));
    const estimatedHeight = menu.kind === "instance" ? 470 : menu.kind === "ungrouped" ? 150 : 160;
    setContextMenu({ ...menu, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 270)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - estimatedHeight - 8)) });
  };
  const beginContextMenuMove = (event: React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0 && event.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
    contextMenuMoveRef.current = { lastX: event.clientX, lastY: event.clientY };
  };
  const renameGroup = async () => {
    if (!renamingGroup || !renameValue.trim()) return;
    try {
      await command("rename_group", { request: { groupId: renamingGroup.id, name: renameValue.trim() } });
      setRenamingGroup(null);
      await refresh();
    } catch (error) {
      pushToast({ tone: "error", title: tr("Group was not renamed"), message: String((error as { message?: string }).message ?? error) });
    }
  };
  const deleteGroup = async (group: InstanceGroup) => {
    try {
      await command("delete_group", { request: { groupId: group.id } });
      setContextMenu(null);
      await refresh();
      pushToast({ tone: "success", title: tr("Group deleted"), message: `${group.name}: ${tr("instances moved to Ungrouped.")}` });
    } catch (error) {
      pushToast({ tone: "error", title: tr("Group was not deleted"), message: String((error as { message?: string }).message ?? error) });
    }
  };
  const rawPanelOptions = bootstrap?.settings.general.instancePanel ?? { showArtwork: true, showMetadata: true, hiddenActions: [], actionOrder: panelActionLabels.map(([id]) => id) };
  const normalizedActionOrder = [...new Set((rawPanelOptions.actionOrder?.length ? rawPanelOptions.actionOrder : panelActionLabels.map(([id]) => id)).map((id) => id === "shortcut" ? "delete" : id))];
  const selectedBedrock = bootstrap.instances.find((item) => item.id === selectedId)?.loaderType === "bedrock";
  if (selectedBedrock && !normalizedActionOrder.includes("resourcepacks")) normalizedActionOrder.splice(normalizedActionOrder.indexOf("mods") + 1, 0, "resourcepacks");
  if (!normalizedActionOrder.includes("delete")) normalizedActionOrder.push("delete");
  const panelOptions = {
    ...rawPanelOptions,
    actionOrder: normalizedActionOrder,
    hiddenActions: rawPanelOptions.hiddenActions.map((id) => id === "shortcut" ? "delete" : id),
  };
  const hideUngrouped = ungroupedHidden;
  const savePanelOptions = async (next: typeof panelOptions) => {
    const general = { ...bootstrap.settings.general, instancePanel: next };
    try {
      await command("update_setting", { key: "general", value: general });
      await refresh();
    } catch (error) {
      pushToast({ tone: "error", title: tr("Panel preferences were not saved"), message: String((error as { message?: string }).message ?? error) });
    }
  };
  const setUngroupedVisible = async (visible: boolean) => {
    const previous = ungroupedHidden;
    setUngroupedHidden(!visible);
    try {
      await command("update_setting", { key: "general", value: { ...bootstrap.settings.general, hideUngrouped: !visible } });
      await refresh();
      setContextMenu(null);
    } catch (error) {
      setUngroupedHidden(previous);
      pushToast({ tone: "error", title: tr("Library view was not saved"), message: String((error as { message?: string }).message ?? error) });
    }
  };
  const setUngroupedCollapsedState = async (collapsed: boolean) => {
    const previous = ungroupedCollapsed;
    setUngroupedCollapsed(collapsed);
    try {
      await command("update_setting", { key: "general", value: { ...bootstrap.settings.general, ungroupedCollapsed: collapsed } });
      await refresh();
    } catch (error) {
      setUngroupedCollapsed(previous);
      pushToast({ tone: "error", title: tr("Ungrouped view was not saved"), message: String((error as { message?: string }).message ?? error) });
    }
  };
  const effectiveUngroupedPosition = Math.max(0, Math.min(bootstrap.groups.length, Number.isInteger(ungroupedPosition) ? ungroupedPosition as number : bootstrap.groups.length));
  const reorderLibrarySectionByDrop = (targetId: string, sourceId = draggedGroupId, after = false) => {
    if (!sourceId || sourceId === targetId) return;
    if (sourceId !== "ungrouped" && targetId !== "ungrouped") {
      reorderGroupByDrop(targetId, sourceId, after);
      return;
    }
    const sections = bootstrap.groups.map((group) => group.id);
    sections.splice(effectiveUngroupedPosition, 0, "ungrouped");
    const sourceIndex = sections.indexOf(sourceId);
    const targetIndex = sections.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    sections.splice(sourceIndex, 1);
    const adjustedTarget = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    sections.splice(Math.max(0, adjustedTarget + (after ? 1 : 0)), 0, sourceId);
    const nextPosition = sections.indexOf("ungrouped");
    const nextGroups = sections.filter((id) => id !== "ungrouped");
    const previousGroups = bootstrap.groups.map((group) => group.id);
    const previousPosition = effectiveUngroupedPosition;
    const operations: Promise<unknown>[] = [];
    if (nextGroups.some((id, index) => id !== previousGroups[index])) {
      operations.push(command("reorder_groups", { request: { groupIds: nextGroups } }));
    }
    if (nextPosition !== effectiveUngroupedPosition) {
      setUngroupedPosition(nextPosition);
      operations.push(command("update_setting", { key: "general", value: { ...bootstrap.settings.general, ungroupedPosition: nextPosition } }));
    }
    if (operations.length > 0) {
      Promise.all(operations).then(() => refresh()).catch((error) => {
        setUngroupedPosition(previousPosition);
        pushToast({ tone: "error", title: tr("Library sections were not reordered"), message: String((error as { message?: string }).message ?? error) });
      });
    }
  };
  const movePanelAction = (id: string, targetId: string, after = false) => {
    const order = panelOptions.actionOrder?.length ? [...panelOptions.actionOrder] : panelActionLabels.map(([value]) => value);
    if (id === targetId) return;
    const next = order.filter((value) => value !== id);
    const target = next.indexOf(targetId);
    next.splice(target < 0 ? next.length : target + (after ? 1 : 0), 0, id);
    void savePanelOptions({ ...panelOptions, actionOrder: next });
  };
  const reorderGroupByDrop = (groupId: string, sourceId = draggedGroupId, after = false) => {
    if (!sourceId || sourceId === groupId) return;
    const order = bootstrap.groups.map((group) => group.id).filter((id) => id !== sourceId);
    const target = order.indexOf(groupId);
    order.splice(target < 0 ? order.length : target + (after ? 1 : 0), 0, sourceId);
    void command("reorder_groups", { request: { groupIds: order } }).then(() => refresh()).catch((error) => pushToast({ tone: "error", title: tr("Groups were not reordered"), message: String((error as { message?: string }).message ?? error) })).finally(() => { setDraggedGroupId(null); setGroupReorderTarget(null); });
  };

  const toggleGroup = async (groupId: string, collapsed: boolean) => {
    try {
      await command("set_group_collapsed", { request: { groupId, collapsed } });
      await refresh();
    } catch (error) {
      pushToast({ tone: "error", title: tr("Group view was not saved"), message: String((error as { message?: string }).message ?? error) });
    }
  };
  const assignGroup = async (instanceId: string, groupId: string | null) => {
    const instance = bootstrap.instances.find((item) => item.id === instanceId);
    if (!instance || instance.groupId === groupId) return;
    try {
      await command("assign_instance_group", { request: { instanceId: instance.id, groupId } });
      await refresh();
    } catch (error) {
      pushToast({ tone: "error", title: tr("Group was not updated"), message: String((error as { message?: string }).message ?? error) });
    } finally {
      setDraggedInstanceId(null);
      setDropGroupId(undefined);
    }
  };

  // Native HTML drag-and-drop is unreliable in older WebView2 runtimes. Keep
  // the interaction entirely pointer based: hold a card, move it to a group,
  // then release. This also works on touch devices.
  useEffect(() => {
    const findDropGroup = (clientX: number, clientY: number) => {
      const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-slh-group-drop]");
      if (!target) return undefined;
      return target.dataset.slhGroupDrop === "ungrouped" ? null : target.dataset.slhGroupDrop ?? undefined;
    };
    const onPointerMove = (event: PointerEvent) => {
      const groupDrag = groupPointerDragRef.current;
      if (groupDrag) {
        if (!groupDrag.dragging && Math.hypot(event.clientX - groupDrag.startX, event.clientY - groupDrag.startY) >= 6) {
          groupDrag.dragging = true;
          setDraggedGroupId(groupDrag.groupId);
          setGroupDragPreview({ label: groupDrag.label, x: event.clientX, y: event.clientY });
        }
      if (groupDrag.dragging) {
          event.preventDefault();
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-slh-group-order]");
        const id = target?.dataset.slhGroupOrder;
          if (target && id && id !== groupDrag.groupId) {
            const rect = target.getBoundingClientRect();
            setGroupReorderTarget({ id, after: event.clientY >= rect.top + rect.height / 2 });
          } else setGroupReorderTarget(null);
          setGroupDragPreview((current) => current ? { ...current, x: event.clientX, y: event.clientY } : current);
        }
        return;
      }
      const actionDrag = panelActionPointerDragRef.current;
      if (actionDrag) {
        if (!actionDrag.dragging && Math.hypot(event.clientX - actionDrag.startX, event.clientY - actionDrag.startY) >= 6) {
          actionDrag.dragging = true;
          setPanelActionDragPreview({ label: actionDrag.label, x: event.clientX, y: event.clientY });
        }
        if (actionDrag.dragging) {
          event.preventDefault();
          const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-slh-panel-action]");
          const id = target?.dataset.slhPanelAction;
          if (target && id && id !== actionDrag.actionId) {
            const rect = target.getBoundingClientRect();
            setPanelActionReorderTarget({ id, after: event.clientY >= rect.top + rect.height / 2 });
          } else setPanelActionReorderTarget(null);
          setPanelActionDragPreview((current) => current ? { ...current, x: event.clientX, y: event.clientY } : current);
        }
        return;
      }
      const drag = pointerDragRef.current;
      if (!drag) return;
      if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 8) {
        drag.dragging = true;
        draggedInstanceRef.current = drag.instanceId;
        setDraggedInstanceId(drag.instanceId);
        const instance = bootstrap.instances.find((item) => item.id === drag.instanceId);
        if (instance) setDragPreview({ instance, x: event.clientX, y: event.clientY });
      }
      if (drag.dragging) {
        const targetGroup = findDropGroup(event.clientX, event.clientY);
        const sourceGroup = bootstrap.instances.find((item) => item.id === drag.instanceId)?.groupId;
        setDropGroupId(targetGroup !== undefined && targetGroup !== sourceGroup ? targetGroup : undefined);
        setDragPreview((current) => current ? { ...current, x: event.clientX, y: event.clientY } : current);
      }
    };
    const finishPointerDrag = (event: PointerEvent) => {
      const groupDrag = groupPointerDragRef.current;
      groupPointerDragRef.current = null;
      if (groupDrag?.dragging) {
        const targetElement = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-slh-group-order]");
        const target = targetElement?.dataset.slhGroupOrder;
        if (target && targetElement) {
          const rect = targetElement.getBoundingClientRect();
          reorderLibrarySectionByDrop(target, groupDrag.groupId, event.clientY >= rect.top + rect.height / 2);
        }
        setDraggedGroupId(null);
        setGroupReorderTarget(null);
        setGroupDragPreview(null);
        return;
      }
      const actionDrag = panelActionPointerDragRef.current;
      panelActionPointerDragRef.current = null;
      if (actionDrag?.dragging) {
        const targetElement = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-slh-panel-action]");
        const target = targetElement?.dataset.slhPanelAction;
        if (target && targetElement) {
          const rect = targetElement.getBoundingClientRect();
          movePanelAction(actionDrag.actionId, target, event.clientY >= rect.top + rect.height / 2);
        }
        setPanelActionDragPreview(null);
        setPanelActionReorderTarget(null);
        return;
      }
      const drag = pointerDragRef.current;
      pointerDragRef.current = null;
      if (!drag?.dragging) return;
      const groupId = findDropGroup(event.clientX, event.clientY);
      draggedInstanceRef.current = null;
      setDraggedInstanceId(null);
      setDropGroupId(undefined);
      setDragPreview(null);
      if (groupId !== undefined) void assignGroup(drag.instanceId, groupId);
    };
    const cancelPointerDrag = () => {
      groupPointerDragRef.current = null;
      panelActionPointerDragRef.current = null;
      setDraggedGroupId(null);
      setGroupReorderTarget(null);
      setGroupDragPreview(null);
      setPanelActionDragPreview(null);
      setPanelActionReorderTarget(null);
      pointerDragRef.current = null;
      draggedInstanceRef.current = null;
      setDraggedInstanceId(null);
      setDropGroupId(undefined);
      setDragPreview(null);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishPointerDrag);
    window.addEventListener("pointercancel", cancelPointerDrag);
    window.addEventListener("slh-ui-cancel", cancelPointerDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishPointerDrag);
      window.removeEventListener("pointercancel", cancelPointerDrag);
      window.removeEventListener("slh-ui-cancel", cancelPointerDrag);
    };
  }, [bootstrap, refresh]);
  const dropHandlers = (groupId: string | null) => ({
    onDragEnter: (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      const source = draggedInstanceRef.current || draggedInstanceId;
      const sourceGroup = source ? bootstrap.instances.find((instance) => instance.id === source)?.groupId : undefined;
      setDropGroupId(source && sourceGroup === groupId ? undefined : groupId);
    },
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const source = draggedInstanceRef.current || draggedInstanceId;
      const sourceGroup = source ? bootstrap.instances.find((instance) => instance.id === source)?.groupId : undefined;
      setDropGroupId(source && sourceGroup === groupId ? undefined : groupId);
    },
    onDragLeave: (event: React.DragEvent<HTMLElement>) => { if (event.currentTarget === event.target) setDropGroupId((current) => current === groupId ? undefined : current); },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      // React state may be cleared before drop after a drag leaves a collapsed group.
      // The drag payload is the authoritative source of the selected instance.
      const instanceId = event.dataTransfer.getData("application/x-slh-instance") || event.dataTransfer.getData("text/plain") || draggedInstanceRef.current || draggedInstanceId;
      if (instanceId) void assignGroup(instanceId, groupId);
    },
    // WebView2 can occasionally suppress HTML drag events while the cursor is
    // still being moved. Keep the same operation available on pointer release.
  });
  const ungrouped = filtered.filter((instance) => !instance.groupId);
  const grouped = bootstrap.groups
    .map((group) => ({ group, instances: filtered.filter((instance) => instance.groupId === group.id) }));
  const orderedSections: Array<{ kind: "group"; group: InstanceGroup; instances: Instance[] } | { kind: "ungrouped" }> = [...grouped.map((section) => ({ ...section, kind: "group" as const }))];
  if (!hideUngrouped) orderedSections.splice(effectiveUngroupedPosition, 0, { kind: "ungrouped" });
  const renderInstance = (instance: Instance, groupName?: string, pending = false) => (
    <InstanceCard
      key={instance.id}
      instance={instance}
      selected={instance.id === selectedId}
      view={viewMode}
      groupName={groupName}
      onSelect={() => { if (!pending) select(instance.id); }}
      onOpenFolder={() => { if (!pending) void revealInstancePath(instance.id, instance.gameDir).catch((error) => pushToast({ tone: "error", title: tr("Folder could not be opened"), message: String((error as { message?: string }).message ?? error) })); }}
      onSettings={() => { if (!pending) navigate(`/instance/${instance.id}?tab=settings`); }}
      onDelete={() => { if (!pending) void deleteInstance(instance); }}
      onPointerDown={(event) => {
        if (pending || event.button !== 0) return;
        if ((event.target as HTMLElement).closest("button, input, select, summary, a")) return;
        // Browser text selection competes with a pointer drag in WebView2.
        event.preventDefault();
        pointerDragRef.current = { instanceId: instance.id, startX: event.clientX, startY: event.clientY, dragging: false };
      }}
      progress={(() => {
        if (instance.status === "error" || instance.status === "installed") return null;
        const progress = pending ? pendingModpack : activities.find((activity) => activity.instanceId === instance.id);
        if (progress?.stage === "complete") return null;
        if (!progress) return null;
        const percentage = progress.downloadedBytes !== null && progress.totalBytes && progress.totalBytes > 0
          ? Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
          : progress.total && progress.total > 0
            ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
            : null;
        return { percentage, message: progress.message };
      })()}
    />
  );

  return (
    <div className={`${styles.layout} ${selected ? `${styles.withPanel} ${panelPositionClass}` : ""}`}>
      <section className={`${styles.library} ${draggedInstanceId || draggedGroupId ? styles.dragging : ""}`}>
        <div className={styles.pageHeader}>
          <div>
            <p className={styles.eyebrow}>{t("library.eyebrow", "Instance library")}</p>
            <h1>{t("library.heading", "Your Minecraft worlds, separated and ready")}</h1>
            <span>{t("library.instanceCount", "{count} instance(s) in this library").replace("{count}", String(bootstrap.instances.length)).replace("(s)", bootstrap.instances.length === 1 ? "" : "s")}</span>
          </div>
          <div className={styles.toolbar}>
            <details name="slh-action-menu" data-action-menu className={styles.groupMenu}>
              <summary className={common.ghostButton}><Plus size={16} weight="bold" /> {t("library.group", "Group")}</summary>
              <form onSubmit={(event) => { event.preventDefault(); void createGroup(); }}>
                <label>{t("library.newGroup", "New group")}</label>
                <input className={common.input} value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder={t("library.groupExample", "e.g. Survival")} maxLength={80} autoFocus />
                <button className={common.button} type="submit" disabled={!groupName.trim() || creatingGroup}>{creatingGroup ? t("library.creating", "Creating") : t("library.createGroup", "Create group")}</button>
              </form>
            </details>
            {hideUngrouped ? <button className={common.ghostButton} type="button" onClick={() => void setUngroupedVisible(true)}>{t("library.showUngrouped", "Show ungrouped")}</button> : null}
            <button className={common.ghostButton} type="button" onClick={() => pushToast({ tone: "info", title: tr("Filters"), message: tr("Search already matches names, versions, and loaders. Advanced filters are being added.") })}>
              <Funnel size={17} /> {t("library.filter", "Filter")}
            </button>
            <div className={styles.viewSwitch} aria-label={t("library.libraryView", "Library view")}>
              <button className={viewMode === "grid" ? styles.active : ""} type="button" onClick={() => void setViewMode("grid")} aria-label={t("library.gridView", "Grid view")}><SquaresFour size={17} weight="bold" /></button>
              <button className={viewMode === "list" ? styles.active : ""} type="button" onClick={() => void setViewMode("list")} aria-label={t("library.listView", "List view")}><ListBullets size={18} weight="bold" /></button>
            </div>
          </div>
        </div>

        {filtered.length === 0 && bootstrap.groups.length === 0 && !pendingInstance ? (
          <div className={styles.empty}>
            <BrandLogo variant="icon" />
            <h2>{bootstrap.instances.length === 0 ? t("library.emptyTitle", "No instances yet") : t("library.noMatching", "No matching instances")}</h2>
            <p>{bootstrap.instances.length === 0 ? t("library.emptyBody", "Create your first Minecraft instance or import an existing one.") : t("library.searchEmpty", "Change the search text to see the rest of your library.")}</p>
            {bootstrap.instances.length === 0 ? (
              <button className={common.button} type="button" onClick={() => setWizardOpen(true)}><Plus size={17} weight="bold" /> {t("library.create", "Create instance")}</button>
            ) : null}
          </div>
        ) : (
          <div className={styles.scrollArea}>
            {viewMode === "list" ? (
              <div className={styles.listHeader}>
                <span />
                <span>{t("library.name", "Name")}</span><span>{t("library.version", "Version")}</span><span>{t("library.loader", "Loader")}</span><span>{t("library.group", "Group")}</span><span>{t("library.lastPlayed", "Last played")}</span>
              </div>
            ) : null}
            {orderedSections.map((section) => section.kind === "group" ? (
              <section className={`${styles.group} ${dropGroupId === section.group.id ? styles.dropTarget : ""}`} key={section.group.id} data-slh-group-drop={section.group.id} {...dropHandlers(section.group.id)}>
                <div className={`${styles.groupHeader} ${groupReorderTarget?.id === section.group.id ? (groupReorderTarget.after ? styles.groupInsertAfter : styles.groupInsertBefore) : ""}`} data-slh-group-drop={section.group.id} data-slh-group-order={section.group.id} {...dropHandlers(section.group.id)} onPointerDown={(event) => { if (event.button !== 0 || (event.target as HTMLElement).closest("button, input")) return; event.preventDefault(); groupPointerDragRef.current = { groupId: section.group.id, label: section.group.name, startX: event.clientX, startY: event.clientY, dragging: false }; }} onContextMenu={(event) => openContextMenu(event, { kind: "group", group: section.group })}>
                  <button type="button" onClick={() => void toggleGroup(section.group.id, !section.group.collapsed)} aria-expanded={!section.group.collapsed} aria-label={`${section.group.collapsed ? "Expand" : "Collapse"} ${section.group.name}`}>
                    <ArrowRight className={section.group.collapsed ? styles.collapsedArrow : styles.expandedArrow} size={15} weight="bold" />
                  </button>
                  <h2>{section.group.name}</h2>
                  <span>{section.instances.length}</span>
                </div>
                {!section.group.collapsed ? <div className={viewMode === "grid" ? styles.grid : styles.list}>
                  {section.instances.length > 0 ? section.instances.map((instance) => renderInstance(instance, section.group.name)) : <p className={styles.emptyGroup}>{t("library.emptyGroup", "Drop or create an instance in this group.")}</p>}
                </div> : null}
              </section>
            ) : (
              <section className={`${styles.group} ${dropGroupId === null ? styles.dropTarget : ""}`} key="ungrouped" data-slh-group-drop="ungrouped" {...dropHandlers(null)}>
                <div className={`${styles.groupHeader} ${groupReorderTarget?.id === "ungrouped" ? (groupReorderTarget.after ? styles.groupInsertAfter : styles.groupInsertBefore) : ""}`} data-slh-group-drop="ungrouped" data-slh-group-order="ungrouped" {...dropHandlers(null)} onPointerDown={(event) => { if (event.button !== 0 || (event.target as HTMLElement).closest("button, input")) return; event.preventDefault(); groupPointerDragRef.current = { groupId: "ungrouped", label: t("library.ungrouped", "Ungrouped"), startX: event.clientX, startY: event.clientY, dragging: false }; }} onContextMenu={(event) => openContextMenu(event, { kind: "ungrouped" })}>
                  <button type="button" onClick={() => void setUngroupedCollapsedState(!ungroupedCollapsed)} aria-expanded={!ungroupedCollapsed} aria-label={`${ungroupedCollapsed ? "Expand" : "Collapse"} ${t("library.ungrouped", "Ungrouped")}`}>
                    <ArrowRight className={ungroupedCollapsed ? styles.collapsedArrow : styles.expandedArrow} size={15} weight="bold" />
                  </button>
                  <h2>{t("library.ungrouped", "Ungrouped")}</h2>
                  <span>{ungrouped.length + (pendingInstance ? 1 : 0)}</span>
                </div>
                {!ungroupedCollapsed ? <div className={viewMode === "grid" ? styles.grid : styles.list} {...dropHandlers(null)}>
                  {pendingInstance ? renderInstance(pendingInstance, undefined, true) : null}
                  {ungrouped.length > 0 ? ungrouped.map((instance) => renderInstance(instance)) : <p className={styles.emptyGroup}>{t("library.emptyGroup", "Drop or create an instance in this group.")}</p>}
                </div> : null}
              </section>
            ))}
          </div>
        )}
      </section>
      {selected ? <div className={styles.panelSlot}><InstanceSidePanel instance={selected} onDelete={() => void deleteInstance(selected)} onContextMenu={(event) => openContextMenu(event, { kind: "instance" })} /></div> : null}
      {dragPreview ? (
        <div className={styles.dragPreview} style={{ left: dragPreview.x, top: dragPreview.y }} aria-hidden="true">
          <span>{dragPreview.instance.name}</span>
          <small>Minecraft {dragPreview.instance.minecraftVersion}</small>
        </div>
      ) : null}
      {groupDragPreview ? <div className={styles.groupDragPreview} style={{ left: groupDragPreview.x, top: groupDragPreview.y }} aria-hidden="true">{groupDragPreview.label}</div> : null}
      {panelActionDragPreview ? <div className={styles.groupDragPreview} style={{ left: panelActionDragPreview.x, top: panelActionDragPreview.y }} aria-hidden="true">{panelActionDragPreview.label}</div> : null}
      {contextMenu ? (
        <div ref={contextMenuRef} className={`${styles.contextMenu} slh-context-menu`} style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => { event.stopPropagation(); if (event.button === 2) beginContextMenuMove(event); }} onMouseDown={(event) => { if (event.button === 2) beginContextMenuMove(event); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}>
          {contextMenu.kind === "ungrouped" ? <>
            <header className={styles.contextTitle} onPointerDown={beginContextMenuMove} onMouseDown={(event) => { if (event.button === 2) beginContextMenuMove(event); }}><FolderOpen size={17} /><strong>{tr("Ungrouped")}</strong></header>
            <div>
              <button className={menuStyles.itemToggle} type="button" onClick={() => { setContextMenu(null); void setUngroupedCollapsedState(!ungroupedCollapsed); }}>
                <span className={menuStyles.check} aria-hidden="true" />
                <ArrowRight className={ungroupedCollapsed ? styles.contextArrowCollapsed : styles.contextArrowExpanded} size={16} />
                <span>{tr(ungroupedCollapsed ? "Expand group" : "Collapse group")}</span>
              </button>
              <button className={menuStyles.itemToggle} type="button" onClick={() => void setUngroupedVisible(false)}><span className={menuStyles.check} aria-hidden="true" /><X size={16} /><span>{tr("Hide ungrouped")}</span></button>
            </div>
          </> : contextMenu.kind === "group" ? <>
            <header className={styles.contextTitle} onPointerDown={beginContextMenuMove} onMouseDown={(event) => { if (event.button === 2) beginContextMenuMove(event); }}><Stack size={17} /><strong>{contextMenu.group.name}</strong></header>
            <div>
              <button className={menuStyles.itemToggle} type="button" onClick={() => { setRenameValue(contextMenu.group.name); setRenamingGroup(contextMenu.group); setContextMenu(null); }}><span className={menuStyles.check} aria-hidden="true" /><Wrench size={16} /><span>{tr("Rename group")}</span></button>
              <button className={`${menuStyles.itemToggle} ${styles.contextDanger}`} type="button" onClick={() => void deleteGroup(contextMenu.group)}><span className={menuStyles.check} aria-hidden="true" /><Trash size={16} /><span>{tr("Delete group")}</span></button>
            </div>
          </> : <>
            <header className={styles.contextTitle} onPointerDown={beginContextMenuMove} onMouseDown={(event) => { if (event.button === 2) beginContextMenuMove(event); }}><Stack size={17} /><strong>{tr("Instance panel")}</strong></header>
            <div>
              <label className={`${menuStyles.itemToggle} ${styles.panelMenuItem}`}><input className={styles.contextCheckbox} type="checkbox" checked={panelOptions.showArtwork} onChange={(event) => void savePanelOptions({ ...panelOptions, showArtwork: event.target.checked })} /><span className={menuStyles.check}>{panelOptions.showArtwork ? <Check size={16} /> : null}</span><span className={styles.contextIcon}><Image size={16} /></span><span>{tr("Icon / artwork")}</span></label>
              <label className={`${menuStyles.itemToggle} ${styles.panelMenuItem}`}><input className={styles.contextCheckbox} type="checkbox" checked={panelOptions.showMetadata} onChange={(event) => void savePanelOptions({ ...panelOptions, showMetadata: event.target.checked })} /><span className={menuStyles.check}>{panelOptions.showMetadata ? <Check size={16} /> : null}</span><span className={styles.contextIcon}><Info size={16} /></span><span>{tr("Information")}</span></label>
              <div className={menuStyles.separator} />
              {(panelOptions.actionOrder?.length ? panelOptions.actionOrder : panelActionLabels.map(([id]) => id)).filter((id) => selectedBedrock ? id !== "screenshots" : id !== "resourcepacks").map((id) => {
                const label = tr(selectedBedrock && id === "mods" ? "Add-ons" : panelActionLabels.find(([value]) => value === id)?.[1] ?? id);
                const enabled = !panelOptions.hiddenActions.includes(id);
                return <div className={`${styles.contextRow} ${panelActionReorderTarget?.id === id ? (panelActionReorderTarget.after ? styles.contextInsertAfter : styles.contextInsertBefore) : ""}`} key={id} data-slh-panel-action={id} onPointerDown={(event) => { if (event.button === 0 && !(event.target as HTMLElement).closest("input")) panelActionPointerDragRef.current = { actionId: id, label, startX: event.clientX, startY: event.clientY, dragging: false }; }}>
                  <label className={`${menuStyles.itemToggle} ${styles.panelMenuItem}`}><input className={styles.contextCheckbox} type="checkbox" checked={enabled} onChange={(event) => void savePanelOptions({ ...panelOptions, hiddenActions: event.target.checked ? panelOptions.hiddenActions.filter((value) => value !== id) : [...panelOptions.hiddenActions, id] })} /><span className={menuStyles.check}>{enabled ? <Check size={16} /> : null}</span><span className={styles.contextIcon}>{panelActionIcon(id)}</span><span>{label}</span></label>
                </div>;
              })}
            </div>
          </>}
        </div>
      ) : null}
      <Dialog open={renamingGroup !== null} title={tr("Rename group")} description={tr("Instances stay in the same group.")} onClose={() => setRenamingGroup(null)} width="small">
        <form className={styles.renameForm} onSubmit={(event) => { event.preventDefault(); void renameGroup(); }}>
          <input className={common.input} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={80} autoFocus />
          <button className={common.button} type="submit" disabled={!renameValue.trim()}>{tr("Save")}</button>
        </form>
      </Dialog>
    </div>
  );
}
