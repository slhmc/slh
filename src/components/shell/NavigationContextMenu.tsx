import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Compass } from "../icons";
import { command } from "../../lib/tauri";
import type { GeneralSettings, SidebarNavigationItem } from "../../lib/types";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n/I18nProvider";
import { defaultSidebarNavigation, sidebarNavigation, sidebarSettings } from "./AppSidebar";
import styles from "./NavigationContextMenu.module.css";

const items = [...sidebarNavigation, sidebarSettings];

interface NavigationContextMenuProps {
  position: { x: number; y: number } | null;
  onClose: () => void;
}

export function NavigationContextMenu({ position, onClose }: NavigationContextMenuProps) {
  const { t, tr } = useI18n();
  const bootstrap = useAppStore((state) => state.bootstrap);
  const refresh = useAppStore((state) => state.refresh);
  const pushToast = useAppStore((state) => state.pushToast);
  const [draggedId, setDraggedId] = useState<SidebarNavigationItem | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: SidebarNavigationItem; after: boolean } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ label: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pointerDragRef = useRef<{ id: SidebarNavigationItem; startX: number; startY: number; dragging: boolean } | null>(null);
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

  const visibleIds = bootstrap?.settings.general.visibleNavigation ?? defaultSidebarNavigation;
  const order = [...(bootstrap?.settings.general.navigationOrder ?? defaultSidebarNavigation)];
  const visible = new Set(visibleIds);
  const toggle = async (id: SidebarNavigationItem) => {
    if (!bootstrap) return;
    const next = new Set(visible);
    if (next.has(id)) next.delete(id); else next.add(id);
    const visibleNavigation = order.filter((item) => next.has(item));
    try {
      await command("update_setting", {
        key: "general",
        value: { ...bootstrap.settings.general, visibleNavigation, navigationOrder: order } satisfies GeneralSettings,
      });
      await refresh();
    } catch (error) {
      pushToast({ tone: "error", title: tr("Navigation was not saved"), message: String((error as { message?: string }).message ?? error) });
    }
  };

  const reorder = async (id: SidebarNavigationItem, targetId: SidebarNavigationItem, after: boolean) => {
    if (!bootstrap) return;
    if (id === targetId || id === "settings" || targetId === "settings") return;
    const next = order.filter((item) => item !== id);
    const target = next.indexOf(targetId);
    next.splice(target < 0 ? next.length : target + (after ? 1 : 0), 0, id);
    const visibleNavigation = next.filter((item) => visible.has(item));
    try {
      await command("update_setting", { key: "general", value: { ...bootstrap.settings.general, visibleNavigation, navigationOrder: next } satisfies GeneralSettings });
      await refresh();
      setDraggedId(null);
      setDropTarget(null);
    } catch (error) {
      setDraggedId(null);
      setDropTarget(null);
      pushToast({ tone: "error", title: tr("Navigation was not saved"), message: String((error as { message?: string }).message ?? error) });
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
        if (item) setDragPreview({ label: t(item.labelKey, item.label), x: event.clientX, y: event.clientY });
      }
      if (drag.dragging) {
        event.preventDefault();
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-slh-navigation-order]");
        const id = target?.dataset.slhNavigationOrder as SidebarNavigationItem | undefined;
        if (target && id && id !== "settings" && drag.id !== "settings" && id !== drag.id) {
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
        const targetElement = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-slh-navigation-order]");
        const target = targetElement?.dataset.slhNavigationOrder as SidebarNavigationItem | undefined;
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
  }, [t, order.join("|"), visible.size]);

  if (!bootstrap || !position) return null;
  const orderedItems = order.map((id) => items.find((item) => item.id === id)).filter((item): item is (typeof items)[number] => Boolean(item));
  return <><div ref={menuRef} className={`${styles.menu} slh-context-menu`} role="menu" aria-label={t("navigation.visibility", "Navigation visibility")} style={{ left: position.x, top: position.y }} onPointerDown={(event) => event.stopPropagation()}>
    <header><Compass size={17} /><strong>{t("navigation.title", "Navigation")}</strong></header>
    <div>{orderedItems.map(({ id, label, labelKey, icon: Icon }) => <div key={id}>
      {id === "settings" ? <div className={styles.separator} aria-hidden="true" /> : null}
      <div className={`${styles.itemRow} ${draggedId === id ? styles.dragging : ""} ${dropTarget?.id === id ? (dropTarget.after ? styles.insertAfter : styles.insertBefore) : ""}`} data-slh-navigation-order={id} onPointerDown={(event) => { if (event.button === 0 && id !== "settings") pointerDragRef.current = { id, startX: event.clientX, startY: event.clientY, dragging: false }; }}>
      <button type="button" className={styles.itemToggle} role="menuitemcheckbox" aria-checked={visible.has(id)} onClick={() => void toggle(id)}>
        <span className={styles.check}>{visible.has(id) ? <Check size={16} /> : null}</span><Icon size={18} /><span>{t(labelKey, label)}</span>
      </button>
      </div>
    </div>)}</div>
  </div>{dragPreview ? <div className={styles.dragPreview} style={{ left: dragPreview.x, top: dragPreview.y }} aria-hidden="true">{dragPreview.label}</div> : null}</>;
}
