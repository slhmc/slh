import { expect, it } from "vitest";
import { Box3, BoxGeometry, Mesh } from "three";
import { PlayerObject } from "skin3d";
import { homePoseBounds, stabilizeHomePose } from "./homeCharacterPose";
import { applyStockLegPose } from "../vendor/mine3d/core/skin-leg-stock";
import { createSkinAnimation, resetLimbPose } from "../vendor/mine3d/core/skin-animations";
import { homeEmotes } from "./home";
import { OuterVoxelLayers } from "../vendor/mine3d/core/skin-outer-voxel";

it("uses the same Three.js constructors for model and engine so outer layers retain their size", () => {
  const player = new PlayerObject();
  expect(player.skin.head.outerLayer).toBeInstanceOf(Mesh);
  expect((player.skin.head.outerLayer as Mesh).geometry).toBeInstanceOf(BoxGeometry);
  expect(((player.skin.head.outerLayer as Mesh).geometry as BoxGeometry).parameters.width).toBe(9);
  expect(((player.skin.head.innerLayer as Mesh).geometry as BoxGeometry).parameters.width).toBe(8);
});

it("places the extruded face half a model pixel ahead of the base layer", () => {
  const player = new PlayerObject();
  const rgba = new Uint8ClampedArray(64 * 64 * 4);
  for (let y = 8; y < 16; y++) for (let x = 40; x < 48; x++) rgba[(y * 64 + x) * 4 + 3] = 255;
  const canvas = { width: 64, height: 64, getContext: () => ({ getImageData: () => ({ data: rgba }) }) } as unknown as HTMLCanvasElement;
  const layers = new OuterVoxelLayers();
  layers.rebuild(player.skin, canvas, false);
  const shell = player.skin.head.getObjectByName("outer3dGroup")!;
  expect(shell).toBeDefined();
  expect(shell.scale.z).toBeCloseTo(9 / 8);
  player.updateWorldMatrix(true, true);
  const outside = new Box3().setFromObject(shell).max.z;
  const inside = new Box3().setFromObject(player.skin.head.innerLayer).max.z;
  expect(outside - inside).toBeCloseTo(.5);
  layers.dispose(player.skin);
});

it("anchors standing poses without drift and preserves deliberate jumping", () => {
  const player = new PlayerObject();
  applyStockLegPose(player.skin);
  const bounds = homePoseBounds();
  for (let frame = 0; frame < 100; frame++) {
    player.position.set(4, 0, 3);
    player.skin.leftLeg.rotation.x = Math.sin(frame / 10) * .1;
    stabilizeHomePose(player, true, bounds);
    player.updateWorldMatrix(true, true);
    bounds.makeEmpty().expandByObject(player.skin.leftLeg).expandByObject(player.skin.rightLeg);
    expect(bounds.min.y).toBeCloseTo(-16);
    expect(player.position.x).toBe(0);
    expect(player.position.z).toBe(0);
  }
  player.position.set(3, 1.6, 2);
  stabilizeHomePose(player, false, bounds);
  expect(player.position.y).toBe(1.6);
});

it("includes every non-idle built-in animation and produces finite poses throughout the clips", () => {
  expect(homeEmotes).toHaveLength(9);
  const player = new PlayerObject();
  for (const id of homeEmotes) {
    const animation = createSkinAnimation(id === "pose" ? "cool" : id);
    for (let frame = 0; frame < 240; frame++) {
      resetLimbPose(player);
      animation.update(player, 1 / 60);
      expect(player.position.toArray().every(Number.isFinite)).toBe(true);
      expect(player.skin.head.rotation.toArray().slice(0, 3).every((value) => Number.isFinite(value))).toBe(true);
    }
  }
});
