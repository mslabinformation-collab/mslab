import { tallinnFormParts, tallinnInstant } from "./calendar";

// E-course access as the admin grants it (Õpilased, "Ava ligipääs"): the expiry date the form starts with and what a date
// typed there is stored as. Pure: no database, no React.
//
// An access lasts until the END of the chosen Estonian calendar day (23:59:59.999 Tallinn time): the student's card then
// says "Ligipääs kuni <that date>", and the course stays open the whole of that day.

/** When an e-course has no access months of its own (the field left empty in the course editor). */
export const DEFAULT_ACCESS_MONTHS = 12;
/** The latest expiry the form takes: this many years from today. */
export const MAX_ACCESS_YEARS = 10;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const two = (n: number) => String(n).padStart(2, "0");

/**
 * A calendar date plus whole months: "2026-10-04" + 6 → "2027-04-04". A day the target month does not have becomes its
 * last day ("2026-08-31" + 6 → "2027-02-28"). Null when `date` is not a real date.
 */
export function addMonths(date: string, months: number): string | null {
  const m = DATE.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  const index = y * 12 + (mo - 1) + months;
  const ty = Math.floor(index / 12);
  const tm = index - ty * 12; // 0…11
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${two(tm + 1)}-${two(Math.min(d, last))}`;
}

/** Today in Estonia as a date field holds it ("2026-10-04"). */
export const tallinnToday = (now: Date): string => tallinnFormParts(now).date;

/** The expiry date the grant form starts with: today in Estonia plus the course's access months (DEFAULT_ACCESS_MONTHS when it has none). */
export function defaultExpiryDate(now: Date, accessMonths: number | null): string {
  const months = accessMonths && accessMonths > 0 ? accessMonths : DEFAULT_ACCESS_MONTHS;
  return addMonths(tallinnToday(now), months)!;
}

/**
 * The end date a paid purchase gives (phase 2b, the owner's decision of 09.10: buying again never shortens access): today + the course's
 * access months (defaultExpiryDate), or the day her access ends when that is later. An access an admin ended counts as none, and one that has
 * run out ends before today, so both give the new date. `current`: her access row to the course, or null.
 */
export function purchaseExpiryDate(now: Date, accessMonths: number | null, current: { expiresAt: Date; revokedAt: Date | null } | null): string {
  const fresh = defaultExpiryDate(now, accessMonths);
  if (!current || current.revokedAt) return fresh;
  const kept = tallinnToday(current.expiresAt); // (the Estonian day it ends on: grantAccess stores the end of that day)
  return kept > fresh ? kept : fresh;
}

/** The last moment of an Estonian calendar day, 23:59:59.999 Tallinn time; null when `date` is not a real date. */
export function endOfDayTallinn(date: string): Date | null {
  const minute = tallinnInstant(date, "23:59");
  return minute ? new Date(minute.getTime() + 59_999) : null;
}

/**
 * The expiry a date typed into the grant form stands for, or null when it cannot be one: not a real date, a day before
 * today (Estonian), or more than MAX_ACCESS_YEARS ahead.
 */
export function grantExpiry(date: string, now: Date): Date | null {
  const today = tallinnToday(now);
  if (!DATE.test(date) || date < today || date > addMonths(today, MAX_ACCESS_YEARS * 12)!) return null;
  return endOfDayTallinn(date);
}

/**
 * The moment „Pikenda“ (Õpilased, B12) counts from: the later of the access's current end and the end of today in Tallinn (piece 2 texts §4). An
 * open access is extended from its own end; one that ran out (or ends tonight) from the end of today, so a lapsed course is never "extended" into
 * the past.
 */
export function extendBase(expiresAt: Date, now: Date): Date {
  const todayEnd = endOfDayTallinn(tallinnToday(now))!;
  return expiresAt.getTime() > todayEnd.getTime() ? expiresAt : todayEnd;
}

/** „+1 kuu“ / „+3 kuud“ / „+6 kuud“: `months` whole months from the Estonian day of {@link extendBase}, to the end of that day (addMonths' clamping of short months). */
export function extendByMonths(expiresAt: Date, now: Date, months: number): Date {
  const from = tallinnToday(extendBase(expiresAt, now));
  return endOfDayTallinn(addMonths(from, months)!)!;
}

/**
 * Whether `until` is a new end „Pikenda“ takes for an access that ends at `expected`: later than {@link extendBase} (so later than today's end, and
 * never a shortening), and not beyond the last moment of the day MAX_ACCESS_YEARS from today (the grant form's limit).
 */
export function isExtension(until: Date, expected: Date, now: Date): boolean {
  const latest = endOfDayTallinn(addMonths(tallinnToday(now), MAX_ACCESS_YEARS * 12)!)!;
  return until.getTime() > extendBase(expected, now).getTime() && until.getTime() <= latest.getTime();
}

export type AccessState = "active" | "expired" | "revoked";

/** Where an access row stands: ended by an admin ("revoked"), run out ("expired"), or open now ("active"). */
export function accessState(row: { expiresAt: Date; revokedAt: Date | null }, now: Date): AccessState {
  if (row.revokedAt) return "revoked";
  return row.expiresAt.getTime() > now.getTime() ? "active" : "expired";
}
