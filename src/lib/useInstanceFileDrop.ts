import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isTauri } from "./tauri";

export type FileDropCategory = "mods" | "resourcepacks" | "shaders";
export function fileDropCategory(value: string | undefined | null): FileDropCategory | null {
  return value === "mods" || value === "resourcepacks" || value === "shaders" ? value : null;
}

/** One native listener per instance; current callbacks survive tab navigation. */
export function useInstanceFileDrop(instanceId: string | undefined, options: {
  hover: (category: FileDropCategory) => void;
  drop: (category: FileDropCategory, paths: string[]) => void;
}) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const [over, setOver] = useState<FileDropCategory | null>(null);
  useEffect(() => {
    if (!instanceId) return;
    let alive = true;
    let dispose: (() => void) | undefined;
    const hit = (x: number, y: number) => fileDropCategory(document.elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-instance-file-drop]")?.dataset.instanceFileDrop);
    const hover = (x: number, y: number) => {
      const category = hit(x, y);
      setOver(category);
      if (category) callbacks.current.hover(category);
      return category;
    };
    if (isTauri) {
      void getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (!alive) return;
        if (payload.type === "leave") { setOver(null); return; }
        const category = hover(payload.position.x / window.devicePixelRatio, payload.position.y / window.devicePixelRatio);
        if (payload.type === "drop") {
          setOver(null);
          if (category) callbacks.current.drop(category, payload.paths);
        }
      }).then(unlisten => { if (alive) dispose = unlisten; else unlisten(); }).catch(error => console.error("File drop listener failed", error));
    }
    // Also suppress browser navigation when files are released outside a zone.
    const dragover = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      const category = hover(event.clientX, event.clientY);
      event.dataTransfer.dropEffect = category ? "copy" : "none";
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      const category = hit(event.clientX, event.clientY);
      setOver(null);
      if (!isTauri && category) {
        const paths = Array.from(event.dataTransfer.files).map(file => (file as File & { path?: string }).path).filter((path): path is string => Boolean(path));
        if (paths.length) callbacks.current.drop(category, paths);
      }
    };
    const leave = (event: DragEvent) => { if (!event.relatedTarget) setOver(null); };
    window.addEventListener("dragover", dragover);
    window.addEventListener("drop", drop);
    window.addEventListener("dragleave", leave);
    return () => {
      alive = false;
      dispose?.();
      window.removeEventListener("dragover", dragover);
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragleave", leave);
    };
  }, [instanceId]);
  return over;
}
