import { useEffect, useState } from "react";
import { isTauri } from "./tauri";

const subscribers = new Set<(visible: boolean) => void>();
let stop: (() => void) | undefined;
let nativeVisible = true;
const visibleNow = () => !document.hidden && nativeVisible;

/** One native subscription shared by all views; losing focus is not hiding. */
export function subscribeWindowActivity(callback: (visible: boolean) => void): () => void {
  subscribers.add(callback);
  if (!stop) {
  let alive = true;
  let revision = 0;
  let lastVisible = visibleNow();
  const unlisten: (() => void)[] = [];
  const notify = () => {
    const visible = visibleNow();
    if (alive && visible !== lastVisible) { lastVisible = visible; subscribers.forEach(listener => listener(visible)); }
  };
  document.addEventListener("visibilitychange", notify);
  const nativeActivity = (event: Event) => {
    if (!alive) return;
    nativeVisible = (event as CustomEvent<boolean>).detail;
    ++revision;
    notify();
  };
  window.addEventListener("slh-native-activity", nativeActivity);
  if (isTauri) void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
    const window = getCurrentWindow();
    const refresh = async () => {
      if (!alive) return;
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
  stop = () => { alive = false; document.removeEventListener("visibilitychange", notify); window.removeEventListener("slh-native-activity", nativeActivity); unlisten.forEach((dispose) => dispose()); nativeVisible = true; };
  }
  callback(visibleNow());
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    subscribers.delete(callback);
    if (!subscribers.size) { stop?.(); stop = undefined; }
  };
}

export function useWindowActivity(): boolean {
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => subscribeWindowActivity(setVisible), []);
  return visible;
}
