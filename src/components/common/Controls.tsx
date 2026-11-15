import { isValidElement, type ReactNode } from "react";
import common from "./Common.module.css";
import styles from "./Controls.module.css";
import { SpinnerGap } from "../icons";
import { MorphIcon } from "./MorphIcon";
import { motion, type HTMLMotionProps } from "motion/react";
import { spring } from "@animate-ui/react/utils/motion";
import { useAnimationTransition, useSmoothAnimations } from "../../lib/motion";

export function BusyIndicator({ size = 16 }: { size?: number }) {
  return <SpinnerGap size={size} className={styles.busyIndicator} aria-hidden="true" />;
}

export function Button({ variant = "secondary", className = "", busy = false, icon, children, ...props }: Omit<HTMLMotionProps<"button">, "children"> & { children?: ReactNode; variant?: "primary" | "secondary" | "danger" | "ghost"; busy?: boolean; icon?: ReactNode }) {
  const smooth = useSmoothAnimations("buttons");
  const press = useAnimationTransition("buttons", spring.press);
  const variants = { primary: common.button, secondary: common.secondaryButton, danger: common.dangerButton, ghost: common.ghostButton };
  const iconSize = isValidElement<{ size?: number }>(icon) && typeof icon.props.size === "number" ? icon.props.size : 16;
  return <motion.button type="button" {...props} whileTap={smooth && !props.disabled && !busy ? { scale: 0.97 } : undefined} transition={press} disabled={props.disabled || busy} aria-busy={busy || undefined} className={`${variants[variant]} ${className}`}>{icon || busy ? <MorphIcon size={iconSize} icon={busy ? <SpinnerGap size={iconSize} /> : icon} /> : null}{children}</motion.button>;
}
export function ActionGroup({ children }: { children: ReactNode }) { return <div className={styles.actions}>{children}</div>; }
export function StatusPanel({ tone = "info", title, children }: { tone?: "info" | "warning" | "error" | "success"; title: ReactNode; children: ReactNode }) {
  return <section className={`${styles.status} ${styles[tone]}`} role={tone === "error" ? "alert" : "status"}><h3>{title}</h3>{children}</section>;
}
export function Progress({ label, value, counter }: { label: string; value?: number | null; counter?: string | null }) {
  return <div className={styles.progress} role="status"><div><span className={styles.progressLabel}>{value == null ? <BusyIndicator /> : null}{label}</span>{counter ? <span className={styles.counter}>{counter}</span> : null}</div><progress aria-label={label} max={100} value={value ?? undefined} /></div>;
}
