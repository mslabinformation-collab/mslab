import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { clients, courseAccess, courses, courseTests, protocols, testAttempts, type TestQuestion } from "@/db/schema";
import { courseSteps, isComplete, practicalStatus, readQuestions, TEST_DEFAULTS, testState, triesAllowed, type CourseSteps, type StepInputs } from "@/domain/completion";
import { isSampleAddress } from "@/domain/email";
import { readStages } from "@/domain/protocols";
import type { I18n } from "@/i18n/field";
import { completionMail, type CompletionMailKind } from "./account-mail";
import { courseOutline } from "./lesson-outline";
import { logFailure, logNote } from "./log";
import { mailConfigured, sendMail, type Env } from "./notify";

// The e-course's completion (e-course completion, spec §4.1, §4.4, D5), without Next.js: whose access a request is about (in any state: an
// expired one's results stay readable, Maria still assesses it), its lock (FOR UPDATE: the first lock of every write about one access), the
// course's test and points, what the step states are made of, and completeIfDone, the ONE place course_access.completed_at is set. Each path
// that can finish the last step calls it after its write — the last lesson (lesson-data.ts), a passed test (test-attempts.ts), an approving
// assessment (assessment.ts) — and only the call that set it mails "completed", after the commit. Logs carry the access's id only.

export type AccessRow = { id: number; clientId: number; courseId: number; expiresAt: Date; revokedAt: Date | null; extraTries: number; completedAt: Date | null };
export type AccessWithCourse = AccessRow & { course: { id: number; slug: string; title: I18n } };

const accessColumns = {
  id: courseAccess.id,
  clientId: courseAccess.clientId,
  courseId: courseAccess.courseId,
  expiresAt: courseAccess.expiresAt,
  revokedAt: courseAccess.revokedAt,
  extraTries: courseAccess.extraTries,
  completedAt: courseAccess.completedAt,
};

/** The access of this client to the e-course `slug`, in any state (revoked and expired too); null without one or for a contact course. */
export async function accessFor(db: Db, clientId: number, slug: string): Promise<AccessWithCourse | null> {
  const [row] = await db
    .select({ ...accessColumns, course: { id: courses.id, slug: courses.slug, title: courses.title } })
    .from(courseAccess)
    .innerJoin(courses, eq(courseAccess.courseId, courses.id))
    .where(and(eq(courseAccess.clientId, clientId), eq(courses.slug, slug), eq(courses.type, "e_learning")))
    .limit(1);
  return row ?? null;
}

/** Not revoked and not ended (the same rule as client-data.ts activeAccess: `expires_at > now`). */
export const isActive = (a: Pick<AccessRow, "revokedAt" | "expiresAt">, now: Date): boolean => a.revokedAt === null && a.expiresAt > now;

/** SELECT … FOR UPDATE of the access row (inside a transaction): every write about one access takes it first; null when it is gone. */
export async function lockAccess(tx: Db, accessId: number): Promise<AccessRow | null> {
  const [row] = await tx.select(accessColumns).from(courseAccess).where(eq(courseAccess.id, accessId)).for("update");
  return row ?? null;
}

export type CourseSetup = { questions: TestQuestion[]; passPercent: number; tries: number; points: string[] };

/** The course's test (R1: its course_tests row; no questions, 80 % and 3 tries without one) and its points (readStages(courses.protocol_stages)). */
export async function courseSetup(db: Db, courseId: number): Promise<CourseSetup> {
  const [[course], [test]] = await Promise.all([
    db.select({ points: courses.protocolStages }).from(courses).where(eq(courses.id, courseId)).limit(1),
    db.select().from(courseTests).where(eq(courseTests.courseId, courseId)).limit(1),
  ]);
  return {
    questions: readQuestions(test?.questions ?? []),
    passPercent: test?.passPercent ?? TEST_DEFAULTS.passPercent,
    tries: test?.tries ?? TEST_DEFAULTS.tries,
    points: readStages(course?.points ?? []),
  };
}

/**
 * Has the practical work points? The protocol's own copy decides once a protocol exists (`stages`; spec §3.4: a later change of the course's
 * points reaches only protocols not made yet), the course's `points` before (null `stages`: no protocol). The one place of this rule: the step
 * inputs, the completion mail's job (here) and the test page's view (test-attempts.ts) all ask it.
 */
export const hasPointsOf = (stages: readonly { title: string }[] | null, points: readonly string[]): boolean => (stages ? stages.length > 0 : points.length > 0);

/**
 * Everything courseSteps needs, read for one access: the lessons (courseOutline: the visible ones, as the e-course page counts them), the
 * attempts, the protocol. The points are the protocol's own copy once it exists (spec §3.4: a later change of the course's points reaches only
 * protocols not made yet), the course's before.
 */
export async function stepInputs(db: Db, access: AccessRow, setup?: CourseSetup): Promise<StepInputs> {
  const [s, outline, attempts, [protocol]] = await Promise.all([
    setup ?? courseSetup(db, access.courseId),
    courseOutline(db, access.courseId, access.clientId),
    db.select({ number: testAttempts.number, status: testAttempts.status }).from(testAttempts).where(and(eq(testAttempts.clientId, access.clientId), eq(testAttempts.courseId, access.courseId))),
    db.select({ stages: protocols.stages, round: protocols.round, sentRound: protocols.sentRound, sent: protocols.sent }).from(protocols).where(eq(protocols.accessId, access.id)).limit(1),
  ]);
  return {
    lessonsDone: outline.progress.done,
    lessonsTotal: outline.progress.total,
    hasQuestions: s.questions.length > 0,
    test: testState(attempts, triesAllowed(s.tries, access.extraTries)),
    hasPoints: hasPointsOf(protocol?.stages ?? null, s.points),
    practical: practicalStatus(protocol ?? null),
    practicalRound: protocol?.round ?? 0,
    completedAt: access.completedAt,
  };
}

/** The steps of one access, as the "Lõpetamine" block and the drawer's line show them. */
export async function loadSteps(db: Db, access: AccessRow): Promise<CourseSteps> {
  return courseSteps(await stepInputs(db, access));
}

/**
 * Sets course_access.completed_at = now when every present step is done and it is still null (one UPDATE … where completed_at is null);
 * true when THIS call set it (the caller mails "completed"). Runs inside the caller's transaction when given one (`tx as unknown as Db`):
 * it is then committed or rolled back with the step that completed the course. Never for a revoked access (checked on the read and again in
 * the UPDATE, so a revoke landing between the two completes nothing); an expired one completes (Maria may assess it, spec §8). Never for a
 * course without a visible lesson (an empty course is not "done", and the student's page load asks this of every access still without a
 * date). Never cleared: a lesson or a question added later leaves it (spec §4.4).
 */
export async function completeIfDone(db: Db, accessId: number, now: Date): Promise<boolean> {
  const [access] = await db.select(accessColumns).from(courseAccess).where(eq(courseAccess.id, accessId)).limit(1);
  if (!access || access.completedAt !== null || access.revokedAt !== null) return false;
  const inputs = await stepInputs(db, access);
  if (inputs.lessonsTotal === 0 || !isComplete(inputs)) return false;
  const set = await db
    .update(courseAccess)
    .set({ completedAt: now })
    .where(and(eq(courseAccess.id, accessId), isNull(courseAccess.completedAt), isNull(courseAccess.revokedAt))) // a revoke between the read and here completes nothing
    .returning(); // (returning(fields) has no common overload on the Db union: the whole row)
  if (set.length === 0) return false;
  console.info(`[completion] access ${accessId}: completed`);
  return true;
}

export type CompletionJob = { accessId: number; email: string; name: string; locale: "et" | "ru"; slug: string; course: I18n; hasPoints: boolean };

/** Who to mail about an access (the client's address, name and language; the course, and whether it has points: the protocol's copy decides once it exists). */
export async function completionJob(db: Db, accessId: number): Promise<CompletionJob | null> {
  const [row] = await db
    .select({ email: clients.email, name: clients.name, locale: clients.locale, slug: courses.slug, course: courses.title, points: courses.protocolStages, stages: protocols.stages })
    .from(courseAccess)
    .innerJoin(clients, eq(courseAccess.clientId, clients.id))
    .innerJoin(courses, eq(courseAccess.courseId, courses.id))
    .leftJoin(protocols, eq(protocols.accessId, courseAccess.id))
    .where(eq(courseAccess.id, accessId))
    .limit(1);
  if (!row) return null;
  return {
    accessId,
    email: row.email,
    name: row.name,
    locale: row.locale === "ru" ? "ru" : "et",
    slug: row.slug,
    course: row.course,
    hasPoints: hasPointsOf(row.stages, readStages(row.points)),
  };
}

/**
 * Sends completionMail of `kind` to the job's student: never to a sample address, nothing when Resend is not set up (local runs, e2e). A mail
 * Resend does not take is logged by the access's id and never undoes what was saved. Logs `[completion] access N: the <kind> mail …`.
 */
export async function mailCompletion(env: Env, siteUrl: string, job: CompletionJob, kind: CompletionMailKind, fixCount?: number): Promise<void> {
  if (isSampleAddress(job.email) || !mailConfigured(env)) return;
  try {
    const mail = completionMail({
      siteUrl,
      email: job.email,
      name: job.name,
      locale: job.locale,
      slug: job.slug,
      course: job.course,
      kind,
      hasPoints: job.hasPoints,
      ...(fixCount !== undefined ? { fixCount } : {}),
    });
    if (await sendMail(env, mail)) console.info(`[completion] access ${job.accessId}: the ${kind} mail sent`);
    else logNote(`[completion] access ${job.accessId}: the ${kind} mail was not sent`);
  } catch (e) {
    logFailure(`[completion] access ${job.accessId}: the ${kind} mail failed`, e);
  }
}

/** The "completed" mail of an access, queued after the answer (`later`): who and what are read then, so the answer never waits for the mail. */
export function queueCompletionMail(deps: { db: Db; env: Env; siteUrl: string; later: (task: () => Promise<unknown>) => void }, accessId: number): void {
  deps.later(async () => {
    const job = await completionJob(deps.db, accessId);
    if (job) await mailCompletion(deps.env, deps.siteUrl, job, "completed");
  });
}
