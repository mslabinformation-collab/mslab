import { and, asc, count, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Q, Tx } from "@/db/client";
import { courseAccess, courseFeedback, courses, protocols, registrations, reviews } from "@/db/schema";
import type { SaveAnswer } from "@/domain/autosave";
import { tallinnFormParts, tallinnInstant } from "@/domain/calendar";
import {
  checkManualReview, COURSE_REVIEWS_MAX, HOME_REVIEWS_MAX, REVIEW_STATUSES, type DecisionExpected, type ManualReviewFields, type ReviewKind, type ReviewStatus,
} from "@/domain/review";
import type { I18n } from "@/i18n/field";
import { contentVersion } from "@/lib/version";
import { fieldCodes } from "./autosave-route";

// The student reviews (spec §2, §4, §5), without Next.js: the student's withdrawal, Maria's decisions and her own reviews, the admin's list, and the
// two public reads. A student's review is made by the feedback's submit (server/course-feedback.ts), as a copy of her answer and the name she
// chose; nothing here changes its text or name: Maria changes only `status`, `featured` and `decided_at`, and only a `manual` review is editable.
// Every change answers the course's slug: the caller (an action or a route) refreshes that course's pages and the home page with it
// (cache-targets.ts, { kind: "reviews" }). Logs carry the review's id only: no names, no texts.
// Admin UX pass piece 4c: Maria's „Kustuta“ only marks a review she added (`removed_at`, R-b), so that „Võta tagasi“ can bring it back until
// server/review-purge.ts deletes it; every read here leaves a marked review out (NOT_REMOVED), and to every change a marked review is not there.
// A decision can be undone while the review is still as the press left it (restoreReviewDecision, R-a). „Muuda“ on a review Maria added autosaves
// (readManualReview, writeManualReview: POST /api/admin/arvustus/<id>, R-c).

const log = (id: number, what: string): void => console.info(`[reviews] review ${id}: ${what}`);

/** A review Maria has not removed: what every read and every change of this file takes (a removed one waits for the purge, seen by nobody). */
const NOT_REMOVED = isNull(reviews.removedAt);

// ---------- the student takes her permission back (D6) ----------

/**
 * "Võta luba tagasi": the review of the client's own feedback (through its registration's `client_id` or its access's) is deleted, whatever its
 * status. Her answers stay with Maria; only the permission goes. `{ ok: false }`: no such review, or it is not hers (also one Maria added, which has
 * no student). The row is locked FOR UPDATE, so that a decision of Maria's at the same moment either finishes first or finds it gone.
 */
export async function withdrawReview(db: Db, clientId: number, reviewId: number): Promise<{ ok: true; courseSlug: string } | { ok: false }> {
  const slug = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ slug: courses.slug })
      .from(reviews)
      .innerJoin(courses, eq(reviews.courseId, courses.id))
      .innerJoin(courseFeedback, eq(reviews.feedbackId, courseFeedback.id))
      .leftJoin(registrations, eq(courseFeedback.registrationId, registrations.id))
      .leftJoin(courseAccess, eq(courseFeedback.accessId, courseAccess.id))
      .where(and(eq(reviews.id, reviewId), or(eq(registrations.clientId, clientId), eq(courseAccess.clientId, clientId))))
      .for("update", { of: reviews });
    if (!row) return null;
    await tx.delete(reviews).where(eq(reviews.id, reviewId));
    return row.slug;
  });
  if (slug === null) return { ok: false };
  log(reviewId, "withdrawn");
  return { ok: true, courseSlug: slug };
}

/**
 * Her reviews (one query), each with the registration or the access its feedback belongs to: what the dashboard puts on the course cards as `review`
 * (D6). Only the student's own: a review reaches her through the feedback of her registration (`registrations.client_id`) or of her access
 * (`course_access.client_id`); one Maria added has no feedback and no student.
 */
export async function reviewsOfClient(q: Q, clientId: number): Promise<{ id: number; registrationId: number | null; accessId: number | null }[]> {
  return q
    .select({ id: reviews.id, registrationId: courseFeedback.registrationId, accessId: courseFeedback.accessId })
    .from(reviews)
    .innerJoin(courseFeedback, eq(reviews.feedbackId, courseFeedback.id))
    .leftJoin(registrations, eq(courseFeedback.registrationId, registrations.id))
    .leftJoin(courseAccess, eq(courseFeedback.accessId, courseAccess.id))
    .where(and(NOT_REMOVED, or(eq(registrations.clientId, clientId), eq(courseAccess.clientId, clientId))));
}

/**
 * The slugs of the courses that have a review on the feedback of these registrations or accesses, once each, sorted: the account deletion's list of
 * pages to refresh once its reviews are gone. Read before the delete (the reviews go with their feedback, by cascade); the course's publication does not matter.
 */
export async function reviewCourseSlugs(q: Q, owners: { registrationIds: number[]; accessIds: number[] }): Promise<string[]> {
  const { registrationIds, accessIds } = owners;
  const mine = [...(registrationIds.length > 0 ? [inArray(courseFeedback.registrationId, registrationIds)] : []), ...(accessIds.length > 0 ? [inArray(courseFeedback.accessId, accessIds)] : [])];
  if (mine.length === 0) return [];
  const rows = await q
    .selectDistinct({ slug: courses.slug })
    .from(reviews)
    .innerJoin(courseFeedback, eq(reviews.feedbackId, courseFeedback.id))
    .innerJoin(courses, eq(reviews.courseId, courses.id))
    .where(and(NOT_REMOVED, or(...mine)));
  return rows.map((r) => r.slug).sort();
}

// ---------- Maria's decisions (D2) ----------

/**
 * A review row FOR UPDATE with its course's slug, or null when there is none (the student took her permission back, Maria deleted it) or Maria
 * removed it (piece 4c, R-b: a removed review reads as gone to every change until „Võta tagasi“ brings it back).
 */
async function lockReview(tx: Tx, id: number) {
  const [row] = await tx
    .select({
      id: reviews.id,
      kind: reviews.kind,
      status: reviews.status,
      decidedAt: reviews.decidedAt,
      updatedAt: reviews.updatedAt,
      courseId: reviews.courseId,
      name: reviews.name,
      text: reviews.text,
      writtenAt: reviews.writtenAt,
      locale: reviews.locale,
      note: reviews.note,
      slug: courses.slug,
    })
    .from(reviews)
    .innerJoin(courses, eq(reviews.courseId, courses.id))
    .where(and(eq(reviews.id, id), NOT_REMOVED))
    .for("update", { of: reviews });
  return row ?? null;
}

/**
 * Why lockReview found nothing (a light read, no lock): `removed`, a review Maria added and removed and not purged yet (piece 4c, review M-1: the
 * actions answer in her words, not the student's); `gone`, there is no such review (the student took her permission back, or it was purged).
 */
async function missingAs(tx: Tx, id: number): Promise<"removed" | "gone"> {
  const [removed] = await tx
    .select({ id: reviews.id })
    .from(reviews)
    .where(and(eq(reviews.id, id), eq(reviews.kind, "manual"), isNotNull(reviews.removedAt)));
  return removed ? "removed" : "gone";
}

export type ReviewDecision = "publish" | "hide";

/**
 * „Avalda“ or „Peida“: the review becomes published or hidden, whatever it was (pending, or the other of the two: a hidden one is published
 * again, and the same press twice is harmless), and `decided_at` is now. Hiding keeps `featured` (spec §5). `gone`: the row does not exist (any
 * more); `removed`: it is a review Maria added and removed (piece 4c: in another tab), not purged yet. A review of an unpublished course can be
 * decided too: it is shown when the course is. `expected` is what the press's „Võta tagasi“ sends back (piece 4c, R-a; restoreReviewDecision): the
 * row as this press left it, and the status and `decided_at` it replaced.
 */
export async function decideReview(
  db: Db,
  id: number,
  decision: ReviewDecision,
  now: Date,
): Promise<{ ok: true; courseSlug: string; expected: DecisionExpected } | { ok: false; error: "gone" | "removed" }> {
  const status: ReviewStatus = decision === "publish" ? "published" : "hidden";
  const done = await db.transaction(async (tx) => {
    const row = await lockReview(tx, id);
    if (!row) return missingAs(tx, id);
    await tx.update(reviews).set({ status, decidedAt: now, updatedAt: now }).where(eq(reviews.id, id));
    const expected: DecisionExpected = { status, updatedAt: now.toISOString(), previous: { status: row.status, decidedAt: row.decidedAt?.toISOString() ?? null } };
    return { slug: row.slug, expected };
  });
  if (done === "gone" || done === "removed") return { ok: false, error: done };
  log(id, status);
  return { ok: true, courseSlug: done.slug, expected: done.expected };
}

/**
 * Whether `expected.previous` is a state a review of `kind` can have been in before that press (piece 4c, Task 1 review I-1): the browser brings it
 * back, so it is checked before it is written. A real status; never `pending` for a review Maria added (she adds them published); `decided_at`
 * null exactly while `pending`; and a `decided_at` that is a time no later than the press. What passes is a state Maria could have made herself.
 */
function possibleBefore(kind: ReviewKind, expected: DecisionExpected): boolean {
  const { status, decidedAt } = expected.previous;
  if (!(REVIEW_STATUSES as readonly string[]).includes(status)) return false;
  if (kind === "manual" && status === "pending") return false;
  if ((status === "pending") !== (decidedAt === null)) return false;
  if (decidedAt === null) return true;
  const at = Date.parse(decidedAt);
  return Number.isFinite(at) && at <= Date.parse(expected.updatedAt);
}

/**
 * „Võta tagasi“ of „Avalda“ or „Peida“ (piece 4c, R-a): the status and `decided_at` the press replaced (`expected.previous`) are put back, while the
 * review is still as that press left it: its status and its `updated_at` are `expected`'s. Anything since (a decision in another tab, the same
 * press again, „Avalehel“, an edit) is `changed`, and nothing is written: the bar says S4-38's „Arvustust muudeti vahepeal. Vaata see üle.“. A
 * `previous` no press can have replaced (possibleBefore: a forged one) is `changed` too, and writes nothing. `featured` is not touched (a decision
 * never changes it). `removed`: it is a review Maria added and removed since (review M-1: the action answers in her words, not the student's);
 * `gone`: the review is not there (any more). Under the row's lock, so that two undos, or an undo and a decision, queue.
 */
export async function restoreReviewDecision(
  db: Db,
  id: number,
  expected: DecisionExpected,
  now: Date,
): Promise<{ ok: true; courseSlug: string } | { ok: false; error: "gone" | "removed" | "changed" }> {
  const { previous } = expected;
  const result = await db.transaction(async (tx) => {
    const row = await lockReview(tx, id);
    if (!row) return missingAs(tx, id);
    if (row.status !== expected.status || row.updatedAt.getTime() !== Date.parse(expected.updatedAt)) return "changed" as const;
    if (!possibleBefore(row.kind, expected)) return "changed" as const;
    await tx
      .update(reviews)
      .set({ status: previous.status, decidedAt: previous.decidedAt === null ? null : new Date(previous.decidedAt), updatedAt: now })
      .where(eq(reviews.id, id));
    return { slug: row.slug };
  });
  if (result === "gone" || result === "removed" || result === "changed") return { ok: false, error: result };
  log(id, `back to ${previous.status}`);
  return { ok: true, courseSlug: result.slug };
}

/**
 * „Avalehel“: a published review also on the home page, or not. Turning it on needs `published` (`notPublished` otherwise: a pending or hidden one
 * is not shown anywhere); turning it off has no condition. `gone`: the row does not exist. `decided_at` is not touched: it is when she last
 * published or hid the review.
 */
export async function setFeatured(
  db: Db,
  id: number,
  featured: boolean,
  now: Date,
): Promise<{ ok: true; courseSlug: string } | { ok: false; error: "gone" | "notPublished" }> {
  const result = await db.transaction(async (tx) => {
    const row = await lockReview(tx, id);
    if (!row) return "gone" as const;
    if (featured && row.status !== "published") return "notPublished" as const;
    await tx.update(reviews).set({ featured, updatedAt: now }).where(eq(reviews.id, id));
    return row.slug;
  });
  if (result === "gone" || result === "notPublished") return { ok: false, error: result };
  log(id, featured ? "featured" : "unfeatured");
  return { ok: true, courseSlug: result };
}

// ---------- the reviews Maria adds (D4) ----------

/**
 * „Lisa arvustus“ (new: `id` null) or an edit of a review Maria added: `raw` is the form as it came (domain/review.ts checkManualReview names every
 * wrong field; a course that does not exist is `courseId: "invalid"`). A new review is published at once (she adds it herself), not featured; the
 * day she gives is the Estonian midnight of it. An edit changes the form's fields only: its status, `featured` and `decided_at` stay (a hidden
 * one stays hidden). Only a `manual` review: a student's answers `{ form: "notManual" }`, an id that does not exist `{ form: "gone" }`. When an
 * edit moves the review to another course, `previousCourseSlug` names the page it left, which the caller refreshes as well.
 */
export async function saveManualReview(
  db: Db,
  id: number | null,
  raw: unknown,
  now: Date,
): Promise<{ ok: true; id: number; courseSlug: string; previousCourseSlug?: string } | { ok: false; fields: Record<string, string> }> {
  const checked = checkManualReview(raw);
  if (!checked.ok) return { ok: false, fields: checked.fields };
  const form = checked.value;
  const writtenAt = tallinnInstant(form.writtenAt, "00:00");
  if (writtenAt === null) return { ok: false, fields: { writtenAt: "invalid" } }; // (checkManualReview has seen a real day)
  const fields = { name: form.name, text: form.text, locale: form.locale, writtenAt, note: form.note, courseId: form.courseId, updatedAt: now };
  const saved = await db.transaction(async (tx): Promise<{ fields: Record<string, string> } | { id: number; courseSlug: string; added: boolean; previousCourseSlug?: string }> => {
    // the course first, then the review: the order a course's deletion takes them in (it cascades to its reviews)
    const [course] = await tx.select({ slug: courses.slug }).from(courses).where(eq(courses.id, form.courseId)).for("key share");
    if (!course) return { fields: { courseId: "invalid" } };
    if (id === null) {
      const [row] = await tx
        .insert(reviews)
        .values({ ...fields, feedbackId: null, kind: "manual", status: "published", featured: false, decidedAt: now, createdAt: now })
        .returning();
      return { id: row.id, courseSlug: course.slug, added: true };
    }
    const current = await lockReview(tx, id);
    if (!current) return { fields: { form: "gone" } };
    if (current.kind !== "manual") return { fields: { form: "notManual" } };
    await tx.update(reviews).set(fields).where(eq(reviews.id, id));
    return { id, courseSlug: course.slug, added: false, ...(current.courseId !== form.courseId ? { previousCourseSlug: current.slug } : {}) };
  });
  if ("fields" in saved) return { ok: false, fields: saved.fields };
  log(saved.id, saved.added ? "added" : "edited");
  return { ok: true, id: saved.id, courseSlug: saved.courseSlug, ...(saved.previousCourseSlug ? { previousCourseSlug: saved.previousCourseSlug } : {}) };
}

// ---------- „Muuda“: a review Maria added, autosaved (piece 4c, R-c) ----------

/**
 * The patch of „Muuda“'s autosave (POST /api/admin/arvustus/<id>, the route's schema): some of ManualReviewFields as typed, no other key. These are the
 * outer limits only, each refusal its field's code: the real rules are checkManualReview's (required, tooLong, invalid), on the review as it would be.
 */
export const MANUAL_REVIEW_PATCH = z
  .strictObject(
    {
      courseId: z.string({ error: "invalid" }).max(20, "invalid"),
      name: z.string({ error: "invalid" }).max(1_000, "tooLong"),
      text: z.string({ error: "invalid" }).max(20_000, "tooLong"),
      writtenAt: z.string({ error: "invalid" }).max(40, "invalid"),
      locale: z.string({ error: "invalid" }).max(10, "invalid"),
      note: z.string({ error: "invalid" }).max(5_000, "tooLong"),
    },
    { error: "invalid" },
  )
  .partial();

type EditableRow = { courseId: number; name: string; text: string; writtenAt: Date; locale: "et" | "ru"; note: string | null };

/** A stored review as „Muuda“'s fields hold it: the course's id as text, the day written in Estonian time, no note as "". */
const fieldsOfReview = (row: EditableRow): ManualReviewFields => ({
  courseId: String(row.courseId),
  name: row.name,
  text: row.text,
  writtenAt: tallinnFormParts(row.writtenAt).date,
  locale: row.locale,
  note: row.note ?? "",
});

/** R-c: "r:" and the hash of the stored {courseId, name, text, writtenAt, locale, note} (never the status or „Avalehel“: a decision changes no field). */
const editVersionOf = async (row: EditableRow): Promise<string> =>
  `r:${await contentVersion({ courseId: row.courseId, name: row.name, text: row.text, writtenAt: row.writtenAt, locale: row.locale, note: row.note })}`;

/**
 * „Muuda“'s drawer (the autosave route's `read`): the version (R-c) and the fields of a review Maria added. Null when there is none to edit: no such
 * review, one she removed, or a student's — a student's words are never edited (builder notes §5 C6).
 */
export async function readManualReview(q: Q, id: number): Promise<{ version: string; value: ManualReviewFields } | null> {
  const [row] = await q
    .select({ courseId: reviews.courseId, name: reviews.name, text: reviews.text, writtenAt: reviews.writtenAt, locale: reviews.locale, note: reviews.note })
    .from(reviews)
    .where(and(eq(reviews.id, id), eq(reviews.kind, "manual"), NOT_REMOVED))
    .limit(1);
  return row ? { version: await editVersionOf(row), value: fieldsOfReview(row) } : null;
}

/**
 * The fields a refusal names (the rule of server/session-edit.ts refusedFields): when none of the refused fields was sent (a stored field the rules no
 * longer take), every field sent is named with it, so that the drawer does not send them again unchanged.
 */
function refusedOf(fields: Record<string, string>, sent: string[]): Record<string, string> {
  if (Object.keys(fields).some((n) => sent.includes(n))) return fields;
  const code = Object.values(fields)[0] ?? "invalid";
  return { ...fields, ...Object.fromEntries(sent.map((n) => [n, code])) };
}

/**
 * „Muuda“'s autosave (the route's `write`; server/autosave-route.ts' contract): `patch` (some of the fields) over the review at `version`, under the
 * review's lock. The answers:
 * - ok with the version after it; a patch that changes nothing answers the version it came from and writes nothing (so a decision's „Võta tagasi“
 *   is not made `changed` by a save of nothing);
 * - a conflict with the stored version and fields when `version` is not the review's (another tab saved first); one not there any more (removed,
 *   or purged), or a student's: version "", value null;
 * - invalid with the fields' codes (checkManualReview on the review as it would be; a course that does not exist is `courseId: "invalid"`).
 * A write keeps the status, `featured` and `decided_at`, and sets `updated_at`. `courseSlugs`: the course pages to revalidate after the commit — the
 * review's course, and the one it left when the course changed; none when nothing was written. No Next.js here: the route revalidates.
 */
export async function writeManualReview(
  db: Db,
  id: number,
  patch: Record<string, unknown>,
  version: string,
  now: Date,
): Promise<{ answer: SaveAnswer; courseSlugs: string[] }> {
  const parsed = MANUAL_REVIEW_PATCH.safeParse(patch);
  if (!parsed.success) return { answer: { ok: false, error: "invalid", fields: fieldCodes(parsed.error.issues) ?? Object.fromEntries(Object.keys(patch).map((k) => [k, "invalid"])) }, courseSlugs: [] };
  const sent = Object.keys(parsed.data);
  const done = await db.transaction(async (tx): Promise<{ answer: SaveAnswer; courseSlugs: string[] }> => {
    const row = await lockReview(tx, id);
    if (!row || row.kind !== "manual") return { answer: { ok: false, error: "conflict", version: "", value: null }, courseSlugs: [] };
    const current = await editVersionOf(row);
    if (version !== current) return { answer: { ok: false, error: "conflict", version: current, value: fieldsOfReview(row) }, courseSlugs: [] };
    const checked = checkManualReview({ ...fieldsOfReview(row), ...parsed.data });
    if (!checked.ok) return { answer: { ok: false, error: "invalid", fields: refusedOf(checked.fields, sent) }, courseSlugs: [] };
    // a field sent is stored as checked (trimmed; the day its Estonian midnight), one not sent stays as it is (a day keeps its time of day)
    const form = checked.value;
    const day = fieldsOfReview(row).writtenAt;
    const next: EditableRow & { note: string } = {
      courseId: sent.includes("courseId") ? form.courseId : row.courseId,
      name: sent.includes("name") ? form.name : row.name,
      text: sent.includes("text") ? form.text : row.text,
      locale: sent.includes("locale") ? form.locale : row.locale,
      note: sent.includes("note") ? form.note : (row.note ?? ""),
      writtenAt: sent.includes("writtenAt") && form.writtenAt !== day ? tallinnInstant(form.writtenAt, "00:00")! : row.writtenAt, // (checkManualReview has seen a real day)
    };
    const same = next.courseId === row.courseId && next.name === row.name && next.text === row.text && next.locale === row.locale && next.note === (row.note ?? "") && next.writtenAt === row.writtenAt;
    if (same) return { answer: { ok: true, version: current, savedAt: now.toISOString() }, courseSlugs: [] };
    let slug = row.slug;
    if (next.courseId !== row.courseId) {
      // the course it moves to must be there (FOR KEY SHARE: a deletion of it waits, or is waited for and leaves nothing here)
      const [course] = await tx.select({ slug: courses.slug }).from(courses).where(eq(courses.id, next.courseId)).for("key share");
      if (!course) return { answer: { ok: false, error: "invalid", fields: { courseId: "invalid" } }, courseSlugs: [] };
      slug = course.slug;
    }
    await tx.update(reviews).set({ ...next, updatedAt: now }).where(eq(reviews.id, id));
    return { answer: { ok: true, version: await editVersionOf(next), savedAt: now.toISOString() }, courseSlugs: slug === row.slug ? [slug] : [slug, row.slug] };
  });
  if (done.courseSlugs.length > 0) log(id, "edited");
  return done;
}

/**
 * „Kustuta“ on a review Maria added (piece 4c, R-b; S4-38 „Arvustus kustutatud.“ with „Võta tagasi“): the row is only marked (`removed_at = now`),
 * so every read leaves it out and restoreManualReview can bring it back; server/review-purge.ts deletes it once the mark is 10 s old. `notManual`: a
 * student's words are never Maria's to delete (she can hide them; the student takes her permission back). `gone`: no such review, or removed already.
 */
export async function removeManualReview(db: Db, id: number, now: Date): Promise<{ ok: true; courseSlug: string } | { ok: false; error: "gone" | "notManual" }> {
  const result = await db.transaction(async (tx) => {
    const row = await lockReview(tx, id);
    if (!row) return "gone" as const;
    if (row.kind !== "manual") return "notManual" as const;
    await tx.update(reviews).set({ removedAt: now, updatedAt: now }).where(eq(reviews.id, id));
    return { slug: row.slug };
  });
  if (result === "gone" || result === "notManual") return { ok: false, error: result };
  log(id, "removed");
  return { ok: true, courseSlug: result.slug };
}

/**
 * „Võta tagasi“ of „Kustuta“ (piece 4c, R-b): the mark is cleared while the row is still there, under the row's lock, so the purge either finds it
 * cleared (its DELETE checks the mark again) or has taken it first. The review comes back as it was: its status, `featured` and text. `gone`: it was
 * purged already, or it is not a removed review of Maria's.
 */
export async function restoreManualReview(db: Db, id: number, now: Date): Promise<{ ok: true; courseSlug: string } | { ok: false; error: "gone" }> {
  const slug = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ slug: courses.slug })
      .from(reviews)
      .innerJoin(courses, eq(reviews.courseId, courses.id))
      .where(and(eq(reviews.id, id), eq(reviews.kind, "manual"), isNotNull(reviews.removedAt)))
      .for("update", { of: reviews });
    if (!row) return null;
    await tx.update(reviews).set({ removedAt: null, updatedAt: now }).where(eq(reviews.id, id));
    return row.slug;
  });
  if (slug === null) return { ok: false, error: "gone" };
  log(id, "restored");
  return { ok: true, courseSlug: slug };
}

// ---------- the admin's list ----------

/**
 * One review for Maria's „Arvustused“. `proof`: what she judges a student by (D2) — the registration's status and whether a protocol was sent for a
 * contact course, when the access was completed for an e-course; null for one she added herself. `feedbackId` and `score` (piece 4c): the answer
 * the review was made from and its „Hinne“ (0–10), the card's stars (domain/review.ts starsOf); both null for one she added, `score` null too for an
 * answer without one.
 */
export type AdminReviewRow = {
  id: number;
  kind: ReviewKind;
  status: ReviewStatus;
  featured: boolean;
  text: string;
  name: string;
  locale: "et" | "ru";
  writtenAt: Date;
  /** `published`: the course is on the public site; a review of a draft shows nowhere until it is (the final review's M2). */
  course: { id: number; slug: string; title: I18n; published: boolean };
  note: string | null;
  proof: { registrationStatus: string; protocolSent: boolean } | { completedAt: Date } | null;
  feedbackId: number | null;
  score: number | null;
};

/** The answer's „Hinne“ as a whole number, or null: none in the answer, or a value no form stores (the list is read, never refused for it). */
const SCORE = sql<number | null>`case when ${courseFeedback.answers}->>'score' ~ '^[0-9]{1,2}$' then (${courseFeedback.answers}->>'score')::int end`;

/** The reviews by status (waiting for Maria, then published, then hidden: spec D2), the newest written first within each; `status` and `courseId` narrow the list. */
export async function adminReviews(db: Db, filter: { status?: ReviewStatus; courseId?: number }): Promise<AdminReviewRow[]> {
  const rows = await db
    .select({
      id: reviews.id,
      kind: reviews.kind,
      status: reviews.status,
      featured: reviews.featured,
      text: reviews.text,
      name: reviews.name,
      locale: reviews.locale,
      writtenAt: reviews.writtenAt,
      note: reviews.note,
      feedbackId: reviews.feedbackId,
      score: SCORE,
      courseId: courses.id,
      slug: courses.slug,
      title: courses.title,
      coursePublished: courses.published,
      registrationStatus: registrations.status,
      protocolSentAt: protocols.sentAt,
      completedAt: courseAccess.completedAt,
    })
    .from(reviews)
    .innerJoin(courses, eq(reviews.courseId, courses.id))
    .leftJoin(courseFeedback, eq(reviews.feedbackId, courseFeedback.id))
    .leftJoin(registrations, eq(courseFeedback.registrationId, registrations.id))
    .leftJoin(protocols, eq(protocols.registrationId, registrations.id))
    .leftJoin(courseAccess, eq(courseFeedback.accessId, courseAccess.id))
    .where(and(NOT_REMOVED, filter.status === undefined ? undefined : eq(reviews.status, filter.status), filter.courseId === undefined ? undefined : eq(reviews.courseId, filter.courseId)))
    .orderBy(sql`case ${reviews.status} when 'pending' then 0 when 'published' then 1 else 2 end`, desc(reviews.writtenAt), desc(reviews.id));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    featured: r.featured,
    text: r.text,
    name: r.name,
    locale: r.locale,
    writtenAt: r.writtenAt,
    course: { id: r.courseId, slug: r.slug, title: r.title, published: r.coursePublished },
    note: r.note,
    proof: r.kind === "manual" ? null : r.registrationStatus !== null ? { registrationStatus: r.registrationStatus, protocolSent: r.protocolSentAt !== null } : r.completedAt !== null ? { completedAt: r.completedAt } : null,
    feedbackId: r.feedbackId,
    score: r.score === null ? null : Number(r.score),
  }));
}

/** The courses Maria's „Lisa arvustus“ can name: every course, drafts too (a review of a draft shows once the course is published), in the public order. */
export async function reviewCourses(q: Q): Promise<{ id: number; title: I18n; published: boolean }[]> {
  return q.select({ id: courses.id, title: courses.title, published: courses.published }).from(courses).orderBy(asc(courses.sort), asc(courses.id));
}

/**
 * The review each of these feedback answers gave rise to, by feedback id (the student's drawer: whether she allowed publishing, and what became of it).
 * An answer without an entry gave no permission: it never became a review.
 */
export async function reviewsOfFeedback(q: Q, feedbackIds: number[]): Promise<Map<number, { id: number; status: ReviewStatus; featured: boolean }>> {
  if (feedbackIds.length === 0) return new Map();
  const rows = await q
    .select({ feedbackId: reviews.feedbackId, id: reviews.id, status: reviews.status, featured: reviews.featured })
    .from(reviews)
    .where(and(inArray(reviews.feedbackId, feedbackIds), NOT_REMOVED));
  return new Map(rows.flatMap((r) => (r.feedbackId === null ? [] : [[r.feedbackId, { id: r.id, status: r.status, featured: r.featured }] as const])));
}

/** How many reviews wait for Maria (the „Tagasiside“ page's heading), of every course. */
export async function pendingReviewCount(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(reviews).where(and(eq(reviews.status, "pending"), NOT_REMOVED));
  return Number(row.n);
}

/** The reviews by status, of every course (piece 4c, R-e: the numbers of „Arvustused“'s pills); a status with none is 0. */
export async function reviewCounts(db: Db): Promise<Record<ReviewStatus, number>> {
  const rows = await db.select({ status: reviews.status, n: count() }).from(reviews).where(NOT_REMOVED).groupBy(reviews.status);
  const counts: Record<ReviewStatus, number> = { pending: 0, published: 0, hidden: 0 };
  for (const r of rows) if (r.status in counts) counts[r.status] = Number(r.n);
  return counts;
}

// ---------- the public reads (D5) ----------

/** What a public page shows of a review: the words, the name, the language, the day written (the page shows its month) and the course. Nothing private. */
export type PublicReview = { id: number; text: string; name: string; locale: "et" | "ru"; writtenAt: Date; course: { slug: string; title: I18n } };

function publicReviews(q: Q) {
  return q
    .select({ id: reviews.id, text: reviews.text, name: reviews.name, locale: reviews.locale, writtenAt: reviews.writtenAt, slug: courses.slug, title: courses.title })
    .from(reviews)
    .innerJoin(courses, eq(reviews.courseId, courses.id));
}

const toPublic = (r: Awaited<ReturnType<typeof publicReviews>>[number]): PublicReview => ({
  id: r.id,
  text: r.text,
  name: r.name,
  locale: r.locale,
  writtenAt: r.writtenAt,
  course: { slug: r.slug, title: r.title },
});

const NEWEST = [desc(reviews.writtenAt), desc(reviews.id)] as const;

/** A course page's block: its published reviews, newest first, at most COURSE_REVIEWS_MAX. Nothing while the course is not published (spec §5). */
export async function courseReviews(q: Q, courseId: number): Promise<PublicReview[]> {
  const rows = await publicReviews(q)
    .where(and(eq(reviews.courseId, courseId), eq(reviews.status, "published"), eq(courses.published, true), NOT_REMOVED))
    .orderBy(...NEWEST)
    .limit(COURSE_REVIEWS_MAX);
  return rows.map(toPublic);
}

/** The home page's section: published reviews marked „Avalehel“, of published courses, newest first, at most HOME_REVIEWS_MAX. */
export async function homeReviews(q: Q): Promise<PublicReview[]> {
  const rows = await publicReviews(q)
    .where(and(eq(reviews.status, "published"), eq(reviews.featured, true), eq(courses.published, true), NOT_REMOVED))
    .orderBy(...NEWEST)
    .limit(HOME_REVIEWS_MAX);
  return rows.map(toPublic);
}
