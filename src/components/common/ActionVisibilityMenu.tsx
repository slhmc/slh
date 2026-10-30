import { createPortal } from "react-dom";
import { LibraryMenuSurface } from "./LibraryChrome";
import library from "../../routes/Library/LibraryPage.module.css";
import { useEffect, useLayoutEffect, useRef, useState, type ElementType, type PointerEvent as ReactPointerEvent } from "react";
import extra from "./ActionVisibilityMenu.module.css";
import { Check, GearSix, Stack } from "../icons";
import { moveBefore } from "../../lib/serverPresentation";
import styles from "../shell/NavigationContextMenu.module.css";

export interface VisibilityItem { id: string; label: string; Icon: ElementType; checked: boolean; disabled?: boolean; reorderable?: boolean; separator?: boolean }
export function ActionVisibilityMenu({ at, title, items, onClose, onToggle, onReorder, variant = "tabs" }: {
  variant?: "tabs" | "panel"; at: { x: number; y: number }; title: string; items: VisibilityItem[]; onClose: () => void;
  onToggle: (id: string) => void; onReorder: (order: string[]) => void;
}) {
  const [position, setPosition] = useState(at);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [preview, setPreview] = useState<{ label: string; x: number; y: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string | null; x: number; y: number; active: boolean; node: HTMLElement; pointerId: number; origin: { x: number; y: number } } | null>(null);
  const suppress = useRef(false);
  const order = items.filter(item => item.reorderable).map(item => item.id);
  const begin = (event: ReactPointerEvent<HTMLElement>, id: string | null) => {
    if (event.button !== 0 && event.button !== 2) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    suppress.current = false;
    drag.current = { id, x: event.clientX, y: event.clientY, active: false, node: event.currentTarget, pointerId: event.pointerId, origin: position };
  };
  useLayoutEffect(() => {
    const rect = root.current?.getBoundingClientRect(); if (!rect) return;
    const x = Math.max(8, Math.min(position.x, innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(position.y, innerHeight - rect.height - 8));
    if (x !== position.x || y !== position.y) setPosition({ x, y });
  }, [position, items.length]);
  useEffect(() => { root.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus(); }, []);
  useEffect(() => {
    const targetAt = (event: PointerEvent) => {
      const node = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-visibility-item]");
      const id = node?.dataset.visibilityItem;
      if (!node || !id || !order.includes(id)) return null;
      const rect = node.getBoundingClientRect(); return { id, after: event.clientY > rect.y + rect.height / 2 };
    };
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) onClose(); };
    const cancel = () => { const value = drag.current; if (value?.node.hasPointerCapture(value.pointerId)) value.node.releasePointerCapture(value.pointerId); drag.current = null; setDrop(null); setPreview(null); };
    const move = (event: PointerEvent) => {
      const value = drag.current; if (!value || !value.active && Math.hypot(event.clientX - value.x, event.clientY - value.y) < 8) return;
      value.active = true;
      if (value.id === null) setPosition({ x: value.origin.x + event.clientX - value.x, y: value.origin.y + event.clientY - value.y });
      else { setDrop(targetAt(event)); setPreview({ label: items.find(item => item.id === value.id)?.label ?? "", x: event.clientX, y: event.clientY }); }
    };
    const end = (event: PointerEvent) => {
      const value = drag.current; const target = targetAt(event); cancel();
      if (!value?.active) return;
      suppress.current = true; window.setTimeout(() => { suppress.current = false; }, 0);
      if (value.id && target && target.id !== value.id) onReorder(moveBefore(order, value.id, target.id, target.after));
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { cancel(); onClose(); } };
    window.addEventListener("pointerdown", close); window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel); window.addEventListener("blur", onClose); window.addEventListener("keydown", key);
    window.addEventListener("slh-ui-cancel", onClose);
    return () => {
      window.removeEventListener("pointerdown", close); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", onClose); window.removeEventListener("keydown", key);
      window.removeEventListener("slh-ui-cancel", onClose);
    };
  }, [items, onClose, onReorder, order.join("|")]);
  const Surface = variant === "panel" ? LibraryMenuSurface : "div";
  const HeaderIcon = variant === "panel" ? Stack : GearSix;
  return createPortal(<>
    <Surface ref={root} className={`${variant === "tabs" ? `${styles.menu} ${styles.instanceTabsMenu}` : ""} ${extra.menu} slh-context-menu`} role="menu" aria-label={title} style={{ left: position.x, top: position.y }} data-slh-context-menu="true" onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={event => {
        if (!["ArrowUp", "ArrowDown"].includes(event.key) || event.altKey) return;
        event.preventDefault(); const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }}>
      <header className={variant === "panel" ? library.contextTitle : undefined} onPointerDown={event => begin(event, null)}><HeaderIcon size={17} /><strong>{title}</strong></header>
      <div>{items.map(item => <div key={item.id}>
        {item.separator ? <div className={styles.separator} aria-hidden="true" /> : null}
        <div data-visibility-item={item.id} className={`${styles.itemRow} ${drop?.id === item.id ? drop.after ? styles.insertAfter : styles.insertBefore : ""}`}>
          <button type="button" className={styles.itemToggle} role="menuitemcheckbox" aria-checked={item.checked} disabled={item.disabled} onPointerDown={item.reorderable ? event => begin(event, item.id) : undefined}
            onClick={() => { if (!suppress.current) onToggle(item.id); }}
            onKeyDown={event => { if (!item.reorderable || !event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return; event.preventDefault(); const target = order[order.indexOf(item.id) + (event.key === "ArrowDown" ? 1 : -1)]; if (target) onReorder(moveBefore(order, item.id, target, event.key === "ArrowDown")); }}>
            <span className={styles.check}>{item.checked ? <Check size={16} /> : null}</span><item.Icon size={18} /><span>{item.label}</span>
          </button>
        </div>
      </div>)}</div>
    </Surface>
    {preview ? <div className={styles.dragPreview} style={{ left: preview.x, top: preview.y }} aria-hidden="true">{preview.label}</div> : null}
  </>, document.body);
}
