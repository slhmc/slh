import { useEffect, useRef, useState } from "react";
import { CheckCircle, Info, WarningCircle, X } from "../icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../../stores/appStore";
import { useI18n } from "../../i18n/I18nProvider";
import { command } from "../../lib/tauri";
import common from "./Common.module.css";
import styles from "./ToastCenter.module.css";

export function ToastCenter() {
  const toasts = useAppStore((state) => state.toasts);
  const dismiss = useAppStore((state) => state.dismissToast);
  const pushToast = useAppStore((state) => state.pushToast);
  const bootstrap = useAppStore((state) => state.bootstrap);
  const { tr, isLocalized } = useI18n();
  const destination = bootstrap?.settings.notifications.destination ?? "launcher";
  const attempted = useRef(new Set<string>());
  const [fallbackIds, setFallbackIds] = useState<Set<string>>(() => new Set());
  const errorMessage = (message: string) => {
    if (isLocalized(message)) return tr(message);
    if (/developer mode|режим разработчика/i.test(message)) return tr("Enable Windows Developer Mode in Settings, then retry the Bedrock installation.");
    if (/conflict(?:ing)?.*package|0x80073cf3|higher version of this package/i.test(message)) return tr("Windows found a conflicting Minecraft Store package. Use the Store version or resolve the package conflict before retrying.");
    return tr("Try again. If it continues, check the app log.");
  };

  useEffect(() => {
    if (destination !== "windows") return;
    for (const toast of toasts) {
      if (attempted.current.has(toast.id)) continue;
      attempted.current.add(toast.id);
      const message = toast.message.trim();
      const body = toast.tone === "success"
        ? ""
        : toast.tone === "error"
          ? errorMessage(message)
          : isLocalized(message) ? tr(message, toast.params) : "";
      void command("send_windows_notification", { title: tr(toast.title, toast.params), body: body || null })
        .then(() => dismiss(toast.id))
        .catch(() => setFallbackIds((current) => new Set(current).add(toast.id)));
    }
  }, [destination, dismiss, isLocalized, toasts, tr]);

  const visibleToasts = destination === "windows"
    ? toasts.filter((toast) => fallbackIds.has(toast.id))
    : toasts;
  if (visibleToasts.length === 0) return null;
  return (
    <div className={styles.center} aria-live="polite" aria-relevant="additions">
      {visibleToasts.map((toast) => {
        const Icon = toast.tone === "success" ? CheckCircle : toast.tone === "error" ? WarningCircle : Info;
        const message = toast.message.trim();
        const visibleMessage = toast.tone === "success"
          ? ""
          : toast.tone === "error"
            ? errorMessage(message)
            : isLocalized(message) ? tr(message, toast.params) : "";
        return (
          <div className={`${styles.toast} ${styles[toast.tone]}`} key={toast.id}>
            <Icon size={20} weight="fill" />
            <div>
              <strong>{tr(toast.title, toast.params)}</strong>
              {visibleMessage ? <p>{visibleMessage}</p> : null}
              {toast.action ? <button className={styles.action} type="button" onClick={() => {
                if (toast.action?.message) {
                  pushToast({
                    tone: "info",
                    title: toast.action.title ?? "Why?",
                    message: toast.action.message,
                  });
                } else if (toast.action?.url) {
                  void openUrl(toast.action.url).catch(() => window.open(toast.action!.url, "_blank", "noopener,noreferrer"));
                }
                dismiss(toast.id);
              }}>{tr(toast.action.label)}</button> : null}
            </div>
            <button className={common.iconButton} type="button" onClick={() => dismiss(toast.id)} aria-label={tr("Dismiss notification")}>
              <X size={16} weight="bold" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
