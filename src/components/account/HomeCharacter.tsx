import { useEffect, useRef, useState } from "react";
import type { Account } from "../../lib/types";
import { command } from "../../lib/tauri";
import { subscribeWindowActivity } from "../../lib/windowActivity";
import type { HomeSkin } from "../../lib/home";
import { homeCharacterFps } from "../../lib/homeCharacterFps";
import { homeSkinCache, homeSkinKey, initialHomeSkin, readHomeView, saveHomeView } from "../../lib/homeCharacterState";
import type { SkinViewEngine } from "../../vendor/mine3d/core/scene-loop";
import { useI18n } from "../../i18n/I18nProvider";
import styles from "./HomeCharacter.module.css";

export function HomeCharacter({ account, frameRate }: { account: Account | null; frameRate?: number }) {
  const fps = homeCharacterFps(frameRate);
  const { tr } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const fallbackCanvas = useRef<HTMLCanvasElement>(null);
  const [skin, setSkin] = useState<HomeSkin>(() => initialHomeSkin(account));
  const [failed, setFailed] = useState(false);
  const [sceneEpoch, setSceneEpoch] = useState(0);
  const view = useRef(readHomeView());
  const [scale, setScale] = useState(view.current.scale);

  useEffect(() => {
    let alive = true;
    const fallback = initialHomeSkin(account);
    let ticket = 0;
    setSkin(fallback);
    const load = async () => {
      const current = ++ticket;
      if (!account || account.provider === "offline") return;
      try {
        const result = await homeSkinCache.load(homeSkinKey(account), () => command<HomeSkin>("get_home_account_skin", { accountId: account.id }));
        if (alive && current === ticket && result.dataUrl) setSkin(result);
      } catch { /* The bundled default remains usable without a network. */ }
    };
    const refresh = (event: Event) => {
      if (account && (event as CustomEvent<string>).detail === account.id) {
        homeSkinCache.invalidate(homeSkinKey(account));
        void load();
      }
    };
    void load();
    window.addEventListener("slh-account-avatar-updated", refresh);
    return () => { alive = false; window.removeEventListener("slh-account-avatar-updated", refresh); };
  }, [account?.id, account?.provider, account?.providerUuid]);

  useEffect(() => {
    const element = canvas.current;
    const container = host.current;
    if (!element || !container || !skin.dataUrl) return;
    let alive = true;
    let released = false;
    let engine: SkinViewEngine | undefined;
    let observer: ResizeObserver | undefined;
    let saveTimer: number | undefined;
    let visible = !document.hidden;
    let resize = () => {};
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1);
      view.current.scale = Math.max(.2, Math.min(1, view.current.scale * Math.exp(-pixels * .0015)));
      setScale(view.current.scale);
      saveHomeView(view.current);
      resize();
    };
    const rememberRotation = () => {
      if (!engine) return;
      view.current.yaw = engine.controls.getAzimuthalAngle();
      if (saveTimer === undefined) saveTimer = window.setTimeout(() => { saveTimer = undefined; saveHomeView(view.current); }, 200);
    };
    const visibility = (active: boolean) => {
      visible = active;
      if (active && released) {
        setSceneEpoch((epoch) => epoch + 1);
        return;
      }
      if (engine) {
        engine.setAnimationActive(visible, visible);
        if (!visible) {
          engine.stop();
          window.clearTimeout(saveTimer);
          saveTimer = undefined;
          saveHomeView(view.current);
        }
      }
    };
    const lost = (event: Event) => { event.preventDefault(); observer?.disconnect(); engine?.dispose(); engine = undefined; setFailed(true); };
    const release = () => {
      if (visible || released) return;
      released = true;
      alive = false;
      observer?.disconnect();
      engine?.controls.removeEventListener("change", rememberRotation);
      element.removeEventListener("webglcontextlost", lost);
      engine?.dispose();
      engine = undefined;
      window.clearTimeout(saveTimer);
      saveHomeView(view.current);
    };
    setFailed(false);
    void Promise.all([import("../../vendor/mine3d/core/scene-loop"), import("../../vendor/mine3d/core/skin-animations"), import("../../vendor/mine3d/types"), import("../../lib/homeCharacterPose")]).then(async ([renderer, animations, types, poses]) => {
      if (!alive) return;
      engine = new renderer.SkinViewEngine(element, {
        autoResize: false, modelType: skin.model === "slim" ? types.SkinModelType.Slim : types.SkinModelType.Classic,
        autoDetectModel: false, transparent: true, enableEffects: false, enableControls: true, enableClickNudge: false, enableAltPan: false,
        zoom: 0.9, fov: 35, idleAnimation: new animations.HeroIdleAnimation(),
      });
      engine.controls.enablePan = false;
      engine.setRenderOnDemand(true);
      engine.setAnimationFrameRate(fps);
      engine.controls.enableZoom = false;
      engine.controls.enableDamping = true;
      engine.controls.dampingFactor = 0.08;
      engine.controls.autoRotate = false;
      const angle = engine.controls.getPolarAngle();
      engine.controls.minPolarAngle = angle;
      engine.controls.maxPolarAngle = angle;
      engine.setContactShadowVisible(true);
      engine.setCursorFollow(false);
      const bounds = poses.homePoseBounds();
      engine.setPoseHook(({ player }) => poses.stabilizeHomePose(player, true, bounds));
      resize = () => {
        engine?.setSize(container.clientWidth, container.clientHeight);
        engine?.fitPlayerToFrame({ fillY: .84 * view.current.scale, maxFillX: .86 * view.current.scale, offsetY: .015 });
        if (visible) engine?.start();
      };
      resize();
      observer = new ResizeObserver(resize);
      observer.observe(container);
      await engine.setSkin(skin.dataUrl!);
      if (!alive) return;
      await engine.setCape(null);
      if (!alive) return;
      resize();
      if (view.current.yaw !== undefined) {
        const camera = engine.controls.object;
        const target = engine.controls.target;
        const distance = engine.getCameraDistance();
        const yaw = view.current.yaw;
        camera.position.set(target.x + distance * Math.sin(angle) * Math.sin(yaw), target.y + distance * Math.cos(angle), target.z + distance * Math.sin(angle) * Math.cos(yaw));
        engine.controls.update();
      }
      engine.controls.addEventListener("change", rememberRotation);
      engine.setAnimationActive(visible, visible);
      if (!visible) engine.stop();
    }).catch(() => { if (alive) { engine?.dispose(); engine = undefined; setFailed(true); } });
    container.addEventListener("wheel", wheel, { passive: false, capture: true });
    element.addEventListener("webglcontextlost", lost);
    window.addEventListener("slh-release-scenes", release);
    const unsubscribeActivity = subscribeWindowActivity(visibility);
    return () => {
      engine?.controls.removeEventListener("change", rememberRotation);
      window.clearTimeout(saveTimer);
      saveHomeView(view.current);
      container.removeEventListener("wheel", wheel, true);
      alive = false; observer?.disconnect();
      element.removeEventListener("webglcontextlost", lost); unsubscribeActivity();
      window.removeEventListener("slh-release-scenes", release);
      engine?.dispose();
    };
  }, [skin.dataUrl, skin.model, fps, sceneEpoch]);

  useEffect(() => {
    if (!failed || !skin.dataUrl) return;
    let alive = true;
    const image = new Image();
    image.onload = () => {
      const target = fallbackCanvas.current;
      if (!alive || !target) return;
      const context = target.getContext("2d");
      if (!context) return;
      target.width = 160; target.height = 320; context.imageSmoothingEnabled = false;
      const scale = image.width / 64;
      const part = (x: number, y: number, w: number, h: number, dx: number, dy: number) => context.drawImage(image, x*scale, y*scale, w*scale, h*scale, dx, dy, w*10, h*10);
      part(8,8,8,8,40,0); part(40,8,8,8,40,0); part(20,20,8,12,40,80); part(20,36,8,12,40,80);
      const arm = skin.model === "slim" ? 3 : 4;
      part(44,20,arm,12,40-arm*10,80); part(44,36,arm,12,40-arm*10,80);
      part(36,52,arm,12,120,80); part(52,52,arm,12,120,80);
      part(4,20,4,12,40,200); part(4,36,4,12,40,200); part(20,52,4,12,80,200); part(4,52,4,12,80,200);
    };
    image.src = skin.dataUrl;
    return () => { alive = false; image.onload = null; };
  }, [failed, skin]);

  return <div ref={host} className={styles.host} role="group"
    aria-label={`${account?.username ?? tr("Offline")}. ${tr("Drag to rotate. Ctrl + wheel to zoom.")}`}>
    {/* A disposed WebGL context belongs to its canvas. A new skin gets a fresh
        canvas so delayed context-loss events cannot break its new renderer. */}
    <canvas key={`${skin.model}:${skin.dataUrl}:${fps}:${sceneEpoch}`} ref={canvas} className={failed ? styles.hidden : styles.canvas} />
    {failed ? <canvas ref={fallbackCanvas} className={styles.flat} style={{ height: `${82 * scale}%` }} aria-hidden="true" /> : null}
  </div>;
}
