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
// toggle and „Lisa arvustus“ (new and edited), each through adminAction (a stand-in here: the guard is tests/unit/admin-guards.test.ts's).
// What each answers, what it stores, that a success revalidates the pages of the review's course (both of them when an edit moves it) and then
// refreshes the open page, that a refusal revalidates nothing, and that a review the student has just withdrawn is answered in words, with the page
// refreshed so the row is gone: no 500 and no stale row. Piece 4c (admin UX pass, Task 1): a decision answers what its „Võta tagasi“ needs and the
// undo is refused when the review moved since (R-a, Review Focus 1); „Kustuta“ is a soft delete with its own undo, and the purge of what is due runs
// after the answer (R-b).

const state = vi.hoisted(() => ({ db: null as unknown, after: [] as (() => Promise<void>)[], dbThrows: false }));
const cache = vi.hoisted(() => ({ refresh: vi.fn() }));
const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
vi.mock("@/db/client", () => ({
  getDb: () => {
    if (state.dbThrows) throw new Error("DATABASE_URL is not set"); // (the database's setup failing: getDb itself throws)
    return state.db;
  },
}));
vi.mock("next/cache", () => cache);
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: (fn: () => Promise<void>) => void state.after.push(fn) }));
vi.mock("@/server/public-cache", () => pub);
vi.mock("@/server/auth", () => ({ adminAction: (fn: (admin: unknown, ...args: unknown[]) => unknown) => (...args: unknown[]) => fn({ email: "admin@example.test" }, ...args) }));

const actions = await import("@/server/actions/admin-reviews");
const E = adminEt.reviews.errors;

let db: Db;
let logged: () => string;
beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  state.after = [];
  state.dbThrows = false;
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
  }) as { id: null } & ManualReviewInput;

describe("decideReviewAction: „Avalda“ and „Peida“", () => {
  test("„Avalda“ on a pending review: it is published, decided now; the course's pages are revalidated, then the open page is refreshed", async () => {
    const { review, course } = await pendingOf();
    const answer = await actions.decideReviewAction({ id: review.id, decision: "publish" });
    const row = await reviewOf(review.id);
    expect(row).toMatchObject({ status: "published", featured: false, text: RECOMMEND, name: "Mari M." });
    expect(row.decidedAt).toBeInstanceOf(Date);
    // (piece 4c, R-a: what its „Võta tagasi“ sends back: the row as the press left it, and what the press replaced)
    expect(answer).toEqual({ ok: true, expected: { status: "published", updatedAt: row.updatedAt.toISOString(), previous: { status: "pending", decidedAt: null } } });
    expect(revalidated()).toEqual([{ kind: "reviews", course: course.slug }]);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    // the pages are marked stale before the open page is rendered again
    expect(pub.revalidatePublic.mock.invocationCallOrder[0]).toBeLessThan(cache.refresh.mock.invocationCallOrder[0]);
  });

  test("„Peida“ on a pending or a published review hides it and keeps „Avalehel“; „Avalda“ on a hidden one publishes it again; the same press twice is harmless", async () => {
    const { review, course } = await pendingOf();
    await actions.decideReviewAction({ id: review.id, decision: "publish" });
    expect(await actions.setFeaturedAction({ id: review.id, featured: true })).toEqual({ ok: true });
    expect(await actions.decideReviewAction({ id: review.id, decision: "hide" })).toMatchObject({ ok: true });
    expect(await reviewOf(review.id)).toMatchObject({ status: "hidden", featured: true });
    expect(await actions.decideReviewAction({ id: review.id, decision: "hide" })).toMatchObject({ ok: true });
    expect(await actions.decideReviewAction({ id: review.id, decision: "publish" })).toMatchObject({ ok: true });
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

  test("a review Maria added and removed in another tab is `manualGone` in her words, not the student's (Task 2's carry, as the undo answers it); the page refreshed, nothing written", async () => {
    const { course } = await protocolCourse(db);
    const added = await actions.saveManualReviewAction(form(course.id));
    if (!added.ok || !("id" in added)) throw new Error("not added");
    await actions.removeReviewAction({ id: added.id }); // (the other tab)
    const before = await reviewOf(added.id);
    pub.revalidatePublic.mockClear();
    cache.refresh.mockClear();
    for (const decision of ["publish", "hide"] as const) {
      expect(await actions.decideReviewAction({ id: added.id, decision })).toEqual({ ok: false, error: "manualGone", text: "Seda arvustust enam pole." });
    }
    expect(await reviewOf(added.id)).toEqual(before);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).toHaveBeenCalledTimes(2);
    // an id that is none at all is still the student's words (nothing tells a purged review of Maria's from a withdrawn one)
    expect(await actions.decideReviewAction({ id: 4242, decision: "hide" })).toMatchObject({ ok: false, error: "gone", text: E.gone });
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

  test("piece 4c, ruling c4: „Avalehel“ on a review Maria added and removed in another tab is `manualGone` in her words; nothing written or revalidated, the page refreshed", async () => {
    const { course } = await protocolCourse(db);
    const added = await actions.saveManualReviewAction(form(course.id));
    if (!added.ok || !("id" in added)) throw new Error("not added");
    await actions.removeReviewAction({ id: added.id }); // (the other tab)
    const before = await reviewOf(added.id);
    pub.revalidatePublic.mockClear();
    cache.refresh.mockClear();
    for (const featured of [true, false]) {
      expect(await actions.setFeaturedAction({ id: added.id, featured })).toEqual({ ok: false, error: "manualGone", text: "Seda arvustust enam pole." });
    }
    expect(await reviewOf(added.id)).toEqual(before);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).toHaveBeenCalledTimes(2);
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

describe("saveManualReviewAction: „Lisa arvustus“ (a create only: „Muuda“ autosaves, tests/db/review-edit.test.ts)", () => {
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

  test("piece 4c, ruling c3: a numeric id (the old edit path) is `form: invalid`; nothing is read, written, revalidated or refreshed", async () => {
    const { course } = await protocolCourse(db);
    const added = await actions.saveManualReviewAction(form(course.id));
    if (!added.ok || !("id" in added)) throw new Error("not added");
    const before = await all();
    pub.revalidatePublic.mockClear();
    cache.refresh.mockClear();
    for (const id of [added.id, 4242]) {
      expect(await actions.saveManualReviewAction({ ...form(course.id, { text: "Parandatud tekst." }), id } as never), String(id)).toEqual({ ok: false, fields: { form: "invalid" } });
    }
    expect(await all()).toEqual(before);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
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

describe("piece 4c, R-a: undoDecisionAction, „Võta tagasi“ of „Avalda“ / „Peida“", () => {
  /** A decision through its action, and the `expected` its answer carries. */
  async function decided(id: number, decision: "publish" | "hide") {
    const answer = await actions.decideReviewAction({ id, decision });
    if (!answer.ok) throw new Error(`not decided: ${answer.error}`);
    return answer.expected;
  }

  test("after a hide of a waiting review: pending again with its old decided_at (none); the decision and the undo each revalidate the course's pages once, then refresh", async () => {
    const { review, course } = await pendingOf();
    const expected = await decided(review.id, "hide");
    expect(await actions.undoDecisionAction({ id: review.id, expected })).toEqual({ ok: true });
    expect(await reviewOf(review.id)).toMatchObject({ status: "pending", decidedAt: null, featured: false });
    expect(revalidated()).toEqual([{ kind: "reviews", course: course.slug }, { kind: "reviews", course: course.slug }]);
    expect(cache.refresh).toHaveBeenCalledTimes(2);
    expect(pub.revalidatePublic.mock.invocationCallOrder[1]).toBeLessThan(cache.refresh.mock.invocationCallOrder[1]);
  });

  test("after „Avalda“ on a hidden review: hidden again, with the decided_at it had", async () => {
    const { review } = await pendingOf();
    await decided(review.id, "hide");
    const hiddenAt = (await reviewOf(review.id)).decidedAt;
    const expected = await decided(review.id, "publish");
    expect(await actions.undoDecisionAction({ id: review.id, expected })).toEqual({ ok: true });
    expect(await reviewOf(review.id)).toMatchObject({ status: "hidden", decidedAt: hiddenAt });
  });

  test("Task 2's carry: „Peida“ on a review Maria added (published, with its decided_at) and its „Võta tagasi“: published again with the decided_at it had", async () => {
    const { course } = await protocolCourse(db);
    const added = await actions.saveManualReviewAction(form(course.id));
    if (!added.ok || !("id" in added)) throw new Error("not added");
    const before = await reviewOf(added.id);
    expect(before).toMatchObject({ kind: "manual", status: "published" });
    expect(before.decidedAt).toBeInstanceOf(Date);
    const expected = await decided(added.id, "hide");
    expect(expected.previous).toEqual({ status: "published", decidedAt: before.decidedAt!.toISOString() });
    expect(await reviewOf(added.id)).toMatchObject({ status: "hidden" });
    pub.revalidatePublic.mockClear();
    cache.refresh.mockClear();
    expect(await actions.undoDecisionAction({ id: added.id, expected })).toEqual({ ok: true });
    const after = await reviewOf(added.id);
    expect(after).toMatchObject({ status: "published", decidedAt: before.decidedAt, featured: false, text: before.text, name: before.name });
    expect(revalidated()).toEqual([{ kind: "reviews", course: course.slug }]);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  test("Review Focus 1: hidden in one tab, published again in another; the first tab's „Võta tagasi“ is S4-38's `changed` in words, nothing is overwritten, the page refreshes", async () => {
    const { review } = await pendingOf();
    const firstTab = await decided(review.id, "hide");
    await decided(review.id, "publish"); // (the other tab)
    const before = await reviewOf(review.id);
    pub.revalidatePublic.mockClear();
    cache.refresh.mockClear();
    const answer = await actions.undoDecisionAction({ id: review.id, expected: firstTab });
    expect(answer).toEqual({ ok: false, error: "changed", text: "Arvustust muudeti vahepeal. Vaata see üle." });
    expect(E.changed).toBe("Arvustust muudeti vahepeal. Vaata see üle.");
    expect(await reviewOf(review.id)).toEqual(before);
    expect(before.status).toBe("published");
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  test("a review gone since the press (the student took her permission back) is `gone` in words, with the page refreshed", async () => {
    const { review, client } = await pendingOf();
    const expected = await decided(review.id, "hide");
    await withdrawReview(db, client.id, review.id);
    pub.revalidatePublic.mockClear();
    cache.refresh.mockClear();
    expect(await actions.undoDecisionAction({ id: review.id, expected })).toEqual({ ok: false, error: "gone", text: E.gone });
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  test("review M-1: a review Maria added and removed since the press is `manualGone` in her words, not the student's; the page refreshed, nothing written", async () => {
    const { course } = await protocolCourse(db);
    const added = await actions.saveManualReviewAction(form(course.id));
    if (!added.ok || !("id" in added)) throw new Error("not added");
    const expected = await decided(added.id, "hide");
    await actions.removeReviewAction({ id: added.id }); // (another tab)
    const before = await reviewOf(added.id);
    pub.revalidatePublic.mockClear();
    cache.refresh.mockClear();
    expect(await actions.undoDecisionAction({ id: added.id, expected })).toEqual({ ok: false, error: "manualGone", text: E.manualGone });
    expect(E.manualGone).toBe("Seda arvustust enam pole.");
    expect(await reviewOf(added.id)).toEqual(before);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  test("a forged `previous` (review I-1: a review Maria added put back to `pending`) is S4-38's `changed`, and writes nothing", async () => {
    const { course } = await protocolCourse(db);
    const added = await actions.saveManualReviewAction(form(course.id));
    if (!added.ok || !("id" in added)) throw new Error("not added");
    const expected = await decided(added.id, "hide");
    const before = await reviewOf(added.id);
    expect(await actions.undoDecisionAction({ id: added.id, expected: { ...expected, previous: { status: "pending", decidedAt: null } } })).toEqual({
      ok: false,
      error: "changed",
      text: E.changed,
    });
    expect(await reviewOf(added.id)).toEqual(before);
  });

  test("an undo the page never sends is `gone` without touching anything: a bad id, a status that is none, an instant that is none, a missing part", async () => {
    const { review } = await pendingOf();
    const expected = await decided(review.id, "hide");
    const before = await reviewOf(review.id);
    pub.revalidatePublic.mockClear();
    cache.refresh.mockClear();
    const bads = [
      { id: 0, expected },
      { id: String(review.id), expected },
      { id: review.id },
      { id: review.id, expected: { ...expected, status: "deleted" } },
      { id: review.id, expected: { ...expected, updatedAt: "yesterday" } },
      { id: review.id, expected: { ...expected, previous: { status: "pending" } } },
      { id: review.id, expected: { ...expected, previous: { status: "removed", decidedAt: null } } },
      { id: review.id, expected: { ...expected, previous: { status: "pending", decidedAt: "soon" } } },
      null,
      "undo",
    ];
    for (const bad of bads) expect(await actions.undoDecisionAction(bad as never), JSON.stringify(bad)).toMatchObject({ ok: false, error: "gone", text: E.gone });
    expect(await reviewOf(review.id)).toEqual(before);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("a throw is `server` in words, logged by the review's id and the error's class only", async () => {
    state.db = { transaction: () => Promise.reject(new TypeError("boom: Mari M.")) };
    const expected = { status: "hidden" as const, updatedAt: "2026-10-21T10:00:00.000Z", previous: { status: "pending" as const, decidedAt: null } };
    expect(await actions.undoDecisionAction({ id: 7, expected })).toEqual({ ok: false, error: "server", text: E.server });
    expect(logged()).toContain("review 7");
    expect(logged()).toContain("TypeError");
    expect(logged()).not.toContain("Mari");
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });
});

describe("piece 4c, R-b: removeReviewAction and undoRemoveReviewAction, „Kustuta“ and its „Võta tagasi“", () => {
  /** A review Maria added, through her form; its id. */
  async function added() {
    const { course } = await protocolCourse(db);
    const answer = await actions.saveManualReviewAction(form(course.id));
    if (!answer.ok || !("id" in answer)) throw new Error("not added");
    pub.revalidatePublic.mockClear();
    cache.refresh.mockClear();
    return { id: answer.id, course };
  }
  const runAfter = async () => {
    for (const job of state.after.splice(0)) await job();
  };

  test("„Kustuta“ marks the review (the row stays until the purge); the course's pages are revalidated once, then the page refreshes; the purge waits for the answer", async () => {
    const { id, course } = await added();
    expect(await actions.removeReviewAction({ id })).toEqual({ ok: true });
    expect((await reviewOf(id)).removedAt).toBeInstanceOf(Date);
    expect(revalidated()).toEqual([{ kind: "reviews", course: course.slug }]);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    expect(pub.revalidatePublic.mock.invocationCallOrder[0]).toBeLessThan(cache.refresh.mock.invocationCallOrder[0]);
    expect(state.after).toHaveLength(1);
    // (the purge that runs after the answer takes what was removed 10 s ago or more, never this one)
    await db
      .insert(reviews)
      .values({ courseId: course.id, kind: "manual", text: "Vana.", name: "Vana V.", locale: "et", writtenAt: new Date("2026-09-01T09:00:00Z"), status: "published", note: "kiri", removedAt: new Date(Date.now() - 11_000) });
    expect(await all()).toHaveLength(2);
    await runAfter();
    expect((await all()).map((r) => r.id)).toEqual([id]);
  });

  test("review M-5: a purge after the answer that fails (here the database's setup) is logged by its class, never thrown", async () => {
    const { id } = await added();
    await actions.removeReviewAction({ id });
    state.dbThrows = true;
    await expect(runAfter()).resolves.toBeUndefined();
    expect(logged()).toContain("[reviews] the removed reviews' purge failed: Error");
    expect(logged()).not.toContain("DATABASE_URL");
  });

  test("„Võta tagasi“ within the UndoBar's time brings it back; its course's pages are revalidated once, then the page refreshes", async () => {
    const { id, course } = await added();
    await actions.removeReviewAction({ id });
    pub.revalidatePublic.mockClear();
    cache.refresh.mockClear();
    expect(await actions.undoRemoveReviewAction({ id })).toEqual({ ok: true });
    expect(await reviewOf(id)).toMatchObject({ removedAt: null, status: "published" });
    expect(revalidated()).toEqual([{ kind: "reviews", course: course.slug }]);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  test("„Võta tagasi“ after the purge: `manualGone` in words, the page refreshed, nothing revalidated", async () => {
    const { id } = await added();
    await actions.removeReviewAction({ id });
    await db.update(reviews).set({ removedAt: new Date(Date.now() - 11_000) }).where(eq(reviews.id, id)); // (11 s have passed)
    await actions.removeReviewAction({ id: 4242 }); // (another „Kustuta“: its purge runs after its answer)
    await runAfter();
    expect(await all()).toEqual([]);
    pub.revalidatePublic.mockClear();
    cache.refresh.mockClear();
    expect(await actions.undoRemoveReviewAction({ id })).toEqual({ ok: false, error: "manualGone", text: E.manualGone });
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  test("a student's words are not Maria's to delete: `notManual` in words, nothing written, nothing revalidated", async () => {
    const { review } = await pendingOf();
    expect(await actions.removeReviewAction({ id: review.id })).toEqual({ ok: false, error: "notManual", text: E.notManual });
    expect(await all()).toEqual([review]);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("one that is already gone (removed in another tab) is `manualGone`, the page refreshed; an id the page never sends is the same, untouched and without a refresh", async () => {
    const { id } = await added();
    await actions.removeReviewAction({ id });
    cache.refresh.mockClear();
    pub.revalidatePublic.mockClear();
    expect(await actions.removeReviewAction({ id })).toEqual({ ok: false, error: "manualGone", text: E.manualGone });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    cache.refresh.mockClear();
    for (const bad of [{ id: 0 }, { id: "5" }, {}, null]) {
      expect(await actions.removeReviewAction(bad as never), JSON.stringify(bad)).toMatchObject({ ok: false, error: "manualGone" });
      expect(await actions.undoRemoveReviewAction(bad as never), JSON.stringify(bad)).toMatchObject({ ok: false, error: "manualGone" });
    }
    expect(cache.refresh).not.toHaveBeenCalled();
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test("a throw is `server` in words, logged by the review's id and the error's class only; nothing is revalidated or refreshed", async () => {
    state.db = { transaction: () => Promise.reject(new RangeError("boom: Anu A.")) };
    expect(await actions.removeReviewAction({ id: 9 })).toEqual({ ok: false, error: "server", text: E.server });
    expect(await actions.undoRemoveReviewAction({ id: 9 })).toEqual({ ok: false, error: "server", text: E.server });
    expect(logged()).toContain("review 9");
    expect(logged()).toContain("RangeError");
    expect(logged()).not.toContain("Anu");
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });
});

describe("the words", () => {
  test("every refusal has Estonian words of its own, and no text is a code", () => {
    for (const code of ["gone", "notPublished", "manualGone", "notManual", "changed", "server"] as const) {
      expect(E[code], code).toMatch(/\S/);
      expect(E[code], code).not.toBe(code);
    }
  });
});
