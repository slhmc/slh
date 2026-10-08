// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MinecraftSkinViewer } from "./MinecraftSkinViewer";

const mocks = vi.hoisted(() => ({ viewers: [] as any[], loadImage: vi.fn(), activity: null as null | ((visible: boolean) => void) }));
vi.mock("../../vendor/mine3d/core/skin-image", () => ({ loadSkinImage: mocks.loadImage }));
vi.mock("../../lib/windowActivity", () => ({ subscribeWindowActivity: (callback: (visible: boolean) => void) => { mocks.activity = callback; callback(true); return vi.fn(); } }));
vi.mock("skinview3d", () => ({ SkinViewer: class {
  camera = { position: { x: 0, y: 0, z: 50, set: vi.fn() } };
  playerObject = { skin: { modelType: "default" }, traverse: vi.fn() }; playerWrapper = { rotation: { y: 0 } };
  controls = { update: vi.fn().mockReturnValue(false), change: null as null | (() => void),
    addEventListener: (_event: string, callback: () => void) => { this.controls.change = callback; }, removeEventListener: vi.fn() };
  composer = { dispose: vi.fn() }; render = vi.fn(); setSize = vi.fn(); loadSkin = vi.fn(); loadCape = vi.fn();
  disposed = false; dispose = vi.fn(() => { this.disposed = true; });
  constructor(public options: unknown) { mocks.viewers.push(this); }
} }));
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
function tick(timestamp: number) {
  const pending = [...frames.entries()];
  for (const [id, callback] of pending) { frames.delete(id); callback(timestamp); }
}
beforeEach(() => {
  frames = new Map(); nextFrame = 1; mocks.viewers.length = 0;
  mocks.loadImage.mockReset().mockResolvedValue({});
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = nextFrame++; frames.set(id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("draws static previews once, drains camera damping, pauses and resumes without perpetual frames", async () => {
  const view = render(<MinecraftSkinViewer skin="skin" label="Preview" interactive />);
  await waitFor(() => expect(mocks.viewers[0]?.loadSkin).toHaveBeenCalled());
  const viewer = mocks.viewers[0];
  expect(viewer.options.renderPaused).toBe(true);
  act(() => tick(100));
  expect(viewer.render).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
  viewer.controls.update.mockReturnValueOnce(true).mockReturnValueOnce(false);
  act(() => viewer.controls.change());
  act(() => tick(120));
  expect(frames.size).toBe(1);
  act(() => tick(140));
  expect(frames.size).toBe(0);
  act(() => { viewer.controls.change(); mocks.activity!(false); });
  expect(frames.size).toBe(0);
  act(() => mocks.activity!(true));
  act(() => tick(180));
  expect(frames.size).toBe(0);
  view.unmount();
  expect(viewer.dispose).toHaveBeenCalledOnce();
  expect(viewer.composer.dispose).toHaveBeenCalledOnce();
});

it("never creates textures from a skin that finishes loading after unmount", async () => {
  let finish!: (image: unknown) => void;
  mocks.loadImage.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<MinecraftSkinViewer skin="slow-skin" label="Preview" />);
  await waitFor(() => expect(mocks.loadImage).toHaveBeenCalled());
  const viewer = mocks.viewers[0];
  view.unmount();
  await act(async () => finish({}));
  expect(viewer.loadSkin).not.toHaveBeenCalled();
  expect(viewer.dispose).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
});

it("releases a hidden preview and restores its camera on a fresh canvas", async () => {
  const view = render(<MinecraftSkinViewer skin="skin" label="Preview" interactive />);
  await waitFor(() => expect(mocks.viewers[0]?.loadSkin).toHaveBeenCalled());
  const first = mocks.viewers[0];
  const canvas = view.container.querySelector("canvas");
  first.camera.position.x = 12;
  first.camera.position.y = 7;
  act(() => mocks.activity!(false));
  act(() => window.dispatchEvent(new CustomEvent("slh-release-scenes")));
  expect(first.dispose).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
  act(() => mocks.activity!(true));
  await waitFor(() => expect(mocks.viewers[1]?.loadSkin).toHaveBeenCalled());
  expect(view.container.querySelector("canvas")).not.toBe(canvas);
  expect(mocks.viewers[1].camera.position.set).toHaveBeenCalledWith(12, 7, 50);
  expect(first.dispose).toHaveBeenCalledOnce();
  act(() => tick(200));
  expect(frames.size).toBe(0);
  view.unmount();
  expect(mocks.viewers[1].dispose).toHaveBeenCalledOnce();
});

it("ignores a stale release request while the preview is visible", async () => {
  render(<MinecraftSkinViewer skin="skin" label="Preview" />);
  await waitFor(() => expect(mocks.viewers[0]?.loadSkin).toHaveBeenCalled());
  act(() => window.dispatchEvent(new CustomEvent("slh-release-scenes")));
  expect(mocks.viewers[0].dispose).not.toHaveBeenCalled();
});
