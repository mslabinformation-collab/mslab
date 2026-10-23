import { and, asc, count, desc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client";
import { clients, courseAccess, courses, courseTests, protocols, testAttempts, type AttemptStatus, type OpenReview, type TestAnswers, type TestAttempt, type TestQuestion } from "../schema";
import { percentOf, readQuestions, TEST_DEFAULTS, triesAllowed } from "@/domain/completion";
import { pick, type I18n } from "@/i18n/field";
import { clientNameSql } from "./client-name";

// "Hindamine" (e-course completion, spec §5.2, §5.4): what waits for Maria — the practical work sent and not yet assessed, the open answers
// waiting for her review, the students out of tries (three groups for the overview's counts, one list for Hindamine) — and an attempt as her
// review shows it. Callers have checked the admin session; nothing here does authorization. An access an admin ended (revoked) is left out
// everywhere: her pages answer 404 and her items leave the list (spec §8); a completed one has nothing left to assess. One that ran out stays:
// Maria can still assess it (spec §8).

/** The student as the admin sees her (client-name.ts): her own name, else her latest registration's, else her address. Every query below joins `clients` unaliased. */
const NAME = clientNameSql(sql`clients.email`);

/** Not ended by an admin and not completed. */
const LIVE = and(isNull(courseAccess.revokedAt), isNull(courseAccess.completedAt));
/** spec §3.4 "review": a submission (round > 0) the last send has not assessed (a submitted round always has its time). */
const PRACTICAL_WAITING = and(gt(protocols.round, 0), or(isNull(protocols.sentRound), lt(protocols.sentRound, protocols.round)), isNotNull(protocols.submittedAt));
/** An attempt's access: the same student and course (course_access_client_course: one row per pair). */
const ATTEMPT_ACCESS = and(eq(courseAccess.clientId, testAttempts.clientId), eq(courseAccess.courseId, testAttempts.courseId));
/** domain/completion.ts testState "used": every attempt failed, and as many as the tries allowed (the course's, 3 without a test row, + hers). */
const USED = sql`bool_and(${testAttempts.status} = 'failed') and count(${testAttempts.id}) >= coalesce(${courseTests.tries}, ${TEST_DEFAULTS.tries}) + ${courseAccess.extraTries}`;

export type WaitingPractical = { accessId: number; name: string; course: I18n; round: number; submittedAt: Date };
export type WaitingTest = { attemptId: number; accessId: number; name: string; course: I18n; number: number; allowed: number; submittedAt: Date };
/** `at`: when her last attempt was sent (the time the row has waited since). */
export type TriesUsed = { accessId: number; name: string; course: I18n; best: number /* percent */; attempts: number; at: Date };
export type AssessmentQueue = { practicals: WaitingPractical[]; tests: WaitingTest[]; triesUsed: TriesUsed[] };

async function waitingPracticals(db: Db): Promise<WaitingPractical[]> {
  const rows = await db
    .select({ accessId: courseAccess.id, name: NAME, course: courses.title, round: protocols.round, submittedAt: protocols.submittedAt })
    .from(protocols)
    .innerJoin(courseAccess, eq(protocols.accessId, courseAccess.id))
    .innerJoin(clients, eq(courseAccess.clientId, clients.id))
    .innerJoin(courses, eq(courseAccess.courseId, courses.id))
    .where(and(PRACTICAL_WAITING, LIVE))
    .orderBy(asc(protocols.submittedAt), asc(protocols.id));
  return rows.map((r) => ({ ...r, submittedAt: r.submittedAt! })); // (PRACTICAL_WAITING: never null here)
}

async function waitingTests(db: Db): Promise<WaitingTest[]> {
  const rows = await db
    .select({
      attemptId: testAttempts.id,
      accessId: courseAccess.id,
      name: NAME,
      course: courses.title,
      number: testAttempts.number,
      tries: courseTests.tries,
      extraTries: courseAccess.extraTries,
      submittedAt: testAttempts.submittedAt,
    })
    .from(testAttempts)
    .innerJoin(courseAccess, ATTEMPT_ACCESS)
    .innerJoin(clients, eq(testAttempts.clientId, clients.id))
    .innerJoin(courses, eq(testAttempts.courseId, courses.id))
    .leftJoin(courseTests, eq(courseTests.courseId, testAttempts.courseId))
    .where(and(eq(testAttempts.status, "review"), LIVE))
    .orderBy(asc(testAttempts.submittedAt), asc(testAttempts.id));
  return rows.map(({ tries, extraTries, ...r }) => ({ ...r, allowed: triesAllowed(tries ?? TEST_DEFAULTS.tries, extraTries) }));
}

/** The accesses out of tries, oldest last attempt first; `best` as percentOf rounds it (100 for an attempt without choice questions). */
async function triesUsedRows(db: Db): Promise<TriesUsed[]> {
  return db
    .select({
      accessId: courseAccess.id,
      name: NAME,
      course: courses.title,
      best: sql<number>`max(case when ${testAttempts.total} = 0 then 100 else (${testAttempts.correct} * 100) / ${testAttempts.total} end)`.mapWith(Number),
      attempts: sql<number>`count(${testAttempts.id})`.mapWith(Number),
      at: sql<Date>`max(${testAttempts.submittedAt})`.mapWith(testAttempts.submittedAt),
    })
    .from(courseAccess)
    .innerJoin(testAttempts, ATTEMPT_ACCESS)
    .innerJoin(clients, eq(courseAccess.clientId, clients.id))
    .innerJoin(courses, eq(courseAccess.courseId, courses.id))
    .leftJoin(courseTests, eq(courseTests.courseId, courseAccess.courseId))
    .where(LIVE)
    // (each table's primary key: the name's, the title's and the tries' columns depend on it)
    .groupBy(courseAccess.id, clients.id, courses.id, courseTests.courseId)
    .having(USED)
    .orderBy(sql`max(${testAttempts.submittedAt})`, asc(courseAccess.id));
}

/** What waits for Maria (spec §5.2), each group oldest first. */
export async function assessmentQueue(db: Db): Promise<AssessmentQueue> {
  const [practicals, tests, triesUsed] = await Promise.all([waitingPracticals(db), waitingTests(db), triesUsedRows(db)]);
  return { practicals, tests, triesUsed };
}

/**
 * One row of Hindamine's list (admin UX pass, A4): something that waits for Maria, of one of the three kinds, with the time it started to wait.
 * `at`: the practical work's send, the test answer's send, or the last attempt of a student out of tries. `course`: its Estonian title. Which
 * fields are there depends on `kind`: practical `round`; test `attemptId`, `number` (which try) and `allowed` (the tries she has); triesUsed
 * `best` (percent) and `attempts`.
 */
export type AssessmentItem = {
  kind: "practical" | "test" | "triesUsed";
  at: Date;
  name: string;
  course: string;
  accessId: number;
  attemptId?: number;
  best?: number;
  attempts?: number;
  round?: number;
  number?: number;
  allowed?: number;
};

/** The order of kinds at one instant. */
const KIND_ORDER: Record<AssessmentItem["kind"], number> = { practical: 0, test: 1, triesUsed: 2 };

/**
 * Everything that waits for Maria as one list, oldest first (A4): the three groups of `assessmentQueue` merged by the time each started to
 * wait. At the same instant: practical work, then test answers, then tries used, then the access (a fixed order, whatever the database returns).
 */
export async function assessmentList(db: Db): Promise<AssessmentItem[]> {
  const { practicals, tests, triesUsed } = await assessmentQueue(db);
  const items: AssessmentItem[] = [
    ...practicals.map((p): AssessmentItem => ({ kind: "practical", at: p.submittedAt, name: p.name, course: pick(p.course, "et"), accessId: p.accessId, round: p.round })),
    ...tests.map(
      (w): AssessmentItem => ({ kind: "test", at: w.submittedAt, name: w.name, course: pick(w.course, "et"), accessId: w.accessId, attemptId: w.attemptId, number: w.number, allowed: w.allowed }),
    ),
    ...triesUsed.map((u): AssessmentItem => ({ kind: "triesUsed", at: u.at, name: u.name, course: pick(u.course, "et"), accessId: u.accessId, best: u.best, attempts: u.attempts })),
  ];
  return items.sort((a, b) => a.at.getTime() - b.at.getTime() || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.accessId - b.accessId || (a.attemptId ?? 0) - (b.attemptId ?? 0));
}

/** The menu badge's number: the three groups together (the same rules, counted; the overview's queue counts them apart from the lists). */
export async function assessmentCount(db: Db): Promise<number> {
  const [[practicals], [tests], used] = await Promise.all([
    db.select({ n: count() }).from(protocols).innerJoin(courseAccess, eq(protocols.accessId, courseAccess.id)).where(and(PRACTICAL_WAITING, LIVE)),
    db.select({ n: count() }).from(testAttempts).innerJoin(courseAccess, ATTEMPT_ACCESS).where(and(eq(testAttempts.status, "review"), LIVE)),
    triesUsedRows(db),
  ]);
  return Number(practicals.n) + Number(tests.n) + used.length;
}

/**
 * One attempt as the review shows it (spec §5.4): the attempt's own copy of the questions with the key (Maria may have changed the test since:
 * Review Focus 3), the student's answers, the score rounded down, the tries she has, and the course's pass mark now.
 */
export type ReviewAttempt = {
  id: number;
  accessId: number;
  name: string;
  course: I18n;
  number: number;
  allowed: number;
  status: AttemptStatus;
  percent: number;
  passPercent: number;
  questions: TestQuestion[];
  answers: TestAnswers;
  review: OpenReview | null;
  submittedAt: Date;
};

type ReviewRow = { attempt: TestAttempt; accessId: number; extraTries: number; name: string; course: I18n; tries: number | null; passPercent: number | null };

const reviewFields = {
  attempt: testAttempts,
  accessId: courseAccess.id,
  extraTries: courseAccess.extraTries,
  name: NAME,
  course: courses.title,
  tries: courseTests.tries,
  passPercent: courseTests.passPercent,
};

function reviewOf(r: ReviewRow): ReviewAttempt {
  const a = r.attempt;
  return {
    id: a.id,
    accessId: r.accessId,
    name: r.name,
    course: r.course,
    number: a.number,
    allowed: triesAllowed(r.tries ?? TEST_DEFAULTS.tries, r.extraTries),
    status: a.status,
    percent: percentOf(a.correct, a.total),
    passPercent: r.passPercent ?? TEST_DEFAULTS.passPercent,
    questions: readQuestions(a.questions), // (jsonb read defensively: a malformed item is dropped, never thrown)
    answers: a.answers ?? {},
    review: a.review ?? null,
    submittedAt: a.submittedAt,
  };
}

/** The attempt `attemptId` for Maria's review; null without one, or when its access was ended by an admin. */
export async function attemptForReview(db: Db, attemptId: number): Promise<ReviewAttempt | null> {
  const [row] = await db
    .select(reviewFields)
    .from(testAttempts)
    .innerJoin(courseAccess, ATTEMPT_ACCESS)
    .innerJoin(clients, eq(testAttempts.clientId, clients.id))
    .innerJoin(courses, eq(testAttempts.courseId, courses.id))
    .leftJoin(courseTests, eq(courseTests.courseId, testAttempts.courseId))
    .where(and(eq(testAttempts.id, attemptId), isNull(courseAccess.revokedAt)))
    .limit(1);
  return row ? reviewOf(row) : null;
}

/** Every attempt of the access `accessId`, newest first (spec §5.4, "Testi katsed"); null without the access, or when an admin ended it. */
export async function attemptsOf(db: Db, accessId: number): Promise<{ name: string; course: I18n; attempts: ReviewAttempt[] } | null> {
  const [who] = await db
    .select({ name: NAME, course: courses.title })
    .from(courseAccess)
    .innerJoin(clients, eq(courseAccess.clientId, clients.id))
    .innerJoin(courses, eq(courseAccess.courseId, courses.id))
    .where(and(eq(courseAccess.id, accessId), isNull(courseAccess.revokedAt)))
    .limit(1);
  if (!who) return null;
  const rows = await db
    .select(reviewFields)
    .from(courseAccess)
    .innerJoin(testAttempts, ATTEMPT_ACCESS)
    .innerJoin(clients, eq(courseAccess.clientId, clients.id))
    .innerJoin(courses, eq(courseAccess.courseId, courses.id))
    .leftJoin(courseTests, eq(courseTests.courseId, courseAccess.courseId))
    .where(eq(courseAccess.id, accessId))
    .orderBy(desc(testAttempts.number));
  return { name: who.name, course: who.course, attempts: rows.map(reviewOf) };
}
