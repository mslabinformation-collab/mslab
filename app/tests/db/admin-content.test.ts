import { beforeEach, describe, expect, test } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { makeTestDb } from "./helpers";
import type { Db } from "@/db/client";
import { clients, contentDrafts, courseAccess, courseImages, courseModules, courses, courseSessions, courseTests, lessons, posts, registrations, requests, type TestQuestion } from "@/db/schema";
import { courseUsage, typeLocked, getCourseForEdit, listAdminSessions, listAllCourses, listAllPosts, listContactCourses, listSessionCities, moveCourseTo, sessionCounts } from "@/db/queries/admin";
import { listUpcomingSessions } from "@/db/queries/public";
import { startOfDayTallinn } from "@/domain/calendar";
import { draftFromCourse, newCourseDraft, type CourseDraft } from "@/domain/course-editor";
import { createCourseForm, deleteSessionForm, moveCourseRequest, saveCourseForm, saveSessionForm, type EditResult, type FieldError } from "@/server/admin-content";

// Task 13: the course editor's and the calendar's form handling and queries on a real (PGlite) database.

const UPLOAD = "img/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg";
const base = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };

let db: Db;
let contact: { id: number };
let online: { id: number };

beforeEach(async () => {
  db = await makeTestDb();
  [contact] = await db
    .insert(courses)
    .values({ ...base, slug: "kulmude-lami", type: "contact", title: { et: "Kulmude LAMI" }, priceGroup: 22000, priceIndividual: 30000, durationLabel: { et: "6 ak" }, published: true, isSample: true, sort: 1 })
    .returning();
  [online] = await db.insert(courses).values({ ...base, slug: "e-kulm", type: "e_learning", title: { et: "E-kulm" }, price: 9500, published: true, sort: 2 }).returning();
  await db.insert(courseImages).values({ courseId: contact.id, key: "/seed/brow-closeup.jpg", alt: { et: "Kulmud" }, sort: 0 });
});

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const save = (draft: CourseDraft) => saveCourseForm(db, form({ data: JSON.stringify(draft) }));
const load = async (id: number) => draftFromCourse((await getCourseForEdit(db, id))!);
const fieldsOf = (r: EditResult) => (r.ok ? {} : (r.fields ?? {}));

describe("createCourseForm: „Lisa koolitus“ (piece 3a, Task 7: the editor's one explicit create; every card autosaves after it)", () => {
  test("creates a new course as saveCourseForm does", async () => {
    const r = await createCourseForm(db, form({ data: JSON.stringify({ ...newCourseDraft(), title: { et: "Uus kulmukoolitus" }, priceGroup: "199,50" }) }));
    expect(r).toMatchObject({ ok: true, created: true });
    expect(await getCourseForEdit(db, (r as { id: number }).id)).toMatchObject({ slug: "uus-kulmukoolitus", priceGroup: 19950, published: false });
  });

  test("never writes an existing course (the old „Salvesta“ path, which could unpublish around R-d, is gone): an id is refused, nothing changes", async () => {
    const before = await getCourseForEdit(db, online.id);
    const draft = { ...(await load(online.id)), title: { et: "Üle kirjutatud" }, published: false };
    expect(await createCourseForm(db, form({ data: JSON.stringify(draft) }))).toEqual({ ok: false, error: "invalid" });
    expect(await getCourseForEdit(db, online.id)).toEqual(before);
    expect(await createCourseForm(db, form({ data: "{" }))).toEqual({ ok: false, error: "invalid" });
    expect(await createCourseForm(db, new FormData())).toEqual({ ok: false, error: "invalid" });
  });
});

describe("saveCourseForm: a new course", () => {
  test("is created after the others with a slug made from its title, its images and badge", async () => {
    const draft: CourseDraft = {
      ...newCourseDraft(),
      title: { et: "Ripsmete tõste Ülikursus", ru: "Ламинирование" },
      summary: { et: "  Lühike  " },
      priceGroup: "290",
      priceIndividual: "",
      durationLabel: { et: "8 ak" },
      includes: [{ et: "Teooria" }, { et: " " }, { et: "Praktika", ru: "Практика" }],
      images: [{ key: UPLOAD, alt: { et: "Ripsmed" } }, { key: "/seed/lash-editorial.jpg", alt: { et: "" } }],
      badge: { label: { et: "Uus", ru: "Новинка" }, bg: "#ddd4dc", fg: "#000000" },
    };
    const r = await save(draft);
    expect(r).toMatchObject({ ok: true, created: true });
    const saved = (await getCourseForEdit(db, (r as { id: number }).id))!;
    expect(saved).toMatchObject({
      slug: "ripsmete-toste-ulikursus",
      type: "contact",
      title: { et: "Ripsmete tõste Ülikursus", ru: "Ламинирование" },
      summary: { et: "Lühike" },
      priceGroup: 29000,
      priceIndividual: null,
      price: null,
      includes: [{ et: "Teooria" }, { et: "Praktika", ru: "Практика" }],
      badge: { label: { et: "Uus", ru: "Новинка" }, bg: "#DDD4DC", fg: "#222222" }, // the swatch's own colours, whatever was sent
      published: false,
      isSample: false,
      sort: 3,
    });
    expect(saved.images.map((i) => [i.key, i.sort, i.alt])).toEqual([
      [UPLOAD, 0, { et: "Ripsmed" }],
      ["/seed/lash-editorial.jpg", 1, null],
    ]);
  });

  test("refuses a missing title, a bad or taken slug, bad amounts and numbers, with the field names", async () => {
    expect(fieldsOf(await save({ ...newCourseDraft(), title: { et: " ", ru: "Только русский" } }))).toMatchObject({ title: "required", slug: "required" });
    expect(fieldsOf(await save({ ...newCourseDraft(), title: { et: "X" }, slug: "Kulmud ja ripsmed!" }))).toEqual({ slug: "slugFormat" });
    expect(fieldsOf(await save({ ...newCourseDraft(), title: { et: "Kulmude LAMI" } }))).toEqual({ slug: "slugTaken" });
    expect(fieldsOf(await save({ ...newCourseDraft(), title: { et: "A" }, priceGroup: "abc", priceIndividual: "-5" }))).toEqual({ priceGroup: "amount", priceIndividual: "amount" });
    expect(fieldsOf(await save({ ...newCourseDraft(), type: "e_learning", title: { et: "B" }, accessMonths: "0", videoCount: "1.5" }))).toEqual({ accessMonths: "whole", videoCount: "whole" });
    expect(fieldsOf(await save({ ...newCourseDraft(), title: { et: "C" }, outcomes: [{ et: "", ru: "Без эстонского" }] }))).toEqual({ outcomes: "listEt" });
    expect(fieldsOf(await save({ ...newCourseDraft(), title: { et: "D".repeat(121) } }))).toEqual({ title: "tooLong" });
    expect(await db.$count(courses)).toBe(2);
  });

  test("a published course needs a price (e-learning: the price; contact: group or individual)", async () => {
    expect(fieldsOf(await save({ ...newCourseDraft(), title: { et: "K" }, published: true }))).toEqual({ priceGroup: "priceRequired" });
    expect(fieldsOf(await save({ ...newCourseDraft(), type: "e_learning", title: { et: "E" }, published: true }))).toEqual({ price: "priceRequired" });
    expect(await save({ ...newCourseDraft(), title: { et: "K2" }, priceIndividual: "300", published: true })).toMatchObject({ ok: true });
    expect(await save({ ...newCourseDraft(), title: { et: "Mustand" } })).toMatchObject({ ok: true }); // a draft may wait for its price
  });

  test("badges: one of D's swatches, at most 18 characters; images: uploads and seed photos only; recommendations: at most 3", async () => {
    const t = { ...newCourseDraft(), title: { et: "Badge" } };
    expect(fieldsOf(await save({ ...t, badge: { label: { et: "Uus" }, bg: "#ff0000", fg: "#ffffff" } }))).toEqual({ badge: "badge" });
    expect(fieldsOf(await save({ ...t, badge: { label: { et: "x".repeat(19) }, bg: "#222222", fg: "#ffffff" } }))).toEqual({ badge: "tooLong" });
    expect(fieldsOf(await save({ ...t, badge: { label: { et: "Uus", ru: "я".repeat(19) }, bg: "#222222", fg: "#ffffff" } }))).toEqual({ badge: "tooLong" });
    for (const key of ["https://evil.example/a.jpg", "//evil.example/a.jpg", "img/abc.jpg", "/seed/../secret.jpg", "javascript:alert(1)"])
      expect(fieldsOf(await save({ ...t, images: [{ key, alt: { et: "" } }] })), key).toEqual({ images: "image" });
    const many = await db.insert(courses).values([1, 2, 3].map((n) => ({ ...base, slug: `c${n}`, type: "contact" as const, title: { et: `C${n}` } }))).returning();
    expect(fieldsOf(await save({ ...t, recommendationIds: [contact.id, ...many.map((c) => c.id)] }))).toEqual({ recommendationIds: "tooMany" });
    // an empty label is no badge at all
    const r = await save({ ...t, badge: { label: { et: "  ", ru: "Новинка" }, bg: "#ff0000", fg: "#fff" }, recommendationIds: [online.id, online.id, 999_999] });
    expect(r).toMatchObject({ ok: true });
    expect((await getCourseForEdit(db, (r as { id: number }).id))!).toMatchObject({ badge: null, recommendationIds: [online.id] });
  });

  test("not a draft at all: invalid, nothing stored", async () => {
    for (const data of ["", "{", JSON.stringify({ ...newCourseDraft(), type: "hybrid" }), JSON.stringify({ title: { et: "x" } })])
      expect(await saveCourseForm(db, form({ data }))).toEqual({ ok: false, error: "invalid" });
    expect(await saveCourseForm(db, new FormData())).toEqual({ ok: false, error: "invalid" });
    expect(await db.$count(courses)).toBe(2);
  });
});

describe("saveCourseForm: editing", () => {
  test("saves the draft, refreshes updatedAt, keeps the order and the Näidis mark unless it is cleared", async () => {
    await db.execute(sql`update courses set updated_at = '2026-01-01T00:00:00Z' where id = ${contact.id}`);
    const before = (await getCourseForEdit(db, contact.id))!;
    const draft = await load(contact.id);
    const r = await save({ ...draft, title: { et: "Kulmude LAMI (uus)" }, badge: { label: { et: "Uus" }, bg: "#DDD4DC", fg: "#222222" } });
    expect(r).toEqual({ ok: true, id: contact.id, created: false });
    const after = (await getCourseForEdit(db, contact.id))!;
    expect(after).toMatchObject({ title: { et: "Kulmude LAMI (uus)" }, badge: { label: { et: "Uus" }, bg: "#DDD4DC" }, sort: 1, isSample: true, slug: "kulmude-lami" });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(after.images.map((i) => i.key)).toEqual(["/seed/brow-closeup.jpg"]);
    expect(await save({ ...(await load(contact.id)), isSample: false })).toMatchObject({ ok: true });
    expect((await getCourseForEdit(db, contact.id))!.isSample).toBe(false);
  });

  test("switching the type stores only the new type's fields (never both)", async () => {
    const draft = await load(contact.id);
    expect(await save({ ...draft, type: "e_learning", price: "150", accessMonths: "6", videoCount: "12", nextDiscount: { et: "−10%" } })).toMatchObject({ ok: true });
    expect((await getCourseForEdit(db, contact.id))!).toMatchObject({
      type: "e_learning",
      price: 15000,
      accessMonths: 6,
      videoCount: 12,
      nextDiscount: { et: "−10%" },
      priceGroup: null,
      priceIndividual: null,
      durationLabel: null,
      includes: [],
    });
  });

  test("a course with sessions or registrations keeps its type (K1/K2); without them it may change", async () => {
    // two sessions, so session ids and course ids do not line up by chance
    const [session, other] = await db
      .insert(courseSessions)
      .values([
        { courseId: contact.id, startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu" },
        { courseId: contact.id, startsAt: new Date("2026-12-14T08:00:00Z"), city: "Tartu" },
      ])
      .returning();
    expect(await courseUsage(db, contact.id)).toEqual({ type: "contact", sessions: 2, registrations: 0, lessons: 0, access: 0 });
    expect(await courseUsage(db, online.id)).toEqual({ type: "e_learning", sessions: 0, registrations: 0, lessons: 0, access: 0 });
    const draft = await load(contact.id);
    expect(await save({ ...draft, type: "e_learning", price: "150" })).toEqual({ ok: false, error: "invalid", fields: { type: "typeLocked" } });
    expect((await getCourseForEdit(db, contact.id))!).toMatchObject({ type: "contact", priceGroup: 22000 }); // nothing changed
    expect(await save({ ...draft, title: { et: "Kulmude LAMI 2" } })).toMatchObject({ ok: true }); // the same type saves as usual

    // registrations lock it too, also once the sessions are gone (and an e-learning course with buyers stays e-learning)
    await db.insert(registrations).values({ courseId: online.id, kind: "group", name: "Liis", email: "liis@example.com", paymentChoice: "full" });
    expect(fieldsOf(await save({ ...(await load(online.id)), type: "contact", priceGroup: "100" }))).toEqual({ type: "typeLocked" });
    await db.delete(courseSessions).where(inArray(courseSessions.id, [session.id, other.id]));
    expect(await save({ ...(await load(contact.id)), type: "e_learning", price: "150" })).toMatchObject({ ok: true }); // nothing points to it now
    expect(await courseUsage(db, 999_999)).toBeNull();
  });

  test("an e-course with lessons, or with anyone's access (an ended one too), keeps its type; its modules alone do not lock it", async () => {
    const toContact = async () => fieldsOf(await save({ ...(await load(online.id)), type: "contact", priceGroup: "100" }));
    const [mod] = await db.insert(courseModules).values({ courseId: online.id, position: 1, title: { et: "Sissejuhatus" } }).returning();
    expect(typeLocked(await courseUsage(db, online.id))).toBe(false);
    const [lesson] = await db.insert(lessons).values({ moduleId: mod.id, position: 1, title: { et: "Tere" } }).returning();
    expect(await courseUsage(db, online.id)).toEqual({ type: "e_learning", sessions: 0, registrations: 0, lessons: 1, access: 0 });
    expect(typeLocked(await courseUsage(db, online.id))).toBe(true);
    expect(await toContact()).toEqual({ type: "typeLocked" });
    expect((await getCourseForEdit(db, online.id))!.type).toBe("e_learning");

    // no lessons, but a student's access (ended long ago): still locked
    await db.delete(lessons).where(eq(lessons.id, lesson.id));
    const [kati] = await db.insert(clients).values({ email: "kati@example.test" }).returning();
    await db.insert(courseAccess).values({ clientId: kati.id, courseId: online.id, grantedBy: "admin@example.test", expiresAt: new Date("2025-01-01T00:00:00Z"), revokedAt: new Date("2024-06-01T00:00:00Z") });
    expect(await courseUsage(db, online.id)).toEqual({ type: "e_learning", sessions: 0, registrations: 0, lessons: 0, access: 1 });
    expect(await toContact()).toEqual({ type: "typeLocked" });

    // neither: it may change (and the same type always saves)
    await db.delete(courseAccess).where(eq(courseAccess.courseId, online.id));
    expect(await save({ ...(await load(online.id)), title: { et: "E-kulm 2" } })).toMatchObject({ ok: true });
    expect(await toContact()).toEqual({});
    expect((await getCourseForEdit(db, online.id))!.type).toBe("contact");
  });

  test("stale: a save based on an older version changes nothing", async () => {
    const mine = await load(contact.id);
    const theirs = await load(contact.id);
    expect(await save({ ...theirs, title: { et: "Teise akna nimi" } })).toMatchObject({ ok: true });
    expect(await save({ ...mine, title: { et: "Minu nimi" } })).toEqual({ ok: false, error: "stale" });
    expect((await getCourseForEdit(db, contact.id))!.title).toEqual({ et: "Teise akna nimi" });
    expect(await save({ ...mine, version: null })).toEqual({ ok: false, error: "invalid" }); // an edit needs its version
    expect(await save({ ...mine, id: 999_999, slug: "olematu" })).toEqual({ ok: false, error: "notFound" });
  });

  test("a row written with microseconds (the seed's defaultNow) can be edited: versions compare to the millisecond", async () => {
    await db.execute(sql`update courses set updated_at = '2026-10-01 12:00:00.123456+00' where id = ${contact.id}`);
    const draft = await load(contact.id);
    expect(draft.version).toBe("2026-10-01T12:00:00.123Z");
    expect(await save({ ...draft, title: { et: "Muudetud" } })).toMatchObject({ ok: true });
  });

  test("a gallery is replaced in the editor's order", async () => {
    const draft = await load(contact.id);
    expect(await save({ ...draft, images: [{ key: UPLOAD, alt: { et: "Uus", ru: "Новый" } }, draft.images[0]] })).toMatchObject({ ok: true });
    expect((await getCourseForEdit(db, contact.id))!.images.map((i) => [i.key, i.sort, i.alt])).toEqual([
      [UPLOAD, 0, { et: "Uus", ru: "Новый" }],
      ["/seed/brow-closeup.jpg", 1, { et: "Kulmud" }],
    ]);
    expect(await save({ ...(await load(contact.id)), images: [] })).toMatchObject({ ok: true });
    expect((await getCourseForEdit(db, contact.id))!.images).toEqual([]);
  });
});

describe("course list", () => {
  /** Three more courses after the two of beforeEach: the order is then c1 (contact), c2 (online), c3, c4, c5. */
  async function more() {
    const rows = await db
      .insert(courses)
      .values([
        { ...base, slug: "c3", type: "contact", title: { et: "C3" }, sort: 3 },
        { ...base, slug: "c4", type: "e_learning", title: { et: "C4" }, sort: 4 },
        { ...base, slug: "c5", type: "contact", title: { et: "C5" }, sort: 5, published: false },
      ])
      .returning();
    return rows;
  }
  const order = async () => (await listAllCourses(db)).map((c) => [c.slug, c.sort]);

  test("listAllCourses has the drafts too, in the public order", async () => {
    await db.insert(courses).values({ ...base, slug: "mustand", type: "contact", title: { et: "Mustand" }, sort: 3 });
    expect((await listAllCourses(db)).map((c) => c.slug)).toEqual(["kulmude-lami", "e-kulm", "mustand"]);
    expect((await listContactCourses(db)).map((c) => c.title.et)).toEqual(["Kulmude LAMI", "Mustand"]);
  });

  test("moveCourseTo puts a course at the place and the others keep their order; the sorts are 1…n after it", async () => {
    const [c3] = await more();
    expect(await moveCourseTo(db, c3.id, 0)).toBe("ok");
    expect(await order()).toEqual([["c3", 1], ["kulmude-lami", 2], ["e-kulm", 3], ["c4", 4], ["c5", 5]]);
    // down: the course after it comes up; the rest are as they were
    expect(await moveCourseTo(db, c3.id, 3)).toBe("ok");
    expect(await order()).toEqual([["kulmude-lami", 1], ["e-kulm", 2], ["c4", 3], ["c3", 4], ["c5", 5]]);
    // one step, as the ↑ / ↓ buttons ask for it
    expect(await moveCourseTo(db, c3.id, 2)).toBe("ok");
    expect((await order()).map(([slug]) => slug)).toEqual(["kulmude-lami", "e-kulm", "c3", "c4", "c5"]);
  });

  test("an index past the end puts the course last; a negative one, first", async () => {
    const [c3] = await more();
    expect(await moveCourseTo(db, contact.id, 99)).toBe("ok");
    expect((await order()).map(([slug]) => slug)).toEqual(["e-kulm", "c3", "c4", "c5", "kulmude-lami"]);
    expect(await moveCourseTo(db, c3.id, -4)).toBe("ok");
    expect((await order()).map(([slug]) => slug)).toEqual(["c3", "e-kulm", "c4", "c5", "kulmude-lami"]);
  });

  test("a course dropped where it is changes nothing but still renumbers a list with gaps in its sorts", async () => {
    const [c3] = await more();
    await db.update(courses).set({ sort: 40 }).where(eq(courses.id, c3.id));
    await db.update(courses).set({ sort: 7 }).where(eq(courses.slug, "c4"));
    expect((await order()).map(([slug]) => slug)).toEqual(["kulmude-lami", "e-kulm", "c5", "c4", "c3"]);
    expect(await moveCourseTo(db, c3.id, 4)).toBe("ok");
    expect(await order()).toEqual([["kulmude-lami", 1], ["e-kulm", 2], ["c5", 3], ["c4", 4], ["c3", 5]]);
  });

  test("a course that is not there is notFound and nothing changes", async () => {
    await more();
    expect(await moveCourseTo(db, 999_999, 0)).toBe("notFound");
    expect((await order()).map(([slug]) => slug)).toEqual(["kulmude-lami", "e-kulm", "c3", "c4", "c5"]);
  });

  // (PGlite runs one transaction at a time, so this shows only that two calls started together end in one whole order. That the second is made on the order the first
  // left, which the locks and their order decide, is shown on real Postgres: tests/e2e/course-order-race.spec.ts.)
  test("two moves started together end in one order with every course once", async () => {
    const [c3, c4] = await more();
    const answers = await Promise.all([moveCourseTo(db, c3.id, 0), moveCourseTo(db, c4.id, 0)]);
    expect(answers).toEqual(["ok", "ok"]);
    const slugs = (await order()).map(([slug]) => slug);
    expect(slugs).toHaveLength(5);
    expect(new Set(slugs).size).toBe(5);
    expect((await order()).map(([, sort]) => sort)).toEqual([1, 2, 3, 4, 5]);
  });

  test("moveCourseRequest: {id, index} moves; anything else is invalid, an unknown course notFound", async () => {
    const [c3] = await more();
    expect(await moveCourseRequest(db, { id: c3.id, index: 0 })).toEqual({ ok: true, id: c3.id });
    expect((await order())[0][0]).toBe("c3");
    expect(await moveCourseRequest(db, { id: 999_999, index: 0 })).toEqual({ ok: false, error: "notFound" });
    for (const bad of [null, "x", {}, { id: c3.id }, { id: c3.id, index: "1" }, { id: c3.id, index: 1.5 }, { id: c3.id, index: -1 }, { id: 0, index: 1 }, { id: c3.id, index: 2_147_483_648 }]) {
      expect(await moveCourseRequest(db, bad), JSON.stringify(bad)).toEqual({ ok: false, error: "invalid" });
    }
    expect((await order())[0][0]).toBe("c3");
  });

  test("a row has changes when the draft layer holds a draft of that course, and only then", async () => {
    const draft = { entityId: online.id, part: "price", value: { price: "99" }, baseVersion: "l:x", updatedBy: "maria@example.test" };
    expect((await listAllCourses(db)).map((c) => [c.slug, c.changes])).toEqual([["kulmude-lami", false], ["e-kulm", false]]);
    // another kind of thing with the same id is not this course's draft
    await db.insert(contentDrafts).values({ ...draft, entity: "post" });
    expect((await listAllCourses(db)).map((c) => c.changes)).toEqual([false, false]);
    await db.insert(contentDrafts).values({ ...draft, entity: "course" });
    await db.insert(contentDrafts).values({ ...draft, entity: "course", part: "badge" });
    expect((await listAllCourses(db)).map((c) => [c.slug, c.changes])).toEqual([["kulmude-lami", false], ["e-kulm", true]]);
  });

  test("listAllPosts has the drafts too, newest first", async () => {
    const p = { excerpt: { et: "" }, body: { et: "" }, category: { et: "" }, coverKey: "/seed/x.jpg" };
    await db.insert(posts).values([
      { ...p, slug: "vana", title: { et: "Vana" }, published: true, publishedAt: new Date("2026-01-01T10:00:00Z") },
      { ...p, slug: "mustand", title: { et: "Mustand" }, published: false, publishedAt: new Date("2026-09-01T10:00:00Z") },
    ]);
    expect((await listAllPosts(db)).map((x) => x.slug)).toEqual(["mustand", "vana"]);
  });
});

describe("calendar sessions", () => {
  const session = (over: Record<string, string> = {}) =>
    form({ id: "", courseId: String(contact.id), date: "2026-11-14", time: "10:00", city: "Pärnu", venue: "MS LAB stuudio", language: "ET / RU", capacity: "6", status: "scheduled", ...over });

  test("a new session: Estonian time is stored as the right instant (winter and summer)", async () => {
    const r = await saveSessionForm(db, session());
    expect(r).toMatchObject({ ok: true, created: true });
    const [row] = await db.select().from(courseSessions).where(eq(courseSessions.id, (r as { id: number }).id));
    expect(row).toMatchObject({ courseId: contact.id, city: "Pärnu", venue: "MS LAB stuudio", language: "ET / RU", capacity: 6, status: "scheduled" });
    expect(row.startsAt.toISOString()).toBe("2026-11-14T08:00:00.000Z");
    const summer = await saveSessionForm(db, session({ date: "2027-06-05" }));
    const [s2] = await db.select().from(courseSessions).where(eq(courseSessions.id, (summer as { id: number }).id));
    expect(s2.startsAt.toISOString()).toBe("2027-06-05T07:00:00.000Z");
  });

  test("an edit changes the row; validation names the fields", async () => {
    const { id } = (await saveSessionForm(db, session())) as { id: number };
    expect(await saveSessionForm(db, session({ id: String(id), city: " Tartu ", capacity: "4", status: "cancelled", time: "09:30" }))).toEqual({ ok: true, id, created: false });
    const [row] = await db.select().from(courseSessions).where(eq(courseSessions.id, id));
    expect(row).toMatchObject({ city: "Tartu", capacity: 4, status: "cancelled" });
    expect(row.startsAt.toISOString()).toBe("2026-11-14T07:30:00.000Z");

    expect(fieldsOf(await saveSessionForm(db, session({ courseId: String(online.id) })))).toEqual({ courseId: "course" }); // e-learning has no dates
    expect(fieldsOf(await saveSessionForm(db, session({ courseId: "" })))).toEqual({ courseId: "course" });
    expect(fieldsOf(await saveSessionForm(db, session({ date: "", time: "" })))).toEqual({ date: "required", time: "required" });
    expect(fieldsOf(await saveSessionForm(db, session({ date: "2026-02-30", time: "25:00" })))).toEqual({ date: "date", time: "time" });
    expect(fieldsOf(await saveSessionForm(db, session({ city: "", capacity: "0" })))).toEqual({ city: "required", capacity: "capacity" });
    expect(fieldsOf(await saveSessionForm(db, session({ capacity: "100" })))).toEqual({ capacity: "capacity" });
    expect(await saveSessionForm(db, session({ status: "maybe" }))).toEqual({ ok: false, error: "invalid" });
    expect(await saveSessionForm(db, session({ id: "999999" }))).toEqual({ ok: false, error: "notFound" });
    expect(await saveSessionForm(db, session({ id: "abc" }))).toEqual({ ok: false, error: "invalid" });
  });

  test("the old drawer's „Salvesta toimumine“ (until the drawer autosaves, piece 3b Task 3) keeps the session rules under its lock (R-b, R-c)", async () => {
    const { id } = (await saveSessionForm(db, session())) as { id: number };
    const [lift] = await db.insert(courses).values({ ...base, slug: "ripsmete-lift", type: "contact", title: { et: "Ripsmete lift" }, priceGroup: 19000, sort: 3 }).returning();
    const reg = (n: number, status: "confirmed" | "awaiting_prepayment") =>
      ({ courseId: contact.id, courseSessionId: id, kind: "group" as const, name: `Õpilane ${n}`, email: `opilane${n}@example.test`, paymentChoice: "half" as const, status });
    await db.insert(registrations).values([reg(1, "confirmed"), reg(2, "confirmed"), reg(3, "awaiting_prepayment")]);
    expect(fieldsOf(await saveSessionForm(db, session({ id: String(id), capacity: "1" })))).toEqual({ capacity: "capacityBelow" });
    expect(fieldsOf(await saveSessionForm(db, session({ id: String(id), courseId: String(lift.id) })))).toEqual({ courseId: "courseLocked" });
    const [kept] = await db.select().from(courseSessions).where(eq(courseSessions.id, id));
    expect(kept).toMatchObject({ courseId: contact.id, capacity: 6 });
    expect(await saveSessionForm(db, session({ id: String(id), capacity: "2", status: "cancelled" }))).toEqual({ ok: true, id, created: false });
    const [row] = await db.select().from(courseSessions).where(eq(courseSessions.id, id));
    expect(row).toMatchObject({ capacity: 2, status: "cancelled" });
    // a session row under an e-course (cannot be made any more) keeps its course and saves nothing: „Vali koolitus.“
    const [legacy] = await db.insert(courseSessions).values({ courseId: online.id, startsAt: new Date("2026-11-15T08:00:00Z"), city: "Vale", capacity: 4 }).returning();
    expect(fieldsOf(await saveSessionForm(db, session({ id: String(legacy.id), courseId: String(online.id), city: "Vale", date: "2026-11-15", capacity: "3" })))).toEqual({ courseId: "course" });
    expect((await db.select().from(courseSessions).where(eq(courseSessions.id, legacy.id)))[0].capacity).toBe(4);
  });

  test("delete: only a session nobody registered for", async () => {
    const { id: free } = (await saveSessionForm(db, session())) as { id: number };
    const { id: booked } = (await saveSessionForm(db, session({ date: "2026-12-05" }))) as { id: number };
    await db.insert(registrations).values({ courseId: contact.id, courseSessionId: booked, kind: "group", name: "Liis", email: "liis@example.com", paymentChoice: "half", status: "cancelled" });
    expect(await deleteSessionForm(db, form({ id: String(booked) }))).toEqual({ ok: false, error: "inUse" });
    expect(await deleteSessionForm(db, form({ id: String(free) }))).toEqual({ ok: true, id: free, deleted: true });
    expect(await deleteSessionForm(db, form({ id: String(free) }))).toEqual({ ok: false, error: "notFound" });
    expect(await deleteSessionForm(db, form({ id: "x" }))).toEqual({ ok: false, error: "invalid" });
    expect((await db.select().from(courseSessions)).map((s) => s.id)).toEqual([booked]);
  });

  test("the public calendar lists contact courses' sessions only, even if a session row of an e-learning course exists", async () => {
    await db.insert(courseSessions).values([
      { courseId: contact.id, startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu" },
      { courseId: online.id, startsAt: new Date("2026-11-15T08:00:00Z"), city: "Vale" }, // cannot be made in the editor any more
    ]);
    const list = await listUpcomingSessions(db, new Date("2026-10-01T00:00:00Z"));
    expect(list.map((s) => [s.city, s.course.type])).toEqual([["Pärnu", "contact"]]);
  });

  test("listAdminSessions: upcoming soonest first, past latest first, drafts' sessions too, with the counts", async () => {
    const [draft] = await db.insert(courses).values({ ...base, slug: "mustand", type: "contact", title: { et: "Mustand" } }).returning();
    const at = (iso: string) => new Date(iso);
    const [a, b, old] = await db
      .insert(courseSessions)
      .values([
        { courseId: contact.id, startsAt: at("2026-12-05T08:00:00Z"), city: "Pärnu", capacity: 4 },
        { courseId: draft.id, startsAt: at("2026-11-20T08:00:00Z"), city: "Tartu" },
        { courseId: contact.id, startsAt: at("2026-09-01T08:00:00Z"), city: "Tallinn" },
      ])
      .returning();
    const reg = (status: "confirmed" | "awaiting_prepayment" | "cancelled") => ({ courseId: contact.id, courseSessionId: a.id, kind: "group" as const, name: "X", email: "x@example.com", paymentChoice: "half" as const, status });
    await db.insert(registrations).values([reg("confirmed"), reg("confirmed"), reg("awaiting_prepayment"), reg("cancelled")]);
    await db.insert(requests).values([
      { kind: "waitlist", payload: { session: a.id, email: "w1@example.com" } },
      { kind: "waitlist", payload: { session: a.id, email: "w2@example.com" }, handled: true },
      { kind: "waitlist", payload: { session: b.id, email: "w3@example.com" } },
    ]);
    const from = at("2026-10-02T00:00:00Z");
    const upcoming = await listAdminSessions(db, { from, upcoming: true });
    expect(upcoming.map((s) => [s.id, s.course.slug, s.confirmed, s.awaiting, s.waitlist])).toEqual([
      [b.id, "mustand", 0, 0, 1],
      [a.id, "kulmude-lami", 2, 1, 1],
    ]);
    expect(upcoming[0].course.published).toBe(false);
    expect((await listAdminSessions(db, { from, upcoming: false })).map((s) => s.id)).toEqual([old.id]);
    // by id, wherever it is in time (the drawer opened from either list), with the same counts
    const byId = await listAdminSessions(db, { ids: [a.id, old.id] });
    expect(byId.map((s) => [s.id, s.confirmed, s.awaiting, s.waitlist])).toEqual([
      [old.id, 0, 0, 0],
      [a.id, 2, 1, 1],
    ]);
    expect(await listAdminSessions(db, { ids: [] })).toEqual([]);
  });

  // B3 Kalender (admin UX pass, piece 3b, Task 1): the list's course and city filters and the counts of its two pills.
  describe("the list's course and city filters, and the pill counts", () => {
    // 12:00 Tallinn time on 25 Oct 2026 (UTC+2 after the clocks went back): "today" starts at 21:00 UTC the day before
    const NOW = new Date("2026-10-25T10:00:00Z");
    const FROM = startOfDayTallinn(NOW);
    const at = (iso: string) => new Date(iso);
    let draft: { id: number };
    const ids: Record<string, number> = {};

    beforeEach(async () => {
      [draft] = await db.insert(courses).values({ ...base, slug: "mustand", type: "contact", title: { et: "Mustand" } }).returning();
      const rows = await db
        .insert(courseSessions)
        .values([
          { courseId: contact.id, startsAt: at("2026-12-05T08:00:00Z"), city: "Pärnu" }, // upcoming
          { courseId: draft.id, startsAt: at("2026-11-20T08:00:00Z"), city: "Tartu" }, // upcoming, a draft course's
          { courseId: contact.id, startsAt: at("2026-12-12T08:00:00Z"), city: "Tallinn", status: "cancelled" }, // upcoming, cancelled
          { courseId: contact.id, startsAt: at("2026-10-25T05:00:00Z"), city: "Tallinn" }, // earlier today: still "Tulevased" (the day, not the minute)
          { courseId: contact.id, startsAt: at("2026-10-24T20:00:00Z"), city: "Tallinn" }, // 23:00 yesterday: past
          { courseId: draft.id, startsAt: at("2026-01-10T08:00:00Z"), city: "Pärnu" }, // past
          { courseId: contact.id, startsAt: at("2025-09-01T08:00:00Z"), city: "Pärnu" }, // past
        ])
        .returning();
      ["parnu", "tartu", "cancelled", "today", "yesterday", "draftPast", "old"].forEach((k, i) => (ids[k] = rows[i].id));
    });

    const idsOf = async (filter: { courseId?: number; city?: string }, upcoming: boolean) =>
      (await listAdminSessions(db, { from: FROM, upcoming, ...filter }, NOW)).map((s) => s.id);

    test("by course: only that course's sessions, in both lists", async () => {
      expect(await idsOf({ courseId: contact.id }, true)).toEqual([ids.today, ids.parnu, ids.cancelled]);
      expect(await idsOf({ courseId: contact.id }, false)).toEqual([ids.yesterday, ids.old]);
      expect(await idsOf({ courseId: draft.id }, true)).toEqual([ids.tartu]); // a draft course's sessions too
      expect(await idsOf({ courseId: draft.id }, false)).toEqual([ids.draftPast]);
    });

    test("by city: exactly that city, every course, cancelled ones too", async () => {
      expect(await idsOf({ city: "Tallinn" }, true)).toEqual([ids.today, ids.cancelled]);
      expect(await idsOf({ city: "Tallinn" }, false)).toEqual([ids.yesterday]);
      expect(await idsOf({ city: "Pärnu" }, false)).toEqual([ids.draftPast, ids.old]);
      expect(await idsOf({ city: "pärnu" }, true)).toEqual([]); // (the city is matched as it is written)
    });

    test("by course and city together, and with nothing found", async () => {
      expect(await idsOf({ courseId: contact.id, city: "Pärnu" }, true)).toEqual([ids.parnu]);
      expect(await idsOf({ courseId: draft.id, city: "Pärnu" }, true)).toEqual([]);
      expect(await idsOf({ courseId: draft.id, city: "Pärnu" }, false)).toEqual([ids.draftPast]);
      expect(await idsOf({ courseId: 999_999 }, true)).toEqual([]);
    });

    test("the drawer's { ids } list ignores the filters of the list (a session opened from another view still opens)", async () => {
      const [row] = await listAdminSessions(db, { ids: [ids.tartu] }, NOW);
      expect(row.city).toBe("Tartu");
    });

    test("sessionCounts: the two pills' counts are the rows each list shows, under the same filters", async () => {
      const filters = [{}, { courseId: contact.id }, { courseId: draft.id }, { city: "Tallinn" }, { city: "Pärnu" }, { courseId: contact.id, city: "Pärnu" }, { courseId: draft.id, city: "Pärnu" }, { city: "Narva" }];
      for (const filter of filters) {
        const counts = await sessionCounts(db, filter, NOW);
        expect(counts, JSON.stringify(filter)).toEqual({ upcoming: (await idsOf(filter, true)).length, past: (await idsOf(filter, false)).length });
      }
      expect(await sessionCounts(db, {}, NOW)).toEqual({ upcoming: 4, past: 3 });
      expect(await sessionCounts(db, { city: "Tallinn" }, NOW)).toEqual({ upcoming: 2, past: 1 });
      expect(await sessionCounts(db, { courseId: draft.id, city: "Pärnu" }, NOW)).toEqual({ upcoming: 0, past: 1 });
    });

    test("sessionCounts counts sessions, not registrations: a cancelled registration, a waitlist request or a second registration changes nothing", async () => {
      const reg = (status: "confirmed" | "awaiting_prepayment" | "cancelled") => ({ courseId: contact.id, courseSessionId: ids.parnu, kind: "group" as const, name: "X", email: "x@example.com", paymentChoice: "half" as const, status });
      await db.insert(registrations).values([reg("confirmed"), reg("confirmed"), reg("cancelled")]);
      await db.insert(requests).values({ kind: "waitlist", payload: { session: ids.parnu, email: "w@example.com" } });
      expect(await sessionCounts(db, {}, NOW)).toEqual({ upcoming: 4, past: 3 });
    });

    test("listSessionCities: every city once, in Estonian order, from sessions of any time and any course", async () => {
      expect(await listSessionCities(db)).toEqual(["Pärnu", "Tallinn", "Tartu"]);
      await db.insert(courseSessions).values({ courseId: online.id, startsAt: at("2026-12-20T08:00:00Z"), city: "Ääre" });
      expect(await listSessionCities(db)).toEqual(["Pärnu", "Tallinn", "Tartu", "Ääre"]); // (Estonian puts Ä near the end)
    });
  });
});

describe("saveCourseForm: 'Protokolli punktid' (phase protocols, spec §3)", () => {
  test("a contact course keeps its headings trimmed, without blank rows, in their order; an e-course keeps its practical points the same way (e-course completion)", async () => {
    const draft = await load(contact.id);
    expect(draft.protocolStages).toEqual([]);
    expect(await save({ ...draft, protocolStages: [" Ettevalmistus ", "", "Kulmude analüüs", "Värvimine"] })).toMatchObject({ ok: true });
    expect((await getCourseForEdit(db, contact.id))!.protocolStages).toEqual(["Ettevalmistus", "Kulmude analüüs", "Värvimine"]);
    expect((await load(contact.id)).protocolStages).toEqual(["Ettevalmistus", "Kulmude analüüs", "Värvimine"]);
    const e = await load(online.id);
    expect(await save({ ...e, protocolStages: [" Kulmude kuju ", "", "Värvimine"] })).toMatchObject({ ok: true });
    expect((await getCourseForEdit(db, online.id))!.protocolStages).toEqual(["Kulmude kuju", "Värvimine"]);
    expect((await load(online.id)).protocolStages).toEqual(["Kulmude kuju", "Värvimine"]);
  });

  test("more than 30 headings, or one over 120 characters, is refused on its field and nothing is saved", async () => {
    const draft = await load(contact.id);
    expect(fieldsOf(await save({ ...draft, protocolStages: Array.from({ length: 31 }, (_, i) => `Punkt ${i + 1}`) }))).toEqual({ protocolStages: "tooMany" });
    expect(fieldsOf(await save({ ...draft, protocolStages: ["x".repeat(121)] }))).toEqual({ protocolStages: "tooLong" });
    expect((await getCourseForEdit(db, contact.id))!.protocolStages).toEqual([]);
    expect(await save({ ...draft, protocolStages: Array.from({ length: 30 }, (_, i) => `Punkt ${i + 1}`) })).toMatchObject({ ok: true });
  });

  test("a draft without the headings (an editor page opened before the deploy) still saves, with none", async () => {
    const older: Partial<CourseDraft> = { ...(await load(contact.id)) };
    delete older.protocolStages;
    expect(await saveCourseForm(db, form({ data: JSON.stringify(older) }))).toMatchObject({ ok: true });
    expect((await getCourseForEdit(db, contact.id))!.protocolStages).toEqual([]);
  });

  test("a pasted heading with a control character, NUL or a lone surrogate is cleaned, not refused (Postgres refuses NUL in jsonb)", async () => {
    const draft = await load(contact.id);
    const pasted = ["Ette\u0000valmis\ud800tus", " Värvimine 😀 \udc00", "\u0000 \u0001 \u007f", `${"x".repeat(120)}\u0000`, "Rea\u0009vahe"];
    expect(await save({ ...draft, protocolStages: pasted })).toMatchObject({ ok: true });
    // the all-control heading is blank once cleaned and dropped; a valid pair (the emoji) and a tab stay; the 120 characters are counted after the cleaning
    expect((await getCourseForEdit(db, contact.id))!.protocolStages).toEqual(["Ettevalmistus", "Värvimine 😀", "x".repeat(120), "Rea\u0009vahe"]);
    expect(fieldsOf(await save({ ...draft, protocolStages: [`${"x".repeat(121)}\u0000`] }))).toEqual({ protocolStages: "tooLong" });
  });

  test("a pasted heading with Word's line or page break keeps its words apart: a heading is one line, so the break is a space", async () => {
    const draft = await load(contact.id);
    expect(await save({ ...draft, protocolStages: ["Ette\u000bvalmistus", "Värvi\u000cmine", "Kolmas\r\npunkt"] })).toMatchObject({ ok: true });
    expect((await getCourseForEdit(db, contact.id))!.protocolStages).toEqual(["Ette valmistus", "Värvi mine", "Kolmas punkt"]);
  });
});

describe("saveCourseForm: 'Teadmiste test' and the e-course's points (e-course completion, spec §3.1, §5.1, R1)", () => {
  const qid = (n: number) => `q${String(n).padStart(7, "0")}`;
  const oid = (n: number, j: number) => `o${String(n * 10 + j).padStart(7, "0")}`;
  const choice = (n: number, text: string, options: [string, boolean][]): TestQuestion => ({
    id: qid(n),
    kind: "choice",
    text,
    options: options.map(([t, correct], j) => ({ id: oid(n, j), text: t, correct })),
  });
  const open = (n: number, text: string): TestQuestion => ({ id: qid(n), kind: "open", text });
  const storedTest = async (id: number) => (await db.select().from(courseTests).where(eq(courseTests.courseId, id)))[0] ?? null;
  /** The e-course's draft as stored, with `test` changed (and `over` on top). */
  const withTest = async (test: Partial<CourseDraft["test"]>, over: Partial<CourseDraft> = {}) => {
    const d = await load(online.id);
    return save({ ...d, ...over, test: { ...d.test, ...test } });
  };
  const ok = choice(1, "Mitu kihti värvi kanname?", [["Ühe", false], ["Kaks", true]]);

  test("an e-course stores its questions in order, trimmed, with the pass mark and tries in course_tests; the editor gets them back; the key stays off the courses rows", async () => {
    const questions = [
      choice(1, " Mitu kihti värvi kanname? ", [[" Ühe ", false], ["Kaks", true]]),
      open(2, "Kirjelda, kuidas valmistad kulmud ette."),
      choice(3, "Vali kõik, mis kuulub ettevalmistusse", [["Tsüanoakrülaadi kontroll", true], ["Värvimine", false], ["Puhastamine", true]]),
    ];
    expect(await withTest({ questions, passPercent: "90", tries: "2" })).toMatchObject({ ok: true });
    expect(await storedTest(online.id)).toMatchObject({
      passPercent: 90,
      tries: 2,
      questions: [
        { id: qid(1), kind: "choice", text: "Mitu kihti värvi kanname?", options: [{ id: oid(1, 0), text: "Ühe", correct: false }, { id: oid(1, 1), text: "Kaks", correct: true }] },
        { id: qid(2), kind: "open", text: "Kirjelda, kuidas valmistad kulmud ette." },
        { id: qid(3), kind: "choice" },
      ],
    });
    expect((await load(online.id)).test).toMatchObject({ passPercent: "90", tries: "2", questions: [{ id: qid(1), text: "Mitu kihti värvi kanname?" }, { id: qid(2), kind: "open" }, { id: qid(3), kind: "choice" }] });
    // R1: the answer key is never on a courses row (listAllCourses reads whole rows, as the public queries do)
    expect(JSON.stringify(await listAllCourses(db))).not.toContain("Tsüanoakrülaadi kontroll");
    // saved again without questions: the row keeps its settings, the questions are gone
    expect(await withTest({ questions: [] })).toMatchObject({ ok: true });
    expect(await storedTest(online.id)).toMatchObject({ questions: [], passPercent: 90, tries: 2 });
  });

  test("each problem is refused on the field 'test' with the question (and the option) it is in; nothing is stored", async () => {
    const cases: [TestQuestion[], FieldError, { index: number; option?: number }][] = [
      [[ok, choice(2, "  ", [["A", true], ["B", false]])], "testEmpty", { index: 1 }],
      [[ok, choice(2, "Mis?", [["A", true], [" ", false]])], "testEmpty", { index: 1, option: 1 }],
      [[open(1, "x".repeat(501))], "testTooLong", { index: 0 }],
      [[choice(1, "Mis?", [["A", true], ["y".repeat(201), false]])], "testTooLong", { index: 0, option: 1 }],
      [[choice(1, "Mis?", [["A", true]])], "testOptions", { index: 0 }],
      [[choice(1, "Mis?", ["A", "B", "C", "D", "E", "F", "G"].map((t, j): [string, boolean] => [t, j === 0]))], "testOptions", { index: 0 }],
      [[ok, choice(2, "Mis?", [["A", false], ["B", false]])], "testNoCorrect", { index: 1 }],
      [Array.from({ length: 51 }, (_, i) => open(i + 1, `Küsimus ${i + 1}`)), "testTooMany", { index: -1 }],
    ];
    for (const [questions, code, at] of cases) expect(await withTest({ questions }), code).toEqual({ ok: false, error: "invalid", fields: { test: code }, at });
    expect(await storedTest(online.id)).toBeNull();
    // the limits themselves are fine
    expect(await withTest({ questions: [open(1, "x".repeat(500)), choice(2, "Mis?", [["y".repeat(200), true], ["B", false], ["C", false], ["D", false], ["E", false], ["F", false]])] })).toMatchObject({ ok: true });
    expect(await withTest({ questions: Array.from({ length: 50 }, (_, i) => open(i + 1, `Küsimus ${i + 1}`)) })).toMatchObject({ ok: true });
  });

  test("the pass mark is 1–100 and the tries 1–10, whole numbers, never blank: each refused on its own field", async () => {
    const cases = [
      ["0", "3", { testPassPercent: "whole" }],
      ["101", "3", { testPassPercent: "whole" }],
      ["", "3", { testPassPercent: "whole" }],
      ["80,5", "3", { testPassPercent: "whole" }],
      ["80", "0", { testTries: "whole" }],
      ["80", "11", { testTries: "whole" }],
      ["80", "kolm", { testTries: "whole" }],
      ["", "", { testPassPercent: "whole", testTries: "whole" }],
    ] as const;
    for (const [passPercent, tries, fields] of cases) expect(fieldsOf(await withTest({ questions: [ok], passPercent, tries })), `${passPercent} / ${tries}`).toEqual(fields);
    expect(await storedTest(online.id)).toBeNull();
    expect(await withTest({ questions: [ok], passPercent: "1", tries: "10" })).toMatchObject({ ok: true });
    expect(await withTest({ questions: [ok], passPercent: "100", tries: "1" })).toMatchObject({ ok: true });
    expect(await storedTest(online.id)).toMatchObject({ passPercent: 100, tries: 1 });
  });

  test("a contact course has no test: a draft's test is not stored, and switching an e-course to contact deletes its row", async () => {
    expect(await withTest({ questions: [ok] })).toMatchObject({ ok: true });
    expect(await storedTest(online.id)).not.toBeNull();
    expect(await save({ ...(await load(online.id)), type: "contact", priceGroup: "100" })).toMatchObject({ ok: true });
    expect(await storedTest(online.id)).toBeNull();
    expect((await getCourseForEdit(db, online.id))!.test).toBeNull();
    expect(await save({ ...(await load(contact.id)), test: { questions: [ok], passPercent: "80", tries: "3" } })).toMatchObject({ ok: true });
    expect(await storedTest(contact.id)).toBeNull();
    // back to an e-course: the test it is saved with is stored again
    expect(await save({ ...(await load(online.id)), type: "e_learning", price: "95", test: { questions: [ok], passPercent: "80", tries: "3" } })).toMatchObject({ ok: true });
    expect(await storedTest(online.id)).toMatchObject({ questions: [{ id: qid(1) }], passPercent: 80, tries: 3 });
  });

  test("a draft without the test (an editor page opened before the deploy) still saves: the e-course gets the defaults, no questions", async () => {
    const older: Partial<CourseDraft> = { ...(await load(online.id)) };
    delete older.test;
    expect(await saveCourseForm(db, form({ data: JSON.stringify(older) }))).toMatchObject({ ok: true });
    expect(await storedTest(online.id)).toMatchObject({ questions: [], passPercent: 80, tries: 3 });
  });

  test("a pasted question or option is cleaned (control characters, NUL): a question keeps its lines, an option is one line", async () => {
    const pasted: TestQuestion = {
      id: qid(1),
      kind: "choice",
      text: "Esimene\u0000 rida\nTeine rida",
      options: [
        { id: oid(1, 0), text: "Ük\u000bs", correct: true },
        { id: oid(1, 1), text: "Ka\r\nks", correct: false },
      ],
    };
    expect(await withTest({ questions: [pasted] })).toMatchObject({ ok: true });
    expect((await storedTest(online.id))!.questions).toEqual([
      { id: qid(1), kind: "choice", text: "Esimene rida\nTeine rida", options: [{ id: oid(1, 0), text: "Ük s", correct: true }, { id: oid(1, 1), text: "Ka ks", correct: false }] },
    ]);
  });

  test("an e-course's points have the headings' limits: more than 30, or one over 120 characters, is refused on its field", async () => {
    const e = await load(online.id);
    expect(fieldsOf(await save({ ...e, protocolStages: Array.from({ length: 31 }, (_, i) => `Punkt ${i + 1}`) }))).toEqual({ protocolStages: "tooMany" });
    expect(fieldsOf(await save({ ...e, protocolStages: ["x".repeat(121)] }))).toEqual({ protocolStages: "tooLong" });
    expect((await getCourseForEdit(db, online.id))!.protocolStages).toEqual([]);
  });
});

describe("saveCourseForm: 'Tunnistus' (phase 3d, spec §6)", () => {
  test("an e-course stores its certificate lines trimmed, without blank ones, in order, and its volume; the editor gets them back", async () => {
    const e = await load(online.id);
    expect([e.certificateSkills, e.certificateVolume]).toEqual([[], ""]);
    expect(await save({ ...e, certificateSkills: [" Kulmude kuju ja proportsioonid ", "", "Värvi valik"], certificateVolume: " 10 akadeemilist tundi " })).toMatchObject({ ok: true });
    expect(await getCourseForEdit(db, online.id)).toMatchObject({ certificateSkills: ["Kulmude kuju ja proportsioonid", "Värvi valik"], certificateVolume: "10 akadeemilist tundi" });
    expect(await load(online.id)).toMatchObject({ certificateSkills: ["Kulmude kuju ja proportsioonid", "Värvi valik"], certificateVolume: "10 akadeemilist tundi" });
  });

  test("more than 16 lines, a line over 120 characters or a volume over 80 is refused on its field; nothing is saved", async () => {
    const e = await load(online.id);
    expect(fieldsOf(await save({ ...e, certificateSkills: Array.from({ length: 17 }, (_, i) => `Oskus ${i + 1}`) }))).toEqual({ certificateSkills: "tooMany" });
    expect(fieldsOf(await save({ ...e, certificateSkills: ["x".repeat(121)] }))).toEqual({ certificateSkills: "tooLong" });
    expect(fieldsOf(await save({ ...e, certificateVolume: "x".repeat(81) }))).toEqual({ certificateVolume: "tooLong" });
    expect(await getCourseForEdit(db, online.id)).toMatchObject({ certificateSkills: [], certificateVolume: "" });
    expect(await save({ ...e, certificateSkills: Array.from({ length: 16 }, () => "x".repeat(120)), certificateVolume: "x".repeat(80) })).toMatchObject({ ok: true });
  });

  test("a contact course has no certificate: a draft's lines and volume are not stored, and switching an e-course to contact empties them", async () => {
    expect(await save({ ...(await load(contact.id)), certificateSkills: ["Kulmude kuju"], certificateVolume: "6 ak" })).toMatchObject({ ok: true });
    expect(await getCourseForEdit(db, contact.id)).toMatchObject({ certificateSkills: [], certificateVolume: "" });
    expect(await save({ ...(await load(online.id)), certificateSkills: ["Kulmude kuju"], certificateVolume: "10 akadeemilist tundi" })).toMatchObject({ ok: true });
    expect(await save({ ...(await load(online.id)), type: "contact", priceGroup: "100" })).toMatchObject({ ok: true });
    expect(await getCourseForEdit(db, online.id)).toMatchObject({ certificateSkills: [], certificateVolume: "" });
  });

  test("a draft without them (an editor page opened before the deploy) still saves, with none", async () => {
    const older: Partial<CourseDraft> = { ...(await load(online.id)) };
    delete older.certificateSkills;
    delete older.certificateVolume;
    expect(await saveCourseForm(db, form({ data: JSON.stringify(older) }))).toMatchObject({ ok: true });
    expect(await getCourseForEdit(db, online.id)).toMatchObject({ certificateSkills: [], certificateVolume: "" });
  });

  test("a pasted line is cleaned, not refused (control characters and NUL go, a line break is a space); a line blank once cleaned is dropped", async () => {
    const e = await load(online.id);
    expect(await save({ ...e, certificateSkills: ["Kulmude\u0000 kuju", "Värvi\r\nvalik", "\u0000 \u0001"], certificateVolume: "10\u000bakadeemilist tundi" })).toMatchObject({ ok: true });
    expect(await getCourseForEdit(db, online.id)).toMatchObject({ certificateSkills: ["Kulmude kuju", "Värvi valik"], certificateVolume: "10 akadeemilist tundi" });
  });
});
