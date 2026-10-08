import { useEffect, useRef, useState } from "react";
import type { SkinViewer } from "skinview3d";
import { subscribeWindowActivity } from "../../lib/windowActivity";
import { loadSkinImage } from "../../vendor/mine3d/core/skin-image";
import styles from "./MinecraftSkinViewer.module.css";

interface Props {
  skin: string | null;
  cape?: string | null;
  model?: "classic" | "slim";
  interactive?: boolean;
  compact?: boolean;
  label: string;
}

function disposeViewer(viewer: SkinViewer | undefined, canvas: HTMLCanvasElement): void {
  if (!viewer || viewer.disposed) return;
  const resources = new Set<{ dispose(): void }>();
  viewer.playerObject.traverse((node) => {
    const mesh = node as unknown as { geometry?: { dispose(): void }; material?: { dispose(): void } | { dispose(): void }[] };
    if (mesh.geometry) resources.add(mesh.geometry);
    if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) resources.add(material);
  });
  // skinview3d 3.4 disposes textures and renderer, but leaves geometry and composer targets.
  viewer.dispose();
  (viewer as unknown as { composer: { dispose(): void } }).composer.dispose();
  resources.forEach((resource) => resource.dispose());
  const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  context?.getExtension("WEBGL_lose_context")?.loseContext();
}

export function MinecraftSkinViewer({ skin, cape = null, model = "classic", interactive = false, compact = false, label }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [sceneEpoch, setSceneEpoch] = useState(0);
  const cameraPosition = useRef<{ x: number; y: number; z: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<SkinViewer | null>(null);
  const capeLoaderRef = useRef<((source: string | null) => void) | null>(null);
  const capeRef = useRef(cape);
  capeRef.current = cape;

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas || !skin) return undefined;

    let alive = true;
    let released = false;
    let visible = !document.hidden;
    let viewer: SkinViewer | undefined;
    let observer: ResizeObserver | undefined;
    let frame = 0;
    let lastFrame = 0;
    let capeTicket = 0;
    const render = (timestamp: number) => {
      if (!alive || !visible || !viewer) { frame = 0; return; }
      if (timestamp - lastFrame < 1000 / 60 - .5) { frame = requestAnimationFrame(render); return; }
      lastFrame = timestamp;
      const changed = viewer.controls.update();
      viewer.render();
      frame = changed ? requestAnimationFrame(render) : 0;
    };
    const invalidate = () => { if (alive && visible && !frame) frame = requestAnimationFrame(render); };
    const unsubscribe = subscribeWindowActivity((active) => {
      visible = active;
      if (active && released) { setSceneEpoch((epoch) => epoch + 1); return; }
      if (active) invalidate(); else { cancelAnimationFrame(frame); frame = 0; }
    });
    const release = () => {
      if (visible || released) return;
      released = true;
      alive = false;
      if (viewer) { const { x, y, z } = viewer.camera.position; cameraPosition.current = { x, y, z }; }
      cancelAnimationFrame(frame);
      observer?.disconnect();
      viewer?.controls.removeEventListener("change", invalidate);
      disposeViewer(viewer, canvas);
      viewer = undefined;
      viewerRef.current = null;
      capeLoaderRef.current = null;
    };
    window.addEventListener("slh-release-scenes", release);
    void import("skinview3d").then(async ({ SkinViewer }) => {
      if (!alive) return;
      viewer = new SkinViewer({
        canvas,
        width: Math.max(1, host.clientWidth),
        height: Math.max(1, host.clientHeight),
        renderPaused: true,
        model: model === "classic" ? "default" : "slim",
        enableControls: interactive,
        pixelRatio: "match-device",
        fov: 40,
        zoom: compact ? 0.72 : 0.78,
      });
      // Keep the selected arm model authoritative.  skinview3d can auto-detect
      // a texture when it is replaced, which used to make slim skins render with
      // classic (wide) arms in the preview.
      viewer.playerObject.skin.modelType = model === "classic" ? "default" : "slim";
      // The library uses nearest-neighbour filtering for Minecraft textures.
      // Keep its final compositor enabled: besides edge processing it performs
      // the correct final colour output for the WebGL canvas.
      viewer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
      viewer.playerWrapper.rotation.y = 0.28;
      viewer.controls.enablePan = false;
      viewer.controls.enableZoom = false;
      viewer.controls.enableRotate = interactive;
      viewer.controls.minPolarAngle = Math.PI / 2;
      viewer.controls.maxPolarAngle = Math.PI / 2;
      if (cameraPosition.current) {
        const { x, y, z } = cameraPosition.current;
        viewer.camera.position.set(x, y, z);
        viewer.controls.update();
      }
      viewerRef.current = viewer;
      const loadCape = (source: string | null) => {
        const ticket = ++capeTicket;
        if (!source) { viewer?.loadCape(null); invalidate(); return; }
        void loadSkinImage(source).then((image) => {
          if (alive && ticket === capeTicket && viewer && !viewer.disposed) { viewer.loadCape(image); invalidate(); }
        }).catch(() => {});
      };
      capeLoaderRef.current = loadCape;
      viewer.controls.addEventListener("change", invalidate);

      observer = new ResizeObserver(() => {
        viewer?.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
        invalidate();
      });
      observer.observe(host);
      const skinImage = await loadSkinImage(skin);
      if (!alive) return;
      viewer.loadSkin(skinImage, { model: model === "classic" ? "default" : "slim" });
      loadCape(capeRef.current);
      invalidate();
    }).catch(() => {
      if (alive) {
        alive = false; unsubscribe(); cancelAnimationFrame(frame); observer?.disconnect();
        viewer?.controls.removeEventListener("change", invalidate);
        disposeViewer(viewer, canvas); viewerRef.current = null; capeLoaderRef.current = null;
      }
    });
    return () => {
      alive = false;
      unsubscribe();
      window.removeEventListener("slh-release-scenes", release);
      cancelAnimationFrame(frame);
      observer?.disconnect();
      if (viewerRef.current === viewer) viewerRef.current = null;
      capeLoaderRef.current = null;
      viewer?.controls.removeEventListener("change", invalidate);
      disposeViewer(viewer, canvas);
    };
  }, [compact, interactive, model, skin, sceneEpoch]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    capeLoaderRef.current?.(cape);
  }, [cape]);

  return (
    <div ref={hostRef} className={`${styles.viewer} ${compact ? styles.compact : ""}`} role="img" aria-label={label}>
      {skin ? <canvas key={`${skin}:${model}:${sceneEpoch}`} ref={canvasRef} /> : <div className={styles.empty} />}
    </div>
  );
}
