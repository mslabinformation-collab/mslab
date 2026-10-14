import { and, asc, count, desc, eq, gte, isNotNull, lt, lte, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  clients, courseAccess, courseFeedback, courses, courseSessions, practicalPhotos, protocols, registrations,
  type CourseSession, type Protocol, type ProtocolStage, type Registration, type Verdict,
} from "../schema";
import { tallinnFormParts } from "@/domain/calendar";
import { practicalStatus, type PracticalStatus } from "@/domain/completion";
import { PAGE_SIZE } from "@/domain/paging";
import {
  protocolStatus, readStages, stagesFrom, summarizeFeedback,
  type AssessmentView, type FeedbackAnswers, type FeedbackSummary, type ProtocolStatus, type ScreenStudentView,
} from "@/domain/protocols";
import type { RegStatus } from "@/domain/registration";
import type { I18n } from "@/i18n/field";
import { paged, type Paged } from "./admin";

// The protocols' reads (phase protocols, spec §8): the course day's screen (Task 2), today's sessions (Task 5), the student's page (Task 7) and
// the admin's feedback page (Task 9). Phase e-course completion: the screen of one e-course access, with its practical work (Maria's assessment).
// Callers have checked the session (admin or client); nothing here does authorization.

/** A protocol as the screen edits it. `version` 0: none yet — the course's headings with empty notes. */
export type ProtocolDraft = {
  /** The protocol's row; null: none yet. One deleted (with the account) and made again is another row, even at the same version. */
  id: number | null;
  version: number;
  stages: ProtocolStage[];
  generalNote: string;
  sentVersion: number | null;
  sentAt: Date | null;
  /** The last saved change; null before the first. */
  updatedAt: Date | null;
};

/** The draft of a stored protocol, or of none yet with the course's `headings`. */
export function draftOf(row: Protocol | null, headings: readonly string[]): ProtocolDraft {
  if (!row) return { id: null, version: 0, stages: stagesFrom(headings), generalNote: "", sentVersion: null, sentAt: null, updatedAt: null };
  return { id: row.id, version: row.version, stages: row.stages, generalNote: row.generalNote, sentVersion: row.sentVersion, sentAt: row.sentAt, updatedAt: row.updatedAt };
}

export type ScreenStudent = { registrationId: number; name: string; status: RegStatus; protocol: ProtocolDraft; state: ProtocolStatus };

/** One submitted photo of a point: its files are GET /api/admin/foto/<id> and, the thumbnail, ?v=pisi (app/api/admin/foto/[id]). */
export type AssessmentPhoto = { id: number; round: number; width: number; height: number };

/** An e-course access's practical work on Maria's screen (domain/protocols.ts AssessmentView is the same with its dates as text). */
export type AssessmentData = {
  accessId: number;
  clientId: number;
  email: string;
  status: PracticalStatus;
  /** The student's submissions so far (0: none yet). */
  round: number;
  submittedAt: Date | null;
  /** The draft's, one per point (null: none yet), each saved by its tap (server/assessment.ts saveVerdict, R2). */
  verdicts: (Verdict | null)[];
  /** The copy last sent's, one per point; null before the first send. */
  sentVerdicts: (Verdict | null)[] | null;
  /** Per point: the photos of the rounds submitted (round ≤ `round`), newest round first; never those of the round being prepared. */
  photos: AssessmentPhoto[][];
  /** Every point approved and sent (status passed): the verdicts are locked, the notes can still change and go again (spec §8). */
  locked: boolean;
  /** When the access ends: an ended one is still assessed (spec §8); its student cannot send again until Maria extends it. */
  expiresAt: Date;
};

/**
 * The protocol screen (phase protocols, spec §4; phase e-course completion, spec §5.3): "session" lists every registration of one session that
 * is not cancelled (confirmed, and awaiting the prepayment), "registration" one registration (an individual course), "access" one e-course
 * access (Maria's assessment of its practical work). `hidden`: the cancelled ones left out. `assessment`: the access's practical work; null for
 * the course day's kinds.
 */
export type ScreenData = {
  kind: "session" | "registration" | "access";
  course: { id: number; title: I18n };
  session: { id: number; startsAt: Date; city: string; venue: string; cancelled: boolean } | null;
  students: ScreenStudent[];
  hidden: number;
  assessment: AssessmentData | null;
};

/** The screen's students for the browser (the page's props, and GET /api/admin/protokoll's answer): every date as text; an access's with its practical work. */
export function screenStudents(screen: ScreenData): ScreenStudentView[] {
  const assessment = screen.assessment ? assessmentView(screen.assessment) : null;
  return screen.students.map((s) => ({
    registrationId: s.registrationId,
    protocolId: s.protocol.id,
    name: s.name,
    awaiting: s.status === "awaiting_prepayment",
    version: s.protocol.version,
    titles: s.protocol.stages.map((x) => x.title),
    notes: s.protocol.stages.map((x) => x.note),
    generalNote: s.protocol.generalNote,
    sentVersion: s.protocol.sentVersion,
    sentAt: s.protocol.sentAt?.toISOString() ?? null,
    savedAt: s.protocol.updatedAt?.toISOString() ?? null,
    ...(assessment ? { assessment } : {}),
  }));
}

/** An access's practical work for the browser: its dates as text. */
const assessmentView = (a: AssessmentData): AssessmentView => ({ ...a, submittedAt: a.submittedAt?.toISOString() ?? null, expiresAt: a.expiresAt.toISOString() });

const courseFields = { id: courses.id, title: courses.title, type: courses.type, protocolStages: courses.protocolStages };
const sessionOf = (s: CourseSession) => ({ id: s.id, startsAt: s.startsAt, city: s.city, venue: s.venue, cancelled: s.status === "cancelled" });

function screenOf(
  kind: ScreenData["kind"],
  course: { id: number; title: I18n; protocolStages: string[] },
  session: ScreenData["session"],
  rows: { registration: Registration; protocol: Protocol | null }[],
): ScreenData {
  const headings = readStages(course.protocolStages);
  const listed = rows.filter((r) => r.registration.status !== "cancelled");
  const students = listed
    .map((r) => ({ registrationId: r.registration.id, name: r.registration.name, status: r.registration.status, protocol: draftOf(r.protocol, headings), state: protocolStatus(r.protocol) }))
    .sort((a, b) => a.name.localeCompare(b.name, "et") || a.registrationId - b.registrationId);
  return { kind, course: { id: course.id, title: course.title }, session, students, hidden: rows.length - listed.length, assessment: null };
}

/**
 * The screen of one session (`sessionId`: its students, a called-off session's too, for the record), of one registration, or of one e-course
 * access (`accessId`, Maria's assessment); null when there is no such session or registration of a contact course (protocols of the course day
 * are for contact courses only: spec assumption 1), or no such access to an e-course, or a revoked one (spec §8: not hers to assess any more).
 */
export async function protocolScreen(db: Db, target: { sessionId: number } | { registrationId: number } | { accessId: number }): Promise<ScreenData | null> {
  if ("accessId" in target) return accessScreen(db, target.accessId);
  if ("sessionId" in target) {
    const [s] = await db
      .select({ session: courseSessions, course: courseFields })
      .from(courseSessions)
      .innerJoin(courses, eq(courseSessions.courseId, courses.id))
      .where(eq(courseSessions.id, target.sessionId))
      .limit(1);
    if (!s || s.course.type !== "contact") return null;
    const rows = await db
      .select({ registration: registrations, protocol: protocols })
      .from(registrations)
      .leftJoin(protocols, eq(protocols.registrationId, registrations.id))
      .where(eq(registrations.courseSessionId, target.sessionId));
    return screenOf("session", s.course, sessionOf(s.session), rows);
  }
  const [r] = await db
    .select({ registration: registrations, protocol: protocols, course: courseFields, session: courseSessions })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
    .leftJoin(protocols, eq(protocols.registrationId, registrations.id))
    .where(eq(registrations.id, target.registrationId))
    .limit(1);
  if (!r || r.course.type !== "contact") return null;
  return screenOf("registration", r.course, r.session ? sessionOf(r.session) : null, [{ registration: r.registration, protocol: r.protocol }]);
}

/**
 * One e-course access's screen (spec §5.3): its student by her name (her address while she has none), her protocol's draft (the course's points
 * with empty notes while there is no protocol yet; its own copy after), and the practical work. An ended access is shown (Maria can still
 * assess); a revoked one is not. Reads only: nothing is created by looking.
 */
async function accessScreen(db: Db, accessId: number): Promise<ScreenData | null> {
  const [a] = await db
    .select({ access: courseAccess, client: { name: clients.name, email: clients.email }, course: courseFields, protocol: protocols })
    .from(courseAccess)
    .innerJoin(clients, eq(courseAccess.clientId, clients.id))
    .innerJoin(courses, eq(courseAccess.courseId, courses.id))
    .leftJoin(protocols, eq(protocols.accessId, courseAccess.id))
    .where(eq(courseAccess.id, accessId))
    .limit(1);
  if (!a || a.course.type !== "e_learning" || a.access.revokedAt !== null) return null;
  const p = a.protocol;
  const draft = draftOf(p, readStages(a.course.protocolStages));
  const photos: AssessmentPhoto[][] = draft.stages.map(() => []);
  if (p && p.round > 0) {
    const rows = await db
      .select({ id: practicalPhotos.id, stage: practicalPhotos.stage, round: practicalPhotos.round, width: practicalPhotos.width, height: practicalPhotos.height })
      .from(practicalPhotos)
      .where(and(eq(practicalPhotos.protocolId, p.id), lte(practicalPhotos.round, p.round))) // (the round being prepared is the student's, not sent yet)
      .orderBy(asc(practicalPhotos.stage), desc(practicalPhotos.round), asc(practicalPhotos.id));
    for (const r of rows) photos[r.stage]?.push({ id: r.id, round: r.round, width: r.width, height: r.height });
  }
  /** A stored list read along the points: one entry per point, null for none. */
  const along = (list: readonly (Verdict | null)[] | undefined) => draft.stages.map((_, i) => list?.[i] ?? null);
  const status = practicalStatus(p);
  return {
    kind: "access",
    course: { id: a.course.id, title: a.course.title },
    session: null,
    students: [{ registrationId: a.access.id, name: a.client.name.trim() || a.client.email, status: "confirmed", protocol: draft, state: protocolStatus(p) }],
    hidden: 0,
    assessment: {
      accessId: a.access.id,
      clientId: a.access.clientId,
      email: a.client.email,
      status,
      round: p?.round ?? 0,
      submittedAt: p?.submittedAt ?? null,
      verdicts: along(p?.verdicts),
      sentVerdicts: p?.sent ? along(p.sent.verdicts) : null,
      photos,
      locked: status === "passed",
      expiresAt: a.access.expiresAt,
    },
  };
}

// ---------- the overview's "Täna" (Task 5) ----------

/** One of today's sessions: its course, when and where, and how many students are listed on its screen (not cancelled). */
export type TodaySession = { id: number; startsAt: Date; city: string; venue: string; title: I18n; students: number };

/**
 * Today's sessions in Tallinn (spec §4: the overview's "Täna" card), scheduled ones of contact courses, earliest first. A window of two days
 * either side is read and each session's Tallinn date compared with today's: the same on the two days the clocks change.
 */
export async function todaySessions(db: Db, now: Date): Promise<TodaySession[]> {
  const DAY = 86_400_000;
  const rows = await db
    .select({
      id: courseSessions.id,
      startsAt: courseSessions.startsAt,
      city: courseSessions.city,
      venue: courseSessions.venue,
      title: courses.title,
      students: sql<number>`(select count(*) from registrations r where r.course_session_id = ${courseSessions.id} and r.status <> 'cancelled')`.mapWith(Number),
    })
    .from(courseSessions)
    .innerJoin(courses, eq(courseSessions.courseId, courses.id))
    .where(
      and(
        eq(courseSessions.status, "scheduled"),
        eq(courses.type, "contact"),
        gte(courseSessions.startsAt, new Date(now.getTime() - 2 * DAY)),
        lt(courseSessions.startsAt, new Date(now.getTime() + 2 * DAY)),
      ),
    )
    .orderBy(asc(courseSessions.startsAt), asc(courseSessions.id));
  const today = tallinnFormParts(now).date;
  return rows.filter((r) => tallinnFormParts(r.startsAt).date === today);
}

// ---------- the student's protocol (Task 7) ----------

/** What the student's page shows (spec §5): the course, its session, when it was sent, and the copy Maria sent. Dates as ISO strings (JSON). */
export type StudentProtocol = {
  course: { slug: string; title: I18n };
  session: { startsAt: string; city: string; venue: string } | null;
  sentAt: string;
  stages: ProtocolStage[];
  generalNote: string;
};

/**
 * The sent protocol of one of the client's own registrations (the dashboard's rule: registrations.client_id is hers), or null: not hers,
 * no protocol, or none sent yet. Only `sent`, the frozen copy, is read: never the draft.
 */
export async function studentProtocol(db: Db, clientId: number, registrationId: number): Promise<StudentProtocol | null> {
  const [r] = await db
    .select({ slug: courses.slug, title: courses.title, startsAt: courseSessions.startsAt, city: courseSessions.city, venue: courseSessions.venue, sent: protocols.sent, sentAt: protocols.sentAt })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .innerJoin(protocols, eq(protocols.registrationId, registrations.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
    .where(and(eq(registrations.id, registrationId), eq(registrations.clientId, clientId), isNotNull(protocols.sentAt)))
    .limit(1);
  if (!r || !r.sent || !r.sentAt) return null;
  return {
    course: { slug: r.slug, title: r.title },
    session: r.startsAt ? { startsAt: r.startsAt.toISOString(), city: r.city ?? "", venue: r.venue ?? "" } : null,
    sentAt: r.sentAt.toISOString(),
    stages: r.sent.stages,
    generalNote: r.sent.generalNote,
  };
}

// ---------- the admin's Tagasiside and the drawers (Task 9) ----------

/** One answered feedback form, for Maria (spec §7): who, which course and day, the answers as keys, the language she answered in, when. */
export type FeedbackRow = {
  id: number;
  registrationId: number;
  clientId: number | null;
  name: string;
  email: string;
  course: { id: number; title: I18n };
  startsAt: Date | null;
  answers: FeedbackAnswers;
  locale: "et" | "ru";
  submittedAt: Date;
};

/** An answer, not an "Ei soovi" (that row has no submitted_at). */
const ANSWERED = isNotNull(courseFeedback.submittedAt);

function feedbackRows(db: Db) {
  return db
    .select({
      id: courseFeedback.id,
      registrationId: courseFeedback.registrationId,
      clientId: registrations.clientId,
      name: registrations.name,
      email: registrations.email,
      courseId: courses.id,
      courseTitle: courses.title,
      startsAt: courseSessions.startsAt,
      answers: courseFeedback.answers,
      locale: courseFeedback.locale,
      submittedAt: courseFeedback.submittedAt,
    })
    .from(courseFeedback)
    .innerJoin(registrations, eq(courseFeedback.registrationId, registrations.id))
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id));
}

type FeedbackSelect = Awaited<ReturnType<typeof feedbackRows>>[number];

// (answers, locale and submitted_at are set together by the submit, server/course-feedback.ts; every read here has ANSWERED)
const toFeedbackRow = (r: FeedbackSelect): FeedbackRow => ({
  id: r.id,
  registrationId: r.registrationId,
  clientId: r.clientId,
  name: r.name,
  email: r.email,
  course: { id: r.courseId, title: r.courseTitle },
  startsAt: r.startsAt,
  answers: r.answers ?? {},
  locale: r.locale === "ru" ? "ru" : "et",
  submittedAt: r.submittedAt!,
});

const NEWEST = [desc(courseFeedback.submittedAt), desc(courseFeedback.id)] as const;

/** Tagasiside's list: the answers, newest first, `size` a page; `courseId` keeps one course's. */
export async function pageFeedback(db: Db, courseId: number | null, page: number, size: number = PAGE_SIZE): Promise<Paged<FeedbackRow>> {
  const where = courseId === null ? ANSWERED : and(ANSWERED, eq(registrations.courseId, courseId));
  return paged(
    page,
    size,
    async () => Number((await db.select({ n: count() }).from(courseFeedback).innerJoin(registrations, eq(courseFeedback.registrationId, registrations.id)).where(where))[0].n),
    async (range) => (await feedbackRows(db).where(where).orderBy(...NEWEST).limit(range.limit).offset(range.offset)).map(toFeedbackRow),
  );
}

/** One answer (the page's drawer, ?id=); null when there is none, or it is an "Ei soovi". */
export async function feedbackById(db: Db, id: number): Promise<FeedbackRow | null> {
  const [row] = await feedbackRows(db).where(and(ANSWERED, eq(courseFeedback.id, id))).limit(1);
  return row ? toFeedbackRow(row) : null;
}

/** The answers in a registration's drawer (at most one), or in a student's (those of her registrations), newest first. */
export async function feedbackOf(db: Db, of: { registrationId: number } | { clientId: number }): Promise<FeedbackRow[]> {
  const whose = "registrationId" in of ? eq(courseFeedback.registrationId, of.registrationId) : eq(registrations.clientId, of.clientId);
  return (await feedbackRows(db).where(and(ANSWERED, whose)).orderBy(...NEWEST)).map(toFeedbackRow);
}

/** A course's answers in numbers (domain/protocols.ts summarizeFeedback). */
export type CourseFeedbackStats = { course: { id: number; title: I18n }; summary: FeedbackSummary };

/**
 * Every course that has answers, by its Estonian title, with its numbers: the average score and the count of every option of every choice
 * question (spec §7). All the answered rows are read (a few hundred a year) and summed here.
 */
export async function feedbackStats(db: Db): Promise<CourseFeedbackStats[]> {
  const rows = await db
    .select({ courseId: courses.id, title: courses.title, answers: courseFeedback.answers })
    .from(courseFeedback)
    .innerJoin(registrations, eq(courseFeedback.registrationId, registrations.id))
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .where(ANSWERED);
  const byCourse = new Map<number, { title: I18n; answers: FeedbackAnswers[] }>();
  for (const r of rows) {
    const entry = byCourse.get(r.courseId) ?? { title: r.title, answers: [] };
    entry.answers.push(r.answers ?? {});
    byCourse.set(r.courseId, entry);
  }
  return [...byCourse]
    .map(([id, { title, answers }]) => ({ course: { id, title }, summary: summarizeFeedback(answers) }))
    .sort((x, y) => x.course.title.et.localeCompare(y.course.title.et, "et") || x.course.id - y.course.id);
}
