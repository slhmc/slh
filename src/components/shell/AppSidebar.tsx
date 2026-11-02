import { useUiText } from "../../i18n/UiText";
import {
  Compass,
  GearSix,
  House,
  HardDrives,
  Stack,
} from "../icons";
import { Link, NavLink, useMatch } from "react-router-dom";
import type { MouseEventHandler } from "react";
import { useAppStore } from "../../stores/appStore";
import { BrandLogo } from "../brand/BrandLogo";
import { AccountAvatar } from "../account/AccountAvatar";
import { useI18n } from "../../i18n/I18nProvider";
import styles from "./AppSidebar.module.css";
import type { SidebarNavigationItem } from "../../lib/types";

export const sidebarNavigation = [
  { id: "home" as const, path: "/home", label: "Home", labelKey: "navigation.home", icon: House },
  { id: "library" as const, path: "/library", label: "Library", labelKey: "navigation.library", icon: Stack },
  { id: "discover" as const, path: "/discover", label: "Discover", labelKey: "navigation.discover", icon: Compass },
  { id: "localServers" as const, path: "/local-servers", label: "Local servers", labelKey: "navigation.localServers", icon: HardDrives },
];

export const sidebarSettings = { id: "settings" as const, path: "/settings/general", label: "Settings", labelKey: "navigation.settings", icon: GearSix };
export const defaultSidebarNavigation: SidebarNavigationItem[] = [...sidebarNavigation.map((item) => item.id), sidebarSettings.id];
const allSidebarItems = [...sidebarNavigation, sidebarSettings];

interface AppSidebarProps {
  onContextMenu?: MouseEventHandler<HTMLElement>;
  compact?: boolean;
}

export function AppSidebar({ onContextMenu, compact = false }: AppSidebarProps) {
  const uiText = useUiText();
  const settingsActive = Boolean(useMatch("/settings/*"));
  const { t, tr } = useI18n();
  const bootstrap = useAppStore((state) => state.bootstrap);
  const setAccountOpen = useAppStore((state) => state.setAccountPopoverOpen);
  const active = bootstrap?.accounts.find((account) => account.active) ?? null;
  const visible = new Set(bootstrap?.settings.general.visibleNavigation ?? defaultSidebarNavigation);
  const configured = bootstrap?.settings.general.navigationOrder ?? defaultSidebarNavigation;
  const navigationPosition = bootstrap?.settings.general.navigationPosition ?? "left";
  const positionClass = compact ? styles.compact : navigationPosition === "right"
    ? styles.right
    : navigationPosition === "top"
      ? styles.top
      : navigationPosition === "bottom"
        ? styles.bottomDock
        : styles.left;
  const orderedIds = [...configured, ...defaultSidebarNavigation.filter((id) => !configured.includes(id))];
  const orderedItems = orderedIds.map((id) => allSidebarItems.find((item) => item.id === id)).filter((item): item is (typeof allSidebarItems)[number] => Boolean(item));
  return (
    <>
    <aside className={`${styles.sidebar} ${positionClass}`} data-slh-context-menu="true" onContextMenu={onContextMenu}>
      <div className={styles.brand}>
        <BrandLogo variant="horizontal" />
        <BrandLogo variant="icon" />
      </div>
      <nav className={styles.navigation} aria-label={uiText("shell.texts.mainNavigation", "Main navigation")}>
        {orderedItems.filter((item) => item.id !== sidebarSettings.id && visible.has(item.id)).map(({ id, path, label, labelKey, icon: Icon }) => (
          <NavLink
            key={path}
            to={path}
            data-navigation-item={id}
            data-minimal-navigation
            aria-label={t(labelKey, label)}
            title={t(labelKey, label)}
            className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ""}`}
          >
            <Icon size={20} weight="duotone" />
            <span data-minimal-text>{t(labelKey, label)}</span>
          </NavLink>
        ))}
      </nav>
      <div className={styles.bottom}>
        <button aria-label={active?.username ?? uiText("shell.texts.noAccount", "No account")} className={styles.account} data-account-popover-anchor type="button" onClick={() => setAccountOpen(true)}>
          <AccountAvatar account={active} className={styles.avatar} />
          <span className={styles.accountText}>
            <strong data-minimal-title>{active?.username ?? uiText("shell.texts.noAccount", "No account")}</strong>
            <small data-minimal-text>{active ? `${active.provider} · ${tr(active.authStatus)}` : uiText("shell.texts.chooseAnIdentity", "Choose an identity")}</small>
          </span>
        </button>
        {visible.has(sidebarSettings.id) ? <Link to={sidebarSettings.path} data-navigation-item={sidebarSettings.id} data-minimal-navigation aria-label={t(sidebarSettings.labelKey, sidebarSettings.label)} title={t(sidebarSettings.labelKey, sidebarSettings.label)} aria-current={settingsActive ? "page" : undefined} className={`${styles.navItem} ${settingsActive ? styles.active : ""}`}>
          <GearSix size={20} weight="duotone" />
            <span data-minimal-text>{t(sidebarSettings.labelKey, sidebarSettings.label)}</span>
        </Link> : null}
      </div>
    </aside>
    </>
  );
}
