import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courseFeedback, reviews } from "@/db/schema";
import type { ManualReviewInput } from "@/domain/review";
import { adminEt } from "@/i18n/dict/admin";
import { withdrawReview } from "@/server/reviews";
import { makeTestDb } from "./helpers";
import { protocolCourse } from "./protocols-fixtures";
import { contactStudent, RECOMMEND, submit } from "./reviews-fixtures";

// Maria's review actions on a real (PGlite) database (student reviews, Task 4; spec D2, D4, §5; Review Focus 5): „Avalda“ and „Peida“, the „Avalehel“
// toggle, „Lisa arvustus“ (new and edited) and „Kustuta“, each through adminAction (a stand-in here: the guard is tests/unit/admin-guards.test.ts's).
// What each answers, what it stores, that a success revalidates the pages of the review's course (both of them when an edit moves it) and then
// refreshes the open page, that a refusal revalidates nothing, and that a review the student has just withdrawn is answered in words, with the page
// refreshed so the row is gone: no 500 and no stale row.

const state = vi.hoisted(() => ({ db: null as unknown }));
const cache = vi.hoisted(() => ({ refresh: vi.fn() }));
const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => cache);
vi.mock("@/server/public-cache", () => pub);
vi.mock("@/server/auth", () => ({ adminAction: (fn: (admin: unknown, ...args: unknown[]) => unknown) => (...args: unknown[]) => fn({ email: "admin@example.test" }, ...args) }));

const actions = await import("@/server/actions/admin-reviews");
const E = adminEt.reviews.errors;

let db: Db;
let logged: () => string;
beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  cache.refresh.mockReset();
  pub.revalidatePublic.mockReset();
  const spies = (["info", "warn", "error"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  logged = () => spies.flatMap((spy) => spy.mock.calls).map((args) => args.map(String).join(" ")).join("\n");
});
afterEach(() => vi.restoreAllMocks());

const all = () => db.select().from(reviews).orderBy(reviews.id);
const reviewOf = async (id: number) => (await db.select().from(reviews).where(eq(reviews.id, id)))[0];
const revalidated = () => pub.revalidatePublic.mock.calls.map((c) => c[0]);

/** Mari's pending review of her contact course (consent given at the submit), with the student and her course. */
async function pendingOf(name = "Mari Maasikas") {
  const s = await contactStudent(db, name);
  const result = await submit(db, s.client.id, { registrationId: s.registration.id }, { name: "Mari M." });
  expect(result.kind).toBe("submitted");
  const [review] = await all();
  return { ...s, review };
}

/** The form „Lisa arvustus“ sends for `courseId` (`over` replaces fields). */
const form = (courseId: number, over: Record<string, unknown> = {}) =>
  ({
    id: null,
    courseId,
    name: "Anu A.",
    text: "Väga hea koolitus, soovitan!",
    writtenAt: "2026-09-20",
    locale: "et",
    note: "Paberil vormil, 20.09.2026",
    ...over,
  }) as { id: number | null } & ManualReviewInput;

describe("decideReviewAction: „Avalda“ and „Peida“", () => {
  test("„Avalda“ on a pending review: it is published, decided now; the course's pages are revalidated, then the open page is refreshed", async () => {
    const { review, course } = await pendingOf();
    expect(await actions.decideReviewAction({ id: review.id, decision: "publish" })).toEqual({ ok: true });
    expect(await reviewOf(review.id)).toMatchObject({ status: "published", featured: false, text: RECOMMEND, name: "Mari M." });
    expect((await reviewOf(review.id)).decidedAt).toBeInstanceOf(Date);
    expect(revalidated()).toEqual([{ kind: "reviews", course: course.slug }]);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    // the pages are marked stale before the open page is rendered again
    expect(pub.revalidatePublic.mock.invocationCallOrder[0]).toBeLessThan(cache.refresh.mock.invocationCallOrder[0]);
  });

  test("„Peida“ on a pending or a published review hides it and keeps „Avalehel“; „Avalda“ on a hidden one publishes it again; the same press twice is harmless", async () => {
    const { review, course } = await pendingOf();
    await actions.decideReviewAction({ id: review.id, decision: "publish" });
    expect(await actions.setFeaturedAction({ id: review.id, featured: true })).toEqual({ ok: true });
    expect(await actions.decideReviewAction({ id: review.id, decision: "hide" })).toEqual({ ok: true });
    expect(await reviewOf(review.id)).toMatchObject({ status: "hidden", featured: true });
    expect(await actions.decideReviewAction({ id: review.id, decision: "hide" })).toEqual({ ok: true });
    expect(await actions.decideReviewAction({ id: review.id, decision: "publish" })).toEqual({ ok: true });
    expect(await reviewOf(review.id)).toMatchObject({ status: "published", featured: true });
    expect(revalidated()).toEqual(Array.from({ length: 5 }, () => ({ kind: "reviews", course: course.slug })));
    expect(cache.refresh).toHaveBeenCalledTimes(5);
  });

  test("Review Focus 5: „Avalda“ on a review the student has just withdrawn answers the friendly text: no throw, the page refreshed so the row is gone, nothing revalidated", async () => {
    const { review, client } = await pendingOf();
    expect(await withdrawReview(db, client.id, review.id)).toMatchObject({ ok: true });
    const answer = await actions.decideReviewAction({ id: review.id, decision: "publish" });
    expect(answer).toEqual({ ok: false, error: "gone", text: "Seda arvustust enam pole — õpilane võttis loa tagasi." });
    expect(E.gone).toBe("Seda arvustust enam pole — õpilane võttis loa tagasi.");
    expect(await all()).toEqual([]);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    // „Peida“ and „Avalehel“ on the same withdrawn review answer the same
    expect(await actions.decideReviewAction({ id: review.id, decision: "hide" })).toMatchObject({ ok: false, error: "gone", text: E.gone });
    expect(await actions.setFeaturedAction({ id: review.id, featured: true })).toMatchObject({ ok: false, error: "gone", text: E.gone });
    expect(await actions.setFeaturedAction({ id: review.id, featured: false })).toMatchObject({ ok: false, error: "gone", text: E.gone });
    // her answers stay with Maria: only the permission went
    expect(await db.select().from(courseFeedback)).toHaveLength(1);
  });

  test("an id or a decision the page never sends is `gone` without touching anything; the page is not refreshed", async () => {
    const { review } = await pendingOf();
    for (const bad of [{ id: 0, decision: "publish" }, { id: "1", decision: "publish" }, { id: review.id, decision: "delete" }, { id: review.id }, { id: 2_147_483_648, decision: "hide" }, null, undefined, "publish"]) {
      expect(await actions.decideReviewAction(bad as never), JSON.stringify(bad)).toMatchObject({ ok: false, error: "gone", text: E.gone });
    }
    expect(await reviewOf(review.id)).toMatchObject({ status: "pending", decidedAt: null });
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("a throw is `server` in words, logged by the review's id and the error's class only; nothing is revalidated or refreshed", async () => {
    state.db = { transaction: () => Promise.reject(new TypeError("boom: Mari M., Soovitaksin kindlasti")) };
    expect(await actions.decideReviewAction({ id: 7, decision: "publish" })).toEqual({ ok: false, error: "server", text: E.server });
    expect(logged()).toContain("TypeError");
    expect(logged()).toContain("review 7");
    for (const secret of ["Mari", "Soovitaksin", "boom"]) expect(logged()).not.toContain(secret);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });
});

describe("setFeaturedAction: „Avalehel“", () => {
  test("a published review is put on the home page and taken off again; each is revalidated and refreshed", async () => {
    const { review, course } = await pendingOf();
    await actions.decideReviewAction({ id: review.id, decision: "publish" });
    pub.revalidatePublic.mockClear();
    cache.refresh.mockClear();
    expect(await actions.setFeaturedAction({ id: review.id, featured: true })).toEqual({ ok: true });
    expect(await reviewOf(review.id)).toMatchObject({ status: "published", featured: true });
    expect(await actions.setFeaturedAction({ id: review.id, featured: false })).toEqual({ ok: true });
    expect(await reviewOf(review.id)).toMatchObject({ featured: false });
    expect(revalidated()).toEqual([{ kind: "reviews", course: course.slug }, { kind: "reviews", course: course.slug }]);
    expect(cache.refresh).toHaveBeenCalledTimes(2);
  });

  test("a pending or a hidden review cannot be put on the home page: `notPublished` in words, nothing changes and nothing is revalidated; the page refreshes, so that a row with a stale status shows its own", async () => {
    const { review } = await pendingOf();
    const answer = await actions.setFeaturedAction({ id: review.id, featured: true });
    expect(answer).toEqual({ ok: false, error: "notPublished", text: "Avalehel saab olla ainult avaldatud arvustus." });
    expect(E.notPublished).toBe("Avalehel saab olla ainult avaldatud arvustus.");
    await actions.decideReviewAction({ id: review.id, decision: "hide" });
    pub.revalidatePublic.mockClear();
    cache.refresh.mockClear();
    expect(await actions.setFeaturedAction({ id: review.id, featured: true })).toMatchObject({ ok: false, error: "notPublished" });
    expect(await reviewOf(review.id)).toMatchObject({ status: "hidden", featured: false });
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  test("taking it off needs no condition: a hidden review that keeps „Avalehel“ can be cleared", async () => {
    const { review } = await pendingOf();
    await actions.decideReviewAction({ id: review.id, decision: "publish" });
    await actions.setFeaturedAction({ id: review.id, featured: true });
    await actions.decideReviewAction({ id: review.id, decision: "hide" });
    expect(await actions.setFeaturedAction({ id: review.id, featured: false })).toEqual({ ok: true });
    expect(await reviewOf(review.id)).toMatchObject({ status: "hidden", featured: false });
  });

  test("an id or a flag the page never sends is `gone` without touching anything", async () => {
    const { review } = await pendingOf();
    for (const bad of [{ id: 0, featured: true }, { id: review.id, featured: "yes" }, { id: review.id }, { id: "1", featured: false }, null]) {
      expect(await actions.setFeaturedAction(bad as never), JSON.stringify(bad)).toMatchObject({ ok: false, error: "gone" });
    }
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });
});

describe("saveManualReviewAction: „Lisa arvustus“ and „Muuda“", () => {
  test("a new review is published at once, not on the home page, with the day she gave (Estonian midnight) and her note; its course's pages are revalidated, then the page refreshes", async () => {
    const { course } = await protocolCourse(db);
    const answer = await actions.saveManualReviewAction(form(course.id));
    expect(answer).toMatchObject({ ok: true, id: expect.any(Number) });
    const [row] = await all();
    expect(row).toMatchObject({
      kind: "manual", status: "published", featured: false, feedbackId: null, courseId: course.id, name: "Anu A.", text: "Väga hea koolitus, soovitan!", locale: "et",
      note: "Paberil vormil, 20.09.2026", writtenAt: new Date("2026-09-19T21:00:00Z"),
    });
    expect(revalidated()).toEqual([{ kind: "reviews", course: course.slug }]);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    expect(pub.revalidatePublic.mock.invocationCallOrder[0]).toBeLessThan(cache.refresh.mock.invocationCallOrder[0]);
  });

  test("a refused field comes back by name (the note is required, the name has its limit, the day must be real); nothing is stored, revalidated or refreshed", async () => {
    const { course } = await protocolCourse(db);
    expect(await actions.saveManualReviewAction(form(course.id, { note: "   " }))).toEqual({ ok: false, fields: { note: "required" } });
    expect(await actions.saveManualReviewAction(form(course.id, { name: "A".repeat(41), text: "", writtenAt: "2026-02-30" }))).toEqual({
      ok: false,
      fields: { name: "tooLong", text: "required", writtenAt: "invalid" },
    });
    expect(await actions.saveManualReviewAction(form(course.id, { courseId: 99_999 }))).toEqual({ ok: false, fields: { courseId: "invalid" } });
    expect(await all()).toEqual([]);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("the form's shape: an id the page never sends, or nothing but a string, is `form: invalid`; nothing is stored", async () => {
    const { course } = await protocolCourse(db);
    for (const bad of [{ ...form(course.id), id: 0 }, { ...form(course.id), id: "3" }, { ...form(course.id), id: undefined }, "not a form", null]) {
      expect(await actions.saveManualReviewAction(bad as never), JSON.stringify(bad)).toEqual({ ok: false, fields: { form: "invalid" } });
    }
    expect(await all()).toEqual([]);
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("an edit changes the fields only: a hidden review stays hidden and keeps „Avalehel“; the page of its course is revalidated once", async () => {
    const { course } = await protocolCourse(db);
    const added = await actions.saveManualReviewAction(form(course.id));
    const id = (added as { id: number }).id;
    await actions.setFeaturedAction({ id, featured: true });
    await actions.decideReviewAction({ id, decision: "hide" });
    pub.revalidatePublic.mockClear();
    cache.refresh.mockClear();
    expect(await actions.saveManualReviewAction(form(course.id, { id, text: "Parandatud tekst.", note: "Kiri, 21.09.2026" }))).toEqual({ ok: true, id });
    expect(await reviewOf(id)).toMatchObject({ text: "Parandatud tekst.", note: "Kiri, 21.09.2026", status: "hidden", featured: true });
    expect(revalidated()).toEqual([{ kind: "reviews", course: course.slug }]);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  test("R4: an edit that moves the review to another course revalidates both courses' pages", async () => {
    const first = await protocolCourse(db);
    const second = await protocolCourse(db, { slug: "ripsmete-tostmine", title: { et: "Ripsmete tõstmine", ru: "Лифтинг ресниц" } });
    const added = await actions.saveManualReviewAction(form(first.course.id));
    pub.revalidatePublic.mockClear();
    cache.refresh.mockClear();
    expect(await actions.saveManualReviewAction(form(second.course.id, { id: (added as { id: number }).id }))).toMatchObject({ ok: true });
    expect(revalidated()).toEqual(expect.arrayContaining([{ kind: "reviews", course: second.course.slug }, { kind: "reviews", course: first.course.slug }]));
    expect(revalidated()).toHaveLength(2);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    expect(pub.revalidatePublic.mock.invocationCallOrder[1]).toBeLessThan(cache.refresh.mock.invocationCallOrder[0]);
  });

  test("a student's review is never edited: `notManual` in words, its text and name unchanged, nothing revalidated or refreshed", async () => {
    const { review, course } = await pendingOf();
    const answer = await actions.saveManualReviewAction(form(course.id, { id: review.id, text: "Maria kirjutas ümber." }));
    expect(answer).toEqual({ ok: false, error: "notManual", text: E.notManual });
    expect(await reviewOf(review.id)).toMatchObject({ text: RECOMMEND, name: "Mari M.", kind: "student" });
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("an edit of a review that is gone (deleted in another tab) says so and refreshes the page, so that the row goes", async () => {
    const { course } = await protocolCourse(db);
    const answer = await actions.saveManualReviewAction(form(course.id, { id: 4242 }));
    expect(answer).toEqual({ ok: false, error: "manualGone", text: E.manualGone });
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  test("a throw is `server`, logged by its class and no text; a log line never holds a name or a text", async () => {
    state.db = { transaction: () => Promise.reject(new RangeError("boom: Anu A.")) };
    expect(await actions.saveManualReviewAction(form(1))).toEqual({ ok: false, error: "server", text: E.server });
    expect(logged()).toContain("RangeError");
    expect(logged()).not.toContain("Anu");
    expect(logged()).not.toContain("Väga hea");
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("the log lines of a save carry the review's id only", async () => {
    const { course } = await protocolCourse(db);
    await actions.saveManualReviewAction(form(course.id));
    expect(logged()).toContain("review 1");
    for (const secret of ["Anu", "Väga hea", "Paberil"]) expect(logged()).not.toContain(secret);
  });
});

describe("deleteManualReviewAction: „Kustuta“", () => {
  test("a manual review is deleted; its course's pages are revalidated, then the page refreshes", async () => {
    const { course } = await protocolCourse(db);
    const added = await actions.saveManualReviewAction(form(course.id));
    pub.revalidatePublic.mockClear();
    cache.refresh.mockClear();
    expect(await actions.deleteManualReviewAction({ id: (added as { id: number }).id })).toEqual({ ok: true });
    expect(await all()).toEqual([]);
    expect(revalidated()).toEqual([{ kind: "reviews", course: course.slug }]);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  test("a student's review is not Maria's to delete (the student takes her permission back): refused in words, the review stays", async () => {
    const { review } = await pendingOf();
    expect(await actions.deleteManualReviewAction({ id: review.id })).toEqual({ ok: false, error: "manualGone", text: E.manualGone });
    expect(await all()).toHaveLength(1);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test("one that is already gone (deleted in another tab) says so and refreshes the page; an id the page never sends is the same, without a refresh", async () => {
    expect(await actions.deleteManualReviewAction({ id: 4242 })).toEqual({ ok: false, error: "manualGone", text: E.manualGone });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    cache.refresh.mockClear();
    for (const bad of [{ id: 0 }, { id: "5" }, {}, null]) expect(await actions.deleteManualReviewAction(bad as never), JSON.stringify(bad)).toMatchObject({ ok: false, error: "manualGone" });
    expect(cache.refresh).not.toHaveBeenCalled();
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });
});

describe("the words", () => {
  test("every refusal has Estonian words of its own, and no text is a code", () => {
    for (const code of ["gone", "notPublished", "manualGone", "notManual", "server"] as const) {
      expect(E[code], code).toMatch(/\S/);
      expect(E[code], code).not.toBe(code);
    }
  });
});
