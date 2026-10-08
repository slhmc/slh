import {
  ArrowRight,
  Compass,
  GearSix,
  House,
  Stack,
} from "../icons";
import { Link, NavLink, useMatch } from "react-router-dom";
import { useEffect, useRef, useState, type MouseEventHandler } from "react";
import { useAppStore } from "../../stores/appStore";
import { command } from "../../lib/tauri";
import { BrandLogo } from "../brand/BrandLogo";
import { AccountAvatar } from "../account/AccountAvatar";
import { useI18n } from "../../i18n/I18nProvider";
import styles from "./AppSidebar.module.css";
import type { GeneralSettings, SidebarNavigationItem } from "../../lib/types";

export const sidebarNavigation = [
  { id: "home" as const, path: "/home", label: "Home", labelKey: "navigation.home", icon: House },
  { id: "library" as const, path: "/library", label: "Library", labelKey: "navigation.library", icon: Stack },
  { id: "discover" as const, path: "/discover", label: "Discover", labelKey: "navigation.discover", icon: Compass },
];

export const sidebarSettings = { id: "settings" as const, path: "/settings/general", label: "Settings", labelKey: "navigation.settings", icon: GearSix };
export const defaultSidebarNavigation: SidebarNavigationItem[] = [...sidebarNavigation.map((item) => item.id), sidebarSettings.id];
const allSidebarItems = [...sidebarNavigation, sidebarSettings];

type NavigationDockPosition = NonNullable<GeneralSettings["navigationPosition"]>;
type DockDragState = { id: SidebarNavigationItem; x: number; y: number; position: NavigationDockPosition };

function navigationDockPosition(x: number, y: number): NavigationDockPosition {
  const edges: Array<[NavigationDockPosition, number]> = [
    ["left", x],
    ["right", window.innerWidth - x],
    ["top", y],
    ["bottom", window.innerHeight - y],
  ];
  return edges.reduce((nearest, candidate) => candidate[1] < nearest[1] ? candidate : nearest)[0];
}

function dockArrowRotation(position: NavigationDockPosition): number {
  return position === "left" ? 180 : position === "top" ? 270 : position === "bottom" ? 90 : 0;
}

interface AppSidebarProps {
  onContextMenu?: MouseEventHandler<HTMLElement>;
}

export function AppSidebar({ onContextMenu }: AppSidebarProps) {
  const settingsActive = Boolean(useMatch("/settings/*"));
  const { t, tr } = useI18n();
  const bootstrap = useAppStore((state) => state.bootstrap);
  const refresh = useAppStore((state) => state.refresh);
  const setAccountOpen = useAppStore((state) => state.setAccountPopoverOpen);
  const pushToast = useAppStore((state) => state.pushToast);
  const active = bootstrap?.accounts.find((account) => account.active) ?? null;
  const visible = new Set(bootstrap?.settings.general.visibleNavigation ?? defaultSidebarNavigation);
  const configured = bootstrap?.settings.general.navigationOrder ?? defaultSidebarNavigation;
  const navigationPosition = bootstrap?.settings.general.navigationPosition ?? "left";
  const positionClass = navigationPosition === "right"
    ? styles.right
    : navigationPosition === "top"
      ? styles.top
      : navigationPosition === "bottom"
        ? styles.bottomDock
        : styles.left;
  const orderedIds = [...configured, ...defaultSidebarNavigation.filter((id) => !configured.includes(id))];
  const orderedItems = orderedIds.map((id) => allSidebarItems.find((item) => item.id === id)).filter((item): item is (typeof allSidebarItems)[number] => Boolean(item));
  const [dockDrag, setDockDrag] = useState<DockDragState | null>(null);
  const dockDragRef = useRef<{ id: SidebarNavigationItem; startX: number; startY: number; active: boolean } | null>(null);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dockDragRef.current;
      if (!drag) return;
      if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 7) drag.active = true;
      if (!drag.active) return;
      event.preventDefault();
      setDockDrag({ id: drag.id, x: event.clientX, y: event.clientY, position: navigationDockPosition(event.clientX, event.clientY) });
    };
    const onEnd = (event: PointerEvent) => {
      const drag = dockDragRef.current;
      dockDragRef.current = null;
      setDockDrag(null);
      if (!drag?.active) return;
      event.preventDefault();
      const nextPosition = navigationDockPosition(event.clientX, event.clientY);
      if (nextPosition === navigationPosition || !bootstrap) return;
      void command("update_setting", { key: "general", value: { ...bootstrap.settings.general, navigationPosition: nextPosition } satisfies GeneralSettings })
        .then(() => refresh())
        .catch((error) => pushToast({ tone: "error", title: tr("Navigation position was not saved"), message: String((error as { message?: string }).message ?? error) }));
    };
    const cancel = () => { dockDragRef.current = null; setDockDrag(null); };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, [bootstrap, navigationPosition, pushToast, refresh, tr]);

  const beginDockDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (!event.ctrlKey || event.button !== 0) return;
    const source = (event.target as HTMLElement).closest<HTMLElement>("[data-navigation-item]");
    if (!source) return;
    event.preventDefault();
    event.stopPropagation();
    dockDragRef.current = { id: (source.dataset.navigationItem ?? "home") as SidebarNavigationItem, startX: event.clientX, startY: event.clientY, active: false };
  };

  const dockPreviewItem = dockDrag ? allSidebarItems.find((item) => item.id === dockDrag.id) : null;
  const dockPositionClass = dockDrag ? styles[`dockDrop${dockDrag.position[0].toUpperCase()}${dockDrag.position.slice(1)}` as "dockDropLeft" | "dockDropRight" | "dockDropTop" | "dockDropBottom"] : "";
  return (
    <>
    <aside className={`${styles.sidebar} ${positionClass}`} onPointerDown={beginDockDrag} onContextMenu={onContextMenu}>
      <div className={styles.brand}>
        <BrandLogo variant="horizontal" />
        <BrandLogo variant="icon" />
      </div>
      <nav className={styles.navigation} aria-label={tr("Main navigation")}>
        {orderedItems.filter((item) => item.id !== sidebarSettings.id && visible.has(item.id)).map(({ id, path, label, labelKey, icon: Icon }) => (
          <NavLink
            key={path}
            to={path}
            data-navigation-item={id}
            data-minimal-navigation
            aria-label={t(labelKey, label)}
            className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ""}`}
          >
            <Icon size={20} weight="duotone" />
            <span data-minimal-text>{t(labelKey, label)}</span>
          </NavLink>
        ))}
      </nav>
      <div className={styles.bottom}>
        <button className={styles.account} data-account-popover-anchor type="button" onClick={() => setAccountOpen(true)}>
          <AccountAvatar account={active} className={styles.avatar} />
          <span className={styles.accountText}>
            <strong>{active?.username ?? tr("No account")}</strong>
            <small data-minimal-text>{active ? `${active.provider} · ${tr(active.authStatus)}` : tr("Choose an identity")}</small>
          </span>
        </button>
        {visible.has(sidebarSettings.id) ? <Link to={sidebarSettings.path} data-navigation-item={sidebarSettings.id} data-minimal-navigation aria-label={t(sidebarSettings.labelKey, sidebarSettings.label)} aria-current={settingsActive ? "page" : undefined} className={`${styles.navItem} ${settingsActive ? styles.active : ""}`}>
          <GearSix size={20} weight="duotone" />
            <span data-minimal-text>{t(sidebarSettings.labelKey, sidebarSettings.label)}</span>
        </Link> : null}
      </div>
    </aside>
    {dockDrag && dockPreviewItem ? <>
      <div className={`${styles.dockDropIndicator} ${dockPositionClass}`} aria-hidden="true" />
      <div className={styles.dockDragPreview} style={{ left: dockDrag.x, top: dockDrag.y }} aria-hidden="true">
        <ArrowRight size={16} style={{ transform: `rotate(${dockArrowRotation(dockDrag.position)}deg)` }} />
        <Compass size={16} />
        <span>{t("navigation.title", "Navigation")}</span>
      </div>
    </> : null}
    </>
  );
}
