import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { makeTestDb } from "./helpers";
import { fakeMediaStore } from "../fakes";
import type { Db } from "@/db/client";
import { campaign, certificateDesigns, clients, courseAccess, courseAreas, courseModules, courseSessions, courses, lessonFiles, lessonProgress, lessons, registrations } from "@/db/schema";
import { runSeed } from "@/db/seed";
import { applySeed, giveSeedCoursesAreas, SeedRefusal, studentDataRefusal } from "@/db/seed-apply";
import * as seedData from "@/db/seed-data";
import { SEEDED_AT } from "@/db/seed-data";
import { seedSessionStart } from "@/db/seed-dates";
import { formatWeekday } from "@/i18n/format";
import { getCourseBySlug, getGallery, getHomeData, getPage, getPracticePackages, getSettings, listModuleTitles, listPosts, listPublishedCourses, listUpcomingSessions } from "@/db/queries/public";
import { upsertCourse } from "@/db/queries/admin";
import { fromPrice, priceOptions } from "@/domain/course";
import { mediaUrl } from "@/lib/media";

describe("prototype seed", () => {
  let db: Db;
  let first: Record<string, number>;

  beforeAll(async () => {
    db = await makeTestDb();
    first = await applySeed(db);
  });

  test("fills every content table", () => {
    expect(first).toEqual({
      courses: 6,
      course_images: 24,
      course_modules: 25,
      course_sessions: 8,
      practice_packages: 2,
      hero_slides: 5,
      faq: 6,
      posts: 6,
      pages: 8,
      gallery_items: 7,
      campaign: 2,
      settings: 3,
      certificate_designs: 2,
    });
  });

  test("is idempotent: a second run changes nothing", async () => {
    const second = await applySeed(db);
    expect(second).toEqual(first);
  });

  test("courses: types, levels, prices and sample flags as agreed", async () => {
    const list = await listPublishedCourses(db);
    expect(list).toHaveLength(6);
    expect(list.every((c) => c.isSample && c.published)).toBe(true);
    const by = Object.fromEntries(list.map((c) => [c.slug, c]));
    const summary = (slug: string) => {
      const c = by[slug];
      return [c.type, c.level, c.price, c.priceGroup, c.priceIndividual];
    };
    expect(summary("kulmumeistri-baaskoolitus")).toEqual(["contact", "basic", null, 35000, 45000]);
    expect(summary("lash-lift-botox")).toEqual(["contact", "basic", null, 29000, 39000]);
    expect(summary("kulmude-lami")).toEqual(["contact", "advanced", null, 22000, 30000]);
    expect(summary("kulmumeistri-e-koolitus")).toEqual(["e_learning", "basic", 19000, null, null]);
    expect(summary("kulmukuju-ja-summeetria")).toEqual(["e_learning", "advanced", 9500, null, null]);
    expect(summary("ripsmete-laminatsiooni-alused")).toEqual(["e_learning", "basic", 15000, null, null]);

    expect(by["kulmumeistri-baaskoolitus"].durationLabel?.et).toBe("2 päeva · 16 ak");
    expect(by["lash-lift-botox"].durationLabel?.et).toBe("8 ak");
    expect(by["kulmude-lami"].durationLabel?.et).toBe("6 ak");
  });

  test("e-learning courses have access period, video and module counts; only the brow course has a next-course discount", async () => {
    const list = await listPublishedCourses(db);
    const online = Object.fromEntries(list.filter((c) => c.type === "e_learning").map((c) => [c.slug, c]));
    const moduleCount = async (slug: string) => (await listModuleTitles(db, online[slug].id)).length;
    expect([online["kulmumeistri-e-koolitus"].accessMonths, online["kulmumeistri-e-koolitus"].videoCount, await moduleCount("kulmumeistri-e-koolitus")]).toEqual([6, 24, 6]);
    expect([online["kulmukuju-ja-summeetria"].accessMonths, online["kulmukuju-ja-summeetria"].videoCount, await moduleCount("kulmukuju-ja-summeetria")]).toEqual([6, 8, 3]);
    expect([online["ripsmete-laminatsiooni-alused"].accessMonths, online["ripsmete-laminatsiooni-alused"].videoCount, await moduleCount("ripsmete-laminatsiooni-alused")]).toEqual([6, 12, 4]);
    expect(online["kulmumeistri-e-koolitus"].nextDiscount?.et).toBe("−10% järgmiselt koolituselt");
    expect(online["kulmukuju-ja-summeetria"].nextDiscount).toBeNull();
  });

  test("no hybrid option: every course offers either one e-learning price or group/individual prices", async () => {
    for (const c of await listPublishedCourses(db)) {
      const kinds = priceOptions(c).map((o) => o.kind);
      expect(kinds).toEqual(c.type === "e_learning" ? ["full"] : ["group", "individual"]);
      expect(fromPrice(c)).not.toBeNull();
    }
  });

  test("contact courses list the eight 'Koolitus sisaldab' items; every course has outcomes and four images", async () => {
    for (const c of await listPublishedCourses(db)) {
      expect(c.outcomes.length).toBeGreaterThan(0);
      expect(c.images).toHaveLength(4);
      expect(c.includes).toHaveLength(c.type === "contact" ? 8 : 0);
    }
    const contact = await getCourseBySlug(db, "kulmumeistri-baaskoolitus");
    expect(contact?.includes.map((i) => i.et)).toEqual([
      "Teooriaosa",
      "Praktiline osa, nt töö kahel modellil",
      "Õppematerjal, mis jääb peale koolitust õpilasele",
      "Koolitaja juhendamine ja personaalne tugi koolituse ajal",
      "Teadmiste test",
      "Praktilise töö hindamine",
      "Kõik vajalikud töövahendid koolituskeskuse poolt",
      "Eduka koolituse läbimise korral tunnistus",
    ]);
  });

  test("sessions: eight upcoming rows on the contact courses, ten weeks from a Saturday about six weeks ahead, one cancelled, capacity 4-6", async () => {
    const sessions = await listUpcomingSessions(db, new Date());
    expect(sessions).toHaveLength(8);
    expect(sessions.every((s) => s.course.type === "contact")).toBe(true);
    expect(sessions.filter((s) => s.status === "cancelled")).toHaveLength(1);
    expect(new Set(sessions.map((s) => s.city))).toEqual(new Set(["Pärnu", "Tallinn", "Tartu", "Viljandi"]));
    expect(sessions.every((s) => s.capacity >= 4 && s.capacity <= 6)).toBe(true);
    // relative to the seed day (seed-dates.ts): made on 1.10.2026 these were prototype D's 14.11.2026 and 23.01.2027
    expect(sessions[0].startsAt.toISOString()).toBe(seedSessionStart(SEEDED_AT, 0).toISOString());
    expect(sessions[sessions.length - 1].startsAt.toISOString()).toBe(seedSessionStart(SEEDED_AT, 70).toISOString());
    expect(sessions.map((s) => formatWeekday(s.startsAt, "et"))).toEqual(["laupäev", "laupäev", "laupäev", "laupäev", "kolmapäev", "laupäev", "laupäev", "laupäev"]);
    expect(sessions.every((s) => s.taken === 0)).toBe(true);
  });

  test("areas (course areas §3): the brow courses „Kulmukoolitused“, the lash courses „Ripsmekoolitused“, the migration's two rows and no new one", async () => {
    const areas = await db.select().from(courseAreas).orderBy(asc(courseAreas.sort));
    expect(areas.map((a) => [a.name, a.sort])).toEqual([
      [{ et: "Kulmukoolitused", ru: "Курсы по бровям" }, 1],
      [{ et: "Ripsmekoolitused", ru: "Курсы по ресницам" }, 2],
    ]);
    const name = new Map(areas.map((a) => [a.id, a.name.et]));
    const list = await listPublishedCourses(db);
    expect(Object.fromEntries(list.map((c) => [c.slug, c.areaId === null ? null : name.get(c.areaId)]))).toEqual({
      "kulmumeistri-baaskoolitus": "Kulmukoolitused",
      "lash-lift-botox": "Ripsmekoolitused",
      "kulmude-lami": "Kulmukoolitused",
      "kulmumeistri-e-koolitus": "Kulmukoolitused",
      "kulmukuju-ja-summeetria": "Kulmukoolitused",
      "ripsmete-laminatsiooni-alused": "Ripsmekoolitused",
    });
    // so the calendar has dates of both (its area chips are shown)
    const dated = new Set((await listUpcomingSessions(db, new Date())).map((s) => s.course.areaId));
    expect(dated.size).toBe(2);
  });

  test("practice packages carry duration and price (MINI 4 ak / 100 €, MAXI 8 ak / 150 €)", async () => {
    const packages = await getPracticePackages(db);
    expect(packages.map((p) => [p.code, p.models, p.durationLabel.et, p.price])).toEqual([
      ["MINI", 2, "4 ak", 10000],
      ["MAXI", 4, "8 ak", 15000],
    ]);
  });

  test("home data: five slides (first is the flower, tones light/dark/dark/light/dark as in prototype B), faq, posts; the old campaign offer off (piece 4b, R-d)", async () => {
    const home = await getHomeData(db);
    expect(home.slides.map((s) => s.tone)).toEqual(["light", "dark", "dark", "light", "dark"]);
    expect(home.slides[0].imageKey).toBe("/seed/flower-hero.png");
    expect(home.slides[0].title.ru).toBeTruthy();
    expect(home.slides[4].imageKey).toBe("/seed/brow-editorial.jpg");
    expect(home.faq).toHaveLength(6);
    expect(home.posts).toHaveLength(6);
    // the old campaign offer (row 1) is seeded off, and the home page never shows it; the newsletter popup's row is the migration's (off), which the
    // seed does not overwrite — a reset seeds it shown ("seed modes")
    expect(home.popup).toBeNull();
    expect((await db.select().from(campaign).orderBy(campaign.id)).map((r) => [r.id, r.kind, r.active])).toEqual([
      [1, "campaign", false],
      [2, "newsletter", false],
    ]);
    expect(Object.keys(home.pages).sort()).toEqual(["center_story", "privacy", "statement", "terms", "trainer_bio", "trainer_journey", "trainer_teaser"]);
    expect(home.settings).toHaveProperty("contact");
    expect(home.settings).toHaveProperty("newsletter", { discountLabel: "10%", welcomeCode: "" });
  });

  test("posts have slugs derived from their titles, newest first", async () => {
    const list = await listPosts(db);
    expect(list.map((p) => p.slug)).toEqual([
      "kuidas-valida-endale-sobiv-kulmukoolitus",
      "uus-koolitus-lash-lift-botox",
      "praktika-modellidega-mida-oodata",
      "kulmude-hooldus-parast-laminatsiooni",
      "ms-lab-koolitused-nuud-ka-tartus-ja-viljandis",
      "esimesest-koolitusest-oma-salongini",
    ]);
  });

  test("placeholder pages are marked for Maria", async () => {
    expect((await getPage(db, "trainer_journey"))?.body.et).toContain("Maria täiendab");
    expect((await getPage(db, "privacy"))?.body.et).toContain("Maria täiendab");
    expect((await getPage(db, "terms"))?.body.et).toContain("Maria täiendab");
  });

  test("the e-course terms: a short sample text in both languages for Maria to replace, no version in the body, no public page and no home data", async () => {
    const page = (await getPage(db, "course_terms"))!;
    expect(page.title).toEqual({ et: "E-koolituse tingimused", ru: "Условия онлайн-обучения" });
    expect(page.body.et).toContain("Näidistekst — Maria täiendab");
    expect(page.body.ru).toContain("Образец текста — Мария дополнит");
    for (const text of [page.body.et, page.body.ru!]) expect(text.split("\n\n").length).toBeGreaterThanOrEqual(3);
    expect(page.body.et).toMatch(/isiklik/);
    expect(page.body.et).toMatch(/jaga/);
    expect(Object.keys(page.body).sort()).toEqual(["et", "ru"]); // the version is the settings key courseTermsVersion, never in the body
    expect(await getSettings(db)).not.toHaveProperty("courseTermsVersion");
    expect(Object.keys((await getHomeData(db)).pages)).not.toContain("course_terms");
  });

  test("trainer works gallery and settings", async () => {
    const gallery = await getGallery(db, "trainer_works");
    expect(gallery).toHaveLength(7);
    const settings = await getSettings(db);
    expect(settings.trainer).toMatchObject({
      name: { et: "Maria Sosnina", ru: "Мария Соснина" },
      // D's labels (C26), in both languages
      stats: [
        { value: "8+", label: { et: "aastat kogemust", ru: "лет опыта" } },
        { value: "4", label: { et: "linna", ru: "города" } },
        { value: "1:4", label: { et: "väikesed grupid", ru: "малые группы" } },
      ],
    });
    expect(settings.contact).toMatchObject({ email: "info@mslab.ee" });
  });

  test("every seed image exists under public/seed and resolves to itself via mediaUrl", () => {
    const keys = new Set<string>();
    const collect = (value: unknown) => {
      if (typeof value === "string" && value.startsWith("/seed/")) keys.add(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    collect(seedData);
    expect(keys.size).toBeGreaterThan(10);
    for (const key of keys) {
      expect(existsSync(path.join(__dirname, "../../public", key)), key).toBe(true);
      expect(mediaUrl(key)).toBe(key);
    }
  });

  test("seed content never names an AI tool", () => {
    expect(JSON.stringify(seedData)).not.toMatch(/claude|anthropic|gpt|openai|lovable|gemini|midjourney/i);
  });
});

describe("seed modes", () => {
  test("a re-run never overwrites rows edited in admin or re-adds deleted children", async () => {
    const db = await makeTestDb();
    await applySeed(db);
    const original = (await getCourseBySlug(db, "lash-lift-botox"))!;
    await upsertCourse(db, { slug: "lash-lift-botox", type: "contact", level: "basic", title: { et: "Maria muutis" }, summary: original.summary, body: original.body, published: false });
    await db.delete(courseSessions);

    const counts = await applySeed(db);
    expect((await getCourseBySlug(db, "lash-lift-botox", { includeUnpublished: true }))?.title.et).toBe("Maria muutis");
    expect(counts.courses).toBe(6);
    expect(counts.course_sessions).toBe(0);
  });

  test("--reset restores the prototype content and ids", async () => {
    const db = await makeTestDb();
    await applySeed(db);
    await upsertCourse(db, { slug: "lash-lift-botox", type: "contact", level: "basic", title: { et: "Maria muutis" }, summary: { et: "" }, body: { et: "" } });
    const counts = await applySeed(db, { reset: true });
    expect(counts.courses).toBe(6);
    expect(counts.course_sessions).toBe(8);
    expect((await getCourseBySlug(db, "lash-lift-botox"))?.title.et).toBe("Lash Lift BOTOX baaskoolitus");
    expect((await db.select().from(courses).orderBy(courses.id))[0].id).toBe(1);
    // the home page's popup as the seed has it since piece 4b: the newsletter sign-up shown, the old campaign offer off (D3, R-d)
    expect((await getHomeData(db)).popup).toMatchObject({ id: 2, kind: "newsletter", active: true, imageKey: "/seed/gift-bag-serum.jpg" });
    expect((await db.select().from(campaign).where(eq(campaign.id, 1)))[0].active).toBe(false);
  });

  test("areas: --reset keeps the area list (not a content table) and gives the courses theirs again; an area the seed needs and lacks is added after the others", async () => {
    const db = await makeTestDb();
    // a database without the migration's „Ripsmekoolitused“ (renamed), and with an area of its own
    await db.update(courseAreas).set({ name: { et: "Ripsmed", ru: "Ресницы" } }).where(eq(courseAreas.sort, 2));
    await db.insert(courseAreas).values({ name: { et: "Meik", ru: "Макияж" }, sort: 5 });
    await applySeed(db);
    const names = async () => (await db.select().from(courseAreas).orderBy(asc(courseAreas.sort), asc(courseAreas.id))).map((a) => [a.name.et, a.sort]);
    expect(await names()).toEqual([
      ["Kulmukoolitused", 1],
      ["Ripsmed", 2],
      ["Meik", 5],
      ["Ripsmekoolitused", 6],
    ]);
    const areaOf = async (slug: string) => {
      const [row] = await db.select({ name: courseAreas.name }).from(courses).innerJoin(courseAreas, eq(courses.areaId, courseAreas.id)).where(eq(courses.slug, slug));
      return row?.name.et ?? null;
    };
    expect(await areaOf("lash-lift-botox")).toBe("Ripsmekoolitused");
    await applySeed(db, { reset: true });
    expect(await names()).toEqual([
      ["Kulmukoolitused", 1],
      ["Ripsmed", 2],
      ["Meik", 5],
      ["Ripsmekoolitused", 6],
    ]);
    expect(await areaOf("lash-lift-botox")).toBe("Ripsmekoolitused");
    expect(await areaOf("kulmude-lami")).toBe("Kulmukoolitused");
  });

  // tests/e2e/fixtures.ts ensureSeedAreas (review round 1, item 1): the local e2e database was seeded before the areas and is never reset, so the
  // seed's course rows exist and applySeed leaves them without one.
  test("giveSeedCoursesAreas: a database seeded before the areas gets them for the seed's courses that have none; any other course, and an area set, are left", async () => {
    const db = await makeTestDb();
    await applySeed(db);
    // as such a database is: no course has an area, the migration's „Ripsmekoolitused“ is gone, and Maria gave LAMI an area of her own
    await db.update(courses).set({ areaId: null });
    await db.delete(courseAreas).where(eq(courseAreas.sort, 2));
    const [meik] = await db.insert(courseAreas).values({ name: { et: "Meik", ru: "Макияж" }, sort: 3 }).returning();
    await db.update(courses).set({ areaId: meik.id }).where(eq(courses.slug, "kulmude-lami"));
    await db.insert(courses).values({ slug: "maria-oma", type: "contact", level: "basic", title: { et: "Maria oma" }, summary: { et: "" }, body: { et: "" }, sort: 9 });

    expect(await giveSeedCoursesAreas(db)).toBe(5);
    const rows = await db.select({ slug: courses.slug, area: courseAreas.name }).from(courses).leftJoin(courseAreas, eq(courses.areaId, courseAreas.id));
    expect(Object.fromEntries(rows.map((r) => [r.slug, r.area?.et ?? null]))).toEqual({
      "kulmumeistri-baaskoolitus": "Kulmukoolitused",
      "lash-lift-botox": "Ripsmekoolitused",
      "kulmude-lami": "Meik",
      "kulmumeistri-e-koolitus": "Kulmukoolitused",
      "kulmukuju-ja-summeetria": "Kulmukoolitused",
      "ripsmete-laminatsiooni-alused": "Ripsmekoolitused",
      "maria-oma": null,
    });
    // the missing area added after the others, by the seed's names
    expect((await db.select().from(courseAreas).orderBy(asc(courseAreas.sort))).map((a) => [a.name, a.sort])).toEqual([
      [{ et: "Kulmukoolitused", ru: "Курсы по бровям" }, 1],
      [{ et: "Meik", ru: "Макияж" }, 3],
      [{ et: "Ripsmekoolitused", ru: "Курсы по ресницам" }, 4],
    ]);
    // a second run changes nothing
    expect(await giveSeedCoursesAreas(db)).toBe(0);
    expect(await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(courseAreas)).toEqual([{ n: 3 }]);
  });

  test("--reset refuses to delete registrations unless forced", async () => {
    const db = await makeTestDb();
    await applySeed(db);
    const [course] = await db.select().from(courses).limit(1);
    await db.insert(registrations).values({ courseId: course.id, kind: "individual", name: "A", email: "a@example.com", paymentChoice: "full" });

    await expect(applySeed(db, { reset: true })).rejects.toThrow(/registration/);
    expect(await db.select().from(registrations)).toHaveLength(1);

    const counts = await applySeed(db, { reset: true, force: true });
    expect(counts.courses).toBe(6);
    expect(await db.select().from(registrations)).toHaveLength(0);
  });

  describe("--reset refuses to wipe students' lessons, with or without --force", () => {
    /** The seeded courses, a client, and (the parts asked for) an access, a progress row, a Bunny video and a file on a lesson. */
    async function world(parts: { access?: boolean; progress?: boolean; video?: "current" | "replaced"; file?: boolean }) {
      const db = await makeTestDb();
      await applySeed(db);
      const [course] = await db.select().from(courses).limit(1);
      const [m] = await db.insert(courseModules).values({ courseId: course.id, position: 90, title: { et: "M" } }).returning();
      const [lesson] = await db.insert(lessons).values({ moduleId: m.id, position: 1, title: { et: "L" } }).returning();
      const [client] = await db.insert(clients).values({ email: "kati@example.test" }).returning();
      if (parts.access) await db.insert(courseAccess).values({ clientId: client.id, courseId: course.id, grantedBy: "admin@example.test", expiresAt: new Date(Date.now() + 86_400_000) });
      if (parts.progress) await db.insert(lessonProgress).values({ clientId: client.id, lessonId: lesson.id, watchedSec: 30 });
      if (parts.video === "current") await db.update(lessons).set({ videoId: "11111111-2222-4333-8444-555555555555", videoStatus: "ready", durationSec: 60 }).where(eq(lessons.id, lesson.id));
      if (parts.video === "replaced") await db.update(lessons).set({ replacedVideoId: "11111111-2222-4333-8444-555555555555" }).where(eq(lessons.id, lesson.id));
      if (parts.file) await db.insert(lessonFiles).values({ lessonId: lesson.id, position: 1, name: "Tööleht.pdf", r2Key: "lessons/11111111-2222-4333-8444-555555555555.pdf", size: 10, contentType: "application/pdf" });
      return { db, lesson };
    }

    test.each([
      ["a course access row", { access: true }, /1 course access row\(s\)/],
      ["a lesson progress row", { progress: true }, /1 lesson progress row\(s\)/],
      ["a lesson with a Bunny video", { video: "current" as const }, /1 lesson video\(s\).*stay on Bunny/],
      ["a lesson whose replaced video is still on Bunny", { video: "replaced" as const }, /1 lesson video\(s\)/],
      ["a lesson file (its R2 object would be orphaned)", { file: true }, /1 lesson file\(s\).*in R2/],
    ])("%s: refused, also with force; nothing deleted", async (_name, parts, message) => {
      const { db } = await world(parts);
      const before = (await db.select().from(courses)).length;
      await expect(applySeed(db, { reset: true })).rejects.toThrow(message);
      await expect(applySeed(db, { reset: true, force: true })).rejects.toThrow(/--force does not override this/);
      expect(await db.select().from(courses)).toHaveLength(before);
      expect(await db.select().from(lessons)).toHaveLength(1);
      expect((await db.select().from(courseModules).where(eq(courseModules.position, 90))).length).toBe(1);
    });

    test("names every kind that is there, and says nothing of Bunny when there is no video", async () => {
      const { db } = await world({ access: true, progress: true });
      const error = await applySeed(db, { reset: true, force: true }).catch((e: Error) => e.message);
      expect(error).toMatch(/^Refusing to reset: 1 lesson progress row\(s\), 1 course access row\(s\) would be deleted with their courses\./);
      expect(error).not.toMatch(/Bunny/);
      const all = await world({ access: true, progress: true, video: "current", file: true });
      await expect(applySeed(all.db, { reset: true })).rejects.toThrow(/1 lesson progress row\(s\), 1 course access row\(s\), 1 lesson video\(s\), 1 lesson file\(s\) would be deleted/);
    });

    test("it says what to do for each kind: videos and files are removed in the admin; progress or access means real students, so no reset", () => {
      const none = { progress: 0, access: 0, videos: 0, files: 0 };
      for (const counts of [{ ...none, videos: 2 }, { ...none, files: 1 }, { ...none, videos: 1, files: 3 }]) {
        const text = studentDataRefusal(counts);
        expect(text).toMatch(/remove them in the admin first/);
        expect(text).not.toMatch(/real students/);
      }
      for (const counts of [{ ...none, access: 1 }, { ...none, progress: 4 }, { ...none, progress: 1, access: 1 }]) {
        const text = studentDataRefusal(counts);
        expect(text).toMatch(/real students: do not reset it, use a fresh database for a clean seed/);
        expect(text).not.toMatch(/admin first/);
      }
      expect(studentDataRefusal({ progress: 2, access: 1, videos: 3, files: 4 })).toBe(
        "Refusing to reset: 2 lesson progress row(s), 1 course access row(s), 3 lesson video(s), 4 lesson file(s) would be deleted with their courses. --force does not override this. Lesson videos and files would stay on Bunny and in R2 with nobody able to delete them: remove them in the admin first (Kustuta õppetund). Progress and access mean this database has real students: do not reset it, use a fresh database for a clean seed.",
      );
    });

    test("both refusals are a SeedRefusal, with counts and no row content", async () => {
      const { db } = await world({ progress: true, file: true });
      const refusal = await applySeed(db, { reset: true, force: true }).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(SeedRefusal);
      expect(String((refusal as Error).message)).not.toMatch(/kati|Tööleht|lessons\/1111/);

      const withRegistration = await makeTestDb();
      await applySeed(withRegistration);
      const [course] = await withRegistration.select().from(courses).limit(1);
      await withRegistration.insert(registrations).values({ courseId: course.id, kind: "individual", name: "A", email: "a@example.test", paymentChoice: "full" });
      const second = await applySeed(withRegistration, { reset: true }).catch((e: unknown) => e);
      expect(second).toBeInstanceOf(SeedRefusal);
      expect((second as Error).message).toBe("Refusing to reset: 1 registration(s) would be deleted with their courses. Pass --force to do it anyway.");
    });

    test("without those rows the reset works, and the refusal comes first when registrations exist too", async () => {
      const { db } = await world({});
      const counts = await applySeed(db, { reset: true });
      expect(counts.courses).toBe(6);

      const both = await world({ access: true });
      const [course] = await both.db.select().from(courses).limit(1);
      await both.db.insert(registrations).values({ courseId: course.id, kind: "individual", name: "A", email: "a@example.test", paymentChoice: "full" });
      await expect(applySeed(both.db, { reset: true, force: true })).rejects.toThrow(/course access row/);
      expect(await both.db.select().from(registrations)).toHaveLength(1);
    });

    test("a plain seed (no reset) is never refused by them", async () => {
      const { db } = await world({ access: true, progress: true, video: "current" });
      await expect(applySeed(db)).resolves.toMatchObject({ courses: 6 });
    });
  });
});

describe("the certificate designs (2026-11-11 certificate designs, spec §3)", () => {
  const FIXTURE = readFileSync("tests/fixtures/certificate-background.jpg");
  const designs = (db: Db) => db.select().from(certificateDesigns).orderBy(asc(certificateDesigns.sort), asc(certificateDesigns.id));

  test("„Hele“ and „Tume“ as the migration has them; a list emptied is filled again, one Maria has is left alone", async () => {
    const db = await makeTestDb();
    await applySeed(db);
    expect((await designs(db)).map((d) => [d.name, d.tone, d.backgroundKey, d.sort])).toEqual([
      ["Hele", "light", "", 1],
      ["Tume", "dark", "", 2],
    ]);
    await db.delete(certificateDesigns);
    await applySeed(db);
    expect((await designs(db)).map((d) => d.name)).toEqual(["Hele", "Tume"]);
    await db.update(certificateDesigns).set({ name: "Valge" }).where(eq(certificateDesigns.name, "Hele"));
    await applySeed(db);
    expect((await designs(db)).map((d) => d.name)).toEqual(["Valge", "Tume"]);
  });

  test("on this machine „Hele“ gets our test JPEG in the store (never over a photo it has); without a store no photo", async () => {
    const db = await makeTestDb();
    const store = fakeMediaStore();
    await applySeed(db, { background: { store, bytes: new Uint8Array(FIXTURE) } });
    expect(seedData.SEED_BACKGROUND_KEY).toMatch(/^img\/[0-9a-f-]{36}\.jpg$/);
    expect([...store.objects.keys()]).toEqual([seedData.SEED_BACKGROUND_KEY]);
    expect(store.objects.get(seedData.SEED_BACKGROUND_KEY)).toMatchObject({ contentType: "image/jpeg" });
    expect(Buffer.from(store.objects.get(seedData.SEED_BACKGROUND_KEY)!.bytes).equals(FIXTURE)).toBe(true);
    expect((await designs(db)).map((d) => [d.name, d.backgroundKey])).toEqual([
      ["Hele", seedData.SEED_BACKGROUND_KEY],
      ["Tume", ""],
    ]);
    // a photo uploaded since stays
    await db.update(certificateDesigns).set({ backgroundKey: "img/11111111-1111-4111-8111-111111111111.jpg" }).where(eq(certificateDesigns.name, "Hele"));
    await applySeed(db, { background: { store, bytes: new Uint8Array(FIXTURE) } });
    expect((await designs(db))[0].backgroundKey).toBe("img/11111111-1111-4111-8111-111111111111.jpg");
    // and a plain seed (another machine's, the CLI's Railway target) gives none
    const plain = await makeTestDb();
    await applySeed(plain);
    expect((await designs(plain)).map((d) => d.backgroundKey)).toEqual(["", ""]);
  });

  test("the test JPEG is ours: small, a JPEG, no camera data", () => {
    expect(FIXTURE.byteLength).toBeLessThan(64 * 1024);
    expect([...FIXTURE.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    // no Exif (APP1 "Exif") block
    expect(FIXTURE.includes(Buffer.from("Exif"))).toBe(false);
  });
});

describe("the seed CLI's output (runSeed)", () => {
  const LOCAL = "postgres://postgres:postgres@localhost:5432/mslab";
  const run = async (db: Db, args: string[]) => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await runSeed(LOCAL, args, (_url, opts) => applySeed(db, opts));
      return { code, out: out.mock.calls.map(String), err: err.mock.calls.map(String) };
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  };

  test("a refusal reaches the terminal as it is (counts and advice), exit code 1, and nothing is deleted", async () => {
    const db = await makeTestDb();
    await applySeed(db);
    const [course] = await db.select().from(courses).limit(1);
    const [client] = await db.insert(clients).values({ email: "kati@example.test" }).returning();
    await db.insert(courseAccess).values({ clientId: client.id, courseId: course.id, grantedBy: "admin@example.test", expiresAt: new Date(Date.now() + 86_400_000) });
    const { code, out, err } = await run(db, ["--reset", "--force", "--target", "local"]);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^Refusing to reset: 1 course access row\(s\) would be deleted with their courses\. --force does not override this\. Progress and access mean this database has real students/);
    expect(err[0]).not.toMatch(/Seed failed|database error/);
    expect(await db.select().from(courseAccess)).toHaveLength(1);
  });

  test("the registrations refusal ('Pass --force') reaches the terminal too", async () => {
    const db = await makeTestDb();
    await applySeed(db);
    const [course] = await db.select().from(courses).limit(1);
    await db.insert(registrations).values({ courseId: course.id, kind: "individual", name: "A", email: "a@example.test", paymentChoice: "full" });
    const { code, err } = await run(db, ["--reset", "--target", "local"]);
    expect(code).toBe(1);
    expect(err).toEqual(["Refusing to reset: 1 registration(s) would be deleted with their courses. Pass --force to do it anyway."]);
    const forced = await run(db, ["--reset", "--force", "--target", "local"]);
    expect(forced.code).toBe(0);
    expect(forced.out[0]).toBe("Seed done (content tables reset first). Row counts:");
  });

  test("any other error stays a database error with its code only, never its message", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = () => Promise.reject(Object.assign(new Error("Failed query: insert ... params: kati@example.test"), { code: "23505" }));
    const code = await runSeed(LOCAL, ["--target", "local"], failing);
    expect(code).toBe(1);
    expect(err.mock.calls.map(String)).toEqual(["Seed failed: database error [23505]."]);
    err.mockRestore();
  });
});
