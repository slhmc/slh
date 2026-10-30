import type { ConsoleLine } from "./types";

export function classifyConsoleLine(text: string, stream?: string): ConsoleLine["level"] {
  const lower = text.toLowerCase();
  if (/fatal|exception|(?:\[|\/)error\b| error:/.test(lower)) return "error";
  if (/(?:\[|\/)warn(?:ing)?\b|warning/.test(lower)) return "warning";
  if (text.startsWith("[SLH]") || /(?:\[|\/)(debug|trace)\b/.test(lower)) return "debug";
  return stream === "stderr" ? "warning" : "info";
}
export function formatConsoleText(text: string, showTimestamps: boolean) {
  // Strip control sequences without treating log text as HTML.
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  return showTimestamps ? clean : clean.replace(/^\[(?:\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T)[^\]]*\]\s*/, "");
}
export function appendConsoleLines<T extends { seq: number }>(previous: T[], incoming: T[], cursor: number, limit: number) {
  return [...previous, ...incoming.filter(line => line.seq > cursor)].slice(-Math.max(1, limit));
}
