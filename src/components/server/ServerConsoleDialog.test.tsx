// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ServerConsolePanel } from "./ServerConsoleDialog";
import { defaultServerConfig, type LocalServer, type ServerSnapshot } from "../../lib/localServers";
const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ command: mocks.command }));
vi.mock("../../lib/windowActivity", () => ({ useWindowActivity: () => true }));
vi.mock("../../i18n/UiText", () => ({ useUiText: () => (key: string) => key }));
vi.mock("../../stores/appStore", () => ({ useAppStore: (select: (state: unknown) => unknown) => select({ bootstrap: { settings: { console: { maxLines: 3000 } } } }) }));
vi.mock("../common/LogViewer", () => ({ LogViewer: ({ lines }: { lines: { text: string }[] }) => <pre aria-label="Output">{lines.map(line => line.text).join("\n")}</pre> }));
const server: LocalServer = { id: "test", name: "Test", path: "test", config: defaultServerConfig(), status: "running", groupId: null, installed: true, createdAt: "" };
const snapshot = (runId: string | null, seq: number, text: string, lastSeq = seq): ServerSnapshot => ({ runId, state: "running", lines: [{ seq, text, stream: "stdout", timestamp: "" }], lastSeq, exitCode: null, error: null });
beforeEach(() => { vi.useFakeTimers(); mocks.command.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function mount() { await act(async () => { render(<ServerConsolePanel server={server} />); }); }
async function poll() { await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); }
it("replaces stopped output on a new run even when its sequence already exceeds the old cursor", async () => {
  mocks.command.mockResolvedValueOnce(snapshot("old", 10, "Old server stopped"))
    .mockResolvedValueOnce(snapshot("new", 20, "partial"))
    .mockResolvedValueOnce(snapshot("new", 1, "New server started", 20));
  await mount();
  expect(screen.getByLabelText("Output").textContent).toContain("Old server stopped");
  await poll();
  expect(mocks.command.mock.calls.map(([, args]) => args.cursor)).toEqual([0, 10, 0]);
  expect(screen.getByLabelText("Output").textContent).toBe("New server started");
});
it("recovers from a sequence reset without a run id", async () => {
  mocks.command.mockResolvedValueOnce(snapshot(null, 50, "Old output"))
    .mockResolvedValueOnce({ ...snapshot(null, 2, "unused"), lines: [] })
    .mockResolvedValueOnce(snapshot(null, 1, "Restarted"));
  await mount(); await poll();
  expect(screen.getByLabelText("Output").textContent).toBe("Restarted");
  expect(mocks.command.mock.calls[2][1].cursor).toBe(0);
});
it("reads the next page instead of skipping to the host's total sequence", async () => {
  mocks.command.mockResolvedValueOnce(snapshot("run", 1000, "Page one", 2500))
    .mockResolvedValueOnce(snapshot("run", 2000, "Page two", 2500));
  await mount(); await poll();
  expect(mocks.command.mock.calls[1][1].cursor).toBe(1000);
  expect(screen.getByLabelText("Output").textContent).toBe("Page one\nPage two");
});
