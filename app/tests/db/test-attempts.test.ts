import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, courseAccess, courseModules, courses, courseTests, lessonProgress, lessons, testAttempts, type TestAnswers, type TestQuestion } from "@/db/schema";
import { publicQuestions } from "@/domain/completion";
import { loadSteps } from "@/server/completion";
import type { Env } from "@/server/notify";
import { reopenTest, resubmitAnswers, reviewAttempt, submitAttempt, testView, type SubmitResult, type TestDeps, type TestView } from "@/server/test-attempts";
import { fakeKv, stubFetch } from "../fakes";
import { makeTestDb } from "./helpers";

// The knowledge test's server (e-course completion, spec §3.3, §4.2, §5.4, §6, §8; §9 DB): grading at once against the course's current
// questions, the frozen copy, the tries with extra_tries, the open answers' review and their rewrite (no try), "Ava test uuesti", the completion
// by a passed test, Maria's notices and the student's mails after the commit, and the refusals that write nothing. Two submits at once on real
// Postgres: tests/e2e/completion-race.spec.ts.

const NOW = new Date("2026-10-13T09:00:00Z");
const LATER = new Date("2026-10-14T09:00:00Z");
const DAY = 86_400_000;
const SITE = "https://mslab.example";
const MARIA = "maria@example.test";

const Q1: TestQuestion = { id: "q0000001", kind: "choice", text: "Mitu kihti värvi kanname?", options: [{ id: "o0000011", text: "Ühe", correct: false }, { id: "o0000012", text: "Kaks", correct: true }] };
const Q2: TestQuestion = {
  id: "q0000002",
  kind: "choice",
  text: "Mis kuulub ettevalmistusse?",
  options: [
    { id: "o0000021", text: "Puhastamine", correct: true },
    { id: "o0000022", text: "Kuju määramine", correct: true },
    { id: "o0000023", text: "Värvimine", correct: false },
  ],
};
const OPEN: TestQuestion = { id: "q0000003", kind: "open", text: "Kirjelda, kuidas valmistad kulmud ette." };
const Q4: TestQuestion = { id: "q0000004", kind: "choice", text: "Kui kaua värv mõjub?", options: [{ id: "o0000041", text: "5 minutit", correct: true }, { id: "o0000042", text: "1 tund", correct: false }] };

const RIGHT: TestAnswers = { [Q1.id]: ["o0000012"], [Q2.id]: ["o0000021", "o0000022"] };
/** 1 of 2 right: 50 %, under the 80 % mark; question 1 wrong. */
const WRONG: TestAnswers = { [Q1.id]: ["o0000011"], [Q2.id]: ["o0000021", "o0000022"] };
const ANSWER = "Puhastan ja määran kuju.";

let db: Db;
let resend: ReturnType<typeof stubFetch>;
beforeEach(async () => {
  db = await makeTestDb();
  resend = stubFetch((url) => (url.includes("resend") ? Response.json({ id: "email_1" }) : Response.json({})));
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The e-course "e-kulm" (`points` its protocol_stages; none by default) with one text lesson, done unless `lessonsDone` is false; its test
 * (`questions`, Q1 and Q2 by default; 80 %; `tries`, 3 by default); Kati Kask (kati@example.com unless `email` says otherwise) with six months of
 * access (`access` replaces fields).
 */
async function world(opts: { questions?: TestQuestion[]; points?: string[]; tries?: number; lessonsDone?: boolean; email?: string; access?: Partial<typeof courseAccess.$inferInsert> } = {}) {
  const [course] = await db
    .insert(courses)
    .values({ slug: "e-kulm", type: "e_learning", level: "basic", title: { et: "Kulmude e-koolitus", ru: "Онлайн-курс бровей" }, summary: { et: "" }, body: { et: "" }, price: 9500, published: true, protocolStages: opts.points ?? [] })
    .returning();
  const [m] = await db.insert(courseModules).values({ courseId: course.id, position: 1, title: { et: "Alustame" } }).returning();
  const [lesson] = await db.insert(lessons).values({ moduleId: m.id, position: 1, title: { et: "Sissejuhatus" }, kind: "text" }).returning();
  await db.insert(courseTests).values({ courseId: course.id, questions: opts.questions ?? [Q1, Q2], passPercent: 80, tries: opts.tries ?? 3 });
  const [client] = await db.insert(clients).values({ email: opts.email ?? "kati@example.com", name: "Kati Kask" }).returning();
  const [access] = await db.insert(courseAccess).values({ clientId: client.id, courseId: course.id, grantedBy: MARIA, expiresAt: new Date(NOW.getTime() + 180 * DAY), ...opts.access }).returning();
  if (opts.lessonsDone !== false) await db.insert(lessonProgress).values({ clientId: client.id, lessonId: lesson.id, doneAt: NOW });
  return { course, lesson, client, access };
}

const env = (): Env => ({ KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: MARIA, SITE_URL: SITE, RESEND_API_KEY: "re_test" });
/** `flush` runs every queued task, as Next's after() does. */
function deps(now = NOW) {
  const tasks: (() => Promise<unknown>)[] = [];
  const d: TestDeps = { db, env: env(), siteUrl: SITE, now, later: (task) => void tasks.push(task) };
  return { d, queued: () => tasks.length, flush: () => Promise.all(tasks.splice(0).map((task) => task())) };
}
type SentMail = { to: string; subject: string; text: string };
const mails = () => resend.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as SentMail);
const toMaria = () => mails().filter((m) => m.to === MARIA);
const toKati = () => mails().filter((m) => m.to === "kati@example.com");
const stored = (clientId: number) => db.select().from(testAttempts).where(eq(testAttempts.clientId, clientId)).orderBy(asc(testAttempts.number));
const accessRow = async (id: number) => (await db.select().from(courseAccess).where(eq(courseAccess.id, id)))[0];
const infoLog = () => vi.mocked(console.info).mock.calls.flat().join("\n");
const viewOf = (r: SubmitResult): TestView => {
  expect(r.kind).toBe("submitted");
  return (r as Extract<SubmitResult, { kind: "submitted" }>).view;
};

describe("testView", () => {
  test("the course's questions without the answer key, the state and the tries; locked before the lessons; read-only once the access has ended", async () => {
    const w = await world();
    const view = (await testView(db, w.client.id, "e-kulm", NOW))!;
    expect(view).toMatchObject({ course: { slug: "e-kulm", title: { et: "Kulmude e-koolitus" } }, state: { kind: "none" }, passPercent: 80, tries: 3, triesLeft: 3, last: null, locked: false, readOnly: false });
    expect(view.questions).toEqual(publicQuestions([Q1, Q2]));
    expect(JSON.stringify(view)).not.toContain('"correct"'); // the answer key never leaves the server
    expect((await testView(db, w.client.id, "e-kulm", new Date(NOW.getTime() + 200 * DAY)))!.readOnly).toBe(true);
    await db.delete(lessonProgress);
    expect((await testView(db, w.client.id, "e-kulm", NOW))!.locked).toBe(true);
  });

  test("null: another client, an unknown course, a course without questions, a revoked access, a contact course", async () => {
    const w = await world();
    const [other] = await db.insert(clients).values({ email: "mari@example.com" }).returning();
    expect(await testView(db, other.id, "e-kulm", NOW)).toBeNull();
    expect(await testView(db, w.client.id, "pole-olemas", NOW)).toBeNull();
    await db.update(courseTests).set({ questions: [] });
    expect(await testView(db, w.client.id, "e-kulm", NOW)).toBeNull();
    await db.update(courseTests).set({ questions: [Q1] });
    await db.update(courseAccess).set({ revokedAt: NOW });
    expect(await testView(db, w.client.id, "e-kulm", NOW)).toBeNull();
    const [contact] = await db.insert(courses).values({ slug: "kontakt", type: "contact", level: "basic", title: { et: "Kontakt" }, summary: { et: "" }, body: { et: "" } }).returning();
    await db.insert(courseAccess).values({ clientId: w.client.id, courseId: contact.id, grantedBy: MARIA, expiresAt: LATER });
    await db.insert(courseTests).values({ courseId: contact.id, questions: [Q1] });
    expect(await testView(db, w.client.id, "kontakt", NOW)).toBeNull();
  });
});

describe("submitAttempt", () => {
  test("graded at once: a failed choice part uses a try and names the wrong questions, the copy kept; a pass on a course with points mails nobody and opens the practical work", async () => {
    const w = await world({ points: ["Kulmude kuju", "Värvimine"] });
    const { d, queued } = deps();
    const failed = viewOf(await submitAttempt(d, w.client.id, "e-kulm", WRONG));
    expect(failed).toMatchObject({
      state: { kind: "open" },
      tries: 3,
      triesLeft: 2,
      last: { number: 1, status: "failed", percent: 50, wrong: [1], answers: WRONG, review: null, submittedAt: NOW.toISOString() },
    });
    expect(failed.last!.questions).toEqual(publicQuestions([Q1, Q2]));
    expect(JSON.stringify(failed)).not.toContain('"correct"');
    expect(await stored(w.client.id)).toMatchObject([{ number: 1, status: "failed", correct: 1, total: 2, answers: WRONG, questions: [Q1, Q2], submittedAt: NOW, review: null, reviewedAt: null }]);

    const passed = viewOf(await submitAttempt(d, w.client.id, "e-kulm", RIGHT));
    expect(passed).toMatchObject({ state: { kind: "passed" }, triesLeft: 1, last: { number: 2, status: "passed", percent: 100, wrong: [] } });
    expect(queued()).toBe(0); // an automatic result mails nobody: she is on the page
    expect((await accessRow(w.access.id)).completedAt).toBeNull(); // the practical work is still to come
    expect((await loadSteps(db, await accessRow(w.access.id))).practical).toMatchObject({ state: "open" });
    const rows = await stored(w.client.id);
    expect(infoLog()).toContain(`[test] attempt ${rows[0].id}: submitted (failed)`);
    expect(infoLog()).toContain(`[test] attempt ${rows[1].id}: submitted (passed)`);
    expect(await submitAttempt(d, w.client.id, "e-kulm", WRONG)).toEqual({ kind: "closed" }); // passed: nothing more to take
  });

  test("the tries are the course's and extra_tries; when the last one fails the state is 'used', Maria hears it once, and nothing more is taken", async () => {
    const w = await world({ tries: 2 });
    const { d, queued, flush } = deps();
    viewOf(await submitAttempt(d, w.client.id, "e-kulm", WRONG));
    expect(queued()).toBe(0);
    const used = viewOf(await submitAttempt(d, w.client.id, "e-kulm", { [Q1.id]: ["o0000011"], [Q2.id]: ["o0000021"] }));
    expect(used).toMatchObject({ state: { kind: "used" }, tries: 2, triesLeft: 0, last: { number: 2, status: "failed" } });
    expect(queued()).toBe(1);
    await flush();
    expect(toMaria()).toHaveLength(1);
    expect(toMaria()[0].subject).toContain("Testi katsed otsas: Kati Kask, Kulmude e-koolitus");
    expect(toMaria()[0].text).toContain(`${SITE}/admin/hindamine`);
    expect(toKati()).toEqual([]);
    expect(await submitAttempt(d, w.client.id, "e-kulm", RIGHT)).toEqual({ kind: "closed" });
    expect(await stored(w.client.id)).toHaveLength(2);
    // extra tries (as "Ava test uuesti" gives them) open it again
    await db.update(courseAccess).set({ extraTries: 2 }).where(eq(courseAccess.id, w.access.id));
    expect(await testView(db, w.client.id, "e-kulm", NOW)).toMatchObject({ state: { kind: "open" }, tries: 4, triesLeft: 2 });
    expect(viewOf(await submitAttempt(d, w.client.id, "e-kulm", RIGHT)).last).toMatchObject({ number: 3, status: "passed" });
  });

  test("refusals write nothing and use no try: locked before the lessons, incomplete or too long answers, an ended access; another client's or a revoked access is notFound", async () => {
    const w = await world({ questions: [Q1, OPEN], lessonsDone: false });
    const { d } = deps();
    const good = { [Q1.id]: ["o0000012"], [OPEN.id]: ANSWER };
    expect(await submitAttempt(d, w.client.id, "e-kulm", good)).toEqual({ kind: "closed" }); // the test opens once every lesson is done
    await db.insert(lessonProgress).values({ clientId: w.client.id, lessonId: w.lesson.id, doneAt: NOW });
    expect(await submitAttempt(d, w.client.id, "e-kulm", { ...good, [Q1.id]: [] })).toEqual({ kind: "invalid", error: "incomplete" });
    expect(await submitAttempt(d, w.client.id, "e-kulm", { ...good, [OPEN.id]: "   " })).toEqual({ kind: "invalid", error: "incomplete" });
    expect(await submitAttempt(d, w.client.id, "e-kulm", { ...good, [OPEN.id]: "x".repeat(2001) })).toEqual({ kind: "invalid", error: "tooLong" });
    expect(await submitAttempt(d, w.client.id, "e-kulm", { ...good, [Q1.id]: ["o0000011", "o0000012"] })).toEqual({ kind: "changed" }); // two options on a one-answer question
    for (const body of ["x", null, [good]]) expect(await submitAttempt(d, w.client.id, "e-kulm", body)).toEqual({ kind: "changed" }); // not answers at all
    expect(await submitAttempt(deps(new Date(NOW.getTime() + 200 * DAY)).d, w.client.id, "e-kulm", good)).toEqual({ kind: "closed" }); // the access has ended
    expect(await stored(w.client.id)).toEqual([]);
    const [other] = await db.insert(clients).values({ email: "mari@example.com" }).returning();
    expect(await submitAttempt(d, other.id, "e-kulm", good)).toEqual({ kind: "notFound" });
    await db.update(courseAccess).set({ revokedAt: NOW });
    expect(await submitAttempt(d, w.client.id, "e-kulm", good)).toEqual({ kind: "notFound" });
    expect(await stored(w.client.id)).toEqual([]);
  });
});

describe("open answers: Maria's review and the rewrite", () => {
  test("review: Maria hears it; 'Paranda' mails the student; only those answers may change, no try used, Maria hears it again; accepted completes a course without points", async () => {
    const w = await world({ questions: [Q1, Q2, OPEN] });
    const { d, flush } = deps();
    const answers = { ...RIGHT, [OPEN.id]: ANSWER };
    const waiting = viewOf(await submitAttempt(d, w.client.id, "e-kulm", answers));
    expect(waiting).toMatchObject({ state: { kind: "review" }, triesLeft: 2, last: { number: 1, status: "review", percent: 100 } });
    const [attempt] = await stored(w.client.id);
    await flush();
    expect(toMaria()).toHaveLength(1);
    expect(toMaria()[0].subject).toContain("Test ootab hindamist: Kati Kask, Kulmude e-koolitus");
    expect(toMaria()[0].text).toContain(`${SITE}/admin/hindamine/test?id=${attempt.id}`);
    expect(toMaria()[0].text).not.toContain(ANSWER); // a notice carries the link, never an answer
    expect(await submitAttempt(d, w.client.id, "e-kulm", { ...answers, [OPEN.id]: "Teine vastus" })).toEqual({ kind: "closed" }); // waiting for Maria

    const COMMENT = "Kirjelda ka, kuidas kulmud puhastad.";
    expect(await reviewAttempt(d, MARIA, attempt.id, { [OPEN.id]: { verdict: "fix", comment: COMMENT } })).toEqual({ kind: "reviewed", status: "fix", completed: false });
    expect((await stored(w.client.id))[0]).toMatchObject({ status: "fix", review: { [OPEN.id]: { verdict: "fix", comment: COMMENT } }, reviewedAt: NOW, reviewedBy: MARIA });
    expect(infoLog()).toContain(`[test] attempt ${attempt.id}: reviewed (fix)`);
    await flush();
    expect(toKati()).toHaveLength(1);
    expect(toKati()[0].subject).toBe("Vaata üle oma testi vastused");
    expect(toKati()[0].text).toContain(`${SITE}/konto/kursus/e-kulm/test`);
    expect(toKati()[0].text).not.toContain(COMMENT); // her comment is on the page only
    expect(await testView(db, w.client.id, "e-kulm", NOW)).toMatchObject({ state: { kind: "fix" }, last: { review: { [OPEN.id]: { verdict: "fix", comment: COMMENT } } } });

    // the rewrite: only the "Paranda" answer may change
    const later = deps(LATER);
    expect(await resubmitAnswers(later.d, w.client.id, "e-kulm", attempt.id, { ...answers, [Q1.id]: ["o0000011"], [OPEN.id]: "Uus vastus" })).toEqual({ kind: "changed" });
    expect(await resubmitAnswers(later.d, w.client.id, "e-kulm", attempt.id, { ...answers, [OPEN.id]: " " })).toEqual({ kind: "invalid", error: "incomplete" });
    expect(await resubmitAnswers(later.d, w.client.id, "e-kulm", 999_999, { ...answers, [OPEN.id]: "Uus vastus" })).toEqual({ kind: "notFound" });
    const NEW = "Puhastan kulmud, kuivatan ja määran kuju.";
    const rewritten = viewOf(await resubmitAnswers(later.d, w.client.id, "e-kulm", attempt.id, { ...answers, [OPEN.id]: NEW }));
    expect(rewritten).toMatchObject({ state: { kind: "review" }, triesLeft: 2, last: { id: attempt.id, number: 1, status: "review", answers: { [OPEN.id]: NEW } } });
    expect(await stored(w.client.id)).toHaveLength(1); // the same attempt: no try used
    expect((await stored(w.client.id))[0].submittedAt).toEqual(LATER);
    expect(later.queued()).toBe(1);
    // the same rewrite again (a double tap): nothing written, no second notice
    viewOf(await resubmitAnswers(later.d, w.client.id, "e-kulm", attempt.id, { ...answers, [OPEN.id]: NEW }));
    expect(later.queued()).toBe(1);
    await later.flush();
    expect(toMaria()).toHaveLength(2);

    expect(await reviewAttempt(d, MARIA, attempt.id, { [OPEN.id]: { verdict: "ok", comment: "" } })).toEqual({ kind: "reviewed", status: "passed", completed: true });
    expect((await accessRow(w.access.id)).completedAt).toEqual(NOW);
    await flush();
    // the course is completed: its own mail, not "Test on sooritatud"
    expect(toKati().map((m) => m.subject)).toEqual(["Vaata üle oma testi vastused", expect.stringContaining("Palju õnne!")]);
  });

  test("a review is refused without a verdict for every open answer, or a 'Paranda' without its comment; stale once not waiting; notFound for an unknown attempt or a revoked access; Review Focus 4: an ended access is still reviewed", async () => {
    const w = await world({ questions: [Q1, Q2, OPEN], points: ["Kulmude kuju"] });
    const { d, flush } = deps();
    viewOf(await submitAttempt(d, w.client.id, "e-kulm", { ...RIGHT, [OPEN.id]: ANSWER }));
    const [attempt] = await stored(w.client.id);
    expect(await reviewAttempt(d, MARIA, attempt.id, {})).toEqual({ kind: "invalid", error: "incomplete" });
    expect(await reviewAttempt(d, MARIA, attempt.id, { [OPEN.id]: { verdict: "fix", comment: "  " } })).toEqual({ kind: "invalid", error: "comment" });
    expect(await reviewAttempt(d, MARIA, attempt.id, { [OPEN.id]: { verdict: "fix", comment: "x".repeat(2001) } })).toEqual({ kind: "invalid", error: "tooLong" });
    expect(await reviewAttempt(d, MARIA, 999_999, { [OPEN.id]: { verdict: "ok", comment: "" } })).toEqual({ kind: "notFound" });
    expect((await stored(w.client.id))[0]).toMatchObject({ status: "review", review: null, reviewedAt: null });

    // the access ends meanwhile: Maria still reviews it (spec §8)
    await db.update(courseAccess).set({ expiresAt: new Date(NOW.getTime() - 1000) });
    expect(await reviewAttempt(d, MARIA, attempt.id, { [OPEN.id]: { verdict: "ok", comment: "" } })).toEqual({ kind: "reviewed", status: "passed", completed: false });
    await flush();
    expect(toKati()).toEqual([]); // her page is read-only until the access is extended: no mail invites her to the practical work now
    expect((await stored(w.client.id))[0]).toMatchObject({ status: "passed", reviewedAt: NOW, reviewedBy: MARIA });
    expect(await reviewAttempt(d, MARIA, attempt.id, { [OPEN.id]: { verdict: "ok", comment: "" } })).toEqual({ kind: "stale" }); // reviewed already (her other device)
    await db.update(courseAccess).set({ revokedAt: NOW });
    expect(await reviewAttempt(d, MARIA, attempt.id, { [OPEN.id]: { verdict: "ok", comment: "" } })).toEqual({ kind: "notFound" });
  });

  test("an accepted review on a course with points mails 'Test on sooritatud' with the practical work's link while the access is active", async () => {
    const w = await world({ questions: [Q1, Q2, OPEN], points: ["Kulmude kuju"] });
    const { d, flush } = deps();
    viewOf(await submitAttempt(d, w.client.id, "e-kulm", { ...RIGHT, [OPEN.id]: ANSWER }));
    const [attempt] = await stored(w.client.id);
    expect(await reviewAttempt(d, MARIA, attempt.id, { [OPEN.id]: { verdict: "ok", comment: "" } })).toEqual({ kind: "reviewed", status: "passed", completed: false });
    await flush();
    expect(toKati()).toHaveLength(1);
    expect(toKati()[0].subject).toBe("Test on sooritatud");
    expect(toKati()[0].text).toContain(`${SITE}/konto/kursus/e-kulm/praktiline`);
  });

  test("an ended access: a 'Paranda' review is stored but mails nobody (her rewrite would answer closed); a review that completes the course still mails 'completed'", async () => {
    const ended = new Date(NOW.getTime() - 1000);
    const fixing = await world({ questions: [Q1, Q2, OPEN] });
    const first = deps();
    viewOf(await submitAttempt(first.d, fixing.client.id, "e-kulm", { ...RIGHT, [OPEN.id]: ANSWER }));
    const [attempt] = await stored(fixing.client.id);
    await db.update(courseAccess).set({ expiresAt: ended });
    expect(await reviewAttempt(first.d, MARIA, attempt.id, { [OPEN.id]: { verdict: "fix", comment: "Lisa puhastamine." } })).toEqual({ kind: "reviewed", status: "fix", completed: false });
    await first.flush();
    expect(toKati()).toEqual([]);
    expect((await stored(fixing.client.id))[0]).toMatchObject({ status: "fix", reviewedAt: NOW });
    expect(await resubmitAnswers(first.d, fixing.client.id, "e-kulm", attempt.id, { ...RIGHT, [OPEN.id]: "Uus vastus" })).toEqual({ kind: "closed" });

    // a course without points: the accepted review completes it, an ended access or not
    const other = await db.insert(clients).values({ email: "mari@example.com", name: "Mari Mänd" }).returning();
    const [done] = await db.insert(courseAccess).values({ clientId: other[0].id, courseId: fixing.course.id, grantedBy: MARIA, expiresAt: ended }).returning();
    await db.insert(lessonProgress).values({ clientId: other[0].id, lessonId: fixing.lesson.id, doneAt: NOW });
    await db.insert(testAttempts).values({ clientId: other[0].id, courseId: fixing.course.id, number: 1, questions: [Q1, Q2, OPEN], answers: { ...RIGHT, [OPEN.id]: ANSWER }, correct: 2, total: 2, status: "review", submittedAt: NOW });
    const [waiting] = await stored(other[0].id);
    const second = deps();
    expect(await reviewAttempt(second.d, MARIA, waiting.id, { [OPEN.id]: { verdict: "ok", comment: "" } })).toEqual({ kind: "reviewed", status: "passed", completed: true });
    expect((await accessRow(done.id)).completedAt).toEqual(NOW);
    await second.flush();
    expect(mails().filter((m) => m.to === "mari@example.com").map((m) => m.subject)).toEqual([expect.stringContaining("Palju õnne!")]);
  });

  test("a review from a page older than her rewrite (Maria's other device) is stale: nothing stored for answers Maria never saw; the page that shows the rewrite reviews it", async () => {
    const w = await world({ questions: [Q1, Q2, OPEN] });
    const { d } = deps();
    const answers = { ...RIGHT, [OPEN.id]: ANSWER };
    viewOf(await submitAttempt(d, w.client.id, "e-kulm", answers));
    const [attempt] = await stored(w.client.id);
    const shown = attempt.submittedAt.toISOString(); // what both of Maria's devices read
    expect(await reviewAttempt(d, MARIA, attempt.id, { [OPEN.id]: { verdict: "fix", comment: "Lisa puhastamine." } }, shown)).toEqual({ kind: "reviewed", status: "fix", completed: false });
    const NEW = "Puhastan, kuivatan ja määran kuju.";
    viewOf(await resubmitAnswers(deps(LATER).d, w.client.id, "e-kulm", attempt.id, { ...answers, [OPEN.id]: NEW })); // back in "review", submittedAt LATER
    // her other device, still showing the first answers
    expect(await reviewAttempt(d, MARIA, attempt.id, { [OPEN.id]: { verdict: "ok", comment: "" } }, shown)).toEqual({ kind: "stale" });
    expect((await stored(w.client.id))[0]).toMatchObject({ status: "review", answers: { [OPEN.id]: NEW }, review: { [OPEN.id]: { verdict: "fix", comment: "Lisa puhastamine." } } });
    expect(infoLog()).not.toContain(`[test] attempt ${attempt.id}: reviewed (passed)`);
    // the page read after the rewrite
    expect(await reviewAttempt(d, MARIA, attempt.id, { [OPEN.id]: { verdict: "ok", comment: "" } }, LATER.toISOString())).toEqual({ kind: "reviewed", status: "passed", completed: true });
  });
});

describe("reopenTest", () => {
  test("'Ava test uuesti' adds the course's tries once they are used up and mails the student; otherwise not needed; an unknown or revoked access is notFound", async () => {
    const w = await world({ tries: 1 });
    const { d, flush } = deps();
    expect(await reopenTest(d, MARIA, w.access.id)).toEqual({ kind: "notNeeded" }); // no attempt yet
    viewOf(await submitAttempt(d, w.client.id, "e-kulm", WRONG));
    await flush(); // Maria's "Testi katsed otsas"
    expect(await reopenTest(d, MARIA, w.access.id)).toEqual({ kind: "reopened", triesLeft: 1 });
    expect((await accessRow(w.access.id)).extraTries).toBe(1);
    expect(infoLog()).toContain(`[test] access ${w.access.id}: reopened`);
    await flush();
    expect(toKati()).toHaveLength(1);
    expect(toKati()[0].subject).toBe("Test on sinu jaoks uuesti avatud");
    expect(toKati()[0].text).toContain(`${SITE}/konto/kursus/e-kulm/test`);
    expect(await testView(db, w.client.id, "e-kulm", NOW)).toMatchObject({ state: { kind: "open" }, tries: 2, triesLeft: 1 });
    expect(await reopenTest(d, MARIA, w.access.id)).toEqual({ kind: "notNeeded" });
    expect(await reopenTest(d, MARIA, 999_999)).toEqual({ kind: "notFound" });
    await db.update(courseAccess).set({ revokedAt: NOW });
    expect(await reopenTest(d, MARIA, w.access.id)).toEqual({ kind: "notFound" });
  });

  test("an expired access: tries added, no mail (her page is read-only until the access is extended)", async () => {
    const w = await world({ tries: 1 });
    const first = deps();
    viewOf(await submitAttempt(first.d, w.client.id, "e-kulm", WRONG));
    await first.flush(); // Maria's "Testi katsed otsas"
    await db.update(courseAccess).set({ expiresAt: new Date(NOW.getTime() - 1000) }).where(eq(courseAccess.id, w.access.id));
    const { d, queued, flush } = deps();
    expect(await reopenTest(d, MARIA, w.access.id)).toEqual({ kind: "reopened", triesLeft: 1 });
    expect((await accessRow(w.access.id)).extraTries).toBe(1);
    expect(infoLog()).toContain(`[test] access ${w.access.id}: reopened`);
    expect(queued()).toBe(0);
    await flush();
    expect(toKati()).toEqual([]);
    expect(await testView(db, w.client.id, "e-kulm", NOW)).toMatchObject({ state: { kind: "open" }, tries: 2, triesLeft: 1, readOnly: true });
  });

  test("Maria lowered the course's tries below the attempts made: one reopen still opens the test, with the course's tries left, and the student is mailed once", async () => {
    const w = await world(); // 3 tries
    const { d, flush } = deps();
    const failing: TestAnswers[] = [{ [Q1.id]: ["o0000011"], [Q2.id]: ["o0000021"] }, { [Q1.id]: ["o0000011"], [Q2.id]: ["o0000022"] }, WRONG];
    for (const answers of failing) viewOf(await submitAttempt(d, w.client.id, "e-kulm", answers));
    await flush(); // Maria's "Testi katsed otsas"
    await db.update(courseTests).set({ tries: 1 }).where(eq(courseTests.courseId, w.course.id)); // 3 tries made, 1 allowed now
    expect(await testView(db, w.client.id, "e-kulm", NOW)).toMatchObject({ state: { kind: "used" }, tries: 1, triesLeft: 0 });
    expect(await reopenTest(d, MARIA, w.access.id)).toEqual({ kind: "reopened", triesLeft: 1 });
    expect(await testView(db, w.client.id, "e-kulm", NOW)).toMatchObject({ state: { kind: "open" }, tries: 4, triesLeft: 1 }); // the allowance now exceeds the 3 made
    await flush();
    expect(toKati().map((m) => m.subject)).toEqual(["Test on sinu jaoks uuesti avatud"]);
    expect(await reopenTest(d, MARIA, w.access.id)).toEqual({ kind: "notNeeded" });
    expect(viewOf(await submitAttempt(d, w.client.id, "e-kulm", RIGHT)).last).toMatchObject({ number: 4, status: "passed" });
  });
});

describe("completion by the test (spec §4.4)", () => {
  test("a pass on a course without points completes it, once, and mails 'completed' with the course's link", async () => {
    const w = await world();
    const { d, queued, flush } = deps();
    viewOf(await submitAttempt(d, w.client.id, "e-kulm", RIGHT));
    expect((await accessRow(w.access.id)).completedAt).toEqual(NOW);
    expect(infoLog()).toContain(`[completion] access ${w.access.id}: completed`);
    expect(queued()).toBe(1);
    await flush();
    expect(toKati()).toHaveLength(1);
    expect(toKati()[0].subject).toContain("Palju õnne!");
    expect(toKati()[0].subject).toContain("Kulmude e-koolitus");
    expect(toKati()[0].text).toContain(`${SITE}/konto/kursus/e-kulm`);
    expect(toKati()[0].text).not.toContain("/praktiline");
  });

  test("a sample address completes without a mail", async () => {
    const w = await world({ email: "kati@example.test" });
    const { d, flush } = deps();
    viewOf(await submitAttempt(d, w.client.id, "e-kulm", RIGHT));
    expect((await accessRow(w.access.id)).completedAt).toEqual(NOW);
    await flush();
    expect(mails()).toEqual([]);
  });
});

describe("Review Focus 2: two submits at once (a double tap, two devices)", () => {
  test("the same answers twice at once make one attempt and one try, a failed one too; once more later (her answer lost on the way) still that one", async () => {
    const w = await world();
    const { d } = deps();
    const [a, b] = await Promise.all([submitAttempt(d, w.client.id, "e-kulm", WRONG), submitAttempt(d, w.client.id, "e-kulm", WRONG)]);
    expect([a.kind, b.kind]).toEqual(["submitted", "submitted"]);
    expect(await stored(w.client.id)).toHaveLength(1);
    expect(viewOf(a)).toMatchObject({ triesLeft: 2, last: { number: 1, status: "failed" } });
    expect(viewOf(b)).toMatchObject({ triesLeft: 2, last: { number: 1, status: "failed" } });
    expect(viewOf(await submitAttempt(d, w.client.id, "e-kulm", WRONG))).toMatchObject({ triesLeft: 2 });
    expect(await stored(w.client.id)).toHaveLength(1);
  });

  test("the same answers sent again after the test is passed are a repeat: the current view, nothing written, nobody told", async () => {
    const w = await world({ points: ["Kulmude kuju"] }); // a course with points: the pass completes nothing, so it mails nobody
    const { d, queued } = deps();
    const first = viewOf(await submitAttempt(d, w.client.id, "e-kulm", RIGHT));
    expect(first.state).toEqual({ kind: "passed" });
    const before = await stored(w.client.id);
    const again = await submitAttempt(d, w.client.id, "e-kulm", RIGHT);
    expect(again.kind).toBe("submitted");
    expect(viewOf(again)).toEqual(first);
    expect(viewOf(again)).toMatchObject({ state: { kind: "passed" }, triesLeft: 2, last: { number: 1, status: "passed" } });
    expect(await stored(w.client.id)).toEqual(before);
    expect(queued()).toBe(0);
    expect(infoLog().match(/submitted \(passed\)/g)).toHaveLength(1);
  });

  test("Maria lowers the pass mark after a failed attempt: the same answers sent again are a new try, graded against the mark as it is now", async () => {
    const w = await world({ points: ["Kulmude kuju"] });
    const { d } = deps();
    viewOf(await submitAttempt(d, w.client.id, "e-kulm", WRONG)); // 50 %, under 80
    expect(viewOf(await submitAttempt(d, w.client.id, "e-kulm", WRONG))).toMatchObject({ triesLeft: 2, last: { number: 1, status: "failed" } }); // still a repeat
    await db.update(courseTests).set({ passPercent: 50 }).where(eq(courseTests.courseId, w.course.id));
    expect(viewOf(await submitAttempt(d, w.client.id, "e-kulm", WRONG))).toMatchObject({ state: { kind: "passed" }, triesLeft: 1, last: { number: 2, status: "passed", percent: 50 } });
    expect(await stored(w.client.id)).toMatchObject([{ number: 1, status: "failed" }, { number: 2, status: "passed" }]);
  });

  test("open answers: one attempt waiting for Maria and one notice; a second device's other answers are closed meanwhile", async () => {
    const w = await world({ questions: [Q1, Q2, OPEN] });
    const { d, queued } = deps();
    const answers = { ...RIGHT, [OPEN.id]: ANSWER };
    await Promise.all([submitAttempt(d, w.client.id, "e-kulm", answers), submitAttempt(d, w.client.id, "e-kulm", answers)]);
    expect(await stored(w.client.id)).toMatchObject([{ number: 1, status: "review" }]);
    expect(queued()).toBe(1);
    expect(await submitAttempt(d, w.client.id, "e-kulm", { ...answers, [OPEN.id]: "Teise seadme vastus" })).toEqual({ kind: "closed" });
    expect(queued()).toBe(1);
  });
});

describe("Review Focus 3: Maria changes the test while a student is on it", () => {
  test("a submit made for the old questions is refused as changed: no try used, nothing written; an earlier attempt keeps its own copy", async () => {
    const w = await world();
    const { d } = deps();
    viewOf(await submitAttempt(d, w.client.id, "e-kulm", WRONG)); // attempt 1, on Q1 and Q2
    await db.update(courseTests).set({ questions: [Q1, Q4] }).where(eq(courseTests.courseId, w.course.id)); // Maria's edit
    expect(await submitAttempt(d, w.client.id, "e-kulm", RIGHT)).toEqual({ kind: "changed" });
    expect(await stored(w.client.id)).toHaveLength(1);
    const view = (await testView(db, w.client.id, "e-kulm", NOW))!;
    expect(view).toMatchObject({ state: { kind: "open" }, triesLeft: 2 });
    expect(view.questions).toEqual(publicQuestions([Q1, Q4])); // a new attempt answers the questions as they are now
    expect(view.last!.questions).toEqual(publicQuestions([Q1, Q2])); // the attempt shows the copy it answered
    expect((await stored(w.client.id))[0].questions).toEqual([Q1, Q2]);
    expect(viewOf(await submitAttempt(d, w.client.id, "e-kulm", { [Q1.id]: ["o0000012"], [Q4.id]: ["o0000041"] })).last).toMatchObject({ number: 2, status: "passed" });
  });

  test("a 'Paranda' rewrite is checked against the attempt's own copy, whatever the course's questions are now", async () => {
    const w = await world({ questions: [Q1, Q2, OPEN] });
    const { d } = deps();
    const answers = { ...RIGHT, [OPEN.id]: ANSWER };
    viewOf(await submitAttempt(d, w.client.id, "e-kulm", answers));
    const [attempt] = await stored(w.client.id);
    expect(await reviewAttempt(d, MARIA, attempt.id, { [OPEN.id]: { verdict: "fix", comment: "Lisa puhastamine." } })).toMatchObject({ kind: "reviewed", status: "fix" });
    await db.update(courseTests).set({ questions: [Q4] }).where(eq(courseTests.courseId, w.course.id));
    const rewritten = viewOf(await resubmitAnswers(d, w.client.id, "e-kulm", attempt.id, { ...answers, [OPEN.id]: "Puhastan, kuivatan ja määran kuju." }));
    expect(rewritten.last).toMatchObject({ id: attempt.id, status: "review" });
    expect(rewritten.last!.questions).toEqual(publicQuestions([Q1, Q2, OPEN]));
  });
});
