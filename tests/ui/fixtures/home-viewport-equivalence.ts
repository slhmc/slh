import { type PlayerObject } from "skin3d";
import { type Scene, type WebGLRenderer, type Texture } from "three";
import { SkinViewEngine } from "../../../src/vendor/mine3d/core/scene-loop";
import { SkinModelType } from "../../../src/vendor/mine3d/types";
import steve from "../../../src/assets/skins/Steve.png?inline";
import alex from "../../../src/assets/skins/Alex.png?inline";

export async function compareHomeViewport(slim: boolean, overlay: boolean) {
  const canvas = document.createElement("canvas");
  canvas.style.width = "320px"; canvas.style.height = "400px";
  document.body.append(canvas);
  const engine = new SkinViewEngine(canvas, { transparent:true, enableEffects:false, autoResize:false,
    modelType:slim ? SkinModelType.Slim : SkinModelType.Classic, autoDetectModel:false,
    idleAnimation:false, preserveDrawingBuffer:true, enableClickNudge:false });
  const internal = engine as unknown as { renderer:WebGLRenderer; scene:Scene; playerObject:PlayerObject };
  try {
    engine.controls.enableDamping = false;
    engine.setSize(320,400);
    const image = new Image(); image.src = slim ? alex : steve; await image.decode();
    const skin = document.createElement("canvas"); skin.width = skin.height = 64;
    const context = skin.getContext("2d")!;
    context.drawImage(image,0,0);
    if (overlay) {
      // Dense voxel shell plus partially transparent detail; keep both paths.
      context.fillStyle = "#397abc"; context.fillRect(32,0,32,16); context.fillRect(0,32,64,32);
      context.fillStyle = "rgba(230,120,30,0.5)"; context.clearRect(42,10,4,4); context.fillRect(42,10,4,4);
    }
    await engine.setSkin(skin);
    engine.setContactShadowVisible(true);
    engine.fitPlayerToFrame({ fillY:.84,maxFillX:.86 });
    const player = internal.playerObject;
    player.skin.head.rotation.set(.12,.4,.04);
    player.skin.leftArm.rotation.x = .17;
    player.skin.rightLeg.rotation.z = -.08;
    const read = () => {
      engine.renderFrame();
      const gl = internal.renderer.getContext();
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      return { pixels, calls:internal.renderer.info.render.calls, triangles:internal.renderer.info.render.triangles };
    };
    const before = read();
    let compactBuffers = true;
    let voxelVertices = 0;
    player.skin.traverse(object => {
      const mesh = object as import("three").Mesh;
      if (!mesh.isMesh || !["outer3d","outer3dGlass"].includes(mesh.name)) return;
      const count = mesh.geometry.getAttribute("position").count;
      voxelVertices += count;
      const index = mesh.geometry.getIndex();
      compactBuffers &&= Boolean(index && new Set(index.array).size === count);
    });
    player.visible = false;
    const shadow = read();
    player.visible = true;
    let shadowOutsideNarrowViewport = 0;
    const narrowWidth = Math.floor(canvas.width * .75);
    const margin = (canvas.width - narrowWidth) / 2;
    for (let pixel=0;pixel<shadow.pixels.length/4;pixel++) {
      const x = pixel % canvas.width;
      if ((x < margin || x >= canvas.width-margin) && shadow.pixels[pixel*4+3] > 1) shadowOutsideNarrowViewport++;
    }
    const originalWidth = canvas.width;
    canvas.style.width = "240px";
    engine.setSize(240,400);
    engine.fitPlayerToFrame({ fillY:.84,maxFillX:.86 });
    const after = read();
    const luts = new Set<Texture>();
    internal.scene.traverse(object => {
      const material = (object as import("three").Mesh).material;
      if (!material) return;
      for (const entry of Array.isArray(material) ? material : [material]) {
        const properties = internal.renderer.properties.get(entry) as {uniforms?:{dfgLUT?:{value?:Texture}}};
        if (properties.uniforms?.dfgLUT?.value) luts.add(properties.uniforms.dfgLUT.value);
      }
    });
    let significant = 0;
    let maximum = 0;
    let difference = 0;
    const left = (originalWidth - canvas.width) / 2;
    after.pixels.forEach((byte,index) => {
      const pixel = Math.floor(index / 4);
      const oldIndex = (Math.floor(pixel / canvas.width) * originalWidth + pixel % canvas.width + left) * 4 + index % 4;
      const delta = Math.abs(byte - before.pixels[oldIndex]);
      maximum = Math.max(maximum,delta); difference += delta;
      if (delta > 3) significant++;
    });
    const visible = after.pixels.reduce((count,byte,index) => count + Number(index % 4 === 3 && byte > 0),0);
    engine.dispose();
    const lutListeners = [...luts].reduce((sum,lut)=>sum+((lut as unknown as {_listeners?:{dispose?:unknown[]}})._listeners?.dispose?.length??0),0);
    return { shadowOutsideNarrowViewport, visible, significant, maximum, difference, compactBuffers, voxelVertices, lutCount:luts.size, lutListeners, channels:after.pixels.length,
      callsBefore:before.calls,callsAfter:after.calls,trianglesBefore:before.triangles,trianglesAfter:after.triangles };
  } finally { engine.dispose(); canvas.remove(); }
}
