// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { subscribeUiEvents, type UiEvent } from "./uiEvents";
const mocks = vi.hoisted(() => ({
  listener: undefined as undefined | ((event: { payload: UiEvent }) => void),
  activity: undefined as undefined | ((active: boolean) => void),
  command: vi.fn(), dispose: vi.fn(), stopActivity: vi.fn(),
}));
vi.mock("./tauri", () => ({ command: mocks.command, isTauri: true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (_name: string, callback: typeof mocks.listener) => { mocks.listener = callback; return mocks.dispose; } }));
vi.mock("./windowActivity", () => ({ subscribeWindowActivity: (callback: typeof mocks.activity) => { mocks.activity = callback; callback?.(true); return mocks.stopActivity; } }));
afterEach(() => { mocks.command.mockReset(); mocks.dispose.mockClear(); mocks.stopActivity.mockClear(); mocks.listener = undefined; mocks.activity = undefined; });
const event = (sequence: number): UiEvent => ({ sequence, name: "slh-launch-state", payload: { state: "exited" } });

it("merges an in-flight completion with its snapshot once, in sequence order", async () => {
  let finish!: (snapshot: unknown) => void;
  mocks.command.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const received: number[] = [];
  const restored = vi.fn();
  const stop = subscribeUiEvents((value) => received.push(value.sequence), restored);
  await vi.waitFor(() => expect(mocks.command).toHaveBeenCalled());
  mocks.listener!({ payload: event(2) });
  mocks.listener!({ payload: event(3) });
  finish({ sequence: 2, events: [event(1), event(2)] });
  await vi.waitFor(() => expect(received).toEqual([1, 2, 3]));
  mocks.activity!(false);
  mocks.listener!({ payload: event(4) });
  expect(received).toEqual([1, 2, 3]);
  mocks.activity!(true);
  finish({ sequence: 4, events: [event(2), event(4)] });
  await vi.waitFor(() => expect(received).toEqual([1, 2, 3, 4]));
  stop();
  expect(mocks.dispose).toHaveBeenCalledOnce();
  expect(mocks.stopActivity).toHaveBeenCalledOnce();
});

it("ignores a snapshot that arrives after unmount", async () => {
  let finish!: (snapshot: unknown) => void;
  mocks.command.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const received = vi.fn();
  const stop = subscribeUiEvents(received, vi.fn());
  await vi.waitFor(() => expect(mocks.command).toHaveBeenCalled());
  stop();
  finish({ sequence: 1, events: [event(1)] });
  await Promise.resolve();
  expect(received).not.toHaveBeenCalled();
});
