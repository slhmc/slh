// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ErrorText } from "./ErrorText";
import { engine } from "../../i18n/engine";
const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ command: mocks.command }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("keeps the file diagnostic and opens its associated report", async () => {
  const message = "Download failed for needed.jar: HTTP 404";
  engine.rememberDiagnostic(message, "errors.downloadMissing", undefined, "E:/SLH/crash/slh-test.txt");
  mocks.command.mockResolvedValue(undefined);
  render(<ErrorText message={message} />);
  expect(screen.getByText(/required file is no longer available/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Technical details" }));
  expect(screen.getByText(message)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open error report" })); });
  expect(mocks.command).toHaveBeenCalledWith("open_crash_report", { path: "E:/SLH/crash/slh-test.txt" });
});

it("leaves a usable report path when the operating system cannot open it", async () => {
  mocks.command.mockRejectedValue(new Error("No text editor"));
  render(<ErrorText message="errors.gameCrashed" reportPath="E:/SLH/crash/slh-test.txt" />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open error report" })); });
  expect(screen.getByRole("alert").textContent).toContain("Open the file at the path above");
  expect(screen.getByText("E:/SLH/crash/slh-test.txt")).toBeTruthy();
});
