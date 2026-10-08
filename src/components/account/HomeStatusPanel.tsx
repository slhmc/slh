import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { openPath } from "@tauri-apps/plugin-opener";
import { ArrowRight } from "../icons";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n/I18nProvider";
import { storageUsageCache as storageCache } from "../../lib/storageUsage";
import { useWindowActivity } from "../../lib/windowActivity";
import { command } from "../../lib/tauri";
import { homeStatusIds, homeStatusItems, homeStatusOrder } from "../../lib/homeStatus";
import { HomeStatusContextMenu } from "./HomeStatusContextMenu";
import common from "../common/Common.module.css";
import styles from "./HomeStatusPanel.module.css";

export function HomeStatusPanel() {
  const { tr, locale } = useI18n();
  const navigate = useNavigate();
  const bootstrap = useAppStore((state) => state.bootstrap);
  const activities = useAppStore((state) => state.activities);
  const pushToast = useAppStore((state) => state.pushToast);
  const [storageBytes, setStorageBytes] = useState(() => storageCache.peek(bootstrap?.portableRoot ?? "", true));
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setPosition(null), []);
  const visible = new Set(bootstrap?.settings.appearance.homeStatusVisible ?? homeStatusIds);
  const windowActive = useWindowActivity();
  const storage = visible.has("storage");

  useEffect(() => {
    const root = bootstrap?.portableRoot;
    if (!storage || !root) return;
    let alive = true;
    let pending = false;
    let dirty = false;
    const load = async (force = false) => {
      dirty ||= force;
      if (!alive || !windowActive || document.hidden || pending) return;
      pending = true;
      const refresh = dirty;
      dirty = false;
      if (refresh) storageCache.invalidate(root);
      try {
        const value = await storageCache.load(root, () => command<number>("get_launcher_storage_usage", { force: true }));
        if (alive) setStorageBytes(value);
      } catch { if (alive) setStorageBytes(undefined); }
      finally { pending = false; if (alive && dirty) void load(); }
    };
    const changed = () => { storageCache.invalidate(root); void load(true); };
    void load();
    window.addEventListener("slh-storage-changed", changed);
    return () => { alive = false; window.removeEventListener("slh-storage-changed", changed); };
  }, [storage, bootstrap?.portableRoot, windowActive]);

  if (!bootstrap) return null;
  const bytes = (value: number) => {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    const index = value > 0 ? Math.min(4, Math.floor(Math.log(value) / Math.log(1024))) : 0;
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: index ? 1 : 0 }).format(value / 1024 ** index)} ${units[index]}`;
  };
  const values: Record<string, string> = {
    launcher: tr("Local"), java: bootstrap.settings.minecraft.javaMode === "auto" ? tr("Automatic") : tr("Custom"),
    downloads: activities.length ? `${activities.length} ${tr("active")}` : tr("No active downloads"),
    storage: storageBytes != null ? bytes(storageBytes) : "—",
    folder: bootstrap.portableRoot,
  };
  const routes: Record<string, string> = { launcher: "/settings/advanced", java: "/settings/java", downloads: "/settings/downloads", storage: "/settings/storage" };
  const ids = homeStatusOrder(bootstrap.settings.appearance.homeStatusOrder).filter((id) => visible.has(id));

  return <section className={styles.card} onContextMenu={(event) => {
    event.preventDefault(); event.stopPropagation();
    window.dispatchEvent(new Event("slh-context-menu-open"));
    setPosition({ x: event.clientX, y: event.clientY });
  }}>
    <h2>{tr("Launcher status")}<span className={common.badge}>v{bootstrap.version}</span></h2>
    {ids.map((id) => {
      const { label, icon: Icon } = homeStatusItems.find((item) => item.id === id)!;
      const content = <><Icon size={18} /><span>{tr(label)}</span><small>{values[id]}</small>{id === "java" ? <ArrowRight size={14} /> : null}</>;
      return <div key={id}>
        {routes[id] || id === "folder" ? <button className={styles.row} type="button" title={id === "storage" ? tr("Size of the launcher folder, including builds, resources and backups.") : values[id]} onClick={() => {
          if (id === "folder") void openPath(bootstrap.portableRoot).catch((error) => pushToast({ tone: "error", title: tr("Data folder"), message: String(error) }));
          else navigate(routes[id]);
        }}>{content}</button> : <div className={styles.row} title={values[id]}>{content}</div>}
      </div>;
    })}
    <HomeStatusContextMenu position={position} onClose={closeMenu} />
  </section>;
}
