// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "./appStore";
import type { LaunchStateEvent } from "../lib/types";

const crashed = (launchId = "launch-1", instanceId = "pack"): LaunchStateEvent => ({
  launchId, instanceId, state: "crashed", exitCode: 1,
  diagnosis: { kind: "java", evidence: ["UnsupportedClassVersionError"] },
});

beforeEach(() => {
  useAppStore.setState({ launchFailures: [], activeLaunchFailure: null, toasts: [], refresh: vi.fn(async () => {}) });
});

it("opens a live failure and retains its diagnosis even without a writable report", () => {
  const event = crashed();
  useAppStore.getState().receiveLaunchState(event);
  expect(useAppStore.getState().activeLaunchFailure).toEqual(event);
  expect(useAppStore.getState().toasts[0].action?.launchFailure).toEqual(event);
  useAppStore.getState().showLaunchFailure(null);
  expect(useAppStore.getState().launchFailures).toEqual([event]);
});

it("keeps a background diagnosis reachable without opening a modal or duplicating an OS notification", () => {
  useAppStore.getState().receiveLaunchState(crashed(), true);
  expect(useAppStore.getState().launchFailures).toHaveLength(1);
  expect(useAppStore.getState().activeLaunchFailure).toBeNull();
  expect(useAppStore.getState().toasts).toHaveLength(0);
});

it("does not diagnose normal exits, kills, or older events with no structured diagnosis", () => {
  for (const state of ["running", "exited", "killed"] as const) useAppStore.getState().receiveLaunchState({ ...crashed(), state });
  useAppStore.getState().receiveLaunchState({ ...crashed(), diagnosis: undefined }, true);
  expect(useAppStore.getState().activeLaunchFailure).toBeNull();
  expect(useAppStore.getState().launchFailures).toHaveLength(0);
});

it("bounds retained failures and keeps the original event attached to each notification", () => {
  useAppStore.getState().receiveLaunchState(crashed());
  const original = useAppStore.getState().toasts[0];
  for (let index = 0; index < 25; index++) useAppStore.getState().receiveLaunchState(crashed(`run-${index}`, `pack-${index}`), true);
  expect(useAppStore.getState().launchFailures).toHaveLength(20);
  useAppStore.getState().showLaunchFailure(original.action!.launchFailure!);
  expect(useAppStore.getState().activeLaunchFailure?.launchId).toBe("launch-1");
});

it("clears the overview diagnosis after a successful launch ends", () => {
  useAppStore.getState().receiveLaunchState(crashed());
  useAppStore.getState().receiveLaunchState({ ...crashed("launch-2"), state: "exited", diagnosis: undefined });
  expect(useAppStore.getState().launchFailures).toHaveLength(0);
});
