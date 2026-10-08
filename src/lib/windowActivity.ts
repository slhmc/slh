import { useEffect, useState } from "react";
import { isTauri } from "./tauri";

/** Document visibility plus native minimization; loss of focus alone is not hiding. */
export function subscribeWindowActivity(callback: (visible: boolean) => void): () => void {
  let alive = true;
  let nativeVisible = true;
  let revision = 0;
  let lastVisible: boolean | undefined;
  const unlisten: (() => void)[] = [];
  const notify = () => {
    const visible = !document.hidden && nativeVisible;
    if (alive && visible !== lastVisible) { lastVisible = visible; callback(visible); }
  };
  document.addEventListener("visibilitychange", notify);
  const nativeActivity = (event: Event) => {
    nativeVisible = (event as CustomEvent<boolean>).detail;
    ++revision;
    notify();
  };
  window.addEventListener("slh-native-activity", nativeActivity);
  notify();
  if (isTauri) void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
    const window = getCurrentWindow();
    const refresh = async () => {
      const ticket = ++revision;
      try {
        const [visible, minimized] = await Promise.all([window.isVisible(), window.isMinimized()]);
        if (alive && ticket === revision) { nativeVisible = visible && !minimized; notify(); }
      } catch { /* Document visibility remains the browser fallback. */ }
    };
    for (const listen of [() => window.onResized(refresh), () => window.onFocusChanged(refresh)]) {
      const dispose = await listen();
      if (alive) unlisten.push(dispose); else dispose();
    }
    await refresh();
  }).catch(() => {});
  return () => { alive = false; document.removeEventListener("visibilitychange", notify); window.removeEventListener("slh-native-activity", nativeActivity); unlisten.forEach((dispose) => dispose()); };
}

export function useWindowActivity(): boolean {
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => subscribeWindowActivity(setVisible), []);
  return visible;
}
