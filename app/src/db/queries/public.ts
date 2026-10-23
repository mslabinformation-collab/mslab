import { and, asc, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { TERMS_PAGE_KEY } from "@/domain/course-terms";
import type { I18n } from "@/i18n/field";
import type { Db, Q } from "../client";
import { campaign, courseImages, courseModules, courseSessions, courses, faq, galleryItems, heroSlides, pages, posts, practicePackages, settings } from "../schema";
import type { Campaign, Course, CourseImage, CourseSession, FaqItem, GalleryItem, HeroSlide, Page, Post, PracticePackage } from "../schema";
import { seatsTaken } from "./seats";

// Public (read-only) queries. Every function takes the Db as its first argument and never creates one itself.

export type CourseWithImages = Course & { images: CourseImage[] };
/** A session with the seats taken now (confirmed and live holds, db/queries/seats.ts). */
export type SessionWithSeats = CourseSession & { taken: number };
export type CourseDetail = CourseWithImages & { sessions: SessionWithSeats[]; moduleTitles: I18n[] };
export type UpcomingSession = SessionWithSeats & { course: Course };
export type HomeData = {
  slides: HeroSlide[];
  courses: CourseWithImages[];
  faq: FaqItem[];
  posts: Post[];
  practice: PracticePackage[];
  pages: Record<string, Page>;
  settings: Record<string, unknown>;
  /** The popup the home page shows: the one active `campaign` row, of either kind (phase 2c); null when every popup is off. */
  popup: Campaign | null;
};

/** Number of newest posts shown in the home page blog carousel. */
const HOME_POSTS_LIMIT = 8;

const imageOrder = [asc(courseImages.sort), asc(courseImages.id)];

/** The published courses in the catalogue's order; `only.slugs` keeps just those courses (the account's favourites). */
export async function listPublishedCourses(db: Db, only?: { slugs: string[] }): Promise<CourseWithImages[]> {
  if (only && only.slugs.length === 0) return [];
  return db.query.courses.findMany({
    where: only ? and(eq(courses.published, true), inArray(courses.slug, only.slugs)) : eq(courses.published, true),
    orderBy: [asc(courses.sort), asc(courses.id)],
    with: { images: { orderBy: imageOrder } },
  });
}

/**
 * The module titles of a course (course_modules), in their order: the public course page and the e-course page show them, and count them. A
 * module made on a published course and not published yet (`unpublished`, piece 3a, R-e) is not among them.
 */
export async function listModuleTitles(db: Db, courseId: number): Promise<I18n[]> {
  const rows = await db
    .select({ title: courseModules.title })
    .from(courseModules)
    .where(and(eq(courseModules.courseId, courseId), eq(courseModules.unpublished, false)))
    .orderBy(asc(courseModules.position), asc(courseModules.id));
  return rows.map((r) => r.title);
}

/**
 * A course page. Drafts are hidden unless `includeUnpublished` is set (admin preview).
 * Sessions are ordered by start; pass `sessionsFrom` to drop sessions that started before that date.
 */
export async function getCourseBySlug(
  db: Db,
  slug: string,
  opts: { includeUnpublished?: boolean; sessionsFrom?: Date } = {},
): Promise<CourseDetail | null> {
  const course = await db.query.courses.findFirst({
    where: opts.includeUnpublished ? eq(courses.slug, slug) : and(eq(courses.slug, slug), eq(courses.published, true)),
    with: {
      images: { orderBy: imageOrder },
      sessions: {
        where: opts.sessionsFrom ? gte(courseSessions.startsAt, opts.sessionsFrom) : undefined,
        orderBy: [asc(courseSessions.startsAt), asc(courseSessions.id)],
      },
    },
  });
  if (!course) return null;
  const [counts, moduleTitles] = await Promise.all([seatsTaken(db, course.sessions.map((s) => s.id)), listModuleTitles(db, course.id)]);
  return { ...course, moduleTitles, sessions: course.sessions.map((s) => ({ ...s, taken: counts.get(s.id) ?? 0 })) };
}

/**
 * Sessions of published contact courses starting on or after `fromDate`, soonest first. Cancelled sessions are included
 * (the calendar shows them as cancelled). Only contact courses have dates (K1/K2): a session row of an e-learning course
 * (none can be made: the editor refuses a type change while sessions exist) is never shown. `only.slugs` keeps just those courses' sessions.
 */
export async function listUpcomingSessions(db: Db, fromDate: Date, only?: { slugs: string[] }): Promise<UpcomingSession[]> {
  if (only && only.slugs.length === 0) return [];
  const rows = await db
    .select({ session: courseSessions, course: courses })
    .from(courseSessions)
    .innerJoin(courses, eq(courseSessions.courseId, courses.id))
    .where(and(eq(courses.published, true), eq(courses.type, "contact"), gte(courseSessions.startsAt, fromDate), only ? inArray(courses.slug, only.slugs) : undefined))
    .orderBy(asc(courseSessions.startsAt), asc(courseSessions.id));
  const counts = await seatsTaken(db, rows.map((r) => r.session.id));
  return rows.map((r) => ({ ...r.session, course: r.course, taken: counts.get(r.session.id) ?? 0 }));
}

export async function getPracticePackages(db: Db): Promise<PracticePackage[]> {
  return db.select().from(practicePackages).orderBy(asc(practicePackages.sort), asc(practicePackages.code));
}

/** Published posts, newest first. */
export async function listPosts(db: Db, limit?: number): Promise<Post[]> {
  const q = db.select().from(posts).where(eq(posts.published, true)).orderBy(desc(posts.publishedAt), desc(posts.id));
  return limit ? q.limit(limit) : q;
}

export async function getPost(db: Db, slug: string): Promise<Post | null> {
  const [row] = await db.select().from(posts).where(and(eq(posts.slug, slug), eq(posts.published, true))).limit(1);
  return row ?? null;
}

export async function getPage(db: Db, key: string): Promise<Page | null> {
  const [row] = await db.select().from(pages).where(eq(pages.key, key)).limit(1);
  return row ?? null;
}

export async function getGallery(db: Db, group: string): Promise<GalleryItem[]> {
  return db.select().from(galleryItems).where(eq(galleryItems.group, group)).orderBy(asc(galleryItems.sort), asc(galleryItems.id));
}

/** One settings value, or null when the key is not stored. Takes the database or an open transaction (the admin's save reads inside its own). */
export async function readSetting(q: Q, key: string): Promise<unknown> {
  const [row] = await q.select().from(settings).where(eq(settings.key, key)).limit(1);
  return row ? row.value : null;
}

export async function getSettings(db: Db): Promise<Record<string, unknown>> {
  const rows = await db.select().from(settings);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Everything the home page needs in one call. The popup is the active one of the campaign and the newsletter popup, or null. The e-course terms (account-only) are not part of it. */
export async function getHomeData(db: Db): Promise<HomeData> {
  const [slides, courseList, faqItems, postList, practice, pageRows, settingsMap, popupRow] = await Promise.all([
    db.select().from(heroSlides).where(eq(heroSlides.active, true)).orderBy(asc(heroSlides.sort), asc(heroSlides.id)),
    listPublishedCourses(db),
    db.select().from(faq).orderBy(asc(faq.sort), asc(faq.id)),
    listPosts(db, HOME_POSTS_LIMIT),
    getPracticePackages(db),
    db.select().from(pages).where(ne(pages.key, TERMS_PAGE_KEY)),
    getSettings(db),
    db.select().from(campaign).where(eq(campaign.active, true)).limit(1),
  ]);
  return {
    slides,
    courses: courseList,
    faq: faqItems,
    posts: postList,
    practice,
    pages: Object.fromEntries(pageRows.map((p) => [p.key, p])),
    settings: settingsMap,
    popup: popupRow[0] ?? null,
  };
}
