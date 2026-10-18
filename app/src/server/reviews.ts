import { and, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db, Q, Tx } from "@/db/client";
import { courseAccess, courseFeedback, courses, protocols, registrations, reviews } from "@/db/schema";
import { tallinnInstant } from "@/domain/calendar";
import { checkManualReview, COURSE_REVIEWS_MAX, HOME_REVIEWS_MAX, type ReviewKind, type ReviewStatus } from "@/domain/review";
import type { I18n } from "@/i18n/field";

// The student reviews (spec §2, §4, §5), without Next.js: the student's withdrawal, Maria's decisions and her own reviews, the admin's list, and the
// two public reads. A student's review is made by the feedback's submit (server/course-feedback.ts), as a copy of her answer and the name she
// chose; nothing here changes its text or name: Maria changes only `status`, `featured` and `decided_at`, and only a `manual` review is editable.
// Every change answers the course's slug: the caller (an action or a route) refreshes that course's pages and the home page with it
// (cache-targets.ts, { kind: "reviews" }). Logs carry the review's id only: no names, no texts.

const log = (id: number, what: string): void => console.info(`[reviews] review ${id}: ${what}`);

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
    .where(or(eq(registrations.clientId, clientId), eq(courseAccess.clientId, clientId)));
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
    .where(or(...mine));
  return rows.map((r) => r.slug).sort();
}

// ---------- Maria's decisions (D2) ----------

/** A review row FOR UPDATE with its course's slug, or null when there is none (the student took her permission back, or Maria deleted it). */
async function lockReview(tx: Tx, id: number) {
  const [row] = await tx
    .select({ id: reviews.id, kind: reviews.kind, status: reviews.status, courseId: reviews.courseId, slug: courses.slug })
    .from(reviews)
    .innerJoin(courses, eq(reviews.courseId, courses.id))
    .where(eq(reviews.id, id))
    .for("update", { of: reviews });
  return row ?? null;
}

export type ReviewDecision = "publish" | "hide";

/**
 * „Avalda“ or „Peida“: the review becomes published or hidden, whatever it was (pending, or the other of the two: a hidden one is published
 * again, and the same press twice is harmless), and `decided_at` is now. Hiding keeps `featured` (spec §5). `gone`: the row does not exist (any
 * more). A review of an unpublished course can be decided too: it is shown when the course is.
 */
export async function decideReview(db: Db, id: number, decision: ReviewDecision, now: Date): Promise<{ ok: true; courseSlug: string } | { ok: false; error: "gone" }> {
  const status: ReviewStatus = decision === "publish" ? "published" : "hidden";
  const slug = await db.transaction(async (tx) => {
    const row = await lockReview(tx, id);
    if (!row) return null;
    await tx.update(reviews).set({ status, decidedAt: now, updatedAt: now }).where(eq(reviews.id, id));
    return row.slug;
  });
  if (slug === null) return { ok: false, error: "gone" };
  log(id, status);
  return { ok: true, courseSlug: slug };
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

/** Deletes a review Maria added. `{ ok: false }`: it does not exist, or it is a student's (not hers to delete: the student can take her permission back). */
export async function deleteManualReview(db: Db, id: number): Promise<{ ok: true; courseSlug: string } | { ok: false }> {
  const slug = await db.transaction(async (tx) => {
    const row = await lockReview(tx, id);
    if (!row || row.kind !== "manual") return null;
    await tx.delete(reviews).where(eq(reviews.id, id));
    return row.slug;
  });
  if (slug === null) return { ok: false };
  log(id, "deleted");
  return { ok: true, courseSlug: slug };
}

// ---------- the admin's list ----------

/**
 * One review for Maria's „Arvustused“. `proof`: what she judges a student by (D2) — the registration's status and whether a protocol was sent for a
 * contact course, when the access was completed for an e-course; null for one she added herself.
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
  course: { id: number; slug: string; title: I18n };
  note: string | null;
  proof: { registrationStatus: string; protocolSent: boolean } | { completedAt: Date } | null;
};

/** The reviews, the ones waiting for Maria first, then the newest written; `status` and `courseId` narrow the list. */
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
      courseId: courses.id,
      slug: courses.slug,
      title: courses.title,
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
    .where(and(filter.status === undefined ? undefined : eq(reviews.status, filter.status), filter.courseId === undefined ? undefined : eq(reviews.courseId, filter.courseId)))
    .orderBy(sql`(${reviews.status} = 'pending') desc`, desc(reviews.writtenAt), desc(reviews.id));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    featured: r.featured,
    text: r.text,
    name: r.name,
    locale: r.locale,
    writtenAt: r.writtenAt,
    course: { id: r.courseId, slug: r.slug, title: r.title },
    note: r.note,
    proof: r.kind === "manual" ? null : r.registrationStatus !== null ? { registrationStatus: r.registrationStatus, protocolSent: r.protocolSentAt !== null } : r.completedAt !== null ? { completedAt: r.completedAt } : null,
  }));
}

/** How many reviews wait for Maria (the „Tagasiside“ page's heading), of every course. */
export async function pendingReviewCount(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(reviews).where(eq(reviews.status, "pending"));
  return Number(row.n);
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
    .where(and(eq(reviews.courseId, courseId), eq(reviews.status, "published"), eq(courses.published, true)))
    .orderBy(...NEWEST)
    .limit(COURSE_REVIEWS_MAX);
  return rows.map(toPublic);
}

/** The home page's section: published reviews marked „Avalehel“, of published courses, newest first, at most HOME_REVIEWS_MAX. */
export async function homeReviews(q: Q): Promise<PublicReview[]> {
  const rows = await publicReviews(q)
    .where(and(eq(reviews.status, "published"), eq(reviews.featured, true), eq(courses.published, true)))
    .orderBy(...NEWEST)
    .limit(HOME_REVIEWS_MAX);
  return rows.map(toPublic);
}
