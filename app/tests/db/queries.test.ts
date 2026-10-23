import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { makeTestDb } from "./helpers";
import type { Db } from "@/db/client";
import { campaign, courseModules, courses, courseSessions, registrations, requests, subscribers } from "@/db/schema";
import {
  getCourseBySlug,
  getGallery,
  getHomeData,
  getPage,
  getPost,
  getPracticePackages,
  getSettings,
  listModuleTitles,
  listPosts,
  listPublishedCourses,
  listUpcomingSessions,
} from "@/db/queries/public";
import {
  deleteFaq,
  deleteHeroSlide,
  listRegistrations,
  listRequests,
  listSubscribers,
  markRequestHandled,
  replaceCourseImages,
  replaceGallery,
  setRegistrationStatus,
  setSetting,
  upsertCampaign,
  upsertCourse,
  upsertFaq,
  upsertHeroSlide,
  upsertPage,
  upsertPost,
  upsertPracticePackage,
  upsertSession,
} from "@/db/queries/admin";

const base = { level: "basic" as const, title: { et: "T" }, summary: { et: "" }, body: { et: "" } };
const reg = (courseId: number, sessionId: number | null, status: "confirmed" | "awaiting_prepayment" | "cancelled", createdAt: string, n: string) => ({
  courseId,
  courseSessionId: sessionId,
  kind: "group" as const,
  name: n,
  email: `${n}@example.com`,
  paymentChoice: "half" as const,
  status,
  createdAt: new Date(createdAt),
});

describe("public queries", () => {
  let db: Db;
  let pub: { id: number };
  let draft: { id: number };
  let session: { id: number };

  beforeEach(async () => {
    db = await makeTestDb();
    [pub] = await db.insert(courses).values({ ...base, slug: "pub", type: "contact", published: true, sort: 2 }).returning();
    [draft] = await db.insert(courses).values({ ...base, slug: "draft", type: "contact", published: false }).returning();
    await db.insert(courses).values({ ...base, slug: "online", type: "e_learning", published: true, sort: 1, price: 9500 }).returning();
    [session] = await db
      .insert(courseSessions)
      .values({ courseId: pub.id, startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu", capacity: 4 })
      .returning();
    await db.insert(registrations).values([
      reg(pub.id, session.id, "confirmed", "2026-10-01T10:00:00Z", "a"),
      reg(pub.id, session.id, "awaiting_prepayment", "2026-10-02T10:00:00Z", "b"),
      reg(pub.id, session.id, "confirmed", "2026-10-03T10:00:00Z", "c"),
    ]);
  });

  test("listPublishedCourses returns only published courses, ordered by sort, with ordered images", async () => {
    await replaceCourseImages(db, pub.id, [{ key: "/seed/one.jpg" }, { key: "/seed/two.jpg" }]);
    const list = await listPublishedCourses(db);
    expect(list.map((c) => c.slug)).toEqual(["online", "pub"]);
    expect(list[1].images.map((i) => i.key)).toEqual(["/seed/one.jpg", "/seed/two.jpg"]);
  });

  test("getCourseBySlug counts the seats taken per session (confirmed; live holds since phase 2b)", async () => {
    const c = await getCourseBySlug(db, "pub");
    expect(c?.sessions).toHaveLength(1);
    expect(c?.sessions[0].taken).toBe(2);
    expect(c?.sessions[0].capacity).toBe(4);
    expect(c?.images).toEqual([]);
  });

  test("getCourseBySlug returns null for unknown slugs and hides drafts unless asked", async () => {
    expect(await getCourseBySlug(db, "missing")).toBeNull();
    expect(await getCourseBySlug(db, "draft")).toBeNull();
    expect((await getCourseBySlug(db, "draft", { includeUnpublished: true }))?.id).toBe(draft.id);
  });

  test("getCourseBySlug can limit sessions to those starting from a date, oldest first", async () => {
    await db.insert(courseSessions).values({ courseId: pub.id, startsAt: new Date("2026-10-20T08:00:00Z"), city: "Tartu" });
    const all = await getCourseBySlug(db, "pub");
    expect(all?.sessions.map((s) => s.city)).toEqual(["Tartu", "Pärnu"]);
    const later = await getCourseBySlug(db, "pub", { sessionsFrom: new Date("2026-11-01T00:00:00Z") });
    expect(later?.sessions.map((s) => s.city)).toEqual(["Pärnu"]);
  });

  test("listUpcomingSessions returns upcoming sessions of published courses with course and seats taken", async () => {
    const [draftSession] = await db.insert(courseSessions).values({ courseId: draft.id, startsAt: new Date("2026-11-15T08:00:00Z"), city: "Tartu" }).returning();
    await db.insert(courseSessions).values({ courseId: pub.id, startsAt: new Date("2026-09-01T08:00:00Z"), city: "Past" });
    await db.insert(courseSessions).values({ courseId: pub.id, startsAt: new Date("2026-12-01T08:00:00Z"), city: "Tallinn", status: "cancelled" });

    const list = await listUpcomingSessions(db, new Date("2026-10-01T00:00:00Z"));
    expect(list.map((s) => s.city)).toEqual(["Pärnu", "Tallinn"]);
    expect(list.some((s) => s.id === draftSession.id)).toBe(false);
    expect(list[0].course.slug).toBe("pub");
    expect(list[0].taken).toBe(2);
    expect(list[1].status).toBe("cancelled");
    expect(list[1].taken).toBe(0);
  });

  test("simple content getters return published rows only and null when missing", async () => {
    await upsertPost(db, { slug: "p1", title: { et: "P1" }, excerpt: { et: "" }, body: { et: "" }, category: { et: "" }, coverKey: "/seed/a.jpg", publishedAt: new Date("2026-09-01"), published: true });
    await upsertPost(db, { slug: "p2", title: { et: "P2" }, excerpt: { et: "" }, body: { et: "" }, category: { et: "" }, coverKey: "/seed/a.jpg", publishedAt: new Date("2026-09-10"), published: true });
    await upsertPost(db, { slug: "p3", title: { et: "P3" }, excerpt: { et: "" }, body: { et: "" }, category: { et: "" }, coverKey: "/seed/a.jpg", publishedAt: new Date("2026-09-20"), published: false });
    expect((await listPosts(db)).map((p) => p.slug)).toEqual(["p2", "p1"]);
    expect((await getPost(db, "p1"))?.slug).toBe("p1");
    expect(await getPost(db, "p3")).toBeNull();
    expect(await getPost(db, "nope")).toBeNull();

    expect(await getPage(db, "privacy")).toBeNull();
    await upsertPage(db, { key: "privacy", title: { et: "Privaatsus" }, body: { et: "x" } });
    expect((await getPage(db, "privacy"))?.title.et).toBe("Privaatsus");

    expect(await getGallery(db, "trainer_works")).toEqual([]);
    expect(await getSettings(db)).toEqual({});
    expect(await getPracticePackages(db)).toEqual([]);
  });

  test("getHomeData bundles active slides, courses, faq, posts, practice, pages, settings and the active campaign", async () => {
    await upsertHeroSlide(db, { imageKey: "/seed/a.jpg", kicker: { et: "k" }, title: { et: "t2" }, text: { et: "" }, ctaLabel: { et: "" }, ctaHref: "/", sort: 2 });
    await upsertHeroSlide(db, { imageKey: "/seed/a.jpg", kicker: { et: "k" }, title: { et: "t1" }, text: { et: "" }, ctaLabel: { et: "" }, ctaHref: "/", sort: 1 });
    await upsertHeroSlide(db, { imageKey: "/seed/a.jpg", kicker: { et: "k" }, title: { et: "off" }, text: { et: "" }, ctaLabel: { et: "" }, ctaHref: "/", sort: 0, active: false });
    await upsertFaq(db, { q: { et: "q" }, a: { et: "a" }, sort: 1 });
    await upsertPracticePackage(db, { code: "MINI", name: { et: "MINI" }, tagline: { et: "" }, models: 2, durationLabel: { et: "4 ak" }, price: 10000, sort: 1 });
    await upsertPage(db, { key: "statement", title: { et: "S" }, body: { et: "b" } });
    await setSetting(db, "newsletter", { discountLabel: "10%" });
    await upsertCampaign(db, { active: false, kicker: { et: "k" }, title: { et: "t" }, text: { et: "x" }, ctaLabel: { et: "Leia enda koolitus" }, ctaHref: "/koolitused", imageKey: "/seed/a.jpg" });

    const home = await getHomeData(db);
    expect(home.slides.map((s) => s.title.et)).toEqual(["t1", "t2"]);
    expect(home.courses.map((c) => c.slug)).toEqual(["online", "pub"]);
    expect(home.faq).toHaveLength(1);
    expect(home.posts).toEqual([]);
    expect(home.practice.map((p) => p.code)).toEqual(["MINI"]);
    expect(Object.keys(home.pages)).toEqual(["statement"]);
    expect(home.settings).toEqual({ newsletter: { discountLabel: "10%" } });
    expect(home.popup).toBeNull();

    await upsertCampaign(db, { active: true, kicker: { et: "k" }, title: { et: "t" }, text: { et: "x" }, ctaLabel: { et: "Leia enda koolitus" }, ctaHref: "/koolitused", imageKey: "/seed/a.jpg" });
    expect((await getHomeData(db)).popup).toMatchObject({ kind: "campaign", ctaLabel: { et: "Leia enda koolitus" } });

    // the newsletter row shown instead (at most one active): the home page gets that one
    await db.update(campaign).set({ active: false }).where(eq(campaign.id, 1));
    await db.update(campaign).set({ active: true }).where(eq(campaign.id, 2));
    expect((await getHomeData(db)).popup).toMatchObject({ id: 2, kind: "newsletter" });
  });
});

describe("admin queries", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  test("listRegistrations filters by the course type, returns newest first and joins course and session", async () => {
    const [contact] = await db.insert(courses).values({ ...base, slug: "c", type: "contact", published: true }).returning();
    const [online] = await db.insert(courses).values({ ...base, slug: "e", type: "e_learning", published: true }).returning();
    const [s] = await db.insert(courseSessions).values({ courseId: contact.id, startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu", capacity: 4 }).returning();
    await db.insert(registrations).values([
      reg(contact.id, s.id, "confirmed", "2026-10-01T10:00:00Z", "a"),
      reg(contact.id, s.id, "awaiting_prepayment", "2026-10-03T10:00:00Z", "b"),
      reg(contact.id, s.id, "confirmed", "2026-10-02T10:00:00Z", "c"),
      reg(online.id, null, "awaiting_prepayment", "2026-10-04T10:00:00Z", "d"),
    ]);

    const contactRows = await listRegistrations(db, { type: "contact" });
    expect(contactRows.map((r) => r.name)).toEqual(["b", "c", "a"]);
    expect(contactRows[0].course.slug).toBe("c");
    expect(contactRows[0].courseSession?.city).toBe("Pärnu");

    expect((await listRegistrations(db, { type: "e_learning" })).map((r) => r.name)).toEqual(["d"]);
    expect((await listRegistrations(db, {})).map((r) => r.name)).toEqual(["d", "b", "c", "a"]);
    expect((await listRegistrations(db, { type: "contact", status: "confirmed" })).map((r) => r.name)).toEqual(["c", "a"]);
    expect((await listRegistrations(db, { status: "awaiting_prepayment" })).map((r) => r.name)).toEqual(["d", "b"]);
  });

  test("setRegistrationStatus updates status and note, and returns null for an unknown id", async () => {
    const [c] = await db.insert(courses).values({ ...base, slug: "c", type: "contact" }).returning();
    const [r] = await db.insert(registrations).values(reg(c.id, null, "awaiting_prepayment", "2026-10-01T10:00:00Z", "a")).returning();
    const updated = await setRegistrationStatus(db, r.id, "confirmed", "50% laekus 02.10");
    expect(updated?.status).toBe("confirmed");
    expect(updated?.note).toBe("50% laekus 02.10");
    expect((await listRegistrations(db, { status: "confirmed" }))).toHaveLength(1);
    expect(await setRegistrationStatus(db, 9999, "cancelled", "")).toBeNull();
  });

  test("upsertCourse inserts, then updates by slug or id, and always refreshes updatedAt", async () => {
    const created = await upsertCourse(db, { ...base, slug: "x", type: "contact", title: { et: "Esimene" }, published: true });
    expect(created.title.et).toBe("Esimene");
    const [stale] = await db.update(courses).set({ updatedAt: new Date("2020-01-01") }).returning();
    expect(stale.updatedAt.getFullYear()).toBe(2020);

    const bySlug = await upsertCourse(db, { ...base, slug: "x", type: "contact", title: { et: "Teine" }, published: true });
    expect(bySlug.id).toBe(created.id);
    expect(bySlug.title.et).toBe("Teine");
    expect(bySlug.updatedAt.getFullYear()).toBeGreaterThanOrEqual(2026);

    await db.update(courses).set({ updatedAt: new Date("2020-01-01") });
    const byId = await upsertCourse(db, { id: created.id, ...base, slug: "x-renamed", type: "contact", title: { et: "Kolmas" } });
    expect(byId.id).toBe(created.id);
    expect(byId.slug).toBe("x-renamed");
    expect(byId.updatedAt.getFullYear()).toBeGreaterThanOrEqual(2026);
    expect(await db.select().from(courses)).toHaveLength(1);

    await expect(upsertCourse(db, { id: 9999, ...base, slug: "ghost", type: "contact" })).rejects.toThrow(/not found/i);
  });

  test("replaceCourseImages replaces the whole list in the given order", async () => {
    const c = await upsertCourse(db, { ...base, slug: "x", type: "contact", published: true });
    await replaceCourseImages(db, c.id, [{ key: "a.jpg", alt: { et: "A" } }, { key: "b.jpg" }, { key: "c.jpg" }]);
    let got = await getCourseBySlug(db, "x");
    expect(got?.images.map((i) => i.key)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(got?.images[0].alt?.et).toBe("A");
    await replaceCourseImages(db, c.id, [{ key: "c.jpg" }, { key: "a.jpg" }]);
    got = await getCourseBySlug(db, "x");
    expect(got?.images.map((i) => i.key)).toEqual(["c.jpg", "a.jpg"]);
    await replaceCourseImages(db, c.id, []);
    got = await getCourseBySlug(db, "x");
    expect(got?.images).toEqual([]);
  });

  test("upsertSession inserts and updates by id", async () => {
    const c = await upsertCourse(db, { ...base, slug: "x", type: "contact", published: true });
    const s = await upsertSession(db, { courseId: c.id, startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu", capacity: 6 });
    expect(s.capacity).toBe(6);
    expect(s.status).toBe("scheduled");
    const cancelled = await upsertSession(db, { id: s.id, courseId: c.id, startsAt: s.startsAt, city: "Pärnu", capacity: 6, status: "cancelled" });
    expect(cancelled.id).toBe(s.id);
    expect(cancelled.status).toBe("cancelled");
    expect(await db.select().from(courseSessions)).toHaveLength(1);
  });

  test("requests: listed newest first, optionally by kind, and can be marked handled", async () => {
    await db.insert(requests).values([
      { kind: "contact", payload: { name: "a" }, createdAt: new Date("2026-10-01T10:00:00Z") },
      { kind: "practice", payload: { name: "b" }, createdAt: new Date("2026-10-02T10:00:00Z") },
      { kind: "contact", payload: { name: "c" }, createdAt: new Date("2026-10-03T10:00:00Z") },
    ]);
    expect((await listRequests(db)).map((r) => r.payload.name)).toEqual(["c", "b", "a"]);
    const contacts = await listRequests(db, "contact");
    expect(contacts.map((r) => r.payload.name)).toEqual(["c", "a"]);
    const done = await markRequestHandled(db, contacts[0].id);
    expect(done?.handled).toBe(true);
    expect(await markRequestHandled(db, 9999)).toBeNull();
    expect((await listRequests(db)).filter((r) => r.handled)).toHaveLength(1);
  });

  test("hero slides and faq items can be created, updated and deleted", async () => {
    const slide = await upsertHeroSlide(db, { imageKey: "/seed/a.jpg", kicker: { et: "k" }, title: { et: "A" }, text: { et: "" }, ctaLabel: { et: "" }, ctaHref: "/", tone: "dark" });
    expect(slide.tone).toBe("dark");
    const edited = await upsertHeroSlide(db, { id: slide.id, imageKey: "/seed/a.jpg", kicker: { et: "k" }, title: { et: "B" }, text: { et: "" }, ctaLabel: { et: "" }, ctaHref: "/", tone: "light" });
    expect(edited.id).toBe(slide.id);
    expect(edited.tone).toBe("light");
    await deleteHeroSlide(db, slide.id);
    expect((await getHomeData(db)).slides).toEqual([]);

    const item = await upsertFaq(db, { q: { et: "q" }, a: { et: "a" } });
    const editedFaq = await upsertFaq(db, { id: item.id, q: { et: "q2" }, a: { et: "a2" }, sort: 3 });
    expect(editedFaq.q.et).toBe("q2");
    expect((await getHomeData(db)).faq).toHaveLength(1);
    await deleteFaq(db, item.id);
    expect((await getHomeData(db)).faq).toEqual([]);
  });

  test("upsertPost, upsertPage, upsertPracticePackage and setSetting update in place", async () => {
    const post = { slug: "a", title: { et: "A" }, excerpt: { et: "" }, body: { et: "" }, category: { et: "" }, coverKey: "/seed/a.jpg", published: true };
    const p1 = await upsertPost(db, post);
    const p2 = await upsertPost(db, { ...post, title: { et: "A2" } });
    expect(p2.id).toBe(p1.id);
    expect(p2.title.et).toBe("A2");
    const p3 = await upsertPost(db, { ...post, id: p1.id, slug: "a-new", title: { et: "A3" } });
    expect(p3.slug).toBe("a-new");
    expect(await listPosts(db)).toHaveLength(1);

    await upsertPage(db, { key: "terms", title: { et: "1" }, body: { et: "1" } });
    await upsertPage(db, { key: "terms", title: { et: "2" }, body: { et: "2" } });
    expect((await getPage(db, "terms"))?.body.et).toBe("2");

    await upsertPracticePackage(db, { code: "MAXI", name: { et: "MAXI" }, tagline: { et: "" }, models: 4, durationLabel: { et: "8 ak" }, price: 15000 });
    await upsertPracticePackage(db, { code: "MAXI", name: { et: "MAXI" }, tagline: { et: "" }, models: 4, durationLabel: { et: "9 ak" }, price: 16000 });
    const pk = await getPracticePackages(db);
    expect(pk).toHaveLength(1);
    expect(pk[0].durationLabel.et).toBe("9 ak");

    await setSetting(db, "contact", { email: "a@example.com" });
    await setSetting(db, "contact", { email: "b@example.com" });
    await setSetting(db, "newsletter", { discountLabel: "10%" });
    expect(await getSettings(db)).toEqual({ contact: { email: "b@example.com" }, newsletter: { discountLabel: "10%" } });
  });

  test("replaceGallery replaces only the given group, in order", async () => {
    await replaceGallery(db, "trainer_works", [{ key: "a.jpg" }, { key: "b.jpg", alt: { et: "B" } }]);
    await replaceGallery(db, "other", [{ key: "z.jpg" }]);
    expect((await getGallery(db, "trainer_works")).map((g) => g.key)).toEqual(["a.jpg", "b.jpg"]);
    await replaceGallery(db, "trainer_works", [{ key: "b.jpg" }]);
    expect((await getGallery(db, "trainer_works")).map((g) => g.key)).toEqual(["b.jpg"]);
    expect((await getGallery(db, "other")).map((g) => g.key)).toEqual(["z.jpg"]);
  });

  test("upsertCampaign keeps one row per popup kind (POPUP_ID), at most one active, and listSubscribers returns newest consent first", async () => {
    const input = { active: true, kicker: { et: "k" }, title: { et: "t" }, text: { et: "x" }, ctaLabel: { et: "Leia enda koolitus" }, ctaHref: "/koolitused", imageKey: "/seed/a.jpg" };
    await upsertCampaign(db, input);
    const second = await upsertCampaign(db, { ...input, title: { et: "t2" } });
    expect(second.id).toBe(1);
    expect(second.title.et).toBe("t2");
    // the newsletter row switched on switches the campaign off first (at most one active), in its own fixed row
    const nl = await upsertCampaign(db, { ...input, title: { et: "Uudiskiri" } }, "newsletter");
    expect([nl.id, nl.kind, nl.active]).toEqual([2, "newsletter", true]);
    expect((await db.select().from(campaign).where(eq(campaign.id, 1)))[0].active).toBe(false);

    await db.insert(subscribers).values([
      { email: "a@example.com", token: "1", consentAt: new Date("2026-10-01T10:00:00Z") },
      { email: "b@example.com", token: "2", consentAt: new Date("2026-10-02T10:00:00Z") },
    ]);
    expect((await listSubscribers(db)).map((s) => s.email)).toEqual(["b@example.com", "a@example.com"]);
  });
});

test("a course's module titles come from course_modules, in position order (phase 3a)", async () => {
  const db = await makeTestDb();
  const [c] = await db.insert(courses).values({ slug: "moodulid", type: "e_learning", level: "basic", title: { et: "M" }, summary: { et: "" }, body: { et: "" }, published: true }).returning();
  await db.insert(courseModules).values([{ courseId: c.id, position: 2, title: { et: "Teine" } }, { courseId: c.id, position: 1, title: { et: "Esimene", ru: "Первый" } }]);
  expect(await listModuleTitles(db, c.id)).toEqual([{ et: "Esimene", ru: "Первый" }, { et: "Teine" }]);
  expect((await getCourseBySlug(db, "moodulid"))?.moduleTitles).toEqual([{ et: "Esimene", ru: "Первый" }, { et: "Teine" }]);
});

test("a module added to a published course stays off the public page and its count until it is published (piece 3a, R-e)", async () => {
  const db = await makeTestDb();
  const [c] = await db.insert(courses).values({ slug: "moodulid", type: "e_learning", level: "basic", title: { et: "M" }, summary: { et: "" }, body: { et: "" }, published: true }).returning();
  await db.insert(courseModules).values([
    { courseId: c.id, position: 1, title: { et: "Esimene" } },
    { courseId: c.id, position: 2, title: { et: "Uus" }, unpublished: true },
    { courseId: c.id, position: 3, title: { et: "Kolmas" } },
  ]);
  expect(await listModuleTitles(db, c.id)).toEqual([{ et: "Esimene" }, { et: "Kolmas" }]);
  // the course page's list and count (moduleTitles) are the same two
  expect((await getCourseBySlug(db, "moodulid"))?.moduleTitles).toEqual([{ et: "Esimene" }, { et: "Kolmas" }]);
  await db.update(courseModules).set({ unpublished: false });
  expect(await listModuleTitles(db, c.id)).toEqual([{ et: "Esimene" }, { et: "Uus" }, { et: "Kolmas" }]);
});
