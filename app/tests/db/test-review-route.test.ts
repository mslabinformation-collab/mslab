import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { contentDrafts, courseAccess, testAttempts, type OpenReview, type TestAnswers, type TestQuestion } from "@/db/schema";
import { createSession } from "@/server/auth";
import { saveDraftPart } from "@/server/drafts";
import { readMarks } from "@/server/test-review-marks";
import { ecourseAccess } from "./assessment-fixtures";
import { makeTestDb } from "./helpers";

// Maria's test review, B15 (admin UX pass, piece 2, Task 11; README A4 "Test review", §1.3): the marks (a verdict and a comment for each OPEN answer)
// are autosaved to the server through POST /api/admin/testi-hinnang/<attempt> with `{ version, patch: { <question id>: { verdict, comment } } }`
// (server/autosave-route.ts autosaveHandler, inside withAdmin). They are a draft of the review in the draft layer (server/drafts.ts: entity
// "test_review", the attempt's id, part "marks"; value `{ submittedAt, marks }`), never in `test_attempts.review`, which is what the student is
// shown. The part's version is the draft's counter as text ("0": there is none), and a draft written for other answers (the student rewrote since:
// another `submittedAt`) is not read. On PGlite, with the admin's session cookie faked (as registration-note-route.test.ts does).

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));

import { POST } from "@/app/api/admin/testi-hinnang/[attemptId]/route";

const ORIGIN = "https://mslab.example";
const SUBMITTED = new Date("2026-10-19T07:00:00.000Z");
const REWRITTEN = new Date("2026-10-19T09:30:00.000Z");
const CHOICE: TestQuestion = { id: "qvalik01", kind: "choice", text: "Mitu korda pesta pintslit?", options: [{ id: "o1oige01", text: "Pärast igat kasutust", correct: true }, { id: "o1vale01", text: "Kord nädalas", correct: false }] };
const OPEN_A: TestQuestion = { id: "qavatud1", kind: "open", text: "Kirjelda oma tööde järjekorda." };
const OPEN_B: TestQuestion = { id: "qavatud2", kind: "open", text: "Mida teed allergia korral?" };
const ANSWERS: TestAnswers = { qvalik01: ["o1oige01"], qavatud1: "Puhastan, siis mõõdan.", qavatud2: "Jätkan tööd." };

let db: Db;
let attemptId: number;
let accessId: number;

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  state.cookie = undefined;
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const w = await ecourseAccess(db);
  accessId = w.access.id;
  attemptId = await attempt(w.client.id, w.course.id);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function attempt(clientId: number, courseId: number, over: Partial<typeof testAttempts.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(testAttempts)
    .values({ clientId, courseId, number: 1, questions: [CHOICE, OPEN_A, OPEN_B], answers: ANSWERS, correct: 1, total: 1, status: "review", submittedAt: SUBMITTED, ...over })
    .returning();
  return row.id;
}

const signIn = async () => {
  state.cookie = await createSession(db, "admin@example.test");
};
const save = (target: string | number, body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request(`${ORIGIN}/api/admin/testi-hinnang/${target}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ attemptId: String(target) }),
  });
const answerOf = async (res: Response) => ({ status: res.status, cache: res.headers.get("cache-control"), body: await res.json() });
const drafts = () => db.select().from(contentDrafts).where(eq(contentDrafts.entity, "test_review"));
const NONE = { verdict: null, comment: "" };

describe("POST /api/admin/testi-hinnang/<attempt>", () => {
  test("without an admin's session: 401, nothing stored; from another site: 403", async () => {
    expect(await answerOf(await save(attemptId, { version: "0", patch: { qavatud1: { verdict: "ok", comment: "" } } }))).toMatchObject({ status: 401, body: { ok: false, error: "unauthorized" } });
    await signIn();
    expect((await save(attemptId, { version: "0", patch: { qavatud1: { verdict: "ok", comment: "" } } }, { origin: "https://evil.example" })).status).toBe(403);
    expect(await drafts()).toEqual([]);
  });

  test("ok: the first save makes the draft (version \"1\"), the next goes on from it; the marks are the draft of the review, apart from `review`", async () => {
    await signIn();
    const first = await answerOf(await save(attemptId, { version: "0", patch: { qavatud1: { verdict: "ok", comment: "" } } }));
    expect(first).toMatchObject({ status: 200, cache: "no-store", body: { ok: true, version: "1", savedAt: expect.any(String) } });
    expect(Number.isNaN(Date.parse(first.body.savedAt))).toBe(false);
    expect(await drafts()).toMatchObject([
      {
        entity: "test_review",
        entityId: attemptId,
        part: "marks",
        version: 1,
        baseVersion: SUBMITTED.toISOString(),
        updatedBy: "admin@example.test",
        value: { submittedAt: SUBMITTED.toISOString(), marks: { qavatud1: { verdict: "ok", comment: "" } } },
      },
    ]);
    // the student is shown `review`: a draft is never written there
    expect((await db.select().from(testAttempts).where(eq(testAttempts.id, attemptId)))[0]).toMatchObject({ status: "review", review: null, reviewedAt: null });
    // the next save names only what changed: the earlier marks stay in the draft
    const second = await answerOf(await save(attemptId, { version: "1", patch: { qavatud2: { verdict: "fix", comment: "Lisa allergiatest." } } }));
    expect(second).toMatchObject({ status: 200, body: { ok: true, version: "2" } });
    expect((await drafts())[0]).toMatchObject({
      version: 2,
      value: { submittedAt: SUBMITTED.toISOString(), marks: { qavatud1: { verdict: "ok", comment: "" }, qavatud2: { verdict: "fix", comment: "Lisa allergiatest." } } },
    });
    // a mark cleared by a re-tap is a mark of no verdict, kept as it is
    expect((await save(attemptId, { version: "2", patch: { qavatud1: { verdict: null, comment: "" } } })).status).toBe(200);
    expect((await drafts())[0].value).toMatchObject({ marks: { qavatud1: NONE, qavatud2: { verdict: "fix" } } });
  });

  test("a version that is not the draft's is a conflict: 409 with the stored marks and their version, nothing stored; a first save when a draft is there already is one too", async () => {
    await signIn();
    expect((await save(attemptId, { version: "0", patch: { qavatud1: { verdict: "ok", comment: "Hea." } } })).status).toBe(200);
    const stale = await answerOf(await save(attemptId, { version: "0", patch: { qavatud2: { verdict: "fix", comment: "Minu." } } }));
    expect(stale).toEqual({
      status: 409,
      cache: "no-store",
      // the stored marks of every open answer: what the draft holds, the others as the form starts (no verdict)
      body: { ok: false, error: "conflict", version: "1", value: { qavatud1: { verdict: "ok", comment: "Hea." }, qavatud2: NONE } },
    });
    expect(await answerOf(await save(attemptId, { version: "7", patch: { qavatud2: { verdict: "fix", comment: "Minu." } } }))).toMatchObject({ status: 409, body: { version: "1" } });
    expect((await drafts())[0]).toMatchObject({ version: 1, value: { marks: { qavatud1: { verdict: "ok", comment: "Hea." } } } });
  });

  test("a draft written for other answers (the student rewrote since) is not read: version \"0\", the form's start; a save replaces it, nothing of it carries over", async () => {
    await signIn();
    await saveDraftPart(db, {
      entity: "test_review",
      entityId: attemptId,
      part: "marks",
      value: { submittedAt: "2026-10-18T07:00:00.000Z", marks: { qavatud1: { verdict: "fix", comment: "Vana." } } },
      baseVersion: "2026-10-18T07:00:00.000Z",
      version: null,
      by: "admin@example.test",
    });
    expect(await readMarks(db, attemptId)).toEqual({ version: "0", value: { qavatud1: NONE, qavatud2: NONE } });
    // her first save of the new answers (from version "0"): the old draft is replaced, not conflicted with
    const res = await answerOf(await save(attemptId, { version: "0", patch: { qavatud2: { verdict: "ok", comment: "" } } }));
    expect(res).toMatchObject({ status: 200, body: { ok: true, version: "2" } });
    const [row, ...rest] = await drafts();
    expect(rest).toEqual([]);
    expect(row.value).toEqual({ submittedAt: SUBMITTED.toISOString(), marks: { qavatud2: { verdict: "ok", comment: "" } } });
    expect(await readMarks(db, attemptId)).toEqual({ version: "2", value: { qavatud1: NONE, qavatud2: { verdict: "ok", comment: "" } } });
    // the answers rewritten once more: the draft belongs to the earlier ones now
    await db.update(testAttempts).set({ submittedAt: REWRITTEN }).where(eq(testAttempts.id, attemptId));
    expect(await readMarks(db, attemptId)).toEqual({ version: "0", value: { qavatud1: NONE, qavatud2: NONE } });
  });

  test("an answer she accepted before (a rewrite brings the attempt back) starts as accepted; a draft's mark over it wins, a cleared one too", async () => {
    await signIn();
    const review: OpenReview = { qavatud1: { verdict: "ok", comment: "Hea." }, qavatud2: { verdict: "fix", comment: "Lisa allergiatest." } };
    await db.update(testAttempts).set({ review }).where(eq(testAttempts.id, attemptId));
    expect(await readMarks(db, attemptId)).toEqual({ version: "0", value: { qavatud1: { verdict: "ok", comment: "Hea." }, qavatud2: NONE } });
    expect((await save(attemptId, { version: "0", patch: { qavatud1: { verdict: null, comment: "" } } })).status).toBe(200);
    expect(await readMarks(db, attemptId)).toEqual({ version: "1", value: { qavatud1: NONE, qavatud2: NONE } });
  });

  test("an attempt that is not waiting for her any more (reviewed on her other device): a conflict with no marks, no draft made", async () => {
    await signIn();
    await db.update(testAttempts).set({ status: "fix", review: { qavatud1: { verdict: "ok", comment: "" }, qavatud2: { verdict: "fix", comment: "Lisa." } } }).where(eq(testAttempts.id, attemptId));
    expect(await answerOf(await save(attemptId, { version: "0", patch: { qavatud1: { verdict: "ok", comment: "" } } }))).toEqual({
      status: 409,
      cache: "no-store",
      body: { ok: false, error: "conflict", version: "0", value: null },
    });
    expect(await drafts()).toEqual([]);
  });

  test("a save that is no mark is refused at its field: a verdict that is none of the two, a comment over 2000 or with a NUL character, an answer that is no open question of this attempt; nothing stored", async () => {
    await signIn();
    const refuse = async (patch: unknown) => answerOf(await save(attemptId, { version: "0", patch }));
    expect(await refuse({ qavatud1: { verdict: "maybe", comment: "" } })).toMatchObject({ status: 400, cache: "no-store", body: { ok: false, error: "invalid", fields: { qavatud1: expect.any(String) } } });
    expect(await refuse({ qavatud1: { verdict: "ok" } })).toMatchObject({ status: 400, body: { error: "invalid", fields: { qavatud1: expect.any(String) } } });
    expect(await refuse({ qavatud1: { verdict: "ok", comment: 5 } })).toMatchObject({ status: 400, body: { error: "invalid", fields: { qavatud1: expect.any(String) } } });
    expect(await refuse({ qavatud1: { verdict: "fix", comment: "x".repeat(2001) } })).toEqual({ status: 400, cache: "no-store", body: { ok: false, error: "invalid", fields: { qavatud1: "tooLong" } } });
    expect(await refuse({ qavatud1: { verdict: "fix", comment: "a\u0000b" } })).toEqual({ status: 400, cache: "no-store", body: { ok: false, error: "invalid", fields: { qavatud1: "text" } } });
    // a choice question has no mark, and a question of another test none at all; the refusal names them all, the good one beside them is not stored either
    expect(await refuse({ qvalik01: { verdict: "ok", comment: "" }, qmuu00001: { verdict: "ok", comment: "" }, qavatud2: { verdict: "ok", comment: "" } })).toEqual({
      status: 400,
      cache: "no-store",
      body: { ok: false, error: "invalid", fields: { qvalik01: "unknown", qmuu00001: "unknown" } },
    });
    expect(await drafts()).toEqual([]);
    // 2000 characters are fine
    expect((await save(attemptId, { version: "0", patch: { qavatud1: { verdict: "fix", comment: "x".repeat(2000) } } })).status).toBe(200);
    // an empty save changes nothing and answers the version it is on
    expect(await answerOf(await save(attemptId, { version: "1", patch: {} }))).toMatchObject({ status: 200, body: { ok: true, version: "1" } });
  });

  test("an id that is no attempt, or whose access an admin ended: 404 notFound; a body that is no save: 400", async () => {
    await signIn();
    const patch = { qavatud1: { verdict: "ok", comment: "" } };
    for (const target of ["999999", "abc", "0"]) expect(await answerOf(await save(target, { version: "0", patch })), target).toMatchObject({ status: 404, body: { ok: false, error: "notFound" } });
    expect(await answerOf(await save(attemptId, { patch }))).toMatchObject({ status: 400, body: { ok: false, error: "body" } });
    await db.update(courseAccess).set({ revokedAt: new Date() }).where(eq(courseAccess.id, accessId));
    expect(await answerOf(await save(attemptId, { version: "0", patch }))).toMatchObject({ status: 404, body: { ok: false, error: "notFound" } });
    expect(await readMarks(db, attemptId)).toBeNull();
    expect(await drafts()).toEqual([]);
  });
});
