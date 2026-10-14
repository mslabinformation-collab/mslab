import { and, asc, count, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type { Db, Q, Tx } from "../client";
import { campaign, courseAccess, courseImages, courseModules, courseSessions, courses, courseTests, faq, galleryItems, heroSlides, lessons, pages, POPUP_ID, posts, practicePackages, registrations, requests, settings, subscribers } from "../schema";
import type { Campaign, Course, CourseImage, CourseSession, CourseTest, FaqItem, GalleryItem, HeroSlide, Page, PopupKind, Post, PracticePackage, Registration, Request as RequestRow, Subscriber, TestQuestion } from "../schema";
import { pageInfo, PAGE_SIZE, type PageInfo } from "@/domain/paging";
import { registrationPrice, registrationStatusAfterPayment, type RegStatus } from "@/domain/registration";
import type { I18n } from "@/i18n/field";
import { assessmentCount } from "./assessment";
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
/** `ids`: only these registrations; `clientId`: only the ones linked to that client (the admin's Õpilased drawer). */
export type RegistrationFilter = { type?: "e_learning" | "contact"; status?: RegStatus; ids?: number[]; clientId?: number };

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

const imageOrder = [asc(courseImages.sort), asc(courseImages.id)];

/** Every course, drafts included, in the public order (sort, then id), with its images. */
export async function listAllCourses(db: Db): Promise<AdminCourse[]> {
  return db.query.courses.findMany({ orderBy: [asc(courses.sort), asc(courses.id)], with: { images: { orderBy: imageOrder } } });
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

/** Is `slug` used by a course other than `exceptId`? */
export async function isSlugTaken(db: Db, slug: string, exceptId?: number): Promise<boolean> {
  const [row] = await db
    .select({ id: courses.id })
    .from(courses)
    .where(and(eq(courses.slug, slug), exceptId != null ? ne(courses.id, exceptId) : undefined))
    .limit(1);
  return row !== undefined;
}

/** A stored course's type and how many sessions and registrations point to it (a type change is refused then). */
export type CourseUsage = { type: Course["type"]; sessions: number; registrations: number; lessons: number; access: number };

export async function courseUsage(db: Db, id: number): Promise<CourseUsage | null> {
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
/** The course fields the editor writes (everything but id, sort and updatedAt), and the e-course's test (null: none, its row is deleted). */
export type CourseFields = Omit<CourseInput, "id" | "sort"> & { test: CourseTestFields | null };

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

/** Moves a course one place up (-1) or down (+1) in the public order; renumbers all sorts 1…n. False when it cannot move. */
export async function moveCourse(db: Db, id: number, dir: -1 | 1): Promise<boolean> {
  return db.transaction(async (tx) => {
    const list = await tx.select({ id: courses.id }).from(courses).orderBy(asc(courses.sort), asc(courses.id)).for("update");
    const i = list.findIndex((c) => c.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return false;
    [list[i], list[j]] = [list[j], list[i]];
    for (const [n, c] of list.entries()) await tx.update(courses).set({ sort: n + 1 }).where(eq(courses.id, c.id));
    return true;
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

/** A slice of a list: `limit` rows from `offset` on. Without one the whole list is returned (the CSV export). */
export type Range = { limit: number; offset: number };
/** One page of an admin list: its rows and where it is (page, pages, total). */
export type Paged<T> = PageInfo & { rows: T[] };

/**
 * Page `requested` (clamped to 1…last) of a list. The count and the rows are read together; only when the requested
 * page lies beyond the end (an old link, a typed ?leht=) are the rows of the last page read once more.
 */
export async function paged<T>(requested: number, size: number, total: () => Promise<number>, rows: (range: Range) => Promise<T[]>): Promise<Paged<T>> {
  const guess = pageInfo(requested, Number.POSITIVE_INFINITY, size);
  const [n, first] = await Promise.all([total(), rows({ limit: size, offset: guess.offset })]);
  const info = pageInfo(requested, n, size);
  return { ...info, rows: info.offset === guess.offset ? first : await rows({ limit: size, offset: info.offset }) };
}

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

const registrationWhere = (filter: RegistrationFilter) =>
  and(
    filter.type ? eq(courses.type, filter.type) : undefined,
    filter.status ? eq(registrations.status, filter.status) : undefined,
    filter.ids ? (filter.ids.length ? inArray(registrations.id, filter.ids) : sql`false`) : undefined,
    filter.clientId !== undefined ? eq(registrations.clientId, filter.clientId) : undefined,
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
 * Maria enters the amount that has arrived (bank transfer): stores `paidCents` and recomputes the status against the
 * price of the registration (group or individual price; e-learning price) — confirmed from 50% (Maria's rule), back
 * to awaiting_prepayment below it, cancelled stays cancelled. Without a price the status is left as it is.
 * Returns null when the id does not exist.
 */
export async function recordRegistrationPayment(db: Db, id: number, paidCents: number): Promise<Registration | null> {
  // One transaction with the registration row locked (FOR UPDATE): a cancel or status change saved at the same moment
  // either happens before (and is seen here) or waits until this is done; it is never overwritten with a stale status.
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ registration: registrations, course: courses })
      .from(registrations)
      .innerJoin(courses, eq(registrations.courseId, courses.id))
      .where(eq(registrations.id, id))
      .for("update", { of: registrations });
    if (!current) return null;
    const { registration: r, course } = current;
    const total = registrationPrice(course, r.kind);
    const status = total == null ? r.status : registrationStatusAfterPayment({ status: r.status, paidCents }, total);
    const [row] = await tx.update(registrations).set({ paidCents, status }).where(eq(registrations.id, id)).returning();
    return row ?? null;
  });
}

/** What an online payment did to a registration (server/payments/settle.ts). `full`: paid, but kept unconfirmed for want of a seat (D2). */
export type RegistrationPaid = { registration: Registration; course: Course; session: CourseSession | null; wasConfirmed: boolean; full: boolean };

/**
 * An online payment of `cents` arrived for a registration (phase 2b, spec 6.2.2): `paidCents` becomes the current value + `cents` — an
 * absolute value written under the row's lock (FOR UPDATE), as recordRegistrationPayment writes Maria's — and the status follows the same
 * rule (confirmed from 50 %), but a payment never takes a confirmed place back: Maria may have confirmed it by hand with less paid. One
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

/** Requests newest first, optionally of one kind. `openFirst`: not handled ones before handled ones (the inbox). */
export async function listRequests(db: Db, kind?: RequestRow["kind"], opts: { openFirst?: boolean; range?: Range } = {}): Promise<RequestRow[]> {
  const q = db
    .select()
    .from(requests)
    .where(kind ? eq(requests.kind, kind) : undefined)
    .orderBy(...(opts.openFirst ? [asc(requests.handled)] : []), desc(requests.createdAt), desc(requests.id));
  return opts.range ? q.limit(opts.range.limit).offset(opts.range.offset) : q;
}

export async function countRequests(db: Db, kind?: RequestRow["kind"]): Promise<number> {
  const [{ n }] = await db.select({ n: count() }).from(requests).where(kind ? eq(requests.kind, kind) : undefined);
  return Number(n);
}

/** One page of the request inbox of one kind: open requests first, each group newest first. */
export async function pageRequests(db: Db, kind: RequestRow["kind"], page: number, size: number = PAGE_SIZE): Promise<Paged<RequestRow>> {
  return paged(page, size, () => countRequests(db, kind), (range) => listRequests(db, kind, { openFirst: true, range }));
}

export async function markRequestHandled(db: Db, id: number): Promise<RequestRow | null> {
  return setRequestHandled(db, id, true);
}

/** "Märgi tehtuks" / "Märgi tegemata". Returns null when the id does not exist. */
export async function setRequestHandled(db: Db, id: number, handled: boolean): Promise<RequestRow | null> {
  const [row] = await db.update(requests).set({ handled }).where(eq(requests.id, id)).returning();
  return row ?? null;
}

export type RequestKind = RequestRow["kind"];
export type AdminCounts = {
  /** Registrations still waiting for their prepayment (the new ones Maria has to look at). */
  awaitingPrepayment: number;
  /** Requests not marked handled, per kind. */
  openRequests: Record<RequestKind, number>;
  /** Of the open contact requests: e-learning purchase interest (cart "let me know"). */
  openPurchaseInterest: number;
  subscribers: number;
  confirmedSubscribers: number;
  /** What waits in Hindamine (e-course completion, spec §5.2): practical work to assess, open answers to review, students out of tries. */
  assessment: number;
};

/** The numbers of the overview and the menu badges. */
export async function adminCounts(db: Db): Promise<AdminCounts> {
  const [[awaiting], byKind, [interest], [subs], assessment] = await Promise.all([
    db.select({ n: count() }).from(registrations).where(eq(registrations.status, "awaiting_prepayment")),
    db.select({ kind: requests.kind, n: count() }).from(requests).where(eq(requests.handled, false)).groupBy(requests.kind),
    db
      .select({ n: count() })
      .from(requests)
      .where(and(eq(requests.kind, "contact"), eq(requests.handled, false), sql`${requests.payload}->>'intent' = 'purchase'`)),
    db.select({ total: count(), confirmed: count(subscribers.confirmedAt) }).from(subscribers),
    assessmentCount(db),
  ]);
  const openRequests: Record<RequestKind, number> = { contact: 0, individual: 0, practice: 0, waitlist: 0, change_request: 0 };
  for (const row of byKind) openRequests[row.kind] = Number(row.n);
  return {
    awaitingPrepayment: Number(awaiting.n),
    openRequests,
    openPurchaseInterest: Number(interest.n),
    subscribers: Number(subs.total),
    confirmedSubscribers: Number(subs.confirmed),
    assessment,
  };
}

/** Course names for the request inbox (requests store the course slug). Drafts included. */
export async function listCourseNames(db: Db): Promise<Pick<Course, "id" | "slug" | "title" | "type">[]> {
  return db.select({ id: courses.id, slug: courses.slug, title: courses.title, type: courses.type }).from(courses);
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
