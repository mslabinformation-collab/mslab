import { tallinnInstant } from "./calendar";
import { COURSE_LANGUAGES } from "./course-editor";

// A calendar session's fields as the Kalender drawer holds them and the server checks them (admin UX pass piece 3b, Task 2; README B3; rulings R-b,
// R-c). Pure: no database, no React. The server's checks (server/session-edit.ts, under the session's lock with the registrations as they are) and
// the drawer's own (Task 3's `validate`, with the counts the page read) are these, so the browser refuses what the server would. Imported by the
// browser (tests/unit/old-safari.test.ts).

/** The fields the drawer autosaves, in screen order. The status is none of them: it changes with its own instant action (server/session-edit.ts setSessionStatus). */
export const SESSION_FIELDS = ["courseId", "date", "time", "city", "venue", "language", "capacity"] as const;
export type SessionField = (typeof SESSION_FIELDS)[number];

export type SessionStatus = "scheduled" | "cancelled";

/**
 * The fields as typed: the course (null: none chosen yet, a new session's „—“), the date (YYYY-MM-DD) and the start (HH:MM) in Estonian time, the
 * city, the venue, the language (ET | RU | ET / RU) and the seats as typed.
 */
export type SessionFields = { courseId: number | null; date: string; time: string; city: string; venue: string; language: string; capacity: string };

export const SESSION_LIMITS = { city: 60, venue: 120, capacityMin: 1, capacityMax: 99 } as const;

/**
 * Why a field is refused: the shared field errors' codes (server/edit-check.ts FieldError, their texts adminEt.courseEditor.errors), with the two rules
 * of the session's registrations: `capacityBelow` (R-c, README B3 „Kinnitatud on {n} — kohti ei saa olla vähem.“, n the confirmed) and `courseLocked`
 * (R-b, S3-P3-i „Toimumisel on registreeringuid, seega koolitust muuta ei saa.“).
 */
export type SessionFieldError = "required" | "course" | "date" | "time" | "tooLong" | "capacity" | "capacityBelow" | "courseLocked";

/** „Kohti“ as typed → the seats, or null when it is not 1–99 written with one or two digits. */
export function parseCapacity(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,2}$/.test(t)) return null;
  const n = Number(t);
  return n >= SESSION_LIMITS.capacityMin && n <= SESSION_LIMITS.capacityMax ? n : null;
}

/** R-c: „Kohti“ fewer than the confirmed registrations (the confirmed only: an awaiting one may lose her seat, a confirmed one never). */
export const capacityBelowConfirmed = (capacity: number, confirmed: number): boolean => capacity < confirmed;

/** R-b: „Koolitus“ is locked once anyone is booked, that is a registration that is not cancelled (confirmed or awaiting its prepayment). */
export const courseLocked = (booked: number): boolean => booked > 0;

/** The fields of `next` that are not `stored`'s, text compared as it is stored (trimmed); every field for a new session (`stored` null). */
export function changedSessionFields(next: SessionFields, stored: SessionFields | null): SessionField[] {
  const norm = (v: string | number | null) => (typeof v === "string" ? v.trim() : v);
  return SESSION_FIELDS.filter((f) => stored === null || norm(next[f]) !== norm(stored[f]));
}

/**
 * The problems of `next`, each field's first (none: {}). A field is checked when it is not the stored one (changedSessionFields; `stored`: the session
 * as it is, null for a new session: every field then): a session over its capacity (a confirmation by hand, db/queries/seats.ts) or a stored value an
 * older rule let in still saves its other fields. `confirmed` / `booked`: the session's registrations as the rules count them (db/queries/admin.ts
 * countSessionRegistrations; a new session has none). Whether the course is a contact course is the server's (it reads the course).
 */
export function sessionFieldProblems(
  next: SessionFields,
  o: { stored: SessionFields | null; confirmed?: number; booked?: number },
): Partial<Record<SessionField, SessionFieldError>> {
  const out: Partial<Record<SessionField, SessionFieldError>> = {};
  const changed = new Set(changedSessionFields(next, o.stored));
  const checked = (f: SessionField) => changed.has(f);
  if (checked("courseId")) {
    if (next.courseId === null) out.courseId = "course";
    else if (o.stored !== null && courseLocked(o.booked ?? 0)) out.courseId = "courseLocked";
  }
  if (checked("date")) {
    if (!next.date.trim()) out.date = "required";
    else if (!tallinnInstant(next.date.trim(), "12:00")) out.date = "date";
  }
  if (checked("time")) {
    if (!next.time.trim()) out.time = "required";
    else if (!tallinnInstant("2026-01-01", next.time.trim())) out.time = "time";
  }
  if (checked("city")) {
    const city = next.city.trim();
    if (!city) out.city = "required";
    else if (city.length > SESSION_LIMITS.city) out.city = "tooLong";
  }
  if (checked("venue") && next.venue.trim().length > SESSION_LIMITS.venue) out.venue = "tooLong";
  if (checked("language") && !(COURSE_LANGUAGES as readonly string[]).includes(next.language)) out.language = "required";
  if (checked("capacity")) {
    const capacity = parseCapacity(next.capacity);
    if (capacity === null) out.capacity = "capacity";
    else if (capacityBelowConfirmed(capacity, o.confirmed ?? 0)) out.capacity = "capacityBelow";
  }
  return out;
}
