import { eq } from "drizzle-orm";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, clientSessions, courseAccess, courseModules, courses, courseTests, lessonProgress, lessons, protocols, testAttempts, type TestQuestion } from "@/db/schema";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { loadDashboard, loadEcourse, type EcourseView as EcourseData } from "@/server/client-data";
import { completeIfDone } from "@/server/completion";
import type { Env } from "@/server/notify";
import { newToken, sha256 } from "@/server/token";
import { fakeKv, stubFetch } from "../fakes";
import { makeTestDb } from "./helpers";

// "Lõpetamine" and "Lõpetatud" (e-course completion, spec §4.1, §4.3, §4.4) against a real (PGlite) database: the e-course page's data
// carries the path's steps (server/completion.ts loadSteps) as the student walks it, a skipped step is null, "Vaata protokolli" only for an
// e-course without points whose notes Maria sent; the dashboard's card carries completed_at, also after the access ended; and Maria's
// read-only view of the course shows the steps with their links inert. The student's own page load completes a course whose last step was
// done before (it heals a missed completion), never an empty one, and a failed check never fails a lesson.

const state = vi.hoisted(() => ({ db: null as unknown, completeIfDone: null as null | (() => Promise<boolean>) }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/auth")>()), requireAdmin: async () => "maria@example.test" }));
// completeIfDone as it is, unless a test sets `state.completeIfDone` (a check that fails)
vi.mock("@/server/completion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/completion")>();
  return { ...actual, completeIfDone: (...args: Parameters<typeof actual.completeIfDone>) => (state.completeIfDone ? state.completeIfDone() : actual.completeIfDone(...args)) };
});

import ViewCoursePage from "@/app/admin/(panel)/opilased/[id]/vaade/[slug]/page";
import { EcourseView } from "@/components/account/EcourseView";

const NOW = new Date("2026-11-14T10:00:00Z");
const DAY = 86_400_000;
const SITE = "https://mslab.example";
const POINTS = ["Ettevalmistus", "Värvimine"];
const QUESTION: TestQuestion = {
  id: "q1aaaaaa",
  kind: "choice",
  text: "Millest alustad kulmude kuju määramist?",
  options: [
    { id: "o1aaaaaa", text: "Näo proportsioonidest", correct: true },
    { id: "o2aaaaaa", text: "Juuste värvist", correct: false },
  ],
};

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  state.completeIfDone = null;
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An e-course of two text lessons with the test (one choice question) unless `questions` is false and these `points`; Kati (Russian) with six months of access. */
async function world(over: { questions?: boolean; points?: string[] } = {}) {
  const base = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };
  const [course] = await db
    .insert(courses)
    .values({ ...base, slug: "veebikursus", type: "e_learning", title: { et: "Veebikursus", ru: "Онлайн-курс" }, price: 9500, published: true, protocolStages: over.points ?? POINTS })
    .returning();
  if (over.questions !== false) await db.insert(courseTests).values({ courseId: course.id, questions: [QUESTION] });
  const [m] = await db.insert(courseModules).values({ courseId: course.id, position: 1, title: { et: "Teooria" } }).returning();
  const [l1] = await db.insert(lessons).values({ moduleId: m.id, position: 1, title: { et: "Üks" }, kind: "text" }).returning();
  const [l2] = await db.insert(lessons).values({ moduleId: m.id, position: 2, title: { et: "Kaks" }, kind: "text" }).returning();
  const [kati] = await db.insert(clients).values({ email: "kati@example.test", name: "Kati Tamm", locale: "ru" }).returning();
  const [access] = await db.insert(courseAccess).values({ clientId: kati.id, courseId: course.id, grantedBy: "admin@example.test", expiresAt: new Date(NOW.getTime() + 180 * DAY) }).returning();
  return { course, l1, l2, kati, access };
}
type World = Awaited<ReturnType<typeof world>>;

const lessonsDone = (w: World) => db.insert(lessonProgress).values([w.l1, w.l2].map((l) => ({ clientId: w.kati.id, lessonId: l.id, doneAt: NOW })));
const completionOf = async (w: World) => (await loadEcourse(db, w.kati.id, "veebikursus", NOW))!.completion;

describe("the e-course page's steps (loadEcourse)", () => {
  test("they follow her path: lessons, the test, the practical work; a set completed_at makes every step done", async () => {
    const w = await world();
    expect(await completionOf(w)).toMatchObject({
      lessons: { done: 0, total: 2, state: "open" },
      test: { state: "locked" },
      practical: { state: "locked", round: 0 },
      completedAt: null,
      protocolSent: false,
    });
    await lessonsDone(w);
    expect(await completionOf(w)).toMatchObject({ lessons: { done: 2, total: 2, state: "done" }, test: { state: "open", triesLeft: 3 }, practical: { state: "locked" } });
    await db.insert(testAttempts).values({
      clientId: w.kati.id, courseId: w.course.id, number: 1, questions: [QUESTION], answers: { [QUESTION.id]: ["o1aaaaaa"] }, correct: 1, total: 1, status: "passed", submittedAt: NOW,
    });
    expect(await completionOf(w)).toMatchObject({ test: { state: "done" }, practical: { state: "open", round: 0 } });
    await db.insert(protocols).values({ accessId: w.access.id, stages: POINTS.map((title) => ({ title, note: "" })), round: 1, submittedAt: NOW });
    expect(await completionOf(w)).toMatchObject({ practical: { state: "review", round: 1 } });
    await db.update(courseAccess).set({ completedAt: NOW }).where(eq(courseAccess.id, w.access.id));
    expect(await completionOf(w)).toMatchObject({
      lessons: { state: "done" },
      test: { state: "done" },
      practical: { state: "done" },
      completedAt: NOW.toISOString(),
      protocolSent: false,
    });
  });

  test("a course without questions has no test step, one without points no practical step (null: the block skips them)", async () => {
    const w = await world({ questions: false, points: [] });
    expect(await completionOf(w)).toMatchObject({ lessons: { done: 0, total: 2, state: "open" }, test: null, practical: null, completedAt: null });
  });

  test("'Vaata protokolli' (protocolSent): only for an e-course without points, and only once Maria has sent its notes", async () => {
    const w = await world({ points: [] });
    expect((await completionOf(w)).protocolSent).toBe(false);
    const [p] = await db.insert(protocols).values({ accessId: w.access.id, stages: [], generalNote: "Tubli!" }).returning();
    expect((await completionOf(w)).protocolSent).toBe(false); // a draft
    await db.update(protocols).set({ sent: { stages: [], generalNote: "Tubli!" }, sentAt: NOW, sentVersion: 1 }).where(eq(protocols.id, p.id));
    expect((await completionOf(w)).protocolSent).toBe(true);
    // the protocol's own copy of the points decides once it exists (spec §3.4: a later change reaches only protocols not created yet)
    await db.update(courses).set({ protocolStages: POINTS }).where(eq(courses.id, w.course.id));
    expect(await completionOf(w)).toMatchObject({ practical: null, protocolSent: true });
  });

  test("with points the practical work is the protocol: a sent assessment has its own step, never 'Vaata protokolli'", async () => {
    const w = await world();
    await lessonsDone(w);
    await db.insert(protocols).values({
      accessId: w.access.id,
      stages: POINTS.map((title) => ({ title, note: "" })),
      round: 1,
      submittedAt: NOW,
      sentRound: 1,
      verdicts: ["ok", "fix"],
      sent: { stages: POINTS.map((title) => ({ title, note: "" })), generalNote: "", verdicts: ["ok", "fix"] },
      sentAt: NOW,
      sentVersion: 1,
    });
    expect(await completionOf(w)).toMatchObject({ practical: { round: 1 }, protocolSent: false });
  });

  test("the page stays for an active access only, as before: a completed course whose access ended has no page (its card keeps the date)", async () => {
    const w = await world();
    await db.update(courseAccess).set({ completedAt: NOW, expiresAt: new Date(NOW.getTime() - DAY) }).where(eq(courseAccess.id, w.access.id));
    expect(await loadEcourse(db, w.kati.id, "veebikursus", NOW)).toBeNull();
    await db.update(courseAccess).set({ expiresAt: new Date(NOW.getTime() + DAY), revokedAt: NOW }).where(eq(courseAccess.id, w.access.id));
    expect(await loadEcourse(db, w.kati.id, "veebikursus", NOW)).toBeNull();
  });
});

describe("the card's 'Lõpetatud' (loadDashboard)", () => {
  test("completedAt: null before, the date after, and still there once the access has ended", async () => {
    const w = await world();
    const card = async () => (await loadDashboard(db, w.kati.id, NOW))!.cards[0];
    expect(await card()).toMatchObject({ kind: "ecourse", completedAt: null });
    await db.update(courseAccess).set({ completedAt: NOW }).where(eq(courseAccess.id, w.access.id));
    expect(await card()).toMatchObject({ kind: "ecourse", completedAt: NOW.toISOString() });
    await db.update(courseAccess).set({ expiresAt: new Date(NOW.getTime() - DAY) }).where(eq(courseAccess.id, w.access.id));
    const ended = await card();
    expect(ended).toMatchObject({ kind: "ecourse", completedAt: NOW.toISOString() });
    expect(ended).not.toHaveProperty("progress");
  });
});

/** The EcourseView element in a page's tree (depth first): the one whose `data` carries the course's `completion`. */
function findView(node: ReactNode): Parameters<typeof EcourseView>[0] | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findView(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as { data?: { completion?: unknown }; children?: ReactNode };
  if (props.data && "completion" in props.data) return node.props as Parameters<typeof EcourseView>[0];
  return findView(props.children);
}

describe("Maria's read-only view of the course (Vaata tema vaadet)", () => {
  test("her copy carries the steps, and their links are inert, like 'Jätka'", async () => {
    const w = await world();
    await lessonsDone(w);
    // the page reads the real clock (loadEcourse(…, new Date())): an access ending far ahead keeps this test from failing once NOW + 180 days has passed
    await db.update(courseAccess).set({ expiresAt: new Date("2099-01-01T00:00:00Z") }).where(eq(courseAccess.id, w.access.id));
    const tree = await ViewCoursePage({ params: Promise.resolve({ id: String(w.kati.id), slug: "veebikursus" }) });
    const props = findView(tree);
    expect(props, "the EcourseView with the course").not.toBeNull();
    expect(props!.readOnly).toBe(true);
    expect((props!.data as EcourseData).completion).toMatchObject({ test: { state: "open" } });
    const html = renderToStaticMarkup(createElement(EcourseView, props!));
    expect(html).toContain('data-completion=""');
    expect(html).not.toContain("<a ");
    expect(html).toMatch(/<span[^>]*aria-disabled="true"[^>]*data-step-link=""[^>]*>Открыть тест/); // her language: Kati reads Russian
  });

  test("it only reads: a course whose lessons are all done is not completed by Maria looking at it", async () => {
    const w = await world({ questions: false, points: [] });
    await lessonsDone(w);
    await db.update(courseAccess).set({ expiresAt: new Date("2099-01-01T00:00:00Z") }).where(eq(courseAccess.id, w.access.id));
    const props = findView(await ViewCoursePage({ params: Promise.resolve({ id: String(w.kati.id), slug: "veebikursus" }) }));
    expect((props!.data as EcourseData).completion.completedAt).toBeNull();
    expect((await db.select().from(courseAccess).where(eq(courseAccess.id, w.access.id)))[0].completedAt).toBeNull();
  });
});

// ---------- the student's page load and the lesson paths ----------

const env = (): Env => ({ KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, RESEND_API_KEY: "re_test" });
const accessRow = async (w: World) => (await db.select().from(courseAccess).where(eq(courseAccess.id, w.access.id)))[0];

/** Kati's signed-in session and the account API's deps (her address one a mail goes to); `flush` runs what was queued after the answer, as Next's after() does. */
async function signedIn(w: World) {
  const resend = stubFetch((url) => (url.includes("resend") ? Response.json({ id: "email_1" }) : Response.json({})));
  await db.update(clients).set({ email: "kati@example.com" }).where(eq(clients.id, w.kati.id));
  const raw = newToken();
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId: w.kati.id, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
  const tasks: (() => Promise<unknown>)[] = [];
  const d: AccountDeps = { db, env: env(), now: NOW, siteUrl: SITE, later: (task) => void tasks.push(task), dev: false };
  const cookie = `__Host-mslab_client=${raw}`;
  return {
    queued: () => tasks.length,
    flush: () => Promise.all(tasks.splice(0).map((task) => task())),
    mails: () => resend.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as { to: string; subject: string }),
    get: async (path: string) => (await handleAccountApi(new Request(`${SITE}/api/konto${path}`, { headers: { cookie } }), d))!,
    post: async (path: string, body: unknown = {}) => (await handleAccountApi(new Request(`${SITE}/api/konto${path}`, { method: "POST", headers: { cookie }, body: JSON.stringify(body) }), d))!,
  };
}
const errorLog = () => vi.mocked(console.error).mock.calls.flat().join("\n");

describe("completion on the page load (the student's GET /kursus/:slug)", () => {
  test("a lessons-only course whose lessons were all done before completes on the page's GET and queues exactly one mail; a second GET queues none", async () => {
    const w = await world({ questions: false, points: [] });
    await lessonsDone(w);
    const s = await signedIn(w);
    expect((await accessRow(w)).completedAt).toBeNull();
    const first = await s.get("/kursus/veebikursus");
    expect(first.status).toBe(200);
    expect((await first.json()).completion).toMatchObject({ completedAt: NOW.toISOString(), lessons: { state: "done" }, test: null, practical: null });
    expect((await accessRow(w)).completedAt).toEqual(NOW);
    expect(s.queued()).toBe(1);
    expect(s.mails()).toEqual([]); // after the answer
    await s.flush();
    expect(s.mails()).toHaveLength(1);
    expect(s.mails()[0].to).toBe("kati@example.com");
    const second = await s.get("/kursus/veebikursus");
    expect((await second.json()).completion.completedAt).toBe(NOW.toISOString());
    expect(s.queued()).toBe(0);
    expect(s.mails()).toHaveLength(1);
  });

  test("a course with a step still to do is not completed by the load", async () => {
    const w = await world();
    await lessonsDone(w); // the test is still to pass
    const s = await signedIn(w);
    expect((await (await s.get("/kursus/veebikursus")).json()).completion).toMatchObject({ completedAt: null, test: { state: "open" } });
    expect((await accessRow(w)).completedAt).toBeNull();
    expect(s.queued()).toBe(0);
  });

  test("an access that has ended has no page, so the load completes nothing there", async () => {
    const w = await world({ questions: false, points: [] });
    await lessonsDone(w);
    await db.update(courseAccess).set({ expiresAt: new Date(NOW.getTime() - DAY) }).where(eq(courseAccess.id, w.access.id));
    const s = await signedIn(w);
    expect((await s.get("/kursus/veebikursus")).status).toBe(404);
    expect((await accessRow(w)).completedAt).toBeNull();
    expect(s.queued()).toBe(0);
  });

  test("never an empty course: with no visible lesson, no question and no point nothing completes, not by completeIfDone, not on the page load", async () => {
    const w = await world({ questions: false, points: [] });
    await db.update(lessons).set({ hidden: true });
    expect(await completeIfDone(db, w.access.id, NOW)).toBe(false);
    const s = await signedIn(w);
    const res = await s.get("/kursus/veebikursus");
    expect(res.status).toBe(200);
    expect((await res.json()).completion).toMatchObject({ lessons: { total: 0 }, test: null, practical: null, completedAt: null });
    expect((await accessRow(w)).completedAt).toBeNull();
    expect(s.queued()).toBe(0);
    await db.delete(lessons); // and no lesson at all
    expect(await completeIfDone(db, w.access.id, NOW)).toBe(false);
    expect((await accessRow(w)).completedAt).toBeNull();
  });

  test("a check that fails does not fail the page: it shows as before, the failure logged by the access's id", async () => {
    const w = await world({ questions: false, points: [] });
    await lessonsDone(w);
    const s = await signedIn(w);
    state.completeIfDone = async () => {
      throw new Error("boom kati@example.com");
    };
    const res = await s.get("/kursus/veebikursus");
    expect(res.status).toBe(200);
    expect((await res.json()).completion).toMatchObject({ lessons: { state: "done" }, completedAt: null });
    expect(errorLog()).toContain(`[completion] access ${w.access.id}: the check failed`);
    expect(errorLog()).not.toContain("kati@example.com");
    expect(s.queued()).toBe(0);
    state.completeIfDone = null;
    expect((await (await s.get("/kursus/veebikursus")).json()).completion.completedAt).toBe(NOW.toISOString()); // the next load heals it
    expect(s.queued()).toBe(1);
  });
});

describe("a failed completion check does not fail the lesson", () => {
  const failingCheck = () => {
    state.completeIfDone = async () => {
      throw new Error("boom kati@example.com");
    };
  };

  test("“Märgi tehtuks”: the lesson is saved and answered as before, not completed, the failure logged by the access's id; the page load heals it", async () => {
    const w = await world({ questions: false, points: [] });
    const s = await signedIn(w);
    expect((await s.post(`/kursus/veebikursus/${w.l1.id}/tehtud`)).status).toBe(200);
    failingCheck();
    const res = await s.post(`/kursus/veebikursus/${w.l2.id}/tehtud`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, done: true, next: null });
    expect((await db.select().from(lessonProgress).where(eq(lessonProgress.lessonId, w.l2.id)))[0].doneAt).toEqual(NOW);
    expect((await accessRow(w)).completedAt).toBeNull();
    expect(s.queued()).toBe(0);
    expect(errorLog()).toContain(`[completion] access ${w.access.id}: the check failed`);
    expect(errorLog()).not.toContain("kati@example.com");
    state.completeIfDone = null;
    await s.get("/kursus/veebikursus");
    expect((await accessRow(w)).completedAt).toEqual(NOW);
    expect(s.queued()).toBe(1);
  });

  test("the video report that reaches 90 %: the progress is saved and answered as before, not completed", async () => {
    const w = await world({ questions: false, points: [] });
    await db.update(lessons).set({ kind: "video", videoId: "22222222-2222-4222-8222-222222222222", videoStatus: "ready", durationSec: 100 }).where(eq(lessons.id, w.l2.id));
    await db.insert(lessonProgress).values([
      { clientId: w.kati.id, lessonId: w.l1.id, doneAt: NOW },
      { clientId: w.kati.id, lessonId: w.l2.id, clockAt: new Date(NOW.getTime() - 3_600_000) }, // opened an hour ago
    ]);
    const s = await signedIn(w);
    failingCheck();
    const res = await s.post(`/kursus/veebikursus/${w.l2.id}/progress`, { watchedSec: 95 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, done: true, next: null });
    expect((await db.select().from(lessonProgress).where(eq(lessonProgress.lessonId, w.l2.id)))[0]).toMatchObject({ watchedSec: 95, doneAt: NOW });
    expect((await accessRow(w)).completedAt).toBeNull();
    expect(s.queued()).toBe(0);
    expect(errorLog()).toContain(`[completion] access ${w.access.id}: the check failed`);
  });
});
