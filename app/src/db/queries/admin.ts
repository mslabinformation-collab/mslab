import { and, asc, count, desc, eq, exists, gte, ilike, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Db, Q, Tx } from "../client";
import type * as schema from "../schema";
import { campaign, contentDrafts, courseAccess, courseImages, courseModules, courseSessions, courses, courseTests, faq, galleryItems, heroSlides, lessons, pages, POPUP_ID, posts, practicePackages, payments, registrations, requests, reviews, settings, subscribers } from "../schema";
import type { Campaign, Course, CourseImage, CourseSession, CourseTest, FaqItem, GalleryItem, HeroSlide, Page, PopupKind, Post, PracticePackage, Registration, Request as RequestRow, Subscriber, TestQuestion } from "../schema";
import { startOfDayTallinn } from "@/domain/calendar";
import { containsPattern, PAGE_SIZE, parseSearch } from "@/domain/paging";
import { registrationPrice, registrationStatusAfterPayment, type RegStatus } from "@/domain/registration";
import { REQUEST_TABS, TAB_KIND, type TabKey } from "@/domain/requests";
import { phoneQuery } from "@/domain/search";
import { pick, type I18n } from "@/i18n/field";
import { ownFaultCount } from "@/server/testplan";
import { assessmentCount } from "./assessment";
import { paged, type Paged, type Range } from "./paged";
import { NEEDS_ATTENTION } from "./payment-checks";
import { todaySessions } from "./protocols";
import { hasFreeSeat, takesSeat } from "./seats";

// Admin (write) queries. Callers must already have checked the admin session; nothing here does authorization.

type Insert<T extends { $inferInsert: unknown }> = T["$inferInsert"];
/** Insert shape with an optional id: with an id the row is updated, without one it is created. */
type WithOptionalId<T> = Omit<T, "id"> & { id?: number };

export type CourseInput = WithOptionalId<Omit<Insert<typeof courses>, "updatedAt">>;
export type SessionInput = WithOptionalId<Insert<typeof courseSessions>>;
export type PracticePackageInput = Insert<typeof practicePackages>;
export type HeroSlideInput = WithOptionalId<Insert<typeof heroSlides>>;
export type FaqInput = WithOptionalId<Insert<typeof faq>>;
export type PostInput = WithOptionalId<Insert<typeof posts>>;
export type PageInput = Insert<typeof pages>;
export type CampaignInput = Omit<Insert<typeof campaign>, "id" | "kind">;
export type ImageInput = { key: string; alt?: I18n | null };
export type RegistrationRow = Registration & { course: Course; courseSession: CourseSession | null };
/**
 * `ids`: only these registrations; `clientId`: only the ones linked to that client (the admin's Õpilased drawer).
 * `search` (A2, B7): a part of the name or the e-mail address, any case and taken literally, or a part of the phone number's digits (from 3 digits:
 * domain/search.ts). `courseId` / `sessionId`: one course, or one session (the list's scope select).
 */
export type RegistrationFilter = {
  type?: "e_learning" | "contact";
  status?: RegStatus;
  ids?: number[];
  clientId?: number;
  search?: string;
  courseId?: number;
  sessionId?: number;
};

function required<T>(row: T | undefined, what: string, id: number): T {
  if (row === undefined) throw new Error(`${what} ${id} not found`);
  return row;
}

// ---------- courses ----------

/** Creates or updates a course (by `id` when given, otherwise by unique `slug`). Always refreshes `updatedAt`. */
export async function upsertCourse(db: Db, input: CourseInput): Promise<Course> {
  const { id, ...fields } = input;
  const values = { ...fields, updatedAt: new Date() };
  if (id != null) {
    const [row] = await db.update(courses).set(values).where(eq(courses.id, id)).returning();
    return required(row, "Course", id);
  }
  const [row] = await db.insert(courses).values(values).onConflictDoUpdate({ target: courses.slug, set: values }).returning();
  return row;
}

/** Replaces the whole image list of a course; order of `images` becomes the display order. */
export async function replaceCourseImages(db: Db, courseId: number, images: ImageInput[]): Promise<CourseImage[]> {
  return db.transaction(async (tx) => {
    await tx.delete(courseImages).where(eq(courseImages.courseId, courseId));
    if (images.length === 0) return [];
    return tx
      .insert(courseImages)
      .values(images.map((img, i) => ({ courseId, key: img.key, alt: img.alt ?? null, sort: i })))
      .returning();
  });
}

export type AdminCourse = Course & { images: CourseImage[] };
/** A course of the admin's list: `changes` is true while the draft layer holds an unpublished change of it (the list's „Avaldamata muudatused“). */
export type CourseListRow = AdminCourse & { changes: boolean };

const imageOrder = [asc(courseImages.sort), asc(courseImages.id)];

/**
 * Every course, drafts included, in the public order (sort, then id), with its images and whether it has an unpublished change: the draft layer
 * (`content_drafts`, entity "course") holds a draft of it, or a module or lesson of it is flagged `unpublished` (B18, R-e: made on the published
 * course and waiting for „Avalda muudatused“).
 */
export async function listAllCourses(db: Db): Promise<CourseListRow[]> {
  const [rows, drafted, flagged] = await Promise.all([
    db.query.courses.findMany({ orderBy: [asc(courses.sort), asc(courses.id)], with: { images: { orderBy: imageOrder } } }),
    db.selectDistinct({ id: contentDrafts.entityId }).from(contentDrafts).where(eq(contentDrafts.entity, "course")),
    db
      .selectDistinct({ id: courseModules.courseId })
      .from(courseModules)
      .leftJoin(lessons, eq(lessons.moduleId, courseModules.id))
      .where(or(eq(courseModules.unpublished, true), eq(lessons.unpublished, true))),
  ]);
  const withChange = new Set([...drafted, ...flagged].map((d) => d.id));
  return rows.map((c) => ({ ...c, changes: withChange.has(c.id) }));
}

/** The course editor's course: the course with its images and its "Teadmiste test" row (null without one; e-course completion, R1). */
export type EditCourse = AdminCourse & { test: CourseTest | null };

/** One course for the editor (drafts included), or null. */
export async function getCourseForEdit(db: Db, id: number): Promise<EditCourse | null> {
  const [course, [test]] = await Promise.all([
    db.query.courses.findFirst({ where: eq(courses.id, id), with: { images: { orderBy: imageOrder } } }),
    db.select().from(courseTests).where(eq(courseTests.courseId, id)).limit(1),
  ]);
  return course ? { ...course, test: test ?? null } : null;
}

/** Is `slug` used by a course other than `exceptId`? (Also inside a caller's transaction.) */
export async function isSlugTaken(db: Q, slug: string, exceptId?: number): Promise<boolean> {
  const [row] = await db
    .select({ id: courses.id })
    .from(courses)
    .where(and(eq(courses.slug, slug), exceptId != null ? ne(courses.id, exceptId) : undefined))
    .limit(1);
  return row !== undefined;
}

/** A stored course's type and how many sessions and registrations point to it (a type change is refused then). */
export type CourseUsage = { type: Course["type"]; sessions: number; registrations: number; lessons: number; access: number };

export async function courseUsage(db: Q, id: number): Promise<CourseUsage | null> {
  const [[course], [sessions], [regs], [lessonRows], [accessRows]] = await Promise.all([
    db.select({ type: courses.type }).from(courses).where(eq(courses.id, id)),
    db.select({ n: count() }).from(courseSessions).where(eq(courseSessions.courseId, id)),
    db.select({ n: count() }).from(registrations).where(eq(registrations.courseId, id)),
    db.select({ n: count() }).from(lessons).innerJoin(courseModules, eq(lessons.moduleId, courseModules.id)).where(eq(courseModules.courseId, id)),
    db.select({ n: count() }).from(courseAccess).where(eq(courseAccess.courseId, id)),
  ]);
  return course
    ? { type: course.type, sessions: Number(sessions.n), registrations: Number(regs.n), lessons: Number(lessonRows.n), access: Number(accessRows.n) }
    : null;
}

/**
 * The course keeps its type (the editor's type switch is locked, and a save that changes it is refused): a contact course with
 * sessions or registrations, an e-course with lessons or anyone's access (also an ended one) — the other type would leave
 * them pointing at a course that no longer has them.
 */
export const typeLocked = (u: CourseUsage | null): boolean => Boolean(u && (u.sessions > 0 || u.registrations > 0 || u.lessons > 0 || u.access > 0));

/** "Teadmiste test" as the editor saves it (e-course completion, R1): a row of its own, so the answer key never rides on a courses row. */
export type CourseTestFields = { questions: TestQuestion[]; passPercent: number; tries: number };
/**
 * The course fields the editor writes (everything but id, sort and updatedAt), and the e-course's test (null: none, its row is deleted). The
 * certificate's lines and volume (phase 3d) are required here although the columns have defaults: every save writes them (a contact course
 * `[]` and `""`), so a save that forgot them could not leave an old e-course's lines behind.
 */
export type CourseFields = Omit<CourseInput, "id" | "sort"> & { test: CourseTestFields | null; certificateSkills: string[]; certificateVolume: string };

/**
 * The course editor's save: the course, its whole image list and its "Teadmiste test" row in ONE transaction.
 * - `id` null: a new course, placed after the others (sort = last + 1).
 * - `id` set: an update, refused as "stale" when `expected` (the updatedAt the editor loaded) is no longer the stored
 *   one — someone saved the course in another window meanwhile — so a save never overwrites changes it did not see.
 *   Compared to the millisecond, as JavaScript dates carry no microseconds.
 * - the test (e-course completion, R1): upserted into course_tests behind the same check, or its row deleted (a contact course).
 * `updatedAt` is set on every save. Returns the saved course with its images, "notFound" or "stale".
 */
export async function saveCourseWithImages(
  db: Db,
  target: { id: number | null; expected?: Date },
  fields: CourseFields,
  images: ImageInput[],
): Promise<AdminCourse | "notFound" | "stale"> {
  return db.transaction(async (tx) => {
    const { test, ...row } = fields;
    const values = { ...row, updatedAt: new Date() };
    let course: Course;
    if (target.id == null) {
      const [{ last }] = await tx.select({ last: sql<number | null>`max(${courses.sort})` }).from(courses);
      [course] = await tx.insert(courses).values({ ...values, sort: (last ?? 0) + 1 }).returning();
    } else {
      const same = target.expected ? sql`date_trunc('milliseconds', ${courses.updatedAt}) = ${target.expected.toISOString()}::timestamptz` : undefined;
      const [updated] = await tx.update(courses).set(values).where(and(eq(courses.id, target.id), same)).returning();
      if (!updated) {
        const [exists] = await tx.select({ id: courses.id }).from(courses).where(eq(courses.id, target.id));
        return exists ? "stale" : "notFound";
      }
      course = updated;
      await tx.delete(courseImages).where(eq(courseImages.courseId, course.id));
    }
    if (test)
      await tx
        .insert(courseTests)
        .values({ courseId: course.id, ...test, updatedAt: values.updatedAt })
        .onConflictDoUpdate({ target: courseTests.courseId, set: { ...test, updatedAt: values.updatedAt } });
    else await tx.delete(courseTests).where(eq(courseTests.courseId, course.id));
    const saved = images.length
      ? await tx
          .insert(courseImages)
          .values(images.map((img, i) => ({ courseId: course.id, key: img.key, alt: img.alt ?? null, sort: i })))
          .returning()
      : [];
    return { ...course, images: saved };
  });
}

// ---------- one course part at a time (admin UX pass piece 3a: server/course-parts.ts) ----------

/**
 * The course row's lock (`SELECT … FROM courses WHERE id = $1 FOR UPDATE`), and the row as it is under it; null when there is no such course. Every
 * write of a course part, its publish, its discard and the „Avaldatud“ switch take it first, before they touch the course's drafts in
 * `content_drafts`: one lock order, so a publish and a discard of the same course never wait for each other the other way round (ledger T11, 40P01),
 * and a part's live value read after it stays what it is until the writes (the old editor's save locks the row by its own UPDATE, first too).
 */
export async function lockCourse(tx: Tx, id: number): Promise<Course | null> {
  const [row] = await tx.select().from(courses).where(eq(courses.id, id)).for("update");
  return row ?? null;
}

/** The course columns a part writes (never id, sort or updatedAt: updatedAt is `now`, so the old editor's stale guard sees every part's write). */
export type CourseColumns = Partial<Omit<CourseInput, "id" | "sort">>;

/** A course part's columns, under the course's lock. */
export async function updateCourseColumns(tx: Tx, id: number, values: CourseColumns, now: Date): Promise<void> {
  await tx.update(courses).set({ ...values, updatedAt: now }).where(eq(courses.id, id));
}

/** The gallery part: the course's whole image list replaced, in this order. */
export async function writeCourseImages(tx: Tx, id: number, images: ImageInput[], now: Date): Promise<void> {
  await tx.delete(courseImages).where(eq(courseImages.courseId, id));
  if (images.length) await tx.insert(courseImages).values(images.map((img, i) => ({ courseId: id, key: img.key, alt: img.alt ?? null, sort: i })));
  await updateCourseColumns(tx, id, {}, now);
}

/** The test part: the course_tests row upserted, or deleted (null: no test, a contact course). The answer key stays in its own table. */
export async function writeCourseTest(tx: Tx, id: number, test: CourseTestFields | null, now: Date): Promise<void> {
  if (test) await tx.insert(courseTests).values({ courseId: id, ...test, updatedAt: now }).onConflictDoUpdate({ target: courseTests.courseId, set: { ...test, updatedAt: now } });
  else await tx.delete(courseTests).where(eq(courseTests.courseId, id));
  await updateCourseColumns(tx, id, {}, now);
}

/**
 * What a course of each type does not have, emptied when the course becomes that type, as the old editor's save stores only the chosen type's (a course
 * is e-learning or contact, never both). An e-course has no group or individual price, duration or „Koolitus sisaldab“; a contact course no price,
 * access, video count, discount or certificate lines (and no test: its course_tests row goes, clearOtherCourseType). „Protokolli punktid“ and the
 * outcomes are both types'. The draft preview (server/course-parts.ts withCourseDrafts) shows a drafted type change the same way.
 */
export const EMPTIED_FOR_TYPE = {
  e_learning: { priceGroup: null, priceIndividual: null, durationLabel: null, includes: [] },
  contact: { price: null, accessMonths: null, videoCount: null, nextDiscount: null, certificateSkills: [], certificateVolume: "" },
} satisfies Record<Course["type"], CourseColumns>;

/** A course whose type became `type`: the other type's fields are emptied (EMPTIED_FOR_TYPE), and a contact course's test goes. */
export async function clearOtherCourseType(tx: Tx, id: number, type: Course["type"], now: Date): Promise<void> {
  await updateCourseColumns(tx, id, EMPTIED_FOR_TYPE[type], now);
  if (type === "contact") await tx.delete(courseTests).where(eq(courseTests.courseId, id));
}

/**
 * Puts a course at place `index` of the public order (0 is the first) and renumbers every sort 1…n; the other courses keep their order. An index past the
 * end puts it last, a negative one first. One transaction with every course row locked (`FOR UPDATE`), so two moves at once (two tabs, two drops in a
 * row) each see the order the other left and no course is lost or doubled. The ↑ / ↓ buttons call it with the neighbour's place. "notFound": no such course.
 * A move changes no course's content, so `updated_at` stays.
 */
export async function moveCourseTo(db: Db, id: number, index: number): Promise<"ok" | "notFound"> {
  return db.transaction(async (tx) => {
    // The locks first, the order second, as two statements. One `select … order by sort, id for update` works the order out BEFORE it waits for the locks: under
    // READ COMMITTED a move that waited for another's commit then gets the rows' new sorts in the old order, applies its place to that old order, and so overwrites
    // the other's move (both answer "ok"). `order by id` is a key no move changes, and the second statement takes a fresh snapshot, after the locks are ours.
    // (tests/e2e/course-order-race.spec.ts shows it on real Postgres: PGlite runs one transaction at a time and cannot.)
    await tx.select({ id: courses.id }).from(courses).orderBy(asc(courses.id)).for("update");
    const list = await tx.select({ id: courses.id, sort: courses.sort }).from(courses).orderBy(asc(courses.sort), asc(courses.id));
    const from = list.findIndex((c) => c.id === id);
    if (from < 0) return "notFound";
    const [moved] = list.splice(from, 1);
    list.splice(Math.min(Math.max(index, 0), list.length), 0, moved);
    for (const [n, c] of list.entries()) if (c.sort !== n + 1) await tx.update(courses).set({ sort: n + 1 }).where(eq(courses.id, c.id));
    return "ok";
  });
}

// ---------- calendar (course sessions) ----------

export type AdminSessionRow = CourseSession & {
  course: Pick<Course, "id" | "slug" | "title" | "type" | "published">;
  /** Registrations by status (cancelled ones are not counted). */
  confirmed: number;
  awaiting: number;
  /** Seats taken now: the confirmed ones and the live holds of unpaid ones (phase 2b, db/queries/seats.ts). What "vabu" counts against. */
  taken: number;
  /** Open waitlist requests for this session. */
  waitlist: number;
};

/**
 * Sessions for the admin calendar, drafts' sessions included, with the registration and waitlist counts per session.
 * `upcoming`: starting from `from`, soonest first; otherwise the ones before `from`, latest first. `{ ids }`: those
 * sessions, wherever they are in time (the drawer of a session opened from either list).
 */
export async function listAdminSessions(db: Db, opts: { from: Date; upcoming: boolean } | { ids: number[] }, now: Date = new Date()): Promise<AdminSessionRow[]> {
  if ("ids" in opts && opts.ids.length === 0) return [];
  const where = "ids" in opts ? inArray(courseSessions.id, opts.ids) : opts.upcoming ? gte(courseSessions.startsAt, opts.from) : lt(courseSessions.startsAt, opts.from);
  const newestFirst = "upcoming" in opts && !opts.upcoming;
  const rows = await db
    .select({ session: courseSessions, course: { id: courses.id, slug: courses.slug, title: courses.title, type: courses.type, published: courses.published } })
    .from(courseSessions)
    .innerJoin(courses, eq(courseSessions.courseId, courses.id))
    .where(where)
    .orderBy(newestFirst ? desc(courseSessions.startsAt) : asc(courseSessions.startsAt), asc(courseSessions.id));
  const ids = rows.map((r) => r.session.id);
  if (ids.length === 0) return [];
  const [regs, waits] = await Promise.all([
    db
      .select({
        sessionId: registrations.courseSessionId,
        confirmed: sql<number>`count(*) filter (where ${registrations.status} = 'confirmed')`.mapWith(Number),
        awaiting: sql<number>`count(*) filter (where ${registrations.status} = 'awaiting_prepayment')`.mapWith(Number),
        taken: sql<number>`count(*) filter (where ${takesSeat(now)})`.mapWith(Number),
      })
      .from(registrations)
      .where(inArray(registrations.courseSessionId, ids))
      .groupBy(registrations.courseSessionId),
    db
      .select({ session: sql<string>`${requests.payload}->>'session'`, n: count() })
      .from(requests)
      .where(and(eq(requests.kind, "waitlist"), eq(requests.handled, false), inArray(sql`${requests.payload}->>'session'`, ids.map(String))))
      .groupBy(sql`${requests.payload}->>'session'`),
  ]);
  const reg = new Map(regs.map((r) => [r.sessionId, r]));
  const wait = new Map(waits.map((w) => [Number(w.session), Number(w.n)]));
  return rows.map((r) => ({
    ...r.session,
    course: r.course,
    confirmed: reg.get(r.session.id)?.confirmed ?? 0,
    awaiting: reg.get(r.session.id)?.awaiting ?? 0,
    taken: reg.get(r.session.id)?.taken ?? 0,
    waitlist: wait.get(r.session.id) ?? 0,
  }));
}

/** One session, or null. */
export async function getSession(db: Db, id: number): Promise<CourseSession | null> {
  const [row] = await db.select().from(courseSessions).where(eq(courseSessions.id, id)).limit(1);
  return row ?? null;
}

/** Contact courses (the only ones with sessions), drafts included, in the public order. */
export async function listContactCourses(db: Db): Promise<Pick<Course, "id" | "title" | "published">[]> {
  return db
    .select({ id: courses.id, title: courses.title, published: courses.published })
    .from(courses)
    .where(eq(courses.type, "contact"))
    .orderBy(asc(courses.sort), asc(courses.id));
}

/**
 * Deletes a session that nobody has registered for. "inUse" when registrations point to it (they keep their history:
 * cancel the session instead), "notFound" when it does not exist.
 */
export async function deleteUnusedSession(db: Db, id: number): Promise<"deleted" | "inUse" | "notFound"> {
  return db.transaction(async (tx) => {
    const [session] = await tx.select({ id: courseSessions.id }).from(courseSessions).where(eq(courseSessions.id, id)).for("update");
    if (!session) return "notFound";
    const [{ n }] = await tx.select({ n: count() }).from(registrations).where(eq(registrations.courseSessionId, id));
    if (Number(n) > 0) return "inUse";
    await tx.delete(courseSessions).where(eq(courseSessions.id, id));
    return "deleted";
  });
}

export async function upsertSession(db: Db, input: SessionInput): Promise<CourseSession> {
  const { id, ...fields } = input;
  if (id != null) {
    const [row] = await db.update(courseSessions).set(fields).where(eq(courseSessions.id, id)).returning();
    return required(row, "Session", id);
  }
  const [row] = await db.insert(courseSessions).values(fields).returning();
  return row;
}

// ---------- registrations and requests ----------

// (paging lives in paged.ts so that protocols.ts and payments.ts can page without importing this file back; the names stay exported from here)
export { paged, type Paged, type Range };

/**
 * Manual status change by Maria (e.g. confirm after the prepayment arrived). Returns null when the id does not exist,
 * or, with `expected`, when the status is no longer the one she saw (someone else changed it meanwhile): one
 * UPDATE ... WHERE status = expected, so it cannot overwrite a change it did not see.
 */
export async function setRegistrationStatus(
  db: Db,
  id: number,
  status: RegStatus,
  note?: string,
  opts: { expected?: RegStatus } = {},
): Promise<Registration | null> {
  const [row] = await db
    .update(registrations)
    .set(note === undefined ? { status } : { status, note })
    .where(and(eq(registrations.id, id), opts.expected ? eq(registrations.status, opts.expected) : undefined))
    .returning();
  return row ?? null;
}

/**
 * The search of the registrations list (B7): the name or the e-mail address holds the text (ILIKE, `%` `_` `\` escaped: containsPattern), or the
 * phone's digits hold the text's digits (domain/search.ts: from 3 digits, so „+372 5123 4567“ finds a number stored as „51234567“ or „5123-4567“).
 */
function registrationSearch(search: string | undefined) {
  const q = parseSearch(search);
  if (!q) return undefined;
  const text = containsPattern(q);
  const phone = phoneQuery(q);
  return or(
    ilike(registrations.name, text),
    ilike(registrations.email, text),
    phone ? sql`regexp_replace(${registrations.phone}, '[^0-9]', '', 'g') like ${phone}` : undefined,
  );
}

const registrationWhere = (filter: RegistrationFilter) =>
  and(
    filter.type ? eq(courses.type, filter.type) : undefined,
    filter.status ? eq(registrations.status, filter.status) : undefined,
    filter.ids ? (filter.ids.length ? inArray(registrations.id, filter.ids) : sql`false`) : undefined,
    filter.clientId !== undefined ? eq(registrations.clientId, filter.clientId) : undefined,
    filter.courseId !== undefined ? eq(registrations.courseId, filter.courseId) : undefined,
    filter.sessionId !== undefined ? eq(registrations.courseSessionId, filter.sessionId) : undefined,
    registrationSearch(filter.search),
  );

/** Registrations with their course and session, newest first. `type` filters by the course type. */
export async function listRegistrations(db: Db, filter: RegistrationFilter = {}, range?: Range): Promise<RegistrationRow[]> {
  const q = db
    .select({ registration: registrations, course: courses, courseSession: courseSessions })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
    .where(registrationWhere(filter))
    .orderBy(desc(registrations.createdAt), desc(registrations.id));
  const rows = await (range ? q.limit(range.limit).offset(range.offset) : q);
  return rows.map((r) => ({ ...r.registration, course: r.course, courseSession: r.courseSession }));
}

export async function countRegistrations(db: Db, filter: RegistrationFilter = {}): Promise<number> {
  const [{ n }] = await db.select({ n: count() }).from(registrations).innerJoin(courses, eq(registrations.courseId, courses.id)).where(registrationWhere(filter));
  return Number(n);
}

/**
 * The status pills of the registrations list with their counts (A2): the keys are the words of the address (?staatus=). The form pills carry no
 * count (README A2 gives counts on the status pills only).
 */
export type RegistrationCounts = { status: Record<"all" | "ootab" | "kinnitatud" | "tuhistatud", number> };

const STATUS_KEY = { awaiting_prepayment: "ootab", confirmed: "kinnitatud", cancelled: "tuhistatud" } as const satisfies Record<RegStatus, string>;

/**
 * The counts on the status pills of the registrations list (admin UX pass B9): they count under every other filter (the search, the scope, the
 * form) and ignore the status chosen now, so a pill's count is the number of rows the list shows once that pill is chosen.
 */
export async function registrationCounts(db: Db, filter: RegistrationFilter = {}): Promise<RegistrationCounts> {
  const byStatus = await db
    .select({ key: registrations.status, n: count() })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .where(registrationWhere({ ...filter, status: undefined }))
    .groupBy(registrations.status);
  const counts: RegistrationCounts = { status: { all: 0, ootab: 0, kinnitatud: 0, tuhistatud: 0 } };
  for (const row of byStatus) {
    counts.status[STATUS_KEY[row.key]] = Number(row.n);
    counts.status.all += Number(row.n);
  }
  return counts;
}

/** One page of registrations (newest first), PAGE_SIZE rows. */
export async function pageRegistrations(db: Db, filter: RegistrationFilter, page: number, size: number = PAGE_SIZE): Promise<Paged<RegistrationRow>> {
  return paged(page, size, () => countRegistrations(db, filter), (range) => listRegistrations(db, filter, range));
}

/** One registration with its course and session, or null. */
export async function getRegistration(db: Db, id: number): Promise<RegistrationRow | null> {
  const [row] = await db
    .select({ registration: registrations, course: courses, courseSession: courseSessions })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
    .where(eq(registrations.id, id))
    .limit(1);
  return row ? { ...row.registration, course: row.course, courseSession: row.courseSession } : null;
}

/**
 * What a payment did to a registration (server/payments/settle.ts, „Märgi tasutuks“, „Lisa laekumine“). `full`: paid, but kept unconfirmed
 * for want of a seat (D2).
 */
export type RegistrationPaid = { registration: Registration; course: Course; session: CourseSession | null; wasConfirmed: boolean; full: boolean };

/**
 * A payment of `cents` arrived for a registration — online (phase 2b, spec 6.2.2), by Maria's „Märgi tasutuks“ on an invoice, or by her
 * „Lisa laekumine“ (admin UX pass B4: the typed absolute „Laekunud summa“ is gone, so every write of the paid sum adds or takes back):
 * `paidCents` becomes the current value + `cents` — an absolute value written under the row's lock (FOR UPDATE) — and the status follows the
 * payments rule (confirmed from 50 %), but a payment never takes a confirmed place back: Maria may have confirmed it by hand with less paid. One
 * exception (D2): a registration that is not confirmed yet stays awaiting_prepayment when its session has
 * no free seat for it, counting the others' seats, confirmed or held, but not her own row (her hold may have ended): `full` says so. A
 * confirmed registration, or one kept for want of a seat, has no hold any more. Runs in the caller's transaction; null: the row is gone.
 * The caller has taken lockForPayment (db/queries/seats.ts: the session, then the registration) before anything else, so that the seats
 * counted here are counted under the session's lock; the FOR UPDATE below is then a lock it already has.
 */
export async function addRegistrationPayment(tx: Tx, registrationId: number, cents: number, now: Date): Promise<RegistrationPaid | null> {
  const [current] = await tx
    .select({ registration: registrations, course: courses, session: courseSessions })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
    .where(eq(registrations.id, registrationId))
    .for("update", { of: registrations });
  if (!current) return null;
  const { registration: r, course, session } = current;
  const paidCents = r.paidCents + cents;
  const total = registrationPrice(course, r.kind);
  const wasConfirmed = r.status === "confirmed";
  let status = wasConfirmed || total == null ? r.status : registrationStatusAfterPayment({ status: r.status, paidCents }, total);
  let full = false;
  if (!wasConfirmed && status === "confirmed" && session && !(await hasFreeSeat(tx, session, now, r.id))) {
    status = r.status;
    full = true;
  }
  const endHold = full || status === "confirmed";
  const [row] = await tx
    .update(registrations)
    .set({ paidCents, status, ...(endHold ? { seatHoldUntil: null } : {}) })
    .where(eq(registrations.id, registrationId))
    .returning();
  return { registration: row, course, session, wasConfirmed, full };
}

export type RequestKind = RequestRow["kind"];
/** Which requests a list holds: one kind, the open or the done ones, the ones a search finds. Each part left out is not asked. */
export type RequestFilter = { kind?: RequestKind; handled?: boolean; search?: string };

/**
 * The search of Päringud (README A7, B7): the name, the e-mail address or the message of the request holds the text (ILIKE, `%` `_` `\` escaped:
 * containsPattern), or the digits of its phone hold the text's digits (domain/search.ts: from 3 digits, so „+372 5555 0103“ finds „5555-0103“). A change
 * request (Muutmine) has only an address and a message of its own, and its card is named by the registration it is about: that registration's name,
 * address and phone are searched too. (The registration is matched by the text of the stored id, so a payload whose registrationId is no plain number
 * matches nothing instead of failing the query.)
 */
function requestSearch(db: Db, search: string | undefined): SQL | undefined {
  const q = parseSearch(search);
  if (!q) return undefined;
  const text = containsPattern(q);
  const phone = phoneQuery(q);
  const digitsLike = (column: SQL | typeof registrations.phone) => sql`regexp_replace(${column}, '[^0-9]', '', 'g') like ${phone}`;
  const registration = db
    .select({ one: sql`1` })
    .from(registrations)
    .where(
      and(
        sql`${registrations.id}::text = ${requests.payload}->>'registrationId'`,
        or(ilike(registrations.name, text), ilike(registrations.email, text), phone ? digitsLike(registrations.phone) : undefined),
      ),
    );
  return or(
    ilike(sql`${requests.payload}->>'name'`, text),
    ilike(sql`${requests.payload}->>'email'`, text),
    ilike(sql`${requests.payload}->>'message'`, text),
    phone ? digitsLike(sql`${requests.payload}->>'phone'`) : undefined,
    and(eq(requests.kind, "change_request"), exists(registration)),
  );
}

const requestWhere = (db: Db, f: RequestFilter) =>
  and(f.kind ? eq(requests.kind, f.kind) : undefined, f.handled === undefined ? undefined : eq(requests.handled, f.handled), requestSearch(db, f.search));

/** Requests newest first, optionally of one kind, one state or the ones a search finds. */
export async function listRequests(db: Db, kind?: RequestRow["kind"], opts: { handled?: boolean; search?: string; range?: Range } = {}): Promise<RequestRow[]> {
  const q = db
    .select()
    .from(requests)
    .where(requestWhere(db, { kind, handled: opts.handled, search: opts.search }))
    .orderBy(desc(requests.createdAt), desc(requests.id));
  return opts.range ? q.limit(opts.range.limit).offset(opts.range.offset) : q;
}

export async function countRequests(db: Db, filter: RequestFilter = {}): Promise<number> {
  const [{ n }] = await db.select({ n: count() }).from(requests).where(requestWhere(db, filter));
  return Number(n);
}

/**
 * One page of Päringud's open requests (`handled: false`, the cards) or done ones (`handled: true`, the fold „Tehtud ({n})“): newest first, 50 a page (`size`).
 * With a `search`, `kind` is ignored: the search looks in every tab.
 */
export async function pageRequests(db: Db, filter: { kind?: RequestKind; search?: string; handled: boolean; page: number }, size: number = PAGE_SIZE): Promise<Paged<RequestRow>> {
  const where: RequestFilter = { kind: parseSearch(filter.search) ? undefined : filter.kind, handled: filter.handled, search: filter.search };
  return paged(filter.page, size, () => countRequests(db, where), (range) => listRequests(db, where.kind, { handled: where.handled, search: where.search, range }));
}

export async function markRequestHandled(db: Db, id: number): Promise<RequestRow | null> {
  return setRequestHandled(db, id, true);
}

/** "Märgi tehtuks" / "Märgi tegemata". Returns null when the id does not exist. */
export async function setRequestHandled(db: Db, id: number, handled: boolean): Promise<RequestRow | null> {
  const [row] = await db.update(requests).set({ handled }).where(eq(requests.id, id)).returning();
  return row ?? null;
}

/**
 * "Märgi tehtuks" / "Märgi tegemata" / "Võta tagasi" of Päringud: sets `handled` only while the request is still what the screen showed, in one
 * UPDATE ... WHERE, so it cannot overwrite a change it did not see. `expected` is the `handled` the card showed. `version` (the UndoBar's undo) is the
 * version the marking left: the row's xmin, the transaction that wrote it. An undo goes back only while that marking is still the last write: a request
 * that another tab reopened and marked done again has the same `handled` and another version, and is a newer change. The answer carries the version this
 * write left. `stale`: the request is not as the screen showed (nothing written); `notFound`: it is gone.
 */
export async function changeRequestHandled(
  db: Db,
  id: number,
  handled: boolean,
  expected: boolean,
  version?: string,
): Promise<{ ok: true; version: string } | { ok: false; error: "stale" | "notFound" }> {
  // (The cast: on the Db union, returning(fields) has no common overload.)
  const [row] = await (db as unknown as PostgresJsDatabase<typeof schema>)
    .update(requests)
    .set({ handled })
    .where(and(eq(requests.id, id), eq(requests.handled, expected), version === undefined ? undefined : sql`${requests}.xmin::text = ${version}`))
    .returning({ version: sql<string>`${requests}.xmin::text` });
  if (row) return { ok: true, version: row.version };
  const [there] = await db.select({ id: requests.id }).from(requests).where(eq(requests.id, id)).limit(1);
  return { ok: false, error: there ? "stale" : "notFound" };
}

export type AdminCounts = {
  /** Registrations still waiting for their prepayment (the new ones Maria has to look at). */
  awaitingPrepayment: number;
  /** Requests not marked handled, per kind. */
  openRequests: Record<RequestKind, number>;
  subscribers: number;
  confirmedSubscribers: number;
  /** What waits in Hindamine (e-course completion, spec §5.2): practical work to assess, open answers to review, students out of tries. */
  assessment: number;
  /** The scheduled sessions on today's Tallinn date, earliest first: „Täna“ in the menu (admin UX pass, B6). */
  todaySessions: { id: number; startsAt: Date; course: string }[];
  /** Reviews waiting for „Avalda“ (Tagasiside's menu badge). */
  waitingReviews: number;
  /** What „Maksed ja arved“ asks Maria to look at (spec S7): paid payments no invoice names, `held` ones, and ones voided after they were paid. */
  paymentsAttention: number;
  /** The signed-in admin's own standing „Viga“ answers on the test page (Testimine's menu badge). */
  ownFaults: number;
};

/**
 * Every count at zero and no session today: what the menu paints when the numbers could not be read (components/admin/Shell.tsx), so that a
 * failing count cannot take the whole admin down with it. A fresh object on every call.
 */
export function emptyCounts(): AdminCounts {
  return {
    awaitingPrepayment: 0,
    openRequests: { contact: 0, individual: 0, practice: 0, waitlist: 0, change_request: 0 },
    subscribers: 0,
    confirmedSubscribers: 0,
    assessment: 0,
    todaySessions: [],
    waitingReviews: 0,
    paymentsAttention: 0,
    ownFaults: 0,
  };
}

/** Requests not marked handled, per kind: the menu badge's number and the tabs' of Päringud. */
async function openRequestsByKind(db: Db): Promise<Record<RequestKind, number>> {
  const byKind = await db.select({ kind: requests.kind, n: count() }).from(requests).where(eq(requests.handled, false)).groupBy(requests.kind);
  const open = emptyCounts().openRequests;
  for (const row of byKind) open[row.kind] = Number(row.n);
  return open;
}

/** The open requests of each tab of Päringud (the e-learning interest is a Kontakt request): the numbers on the tabs, which are the menu badge's. */
export async function requestCounts(db: Db): Promise<Record<TabKey, number>> {
  const open = await openRequestsByKind(db);
  return Object.fromEntries(REQUEST_TABS.map((tab) => [tab, open[TAB_KIND[tab]]])) as Record<TabKey, number>;
}

/**
 * The numbers of the menu badges (and Päringud's and Uudiskiri's counts), for the admin `email` at `now`: each count is one query, all read together. The test page's
 * answers are one settings row, read by server/testplan.ts ownFaultCount.
 */
export async function adminCounts(db: Db, email: string, now: Date): Promise<AdminCounts> {
  const [[awaiting], openRequests, [subs], assessment, today, [waiting], [attention], ownFaults] = await Promise.all([
    db.select({ n: count() }).from(registrations).where(eq(registrations.status, "awaiting_prepayment")),
    openRequestsByKind(db),
    db.select({ total: count(), confirmed: count(subscribers.confirmedAt) }).from(subscribers),
    assessmentCount(db),
    todaySessions(db, now),
    // (the number of the Tagasiside heading: server/reviews.ts pendingReviewCount)
    db.select({ n: count() }).from(reviews).where(eq(reviews.status, "pending")),
    // (payment-checks.ts: the unbilled paid payments, the held ones and the ones voided after they were paid)
    db.select({ n: count() }).from(payments).where(NEEDS_ATTENTION),
    ownFaultCount(db, email),
  ]);
  return {
    awaitingPrepayment: Number(awaiting.n),
    openRequests,
    subscribers: Number(subs.total),
    confirmedSubscribers: Number(subs.confirmed),
    assessment,
    todaySessions: today.map((s) => ({ id: s.id, startsAt: s.startsAt, course: pick(s.title, "et") })),
    waitingReviews: Number(waiting.n),
    paymentsAttention: Number(attention.n),
    ownFaults,
  };
}

/** Course names for the request inbox (requests store the course slug). Drafts included. */
export async function listCourseNames(db: Db): Promise<Pick<Course, "id" | "slug" | "title" | "type">[]> {
  return db.select({ id: courses.id, slug: courses.slug, title: courses.title, type: courses.type }).from(courses);
}

/** A course and its sessions, one entry of the registrations list's scope select (A2). */
export type RegistrationScope = { course: { id: number; title: I18n }; sessions: { id: number; startsAt: Date; city: string }[] };

/**
 * What the registrations list's scope select offers: every course in the admin's order, drafts and e-courses too, each with all its sessions
 * (cancelled ones too: they can hold registrations). The sessions from the Tallinn day of `now` on come first, nearest first, then the past
 * ones, newest first: what Maria looks for is mostly ahead of her, and the old ones pile up behind.
 */
export async function listRegistrationScopes(db: Db, now: Date): Promise<RegistrationScope[]> {
  const [list, sessions] = await Promise.all([
    db.select({ id: courses.id, title: courses.title }).from(courses).orderBy(asc(courses.sort), asc(courses.id)),
    db.select({ id: courseSessions.id, courseId: courseSessions.courseId, startsAt: courseSessions.startsAt, city: courseSessions.city }).from(courseSessions),
  ]);
  const from = startOfDayTallinn(now).getTime();
  const order = (a: Date, b: Date) => {
    const [x, y] = [a.getTime(), b.getTime()];
    if (x >= from !== y >= from) return x >= from ? -1 : 1;
    return x >= from ? x - y : y - x;
  };
  return list.map((course) => ({
    course,
    sessions: sessions
      .filter((s) => s.courseId === course.id)
      .sort((a, b) => order(a.startsAt, b.startsAt) || a.id - b.id)
      .map(({ id, startsAt, city }) => ({ id, startsAt, city })),
  }));
}

/** Sessions by id (the waitlist requests store the session id). */
export async function listSessionsByIds(db: Db, ids: number[]): Promise<CourseSession[]> {
  if (ids.length === 0) return [];
  return db.select().from(courseSessions).where(inArray(courseSessions.id, ids));
}

// ---------- practice, home, content ----------

export async function upsertPracticePackage(db: Db, input: PracticePackageInput): Promise<PracticePackage> {
  const [row] = await db.insert(practicePackages).values(input).onConflictDoUpdate({ target: practicePackages.code, set: input }).returning();
  return row;
}

export async function upsertHeroSlide(db: Db, input: HeroSlideInput): Promise<HeroSlide> {
  const { id, ...fields } = input;
  if (id != null) {
    const [row] = await db.update(heroSlides).set(fields).where(eq(heroSlides.id, id)).returning();
    return required(row, "Hero slide", id);
  }
  const [row] = await db.insert(heroSlides).values(fields).returning();
  return row;
}

export async function deleteHeroSlide(db: Db, id: number): Promise<void> {
  await db.delete(heroSlides).where(eq(heroSlides.id, id));
}

export async function upsertFaq(db: Db, input: FaqInput): Promise<FaqItem> {
  const { id, ...fields } = input;
  if (id != null) {
    const [row] = await db.update(faq).set(fields).where(eq(faq.id, id)).returning();
    return required(row, "FAQ item", id);
  }
  const [row] = await db.insert(faq).values(fields).returning();
  return row;
}

export async function deleteFaq(db: Db, id: number): Promise<void> {
  await db.delete(faq).where(eq(faq.id, id));
}

/** Every post, drafts included, newest first (the admin list; the public listPosts stays published-only). */
export async function listAllPosts(db: Db): Promise<Post[]> {
  return db.select().from(posts).orderBy(desc(posts.publishedAt), desc(posts.id));
}

/** Creates or updates a post (by `id` when given, otherwise by unique `slug`). */
export async function upsertPost(db: Db, input: PostInput): Promise<Post> {
  const { id, ...fields } = input;
  if (id != null) {
    const [row] = await db.update(posts).set(fields).where(eq(posts.id, id)).returning();
    return required(row, "Post", id);
  }
  const [row] = await db.insert(posts).values(fields).onConflictDoUpdate({ target: posts.slug, set: fields }).returning();
  return row;
}

/** Creates or updates a text page by its key (inside a transaction too). */
export async function upsertPage(db: Q, input: PageInput): Promise<Page> {
  const [row] = await db.insert(pages).values(input).onConflictDoUpdate({ target: pages.key, set: input }).returning();
  return row;
}

/**
 * Replaces the images of one gallery group; order of `items` becomes the display order. One transaction (a savepoint
 * inside the caller's when `db` already is one).
 */
export async function replaceGallery(db: Q, group: string, items: ImageInput[]): Promise<GalleryItem[]> {
  return (db as Db).transaction(async (tx) => {
    await tx.delete(galleryItems).where(eq(galleryItems.group, group));
    if (items.length === 0) return [];
    return tx
      .insert(galleryItems)
      .values(items.map((item, i) => ({ group, key: item.key, alt: item.alt ?? null, sort: i })))
      .returning();
  });
}

/**
 * A popup's fixed row (POPUP_ID: the campaign 1, the newsletter popup 2): one row per kind. At most one popup is shown (the partial
 * unique index campaign_one_active): switching one on switches the other off first, in the caller's transaction.
 */
export async function upsertCampaign(db: Q, input: CampaignInput, kind: PopupKind = "campaign"): Promise<Campaign> {
  const id = POPUP_ID[kind];
  if (input.active) await db.update(campaign).set({ active: false }).where(and(ne(campaign.id, id), eq(campaign.active, true)));
  const [row] = await db.insert(campaign).values({ ...input, id, kind }).onConflictDoUpdate({ target: campaign.id, set: { ...input, kind } }).returning();
  return row;
}

export async function setSetting(db: Q, key: string, value: unknown): Promise<void> {
  await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

/** Newsletter subscribers, newest consent first; the whole list unless a range is given (the CSV export takes all). */
export async function listSubscribers(db: Db, range?: Range): Promise<Subscriber[]> {
  const q = db.select().from(subscribers).orderBy(desc(subscribers.consentAt), desc(subscribers.id));
  return range ? q.limit(range.limit).offset(range.offset) : q;
}

export async function countSubscribers(db: Db): Promise<number> {
  const [{ n }] = await db.select({ n: count() }).from(subscribers);
  return Number(n);
}

/** One page of the subscriber list. */
export async function pageSubscribers(db: Db, page: number, size: number = PAGE_SIZE): Promise<Paged<Subscriber>> {
  return paged(page, size, () => countSubscribers(db), (range) => listSubscribers(db, range));
}
