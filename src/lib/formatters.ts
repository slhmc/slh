export function formatPlaytime(
  totalSeconds: number,
  locale: string,
  tr: (source: string) => string,
): string {
  if (totalSeconds <= 0) return tr("No recorded playtime");

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const unit = (value: number, name: "hour" | "minute") => {
    try { return new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "short" }).format(value); }
    catch { return `${value} ${name}`; }
  };
  const parts: string[] = [];
  if (hours > 0) parts.push(unit(hours, "hour"));
  if (minutes > 0 || hours === 0) parts.push(unit(minutes, "minute"));
  return tr("{duration} played").replace("{duration}", parts.join(" "));
}
import { engine } from "../i18n/engine";

export function formatBytes(bytes: number, locale = engine.getSnapshot().code): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];
  const exponent = Math.max(0, Math.min(4, Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024))));
  const value = bytes / 1024 ** exponent;
  return new Intl.NumberFormat(locale, { style: "unit", unit: units[exponent], unitDisplay: "short", maximumFractionDigits: exponent ? 2 : 0 }).format(value);
}
