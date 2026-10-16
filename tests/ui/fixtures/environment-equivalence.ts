import { MeshStandardMaterial, PMREMGenerator, type Texture, type Scene, type WebGLRenderer, type Mesh } from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { SkinViewEngine } from "../../../src/vendor/mine3d/core/scene-loop";
import { SkinModelType } from "../../../src/vendor/mine3d/types";
import steve from "../../../src/assets/skins/Steve.png?inline";
import alex from "../../../src/assets/skins/Alex.png?inline";

/** Functional pixel comparison, not a resource benchmark. */
export async function compareEnvironment(slim: boolean) {
  const canvas = document.createElement("canvas");
  canvas.style.width = "320px"; canvas.style.height = "400px";
  document.body.append(canvas);
  const engine = new SkinViewEngine(canvas, { transparent:true, enableEffects:false, autoResize:false,
    modelType:slim ? SkinModelType.Slim : SkinModelType.Classic, autoDetectModel:false,
    idleAnimation:false, preserveDrawingBuffer:true, enableClickNudge:false });
  try {
    engine.controls.enableDamping=false;
    engine.setSize(320,400);
    await engine.setSkin(slim ? alex : steve);
    engine.setContactShadowVisible(true);
    engine.fitPlayerToFrame({fillY:.84,maxFillX:.86});
    const internal = engine as unknown as { renderer:WebGLRenderer; scene:Scene; _envMap:Texture };
    const cached = internal._envMap;
    const pmrem = new PMREMGenerator(internal.renderer);
    const room = new RoomEnvironment();
    const original = pmrem.fromScene(room,.04);
    room.dispose(); pmrem.dispose();
    const materials = new Set<MeshStandardMaterial>();
    internal.scene.traverse(node => {
      const mesh=node as Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (material instanceof MeshStandardMaterial && material.envMap === cached) materials.add(material);
      }
    });
    const read = (environment:Texture) => {
      internal.scene.environment=environment;
      materials.forEach(material => { material.envMap=environment; material.needsUpdate=true; });
      engine.renderFrame();
      const gl=internal.renderer.getContext();
      const pixels=new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      return pixels;
    };
    const before=read(original.texture);
    const after=read(cached);
    original.dispose();
    const differences=before.reduce((count,byte,index) => count + Number(byte !== after[index]),0);
    const visible=after.reduce((count,byte,index) => count + Number(index % 4 === 3 && byte !== 0),0);
    return { differences, visible, dataTexture:Boolean((cached as Texture & {isDataTexture?:boolean}).isDataTexture), retainedTarget:Boolean(cached.userData.slhEnvironmentTarget) };
  } finally { engine.dispose(); canvas.remove(); }
}
