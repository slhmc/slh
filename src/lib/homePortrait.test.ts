// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { homePortrait } from "./homePortrait";

const mocks = vi.hoisted(() => ({engines:[] as any[],fail:false}));
vi.mock("../vendor/mine3d/core/scene-loop",() => ({SkinViewEngine:class {
  controls = {enableDamping:true,target:{y:0},object:{position:{set:vi.fn()}},update:vi.fn()};
  lighting = {key:{color:{set:vi.fn()}},fill:{color:{set:vi.fn()}},ambient:{color:{set:vi.fn()}},hemi:{color:{set:vi.fn()}},rim:{intensity:0}};
  getCameraDistance = () => 100; applyLightSettings = vi.fn();
  setSize = vi.fn(); setCursorFollow = vi.fn();
  setContactShadowVisible = vi.fn(); fitPlayerToFrame = vi.fn(); renderFrame = vi.fn(); dispose = vi.fn(); start = vi.fn();
  setSkin = vi.fn(async () => {if (mocks.fail) throw new Error("skin failed");});
  constructor(public canvas:HTMLCanvasElement,public options:unknown) {mocks.engines.push(this);}
}}));
beforeEach(() => {
  mocks.engines.length = 0; mocks.fail = false;
  vi.stubGlobal("crypto",{subtle:{digest:async (_algorithm:string,input:Uint8Array) => input.slice().buffer}});
  vi.spyOn(HTMLCanvasElement.prototype,"toBlob").mockImplementation(callback => callback(new Blob(["portrait"],{type:"image/png"})));
});
afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();});

it("deduplicates image generation, frees its renderer and reuses the PNG without another scene",async () => {
  const skin = {model:"slim" as const,dataUrl:"one-shot-skin"};
  const [first,second] = await Promise.all([homePortrait(skin),homePortrait(skin)]);
  expect(first).toBe(second);
  expect(mocks.engines).toHaveLength(1);
  const engine = mocks.engines[0];
  expect(engine.renderFrame).toHaveBeenCalledOnce();
  expect(engine.start).not.toHaveBeenCalled();
  expect(engine.dispose).toHaveBeenCalledOnce();
  expect(await homePortrait(skin)).toBe(first);
  expect(mocks.engines).toHaveLength(1);
});

it("disposes a failed scene and allows retrying the same skin",async () => {
  const skin = {model:"classic" as const,dataUrl:"retry-skin"};
  mocks.fail = true;
  await expect(homePortrait(skin)).rejects.toThrow("skin failed");
  expect(mocks.engines[0].dispose).toHaveBeenCalledOnce();
  mocks.fail = false;
  expect((await homePortrait(skin)).type).toBe("image/png");
  expect(mocks.engines[1].dispose).toHaveBeenCalledOnce();
});
