// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useInstanceFileDrop } from "./useInstanceFileDrop";
const mocks = vi.hoisted(() => ({ receive: null as null | ((event: { payload: any }) => void), dispose: vi.fn() }));
vi.mock("./tauri", () => ({ isTauri: true }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async (receive: typeof mocks.receive) => {
  mocks.receive = receive;
  return mocks.dispose;
} }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("switches tabs on native hover, imports only on release and scales physical coordinates", async () => {
  const tab = document.createElement("button");
  tab.dataset.instanceFileDrop = "resourcepacks";
  const hit = vi.fn(() => tab);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hit });
  vi.stubGlobal("devicePixelRatio", 2);
  const hover = vi.fn();
  const drop = vi.fn();
  const { result, unmount } = renderHook(() => useInstanceFileDrop("instance", { hover, drop }));
  await waitFor(() => expect(mocks.receive).not.toBeNull());
  act(() => mocks.receive!({ payload: { type: "enter", position: { x: 200, y: 100 }, paths: ["C:/pack.zip"] } }));
  expect(hit).toHaveBeenCalledWith(100, 50);
  expect(hover).toHaveBeenCalledWith("resourcepacks");
  expect(result.current).toBe("resourcepacks");
  expect(drop).not.toHaveBeenCalled();
  act(() => mocks.receive!({ payload: { type: "drop", position: { x: 200, y: 100 }, paths: ["C:/pack.zip"] } }));
  expect(drop).toHaveBeenCalledWith("resourcepacks", ["C:/pack.zip"]);
  expect(result.current).toBeNull();
  unmount();
  expect(mocks.dispose).toHaveBeenCalled();
  vi.unstubAllGlobals();
});
