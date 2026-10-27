import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { reviews } from "@/db/schema";
import { createSession as signInSession } from "@/server/auth";
import { makeTestDb } from "./helpers";
import { contactStudent, graduate, submit } from "./reviews-fixtures";

// „Muuda“ on a review Maria added (admin UX pass piece 4c, Task 2; ruling R-c): an autosave drawer on POST /api/admin/arvustus/<id>
// (server/autosave-route.ts' contract around server/reviews.ts readManualReview / writeManualReview), from the version "r:" and the hash of the stored
// {courseId, name, text, writtenAt, locale, note}. Only a review Maria added has one: a student's words are never edited (builder notes §5, C6), and
// one she removed is not there to edit. A write keeps the status, „Avalehel“ and decided_at, sets updated_at (so a decision's „Võta tagasi“ after it is
// `changed`), and the course pages it touches are revalidated once, after the commit. On PGlite; the public pages' revalidation is a spy; the admin's
// cookie is faked for the route.

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
vi.mock("@/server/public-cache", () => pub);

import { POST as saveRoute } from "@/app/api/admin/arvustus/[id]/route";
import { decideReview, readManualReview, removeManualReview, restoreReviewDecision, setFeatured, writeManualReview } from "@/server/reviews";

const NOW = new Date("2026-10-27T09:00:00Z");
const LATER = new Date("2026-10-27T09:05:00Z");
const ORIGIN = "https://mslab.example";

let db: Db;
let course: { id: number; slug: string };
let other: { id: number; slug: string };
/** Maria's review: published, of the contact course, written 15.09.2026 (Estonian midnight), in Estonian, with her note. */
let review: typeof reviews.$inferSelect;

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  state.cookie = undefined;
  pub.revalidatePublic.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  ({ course } = await contactStudent(db));
  ({ course: other } = await graduate(db));
  [review] = await db
    .insert(reviews)
    .values({ courseId: course.id, kind: "manual", text: "Väga hea koolitus.", name: "Anu A.", locale: "et", writtenAt: new Date("2026-09-14T21:00:00Z"), status: "published", decidedAt: NOW, note: "Paberil vormil" })
    .returning();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const rowOf = async (id = review.id) => (await db.select().from(reviews).where(eq(reviews.id, id)))[0];
const versionNow = async (id = review.id) => (await readManualReview(db, id))!.version;
const write = async (patch: Record<string, unknown>, version?: string, now = LATER) => writeManualReview(db, review.id, patch, version ?? (await versionNow()), now);

describe("readManualReview and the version (R-c)", () => {
  test("the drawer's fields as the form holds them: the course as text, the day in Estonian time, the note; „r:“ and a hash", async () => {
    const read = await readManualReview(db, review.id);
    expect(read).toEqual({
      version: expect.stringMatching(/^r:[0-9a-f]{32}$/),
      value: { courseId: String(course.id), name: "Anu A.", text: "Väga hea koolitus.", writtenAt: "2026-09-15", locale: "et", note: "Paberil vormil" },
    });
  });

  test("the version moves with each field and with nothing else: a decision or „Avalehel“ leaves it", async () => {
    const versions = new Set([await versionNow()]);
    await decideReview(db, review.id, "hide", LATER);
    await decideReview(db, review.id, "publish", LATER);
    await setFeatured(db, review.id, true, LATER);
    expect(versions.has(await versionNow())).toBe(true);
    for (const [column, value] of [
      ["courseId", other.id],
      ["name", "Kati K."],
      ["text", "Teine tekst."],
      ["writtenAt", new Date("2026-09-15T21:00:00Z")],
      ["locale", "ru"],
      ["note", "Kiri"],
    ] as const) {
      await db.update(reviews).set({ [column]: value }).where(eq(reviews.id, review.id));
      const v = await versionNow();
      expect(versions.has(v), column).toBe(false);
      versions.add(v);
    }
  });

  test("none to edit: a student's review (her words are never edited), one Maria removed, one that does not exist", async () => {
    const student = await contactStudent(db, "Liis Lepp", { slug: "teine-kursus" });
    await submit(db, student.client.id, { registrationId: student.registration.id }, { name: "Mari M." });
    const [students] = await db.select().from(reviews).where(eq(reviews.kind, "student"));
    expect(await readManualReview(db, students.id)).toBeNull();
    await removeManualReview(db, review.id, LATER);
    expect(await readManualReview(db, review.id)).toBeNull();
    expect(await readManualReview(db, 99_999)).toBeNull();
  });
});

describe("writeManualReview: „Muuda“'s autosave", () => {
  test("a text change is stored (trimmed); the status, „Avalehel“ and decided_at stay, updated_at moves; the new version and the course's page", async () => {
    await setFeatured(db, review.id, true, NOW);
    const before = await rowOf();
    const done = await write({ text: "  Parandatud tekst.  " });
    const after = await rowOf();
    expect(done).toEqual({ answer: { ok: true, version: await versionNow(), savedAt: LATER.toISOString() }, courseSlugs: [course.slug] });
    expect(after).toEqual({ ...before, text: "Parandatud tekst.", updatedAt: LATER });
  });

  test("every field: the day is stored as its Estonian midnight; a move to another course names both pages (the new one first)", async () => {
    const done = await write({ courseId: String(other.id), name: " Kati   K. ", writtenAt: "2026-10-01", locale: "ru", note: " Kiri " });
    expect(done.answer).toMatchObject({ ok: true });
    expect(done.courseSlugs).toEqual([other.slug, course.slug]);
    expect(await rowOf()).toMatchObject({ courseId: other.id, name: "Kati K.", writtenAt: new Date("2026-09-30T21:00:00Z"), locale: "ru", note: "Kiri", status: "published", decidedAt: NOW });
  });

  test("a field not sent stays as it is stored: a day written at another time of day keeps it when only the text changes", async () => {
    const odd = new Date("2026-09-15T08:30:00Z");
    await db.update(reviews).set({ writtenAt: odd }).where(eq(reviews.id, review.id));
    expect((await write({ text: "Uus." })).answer).toMatchObject({ ok: true });
    expect((await rowOf()).writtenAt).toEqual(odd);
    // the same day sent back (the form's own, unchanged) keeps it too
    expect((await write({ writtenAt: "2026-09-15", text: "Uuem." })).answer).toMatchObject({ ok: true });
    expect((await rowOf()).writtenAt).toEqual(odd);
  });

  test("a save that changes nothing answers the version it came from and writes nothing: a decision's „Võta tagasi“ is not made `changed` by it", async () => {
    const decided = await decideReview(db, review.id, "hide", NOW);
    if (!decided.ok) throw new Error("not decided");
    const before = await rowOf();
    const version = await versionNow();
    expect(await write({ text: "Väga hea koolitus.", note: " Paberil vormil " }, version)).toEqual({ answer: { ok: true, version, savedAt: LATER.toISOString() }, courseSlugs: [] });
    expect(await rowOf()).toEqual(before);
    expect(await restoreReviewDecision(db, review.id, decided.expected, LATER)).toMatchObject({ ok: true });
  });

  test("an edit after a decision makes that decision's „Võta tagasi“ `changed`: the review moved", async () => {
    const decided = await decideReview(db, review.id, "hide", NOW);
    if (!decided.ok) throw new Error("not decided");
    expect((await write({ text: "Muudetud." })).answer).toMatchObject({ ok: true });
    expect(await restoreReviewDecision(db, review.id, decided.expected, new Date("2026-10-27T09:06:00Z"))).toEqual({ ok: false, error: "changed" });
  });

  test("a stale version is a conflict with the stored version and fields; nothing is written", async () => {
    const old = await versionNow();
    await write({ text: "Teises aknas." });
    const before = await rowOf();
    expect(await write({ text: "Siin." }, old)).toEqual({
      answer: { ok: false, error: "conflict", version: await versionNow(), value: { courseId: String(course.id), name: "Anu A.", text: "Teises aknas.", writtenAt: "2026-09-15", locale: "et", note: "Paberil vormil" } },
      courseSlugs: [],
    });
    expect(await rowOf()).toEqual(before);
  });

  test("removed meanwhile, or a student's: a conflict with version \"\" and no value; nothing is written", async () => {
    const version = await versionNow();
    await removeManualReview(db, review.id, LATER);
    expect(await write({ text: "Uus." }, version)).toEqual({ answer: { ok: false, error: "conflict", version: "", value: null }, courseSlugs: [] });
    const student = await contactStudent(db, "Liis Lepp", { slug: "teine-kursus" });
    await submit(db, student.client.id, { registrationId: student.registration.id }, { name: "Mari M." });
    const [students] = await db.select().from(reviews).where(eq(reviews.kind, "student"));
    expect(await writeManualReview(db, students.id, { text: "Muudetud." }, version, LATER)).toEqual({ answer: { ok: false, error: "conflict", version: "", value: null }, courseSlugs: [] });
    expect((await rowOf(students.id)).text).toBe(students.text);
  });

  test("each field's own rule, by field code (checkManualReview); a course that does not exist; a key that is no field; nothing is written", async () => {
    const before = await rowOf();
    expect((await write({ name: "", text: "x".repeat(2001), writtenAt: "2026-02-31", locale: "en", note: "  " })).answer).toEqual({
      ok: false,
      error: "invalid",
      fields: { name: "required", text: "tooLong", writtenAt: "invalid", locale: "invalid", note: "required" },
    });
    expect((await write({ courseId: "" })).answer).toEqual({ ok: false, error: "invalid", fields: { courseId: "required" } });
    expect((await write({ courseId: "99999" })).answer).toEqual({ ok: false, error: "invalid", fields: { courseId: "invalid" } });
    expect((await write({ status: "hidden" })).answer).toEqual({ ok: false, error: "invalid", fields: { status: "invalid" } });
    expect((await write({ text: 7 })).answer).toEqual({ ok: false, error: "invalid", fields: { text: "invalid" } });
    expect(await rowOf()).toEqual(before);
  });

  test("a stored field the rules no longer take (an old review without a note) holds back what is sent with it, by name", async () => {
    await db.update(reviews).set({ note: null }).where(eq(reviews.id, review.id));
    expect((await write({ text: "Uus." })).answer).toEqual({ ok: false, error: "invalid", fields: { note: "required", text: "required" } });
    expect((await write({ text: "Uus.", note: "Kiri" })).answer).toMatchObject({ ok: true });
  });
});

describe("POST /api/admin/arvustus/<id>", () => {
  const post = (id: string | number, body: unknown, headers: Record<string, string> = {}) =>
    saveRoute(new Request(`${ORIGIN}/api/admin/arvustus/${id}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), {
      params: Promise.resolve({ id: String(id) }),
    });
  const answerOf = async (res: Response) => ({ status: res.status, cache: res.headers.get("cache-control"), body: await res.json() });
  const signIn = async () => {
    state.cookie = await signInSession(db, "admin@example.test");
  };

  test("without an admin's session: 401; from another site: 403; nothing stored", async () => {
    const version = await versionNow();
    expect((await post(review.id, { version, patch: { text: "Uus." } })).status).toBe(401);
    await signIn();
    expect((await post(review.id, { version, patch: { text: "Uus." } }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await rowOf()).text).toBe("Väga hea koolitus.");
  });

  test("the contract: 200 with the new version and the course's pages revalidated once, 409 with the stored fields, 400 per field, 404 for none to edit", async () => {
    await signIn();
    const version = await versionNow();
    expect(await answerOf(await post(review.id, { version, patch: { text: "Uus tekst." } }))).toEqual({
      status: 200,
      cache: "no-store",
      body: { ok: true, version: await versionNow(), savedAt: expect.any(String) },
    });
    expect(pub.revalidatePublic.mock.calls).toEqual([[{ kind: "reviews", course: course.slug }]]);
    const stored = (await readManualReview(db, review.id))!;
    expect(await answerOf(await post(review.id, { version, patch: { text: "Teine." } }))).toEqual({
      status: 409,
      cache: "no-store",
      body: { ok: false, error: "conflict", version: stored.version, value: stored.value },
    });
    expect(await answerOf(await post(review.id, { version: stored.version, patch: { name: "", locale: "en" } }))).toMatchObject({ status: 400, body: { ok: false, error: "invalid", fields: { name: "required", locale: "invalid" } } });
    expect(await answerOf(await post(review.id, { version: stored.version, patch: { featured: true } }))).toMatchObject({ status: 400, body: { error: "invalid", fields: { featured: "invalid" } } });
    // moved to another course: both pages
    pub.revalidatePublic.mockClear();
    expect((await post(review.id, { version: stored.version, patch: { courseId: String(other.id) } })).status).toBe(200);
    expect(pub.revalidatePublic.mock.calls).toEqual([[{ kind: "reviews", course: other.slug }], [{ kind: "reviews", course: course.slug }]]);
    // a student's review, a removed one, an id that is none: 404
    const student = await contactStudent(db, "Liis Lepp", { slug: "teine-kursus" });
    await submit(db, student.client.id, { registrationId: student.registration.id }, { name: "Mari M." });
    const [students] = await db.select().from(reviews).where(eq(reviews.kind, "student"));
    for (const id of [students.id, 999_999, "x", "0"]) expect((await post(id, { version, patch: { text: "Muudetud." } })).status, String(id)).toBe(404);
    await removeManualReview(db, review.id, LATER);
    expect((await post(review.id, { version: stored.version, patch: { text: "Pärast." } })).status).toBe(404);
    expect((await rowOf(students.id)).text).toBe(students.text);
  });
});
