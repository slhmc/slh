import { cloneElement, isValidElement, useEffect, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { ReducedMotionConfig } from "@animate-ui/react/utils/motion";
import { SpinnerGap, type PixelIconProps } from "../icons";
import { useAnimationTransition, useSmoothAnimations } from "../../lib/motion";
import { iconMorphPaths } from "./iconMorphPaths";
import styles from "./MorphIcon.module.css";
const stateTransition = { duration: 0.3, ease: "easeInOut" as const };

export function MorphIcon({ icon, size }: { icon: ReactNode; size?: number }) {
  return <ReducedMotionConfig><IconShape icon={icon} size={size} /></ReducedMotionConfig>;
}

function IconShape({ icon, size }: { icon: ReactNode; size?: number }) {
  const smooth = useSmoothAnimations();
  const [moving, setMoving] = useState(false);
  const element = isValidElement<PixelIconProps>(icon) ? icon : null;
  const dimension = size ?? (typeof element?.props.size === "number" ? element.props.size : 16);
  const spinning = element?.type === SpinnerGap;
  const target = iconMorphPaths.get(element?.type);
  const morph = useAnimationTransition("icons", stateTransition);
  useEffect(() => { if (!smooth) setMoving(false); }, [smooth]);
  return <span className={`${styles.icon} ${spinning ? styles.spinning : ""}`} style={{ width: dimension, height: dimension }} aria-hidden="true" data-morph-icon data-icon-state={spinning ? "busy" : "idle"} data-morphing={moving || undefined}>
    {target ? <motion.svg viewBox="0 0 24 24" width={dimension} height={dimension} fill="currentColor" initial={false}>
      <motion.path data-morph-geometry initial={false} animate={{ d: target }} transition={smooth ? morph : { duration: 0 }} onAnimationStart={() => setMoving(smooth)} onAnimationComplete={() => setMoving(false)} />
    </motion.svg> : <span className={styles.source}>{element ? cloneElement(element, { size: dimension, className: undefined }) : icon}</span>}
  </span>;
}
