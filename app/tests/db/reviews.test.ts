import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, courseFeedback, courses, courseSessions, protocols, registrations, reviews } from "@/db/schema";
import { COURSE_REVIEWS_MAX, HOME_REVIEWS_MAX, REVIEW_NAME_MAX } from "@/domain/review";
import { submitFeedback } from "@/server/course-feedback";
import {
  adminReviews, courseReviews, decideReview, deleteManualReview, homeReviews, pendingReviewCount, saveManualReview, setFeatured, withdrawReview,
} from "@/server/reviews";
import { makeTestDb } from "./helpers";
import { protocolCourse } from "./protocols-fixtures";
import { contactStudent, graduate, NOW, RECOMMEND, studentOf, submit } from "./reviews-fixtures";

// Student reviews, the server side (spec §2 D1–D4, §4, §5): the consent in the feedback submit, the student's withdrawal, Maria's decisions and
// manual reviews, the admin's list, and the two public reads (a course's block, the home page's section).

let db: Db;
let logged: () => string;
beforeEach(async () => {
  db = await makeTestDb();
  const spies = (["info", "error"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  logged = () => spies.flatMap((spy) => spy.mock.calls).map((args) => args.map(String).join(" ")).join("\n");
});
afterEach(() => vi.restoreAllMocks());

const LATER = new Date("2026-10-20T10:00:00Z");
const all = () => db.select().from(reviews).orderBy(reviews.id);
const reviewOf = async (id: number) => (await db.select().from(reviews).where(eq(reviews.id, id)))[0];
const feedbackRows = () => db.select().from(courseFeedback);
const day = (d: number, hour = 12) => new Date(Date.UTC(2026, 9, d, hour));

/** A review row for the reads' tests (`over` replaces fields): published and manual unless said. */
async function addReview(courseId: number, over: Partial<typeof reviews.$inferInsert> = {}) {
  const [row] = await db
    .insert(reviews)
    .values({ courseId, kind: "manual", text: "Tore koolitus.", name: "Anu A.", locale: "et", writtenAt: day(10), status: "published", note: "paberil", ...over })
    .returning();
  return row;
}

/** Mari's pending review of her contact course (consent given at the submit). */
async function pendingOf(name = "Mari Maasikas") {
  const s = await contactStudent(db, name);
  const result = await submit(db, s.client.id, { registrationId: s.registration.id }, { name: "Mari M." });
  expect(result.kind).toBe("submitted");
  const [review] = await all();
  return { ...s, review };
}

describe("the consent in the feedback submit", () => {
  test("with a consent: a pending review with the typed name and the recommend text, made with the feedback; the notice is publishable", async () => {
    const { course, client, registration } = await contactStudent(db);
    const result = await submit(db, client.id, { registrationId: registration.id }, { name: "  Mari   M. " }, { locale: "ru" });
    expect(result).toMatchObject({ kind: "submitted", notice: { target: { registrationId: registration.id }, name: "Mari Maasikas", course: "Kulmude lamineerimine", publishable: true } });
    const [feedback] = await feedbackRows();
    expect(await all()).toEqual([
      expect.objectContaining({
        courseId: course.id, feedbackId: feedback.id, kind: "student", text: RECOMMEND, name: "Mari M.", locale: "ru", writtenAt: NOW, status: "pending",
        featured: false, decidedAt: null, note: null,
      }),
    ]);
    expect(await pendingReviewCount(db)).toBe(1);
  });

  test("without a consent: the feedback is stored, no review is made, and the notice is not publishable", async () => {
    const { client, registration } = await contactStudent(db);
    const result = await submit(db, client.id, { registrationId: registration.id }, null);
    expect(result).toMatchObject({ kind: "submitted", notice: { publishable: false } });
    expect(await feedbackRows()).toHaveLength(1);
    expect(await all()).toEqual([]);
  });

  test("Review Focus 2: a tick without a usable answer or name is refused with its field; neither the feedback nor the review is stored", async () => {
    const { client, registration } = await contactStudent(db);
    const target = { registrationId: registration.id };
    const cases: [string, Parameters<typeof submit>[3], Parameters<typeof submit>[4], string][] = [
      ["no recommend text", { name: "Mari M." }, { answers: { score: 9 } }, "consentText"],
      ["a blank recommend text", { name: "Mari M." }, { answers: { score: 9, recommend: " \n " } }, "consentText"],
      ["no text and no name: the text first", { name: "" }, { answers: { score: 9 } }, "consentText"],
      ["an empty name", { name: "" }, undefined, "consentName"],
      ["a name of white space", { name: " \t\n " }, undefined, "consentName"],
      ["a name over 40 characters", { name: "M".repeat(REVIEW_NAME_MAX + 1) }, undefined, "consentName"],
      ["a name over 40 characters once white space is collapsed", { name: `${"M".repeat(30)}   ${"N".repeat(11)}` }, undefined, "consentName"],
    ];
    for (const [label, consent, over, kind] of cases) expect(await submit(db, client.id, target, consent, over), label).toEqual({ kind });
    expect(await feedbackRows()).toEqual([]);
    expect(await all()).toEqual([]);
    expect(logged()).not.toContain("submitted");
    // the form is not used up: a good tick still goes through
    expect(await submit(db, client.id, target, { name: "M".repeat(REVIEW_NAME_MAX) })).toMatchObject({ kind: "submitted" });
    expect((await all())[0].name).toBe("M".repeat(REVIEW_NAME_MAX));
  });

  test("the consent is checked before anything is looked up: a bad tick on a registration that is not hers is the field error, and writes nothing", async () => {
    const { registration } = await contactStudent(db);
    const [other] = await db.insert(clients).values({ email: "teine@example.test", name: "Teine" }).returning();
    expect(await submit(db, other.id, { registrationId: registration.id }, { name: "" })).toEqual({ kind: "consentName" });
    expect(await submit(db, other.id, { registrationId: registration.id }, { name: "T." })).toEqual({ kind: "notFound" });
    expect(await feedbackRows()).toEqual([]);
    expect(await all()).toEqual([]);
  });

  test("a second submit is 'sent' and writes no second review; the first review is untouched", async () => {
    const { client, registration, review } = await pendingOf();
    const again = await submit(db, client.id, { registrationId: registration.id }, { name: "Hoopis Teine" }, { answers: { recommend: "Teine tekst" }, now: LATER });
    expect(again).toEqual({ kind: "sent" });
    expect(await all()).toEqual([review]);
    expect(await feedbackRows()).toHaveLength(1);
  });

  test("'Ei soovi' first, then the answers with a consent: the review is made from the same feedback row", async () => {
    const { client, registration } = await contactStudent(db);
    await db.insert(courseFeedback).values({ registrationId: registration.id, dismissedAt: NOW, createdAt: NOW });
    expect(await submit(db, client.id, { registrationId: registration.id }, { name: "Mari M." })).toMatchObject({ kind: "submitted" });
    const [feedback] = await feedbackRows();
    expect((await all())[0].feedbackId).toBe(feedback.id);
  });

  test("the review is a copy: her account name and the registration's name changing afterwards touch nothing", async () => {
    const { client, registration, review } = await pendingOf();
    await db.update(clients).set({ name: "Hoopis Teine Nimi" }).where(eq(clients.id, client.id));
    await db.update(registrations).set({ name: "Hoopis Teine Nimi" }).where(eq(registrations.id, registration.id));
    expect(await all()).toEqual([review]);
  });

  test("a submit whose transaction does not commit leaves neither the feedback nor the review, and logs nothing as stored", async () => {
    const { client, registration } = await contactStudent(db);
    const failing = new Proxy(db, {
      get: (target, prop) =>
        prop === "transaction"
          ? (work: (tx: never) => Promise<unknown>) =>
              target.transaction(async (tx) => {
                await work(tx as never);
                throw new Error("commit failed");
              })
          : Reflect.get(target, prop, target),
    });
    await expect(
      submitFeedback(failing, { clientId: client.id, target: { registrationId: registration.id }, answers: { recommend: RECOMMEND }, locale: "et", consent: { name: "Mari M." } }, NOW),
    ).rejects.toThrow("commit failed");
    expect(await feedbackRows()).toEqual([]);
    expect(await all()).toEqual([]);
    expect(logged()).not.toMatch(/submitted|pending/);
  });

  test("the log carries ids only: no name, no text", async () => {
    const { client, registration } = await contactStudent(db);
    await submit(db, client.id, { registrationId: registration.id }, { name: "Salanimi Z." }, { answers: { recommend: "Salajane vastus 7731" } });
    const log = logged();
    expect(log).toContain(`[feedback] registration ${registration.id}: submitted`);
    for (const text of ["Salajane vastus 7731", "Salanimi", "Mari", "Maasikas", "example.test"]) expect(log, text).not.toContain(text);
  });
});

describe("withdrawReview: her permission taken back", () => {
  test("her review goes, whatever its status (pending, published and featured, hidden); the course's slug is returned", async () => {
    const first = await contactStudent(db);
    const students = [first, await studentOf(db, first.course, first.session, "Anu Aas"), await studentOf(db, first.course, first.session, "Liis Lepp")];
    for (const [i, status] of (["pending", "published", "hidden"] as const).entries()) {
      const { client, registration } = students[i];
      await submit(db, client.id, { registrationId: registration.id }, { name: "Nimi N." });
      const [feedback] = await db.select().from(courseFeedback).where(eq(courseFeedback.registrationId, registration.id));
      const [review] = await db.select().from(reviews).where(eq(reviews.feedbackId, feedback.id));
      await db.update(reviews).set({ status, featured: status === "published" }).where(eq(reviews.id, review.id));
      expect(await withdrawReview(db, client.id, review.id), status).toEqual({ ok: true, courseSlug: first.course.slug });
      expect(await db.select().from(reviews).where(eq(reviews.id, review.id)), status).toEqual([]);
      expect(logged()).toContain(`[reviews] review ${review.id}: withdrawn`);
    }
    expect(await all()).toEqual([]);
  });

  test("the feedback itself stays, and a second withdrawal finds nothing", async () => {
    const { client, review } = await pendingOf();
    expect(await withdrawReview(db, client.id, review.id)).toMatchObject({ ok: true });
    expect(await feedbackRows()).toHaveLength(1);
    expect((await feedbackRows())[0].answers).toMatchObject({ recommend: RECOMMEND });
    expect(await withdrawReview(db, client.id, review.id)).toEqual({ ok: false });
  });

  test("another client cannot take it back (not even with her registration's id): ok false, the row stays", async () => {
    const { course, session, review } = await pendingOf();
    const other = await studentOf(db, course, session, "Teine Inimene");
    expect(await withdrawReview(db, other.client.id, review.id)).toEqual({ ok: false });
    expect(await all()).toEqual([review]);
  });

  test("an e-course graduate's review goes through her access; another graduate of the same course cannot", async () => {
    const kati = await graduate(db);
    const [liis] = await db.insert(clients).values({ email: "liis@example.test", name: "Liis Lepp" }).returning();
    await submit(db, kati.client.id, { courseSlug: "kulmud-e" }, { name: "Kati K." });
    const [review] = await all();
    expect(await withdrawReview(db, liis.id, review.id)).toEqual({ ok: false });
    expect(await withdrawReview(db, kati.client.id, review.id)).toEqual({ ok: true, courseSlug: "kulmud-e" });
    expect(await all()).toEqual([]);
  });

  test("a review Maria added has no student: nobody can withdraw it; an unknown id is ok false", async () => {
    const { course, client } = await contactStudent(db);
    const manual = await addReview(course.id);
    expect(await withdrawReview(db, client.id, manual.id)).toEqual({ ok: false });
    expect(await withdrawReview(db, client.id, 99999)).toEqual({ ok: false });
    expect(await all()).toEqual([manual]);
  });
});

describe("Maria's decisions", () => {
  test("publish and hide a review: the status and decided_at change, the text and the name never do; the course's slug is returned", async () => {
    const { course, review } = await pendingOf();
    expect(await decideReview(db, review.id, "publish", LATER)).toEqual({ ok: true, courseSlug: course.slug });
    expect(await reviewOf(review.id)).toEqual({ ...review, status: "published", decidedAt: LATER, updatedAt: expect.any(Date) });
    const hiddenAt = new Date("2026-10-21T10:00:00Z");
    expect(await decideReview(db, review.id, "hide", hiddenAt)).toEqual({ ok: true, courseSlug: course.slug });
    expect(await reviewOf(review.id)).toMatchObject({ status: "hidden", decidedAt: hiddenAt, text: RECOMMEND, name: "Mari M.", writtenAt: NOW });
    expect(await decideReview(db, review.id, "publish", hiddenAt)).toMatchObject({ ok: true }); // a hidden one is published again
    expect((await reviewOf(review.id)).status).toBe("published");
  });

  test("a pending review can be hidden at once; pressing the same decision twice is harmless", async () => {
    const { review } = await pendingOf();
    expect(await decideReview(db, review.id, "hide", LATER)).toMatchObject({ ok: true });
    expect(await decideReview(db, review.id, "hide", LATER)).toMatchObject({ ok: true });
    expect(await reviewOf(review.id)).toMatchObject({ status: "hidden", decidedAt: LATER });
    expect(await pendingReviewCount(db)).toBe(0);
  });

  test("a review that is gone (the student took her permission back): 'gone', nothing is written", async () => {
    const { client, review } = await pendingOf();
    await withdrawReview(db, client.id, review.id);
    expect(await decideReview(db, review.id, "publish", LATER)).toEqual({ ok: false, error: "gone" });
    expect(await decideReview(db, 99999, "hide", LATER)).toEqual({ ok: false, error: "gone" });
    expect(await setFeatured(db, review.id, true, LATER)).toEqual({ ok: false, error: "gone" });
    expect(await all()).toEqual([]);
  });

  test("a review of an unpublished course can still be decided (it comes back with the course)", async () => {
    const { course, review } = await pendingOf();
    await db.update(courses).set({ published: false }).where(eq(courses.id, course.id));
    expect(await decideReview(db, review.id, "publish", LATER)).toMatchObject({ ok: true });
  });

  test("„Avalehel“: only a published review can be featured; un-featuring has no condition; hiding keeps `featured` and publishing again brings it back", async () => {
    const { course, review } = await pendingOf();
    expect(await setFeatured(db, review.id, true, LATER)).toEqual({ ok: false, error: "notPublished" });
    await decideReview(db, review.id, "publish", LATER);
    expect(await setFeatured(db, review.id, true, LATER)).toEqual({ ok: true, courseSlug: course.slug });
    expect(await reviewOf(review.id)).toMatchObject({ featured: true, status: "published", decidedAt: LATER });
    expect((await homeReviews(db)).map((r) => r.id)).toEqual([review.id]);
    await decideReview(db, review.id, "hide", LATER);
    expect(await reviewOf(review.id)).toMatchObject({ status: "hidden", featured: true }); // spec §5: its value stays
    expect(await homeReviews(db)).toEqual([]);
    expect(await setFeatured(db, review.id, true, LATER)).toEqual({ ok: false, error: "notPublished" }); // hidden: not now
    await decideReview(db, review.id, "publish", LATER);
    expect((await homeReviews(db)).map((r) => r.id)).toEqual([review.id]);
    await decideReview(db, review.id, "hide", LATER);
    expect(await setFeatured(db, review.id, false, LATER)).toEqual({ ok: true, courseSlug: course.slug });
    expect((await reviewOf(review.id)).featured).toBe(false);
  });

  test("toggling „Avalehel“ does not change decided_at", async () => {
    const { review } = await pendingOf();
    await decideReview(db, review.id, "publish", LATER);
    await setFeatured(db, review.id, true, new Date("2026-10-25T10:00:00Z"));
    expect((await reviewOf(review.id)).decidedAt).toEqual(LATER);
  });

  test("the log names the review by its id and what happened", async () => {
    const { review } = await pendingOf();
    await decideReview(db, review.id, "publish", LATER);
    await setFeatured(db, review.id, true, LATER);
    await decideReview(db, review.id, "hide", LATER);
    const log = logged();
    for (const line of [`review ${review.id}: published`, `review ${review.id}: featured`, `review ${review.id}: hidden`]) expect(log).toContain(`[reviews] ${line}`);
    for (const text of [RECOMMEND, "Mari", "Maasikas"]) expect(log, text).not.toContain(text);
  });
});

describe("Maria's own reviews („Lisa arvustus“)", () => {
  const form = (courseId: number, over: Record<string, unknown> = {}) => ({ courseId, name: " Kati K. ", text: " Väga hea koolitus. ", writtenAt: "2026-09-15", locale: "et", note: " Paberil vormil, 15.09 ", ...over });

  test("a new one is published at once, by Maria: no feedback, her note, the day written as Estonian midnight, not featured", async () => {
    const { course } = await protocolCourse(db);
    const result = await saveManualReview(db, null, form(course.id), LATER);
    expect(result).toEqual({ ok: true, id: expect.any(Number), courseSlug: course.slug });
    if (!result.ok) throw new Error("not saved");
    expect(await reviewOf(result.id)).toMatchObject({
      courseId: course.id, feedbackId: null, kind: "manual", text: "Väga hea koolitus.", name: "Kati K.", locale: "et", status: "published", featured: false,
      decidedAt: LATER, note: "Paberil vormil, 15.09", writtenAt: new Date("2026-09-14T21:00:00Z"),
    });
    expect((await courseReviews(db, course.id)).map((r) => r.id)).toEqual([result.id]);
    expect(logged()).toContain(`[reviews] review ${result.id}: added`);
  });

  test("a wrong form names every wrong field and writes nothing; anything but an object is a form error", async () => {
    const { course } = await protocolCourse(db);
    expect(await saveManualReview(db, null, form(course.id, { name: "", text: "x".repeat(2001), writtenAt: "2026-02-31", locale: "en", note: "" }), LATER)).toEqual({
      ok: false,
      fields: { name: "required", text: "tooLong", writtenAt: "invalid", locale: "invalid", note: "required" },
    });
    expect(await saveManualReview(db, null, "nope", LATER)).toEqual({ ok: false, fields: { form: "invalid" } });
    expect(await saveManualReview(db, null, null, LATER)).toEqual({ ok: false, fields: { form: "invalid" } });
    expect(await all()).toEqual([]);
  });

  test("a course that does not exist is a field error on `courseId`, not a database error", async () => {
    expect(await saveManualReview(db, null, form(99999), LATER)).toEqual({ ok: false, fields: { courseId: "invalid" } });
    expect(await all()).toEqual([]);
  });

  test("an e-course can have one too", async () => {
    const { course } = await graduate(db);
    expect(await saveManualReview(db, null, form(course.id), LATER)).toMatchObject({ ok: true, courseSlug: "kulmud-e" });
  });

  test("editing: the fields change, the status, `featured` and decided_at stay (a hidden one stays hidden); the course's slug is returned", async () => {
    const { course } = await protocolCourse(db);
    const saved = await saveManualReview(db, null, form(course.id), LATER);
    if (!saved.ok) throw new Error("not saved");
    await setFeatured(db, saved.id, true, LATER);
    await decideReview(db, saved.id, "hide", new Date("2026-10-21T10:00:00Z"));
    const edited = await saveManualReview(db, saved.id, form(course.id, { name: "Kati Kask", text: "Parandatud tekst.", locale: "ru", writtenAt: "2026-10-01", note: "Uus märkus" }), new Date("2026-10-22T10:00:00Z"));
    expect(edited).toEqual({ ok: true, id: saved.id, courseSlug: course.slug });
    expect(await reviewOf(saved.id)).toMatchObject({
      name: "Kati Kask", text: "Parandatud tekst.", locale: "ru", note: "Uus märkus", writtenAt: new Date("2026-09-30T21:00:00Z"),
      status: "hidden", featured: true, decidedAt: new Date("2026-10-21T10:00:00Z"), kind: "manual", feedbackId: null,
    });
    expect(logged()).toContain(`[reviews] review ${saved.id}: edited`);
  });

  test("editing into another course: the page it left is named too (previousCourseSlug), so both are refreshed", async () => {
    const { course } = await protocolCourse(db);
    const { course: other } = await graduate(db);
    const saved = await saveManualReview(db, null, form(course.id), LATER);
    if (!saved.ok) throw new Error("not saved");
    const moved = await saveManualReview(db, saved.id, form(other.id), LATER);
    expect(moved).toEqual({ ok: true, id: saved.id, courseSlug: other.slug, previousCourseSlug: course.slug });
    expect((await reviewOf(saved.id)).courseId).toBe(other.id);
    expect(await courseReviews(db, course.id)).toEqual([]);
  });

  test("a student's review is not hers to edit or delete: 'notManual', nothing changes; an unknown id is 'gone'", async () => {
    const { course, review } = await pendingOf();
    expect(await saveManualReview(db, review.id, form(course.id), LATER)).toEqual({ ok: false, fields: { form: "notManual" } });
    expect(await deleteManualReview(db, review.id)).toEqual({ ok: false });
    expect(await all()).toEqual([review]);
    expect(await saveManualReview(db, 99999, form(course.id), LATER)).toEqual({ ok: false, fields: { form: "gone" } });
  });

  test("a bad form on a student's review still names its fields first (the check needs no row); nothing is written", async () => {
    const { review } = await pendingOf();
    expect(await saveManualReview(db, review.id, {}, LATER)).toMatchObject({ ok: false, fields: { courseId: "required" } });
    expect(await all()).toEqual([review]);
  });

  test("deleting: the review is gone, the course's slug returned; a second delete is ok false", async () => {
    const { course } = await protocolCourse(db);
    const saved = await saveManualReview(db, null, form(course.id), LATER);
    if (!saved.ok) throw new Error("not saved");
    expect(await deleteManualReview(db, saved.id)).toEqual({ ok: true, courseSlug: course.slug });
    expect(await all()).toEqual([]);
    expect(await deleteManualReview(db, saved.id)).toEqual({ ok: false });
    expect(logged()).toContain(`[reviews] review ${saved.id}: deleted`);
  });
});

describe("adminReviews and pendingReviewCount", () => {
  test("by status (pending, published, hidden), the newest written first within each; each with its course, and the proof Maria judges a student by", async () => {
    const mari = await contactStudent(db);
    await db.insert(protocols).values({ registrationId: mari.registration.id, stages: [], sentAt: day(12) });
    await submit(db, mari.client.id, { registrationId: mari.registration.id }, { name: "Mari M." });
    const kati = await graduate(db);
    await submit(db, kati.client.id, { courseSlug: "kulmud-e" }, { name: "Kati K." }, { now: day(14) });
    const manual = await addReview(mari.course.id, { writtenAt: day(1), status: "published" });
    const hidden = await addReview(mari.course.id, { writtenAt: day(30), status: "hidden", name: "Peidetud P." });
    const [marisReview, katisReview] = await all();
    await decideReview(db, marisReview.id, "publish", LATER);

    const list = await adminReviews(db, {});
    expect(list.map((r) => [r.id, r.status])).toEqual([
      [katisReview.id, "pending"], // the one still waiting comes first
      [marisReview.id, "published"], // then the published ones, the newest written first
      [manual.id, "published"],
      [hidden.id, "hidden"], // the hidden one last, though it is the newest written
    ]);
    const byId = Object.fromEntries(list.map((r) => [r.id, r]));
    expect(byId[marisReview.id]).toEqual({
      id: marisReview.id, kind: "student", status: "published", featured: false, text: RECOMMEND, name: "Mari M.", locale: "et", writtenAt: NOW,
      course: { id: mari.course.id, slug: mari.course.slug, title: mari.course.title }, note: null, proof: { registrationStatus: "confirmed", protocolSent: true },
    });
    expect(byId[katisReview.id]).toMatchObject({ kind: "student", proof: { completedAt: new Date("2026-10-10T09:00:00Z") }, course: { id: kati.course.id, slug: "kulmud-e" }, note: null });
    expect(byId[manual.id]).toMatchObject({ kind: "manual", note: "paberil", proof: null });
  });

  test("the proof says when the protocol was not sent, and a cancelled registration's status", async () => {
    const mari = await contactStudent(db);
    await submit(db, mari.client.id, { registrationId: mari.registration.id }, { name: "Mari M." });
    await db.update(registrations).set({ status: "awaiting_prepayment" }).where(eq(registrations.id, mari.registration.id));
    expect((await adminReviews(db, {}))[0].proof).toEqual({ registrationStatus: "awaiting_prepayment", protocolSent: false });
    await db.insert(protocols).values({ registrationId: mari.registration.id, stages: [] }); // a draft, not sent
    expect((await adminReviews(db, {}))[0].proof).toEqual({ registrationStatus: "awaiting_prepayment", protocolSent: false });
  });

  test("the filters: by status, by course, both; a course with none is empty", async () => {
    const { course } = await protocolCourse(db);
    const { course: other } = await graduate(db);
    const a = await addReview(course.id, { status: "published" });
    const b = await addReview(course.id, { status: "hidden" });
    const c = await addReview(other.id, { status: "published" });
    const p = await addReview(other.id, { status: "pending", kind: "student", note: null, feedbackId: null });
    const ids = async (filter: Parameters<typeof adminReviews>[1]) => (await adminReviews(db, filter)).map((r) => r.id).sort((x, y) => x - y);
    expect(await ids({ status: "published" })).toEqual([a.id, c.id]);
    expect(await ids({ status: "hidden" })).toEqual([b.id]);
    expect(await ids({ status: "pending" })).toEqual([p.id]);
    expect(await ids({ courseId: other.id })).toEqual([c.id, p.id]);
    expect(await ids({ courseId: course.id, status: "published" })).toEqual([a.id]);
    expect(await ids({ courseId: 99999 })).toEqual([]);
    expect(await ids({})).toEqual([a.id, b.id, c.id, p.id]);
  });

  test("a student review whose feedback has no proof to show (no feedback left) is listed with proof null", async () => {
    const { course } = await protocolCourse(db);
    await addReview(course.id, { kind: "student", status: "pending", feedbackId: null, note: null });
    expect((await adminReviews(db, {}))[0]).toMatchObject({ kind: "student", proof: null });
  });

  test("pendingReviewCount counts the pending ones of every course, published or not", async () => {
    const { course } = await protocolCourse(db);
    const { course: other } = await graduate(db, { published: false });
    expect(await pendingReviewCount(db)).toBe(0);
    await addReview(course.id, { status: "pending", kind: "student", note: null });
    await addReview(other.id, { status: "pending", kind: "student", note: null });
    await addReview(course.id, { status: "published" });
    await addReview(course.id, { status: "hidden" });
    expect(await pendingReviewCount(db)).toBe(2);
  });
});

describe("the public reads", () => {
  test("courseReviews: the course's published reviews only, newest first, with the course; pending and hidden never", async () => {
    const { course } = await protocolCourse(db);
    const { course: other } = await graduate(db);
    const oldest = await addReview(course.id, { writtenAt: day(1), name: "Esimene E.", locale: "ru", text: "Отлично" });
    const newest = await addReview(course.id, { writtenAt: day(20) });
    const middle = await addReview(course.id, { writtenAt: day(10) });
    await addReview(course.id, { status: "pending", writtenAt: day(25), kind: "student", note: null });
    await addReview(course.id, { status: "hidden", writtenAt: day(26) });
    await addReview(other.id, { writtenAt: day(27) });
    const list = await courseReviews(db, course.id);
    expect(list.map((r) => r.id)).toEqual([newest.id, middle.id, oldest.id]);
    expect(list[2]).toEqual({ id: oldest.id, text: "Отлично", name: "Esimene E.", locale: "ru", writtenAt: day(1), course: { slug: course.slug, title: course.title } });
    expect(Object.keys(list[0]).sort()).toEqual(["course", "id", "locale", "name", "text", "writtenAt"]); // (no status, no note, no featured: nothing private)
  });

  test("courseReviews: at most COURSE_REVIEWS_MAX, the newest", async () => {
    const { course } = await protocolCourse(db);
    for (let i = 0; i < COURSE_REVIEWS_MAX + 2; i++) await addReview(course.id, { writtenAt: new Date(Date.UTC(2026, 0, 1 + i)), name: `N${i}` });
    const list = await courseReviews(db, course.id);
    expect(list).toHaveLength(COURSE_REVIEWS_MAX);
    expect(list[0].name).toBe(`N${COURSE_REVIEWS_MAX + 1}`);
    expect(list.at(-1)!.name).toBe("N2");
  });

  test("homeReviews: published and featured only, newest first, at most HOME_REVIEWS_MAX; hidden, pending and unfeatured never", async () => {
    const { course } = await protocolCourse(db);
    const { course: other } = await graduate(db);
    const ids: number[] = [];
    for (let i = 0; i < HOME_REVIEWS_MAX + 1; i++) ids.push((await addReview(i % 2 ? other.id : course.id, { featured: true, writtenAt: day(1 + i) })).id);
    await addReview(course.id, { featured: false, writtenAt: day(28) });
    await addReview(course.id, { featured: true, status: "hidden", writtenAt: day(29) });
    await addReview(course.id, { featured: true, status: "pending", kind: "student", note: null, writtenAt: day(30) });
    const list = await homeReviews(db);
    expect(list.map((r) => r.id)).toEqual(ids.slice(1).reverse());
    expect(list).toHaveLength(HOME_REVIEWS_MAX);
    expect([list[0].course, list[1].course]).toEqual([{ slug: course.slug, title: course.title }, { slug: "kulmud-e", title: other.title }]); // each names its course
  });

  test("Review Focus 3: a course that is not published shows nothing, on its page and on the home page; the reviews come back when it is published again", async () => {
    const { course } = await protocolCourse(db);
    const review = await addReview(course.id, { featured: true });
    expect((await courseReviews(db, course.id)).map((r) => r.id)).toEqual([review.id]);
    expect((await homeReviews(db)).map((r) => r.id)).toEqual([review.id]);
    await db.update(courses).set({ published: false }).where(eq(courses.id, course.id));
    expect(await courseReviews(db, course.id)).toEqual([]);
    expect(await homeReviews(db)).toEqual([]);
    expect(await all()).toHaveLength(1); // (kept)
    await db.update(courses).set({ published: true }).where(eq(courses.id, course.id));
    expect((await courseReviews(db, course.id)).map((r) => r.id)).toEqual([review.id]);
    expect((await homeReviews(db)).map((r) => r.id)).toEqual([review.id]);
  });

  test("a course deleted takes its reviews, manual ones too", async () => {
    const { course } = await protocolCourse(db);
    await addReview(course.id);
    await db.delete(courseSessions).where(eq(courseSessions.courseId, course.id));
    await db.delete(courses).where(eq(courses.id, course.id));
    expect(await all()).toEqual([]);
  });

  test("the reads run inside a caller's transaction as well (they take a Q)", async () => {
    const { course } = await protocolCourse(db);
    const review = await addReview(course.id, { featured: true });
    const [fromCourse, fromHome] = await db.transaction(async (tx) => [await courseReviews(tx, course.id), await homeReviews(tx)]);
    expect([fromCourse[0].id, fromHome[0].id]).toEqual([review.id, review.id]);
  });
});
