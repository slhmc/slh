import type { HomeSkin } from "./home";

const databaseName = "slh-home-portrait-v1";
const portraitRevision = "body4-soft-light-v5-relaxed-stance";
let latest: { key:string; blob:Blob } | undefined;
const pending = new Map<string, Promise<Blob>>();
let queue: Promise<unknown> = Promise.resolve();

async function stored(key: string, blob?: Blob): Promise<Blob | undefined> {
  if (typeof indexedDB === "undefined") return;
  return new Promise(resolve => {
    const open = indexedDB.open(databaseName,1);
    open.onupgradeneeded = () => open.result.createObjectStore("portrait");
    open.onerror = open.onblocked = () => resolve(undefined);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("portrait",blob ? "readwrite" : "readonly");
      const store = tx.objectStore("portrait");
      const request = blob ? store.put({key,blob},"last") : store.get("last");
      let result: Blob | undefined;
      request.onsuccess = () => { if (!blob && request.result?.key === key) result = request.result.blob; };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = tx.onabort = () => { db.close(); resolve(undefined); };
    };
  });
}

/** A single PNG is retained on disk. No renderer, canvas or animation loop is cached. */
export async function homePortrait(skin: HomeSkin): Promise<Blob> {
  const hash = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`${portraitRevision}:${skin.model}:${skin.dataUrl}`));
  const key = Array.from(new Uint8Array(hash),byte => byte.toString(16).padStart(2,"0")).join("");
  if (latest?.key === key) return latest.blob;
  const existing = pending.get(key);
  if (existing) return existing;
  const work = queue.catch(() => {}).then(async () => {
    const cached = await stored(key);
    const blob = cached ?? await renderPortrait(skin);
    latest = {key,blob};
    if (!cached) await stored(key,blob);
    return blob;
  });
  queue = work;
  pending.set(key,work);
  try { return await work; }
  finally { pending.delete(key); }
}

async function renderPortrait(skin: HomeSkin): Promise<Blob> {
  const [{SkinViewEngine},{SkinModelType}] = await Promise.all([
    import("../vendor/mine3d/core/scene-loop"), import("../vendor/mine3d/types"),
  ]);
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:480px;height:720px";
  const pose = {speed:1,paused:true,progress:0,controlsLegs:true,
    update(player: import("skin3d").PlayerObject) {
      // Avatar Maker's Body4 joint angles, adapted to skin3d's pivots.
      player.rotation.set(.3,.25,0);
      player.skin.head.rotation.set(-.26,-.3,-.1);
      player.skin.body.rotation.set(-.1,0,0);
      player.skin.leftArm.rotation.set(.08,0,0);
      player.skin.rightArm.rotation.set(.08,0,0);
      player.skin.leftLeg.rotation.set(-.06,0,0);
      player.skin.rightLeg.rotation.set(-.06,0,0);
      player.skin.leftLeg.position.x = 2.2;
      player.skin.rightLeg.position.x = -2.2;
    }};
  const engine = new SkinViewEngine(canvas,{autoResize:false,transparent:true,enableEffects:false,
    enableControls:false,enableClickNudge:false,enableAltPan:false,preserveDrawingBuffer:true,
    autoDetectModel:false,modelType:skin.model === "slim" ? SkinModelType.Slim : SkinModelType.Classic,
    idleAnimation:pose,fov:15});
  try {
    engine.setSize(480,720);
    await engine.setSkin(skin.dataUrl!);
    engine.setCursorFollow(false);
    engine.setContactShadowVisible(false);
    engine.controls.enableDamping = false;
    const camera = engine.controls.object;
    camera.position.set(0,engine.controls.target.y,engine.getCameraDistance());
    engine.controls.update();
    engine.fitPlayerToFrame({fillY:.82,maxFillX:.8});
    engine.applyLightSettings({keyAzimuthDeg:25,keyElevationDeg:35,keyIntensity:1.1,
      ambientIntensity:.65,fillIntensity:.65,shadowIntensity:.35,shadowRadius:7});
    engine.lighting.key.color.set(0xffffff);
    engine.lighting.fill.color.set(0xffffff);
    engine.lighting.ambient.color.set(0xffffff);
    engine.lighting.hemi.color.set(0xffffff);
    engine.lighting.rim.intensity = .15;
    engine.renderFrame();
    return await new Promise<Blob>((resolve,reject) => canvas.toBlob(blob =>
      blob ? resolve(blob) : reject(new Error("Portrait encoding failed")),"image/png"));
  } finally { engine.dispose(); }
}
