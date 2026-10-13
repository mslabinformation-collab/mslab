import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, clientSessions, courseAccess, courses, courseTests, lessonProgress, lessons, testAttempts, type TestQuestion } from "@/db/schema";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { newToken, sha256 } from "@/server/token";
import { fakeKv } from "../fakes";
import { addModules, makeTestDb } from "./helpers";

// The student's test through the account API (e-course completion, spec §4.2, §7): GET /api/konto/kursus/<slug>/test, POST …/test (a new
// attempt) and POST …/test/uuesti (Maria's "Paranda" answers rewritten). Matched before the lesson paths, which would read "test" as a
// lesson id; the answer key never leaves the server; a revoked access is 404, an expired one read-only; 10 submits an hour.

const NOW = new Date("2026-10-13T10:00:00Z");
const SITE = "https://mslab.example";
const DAY = 86_400_000;
const QUESTIONS: TestQuestion[] = [
  {
    id: "q1choice",
    kind: "choice",
    text: "Mis värvi kasutad heledatel kulmudel?",
    options: [
      { id: "o1right0", text: "Helepruun", correct: true },
      { id: "o1wrong0", text: "Must", correct: false },
    ],
  },
  {
    id: "q2multi0",
    kind: "choice",
    text: "Mis kuulub ettevalmistusse?",
    options: [
      { id: "o2a00000", text: "Puhastus", correct: true },
      { id: "o2b00000", text: "Kaitsekreem", correct: true },
      { id: "o2c00000", text: "Kohv", correct: false },
    ],
  },
];
const OPEN: TestQuestion = { id: "q3open00", kind: "open", text: "Kirjelda, kuidas valmistad kulmud ette." };
/** Both choice questions right. */
const RIGHT = { q1choice: ["o1right0"], q2multi0: ["o2a00000", "o2b00000"] };
/** One of the two right: 50 %, under the pass mark of 80. */
const HALF = { q1choice: ["o1wrong0"], q2multi0: ["o2a00000", "o2b00000"] };

let db: Db;
let kv: ReturnType<typeof fakeKv>;
beforeEach(async () => {
  db = await makeTestDb();
  kv = fakeKv();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** No Resend key: whatever the handlers queue for after the answer never mails (and `later` drops it). */
const deps = (): AccountDeps => ({
  db,
  env: { KV: kv, MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE },
  now: NOW,
  siteUrl: SITE,
  later: () => {},
  dev: false,
});

type World = { questions?: TestQuestion[] | null; points?: string[]; lessonsDone?: boolean; access?: Partial<typeof courseAccess.$inferInsert> };

/**
 * The e-course "veebikursus" (one text lesson; `questions` in course_tests with the pass mark 80 and 3 tries, none for null; two points),
 * Kati signed in with six months of access and her lesson done (unless `lessonsDone: false`).
 */
async function world(o: World = {}) {
  const [course] = await db
    .insert(courses)
    .values({ slug: "veebikursus", type: "e_learning", level: "basic", title: { et: "Veebikursus", ru: "Онлайн-курс" }, summary: { et: "" }, body: { et: "" }, published: true, price: 9500, protocolStages: o.points ?? ["Ettevalmistus", "Tulemus"] })
    .returning();
  const [mod] = await addModules(db, course.id, [{ et: "Moodul" }]);
  const [lesson] = await db.insert(lessons).values({ moduleId: mod.id, position: 1, title: { et: "Tekst" }, kind: "text" }).returning();
  if (o.questions !== null) await db.insert(courseTests).values({ courseId: course.id, questions: o.questions ?? QUESTIONS, passPercent: 80, tries: 3 });
  const [client] = await db.insert(clients).values({ email: "kati@example.test", name: "Kati Kask" }).returning();
  const [access] = await db
    .insert(courseAccess)
    .values({ clientId: client.id, courseId: course.id, grantedBy: "admin@example.test", expiresAt: new Date(NOW.getTime() + 180 * DAY), ...o.access })
    .returning();
  if (o.lessonsDone !== false) await db.insert(lessonProgress).values({ clientId: client.id, lessonId: lesson.id, doneAt: NOW });
  const raw = newToken();
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId: client.id, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
  return { course, lesson, client, access, cookie: `__Host-mslab_client=${raw}` };
}

/** One request to /api/konto<path>: GET without a body, POST with one (a string goes as it is), or `method`. */
async function call(cookie: string | null, path: string, body?: unknown, method?: string): Promise<Response> {
  const init: RequestInit = {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: cookie ? { cookie } : {},
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  };
  return (await handleAccountApi(new Request(`${SITE}/api/konto${path}`, init), deps()))!;
}
const attempts = () => db.select().from(testAttempts);

describe("GET /kursus/:slug/test", () => {
  test("the questions without their answer key (more than one right option says so), the state and the tries; private and never cached", async () => {
    const w = await world();
    const res = await call(w.cookie, "/kursus/veebikursus/test");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      course: { slug: "veebikursus", title: { et: "Veebikursus", ru: "Онлайн-курс" } },
      state: { kind: "none", triesLeft: 3 },
      passPercent: 80,
      triesLeft: 3,
      last: null,
      locked: false,
      readOnly: false,
      hasPoints: true,
    });
    expect(body.questions).toEqual([
      { id: "q1choice", kind: "choice", text: "Mis värvi kasutad heledatel kulmudel?", options: [{ id: "o1right0", text: "Helepruun" }, { id: "o1wrong0", text: "Must" }], multiple: false },
      {
        id: "q2multi0",
        kind: "choice",
        text: "Mis kuulub ettevalmistusse?",
        options: [{ id: "o2a00000", text: "Puhastus" }, { id: "o2b00000", text: "Kaitsekreem" }, { id: "o2c00000", text: "Kohv" }],
        multiple: true,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("correct");
  });

  test("the lessons not done and no attempt yet: locked, and a submit is refused as closed with nothing stored", async () => {
    const w = await world({ lessonsDone: false });
    expect(await (await call(w.cookie, "/kursus/veebikursus/test")).json()).toMatchObject({ ok: true, locked: true });
    const res = await call(w.cookie, "/kursus/veebikursus/test", { answers: RIGHT });
    expect([res.status, await res.json()]).toEqual([409, { ok: false, error: "closed" }]);
    expect(await attempts()).toEqual([]);
  });

  test("no such course, a slug that cannot be one, a contact course, a revoked access: 404; without a session: 401", async () => {
    const w = await world();
    for (const path of ["/kursus/olematu/test", "/kursus/Veebi_Kursus/test"]) {
      const res = await call(w.cookie, path);
      expect([res.status, await res.json()], path).toEqual([404, { ok: false }]);
    }
    const [contact] = await db.insert(courses).values({ slug: "kulmud", type: "contact", level: "basic", title: { et: "Kulmud" }, summary: { et: "" }, body: { et: "" }, published: true, price: 35000 }).returning();
    await db.insert(courseAccess).values({ clientId: w.client.id, courseId: contact.id, grantedBy: "admin@example.test", expiresAt: new Date(NOW.getTime() + DAY) });
    await db.insert(courseTests).values({ courseId: contact.id, questions: QUESTIONS });
    expect((await call(w.cookie, "/kursus/kulmud/test")).status).toBe(404);
    expect((await call(null, "/kursus/veebikursus/test")).status).toBe(401);
    await db.update(courseAccess).set({ revokedAt: NOW }).where(eq(courseAccess.id, w.access.id));
    expect((await call(w.cookie, "/kursus/veebikursus/test")).status).toBe(404);
    expect((await call(w.cookie, "/kursus/veebikursus/test", { answers: RIGHT })).status).toBe(404);
    expect(await attempts()).toEqual([]);
  });

  test("a course without questions has no test: 404", async () => {
    const w = await world({ questions: null });
    expect((await call(w.cookie, "/kursus/veebikursus/test")).status).toBe(404);
  });

  test("the test's paths come before the lesson paths: a lesson still opens; a method or a path the test does not have is 404", async () => {
    const w = await world();
    expect((await call(w.cookie, `/kursus/veebikursus/${w.lesson.id}`)).status).toBe(200);
    const cases = [
      ["/kursus/veebikursus/test/uuesti", "GET"],
      ["/kursus/veebikursus/test", "PATCH"],
      ["/kursus/veebikursus/test", "DELETE"],
      ["/kursus/veebikursus/test/x", "POST"],
    ] as const;
    for (const [path, method] of cases) {
      const res = await call(w.cookie, path, method === "GET" ? undefined : {}, method);
      expect([res.status, await res.json()], `${method} ${path}`).toEqual([404, { ok: false }]);
    }
  });
});

describe("POST /kursus/:slug/test", () => {
  test("a failed attempt: the score and the numbers of the wrong choice questions, never the right options; one try used", async () => {
    const w = await world();
    const res = await call(w.cookie, "/kursus/veebikursus/test", { answers: HALF });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, state: { kind: "open", triesLeft: 2 }, triesLeft: 2, last: { number: 1, status: "failed", percent: 50, wrong: [1], answers: HALF } });
    expect(JSON.stringify(body)).not.toContain("correct");
    expect((await attempts()).map((a) => [a.number, a.status, a.correct, a.total])).toEqual([[1, "failed", 1, 2]]);
    // a double tap, or the answer lost on a weak signal and sent again: the same answers to the same questions are that attempt, not a new try
    const repeat = await call(w.cookie, "/kursus/veebikursus/test", { answers: HALF });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ ok: true, state: { kind: "open", triesLeft: 2 }, last: { number: 1, status: "failed" } });
    expect(await attempts()).toHaveLength(1);
  });

  test("a passing attempt of a course with points: passed (the practical work is next); sent again it is the same attempt; other answers after it are closed", async () => {
    const w = await world();
    expect(await (await call(w.cookie, "/kursus/veebikursus/test", { answers: RIGHT })).json()).toMatchObject({
      ok: true,
      state: { kind: "passed" },
      hasPoints: true,
      last: { status: "passed", percent: 100, wrong: [] },
    });
    const repeat = await call(w.cookie, "/kursus/veebikursus/test", { answers: RIGHT });
    expect([repeat.status, (await repeat.json()).state]).toEqual([200, { kind: "passed" }]);
    const other = await call(w.cookie, "/kursus/veebikursus/test", { answers: HALF });
    expect([other.status, await other.json()]).toEqual([409, { ok: false, error: "closed" }]);
    expect(await attempts()).toHaveLength(1);
  });

  test("answers to other questions than the course's (Maria changed the test): 409 changed, no try used, nothing stored", async () => {
    const w = await world();
    for (const answers of [{ q1choice: ["o1right0"] }, { ...RIGHT, zzzzzzzz: ["o1right0"] }, { q1choice: ["o1right0"], q2multi0: ["o2z00000"] }]) {
      const res = await call(w.cookie, "/kursus/veebikursus/test", { answers });
      expect([res.status, await res.json()], JSON.stringify(answers)).toEqual([409, { ok: false, error: "changed" }]);
    }
    expect(await attempts()).toEqual([]);
    expect(await (await call(w.cookie, "/kursus/veebikursus/test")).json()).toMatchObject({ state: { kind: "none", triesLeft: 3 } });
  });

  test("a question left unanswered: 400 incomplete; an open answer over 2000 characters: 400 tooLong; a body that is not JSON: 400 answers", async () => {
    const w = await world({ questions: [...QUESTIONS, OPEN] });
    const send = async (body: unknown) => {
      const res = await call(w.cookie, "/kursus/veebikursus/test", body);
      return [res.status, await res.json()];
    };
    expect(await send({ answers: { ...RIGHT, q2multi0: [], q3open00: "Puhastan." } })).toEqual([400, { ok: false, error: "incomplete" }]);
    expect(await send({ answers: { ...RIGHT, q3open00: "   " } })).toEqual([400, { ok: false, error: "incomplete" }]);
    expect(await send({ answers: { ...RIGHT, q3open00: "x".repeat(2001) } })).toEqual([400, { ok: false, error: "tooLong" }]);
    expect(await send("not json")).toEqual([400, { ok: false, error: "answers" }]);
    expect(await attempts()).toEqual([]);
  });

  test("an access that has ended: the test is read-only, a submit is closed", async () => {
    const w = await world({ access: { expiresAt: new Date(NOW.getTime() - DAY) } });
    expect(await (await call(w.cookie, "/kursus/veebikursus/test")).json()).toMatchObject({ ok: true, readOnly: true });
    const res = await call(w.cookie, "/kursus/veebikursus/test", { answers: RIGHT });
    expect([res.status, await res.json()]).toEqual([409, { ok: false, error: "closed" }]);
    expect(await attempts()).toEqual([]);
  });

  test("10 submits an hour per student; the 11th is 429 rate, before its answers are looked at", async () => {
    const w = await world();
    for (let i = 0; i < 10; i++) expect((await call(w.cookie, "/kursus/veebikursus/test", { answers: { q1choice: [], q2multi0: [] } })).status, `submit ${i + 1}`).toBe(400);
    const res = await call(w.cookie, "/kursus/veebikursus/test", { answers: RIGHT });
    expect([res.status, await res.json()]).toEqual([429, { ok: false, error: "rate" }]);
    expect(await attempts()).toEqual([]);
  });
});

describe("POST /kursus/:slug/test/uuesti", () => {
  test("Maria's 'Paranda' answers rewritten: the same attempt goes back to her review, no try used; nothing to rewrite while she reads it", async () => {
    const w = await world({ questions: [...QUESTIONS, OPEN] });
    expect(await (await call(w.cookie, "/kursus/veebikursus/test", { answers: { ...RIGHT, q3open00: "Puhastan." } })).json()).toMatchObject({
      state: { kind: "review" },
      triesLeft: 2,
      last: { status: "review" },
    });
    const [row] = await attempts();
    await db
      .update(testAttempts)
      .set({ status: "fix", review: { q3open00: { verdict: "fix", comment: "Lisa, millega puhastad." } }, reviewedAt: NOW, reviewedBy: "admin@example.test" })
      .where(eq(testAttempts.id, row.id));
    expect(await (await call(w.cookie, "/kursus/veebikursus/test")).json()).toMatchObject({
      state: { kind: "fix" },
      last: { id: row.id, review: { q3open00: { verdict: "fix", comment: "Lisa, millega puhastad." } } },
    });

    const res = await call(w.cookie, "/kursus/veebikursus/test/uuesti", { attemptId: row.id, answers: { ...RIGHT, q3open00: "Puhastan seebivaba puhastiga." } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, state: { kind: "review" }, triesLeft: 2, last: { id: row.id, number: 1, status: "review" } });
    expect((await attempts()).map((a) => [a.id, a.status, a.answers.q3open00])).toEqual([[row.id, "review", "Puhastan seebivaba puhastiga."]]);
    const again = await call(w.cookie, "/kursus/veebikursus/test/uuesti", { attemptId: row.id, answers: { ...RIGHT, q3open00: "Veel üks kord." } });
    expect([again.status, await again.json()]).toEqual([409, { ok: false, error: "closed" }]);
  });

  test("an attempt id that is no id: 400 attemptId; a body that is not JSON: 400 answers", async () => {
    const w = await world({ questions: [...QUESTIONS, OPEN] });
    for (const attemptId of ["1", 0, -1, 1.5, 2_147_483_648, null]) {
      const res = await call(w.cookie, "/kursus/veebikursus/test/uuesti", { attemptId, answers: RIGHT });
      expect([res.status, await res.json()], String(attemptId)).toEqual([400, { ok: false, error: "attemptId" }]);
    }
    const res = await call(w.cookie, "/kursus/veebikursus/test/uuesti", "{");
    expect([res.status, await res.json()]).toEqual([400, { ok: false, error: "answers" }]);
  });
});
