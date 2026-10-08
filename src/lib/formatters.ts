export function formatPlaytime(
  totalSeconds: number,
  locale: string,
  tr: (source: string) => string,
): string {
  if (totalSeconds <= 0) return tr("No recorded playtime");

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const language = locale.toLowerCase();
  const units = language.startsWith("ru")
    ? { hours: "ч.", minutes: "м." }
    : language.startsWith("de")
      ? { hours: "Std.", minutes: "Min." }
      : { hours: "h", minutes: "m" };
  const number = (value: number) => {
    try {
      return new Intl.NumberFormat(locale).format(value);
    } catch {
      return String(value);
    }
  };
  const parts: string[] = [];
  if (hours > 0) parts.push(`${number(hours)} ${units.hours}`);
  if (minutes > 0 || hours === 0) parts.push(`${number(minutes)} ${units.minutes}`);
  return `${parts.join(" ")} ${tr("played")}`;
}
