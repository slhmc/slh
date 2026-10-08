import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { command, isTauri } from "./tauri";
import { subscribeWindowActivity } from "./windowActivity";

export interface UiEvent { sequence: number; name: string; payload: unknown; notified?: boolean }
interface Snapshot { sequence: number; events: UiEvent[] }

/** Subscribe before taking a snapshot so restore cannot lose a completion. */
export function subscribeUiEvents(deliver: (event: UiEvent) => void, restored: () => void): () => void {
  if (!isTauri) return () => {};
  let alive = true;
  let lastSequence = 0;
  let recovering = true;
  let recoveringRequest = false;
  let retry = false;
  let windowActive = true;
  let buffered: UiEvent[] = [];
  let unlisten: UnlistenFn | undefined;
  let unsubscribeActivity: (() => void) | undefined;
  const apply = (event: UiEvent) => {
    if (event.sequence <= lastSequence) return;
    lastSequence = event.sequence;
    deliver(event);
  };
  const recover = async () => {
    if (!alive || !windowActive) return;
    if (recoveringRequest) { retry = true; return; }
    recoveringRequest = true;
    recovering = true;
    try {
      const snapshot = await command<Snapshot>("get_ui_snapshot");
      if (!alive || !windowActive) return;
      const merged = [...snapshot.events, ...buffered].sort((a, b) => a.sequence - b.sequence);
      buffered = [];
      merged.forEach(apply);
      restored();
    } catch { /* Keep the existing screen usable if a refresh fails. */ }
    finally {
      recoveringRequest = false;
      recovering = false;
      if (alive && windowActive) { buffered.sort((a, b) => a.sequence - b.sequence).forEach(apply); buffered = []; }
      if (retry) { retry = false; void recover(); }
    }
  };
  void listen<UiEvent>("slh-ui-event", ({ payload }) => {
    if (!alive) return;
    if (recovering || !windowActive) {
      // At most one progress update per operation plus bounded results.
      if (payload.name === "slh-operation-progress") buffered = buffered.filter((event) => event.name !== payload.name
        || (event.payload as { operationId: string }).operationId !== (payload.payload as { operationId: string }).operationId);
      buffered.push(payload);
      buffered = buffered.slice(-128);
    } else apply(payload);
  }).then((dispose) => {
    if (!alive) { dispose(); return; }
    unlisten = dispose;
    let wasHidden = false;
    unsubscribeActivity = subscribeWindowActivity((active) => {
      windowActive = active;
      if (!active) { wasHidden = true; recovering = true; }
      else if (wasHidden) { wasHidden = false; void recover(); }
    });
    void recover();
  }).catch(() => {});
  return () => { alive = false; buffered = []; unlisten?.(); unsubscribeActivity?.(); };
}
