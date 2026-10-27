import { and, asc, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { TERMS_PAGE_KEY } from "@/domain/course-terms";
import { POST_PART } from "@/domain/site-entities";
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

/**
 * The published courses in the catalogue's order; `only.slugs` keeps just those courses (the account's favourites).
 * `opts.drafts`: the signed-in admin's preview (admin UX pass piece 3a, ruling R-h): each course's unpublished changes are laid over its live data
 * (server/course-parts.ts withCourseDrafts), the order unchanged. Only a caller that has asked server/preview.ts previewActive passes it; the draft
 * layer is loaded only then, so every other reader (and the static pages) never touch it.
 */
export async function listPublishedCourses(db: Db, only?: { slugs: string[] }, opts: { drafts?: boolean } = {}): Promise<CourseWithImages[]> {
  if (only && only.slugs.length === 0) return [];
  const list = await db.query.courses.findMany({
    where: only ? and(eq(courses.published, true), inArray(courses.slug, only.slugs)) : eq(courses.published, true),
    orderBy: [asc(courses.sort), asc(courses.id)],
    with: { images: { orderBy: imageOrder } },
  });
  if (!opts.drafts) return list;
  const { withCourseDrafts } = await import("@/server/course-parts");
  return Promise.all(list.map((c) => withCourseDrafts(db, c)));
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
 * A course page. Unpublished courses are hidden unless `includeUnpublished` is set (admin preview).
 * Sessions are ordered by start; pass `sessionsFrom` to drop sessions that started before that date.
 * `drafts`: the signed-in admin's draft preview (admin UX pass piece 3a, ruling R-h; README §1.8 „Eelvaade ↗“): the course's unpublished changes are laid
 * over its live data (server/course-parts.ts withCourseDrafts, the test's answer key never among them), and the module titles are the working order's,
 * with the modules made on the published course and not published yet (server/course-parts.ts previewModuleTitles), as „Avalda muudatused“ would make
 * them. Only a caller that has asked server/preview.ts previewActive passes it (the course page); the draft layer is loaded only then. Without it
 * the module titles are the students' (listModuleTitles): the admin's contact-course read (includeUnpublished) lists no unpublished module either.
 */
export async function getCourseBySlug(
  db: Db,
  slug: string,
  opts: { includeUnpublished?: boolean; sessionsFrom?: Date; drafts?: boolean } = {},
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
  const preview = opts.drafts ? await import("@/server/course-parts") : null;
  const [counts, moduleTitles] = await Promise.all([
    seatsTaken(db, course.sessions.map((s) => s.id)),
    preview ? preview.previewModuleTitles(db, course) : listModuleTitles(db, course.id),
  ]);
  const detail = { ...course, moduleTitles, sessions: course.sessions.map((s) => ({ ...s, taken: counts.get(s.id) ?? 0 })) };
  return preview ? preview.withCourseDrafts(db, detail) : detail;
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

// ---------- the site content in the admin's draft preview (admin UX pass piece 4a, Task 3; ruling R-f) ----------
// `opts.drafts` on the readers of the home page, /koolitaja, /praktika and the posts (/uudised, /uudised/<slug>, the home page's carousel; piece 4b): the
// signed-in admin's preview lays the drafts of the entities home, trainer, practice and each post over the live data, each part as „Avalda muudatused“
// would store it, a part whose draft fails its check left live
// (server/site-preview.ts withSiteDrafts). Only a page that has asked server/preview.ts previewActive passes it; the draft layer is loaded only then, so
// every other reader (and the static pages) never touch it. The `pick`s below put each part's stored value where the reader keeps it.

/** The packages with the practice drafts' rows (by code) over the live ones, in their order. */
const packagesOver =
  (live: PracticePackage[]) =>
  (parts: Record<string, unknown>): PracticePackage[] =>
    live.map((p) => (Object.hasOwn(parts, p.code) ? (parts[p.code] as PracticePackage) : p));

/** Practice packages (MINI, MAXI) in their order; `opts.drafts`: the admin's preview (the practice drafts, above). */
export async function getPracticePackages(db: Db, opts: { drafts?: boolean } = {}): Promise<PracticePackage[]> {
  const live = await db.select().from(practicePackages).orderBy(asc(practicePackages.sort), asc(practicePackages.code));
  if (!opts.drafts) return live;
  const { withSiteDrafts } = await import("@/server/site-preview");
  return withSiteDrafts(db, "practice", live, packagesOver(live));
}

/** The trainer page's content (/koolitaja): the trainer setting (portrait, name, role, numbers), the bio, the two stories and the works gallery. */
export type TrainerPageData = { trainer: unknown; bio: Page | null; story: Page | null; journey: Page | null; works: GalleryItem[] };

/** The trainer's works gallery (gallery_items group; server/admin-site.ts WORKS_GROUP). */
const TRAINER_WORKS = "trainer_works";

/** What /koolitaja shows; `opts.drafts`: the admin's preview (the trainer drafts, above: parts trainer, bio, works, center_story, trainer_journey). */
export async function getTrainerPage(db: Db, opts: { drafts?: boolean } = {}): Promise<TrainerPageData> {
  const [trainer, bio, story, journey, works] = await Promise.all([
    readSetting(db, "trainer"),
    getPage(db, "trainer_bio"),
    getPage(db, "center_story"),
    getPage(db, "trainer_journey"),
    getGallery(db, TRAINER_WORKS),
  ]);
  const live: TrainerPageData = { trainer, bio, story, journey, works };
  if (!opts.drafts) return live;
  const { withSiteDrafts } = await import("@/server/site-preview");
  return withSiteDrafts(db, "trainer", live, (p) => ({
    trainer: Object.hasOwn(p, "trainer") ? p.trainer : trainer,
    bio: Object.hasOwn(p, "bio") ? (p.bio as Page) : bio,
    story: Object.hasOwn(p, "center_story") ? (p.center_story as Page) : story,
    journey: Object.hasOwn(p, "trainer_journey") ? (p.trainer_journey as Page) : journey,
    works: Object.hasOwn(p, "works") ? (p.works as GalleryItem[]) : works,
  }));
}

/**
 * The home page's data in the admin's preview: its own drafts (home: the hero slides, shown ones only, the statement, the trainer card's text, the
 * FAQ), the trainer's (the card's setting and the bio its text falls back to), the packages' and the carousel's posts', each from its own entity.
 */
async function homeWithDrafts(db: Db, live: HomeData): Promise<HomeData> {
  const { withSiteDrafts } = await import("@/server/site-preview");
  const home = await withSiteDrafts(db, "home", live, (p) => ({
    ...live,
    slides: Object.hasOwn(p, "slides") ? (p.slides as HeroSlide[]).filter((s) => s.active) : live.slides,
    faq: Object.hasOwn(p, "faq") ? (p.faq as FaqItem[]) : live.faq,
    pages: {
      ...live.pages,
      ...(Object.hasOwn(p, "statement") ? { statement: p.statement as Page } : {}),
      ...(Object.hasOwn(p, "teaser") ? { trainer_teaser: p.teaser as Page } : {}),
    },
  }));
  const trainer = await withSiteDrafts(db, "trainer", home, (p) => ({
    ...home,
    settings: Object.hasOwn(p, "trainer") ? { ...home.settings, trainer: p.trainer } : home.settings,
    pages: Object.hasOwn(p, "bio") ? { ...home.pages, trainer_bio: p.bio as Page } : home.pages,
  }));
  const practice = await withSiteDrafts(db, "practice", trainer, (p) => ({ ...trainer, practice: packagesOver(trainer.practice)(p) }));
  // the blog carousel's posts, each with its own drafts (piece 4b)
  return { ...practice, posts: await Promise.all(practice.posts.map((post) => postWithDrafts(db, post))) };
}

/**
 * A published post with its drafts laid over it, in the admin's preview (piece 4b, Task 2; the entity "post", one row per post): as „Avalda muudatused“
 * would store it (server/site-preview.ts withSiteDrafts, S4-Q1 A's check: a draft that fails it shows live), at its LIVE address — a drafted address is
 * the post's only after the publish, as a course's (piece 3a). The lists keep their live order.
 */
async function postWithDrafts(db: Db, post: Post): Promise<Post> {
  const { withSiteDrafts } = await import("@/server/site-preview");
  return withSiteDrafts(db, { entity: "post", id: post.id }, post, (p) => (Object.hasOwn(p, POST_PART) ? { ...(p[POST_PART] as Post), slug: post.slug } : post));
}

/** Published posts, newest first; `opts.drafts`: the admin's preview (each post's drafts, above: postWithDrafts). */
export async function listPosts(db: Db, limit?: number, opts: { drafts?: boolean } = {}): Promise<Post[]> {
  const q = db.select().from(posts).where(eq(posts.published, true)).orderBy(desc(posts.publishedAt), desc(posts.id));
  const list = await (limit ? q.limit(limit) : q);
  return opts.drafts ? Promise.all(list.map((post) => postWithDrafts(db, post))) : list;
}

/** A published post by its (live) address; `opts.drafts`: the admin's preview (its drafts, above: postWithDrafts). */
export async function getPost(db: Db, slug: string, opts: { drafts?: boolean } = {}): Promise<Post | null> {
  const [row] = await db.select().from(posts).where(and(eq(posts.slug, slug), eq(posts.published, true))).limit(1);
  if (!row) return null;
  return opts.drafts ? postWithDrafts(db, row) : row;
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

/**
 * Everything the home page needs in one call. The popup is the active one of the campaign and the newsletter popup, or null. The e-course terms
 * (account-only) are not part of it. `opts.drafts`: the admin's preview (the site content's drafts, above: homeWithDrafts).
 */
export async function getHomeData(db: Db, opts: { drafts?: boolean } = {}): Promise<HomeData> {
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
  const live: HomeData = {
    slides,
    courses: courseList,
    faq: faqItems,
    posts: postList,
    practice,
    pages: Object.fromEntries(pageRows.map((p) => [p.key, p])),
    settings: settingsMap,
    popup: popupRow[0] ?? null,
  };
  return opts.drafts ? homeWithDrafts(db, live) : live;
}
