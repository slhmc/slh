import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { command } from "../lib/tauri";
import { subscribeWindowActivity } from "../lib/windowActivity";
import { useAppStore } from "../stores/appStore";
import { engine, type LocaleSnapshot } from "./engine";

export function I18nProvider({ locale, children }: { locale: string; children: ReactNode }) {
  useEffect(() => {
    let alive = true;
    let visible = true;
    let busy = false;
    let revision: string | undefined;
    let interval: number | undefined;
    const refresh = async (force = false) => {
      if (!alive || !visible || busy) return;
      busy = true;
      try {
        const nextRevision = await command<string>("get_locale_revision", { code: locale });
        if (!alive || (!force && revision === nextRevision)) return;
        const snapshot = await command<LocaleSnapshot>("get_locale_snapshot", { code: locale });
        if (!alive) return;
        engine.apply(snapshot);
        revision = nextRevision;
        const store = useAppStore.getState();
        if (store.bootstrap && JSON.stringify(store.bootstrap.locales) !== JSON.stringify(snapshot.locales)) {
          useAppStore.setState({ bootstrap: { ...store.bootstrap, locales: snapshot.locales } });
        }
      } catch { /* Retain the last working language during a transient read failure. */ }
      finally { busy = false; }
    };
    const unsubscribe = subscribeWindowActivity((active) => {
      visible = active;
      if (active) {
        interval ??= window.setInterval(() => void refresh(), 1500);
        void refresh();
      } else { window.clearInterval(interval); interval = undefined; }
    });
    const onFocus = () => void refresh();
    const forceRefresh = () => void refresh(true);
    window.addEventListener("focus", onFocus);
    window.addEventListener("slh-refresh-languages", forceRefresh);
    void refresh();
    return () => {
      alive = false;
      unsubscribe();
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("slh-refresh-languages", forceRefresh);
    };
  }, [locale]);
  return children;
}

export function useI18n() {
  const state = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  return { locale: state.code, t: engine.t, tr: engine.tr, isLocalized: engine.isLocalized, diagnostics: state.diagnostics };
}
