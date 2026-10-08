import { Outlet } from "react-router-dom";
import { lazy, Suspense, useCallback, useState } from "react";
import type { MouseEvent } from "react";
import { ActivityBar } from "./ActivityBar";
import { AccountPopover } from "./AccountPopover";
import { AppSidebar } from "./AppSidebar";
import { Titlebar } from "./Titlebar";
const CreateInstanceWizard = lazy(() => import("../instance/CreateInstanceWizard").then((module) => ({ default: module.CreateInstanceWizard })));
import { ToastCenter } from "../common/ToastCenter";
import { NavigationContextMenu } from "./NavigationContextMenu";
import styles from "./AppShell.module.css";
import { useAppStore } from "../../stores/appStore";

export function AppShell() {
  const bootstrap = useAppStore((state) => state.bootstrap);
  const wizardOpen = useAppStore((state) => state.createWizardOpen);
  const [navigationMenuPosition, setNavigationMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const closeNavigationMenu = useCallback(() => setNavigationMenuPosition(null), []);
  const navigationPosition = bootstrap?.settings.general.navigationPosition ?? "left";
  const navigationPositionClass = navigationPosition === "right"
    ? styles.navRight
    : navigationPosition === "top"
      ? styles.navTop
      : navigationPosition === "bottom"
        ? styles.navBottom
        : styles.navLeft;

  const openNavigationMenu = useCallback((event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    window.dispatchEvent(new Event("slh-context-menu-open"));
    setNavigationMenuPosition({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 244)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 300)),
    });
  }, []);

  return (
    <div className={styles.app} onContextMenu={(event) => event.preventDefault()}>
      <Titlebar />
      <div className={`${styles.workspace} ${navigationPositionClass}`}>
        <AppSidebar onContextMenu={openNavigationMenu} />
        <main className={styles.content}>
          <Outlet />
        </main>
      </div>
      <ActivityBar />
      <AccountPopover />
      {wizardOpen ? <Suspense fallback={null}><CreateInstanceWizard /></Suspense> : null}
      <ToastCenter />
      <NavigationContextMenu position={navigationMenuPosition} onClose={closeNavigationMenu} />
    </div>
  );
}
