import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db, Q, Tx } from "@/db/client";
import { countSessionRegistrations } from "@/db/queries/admin";
import { lockSession } from "@/db/queries/seats";
import { courses, courseSessions, type CourseSession } from "@/db/schema";
import type { SaveAnswer } from "@/domain/autosave";
import { tallinnFormParts, tallinnInstant } from "@/domain/calendar";
import {
  changedSessionFields, parseCapacity, SESSION_FIELDS, sessionFieldProblems, type SessionField, type SessionFieldError, type SessionFields, type SessionStatus,
} from "@/domain/session-fields";
import { ROW_ID_MAX } from "@/lib/row-id";
import { toStorable } from "@/lib/to-storable";
import { contentVersion } from "@/lib/version";
import { fieldCodes, refusedFields } from "./autosave-route";
import { revalidatePublic } from "./public-cache";

// A calendar session's edits (admin UX pass piece 3b, Task 2; README B3; rulings R-a, R-b, R-c). The Kalender drawer:
// - autosaves its fields (domain/session-fields.ts SESSION_FIELDS) on POST /api/admin/toimumine/<id> (server/autosave-route.ts' contract): writeSession;
// - creates a new session only with the explicit „Lisa toimumine“ (S3-P3-g): createSession, which answers the id (the drawer goes on at ?id=<n>);
// - changes the status („Tühistatud“, „Toimub“) with an instant action, behind a ConfirmPanel when someone is booked: setSessionStatus.
// The version (R-a) is "s:" and lib/version.ts contentVersion of the stored {courseId, startsAt, city, venue, language, capacity, status}: a status
// changed in another tab is a conflict for the fields too. Every write of a session takes its lock first (db/queries/seats.ts lockSession, the first
// lock of the order course_sessions → registrations → payments, as the public registration and the payments take it), so the rules decide by the
// registrations as they are, never by what the page showed: „Kohti“ is never fewer than the confirmed (R-c, `capacityBelow`), and „Koolitus“ does not
// change once anyone is booked, confirmed or awaiting (R-b, `courseLocked`; cancelled registrations stay as history and do not lock it). A registration
// queued on the lock behind a save sees the new capacity and course. Every successful write revalidates `{ kind: "sessions" }` once, after the commit.
// No Next.js here but the public pages' revalidation (server/public-cache.ts, mocked in tests/db/session-edit.test.ts).

export { SESSION_FIELDS, type SessionField, type SessionFieldError, type SessionFields, type SessionStatus } from "@/domain/session-fields";

/** A stored session as the drawer shows it: its fields as typed (domain/session-fields.ts SessionFields) and its status. */
export type SessionValue = SessionFields & { courseId: number; status: SessionStatus };

/** A refusal by field: each refused field's code (SessionFieldError, or the patch shape's own). */
export type SessionInvalid = { ok: false; error: "invalid"; fields: Record<string, string> };

// ---------- the fields' shapes (the outer limits: the real ones are domain/session-fields.ts sessionFieldProblems, with field codes) ----------

/**
 * The course as its id (a number), the rest as typed; the city and the venue without what Postgres cannot store (lib/to-storable.ts: a NUL, a lone
 * surrogate; the 500 would be tried again for good). Each refusal is its field's code.
 */
const shape = {
  courseId: z.number({ error: "course" }).int("course").positive("course").max(ROW_ID_MAX, "course"),
  date: z.string({ error: "date" }).max(40, "date"),
  time: z.string({ error: "time" }).max(40, "time"),
  city: z.string({ error: "required" }).max(2_000, "tooLong").transform(toStorable),
  venue: z.string({ error: "tooLong" }).max(2_000, "tooLong").transform(toStorable),
  language: z.string({ error: "required" }).max(40, "required"),
  capacity: z.string({ error: "capacity" }).max(40, "capacity"),
};

/** The drawer's autosave patch (the route's schema): some of its fields, no other (the status has its own action: a field `status` is `invalid`). */
export const SESSION_PATCH = z.strictObject(shape, { error: "invalid" }).partial();
export type SessionPatch = z.output<typeof SESSION_PATCH>;

/** „Lisa toimumine“: every field; the course may be none yet (the new drawer's „—“, refused `course`). A new session is always „Toimub“. */
const NEW_SESSION = z.strictObject({ ...shape, courseId: shape.courseId.nullable() }, { error: "invalid" });

// ---------- the stored session ----------

const valueOf = (row: CourseSession): SessionValue => {
  const { date, time } = tallinnFormParts(row.startsAt);
  return { courseId: row.courseId, date, time, city: row.city, venue: row.venue, language: row.language, capacity: String(row.capacity), status: row.status };
};

const fieldsOf = (v: SessionValue): SessionFields => ({ courseId: v.courseId, date: v.date, time: v.time, city: v.city, venue: v.venue, language: v.language, capacity: v.capacity });

/** R-a: "s:" and the hash of the stored content (never the registrations: a booking changes no field). */
const versionOf = async (row: CourseSession): Promise<string> =>
  `s:${await contentVersion({ courseId: row.courseId, startsAt: row.startsAt, city: row.city, venue: row.venue, language: row.language, capacity: row.capacity, status: row.status })}`;

async function sessionRow(q: Q, id: number): Promise<CourseSession | null> {
  const [row] = await q.select().from(courseSessions).where(eq(courseSessions.id, id)).limit(1);
  return row ?? null;
}

/** The session as the drawer reads it (the autosave route's `read`): its version (R-a) and its fields with the status; null when there is no such session (404). */
export async function readSession(db: Q, id: number): Promise<{ version: string; value: SessionValue } | null> {
  const row = await sessionRow(db, id);
  return row ? { version: await versionOf(row), value: valueOf(row) } : null;
}

// ---------- the checks and the writes ----------

type Columns = Pick<CourseSession, "courseId" | "startsAt" | "city" | "venue" | "language" | "capacity">;
type Checked = { ok: true; columns: Columns } | { ok: false; fields: Record<string, string> };

/**
 * `next` checked as the session it would make: domain/session-fields.ts sessionFieldProblems for the fields that are not `row`'s (every field of a new
 * session, `row` null), with `counts` (R-b, R-c), and the course must be a contact course (an e-course has no dates), on every save: a session row of an
 * e-course (one an older editor let in) saves nothing until it is under a contact course. The course's type is read FOR SHARE (piece 3b Task 3): in the
 * caller's transaction, after the session's lock when there is one (the registration's order, the session and then the course), it stays until the
 * write commits — a type change (server/course-parts.ts, under the course's FOR UPDATE, then typeLocked counts its sessions) waits for it and counts the
 * session, or it waits for the type change and reads the new type. The columns to store: a changed field as checked (text trimmed, the start from the
 * Estonian date and time), an unchanged one as it is stored.
 */
async function check(tx: Tx, next: SessionFields, row: CourseSession | null, counts: { confirmed: number; booked: number }): Promise<Checked> {
  const stored = row ? fieldsOf(valueOf(row)) : null;
  const problems: Partial<Record<SessionField, SessionFieldError>> = sessionFieldProblems(next, { stored, ...counts });
  const changed = new Set(changedSessionFields(next, stored));
  if (!problems.courseId && next.courseId !== null) {
    const [course] = await tx.select({ type: courses.type }).from(courses).where(eq(courses.id, next.courseId)).for("share");
    if (course?.type !== "contact") problems.courseId = "course";
  }
  const fields = Object.fromEntries(Object.entries(problems).filter(([, code]) => code !== undefined)) as Record<string, string>;
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  // (every changed field passed its check: the course is a contact course's id, the date and time make an instant, the seats are 1–99)
  const keep = (f: SessionField) => row !== null && !changed.has(f);
  return {
    ok: true,
    columns: {
      courseId: keep("courseId") ? row!.courseId : next.courseId!,
      startsAt: keep("date") && keep("time") ? row!.startsAt : tallinnInstant(next.date.trim(), next.time.trim())!,
      city: keep("city") ? row!.city : next.city.trim(),
      venue: keep("venue") ? row!.venue : next.venue.trim(),
      language: keep("language") ? row!.language : next.language,
      capacity: keep("capacity") ? row!.capacity : parseCapacity(next.capacity)!,
    },
  };
}

const NONE = { confirmed: 0, booked: 0 };

/**
 * A stored session changed to `next` and `status`, under its lock (the caller has taken it, first): "same" when nothing would change (nothing written),
 * the refused fields, or the row as written. The registrations are counted under the lock when a rule needs them (the seats or the course changed).
 */
async function changeLocked(
  tx: Tx,
  row: CourseSession,
  next: SessionFields,
  status: SessionStatus,
): Promise<"same" | { ok: false; fields: Record<string, string> } | { ok: true; row: CourseSession }> {
  const changed = changedSessionFields(next, fieldsOf(valueOf(row)));
  if (changed.length === 0 && status === row.status) return "same";
  const counts = changed.includes("capacity") || changed.includes("courseId") ? await countSessionRegistrations(tx, row.id) : NONE;
  const checked = await check(tx, next, row, counts);
  if (!checked.ok) return checked;
  const [after] = await tx.update(courseSessions).set({ ...checked.columns, status }).where(eq(courseSessions.id, row.id)).returning();
  return { ok: true, row: after };
}

/** The patch's own fields (any other is not read: the status has its own action). */
const ownFields = (patch: Record<string, unknown>) => Object.fromEntries(Object.entries(patch).filter(([k]) => (SESSION_FIELDS as readonly string[]).includes(k)));

/**
 * The drawer's autosave (the route's `write`; server/autosave-route.ts' contract): `patch` (some of the fields; any other is not read) over the session
 * at `version`, under the session's lock, taken as the transaction's first statement. The answers:
 * - ok with the session's version after it; a save that changes nothing answers the version it came from and writes nothing;
 * - a conflict with the stored version and value when `version` is not the session's (another tab saved a field or the status first); a session
 *   deleted meanwhile: version "", value null;
 * - invalid with the fields' codes: each field's check (domain/session-fields.ts, for the fields it changes), „Kohti“ below the confirmed
 *   (`capacityBelow`, R-c) and another course once anyone is booked (`courseLocked`, R-b), both counted under the lock.
 * `{ kind: "sessions" }` is revalidated once after a write. `admin`: who saved (the route's; a session keeps no author).
 */
export async function writeSession(db: Db, id: number, patch: Record<string, unknown>, version: string, admin: { email: string }, now: Date): Promise<SaveAnswer> {
  const savedAt = now.toISOString();
  const own = ownFields(patch);
  const parsed = SESSION_PATCH.safeParse(own);
  if (!parsed.success) return { ok: false, error: "invalid", fields: fieldCodes(parsed.error.issues) ?? Object.fromEntries(Object.keys(own).map((k) => [k, "invalid"])) };
  const done = await db.transaction(async (tx): Promise<{ answer: SaveAnswer; wrote: boolean }> => {
    await lockSession(tx, id);
    const row = await sessionRow(tx, id);
    if (!row) return { answer: { ok: false, error: "conflict", version: "", value: null }, wrote: false };
    const current = await versionOf(row);
    if (version !== current) return { answer: { ok: false, error: "conflict", version: current, value: valueOf(row) }, wrote: false };
    const result = await changeLocked(tx, row, { ...fieldsOf(valueOf(row)), ...parsed.data }, row.status);
    if (result === "same") return { answer: { ok: true, version: current, savedAt }, wrote: false };
    if (!result.ok) return { answer: { ok: false, error: "invalid", fields: refusedFields(result.fields, Object.keys(parsed.data)) }, wrote: false };
    return { answer: { ok: true, version: await versionOf(result.row), savedAt }, wrote: true };
  });
  if (done.wrote) revalidatePublic({ kind: "sessions" });
  return done.answer;
}

/**
 * Inserts a new session from `fields` after its checks (status „Toimub“), in one transaction with the course's FOR SHARE read (check): its row, or the
 * refused fields. The caller revalidates.
 */
async function insertChecked(db: Db, fields: SessionFields): Promise<{ ok: true; row: CourseSession } | { ok: false; fields: Record<string, string> }> {
  return db.transaction(async (tx) => {
    const checked = await check(tx, fields, null, NONE);
    if (!checked.ok) return checked;
    const [row] = await tx.insert(courseSessions).values({ ...checked.columns, status: "scheduled" }).returning();
    return { ok: true as const, row };
  });
}

/** „Lisa toimumine“'s answer: the new session's id and version (the drawer goes on autosaving from it), or the refused fields. */
export type CreateSessionResult = { ok: true; id: number; version: string; savedAt: string } | SessionInvalid;

/**
 * „Lisa toimumine“ (README B3, S3-P3-g: an explicit create; the drawer autosaves after it): `input` the new drawer's fields `{ courseId, date, time,
 * city, venue, language, capacity }` (nothing the browser sends is trusted: parsed and every field checked; the required ones are the course, the date
 * and the city, the others come filled in). A new session is „Toimub“ with no registrations, so neither rule of R-b / R-c can refuse it. Answers its
 * id and version (`savedAt`: `now`, for the drawer's „Salvestatud“); `{ kind: "sessions" }` revalidated once.
 */
export async function createSession(db: Db, input: unknown, now: Date): Promise<CreateSessionResult> {
  const parsed = NEW_SESSION.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid", fields: fieldCodes(parsed.error.issues) ?? {} };
  const created = await insertChecked(db, parsed.data);
  if (!created.ok) return { ok: false, error: "invalid", fields: created.fields };
  revalidatePublic({ kind: "sessions" });
  return { ok: true, id: created.row.id, version: await versionOf(created.row), savedAt: now.toISOString() };
}

/** The status action's answer: the session's version after it, a conflict with the stored version and value, or no such session. */
export type SessionStatusResult =
  | { ok: true; version: string }
  | { ok: false; error: "conflict"; version: string; value: SessionValue }
  | { ok: false; error: "notFound" | "invalid" | "server" };

/** The status action's request as the drawer sends it: `{ id, status, version }` (the version the drawer holds); null for anything else. */
export function parseStatusRequest(input: unknown): { id: number; status: SessionStatus; version: string } | null {
  const parsed = z
    .strictObject({ id: z.number().int().positive().max(ROW_ID_MAX), status: z.enum(["scheduled", "cancelled"]), version: z.string().max(100) })
    .safeParse(input);
  return parsed.success ? parsed.data : null;
}

/**
 * „Tühistatud“ / „Toimub“, instant (README B3: „Tühistatud“ with registrations behind the ConfirmPanel „Kas tühistan toimumise? …“ / „Jah, tühista“):
 * the status from `expectedVersion` (the drawer's version, R-a), under the session's lock. The registrations stay as they are (cancelling tells nobody:
 * „teavita õpilasi ise“). A conflict when the session was saved elsewhere since (the drawer shows the stored fields); the same status answers the
 * version and writes nothing. `{ kind: "sessions" }` revalidated once after a change.
 */
export async function setSessionStatus(db: Db, id: number, status: SessionStatus, expectedVersion: string): Promise<SessionStatusResult> {
  const done = await db.transaction(async (tx): Promise<{ answer: SessionStatusResult; wrote: boolean }> => {
    await lockSession(tx, id);
    const row = await sessionRow(tx, id);
    if (!row) return { answer: { ok: false, error: "notFound" }, wrote: false };
    const current = await versionOf(row);
    if (expectedVersion !== current) return { answer: { ok: false, error: "conflict", version: current, value: valueOf(row) }, wrote: false };
    if (row.status === status) return { answer: { ok: true, version: current }, wrote: false };
    const [after] = await tx.update(courseSessions).set({ status }).where(eq(courseSessions.id, id)).returning();
    return { answer: { ok: true, version: await versionOf(after) }, wrote: true };
  });
  if (done.wrote) revalidatePublic({ kind: "sessions" });
  return done.answer;
}
