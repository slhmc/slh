// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { SkinViewEngine } from "../vendor/mine3d/core/scene-loop";
import { homeCharacterFps } from "./homeCharacterFps";

it("keeps all saved limits and defaults old or invalid settings to 30 FPS", () => {
  for (const fps of [0, 1, 29, 30, 31, 60]) expect(homeCharacterFps(fps)).toBe(fps);
  for (const value of [undefined, null, -1, 61, 1.5, NaN, "30"]) expect(homeCharacterFps(value)).toBe(30);
});

it("removes the application cap for unlimited and accepts 1 FPS", () => {
  const state = { _animationFrameRate: 30 };
  SkinViewEngine.prototype.setAnimationFrameRate.call(state as unknown as SkinViewEngine, 0);
  expect(state._animationFrameRate).toBe(Infinity);
  SkinViewEngine.prototype.setAnimationFrameRate.call(state as unknown as SkinViewEngine, 1);
  expect(state._animationFrameRate).toBe(1);
});

it("does not reduce image quality because idle deliberately renders at 30 FPS", () => {
  // Exercise the quality policy without allocating a real GPU context.
  const state = {
    _qualityLevel: 0, _qualityElapsed: 0,
    _renderOnDemand: true, _animationActive: true, _animationFrameRate: 30,
    _fpsSamples: [30, 30, 30], _fpsAvg: 30,
    _basePixelRatio: 2, _applyPixelRatio: vi.fn(),
    lighting: { setShadowMapSize: vi.fn() },
    _particles: { group: { visible: false } },
  };
  const policy = SkinViewEngine.prototype as unknown as { _adaptQuality: (delta: number) => void };
  policy._adaptQuality.call(state, 60);
  expect(state._qualityLevel).toBe(0);
  expect(state._applyPixelRatio).not.toHaveBeenCalled();
  expect(state.lighting.setShadowMapSize).not.toHaveBeenCalled();
});


it("sleeps between capped frames and cancels the pending wake when stopped", () => {
  vi.useFakeTimers();
  const raf = vi.fn().mockReturnValue(17);
  const cancel = vi.fn();
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  const state = {
    _running: true, _disposed: false, _renderOnDemand: true, _animationFrameRate: 1,
    _lastFrameAt: performance.now(), _frameTimer: undefined, _rafId: 0,
    _tick: vi.fn(), clock: { stop: vi.fn() }, _controlsActive: true,
  };
  const scheduler = SkinViewEngine.prototype as unknown as { _scheduleFrame(): void };
  try {
    scheduler._scheduleFrame.call(state);
    vi.advanceTimersByTime(900);
    expect(raf).not.toHaveBeenCalled();
    SkinViewEngine.prototype.stop.call(state as unknown as SkinViewEngine);
    vi.advanceTimersByTime(2000);
    expect(raf).not.toHaveBeenCalled();
    expect(state._running).toBe(false);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
