import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, HardDrives } from "../icons";
import { command } from "../../lib/tauri";
import type { AppearanceSettings } from "../../lib/types";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n/I18nProvider";
import { homeStatusIds, homeStatusItems, homeStatusOrder, type HomeStatusId } from "../../lib/homeStatus";
import styles from "../shell/NavigationContextMenu.module.css";

const items = homeStatusItems;

interface HomeStatusContextMenuProps {
  position: { x: number; y: number } | null;
  onClose: () => void;
}

export function HomeStatusContextMenu({ position, onClose }: HomeStatusContextMenuProps) {
  const { tr } = useI18n();
  const bootstrap = useAppStore((state) => state.bootstrap);
  const refresh = useAppStore((state) => state.refresh);
  const pushToast = useAppStore((state) => state.pushToast);
  const [draggedId, setDraggedId] = useState<HomeStatusId | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: HomeStatusId; after: boolean } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ label: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pointerDragRef = useRef<{ id: HomeStatusId; startX: number; startY: number; dragging: boolean } | null>(null);
  useEffect(() => {
    if (!position) return undefined;
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const anotherMenu = () => onClose();
    const cancel = () => {
      pointerDragRef.current = null;
      setDraggedId(null);
      setDropTarget(null);
      setDragPreview(null);
      onClose();
    };
    window.addEventListener("pointerdown", onClose);
    window.addEventListener("keydown", keydown);
    window.addEventListener("slh-context-menu-open", anotherMenu);
    window.addEventListener("slh-ui-cancel", cancel);
    return () => {
      window.removeEventListener("pointerdown", onClose);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("slh-context-menu-open", anotherMenu);
      window.removeEventListener("slh-ui-cancel", cancel);
    };
  }, [onClose, position]);

  useLayoutEffect(() => {
    if (!position || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8));
    menuRef.current.style.left = `${x}px`;
    menuRef.current.style.top = `${y}px`;
  }, [position]);

  const visibleIds = bootstrap?.settings.appearance.homeStatusVisible ?? homeStatusIds;
  const order = homeStatusOrder(bootstrap?.settings.appearance.homeStatusOrder);
  const visible = new Set(visibleIds);
  const toggle = async (id: HomeStatusId) => {
    if (!bootstrap) return;
    const next = new Set(visible);
    if (next.has(id)) next.delete(id); else next.add(id);
    const homeStatusVisible = order.filter((item) => next.has(item));
    try {
      await command("update_setting", {
        key: "appearance",
        value: { ...bootstrap.settings.appearance, homeStatusVisible, homeStatusOrder: order } satisfies AppearanceSettings,
      });
      await refresh();
    } catch (error) {
      pushToast({ tone: "error", title: tr("Launcher status layout was not saved"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  const reorder = async (id: HomeStatusId, targetId: HomeStatusId, after: boolean) => {
    if (!bootstrap) return;
    if (id === targetId) return;
    const next = order.filter((item) => item !== id);
    const target = next.indexOf(targetId);
    next.splice(target < 0 ? next.length : target + (after ? 1 : 0), 0, id);
    const homeStatusVisible = next.filter((item) => visible.has(item));
    try {
      await command("update_setting", { key: "appearance", value: { ...bootstrap.settings.appearance, homeStatusVisible, homeStatusOrder: next } satisfies AppearanceSettings });
      await refresh();
      setDraggedId(null);
      setDropTarget(null);
    } catch (error) {
      setDraggedId(null);
      setDropTarget(null);
      pushToast({ tone: "error", title: tr("Launcher status layout was not saved"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag) return;
      if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 6) {
        drag.dragging = true;
        setDraggedId(drag.id);
        const item = items.find((candidate) => candidate.id === drag.id);
        if (item) setDragPreview({ label: tr(item.label), x: event.clientX, y: event.clientY });
      }
      if (drag.dragging) {
        event.preventDefault();
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-slh-status-order]");
        const id = target?.dataset.slhStatusOrder as HomeStatusId | undefined;
        if (target && id && id !== drag.id) {
          const rect = target.getBoundingClientRect();
          setDropTarget({ id, after: event.clientY >= rect.top + rect.height / 2 });
        } else setDropTarget(null);
        setDragPreview((current) => current ? { ...current, x: event.clientX, y: event.clientY } : current);
      }
    };
    const onEnd = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      pointerDragRef.current = null;
      if (drag?.dragging) {
        const targetElement = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-slh-status-order]");
        const target = targetElement?.dataset.slhStatusOrder as HomeStatusId | undefined;
        if (target && targetElement && target !== drag?.id) {
          const rect = targetElement.getBoundingClientRect();
          void reorder(drag.id, target, event.clientY >= rect.top + rect.height / 2);
        }
      }
      setDraggedId(null);
      setDropTarget(null);
      setDragPreview(null);
    };
    const cancel = () => {
      pointerDragRef.current = null;
      setDraggedId(null);
      setDropTarget(null);
      setDragPreview(null);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("slh-ui-cancel", cancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("slh-ui-cancel", cancel);
    };
  }, [tr, order.join("|"), visible.size]);

  if (!bootstrap || !position) return null;
  const orderedItems = order.map((id) => items.find((item) => item.id === id)).filter((item): item is (typeof items)[number] => Boolean(item));
  return createPortal(<><div ref={menuRef} className={`${styles.menu} slh-context-menu`} role="menu" aria-label={tr("Launcher status")} style={{ left: position.x, top: position.y }} onPointerDown={(event) => event.stopPropagation()}>
    <header><HardDrives size={17} /><strong>{tr("Launcher status")}</strong></header>
    <div>{orderedItems.map(({ id, label, icon: Icon }) => <div key={id}>
      <div className={`${styles.itemRow} ${draggedId === id ? styles.dragging : ""} ${dropTarget?.id === id ? (dropTarget.after ? styles.insertAfter : styles.insertBefore) : ""}`} data-slh-status-order={id} onPointerDown={(event) => { if (event.button === 0) pointerDragRef.current = { id, startX: event.clientX, startY: event.clientY, dragging: false }; }}>
      <button type="button" className={styles.itemToggle} role="menuitemcheckbox" aria-checked={visible.has(id)} onClick={() => void toggle(id)}>
        <span className={styles.check}>{visible.has(id) ? <Check size={16} /> : null}</span><Icon size={18} /><span>{tr(label)}</span>
      </button>
      </div>
    </div>)}</div>
  </div>{dragPreview ? <div className={styles.dragPreview} style={{ left: dragPreview.x, top: dragPreview.y }} aria-hidden="true">{dragPreview.label}</div> : null}</>, document.body);
}
