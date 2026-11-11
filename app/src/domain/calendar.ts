// Pure rules for the calendar (/koolituskalender) (no database, no React).

import { normalizeSearch } from "./catalogue";

/** The calendar's city chips after "Kõik", in Maria's order (prototype A). */
export const CALENDAR_CITIES = ["Pärnu", "Tallinn", "Tartu", "Viljandi"];

/** A city in the URL: lowercase, no diacritics, spaces as dashes ("Pärnu" → "parnu"). */
export function citySlug(city: string): string {
  return normalizeSearch(city).replace(/ /g, "-");
}

/** The chip cities: Maria's four, then any other city that has an upcoming session (each once, in date order). */
export function calendarCities(sessionCities: string[], base: string[] = CALENDAR_CITIES): string[] {
  const out = [...base];
  const seen = new Set(base.map(citySlug));
  for (const raw of sessionCities) {
    const city = raw.trim();
    const key = citySlug(city);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(city);
  }
  return out;
}

/**
 * The city filter in the URL, the single source of truth: ?linn=parnu|tallinn|…
 * Returns the slug of a known chip city; a missing or unknown value means all cities (null).
 */
export function parseCity(value: string | string[] | null | undefined, cities: string[]): string | null {
  const v = citySlug(Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));
  return v && cities.some((c) => citySlug(c) === v) ? v : null;
}

/**
 * The calendar's rows the filters leave (course areas, spec 2026-11-11-course-areas-filter-design.md §5.1): the city's (?linn, `cityKey`) and the
 * area's (?valdkond, `areaKey`: the slug of the course's area, null without one) together, AND; a null filter is every city or every area. A course
 * without an area is only under „Kõik“.
 */
export function filterCalendar<R extends { cityKey: string; areaKey: string | null }>(rows: readonly R[], f: { city: string | null; area: string | null }): R[] {
  return rows.filter((r) => (f.city === null || r.cityKey === f.city) && (f.area === null || r.areaKey === f.area));
}

/**
 * The calendar's query after a chip or „Näita kõiki“: a copy of `live` (the address as it is now) with ?linn and ?valdkond set to a slug or removed
 * (null); a filter not named stays as it is, and so does every other parameter.
 */
export function calendarQuery(live: URLSearchParams, change: { linn?: string | null; valdkond?: string | null }): URLSearchParams {
  const next = new URLSearchParams(live);
  for (const key of ["linn", "valdkond"] as const) {
    const value = change[key];
    if (value === undefined) continue;
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return next;
}

/** Only contact courses have dates; e-learning starts any time, so it never appears in the calendar. */
export function contactSessions<S extends { course: { type: "e_learning" | "contact" } }>(sessions: S[]): S[] {
  return sessions.filter((s) => s.course.type === "contact");
}

/** Built once: an Intl formatter per call is slow. */
const TALLINN_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Tallinn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * Midnight at the start of `now`'s day in Estonian time, so the calendar still lists a session later today.
 * (On the two DST change days the boundary can be an hour off; sessions never start around midnight.)
 */
export function startOfDayTallinn(now: Date): Date {
  const parts = TALLINN_PARTS.formatToParts(now);
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const [y, m, d] = [get("year"), get("month"), get("day")];
  const offset = Date.UTC(y, m - 1, d, get("hour"), get("minute"), get("second")) - (now.getTime() - now.getUTCMilliseconds());
  return new Date(Date.UTC(y, m - 1, d) - offset);
}

/**
 * Where "upcoming" starts, for every public view of the dates and for booking: the earliest start that still counts,
 * one millisecond after `now` (a session counts while startsAt > now). One definition for the calendar, the course page,
 * the catalogue and home cards and the registration check: a session is listed and can be booked until it begins, and
 * nowhere after that (a 10:00 session is not bookable at 20:00 the same day). Queries use startsAt >= upcomingFrom(now).
 */
export function upcomingFrom(now: Date): Date {
  return new Date(now.getTime() + 1);
}

/** Estonian wall-clock parts of an instant. */
function tallinnWall(instant: Date): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const parts = TALLINN_PARTS.formatToParts(instant);
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") % 24, mi: get("minute"), s: get("second") };
}

/** How far Estonian time is ahead of UTC at `instant`, in ms (2 h in winter, 3 h in summer). */
function tallinnOffset(instant: Date): number {
  const w = tallinnWall(instant);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - (instant.getTime() - instant.getUTCMilliseconds());
}

/**
 * The instant of an Estonian date and time as the admin types them ("2026-11-14", "10:00" → 08:00 UTC in winter,
 * "2027-06-05", "10:00" → 07:00 UTC in summer). Null when either is not a real date / time.
 */
export function tallinnInstant(date: string, time: string): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dm || !tm) return null;
  const [y, m, d, h, mi] = [Number(dm[1]), Number(dm[2]), Number(dm[3]), Number(tm[1]), Number(tm[2])];
  if (h > 23 || mi > 59) return null;
  const wall = Date.UTC(y, m - 1, d, h, mi);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  // The offset depends on the instant itself: guess with the offset at the wall time, then correct once.
  const guess = wall - tallinnOffset(new Date(wall));
  return new Date(wall - tallinnOffset(new Date(guess)));
}

/** An instant as the session form shows it: Estonian date "2026-11-14" and time "10:00". */
export function tallinnFormParts(instant: Date): { date: string; time: string } {
  const w = tallinnWall(instant);
  const two = (n: number) => String(n).padStart(2, "0");
  return { date: `${w.y}-${two(w.m)}-${two(w.d)}`, time: `${two(w.h)}:${two(w.mi)}` };
}
