import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { courseAccess, protocols, testAttempts, type AttemptStatus, type OpenReview, type TestAnswers, type TestAttempt } from "@/db/schema";
import {
  checkAnswers, checkReview, fixAnswers, grade, percentOf, publicQuestions, readQuestions, reviewStatus, submitStatus, testState, triesAllowed,
  type PublicQuestion, type TestState,
} from "@/domain/completion";
import { pick, type I18n } from "@/i18n/field";
import type { CompletionMailKind } from "./account-mail";
import { accessFor, completeIfDone, completionJob, courseSetup, hasPointsOf, isActive, lockAccess, mailCompletion, type AccessWithCourse, type CompletionJob, type CourseSetup } from "./completion";
import { courseOutline } from "./lesson-outline";
import { testReviewSummary, triesUsedSummary, type CompletionNotice, type Summary } from "./messages";
import { adminUrl, notifyMaria, type Env } from "./notify";

// The knowledge test (e-course completion, spec §3.3, §4.2, §5.4, D2, D3), without Next.js: the student's view and her submits (account-api.ts
// takes the client from the session), Maria's review and "Ava test uuesti" (the admin's server actions). Every write is ONE transaction that
// locks the course_access row first (completion.ts lockAccess) and then reads the attempts, so two submits at once (a double tap, two devices)
// run one after the other and the second sees the first's attempt; the unique (client, course, number) index is the backstop. The student is only
// ever served publicQuestions (no answer key), and the result names the wrong questions' numbers, never the right options. An attempt keeps a
// frozen copy of the questions it answered: a later edit of the course never changes it, and a submit made for other questions than the
// course's current ones is refused as `changed` (no try, nothing written). Mails and Maria's notices go after the commit (`later`). Logs carry ids.

export type TestDeps = { db: Db; env: Env; siteUrl: string; now: Date; later: (task: () => Promise<unknown>) => void };

export type AttemptView = {
  id: number;
  number: number;
  status: AttemptStatus;
  percent: number;
  wrong: number[];
  /** The attempt's frozen copy, public. */
  questions: PublicQuestion[];
  answers: TestAnswers;
  review: OpenReview | null;
  submittedAt: string;
};

export type TestView = {
  course: { slug: string; title: I18n };
  state: TestState;
  passPercent: number;
  /** The tries allowed: the course's and extra_tries ("Katse 2/3"). */
  tries: number;
  /** The tries allowed less the attempts made, at least 0. */
  triesLeft: number;
  /** The course's current questions (for a new attempt). */
  questions: PublicQuestion[];
  /** The newest attempt. */
  last: AttemptView | null;
  /** The lessons are not done and no attempt exists. */
  locked: boolean;
  /** The access has expired (results only). */
  readOnly: boolean;
  /** The course has practical points: its protocol's own copy once one exists (spec §3.4), else the course's (the passed state links the practical page only then). */
  hasPoints: boolean;
};

export type SubmitResult =
  | { kind: "submitted"; view: TestView }
  | { kind: "changed" }
  | { kind: "invalid"; error: "incomplete" | "tooLong" }
  /** Locked, used, waiting for Maria, passed, or expired. */
  | { kind: "closed" }
  | { kind: "notFound" };

export type ReviewResult = { kind: "reviewed"; status: "passed" | "fix"; completed: boolean } | { kind: "invalid"; error: "incomplete" | "comment" | "tooLong" } | { kind: "stale" } | { kind: "notFound" };

export type ReopenResult = { kind: "reopened"; triesLeft: number } | { kind: "notNeeded" } | { kind: "notFound" };

/** Work for after the commit: Maria's notice, the student's mail. */
type Task = () => Promise<void>;
/** What a transaction answers: the result, and what goes out once it is committed. */
type Done<R> = { result: R; after: Task[] };

/** Two answers to one question alike: the same text, or the same options in any order. */
function sameAnswer(a: string[] | string | undefined, b: string[] | string | undefined): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (!a || !b || a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

const sameAnswers = (a: TestAnswers, b: TestAnswers): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => sameAnswer(a[k], b[k]));
};

/** Two JSON values alike, whatever the order of their keys (jsonb keeps its own). */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

/** Her attempts at the course, newest first. */
const attemptsOf = (db: Db, access: { clientId: number; courseId: number }) =>
  db.select().from(testAttempts).where(and(eq(testAttempts.clientId, access.clientId), eq(testAttempts.courseId, access.courseId))).orderBy(desc(testAttempts.number));

/** An attempt as she sees it: graded from its own copy, which is all it shows. */
function attemptView(a: TestAttempt): AttemptView {
  const questions = readQuestions(a.questions);
  return {
    id: a.id,
    number: a.number,
    status: a.status,
    percent: percentOf(a.correct, a.total),
    wrong: grade(questions, a.answers).wrong,
    questions: publicQuestions(questions),
    answers: a.answers,
    review: a.review,
    submittedAt: a.submittedAt.toISOString(),
  };
}

/** The test page's data for one access (read inside a write's transaction too, so it shows that write). */
async function buildView(db: Db, access: AccessWithCourse, setup: CourseSetup, now: Date): Promise<TestView> {
  const [rows, outline, [protocol]] = await Promise.all([
    attemptsOf(db, access),
    courseOutline(db, access.courseId, access.clientId),
    db.select({ stages: protocols.stages }).from(protocols).where(eq(protocols.accessId, access.id)).limit(1),
  ]);
  const allowed = triesAllowed(setup.tries, access.extraTries);
  return {
    course: { slug: access.course.slug, title: access.course.title },
    state: testState(rows, allowed),
    passPercent: setup.passPercent,
    tries: allowed,
    triesLeft: Math.max(0, allowed - rows.length),
    questions: publicQuestions(setup.questions),
    last: rows[0] ? attemptView(rows[0]) : null,
    locked: rows.length === 0 && outline.progress.done < outline.progress.total,
    readOnly: !isActive(access, now),
    hasPoints: hasPointsOf(protocol?.stages ?? null, setup.points),
  };
}

/** Maria's notice about a student (Task 2's summaries): her name, or her address when she gave none. */
const noticeOf = (job: CompletionJob): CompletionNotice => ({ accessId: job.accessId, name: job.name.trim() || job.email, email: job.email, course: pick(job.course, "et") });

/** Maria's notice by mail and Telegram (spec §6), Reply-To the student; logged by the attempt's id only. */
async function notify(deps: TestDeps, label: string, s: Summary, replyTo: string): Promise<void> {
  const r = await notifyMaria(deps.env, s.subject, s.text, { short: s.short, replyTo, siteUrl: deps.siteUrl });
  console.info(`${label}: Maria notified by e-mail: ${r.mail}, Telegram: ${r.telegram}`);
}

const queue = (deps: TestDeps, after: readonly Task[]): void => {
  for (const task of after) deps.later(task);
};

/** null: no access (any state but revoked is shown; revoked → null), a contact course, or a course without questions. */
export async function testView(db: Db, clientId: number, slug: string, now: Date): Promise<TestView | null> {
  const access = await accessFor(db, clientId, slug);
  if (!access || access.revokedAt !== null) return null;
  const setup = await courseSetup(db, access.courseId);
  if (setup.questions.length === 0) return null;
  return buildView(db, access, setup, now);
}

/**
 * A new attempt (spec §3.3, §4.2): lock the access, check it is active, check the answers against the course's CURRENT questions (other ids:
 * `changed`, no try, nothing written), then the state and the tries; grade, insert with the copy, and after the commit notify Maria when it
 * waits for her ("review") or when it was the last try ("used"), and mail "completed" when the pass completed the course. A repeat — the same
 * answers to the same questions as her newest attempt (a double tap, a second device, a retry whose answer was lost) — is answered with the view
 * as it is and writes nothing: the same answers grade the same, so a new attempt would only use a try (Review Focus 2). Not a repeat: a failed
 * newest attempt whose score passes the course's pass mark as it is NOW (Maria lowered it since): that is a new try. `raw`: the body's answers.
 */
export async function submitAttempt(deps: TestDeps, clientId: number, slug: string, raw: unknown): Promise<SubmitResult> {
  const peek = await accessFor(deps.db, clientId, slug);
  if (!peek || peek.revokedAt !== null) return { kind: "notFound" };
  const done = await deps.db.transaction(async (tx): Promise<Done<SubmitResult> & { attempt?: { id: number; status: AttemptStatus } }> => {
    const t = tx as unknown as Db;
    const stop = (result: SubmitResult): Done<SubmitResult> => ({ result, after: [] });
    const locked = await lockAccess(t, peek.id);
    if (!locked || locked.revokedAt !== null) return stop({ kind: "notFound" });
    const access: AccessWithCourse = { ...locked, course: peek.course };
    const setup = await courseSetup(t, access.courseId);
    if (setup.questions.length === 0) return stop({ kind: "notFound" });
    if (!isActive(access, deps.now)) return stop({ kind: "closed" });
    const answers = checkAnswers(setup.questions, raw);
    if (!answers.ok) return stop(answers.error === "changed" ? { kind: "changed" } : { kind: "invalid", error: answers.error });
    const rows = await attemptsOf(t, access);
    const newest = rows[0];
    // a repeat; but a failed attempt whose answers would pass under the pass mark Maria has lowered since is a new try, graded as it is now
    if (
      newest &&
      sameAnswers(newest.answers, answers.answers) &&
      sameJson(readQuestions(newest.questions), setup.questions) &&
      (newest.status !== "failed" || submitStatus(setup.questions, newest.correct, newest.total, setup.passPercent) === "failed")
    )
      return stop({ kind: "submitted", view: await buildView(t, access, setup, deps.now) });
    const allowed = triesAllowed(setup.tries, access.extraTries);
    const state = testState(rows, allowed);
    if (state.kind !== "none" && state.kind !== "open") return stop({ kind: "closed" });
    if (rows.length === 0) {
      // the test opens once every lesson is done (spec D5); once an attempt exists, a lesson added later never locks it again (§4.4)
      const { progress } = await courseOutline(t, access.courseId, access.clientId);
      if (progress.done < progress.total) return stop({ kind: "closed" });
    }
    const graded = grade(setup.questions, answers.answers);
    const status = submitStatus(setup.questions, graded.correct, graded.total, setup.passPercent);
    const [row] = await tx
      .insert(testAttempts)
      .values({
        clientId: access.clientId,
        courseId: access.courseId,
        number: (newest?.number ?? 0) + 1,
        questions: setup.questions,
        answers: answers.answers,
        correct: graded.correct,
        total: graded.total,
        status,
        submittedAt: deps.now,
      })
      .returning();
    const completed = status === "passed" && (await completeIfDone(t, access.id, deps.now));
    const view = await buildView(t, access, setup, deps.now);
    const job = await completionJob(t, access.id);
    const after: Task[] = [];
    if (job) {
      const label = `[test] attempt ${row.id}`;
      if (status === "review") after.push(() => notify(deps, label, testReviewSummary({ ...noticeOf(job), attemptId: row.id, number: row.number }, adminUrl(deps.siteUrl)), job.email));
      if (view.state.kind === "used") after.push(() => notify(deps, label, triesUsedSummary({ ...noticeOf(job), tries: allowed }, adminUrl(deps.siteUrl)), job.email));
      if (completed) after.push(() => mailCompletion(deps.env, deps.siteUrl, job, "completed"));
    }
    return { result: { kind: "submitted", view }, after, attempt: { id: row.id, status } };
  });
  if (done.attempt) console.info(`[test] attempt ${done.attempt.id}: submitted (${done.attempt.status})`);
  queue(deps, done.after);
  return done.result;
}

/**
 * The "Paranda" answers rewritten (spec §4.2, §3.3): the same attempt, checked against its OWN copy of the questions (an edit of the course since
 * does not matter); only the answers Maria marked "fix" may change, every other one must be as stored (else `changed`). The attempt goes back to
 * "review" with its new answers and time; no try is used; Maria is notified again after the commit. The same rewrite again while it waits is a
 * repeat: the view, nothing written, no second notice.
 */
export async function resubmitAnswers(deps: TestDeps, clientId: number, slug: string, attemptId: number, raw: unknown): Promise<SubmitResult> {
  const peek = await accessFor(deps.db, clientId, slug);
  if (!peek || peek.revokedAt !== null) return { kind: "notFound" };
  const done = await deps.db.transaction(async (tx): Promise<Done<SubmitResult> & { rewritten?: number }> => {
    const t = tx as unknown as Db;
    const stop = (result: SubmitResult): Done<SubmitResult> => ({ result, after: [] });
    const locked = await lockAccess(t, peek.id);
    if (!locked || locked.revokedAt !== null) return stop({ kind: "notFound" });
    const access: AccessWithCourse = { ...locked, course: peek.course };
    const [attempt] = await tx
      .select()
      .from(testAttempts)
      .where(and(eq(testAttempts.id, attemptId), eq(testAttempts.clientId, access.clientId), eq(testAttempts.courseId, access.courseId)))
      .limit(1);
    if (!attempt) return stop({ kind: "notFound" });
    if (!isActive(access, deps.now)) return stop({ kind: "closed" });
    const questions = readQuestions(attempt.questions);
    const answers = checkAnswers(questions, raw);
    if (!answers.ok) return stop(answers.error === "changed" ? { kind: "changed" } : { kind: "invalid", error: answers.error });
    const setup = await courseSetup(t, access.courseId);
    if (attempt.status === "review" && sameAnswers(attempt.answers, answers.answers)) return stop({ kind: "submitted", view: await buildView(t, access, setup, deps.now) });
    if (attempt.status !== "fix") return stop({ kind: "closed" });
    const open = new Set(fixAnswers(attempt.review));
    if (questions.some((q) => !open.has(q.id) && !sameAnswer(attempt.answers[q.id], answers.answers[q.id]))) return stop({ kind: "changed" });
    await tx.update(testAttempts).set({ answers: answers.answers, status: "review", submittedAt: deps.now }).where(eq(testAttempts.id, attempt.id));
    const view = await buildView(t, access, setup, deps.now);
    const job = await completionJob(t, access.id);
    const after: Task[] = job
      ? [() => notify(deps, `[test] attempt ${attempt.id}`, testReviewSummary({ ...noticeOf(job), attemptId: attempt.id, number: attempt.number }, adminUrl(deps.siteUrl)), job.email)]
      : [];
    return { result: { kind: "submitted", view }, after, rewritten: attempt.id };
  });
  if (done.rewritten !== undefined) console.info(`[test] attempt ${done.rewritten}: rewritten (review)`);
  queue(deps, done.after);
  return done.result;
}

/**
 * Maria's review of an attempt in "review" (spec §5.4), else `stale` (reviewed already, on her other device): lock the access, store the review,
 * when and by whom, and the status (every open answer "ok": passed, else fix); a pass may complete the course. After the commit the student's
 * mail: "completed" when it completed the course, "testFix" for a rewrite, "testPassed" when the practical work is next (a course with points).
 * An expired access is still reviewed (spec §8) and the review is stored, but its "testFix" and "testPassed" mails are not sent: her pages are
 * read-only until the access is extended (a rewrite answers `closed`), so they would invite her to what she cannot do (as with `reopenTest`);
 * "completed" still goes, it only tells her the course is done. A revoked access is notFound. `raw`: the review form's verdicts and comments. `shownSubmittedAt`:
 * the attempt's `submittedAt` (ISO) as the review page showed it; when given and the stored one differs, the student has rewritten her answers
 * since that page was read (a screen on Maria's other device, older than the rewrite): `stale`, nothing stored for answers she never saw.
 */
export async function reviewAttempt(deps: TestDeps, adminEmail: string, attemptId: number, raw: unknown, shownSubmittedAt?: string): Promise<ReviewResult> {
  const [peek] = await deps.db
    .select({ accessId: courseAccess.id })
    .from(testAttempts)
    .innerJoin(courseAccess, and(eq(courseAccess.clientId, testAttempts.clientId), eq(courseAccess.courseId, testAttempts.courseId)))
    .where(eq(testAttempts.id, attemptId))
    .limit(1);
  if (!peek) return { kind: "notFound" };
  const done = await deps.db.transaction(async (tx): Promise<Done<ReviewResult>> => {
    const t = tx as unknown as Db;
    const stop = (result: ReviewResult): Done<ReviewResult> => ({ result, after: [] });
    const access = await lockAccess(t, peek.accessId);
    if (!access || access.revokedAt !== null) return stop({ kind: "notFound" });
    const [attempt] = await tx.select().from(testAttempts).where(eq(testAttempts.id, attemptId)).limit(1);
    if (!attempt) return stop({ kind: "notFound" });
    if (attempt.status !== "review") return stop({ kind: "stale" });
    if (shownSubmittedAt !== undefined && shownSubmittedAt !== attempt.submittedAt.toISOString()) return stop({ kind: "stale" }); // rewritten since
    const review = checkReview(readQuestions(attempt.questions), raw);
    if (!review.ok) return stop({ kind: "invalid", error: review.error });
    const status = reviewStatus(review.review);
    await tx.update(testAttempts).set({ review: review.review, status, reviewedAt: deps.now, reviewedBy: adminEmail }).where(eq(testAttempts.id, attemptId));
    const completed = status === "passed" && (await completeIfDone(t, access.id, deps.now));
    const job = await completionJob(t, access.id);
    const active = isActive(access, deps.now); // an ended access: no mail sends her to a page she can only read
    const kind: CompletionMailKind | null = completed ? "completed" : !active ? null : status === "fix" ? "testFix" : job?.hasPoints ? "testPassed" : null;
    return { result: { kind: "reviewed", status, completed }, after: job && kind ? [() => mailCompletion(deps.env, deps.siteUrl, job, kind)] : [] };
  });
  if (done.result.kind === "reviewed") console.info(`[test] attempt ${attemptId}: reviewed (${done.result.status})`);
  queue(deps, done.after);
  return done.result;
}

/**
 * "Ava test uuesti" (spec §5.2, D3): when every allowed try failed ("used"), the allowance becomes the attempts made plus the course's tries
 * (extra_tries grows by the course's tries, but at least up to the attempts made: when Maria has lowered the course's tries below them, the
 * plain addition would leave it "used"), and after the commit the student gets "reopened"; otherwise `notNeeded`. Under the access lock, so
 * two taps add the tries once (the second finds the test open). A revoked access is notFound. An access that has ended (Hindamine still lists
 * it) gets the tries all the same, for the day it is extended, but no "reopened" mail: her page is read-only and a submit answers `closed`, so
 * the mail would promise a test she cannot take. `adminEmail`: the admin who asked (course_access has no column for it; the reopen shows as
 * extra_tries).
 */
export async function reopenTest(deps: TestDeps, adminEmail: string, accessId: number): Promise<ReopenResult> {
  const done = await deps.db.transaction(async (tx): Promise<Done<ReopenResult>> => {
    const t = tx as unknown as Db;
    const stop = (result: ReopenResult): Done<ReopenResult> => ({ result, after: [] });
    const access = await lockAccess(t, accessId);
    if (!access || access.revokedAt !== null) return stop({ kind: "notFound" });
    const setup = await courseSetup(t, access.courseId);
    const rows = await attemptsOf(t, access);
    const allowed = triesAllowed(setup.tries, access.extraTries);
    if (testState(rows, allowed).kind !== "used") return stop({ kind: "notNeeded" });
    // the new allowance is setup.tries + extraTries: at least the attempts made (rows.length) plus the course's tries
    const extraTries = Math.max(access.extraTries + setup.tries, rows.length);
    await tx.update(courseAccess).set({ extraTries }).where(eq(courseAccess.id, accessId));
    const job = await completionJob(t, accessId);
    return {
      result: { kind: "reopened", triesLeft: Math.max(0, triesAllowed(setup.tries, extraTries) - rows.length) },
      // an ended access: the tries wait for an extension, and no mail invites her to a test she cannot take now
      after: job && isActive(access, deps.now) ? [() => mailCompletion(deps.env, deps.siteUrl, job, "reopened")] : [],
    };
  });
  if (done.result.kind === "reopened") console.info(`[test] access ${accessId}: reopened`);
  queue(deps, done.after);
  return done.result;
}
