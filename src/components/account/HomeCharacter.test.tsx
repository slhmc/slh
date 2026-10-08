// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HomeCharacter } from "./HomeCharacter";
import type { Account } from "../../lib/types";

const mocks = vi.hoisted(() => ({ engines: [] as any[], command: vi.fn(), unavailable: false }));
vi.mock("../../lib/tauri", () => ({ command: mocks.command, isTauri: false }));
vi.mock("../../i18n/I18nProvider", () => ({ useI18n: () => ({ tr: (value: string) => value }) }));
vi.mock("../../vendor/mine3d/types", () => ({ SkinModelType: { Slim: "slim", Classic: "classic" } }));
// Pose geometry has its own real-engine tests; lifecycle tests only need the
// callback contract and should not wait for Three.js module initialization.
vi.mock("../../lib/homeCharacterPose", () => ({ homePoseBounds: () => ({}), stabilizeHomePose: vi.fn() }));
vi.mock("../../vendor/mine3d/core/skin-animations", () => ({
  HeroIdleAnimation: class { id = "idle"; }, CoolPoseAnimation: class { id = "pose"; },
  createSkinAnimation: (id: string) => ({ id }),
}));
vi.mock("../../vendor/mine3d/core/scene-loop", () => ({ SkinViewEngine: class {
  idleAnimation = { id: "idle" }; controls = { getPolarAngle: () => 1, getAzimuthalAngle: () => 0, addEventListener: vi.fn(), removeEventListener: vi.fn(), object: { position: { set: vi.fn() } }, target: { x: 0, y: 0, z: 0 }, update: vi.fn() };
  getCameraDistance = () => 110;
  fitPlayerToFrame = vi.fn(); setSize = vi.fn(); setSkin = vi.fn().mockResolvedValue(undefined); setCape = vi.fn().mockResolvedValue(undefined);
  setContactShadowVisible = vi.fn(); setCursorFollow = vi.fn(); setAnimation = vi.fn();
  setPoseHook = vi.fn(); setRenderOnDemand = vi.fn(); setAnimationActive = vi.fn(); setAnimationFrameRate = vi.fn();
  hitPlayerAt = vi.fn().mockReturnValue(true); start = vi.fn(); stop = vi.fn(); dispose = vi.fn();
  constructor() { if (mocks.unavailable) throw new Error("WebGL unavailable"); mocks.engines.push(this); }
} }));
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(Math, "random").mockReturnValue(0);
  mocks.engines.length = 0; mocks.command.mockReset(); mocks.unavailable = false;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerId: number;
    constructor(type: string, options: PointerEventInit = {}) { super(type, options); this.pointerId = options.pointerId ?? 1; }
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("plays only idle and ignores mouse clicks, Enter and Space", async () => {
  const view = render(<HomeCharacter account={null} />);
  await waitFor(() => expect(mocks.engines[0]?.start).toHaveBeenCalled());
  const engine = mocks.engines[0];
  expect(engine.setAnimationFrameRate).toHaveBeenCalledWith(30);
  vi.useFakeTimers();
  act(() => vi.advanceTimersByTime(60000));
  expect(engine.setAnimation).not.toHaveBeenCalled();
  expect(engine.setRenderOnDemand).toHaveBeenCalledWith(true);
  expect(engine.setAnimationActive).toHaveBeenLastCalledWith(true, true);
  fireEvent.click(view.container.querySelector("canvas")!);
  fireEvent.keyDown(view.getByRole("group"), { key: "Enter" });
  fireEvent.keyDown(view.getByRole("group"), { key: " " });
  act(() => vi.advanceTimersByTime(10000));
  expect(engine.setAnimation).not.toHaveBeenCalled();
  expect(engine.setCape).toHaveBeenCalledWith(null);
  expect(engine.controls.enableZoom).toBe(false);
  expect(engine.controls.enablePan).toBe(false);
  expect(engine.controls.autoRotate).toBe(false);
  expect(engine.controls.dampingFactor).toBe(.08);
  view.unmount();
  expect(engine.dispose).toHaveBeenCalledOnce();
  act(() => vi.advanceTimersByTime(10000));
  expect(engine.setAnimation).not.toHaveBeenCalled();
});

it("pauses a hidden page and disposes the scene on leaving", async () => {
  const view = render(<HomeCharacter account={null} />);
  await waitFor(() => expect(mocks.engines[0]?.start).toHaveBeenCalled());
  const engine = mocks.engines[0];
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  fireEvent(document, new Event("visibilitychange"));
  expect(engine.stop).toHaveBeenCalled();
  expect(engine.setAnimationActive).toHaveBeenLastCalledWith(false, false);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  fireEvent(document, new Event("visibilitychange"));
  expect(engine.setAnimationActive).toHaveBeenLastCalledWith(true, true);
  view.unmount();
  expect(engine.dispose).toHaveBeenCalledOnce();
});

it("keeps drag rotation available and changes scale only with Ctrl + wheel", async () => {
  const view = render(<HomeCharacter account={null} />);
  await waitFor(() => expect(mocks.engines[0]?.start).toHaveBeenCalled());
  const engine = mocks.engines[0];
  const canvas = view.container.querySelector("canvas")!;
  fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(canvas, { clientX: 120, clientY: 100 });
  fireEvent.pointerUp(canvas, { clientX: 100, clientY: 100 });
  expect(engine.setAnimation).not.toHaveBeenCalled();
  engine.hitPlayerAt.mockReturnValue(false);
  fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(canvas, { clientX: 100, clientY: 100 });
  expect(engine.setAnimation).not.toHaveBeenCalled();
  engine.hitPlayerAt.mockReturnValue(true);
  fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(canvas, { clientX: 102, clientY: 100 });
  expect(engine.setAnimation).not.toHaveBeenCalled();
  engine.fitPlayerToFrame.mockClear();
  fireEvent.wheel(canvas, { deltaY: 100 });
  expect(engine.fitPlayerToFrame).not.toHaveBeenCalled();
  fireEvent.wheel(canvas, { deltaY: 100, ctrlKey: true });
  expect(engine.fitPlayerToFrame).toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem("slh.home.character.view")!).scale).toBeLessThan(1);
});

it("ignores a late skin response from the previous account", async () => {
  let resolveOld!: (value: unknown) => void;
  mocks.command.mockImplementation((_name, args) => args.accountId === "old"
    ? new Promise((resolve) => { resolveOld = resolve; })
    : Promise.resolve({ dataUrl: "current-skin", model: "slim" }));
  const account = { id: "old", provider: "microsoft", providerUuid: "00000000-0000-0000-0000-000000000000", username: "Player" } as Account;
  const view = render(<HomeCharacter account={account} />);
  view.rerender(<HomeCharacter account={{ ...account, id: "current" }} />);
  await waitFor(() => expect(mocks.engines.some((engine) => engine.setSkin.mock.calls.some((call: string[]) => call[0] === "current-skin"))).toBe(true));
  await act(async () => resolveOld({ dataUrl: "old-skin", model: "classic" }));
  expect(mocks.engines.some((engine) => engine.setSkin.mock.calls.some((call: string[]) => call[0] === "old-skin"))).toBe(false);
});

it("shows a static character when WebGL is unavailable without requiring an account", async () => {
  mocks.unavailable = true;
  const view = render(<HomeCharacter account={null} />);
  await waitFor(() => expect(view.container.querySelectorAll("canvas")).toHaveLength(2));
  expect(mocks.command).not.toHaveBeenCalled();
  expect(view.getByRole("group").getAttribute("tabindex")).toBeNull();
});

it("uses a fresh WebGL canvas when the downloaded skin replaces the startup skin", async () => {
  let finish!: (value: unknown) => void;
  mocks.command.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const account = { id: "account", provider: "microsoft", providerUuid: "00000000-0000-0000-0000-000000000000", username: "Player" } as Account;
  const view = render(<HomeCharacter account={account} />);
  await waitFor(() => expect(mocks.engines[0]?.start).toHaveBeenCalled());
  const firstCanvas = view.container.querySelector("canvas")!;
  const firstEngine = mocks.engines[0];
  await act(async () => finish({ dataUrl: "downloaded-skin", model: "slim" }));
  await waitFor(() => expect(mocks.engines.some((engine) => engine.setSkin.mock.calls.some((call: string[]) => call[0] === "downloaded-skin"))).toBe(true));
  expect(view.container.querySelector("canvas")).not.toBe(firstCanvas);
  expect(firstEngine.dispose).toHaveBeenCalledOnce();
  fireEvent(firstCanvas, new Event("webglcontextlost"));
  expect(view.container.querySelectorAll("canvas")).toHaveLength(1);
  expect(mocks.engines[mocks.engines.length - 1].setAnimationActive).toHaveBeenLastCalledWith(true, true);
});

it("applies saved FPS limits, including unlimited, without reusing a disposed canvas", async () => {
  const view = render(<HomeCharacter account={null} frameRate={1} />);
  await waitFor(() => expect(mocks.engines[0]?.setAnimationFrameRate).toHaveBeenCalledWith(1));
  const oldCanvas = view.container.querySelector("canvas");
  view.rerender(<HomeCharacter account={null} frameRate={0} />);
  await waitFor(() => expect(mocks.engines[mocks.engines.length - 1]?.setAnimationFrameRate).toHaveBeenCalledWith(0));
  expect(view.container.querySelector("canvas")).not.toBe(oldCanvas);
  expect(mocks.engines[0].dispose).toHaveBeenCalledOnce();
});


it("releases hidden GPU resources and restores on a fresh canvas with saved scale", async () => {
  const view = render(<HomeCharacter account={null} frameRate={30} />);
  await waitFor(() => expect(mocks.engines[0]?.start).toHaveBeenCalled());
  const first = mocks.engines[0];
  const canvas = view.container.querySelector("canvas")!;
  fireEvent.wheel(canvas, { deltaY: 100, ctrlKey: true });
  const saved = localStorage.getItem("slh.home.character.view");
  act(() => window.dispatchEvent(new CustomEvent("slh-native-activity", { detail: false })));
  act(() => window.dispatchEvent(new CustomEvent("slh-release-scenes", { detail: 1 })));
  expect(first.dispose).toHaveBeenCalledOnce();
  expect(mocks.engines).toHaveLength(1);
  act(() => window.dispatchEvent(new CustomEvent("slh-native-activity", { detail: true })));
  await waitFor(() => expect(mocks.engines).toHaveLength(2));
  expect(view.container.querySelector("canvas")).not.toBe(canvas);
  expect(localStorage.getItem("slh.home.character.view")).toBe(saved);
  await waitFor(() => expect(mocks.engines[1].setAnimationActive).toHaveBeenLastCalledWith(true, true));
  view.unmount();
  expect(first.dispose).toHaveBeenCalledOnce();
  expect(mocks.engines[1].dispose).toHaveBeenCalledOnce();
});

it("ignores a stale release event when the window is visible", async () => {
  render(<HomeCharacter account={null} />);
  await waitFor(() => expect(mocks.engines[0]?.start).toHaveBeenCalled());
  act(() => window.dispatchEvent(new CustomEvent("slh-release-scenes", { detail: 1 })));
  expect(mocks.engines[0].dispose).not.toHaveBeenCalled();
});
