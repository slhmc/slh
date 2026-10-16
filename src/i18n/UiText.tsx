import { useSyncExternalStore } from "react";
import { engine } from "./engine";

/** Translate during React rendering, with an explicit subscription for every component. */
export function useUiText() {
  useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  return engine.t;
}
