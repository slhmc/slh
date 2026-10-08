import { useEffect } from "react";

/** One coordinator for action menus, including native details and context menus. */
export function useActionMenus() {
  useEffect(() => {
    const selector = "details[data-action-menu][open]";
    let announcing = false;
    const close = (except?: Element | null) => {
      document.querySelectorAll<HTMLDetailsElement>(selector).forEach((menu) => {
        if (menu !== except) menu.open = false;
      });
    };
    const toggle = (event: Event) => {
      const menu = event.target;
      if (!(menu instanceof HTMLDetailsElement) || !menu.hasAttribute("data-action-menu") || !menu.open) return;
      close(menu);
      announcing = true;
      window.dispatchEvent(new Event("slh-context-menu-open"));
      announcing = false;
    };
    const pointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      close(target?.closest("details[data-action-menu]"));
    };
    const click = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button") && target.closest("details[data-action-menu]")) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const menu = document.querySelector<HTMLDetailsElement>(selector);
      menu?.querySelector<HTMLElement>("summary")?.focus();
      close();
    };
    const cancel = () => { if (!announcing) close(); };
    document.addEventListener("toggle", toggle, true);
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key);
    window.addEventListener("slh-context-menu-open", cancel);
    window.addEventListener("slh-ui-cancel", cancel);
    return () => {
      document.removeEventListener("toggle", toggle, true);
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("slh-context-menu-open", cancel);
      window.removeEventListener("slh-ui-cancel", cancel);
    };
  }, []);
}
