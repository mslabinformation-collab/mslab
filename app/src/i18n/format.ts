import type { Locale } from "./locales";

/** Fills `{name}` placeholders in a dictionary string; unknown placeholders are left as they are. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Course dates are Estonian local times, wherever the server runs. */
const TIME_ZONE = "Europe/Tallinn";
const INTL_LOCALE: Record<Locale, string> = { et: "et-EE", ru: "ru-RU" };

/**
 * Intl.DateTimeFormat instances are expensive to build (locale data is resolved each time), and a long admin list
 * formats hundreds of dates; so one instance per locale + options, kept for the life of the module.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
const fmt = (l: Locale, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  const key = `${l}|${JSON.stringify(opts)}`;
  let f = formatters.get(key);
  if (!f) formatters.set(key, (f = new Intl.DateTimeFormat(INTL_LOCALE[l], { timeZone: TIME_ZONE, ...opts })));
  return f;
};

/** "14.11" */
export function formatDayMonth(d: Date, l: Locale): string {
  const parts = fmt(l, { day: "2-digit", month: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}.${get("month")}`;
}

/**
 * A file's size for people: "820 kB" under a megabyte (at least 1), else "1,4 MB" (one decimal, none when it is whole); Russian
 * units in Russian. A size that rounds to 1000 kB is "1 MB".
 */
export function formatSize(bytes: number, l: Locale): string {
  const number = (n: number, digits: number) => new Intl.NumberFormat(INTL_LOCALE[l], { maximumFractionDigits: digits }).format(n);
  const [kb, mb] = l === "ru" ? ["КБ", "МБ"] : ["kB", "MB"];
  const kilobytes = Math.max(1, Math.round(bytes / 1000));
  return kilobytes < 1000 ? `${number(kilobytes, 0)} ${kb}` : `${number(bytes / 1_000_000, 1)} ${mb}`;
}

/** "22.09.2026" */
export function formatDate(d: Date, l: Locale): string {
  const parts = fmt(l, { day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}.${get("month")}.${get("year")}`;
}

/** "okt 2026" / "окт. 2026": the short month and the year, in Estonian time (Russian without the "г." after the year). */
export function formatMonthYear(d: Date, l: Locale): string {
  const parts = fmt(l, { month: "short", year: "numeric" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("month")} ${get("year")}`;
}

/** "laupäev" / "суббота" */
export function formatWeekday(d: Date, l: Locale): string {
  return fmt(l, { weekday: "long" }).format(d);
}

/** "14:05" (Estonian time) */
export function formatTime(d: Date, l: Locale): string {
  const parts = fmt(l, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

/** "Neljapäev, 1. oktoober" / "Четверг, 1 октября" (the admin overview's date line) */
export function formatLongDate(d: Date, l: Locale): string {
  const text = `${formatWeekday(d, l)}, ${fmt(l, { day: "numeric", month: "long" }).format(d)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "2026-10-01 14:05" in Estonian time (CSV exports: sorts as text, read by spreadsheets and mailing tools). */
const STAMP = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatStamp(d: Date): string {
  const parts = STAMP.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}
