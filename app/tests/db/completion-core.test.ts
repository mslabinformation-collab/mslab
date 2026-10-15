import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, clientSessions, courseAccess, courseModules, courses, courseTests, lessonProgress, lessons, protocols, testAttempts, type TestQuestion } from "@/db/schema";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { accessFor, completeIfDone, completionJob, courseSetup, isActive, loadSteps, lockAccess, mailCompletion, stepInputs } from "@/server/completion";
import { saveProgress } from "@/server/lesson-data";
import type { Env } from "@/server/notify";
import { newToken, sha256 } from "@/server/token";
import { fakeKv, stubFetch } from "../fakes";
import { makeTestDb } from "./helpers";

// The e-course's completion core (e-course completion, spec §4.1, §4.4, §6, §8; §9 DB "completed_at set once by each path"): whose access a
// request is about, in any state; the course's test and points; the step inputs of one access; completed_at set once, in the caller's
// transaction when given one, never cleared; the lesson paths that complete a lessons-only course, and the "completed" mail after the answer.

const NOW = new Date("2026-10-13T09:00:00Z");
const DAY = 86_400_000;
const SITE = "https://mslab.example";
const Q1: TestQuestion = { id: "q0000001", kind: "choice", text: "Mitu kihti värvi kanname?", options: [{ id: "o0000011", text: "Ühe", correct: false }, { id: "o0000012", text: "Kaks", correct: true }] };

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

const env = (over: Partial<Env> = {}): Env => ({ KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, RESEND_API_KEY: "re_test", ...over });
type SentMail = { to: string; subject: string; text: string };
const mails = () => resend.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as SentMail);
const infoLog = () => vi.mocked(console.info).mock.calls.flat().join("\n");
const accessRow = async (id: number) => (await db.select().from(courseAccess).where(eq(courseAccess.id, id)))[0];

/**
 * The e-course "e-kulm" (ET and RU titles; `points` its protocol_stages) with one module of two text lessons (`video`: the second is a video
 * lesson of 100 s with a ready video), a course_tests row when `questions` is given, Kati (kati@example.com unless `email` says otherwise) with
 * six months of access, and her signed-in session.
 */
async function world(opts: { questions?: TestQuestion[]; points?: string[]; email?: string; locale?: "et" | "ru"; access?: Partial<typeof courseAccess.$inferInsert>; video?: boolean } = {}) {
  const [course] = await db
    .insert(courses)
    .values({ slug: "e-kulm", type: "e_learning", level: "basic", title: { et: "Kulmude e-koolitus", ru: "Онлайн-курс бровей" }, summary: { et: "" }, body: { et: "" }, price: 9500, published: true, protocolStages: opts.points ?? [] })
    .returning();
  const [m] = await db.insert(courseModules).values({ courseId: course.id, position: 1, title: { et: "Alustame" } }).returning();
  const [l1] = await db.insert(lessons).values({ moduleId: m.id, position: 1, title: { et: "Esimene" }, kind: "text" }).returning();
  const [l2] = opts.video
    ? await db.insert(lessons).values({ moduleId: m.id, position: 2, title: { et: "Teine" }, videoId: "22222222-2222-4222-8222-222222222222", videoStatus: "ready", durationSec: 100 }).returning()
    : await db.insert(lessons).values({ moduleId: m.id, position: 2, title: { et: "Teine" }, kind: "text" }).returning();
  if (opts.questions) await db.insert(courseTests).values({ courseId: course.id, questions: opts.questions });
  const [client] = await db.insert(clients).values({ email: opts.email ?? "kati@example.com", name: "Kati Kask", locale: opts.locale ?? "et" }).returning();
  const [access] = await db
    .insert(courseAccess)
    .values({ clientId: client.id, courseId: course.id, grantedBy: "maria@example.test", expiresAt: new Date(NOW.getTime() + 180 * DAY), ...opts.access })
    .returning();
  const raw = newToken();
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId: client.id, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
  return { course, l1, l2, client, access, cookie: `__Host-mslab_client=${raw}` };
}
const done = (clientId: number, lessonId: number) => db.insert(lessonProgress).values({ clientId, lessonId, doneAt: NOW });
const passed = (clientId: number, courseId: number) =>
  db.insert(testAttempts).values({ clientId, courseId, number: 1, questions: [Q1], answers: { [Q1.id]: ["o0000012"] }, correct: 1, total: 1, status: "passed", submittedAt: NOW });

/** The account API's deps; `flush` runs what was queued after the answer, as Next's after() does. */
function deps() {
  const tasks: (() => Promise<unknown>)[] = [];
  const d: AccountDeps = { db, env: env(), now: NOW, siteUrl: SITE, later: (task) => void tasks.push(task), dev: false };
  return { d, queued: () => tasks.length, flush: () => Promise.all(tasks.splice(0).map((task) => task())) };
}
const post = async (d: AccountDeps, cookie: string, path: string, body: unknown = {}) =>
  (await handleAccountApi(new Request(`${SITE}/api/konto${path}`, { method: "POST", headers: { cookie }, body: JSON.stringify(body) }), d))!;

describe("whose access", () => {
  test("accessFor finds her access to an e-course, with the course; never another client's, an unknown course or a contact course; lockAccess reads it in a transaction", async () => {
    const w = await world();
    expect(await accessFor(db, w.client.id, "e-kulm")).toEqual({
      id: w.access.id,
      clientId: w.client.id,
      courseId: w.course.id,
      expiresAt: w.access.expiresAt,
      revokedAt: null,
      extraTries: 0,
      completedAt: null,
      course: { id: w.course.id, slug: "e-kulm", title: { et: "Kulmude e-koolitus", ru: "Онлайн-курс бровей" } },
    });
    const [other] = await db.insert(clients).values({ email: "mari@example.com" }).returning();
    expect(await accessFor(db, other.id, "e-kulm")).toBeNull();
    expect(await accessFor(db, w.client.id, "pole-olemas")).toBeNull();
    const [contact] = await db.insert(courses).values({ slug: "kontakt", type: "contact", level: "basic", title: { et: "Kontakt" }, summary: { et: "" }, body: { et: "" } }).returning();
    await db.insert(courseAccess).values({ clientId: w.client.id, courseId: contact.id, grantedBy: "maria@example.test", expiresAt: new Date(NOW.getTime() + DAY) });
    expect(await accessFor(db, w.client.id, "kontakt")).toBeNull();
    expect(await db.transaction(async (tx) => lockAccess(tx as unknown as Db, w.access.id))).toMatchObject({ id: w.access.id, extraTries: 0, completedAt: null });
    expect(await db.transaction(async (tx) => lockAccess(tx as unknown as Db, 999_999))).toBeNull();
  });

  test("Review Focus 4: an expired access is found (her results stay readable) and still completes (Maria's approving assessment); a revoked one is found, never active, and never completes", async () => {
    const w = await world({ access: { expiresAt: new Date(NOW.getTime() - DAY) } });
    await done(w.client.id, w.l1.id);
    await done(w.client.id, w.l2.id);
    const expired = (await accessFor(db, w.client.id, "e-kulm"))!;
    expect(expired.id).toBe(w.access.id);
    expect(isActive(expired, NOW)).toBe(false);
    expect(await completeIfDone(db, w.access.id, NOW)).toBe(true);

    await db.update(courseAccess).set({ completedAt: null, revokedAt: NOW, expiresAt: new Date(NOW.getTime() + DAY) }).where(eq(courseAccess.id, w.access.id));
    const revoked = (await accessFor(db, w.client.id, "e-kulm"))!;
    expect(revoked.revokedAt).toEqual(NOW);
    expect(isActive(revoked, NOW)).toBe(false);
    expect(await completeIfDone(db, w.access.id, NOW)).toBe(false);
    expect((await accessRow(w.access.id)).completedAt).toBeNull();
    // her lesson pages answer 404 when it is not active: no lesson write, nothing completes from there
    expect((await post(deps().d, w.cookie, `/kursus/e-kulm/${w.l2.id}/tehtud`)).status).toBe(404);

    expect(isActive({ revokedAt: null, expiresAt: new Date(NOW.getTime() + 1) }, NOW)).toBe(true);
    expect(isActive({ revokedAt: null, expiresAt: NOW }, NOW)).toBe(false); // it ends at its moment, as activeAccess's `expires_at > now`
  });
});

describe("the course's test and points, and one access's steps (spec §4.1)", () => {
  test("courseSetup: without a course_tests row no questions, 80 % and 3 tries; with one its questions, mark and tries; the course's points as read", async () => {
    const w = await world({ points: [" Kulmude kuju ", "", "Värvimine"] });
    expect(await courseSetup(db, w.course.id)).toEqual({ questions: [], passPercent: 80, tries: 3, points: ["Kulmude kuju", "Värvimine"] });
    await db.insert(courseTests).values({ courseId: w.course.id, questions: [Q1], passPercent: 70, tries: 5 });
    expect(await courseSetup(db, w.course.id)).toEqual({ questions: [Q1], passPercent: 70, tries: 5, points: ["Kulmude kuju", "Värvimine"] });
  });

  test("stepInputs: the lessons, the attempts and the protocol of one access; the points are the protocol's own copy once it exists (spec §3.4)", async () => {
    const w = await world();
    expect(await stepInputs(db, await accessRow(w.access.id))).toEqual({
      lessonsDone: 0,
      lessonsTotal: 2,
      hasQuestions: false,
      test: { kind: "none", triesLeft: 3 },
      hasPoints: false,
      practical: "open",
      practicalRound: 0,
      completedAt: null,
    });
    await db.insert(courseTests).values({ courseId: w.course.id, questions: [Q1], tries: 2 });
    await db.update(courses).set({ protocolStages: ["Kulmude kuju", "Värvimine"] }).where(eq(courses.id, w.course.id));
    await done(w.client.id, w.l1.id);
    await done(w.client.id, w.l2.id);
    await passed(w.client.id, w.course.id);
    await db.insert(protocols).values({ accessId: w.access.id, stages: [{ title: "Kulmude kuju", note: "" }], round: 1, submittedAt: NOW });
    expect(await stepInputs(db, await accessRow(w.access.id))).toEqual({
      lessonsDone: 2,
      lessonsTotal: 2,
      hasQuestions: true,
      test: { kind: "passed" },
      hasPoints: true,
      practical: "review",
      practicalRound: 1,
      completedAt: null,
    });
    // the course's points changed after the protocol was made: the protocol's copy decides
    await db.update(courses).set({ protocolStages: [] }).where(eq(courses.id, w.course.id));
    expect((await stepInputs(db, await accessRow(w.access.id))).hasPoints).toBe(true);
    await db.update(protocols).set({ stages: [] }).where(eq(protocols.accessId, w.access.id));
    await db.update(courses).set({ protocolStages: ["Kulmude kuju"] }).where(eq(courses.id, w.course.id));
    expect((await stepInputs(db, await accessRow(w.access.id))).hasPoints).toBe(false); // a notes-only protocol made while the course had none
  });

  test("loadSteps: locked steps before the lessons, the test open after them; a completed lessons-only course: every step done, none it lacks", async () => {
    const w = await world({ questions: [Q1], points: ["Kulmude kuju"] });
    expect(await loadSteps(db, await accessRow(w.access.id))).toMatchObject({
      lessons: { done: 0, total: 2, state: "open" },
      test: { state: "locked" },
      practical: { state: "locked", round: 0 },
      completedAt: null,
    });
    await done(w.client.id, w.l1.id);
    await done(w.client.id, w.l2.id);
    expect((await loadSteps(db, await accessRow(w.access.id))).test).toMatchObject({ state: "open" });
    await db.delete(courseTests);
    await db.update(courses).set({ protocolStages: [] });
    await db.update(courseAccess).set({ completedAt: NOW });
    expect(await loadSteps(db, await accessRow(w.access.id))).toEqual({ lessons: { done: 2, total: 2, state: "done" }, test: null, practical: null, completedAt: NOW.toISOString() });
  });
});

describe("completeIfDone (spec §4.4)", () => {
  test("sets completed_at once, when every step the course has is done: true for the call that set it, false after; never while a step is open", async () => {
    const w = await world({ questions: [Q1] });
    await done(w.client.id, w.l1.id);
    await done(w.client.id, w.l2.id);
    expect(await completeIfDone(db, w.access.id, NOW)).toBe(false); // the test is still to pass
    expect((await accessRow(w.access.id)).completedAt).toBeNull();
    await passed(w.client.id, w.course.id);
    expect(await completeIfDone(db, w.access.id, NOW)).toBe(true);
    expect(await completeIfDone(db, w.access.id, new Date(NOW.getTime() + DAY))).toBe(false);
    expect((await accessRow(w.access.id)).completedAt).toEqual(NOW);
    expect(infoLog()).toContain(`[completion] access ${w.access.id}: completed`);
    expect(await completeIfDone(db, 999_999, NOW)).toBe(false);
  });

  test("a passed step stays passed: a lesson or questions added after the completion never clear it", async () => {
    const w = await world();
    await done(w.client.id, w.l1.id);
    await done(w.client.id, w.l2.id);
    expect(await completeIfDone(db, w.access.id, NOW)).toBe(true);
    const [m] = await db.select().from(courseModules);
    await db.insert(lessons).values({ moduleId: m.id, position: 3, title: { et: "Uus" }, kind: "text" });
    await db.insert(courseTests).values({ courseId: w.course.id, questions: [Q1] });
    expect(await completeIfDone(db, w.access.id, new Date(NOW.getTime() + DAY))).toBe(false);
    const access = await accessRow(w.access.id);
    expect(access.completedAt).toEqual(NOW);
    expect(await loadSteps(db, access)).toMatchObject({ lessons: { state: "done" }, test: { state: "done" }, completedAt: NOW.toISOString() });
  });

  test("a revoke landing between its read and its UPDATE completes nothing (the UPDATE carries revoked_at is null)", async () => {
    const w = await world();
    await done(w.client.id, w.l1.id);
    await done(w.client.id, w.l2.id);
    // The statement runs when it is awaited: revoke the access just before the guarded UPDATE does.
    const racing = {
      ...db,
      select: db.select.bind(db),
      update: (table: Parameters<Db["update"]>[0]) => {
        const builder = db.update(table);
        return {
          set: (values: Parameters<typeof builder.set>[0]) => {
            const set = builder.set(values);
            return {
              where: (condition: Parameters<typeof set.where>[0]) => {
                const where = set.where(condition);
                return {
                  returning: async () => {
                    await db.update(courseAccess).set({ revokedAt: NOW }).where(eq(courseAccess.id, w.access.id));
                    return where.returning();
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as Db;
    expect(await completeIfDone(racing, w.access.id, NOW)).toBe(false);
    const access = await accessRow(w.access.id);
    expect(access.revokedAt).toEqual(NOW);
    expect(access.completedAt).toBeNull();
    expect(infoLog()).not.toContain("completed");
  });

  test("inside the caller's transaction: it is rolled back with it", async () => {
    const w = await world();
    await done(w.client.id, w.l1.id);
    await done(w.client.id, w.l2.id);
    await expect(
      db.transaction(async (tx) => {
        expect(await completeIfDone(tx as unknown as Db, w.access.id, NOW)).toBe(true);
        tx.rollback();
      }),
    ).rejects.toThrow();
    expect((await accessRow(w.access.id)).completedAt).toBeNull();
  });
});

describe("the lesson paths complete a course (spec §4.4)", () => {
  test("“Märgi tehtuks” on the last lesson of a lessons-only course completes it; the answer is as before; the 'completed' mail goes once, after the answer", async () => {
    const w = await world();
    const { d, queued, flush } = deps();
    expect(await (await post(d, w.cookie, `/kursus/e-kulm/${w.l1.id}/tehtud`)).json()).toEqual({ ok: true, done: true, next: w.l2.id });
    expect(queued()).toBe(0);
    expect((await accessRow(w.access.id)).completedAt).toBeNull();
    expect(await (await post(d, w.cookie, `/kursus/e-kulm/${w.l2.id}/tehtud`)).json()).toEqual({ ok: true, done: true, next: null });
    expect((await accessRow(w.access.id)).completedAt).toEqual(NOW);
    expect(mails()).toEqual([]); // nothing is mailed before the answer
    expect(queued()).toBe(1);
    await flush();
    const [mail] = mails();
    expect(mail.to).toBe("kati@example.com");
    expect(mail.subject).toContain("Palju õnne!");
    expect(mail.subject).toContain("Kulmude e-koolitus");
    expect(mail.text).toContain(`${SITE}/konto/kursus/e-kulm`);
    expect(mail.text).not.toContain("/praktiline"); // a course without points: the link opens the course
    // marked again (a second tab): done already, nothing completes again, no second mail
    expect((await post(d, w.cookie, `/kursus/e-kulm/${w.l2.id}/tehtud`)).status).toBe(200);
    expect(queued()).toBe(0);
    expect(mails()).toHaveLength(1);
  });

  test("a course with a test is not completed by its lessons; a sample address completes without a mail", async () => {
    const w = await world({ questions: [Q1] });
    const { d, queued } = deps();
    await post(d, w.cookie, `/kursus/e-kulm/${w.l1.id}/tehtud`);
    await post(d, w.cookie, `/kursus/e-kulm/${w.l2.id}/tehtud`);
    expect((await accessRow(w.access.id)).completedAt).toBeNull();
    expect(queued()).toBe(0);

    await db.delete(courseTests);
    await db.delete(lessonProgress);
    await db.update(clients).set({ email: "kati@example.test" });
    const sample = deps();
    await post(sample.d, w.cookie, `/kursus/e-kulm/${w.l1.id}/tehtud`);
    await post(sample.d, w.cookie, `/kursus/e-kulm/${w.l2.id}/tehtud`);
    expect((await accessRow(w.access.id)).completedAt).toEqual(NOW);
    await sample.flush();
    expect(mails()).toEqual([]);
  });

  test("the video report that reaches 90 % on the last lesson completes it too; a later report does not again", async () => {
    const w = await world({ video: true });
    await done(w.client.id, w.l1.id);
    await db.insert(lessonProgress).values({ clientId: w.client.id, lessonId: w.l2.id, clockAt: new Date(NOW.getTime() - 3_600_000) }); // opened an hour ago
    const { d, queued } = deps();
    expect(await (await post(d, w.cookie, `/kursus/e-kulm/${w.l2.id}/progress`, { watchedSec: 95 })).json()).toEqual({ ok: true, done: true, next: null });
    expect((await accessRow(w.access.id)).completedAt).toEqual(NOW);
    expect(queued()).toBe(1);
    expect(await saveProgress(db, w.client.id, "e-kulm", w.l2.id, 100, NOW)).toEqual({ kind: "saved", done: true, next: null, completed: false, accessId: w.access.id });
  });
});

describe("the 'completed' mail (spec §6)", () => {
  test("completionJob: her address, name and language and the course; hasPoints from the protocol's copy once there is one; whether the access is active at `now`", async () => {
    const w = await world({ locale: "ru", points: ["Kulmude kuju"] });
    expect(await completionJob(db, w.access.id, NOW)).toEqual({
      accessId: w.access.id,
      email: "kati@example.com",
      name: "Kati Kask",
      locale: "ru",
      slug: "e-kulm",
      course: { et: "Kulmude e-koolitus", ru: "Онлайн-курс бровей" },
      hasPoints: true,
      active: true,
    });
    await db.insert(protocols).values({ accessId: w.access.id, stages: [] });
    expect((await completionJob(db, w.access.id, NOW))!.hasPoints).toBe(false);
    expect(await completionJob(db, 999_999, NOW)).toBeNull();
    // ended at `now` (expires_at > now is active, as everywhere), or revoked: not active
    expect((await completionJob(db, w.access.id, new Date(NOW.getTime() + 180 * DAY)))!.active).toBe(false);
    await db.update(courseAccess).set({ revokedAt: NOW }).where(eq(courseAccess.id, w.access.id));
    expect((await completionJob(db, w.access.id, NOW))!.active).toBe(false);
  });

  test("I-1: mailCompletion of an access that is not active: the certificate's line goes to the dashboard, an active one's to the course page", async () => {
    const w = await world({ points: ["Kulmude kuju"], access: { expiresAt: new Date(NOW.getTime() - DAY) } });
    await mailCompletion(env(), SITE, (await completionJob(db, w.access.id, NOW))!, "completed");
    await db.update(courseAccess).set({ expiresAt: new Date(NOW.getTime() + DAY) }).where(eq(courseAccess.id, w.access.id));
    await mailCompletion(env(), SITE, (await completionJob(db, w.access.id, NOW))!, "completed");
    const [ended, active] = mails();
    expect(ended.text).toContain(`Kinnita oma nimi ja laadi tunnistus alla:\n${SITE}/konto\n`);
    expect(active.text).toContain(`Kinnita oma nimi ja laadi tunnistus alla:\n${SITE}/konto/kursus/e-kulm\n`);
  });

  test("mailCompletion: in her language, linking the practical page of a course with points; never to a sample address, nothing without Resend", async () => {
    const w = await world({ locale: "ru", points: ["Kulmude kuju"] });
    const job = (await completionJob(db, w.access.id, NOW))!;
    await mailCompletion(env(), SITE, job, "completed");
    const [mail] = mails();
    expect(mail.to).toBe("kati@example.com");
    expect(mail.subject).toContain("Поздравляем!");
    expect(mail.text).toContain("/konto/kursus/e-kulm/praktiline");
    expect(infoLog()).toContain(`[completion] access ${w.access.id}: the completed mail sent`);
    await mailCompletion(env(), SITE, { ...job, email: "kati@example.test" }, "completed");
    await mailCompletion(env({ RESEND_API_KEY: undefined }), SITE, job, "completed");
    expect(mails()).toHaveLength(1);
  });
});
