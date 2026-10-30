// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { command } from "../lib/tauri";
import { useAppStore } from "./appStore";
import type { BootstrapData } from "../lib/types";
vi.mock("../lib/tauri", async importOriginal => {
  const actual = await importOriginal<typeof import("../lib/tauri")>();
  return { ...actual, command: vi.fn(actual.command) };
});
afterEach(() => { vi.useRealTimers(); vi.mocked(command).mockRestore(); });

it("hides a deleting card immediately, keeps it hidden on refresh and restores it on failure", async () => {
  const original = vi.mocked(command).getMockImplementation()!;
  const bootstrap = await original("get_bootstrap") as BootstrapData;
  const id = bootstrap.instances[0].id;
  useAppStore.setState({ bootstrap, deletingInstanceIds: [], activities: [], instanceOperationIds: [], selectedInstanceId: id });
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  vi.mocked(command).mockImplementation((async (name: string) => {
    if (name === "delete_instance") return new Promise((_, fail) => { reject = fail; });
    if (name === "get_bootstrap") return structuredClone(bootstrap);
  }) as typeof command);
  const pending = useAppStore.getState().deleteInstance(id);
  expect(useAppStore.getState().bootstrap?.instances.some(instance => instance.id === id)).toBe(false);
  expect(useAppStore.getState().selectedInstanceId).toBeNull();
  await useAppStore.getState().refresh();
  expect(useAppStore.getState().bootstrap?.instances.some(instance => instance.id === id)).toBe(false);
  reject(new Error("File is in use"));
  await expect(pending).rejects.toThrow("File is in use");
  expect(useAppStore.getState().bootstrap?.instances.some(instance => instance.id === id)).toBe(true);
  expect(useAppStore.getState().deletingInstanceIds).toEqual([]);
  expect(useAppStore.getState().activities).toEqual([]);
  vi.clearAllTimers();
});

it("does not resurrect a successfully deleted instance from a stale bootstrap response", async () => {
  const original = vi.mocked(command).getMockImplementation()!;
  const bootstrap = await original("get_bootstrap") as BootstrapData;
  const id = bootstrap.instances[0].id;
  useAppStore.setState({ bootstrap, deletingInstanceIds: [], deletedInstanceIds: [], activities: [], instanceOperationIds: [] });
  vi.useFakeTimers();
  vi.mocked(command).mockImplementation((async (name: string) => {
    if (name === "get_bootstrap") return structuredClone(bootstrap);
  }) as typeof command);
  await useAppStore.getState().deleteInstance(id);
  await useAppStore.getState().refresh();
  expect(useAppStore.getState().bootstrap?.instances.some(instance => instance.id === id)).toBe(false);
  expect(useAppStore.getState().deletingInstanceIds).toEqual([]);
  vi.clearAllTimers();
});
