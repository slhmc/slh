// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { LogViewer } from "./LogViewer";
import type { ConsoleSettings } from "../../lib/types";
vi.mock("../../i18n/UiText", () => ({ useUiText: () => (key: string) => key }));
afterEach(cleanup);
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
const settings: ConsoleSettings = { background: "black", foreground: "white", info: "white", warning: "yellow", error: "red", debug: "blue", timestamp: "gray", fontSize: 14, maxLines: 2000, wrapLines: true, showTimestamps: true, autoScroll: true, openOnLaunch: true };
it("compact follow resumes a paused log without switching auto-scroll off", () => {
  const onSettingsChange = vi.fn();
  render(<LogViewer compact lines={[{ text: "line" }]} settings={settings} onSettingsChange={onSettingsChange} onClear={vi.fn()} label="Output" emptyText="Empty" />);
  const output = screen.getByLabelText("Output");
  Object.defineProperties(output, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 100 } });
  output.scrollTop = 400; fireEvent.scroll(output);
  const follow = screen.getByRole("button", { name: "serverWorkspace.autoScroll" });
  expect(follow.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(follow);
  expect(output.scrollTop).toBe(1000);
  expect(follow.getAttribute("aria-pressed")).toBe("true");
  expect(onSettingsChange).not.toHaveBeenCalled();
});
it("pauses follow after scrolling up and resumes with Bottom", () => {
  const props = { settings, onSettingsChange: vi.fn(), onClear: vi.fn(), label: "Output", emptyText: "Empty" };
  const { rerender } = render(<LogViewer {...props} lines={[{ text: "one" }]} />);
  const output = screen.getByLabelText("Output");
  Object.defineProperties(output, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 100 } });
  output.scrollTop = 400; fireEvent.scroll(output);
  rerender(<LogViewer {...props} lines={[{ text: "one" }, { text: "two" }]} />);
  expect(output.scrollTop).toBe(400);
  fireEvent.click(screen.getByRole("button", { name: "instance.texts.bottom" }));
  expect(output.scrollTop).toBe(1000);
  output.scrollTop = 900; fireEvent.scroll(output);
  rerender(<LogViewer {...props} lines={[{ text: "three" }]} />);
  expect(output.scrollTop).toBe(1000);
});
it("copies only filtered lines as plain text", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<LogViewer lines={[{ text: "INFO ready" }, { text: "ERROR <script>text</script>" }]} settings={settings} onSettingsChange={vi.fn()} onClear={vi.fn()} label="Output" emptyText="Empty" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "error" } });
  fireEvent.click(screen.getByRole("button", { name: "installation.texts.copy" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("ERROR <script>text</script>"));
  expect(screen.getByLabelText("Output").querySelector("script")).toBeNull();
});
