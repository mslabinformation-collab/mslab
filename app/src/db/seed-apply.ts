import { and, eq, getTableName, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { areaSlug } from "@/domain/course-areas";
import type { FileStore } from "@/server/media";
import type { Db } from "./client";
import { POPUP_ID, campaign, certificateDesigns, courseAccess, courseAreas, courseImages, courseModules, courseSessions, courses, faq, galleryItems, heroSlides, lessonFiles, lessonProgress, lessons, pages, posts, practicePackages, registrations, settings } from "./schema";
import { areaSeeds, campaignSeed, certificateDesignSeeds, courseSeeds, faqSeeds, heroSeeds, newsletterPopupSeed, pageSeeds, postSeeds, practiceSeeds, SEED_BACKGROUND_KEY, settingSeeds, trainerWorks } from "./seed-data";

// Applies the prototype content. Plain drizzle: no Cloudflare bindings, so it runs from the CLI (seed.ts) and from tests.
//
// Default mode only INSERTS WHAT IS MISSING (by slug / code / key; keyless lists such as hero slides, FAQ and the
// gallery only when empty). Rows that already exist, including everything Maria has edited in admin, are never
// overwritten, so running the seed twice (or against a live database) is safe.
// `reset` truncates the content tables first and restores the prototype content.

export type SeedOptions = {
  /** Truncate the content tables before seeding. */
  reset?: boolean;
  /**
   * Allow `reset` even when registrations exist (they are deleted together with the courses they belong to). It never allows a
   * reset over students' lesson progress, course access, lesson videos or lesson files (see `studentData`).
   */
  force?: boolean;
  /**
   * This machine's (the local seed, seed.ts; the e2e setup): our test JPEG (`bytes`, seed-data.ts SEED_BACKGROUND_FILE) put in `store` at
   * SEED_BACKGROUND_KEY, and „Hele“ given it while it has no photo (2026-11-11 certificate designs, spec §3). Never Maria's photo, never over hers.
   */
  background?: { store: FileStore; bytes: Uint8Array };
};

/** „Hele“'s test background (SeedOptions.background): the store gets the file once, the design its key only while it has none. */
export async function seedDesignBackground(db: Db, { store, bytes }: { store: FileStore; bytes: Uint8Array }): Promise<void> {
  if (!(await store.get(SEED_BACKGROUND_KEY))) await store.put(SEED_BACKGROUND_KEY, bytes.slice().buffer, "image/jpeg");
  await db
    .update(certificateDesigns)
    .set({ backgroundKey: SEED_BACKGROUND_KEY })
    .where(and(eq(certificateDesigns.name, "Hele"), eq(certificateDesigns.backgroundKey, "")));
}

const CONTENT_TABLES = ["courses", "course_images", "course_modules", "course_sessions", "registrations", "practice_packages", "hero_slides", "faq", "posts", "pages", "gallery_items", "campaign", "settings"];
const TRAINER_WORKS = "trainer_works";

/**
 * A reset the seed refuses. The CLI prints `text` as it is: counts and advice, never a row's content. (Every other error is a
 * database error, and prints only its code: safeDbError.)
 */
export class SeedRefusal extends Error {
  constructor(readonly text: string) {
    super(text);
    this.name = "SeedRefusal";
  }
}

async function total(db: Db, table: PgTable): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(table);
  return row.n;
}

/**
 * What the reset's TRUNCATE ... CASCADE would take with the courses and that no flag may take: the students' lesson progress and
 * course access, and the lessons' Bunny videos and R2 files (the lesson rows go, so the video ids and file keys are lost and nobody
 * can delete the videos from Bunny or the files from R2 any more: they would stay there, billed). `videos` counts lessons (a
 * replacement in progress is one more Bunny video).
 */
type StudentData = { progress: number; access: number; videos: number; files: number };
async function studentData(db: Db): Promise<StudentData> {
  const [videos] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(lessons)
    .where(or(isNotNull(lessons.videoId), isNotNull(lessons.replacedVideoId)));
  return { progress: await total(db, lessonProgress), access: await total(db, courseAccess), videos: videos.n, files: await total(db, lessonFiles) };
}

/** The refusal's text: the counts, then what to do for each kind that is there. Counts only. */
export function studentDataRefusal({ progress, access, videos, files }: StudentData): string {
  const found = [
    progress && `${progress} lesson progress row(s)`,
    access && `${access} course access row(s)`,
    videos && `${videos} lesson video(s)`,
    files && `${files} lesson file(s)`,
  ].filter(Boolean);
  const todo = [
    (videos || files) && "Lesson videos and files would stay on Bunny and in R2 with nobody able to delete them: remove them in the admin first (Kustuta õppetund).",
    (progress || access) && "Progress and access mean this database has real students: do not reset it, use a fresh database for a clean seed.",
  ].filter(Boolean);
  return `Refusing to reset: ${found.join(", ")} would be deleted with their courses. --force does not override this. ${todo.join(" ")}`;
}

/**
 * The course areas the seed's courses need (seed-data.ts areaSeeds), by slug → id. The list is Maria's (Seaded → Valdkonnad), so it is never truncated,
 * not even by a reset, and never overwritten: an area of the seed that no row has the slug of (renamed or deleted here) is added after the others.
 */
async function seedAreas(db: Db): Promise<Map<string, number>> {
  const rows = await db.select().from(courseAreas);
  const ids = new Map(rows.map((r) => [areaSlug(r.name), r.id]));
  let sort = Math.max(0, ...rows.map((r) => r.sort));
  for (const seed of areaSeeds) {
    const slug = areaSlug(seed.name);
    if (ids.has(slug)) continue;
    const [created] = await db.insert(courseAreas).values({ name: seed.name, sort: ++sort }).returning();
    ids.set(slug, created.id);
  }
  return ids;
}

/**
 * For the local e2e database only (tests/e2e/fixtures.ts ensureSeedAreas); applySeed never calls it. That database was seeded before the course areas
 * and is never reset, so applySeed's course insert does nothing there and the seed's courses keep no area. This finds or adds the seed's areas by slug
 * (as applySeed does) and gives each seed course its area where the course has none; a course with an area, and any course not in the seed, is left.
 * Returns how many courses it gave one.
 */
export async function giveSeedCoursesAreas(db: Db): Promise<number> {
  const ids = await seedAreas(db);
  let given = 0;
  for (const { slug, area } of courseSeeds) {
    if (area === undefined) continue;
    const id = ids.get(areaSlug({ et: area }));
    if (id === undefined) continue;
    const updated = await db
      .update(courses)
      .set({ areaId: id })
      .where(and(eq(courses.slug, slug), isNull(courses.areaId)))
      .returning();
    given += updated.length;
  }
  return given;
}

export async function applySeed(db: Db, opts: SeedOptions = {}): Promise<Record<string, number>> {
  if (opts.reset) {
    const data = await studentData(db);
    if (data.progress + data.access + data.videos + data.files > 0) throw new SeedRefusal(studentDataRefusal(data));
    const existing = await total(db, registrations);
    if (existing > 0 && !opts.force) {
      throw new SeedRefusal(`Refusing to reset: ${existing} registration(s) would be deleted with their courses. Pass --force to do it anyway.`);
    }
    await db.execute(sql.raw(`TRUNCATE TABLE ${CONTENT_TABLES.join(", ")} RESTART IDENTITY CASCADE`));
  }

  // Courses with their images, sessions and module titles: a course is seeded as a unit, only when its slug is new; its area (by slug) is the seed's.
  const areaIds = await seedAreas(db);
  for (const [index, { images, sessions = [], modules = [], area, ...course }] of courseSeeds.entries()) {
    await db.transaction(async (tx) => {
      const areaId = area === undefined ? null : (areaIds.get(areaSlug({ et: area })) ?? null);
      const [created] = await tx
        .insert(courses)
        .values({ ...course, areaId, published: true, isSample: true, sort: index + 1 })
        .onConflictDoNothing({ target: courses.slug })
        .returning();
      if (!created) return;
      await tx.insert(courseImages).values(images.map((image, i) => ({ courseId: created.id, key: image.key, alt: image.alt, sort: i })));
      if (sessions.length) await tx.insert(courseSessions).values(sessions.map((session) => ({ ...session, courseId: created.id })));
      if (modules.length) await tx.insert(courseModules).values(modules.map((title, i) => ({ courseId: created.id, position: i + 1, title })));
    });
  }

  await db.insert(practicePackages).values(practiceSeeds).onConflictDoNothing({ target: practicePackages.code });
  if ((await total(db, heroSlides)) === 0) await db.insert(heroSlides).values(heroSeeds);
  if ((await total(db, faq)) === 0) await db.insert(faq).values(faqSeeds.map((item, i) => ({ ...item, sort: i + 1 })));
  await db.insert(posts).values(postSeeds).onConflictDoNothing({ target: posts.slug });
  await db.insert(pages).values(pageSeeds).onConflictDoNothing({ target: pages.key });
  const [{ n: galleryCount }] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(galleryItems).where(eq(galleryItems.group, TRAINER_WORKS));
  if (galleryCount === 0) await db.insert(galleryItems).values(trainerWorks.map((item, i) => ({ group: TRAINER_WORKS, key: item.key, alt: item.alt, sort: i })));
  await db.insert(campaign).values({ ...campaignSeed, id: POPUP_ID.campaign, kind: "campaign" }).onConflictDoNothing({ target: campaign.id });
  await db.insert(campaign).values({ ...newsletterPopupSeed, id: POPUP_ID.newsletter, kind: "newsletter" }).onConflictDoNothing({ target: campaign.id });
  await db.insert(settings).values(Object.entries(settingSeeds).map(([key, value]) => ({ key, value }))).onConflictDoNothing({ target: settings.key });
  // the certificate designs (the migration seeds them; a list emptied by hand gets them again), and on this machine „Hele“'s test photo
  if ((await total(db, certificateDesigns)) === 0) await db.insert(certificateDesigns).values(certificateDesignSeeds);
  if (opts.background) await seedDesignBackground(db, opts.background);

  const counts: Record<string, number> = {};
  for (const table of [courses, courseImages, courseModules, courseSessions, practicePackages, heroSlides, faq, posts, pages, galleryItems, campaign, settings, certificateDesigns]) {
    counts[getTableName(table)] = await total(db, table);
  }
  return counts;
}
