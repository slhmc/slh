import { expect, it } from "vitest";
import { appendConsoleLines, classifyConsoleLine, formatConsoleText } from "./consolePresentation";
it.each([
  ["[12:00:00] [Server thread/INFO]: Ready", "stdout", "info"],
  ["[12:00:00] [Server thread/WARN]: Slow", "stdout", "warning"],
  ["[ERROR] Failed", "stdout", "error"],
  ["java.lang.IllegalStateException", "stdout", "error"],
  ["[Server thread/DEBUG]: Details", "stdout", "debug"],
  ["[SLH] Process started", "stdout", "debug"],
  ["Other output", "stderr", "warning"],
])("classifies %s", (text, stream, level) => { expect(classifyConsoleLine(text, stream)).toBe(level); });
it("preserves thread prefixes and strips only timestamps and terminal escapes", () => {
  expect(formatConsoleText("[Server thread/INFO]: Ready", false)).toBe("[Server thread/INFO]: Ready");
  expect(formatConsoleText("[12:00:00] [INFO] Ready", false)).toBe("[INFO] Ready");
  expect(formatConsoleText("\x1b[31m[ERROR] Failed\x1b[0m", true)).toBe("[ERROR] Failed");
});
it("respects the history limit and does not restore cleared or duplicate lines", () => {
  const incoming = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
  expect(appendConsoleLines([], incoming, 2, 2000)).toEqual([{ seq: 3 }]);
  expect(appendConsoleLines([], incoming, 3, 2000)).toEqual([]);
  expect(appendConsoleLines([{ seq: 1 }], incoming, 1, 1)).toEqual([{ seq: 3 }]);
});
