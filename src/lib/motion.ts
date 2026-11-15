import { scaleTransition, useMotionTokens, useShouldReduceMotion } from "@animate-ui/react/utils/motion";
import { useMemo } from "react";
import type { Transition } from "motion/react";
import { useAppStore } from "../stores/appStore";
import { animationConfig, type AnimationKind } from "./animationSettings";

export function useAnimationConfig(kind: AnimationKind) {
  const appearance = useAppStore(state => state.bootstrap?.settings.appearance);
  return animationConfig(appearance, kind);
}
export function useSmoothAnimations(kind: AnimationKind = "icons") {
  const { enabled } = useAnimationConfig(kind);
  const reduce = useShouldReduceMotion();
  return enabled && !reduce;
}
export function useAnimationTransition<T extends Transition>(kind: AnimationKind, base: T): T {
  const { speed } = useAnimationConfig(kind);
  const { tempo } = useMotionTokens();
  return useMemo(() => scaleTransition(base, tempo / speed), [base, tempo, speed]);
}
