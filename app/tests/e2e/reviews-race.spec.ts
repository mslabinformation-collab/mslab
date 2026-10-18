import postgres from "postgres";
import type { Db } from "../../src/db/client";
import * as schema from "../../src/db/schema";
import { handleAccountApi, type AccountDeps } from "../../src/server/account-api";
import type { PublicChange } from "../../src/server/cache-targets";
import { CLIENT_COOKIE, CLIENT_SESSION_TTL_MS } from "../../src/server/client-auth";
import { decideReview } from "../../src/server/reviews";
import { newToken, sha256 } from "../../src/server/token";
import { clientEmail, insertAccountFixtures, insertEcourseAccess } from "./account";
import { onLocalDb, removeClientRows } from "./fixtures";
import { insertSentProtocol } from "./protocols";
import { inFlight, racePool } from "./race";
import { expect, submitsForms, test } from "./test";

// Student reviews on real Postgres (student reviews, Task 6; owed by Tasks 2 and 3): what the unit tests' single-connection PGlite cannot show, because
// it runs one transaction at a time (the concurrent submit was proved there only one after the other). The app's own account API (handleAccountApi:
// the very handler of POST /api/konto/tagasiside and POST /api/konto/arvustus/tagasi) and Maria's decideReview (the work of „Avalda“), in this process,
// on a pool of the local Postgres:
// - (a) two feedback submits with the tick at the same moment, for one contact registration: one 200 and one 409 „sent“, one feedback row, one review
//   (a copy of the answer and the name), one „submitted“ in the log and one notice to Maria;
// - (b) the same for one completed e-course access, addressed by its slug (`{ kursus }`);
// - (c) „Võta luba tagasi“ and Maria's „Avalda“ on the same review at the same moment, in both orders: neither is a 500; withdrawn first, the
//   publish finds the review gone (`gone`); published first, the publish lands and the withdrawal then deletes it. Either way no review is left, the
//   withdrawal asks for the course's pages and the home page to be refreshed once, and the student's answers stay.
// "At the same moment" is proven, not hoped for (race.ts inFlight, as contracts-race.spec.ts): another connection holds a lock the calls meet, and lets it
// go only once this pool shows every call waiting for it. They stand in the lock's queue in the order started, so which goes first is fixed by the test,
// and the outcome that follows is the locks', not the timing's.
// - (a) and (b) hold the course's row FOR UPDATE. A submit takes the registration or the access FOR SHARE (shared by both), writes the feedback and
//   then meets the course at the review's foreign key (FOR KEY SHARE, which FOR UPDATE refuses). So the first submit stands inside its transaction with
//   the feedback row written and not committed, at the course's lock; the second reads the feedback as it was (none), tries to write the same row, and
//   waits for the first's transaction at the unique index. When the course is let go the first commits, and the second's `ON CONFLICT DO NOTHING`
//   (course-feedback.ts submitFeedback) does nothing and finds the answer sent. Without it the second's insert would fail with the unique violation
//   (a 500): this was run against that mutation and failed there.
// - (c) holds the review's row FOR UPDATE, the first lock of both (reviews.ts withdrawReview and lockReview).
// No mail goes out (`dev: true`; Maria's notice, the work after the response, is collected and counted, never run). The rows are the tests' own sample
// accounts (`e2e-client-revrace-…@example.test`) on courses of their own (not published), found by the ids they stored and deleted by them. Nothing here
// depends on the screen: the desktop project runs these once.

test.skip(({ isMobile }) => isMobile, "nothing here depends on the screen: the desktop project runs these once");

/** The name this process's pool connects under, so the test finds its own backends in pg_stat_activity and no one else's. */
const APPLICATION = `mslab-e2e-reviews-race-${process.pid}`;
const SITE = "http://localhost:3000";
let pool: postgres.Sql | null = null;
let db: Db;
/** The rows of the test that is running, by id (the clean-up deletes exactly these). */
const made: { emails: string[]; registrations: number[]; accesses: number[]; clients: number[] } = { emails: [], registrations: [], accesses: [], clients: [] };
/** What the test's app wrote to the log, and the work it queued for after the response (Maria's notices), and the pages it asked to refresh. */
let logged: string[] = [];
let jobs: (() => Promise<unknown>)[] = [];
let changes: PublicChange[] = [];
const loggedInfo = console.info;

test.beforeAll(() => {
  ({ pool, db } = racePool(APPLICATION));
});
test.afterAll(async () => {
  await pool?.end();
});
test.beforeEach(() => {
  submitsForms();
  test.setTimeout(90_000);
  logged = [];
  jobs = [];
  changes = [];
  console.info = (...args: unknown[]) => void logged.push(args.map(String).join(" ")); // (the app's own log lines, ids only: read here, not the test's output)
});
test.afterEach(async () => {
  console.info = loggedInfo;
  try {
    await onLocalDb(
      async (sql) => {
        // exactly the rows of the ids the test noted: their reviews, their answers
        const feedback = (await sql<{ id: number }[]>`select id from course_feedback where registration_id = any(${made.registrations}::int[]) or access_id = any(${made.accesses}::int[])`).map((f) => f.id);
        if (feedback.length) {
          await sql`delete from reviews where feedback_id in ${sql(feedback)}`;
          await sql`delete from course_feedback where id in ${sql(feedback)}`;
        }
      },
      { marksPages: false },
    );
    for (const email of made.emails) expect(await removeClientRows(email), `rows of ${email} left`).toBe(0);
  } finally {
    made.emails = [];
    made.registrations = [];
    made.accesses = [];
    made.clients = [];
  }
});

/** What another connection holds while two calls start: the course's row (the review's foreign key asks for it late in a submit)… */
const courseRow = (id: number) => (tx: postgres.TransactionSql) => tx`select 1 from courses where id = ${id} for update`;
/** …or a review's row (the first lock of a withdrawal and of Maria's decision). */
const reviewRow = (id: number) => (tx: postgres.TransactionSql) => tx`select 1 from reviews where id = ${id} for update`;

type Student = { email: string; clientId: number; cookie: string; course: { id: number; slug: string }; registrationId?: number; accessId?: number };

/** The `{ id }` or `{ kursus }` the feedback POST names a course by. */
const targetOf = (s: Student): { id: number } | { kursus: string } => (s.registrationId !== undefined ? { id: s.registrationId } : { kursus: s.course.slug });

/**
 * A student of her own, signed in (a live session in the database: the handler reads the cookie), with the feedback form open for a course of the
 * test's own: a contact registration whose protocol Maria has sent, or an e-course she has completed. Her rows are noted for the clean-up.
 */
async function student(label: string, kind: "contact" | "ecourse", info: { project: { name: string } }): Promise<Student> {
  const email = clientEmail(`revrace-${label}`, info.project.name);
  await removeClientRows(email);
  made.emails.push(email);
  let s: Omit<Student, "cookie">;
  if (kind === "contact") {
    const f = await insertAccountFixtures(email, { name: "Kati Tamm", cards: ["confirmed"] });
    const registrationId = f.registrations.confirmed!;
    made.registrations.push(registrationId);
    await insertSentProtocol(registrationId, ["Ühtlane joon."], "Tubli töö!"); // (the first send opens the form)
    s = { email, clientId: f.clientId, course: { id: f.course.id, slug: f.course.slug }, registrationId };
  } else {
    const e = await insertEcourseAccess(email, { own: true, name: "Mari Maasikas" });
    const [access] = await onLocalDb(
      (sql) => sql<{ id: number; courseId: number }[]>`update course_access set completed_at = now() where client_id = ${e.clientId} returning id, course_id as "courseId"`,
      { marksPages: false },
    );
    made.accesses.push(access.id);
    s = { email, clientId: e.clientId, course: { id: access.courseId, slug: e.slug }, accessId: access.id };
  }
  made.clients.push(s.clientId);
  const raw = newToken();
  const now = new Date();
  await db.insert(schema.clientSessions).values({ idHash: await sha256(raw), clientId: s.clientId, createdAt: now, expiresAt: new Date(now.getTime() + CLIENT_SESSION_TTL_MS) });
  return { ...s, cookie: `${CLIENT_COOKIE}=${raw}` };
}

/** The account API as the handler answers it (in this process, on the pool): POST `path` with a JSON body, as the signed-in student. */
async function post(cookie: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const deps: AccountDeps = {
    db,
    env: { KV: { get: async () => null, put: async () => {} }, MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE },
    now: new Date(),
    siteUrl: SITE,
    later: (task) => void jobs.push(task),
    dev: true,
    changed: (change) => void changes.push(change),
  };
  const res = await handleAccountApi(new Request(`${SITE}/api/konto${path}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), deps);
  if (!res) throw new Error(`POST ${path}: no such route`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const WORDS = "E2E Soovitan seda koolitust kõigile, kes tahavad kulme õppida.";
const NAME = "Kati T.";
/** The feedback form sent with the tick: her words and the name to show. */
const submit = (s: Student) => post(s.cookie, "/tagasiside", { ...targetOf(s), locale: "et", answers: { score: 9, recommend: WORDS }, consent: { name: NAME } });

type Stored = { feedback: { id: number; submitted: boolean; recommend: unknown }[]; reviews: { id: number; kind: string; status: string; featured: boolean; name: string; text: string; locale: string; feedbackId: number | null }[] };

/** The answers of one registration or access as stored, and the reviews made of them. */
async function stored(s: Student): Promise<Stored> {
  return onLocalDb(
    async (sql) => {
      const feedback = await sql<Stored["feedback"]>`
        select id, submitted_at is not null as submitted, answers->'recommend' as recommend from course_feedback
        where ${s.registrationId !== undefined ? sql`registration_id = ${s.registrationId}` : sql`access_id = ${s.accessId!}`} order by id`;
      const ids = feedback.map((f) => f.id);
      const reviews = ids.length
        ? await sql<Stored["reviews"]>`select id, kind, status, featured, name, text, locale, feedback_id as "feedbackId" from reviews where feedback_id in ${sql(ids)} order by id`
        : [];
      return { feedback, reviews };
    },
    { marksPages: false },
  );
}

/** What a log line says, once per matching line: how many lines the app wrote that match. */
const logLines = (pattern: RegExp) => logged.filter((l) => pattern.test(l));

/** The common end of (a) and (b): the answers as the two submits left them. */
async function expectOneAnswerOneReview(s: Student, first: Awaited<ReturnType<typeof submit>>, second: Awaited<ReturnType<typeof submit>>, owner: string) {
  // the submit that wrote the answer first is answered; the other finds it sent (409 „sent“, the form says „Tagasiside on juba saadetud“), never a 500
  expect(first).toEqual({ status: 200, body: { ok: true } });
  expect(second).toEqual({ status: 409, body: { ok: false, error: "sent" } });
  const rows = await stored(s);
  expect(rows.feedback, "one answer").toEqual([{ id: rows.feedback[0]?.id, submitted: true, recommend: WORDS }]);
  expect(rows.reviews, "one review, a copy of the answer and the name, waiting for Maria").toEqual([
    { id: rows.reviews[0]?.id, kind: "student", status: "pending", featured: false, name: NAME, text: WORDS, locale: "et", feedbackId: rows.feedback[0].id },
  ]);
  // the app told its log and Maria once each: only the submit that stored the answer
  expect(logLines(new RegExp(`^\\[feedback\\] ${owner}: submitted$`)), "the log: submitted").toHaveLength(1);
  expect(logLines(new RegExp(`^\\[reviews\\] review ${rows.reviews[0].id}: pending \\(${owner}\\)$`)), "the log: the review is pending").toHaveLength(1);
  expect(logLines(/^\[reviews\] review \d+: pending/), "one review in the whole log").toHaveLength(1);
  expect(jobs, "Maria's notice: one").toHaveLength(1);
}

test("(a) two feedback submits with the tick at the same moment for one contact registration: one answer, one review, one 200 and one „sent“", async ({}, info) => {
  const s = await student("a", "contact", info);
  const [first, second] = await inFlight(APPLICATION, courseRow(s.course.id), () => submit(s), () => submit(s));
  await expectOneAnswerOneReview(s, first, second, `registration ${s.registrationId}`);
});

test("(b) the same for one completed e-course access, addressed by its slug: one answer, one review, one 200 and one „sent“", async ({}, info) => {
  const s = await student("b", "ecourse", info);
  const [first, second] = await inFlight(APPLICATION, courseRow(s.course.id), () => submit(s), () => submit(s));
  await expectOneAnswerOneReview(s, first, second, `access ${s.accessId}`);
});

for (const c of [
  { order: "withdraw-first", name: "„Võta luba tagasi“ first: Maria's „Avalda“ finds the review gone" },
  { order: "decide-first", name: "Maria's „Avalda“ first: it lands, and the withdrawal then deletes the published review" },
] as const) {
  test(`(c) „Võta luba tagasi“ and Maria's „Avalda“ on one review at the same moment, ${c.name}`, async ({}, info) => {
    const s = await student(`c-${c.order === "withdraw-first" ? "w" : "d"}`, "contact", info);
    // her answer with the tick, through the very handler (nothing in flight yet); the review waits for Maria
    expect(await submit(s)).toEqual({ status: 200, body: { ok: true } });
    const [review] = (await stored(s)).reviews;
    expect(review).toMatchObject({ status: "pending" });
    changes = [];
    const withdraw = () => post(s.cookie, "/arvustus/tagasi", { reviewId: review.id });
    const publish = () => decideReview(db, review.id, "publish", new Date());
    const [first, second] = c.order === "withdraw-first" ? await inFlight(APPLICATION, reviewRow(review.id), withdraw, publish) : await inFlight(APPLICATION, reviewRow(review.id), publish, withdraw);
    const [withdrawn, published] = (c.order === "withdraw-first" ? [first, second] : [second, first]) as [Awaited<ReturnType<typeof withdraw>>, Awaited<ReturnType<typeof publish>>];
    // never a 500: the withdrawal deletes the review whatever Maria did, and her press finds either the published row or no row
    expect(withdrawn).toEqual({ status: 200, body: { ok: true } });
    expect(published).toEqual(c.order === "withdraw-first" ? { ok: false, error: "gone" } : { ok: true, courseSlug: s.course.slug });
    // no review is left, whichever came first; her answers stay with Maria
    const rows = await stored(s);
    expect(rows.reviews, "no review left").toEqual([]);
    expect(rows.feedback).toEqual([{ id: rows.feedback[0]?.id, submitted: true, recommend: WORDS }]);
    // the withdrawal asked once for the course's pages and the home page to be refreshed
    expect(changes).toEqual([{ kind: "reviews", course: s.course.slug }]);
    expect(logLines(new RegExp(`^\\[reviews\\] review ${review.id}: withdrawn$`))).toHaveLength(1);
    expect(logLines(new RegExp(`^\\[reviews\\] review ${review.id}: published$`))).toHaveLength(c.order === "withdraw-first" ? 0 : 1);
  });
}
