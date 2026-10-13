import { beforeEach, describe, expect, test } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { makeTestDb } from "./helpers";
import type { Db } from "@/db/client";
import { clients, courseAccess, courseImages, courseModules, courses, courseSessions, lessons, posts, registrations, requests } from "@/db/schema";
import { courseUsage, typeLocked, getCourseForEdit, listAdminSessions, listAllCourses, listAllPosts, listContactCourses } from "@/db/queries/admin";
import { listUpcomingSessions } from "@/db/queries/public";
import { draftFromCourse, newCourseDraft, type CourseDraft } from "@/domain/course-editor";
import { deleteSessionForm, moveCourseForm, saveCourseForm, saveSessionForm, type EditResult } from "@/server/admin-content";

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
  test("listAllCourses has the drafts too, in the public order; ↑ / ↓ renumbers", async () => {
    const [draft] = await db.insert(courses).values({ ...base, slug: "mustand", type: "contact", title: { et: "Mustand" }, sort: 3 }).returning();
    expect((await listAllCourses(db)).map((c) => c.slug)).toEqual(["kulmude-lami", "e-kulm", "mustand"]);
    expect(await moveCourseForm(db, form({ id: String(draft.id), dir: "up" }))).toMatchObject({ ok: true });
    expect((await listAllCourses(db)).map((c) => [c.slug, c.sort])).toEqual([
      ["kulmude-lami", 1],
      ["mustand", 2],
      ["e-kulm", 3],
    ]);
    // the first cannot go up: nothing changes (still ok, the list is as it was)
    expect(await moveCourseForm(db, form({ id: String(contact.id), dir: "up" }))).toMatchObject({ ok: true });
    expect((await listAllCourses(db)).map((c) => c.slug)).toEqual(["kulmude-lami", "mustand", "e-kulm"]);
    expect(await moveCourseForm(db, form({ id: "999999", dir: "down" }))).toEqual({ ok: false, error: "notFound" });
    expect(await moveCourseForm(db, form({ id: String(contact.id), dir: "left" }))).toEqual({ ok: false, error: "invalid" });
    expect((await listContactCourses(db)).map((c) => c.title.et)).toEqual(["Kulmude LAMI", "Mustand"]);
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
});

describe("saveCourseForm: 'Protokolli punktid' (phase protocols, spec §3)", () => {
  test("a contact course keeps its headings trimmed, without blank rows, in their order; an e-course keeps none", async () => {
    const draft = await load(contact.id);
    expect(draft.protocolStages).toEqual([]);
    expect(await save({ ...draft, protocolStages: [" Ettevalmistus ", "", "Kulmude analüüs", "Värvimine"] })).toMatchObject({ ok: true });
    expect((await getCourseForEdit(db, contact.id))!.protocolStages).toEqual(["Ettevalmistus", "Kulmude analüüs", "Värvimine"]);
    expect((await load(contact.id)).protocolStages).toEqual(["Ettevalmistus", "Kulmude analüüs", "Värvimine"]);
    const e = await load(online.id);
    expect(await save({ ...e, protocolStages: ["Ei kuulu siia"] })).toMatchObject({ ok: true });
    expect((await getCourseForEdit(db, online.id))!.protocolStages).toEqual([]);
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
