import type { ButtonHTMLAttributes, ReactNode } from "react";
import common from "./Common.module.css";
import styles from "./Controls.module.css";
import { ArrowsClockwise } from "../icons";

export function BusyIndicator({ size = 16 }: { size?: number }) {
  return <ArrowsClockwise size={size} className={styles.busyIndicator} aria-hidden="true" />;
}

export function Button({ variant = "secondary", className = "", busy = false, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; busy?: boolean }) {
  const variants = { primary: common.button, secondary: common.secondaryButton, danger: common.dangerButton, ghost: common.ghostButton };
  return <button type="button" {...props} disabled={props.disabled || busy} aria-busy={busy || undefined} className={`${variants[variant]} ${className}`}>{busy ? <BusyIndicator /> : null}{children}</button>;
}
export function ActionGroup({ children }: { children: ReactNode }) { return <div className={styles.actions}>{children}</div>; }
export function StatusPanel({ tone = "info", title, children }: { tone?: "info" | "warning" | "error" | "success"; title: ReactNode; children: ReactNode }) {
  return <section className={`${styles.status} ${styles[tone]}`} role={tone === "error" ? "alert" : "status"}><h3>{title}</h3>{children}</section>;
}
export function Progress({ label, value, counter }: { label: string; value?: number | null; counter?: string | null }) {
  return <div className={styles.progress} role="status"><div><span className={styles.progressLabel}>{value == null ? <BusyIndicator /> : null}{label}</span>{counter ? <span className={styles.counter}>{counter}</span> : null}</div><progress aria-label={label} max={100} value={value ?? undefined} /></div>;
}
