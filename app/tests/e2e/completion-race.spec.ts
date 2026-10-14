import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { APIResponse, Page, TestInfo } from "@playwright/test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Db } from "../../src/db/client";
import * as schema from "../../src/db/schema";
import type { FileStore } from "../../src/server/media";
import { localStore } from "../../src/server/media-local";
import { addPhoto, submitPractical, type PhotoInput, type PracticalDeps } from "../../src/server/practical";
import { submitAttempt } from "../../src/server/test-attempts";
import { clientEmail, signInAsClient } from "./account";
import { E2E_POINTS, E2E_QUESTIONS, insertCompletionCourse, storedAttempts, storedPhotos, storedProtocolOf, type CompletionCourse } from "./completion";
import { holdLocalLock, localDatabaseUrl, LOCK_WAIT_MS, onLocalDb, removeClientRows } from "./fixtures";
import { runName } from "./protocols";
import { expect, submitsForms, test } from "./test";

// Spec §9 "Real Postgres" and Review Focus 2 (two devices, or a double tap): what the unit tests' single-connection PGlite cannot show. The
// app's own submitPractical, addPhoto and submitAttempt, in this process, on a pool of the local Postgres, with a store in a temporary folder:
// - two "Saada hindamiseks" at the same moment give one round and one notice to Maria; the other finds it sent;
// - the 3rd and a 4th photo of one point at the same moment give three photos: the cap is counted under the access lock, and the refused
//   photo's objects, stored first, are removed;
// - the lock order, by a test that never misses: another connection holds her access row, and a submit waits for it with her protocol's row
//   still free (access, then protocol: a submit that took the protocol first would hold it while it waited);
// - two submits of the same test answers at the same moment give one attempt: one try (the second is the same submission, Task 5).
// And through the e2e run's server (Task 7's ruling): photo uploads alongside the student's own account deletion, POST /api/konto/kustuta —
// with her access row held, one photo waits before the deletion and one after it — and no practical/ file is left in the server's local
// store (app/.media-local) that no row names, and no row without its files.
// Nothing here depends on the screen: the desktop project runs these once.

test.skip(({ isMobile }) => isMobile, "nothing here depends on the screen: the desktop project runs these once");

const made = new Set<string>();
/** The name this process's pool connects under, so the test finds its own backends in pg_stat_activity and no one else's. */
const APPLICATION = `mslab-e2e-completion-race-${process.pid}`;
let pool: postgres.Sql | null = null;
let db: Db;
let dir = "";
let store: FileStore;

test.beforeAll(() => {
  pool = postgres(localDatabaseUrl(), { max: 6, connect_timeout: 20, onnotice: () => {}, connection: { application_name: APPLICATION } });
  db = drizzle(pool, { schema }) as unknown as Db;
});
test.afterAll(async () => {
  await pool?.end();
});
test.beforeEach(() => {
  submitsForms();
  test.setTimeout(60_000);
  dir = mkdtempSync(join(tmpdir(), "mslab-e2e-practical-"));
  store = localStore(dir);
});
test.afterEach(async () => {
  for (const email of made) await removeClientRows(email);
  made.clear();
  rmSync(dir, { recursive: true, force: true });
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Waiting = { query: string; wait_event: string | null };
/**
 * This pool's backends that wait for a lock (pg_stat_activity by its application_name), asked again every 50 ms until there are `n` of them, or
 * `gone()` says the work it waits for is over, or `ms` have passed: a test proves the wait instead of sleeping and hoping.
 */
async function lockWaits(n: number, gone: () => boolean, ms = 15_000): Promise<Waiting[]> {
  const until = Date.now() + ms;
  for (;;) {
    const waiting = await onLocalDb(
      (other) => other<Waiting[]>`select query, wait_event from pg_stat_activity where application_name = ${APPLICATION} and wait_event_type = 'Lock'`,
      { marksPages: false },
    );
    if (waiting.length >= n || gone() || Date.now() > until) return waiting;
    await pause(50);
  }
}

type Job = () => Promise<unknown>;
/** The dependencies of the practical work's and the test's calls; their mails and notices are collected, never run: nothing is mailed. */
function deps(jobs: Job[]): PracticalDeps {
  const site = "http://localhost:3000";
  return {
    db,
    env: { KV: { get: async () => null, put: async () => {} }, MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: site },
    siteUrl: site,
    now: new Date(),
    later: (task) => void jobs.push(task),
    files: store,
  };
}

/** A file as the server checks a JPEG (its signature FF D8 FF and its size; the server decodes nothing), `bytes` long. */
function jpegFile(bytes: number, name: string): File {
  const b = new Uint8Array(bytes);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  b.set([0xff, 0xd9], bytes - 2);
  return new File([b], name, { type: "image/jpeg" });
}
const photo = (stage: number): PhotoInput => ({ stage, full: jpegFile(4096, "foto.jpg"), thumb: jpegFile(1024, "foto-t.jpg"), width: 2048, height: 1365 });
/** The full photos and thumbnails in this test's store. */
const storedJpegs = () => readdirSync(join(dir, "practical")).filter((f) => f.endsWith(".jpg"));

/** A student of an e-course of her own (E2E_POINTS, the lesson done, no test unless `questions`): her practical work is open. */
async function course(label: string, info: TestInfo, opts: Parameters<typeof insertCompletionCourse>[1] = { points: E2E_POINTS, lessonsDone: true }): Promise<CompletionCourse> {
  const email = clientEmail(`race-${label}`, runName(info));
  made.add(email);
  await removeClientRows(email);
  return insertCompletionCourse(email, opts);
}

/** …with a photo on each point: ready to send. */
async function ready(label: string, info: TestInfo): Promise<CompletionCourse> {
  const s = await course(label, info);
  for (const stage of [0, 1]) expect(await addPhoto(deps([]), s.clientId, s.slug, photo(stage))).toMatchObject({ kind: "added" });
  return s;
}

test("Review Focus 2: two 'Saada hindamiseks' at the same moment — one round, one notice to Maria; the other finds it sent", async ({}, info) => {
  const s = await ready("send", info);
  const jobs: Job[] = [];
  const results = await Promise.all([submitPractical(deps(jobs), s.clientId, s.slug), submitPractical(deps(jobs), s.clientId, s.slug)]);
  expect(results.map((r) => r.kind).sort()).toEqual(["already", "submitted"]);
  expect(jobs, "the notices queued: one").toHaveLength(1);
  expect(await storedProtocolOf(s.accessId)).toMatchObject({ round: 1 });
});

test("Review Focus 2: the 3rd and a 4th photo of one point at the same moment — three photos; the 4th refused as full, its stored objects removed", async ({}, info) => {
  const s = await course("cap", info);
  for (let i = 0; i < 2; i++) expect(await addPhoto(deps([]), s.clientId, s.slug, photo(0))).toMatchObject({ kind: "added" });
  const results = await Promise.all([addPhoto(deps([]), s.clientId, s.slug, photo(0)), addPhoto(deps([]), s.clientId, s.slug, photo(0))]);
  expect(results.map((r) => r.kind).sort()).toEqual(["added", "full"]);
  const protocol = (await storedProtocolOf(s.accessId))!;
  expect((await storedPhotos(protocol.id)).filter((p) => p.stage === 0)).toHaveLength(3);
  expect(storedJpegs(), "three photos, a full one and a thumbnail each").toHaveLength(6);
});

test("the lock order: a submit waits while another transaction holds her access row, with her protocol's row still free; let go, it goes on", async ({}, info) => {
  const s = await ready("order", info);
  const protocol = (await storedProtocolOf(s.accessId))!;
  const jobs: Job[] = [];
  let sending!: ReturnType<typeof submitPractical>;
  let finished = false;
  await onLocalDb(
    (sql) =>
      sql.begin(async (tx) => {
        await tx`select 1 from course_access where id = ${s.accessId} for update`;
        sending = submitPractical(deps(jobs), s.clientId, s.slug);
        void sending.then(
          () => (finished = true),
          () => (finished = true),
        );
        const waiting = await lockWaits(1, () => finished);
        expect(finished, "the submit went past the access row's lock while it was held").toBe(false);
        expect(waiting, "this pool's backends that wait for a lock: the submit's").toHaveLength(1);
        expect(waiting[0].query, "what the submit waits at (server/completion.ts lockAccess)").toMatch(/from "?course_access"?[\s\S]*\bfor update\b/i);
        // the submit holds nothing of the protocol yet: another connection locks its row at once (NOWAIT fails otherwise, 55P03)
        await onLocalDb((other) => other.begin((t) => t`select 1 from protocols where id = ${protocol.id} for update nowait`), { marksPages: false });
      }),
    { marksPages: false },
  );
  expect(await sending).toMatchObject({ kind: "submitted" });
  expect(jobs).toHaveLength(1);
  expect(await storedProtocolOf(s.accessId)).toMatchObject({ round: 1 });
});

test("Review Focus 2: two submits of the same test answers at the same moment — one attempt, one try", async ({}, info) => {
  const s = await course("test", info, { questions: E2E_QUESTIONS, points: [], lessonsDone: true });
  const answers = { q1: ["a"], q2: ["b"] }; // one wrong: the test stays open for another try, so only the repeat rule keeps it at one
  const results = await Promise.all([submitAttempt(deps([]), s.clientId, s.slug, answers), submitAttempt(deps([]), s.clientId, s.slug, answers)]);
  expect(results.map((r) => r.kind)).toEqual(["submitted", "submitted"]);
  expect((await storedAttempts(s.clientId)).map((a) => [a.number, a.status])).toEqual([[1, "failed"]]);
});

// ---------- the account deleted while her photos are on their way (through the e2e run's server) ----------

/** The e2e run's server keeps the photos here (server/media-local.ts: `next dev`, and the production build with MEDIA_LOCAL=1). */
const MEDIA = join(process.cwd(), ".media-local");
const fileOf = (key: string) => join(MEDIA, ...key.split("/"));

/** Bytes the server takes for a JPEG (FF D8 FF … FF D9: it checks the signature and the size, decodes nothing), with `marker` inside. */
function markedJpeg(bytes: number, marker: string): Buffer {
  const b = Buffer.alloc(bytes);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  b.write(marker, 4, "latin1");
  b.set([0xff, 0xd9], bytes - 2);
  return b;
}

/** The photo files in the store (full photos and thumbnails, not their content-type notes) whose bytes carry `marker`: this test's own. */
function markedFiles(marker: string): string[] {
  const folder = join(MEDIA, "practical");
  if (!existsSync(folder)) return [];
  const needle = Buffer.from(marker, "latin1");
  return readdirSync(folder)
    .filter((name) => name.endsWith(".jpg"))
    .filter((name) => {
      try {
        return readFileSync(join(folder, name)).includes(needle);
      } catch {
        return false; // removed meanwhile
      }
    })
    .map((name) => `practical/${name}`);
}

/**
 * Every practical_photos row (any test's) one of whose files is not in the store. Each writer stores the files before the row and removes
 * the row before the files, so a row seen without a file while another test removed it is gone when asked again: only rows still there count.
 */
async function rowsWithoutFiles(): Promise<number[]> {
  const rows = await onLocalDb((sql) => sql<{ id: number; key: string; thumbKey: string }[]>`select id, key, thumb_key as "thumbKey" from practical_photos`, { marksPages: false });
  const missing = rows.filter((r) => !existsSync(fileOf(r.key)) || !existsSync(fileOf(r.thumbKey))).map((r) => r.id);
  if (missing.length === 0) return [];
  const still = await onLocalDb((sql) => sql<{ id: number }[]>`select id from practical_photos where id in ${sql(missing)}`, { marksPages: false });
  return still.map((r) => r.id);
}

/**
 * The backends (any connection: the e2e run's server's too) that wait, directly or down a queue, for a lock the backend `holder` holds:
 * the requests a test holds up, proven instead of slept on.
 */
async function waitingBehind(holder: number, n: number, ms = 30_000): Promise<number> {
  const until = Date.now() + ms;
  for (;;) {
    const [{ count }] = await onLocalDb(
      (sql) => sql<{ count: number }[]>`
        with recursive behind(pid) as (
          select pid from pg_stat_activity where ${holder} = any(pg_blocking_pids(pid))
          union
          select a.pid from pg_stat_activity a join behind b on b.pid = any(pg_blocking_pids(a.pid))
        )
        select count(*)::int as count from behind`,
      { marksPages: false },
    );
    if (count >= n || Date.now() > until) return count;
    await pause(50);
  }
}

/**
 * Her account deleted while her photos are on their way, through the e2e run's server (its route, its after(), its local store): see the test.
 */
async function deletionDuringUploads(page: Page, info: TestInfo): Promise<void> {
  const s = await course("gone", info);
  const email = clientEmail("race-gone", runName(info));
  await signInAsClient(page, email);
  const origin = new URL(page.url()).origin;
  const marker = `mslab-e2e-race-gone-${randomUUID()}`;
  const upload = (stage: number) =>
    page.request.post(`/api/konto/kursus/${s.slug}/praktiline/foto`, {
      headers: { origin },
      multipart: {
        stage: String(stage),
        width: "2048",
        height: "1365",
        full: { name: "foto.jpg", mimeType: "image/jpeg", buffer: markedJpeg(64 * 1024, marker) },
        thumb: { name: "foto-t.jpg", mimeType: "image/jpeg", buffer: markedJpeg(8 * 1024, marker) },
      },
      failOnStatusCode: false,
    });

  // one photo stored before anything else: its row and both files are there for the deletion to take
  const first = await upload(0);
  expect(first.status(), await first.text()).toBe(200);
  const protocol = (await storedProtocolOf(s.accessId))!;
  const [row] = await storedPhotos(protocol.id);
  expect([existsSync(fileOf(row.key)), existsSync(fileOf(row.thumbKey))]).toEqual([true, true]);
  expect(markedFiles(marker)).toHaveLength(2);

  // Another connection holds her access row, which every photo and the deletion lock first (the phase's lock order). Behind it, in this
  // order: a photo (its files stored, its row not yet), the deletion, and a second photo (its files stored too, the session still there).
  // Let go, they take the row in that order: the first photo's row goes in before the deletion lists her files; the second photo finds her
  // access gone and removes its own files.
  let before: Promise<APIResponse> | undefined;
  let deletion: Promise<APIResponse> | undefined;
  let after: Promise<APIResponse> | undefined;
  try {
    await onLocalDb(
      (sql) =>
        sql.begin(async (tx) => {
          const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          await tx`select 1 from course_access where id = ${s.accessId} for update`;
          before = upload(0);
          expect(await waitingBehind(pid, 1), "the first photo waits for her access row").toBe(1);
          deletion = page.request.post("/api/konto/kustuta", { headers: { origin }, data: { confirm: true }, failOnStatusCode: false });
          expect(await waitingBehind(pid, 2), "the deletion waits behind it").toBe(2);
          after = upload(1);
          expect(await waitingBehind(pid, 3), "the second photo waits behind the deletion").toBe(3);
          expect(markedFiles(marker), "both waiting photos have stored their files").toHaveLength(6);
        }),
      { marksPages: false },
    );
  } finally {
    // a failure above lets the row go too: what is on its way is answered before the clean-up reads her photos (a row written after that
    // read would leave its files behind)
    await Promise.allSettled([before, deletion, after]);
  }
  const [stored, gone, refused] = await Promise.all([before!, deletion!, after!]);
  expect(stored.status(), await stored.text()).toBe(200);
  expect(gone.status(), await gone.text()).toBe(200);
  expect(refused.status(), await refused.text()).toBe(404); // her access was gone by the time the row was hers

  // the account, her access, her protocol and its photo rows are gone (on delete cascade) …
  expect(await onLocalDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from clients where email = ${email}`, { marksPages: false })).toEqual([{ n: 0 }]);
  expect(await storedProtocolOf(s.accessId)).toBeNull();
  expect(await storedPhotos(protocol.id)).toEqual([]);
  // … and so are the files: the two stored photos' after the deletion's answer (account-api.ts deleteAccount's later), the refused one's by
  // addPhoto itself. None of this test's files is left without a row, and no row anywhere is left without its files.
  await expect.poll(() => markedFiles(marker), { message: "this test's photo files left in app/.media-local", timeout: 20_000 }).toEqual([]);
  expect(await rowsWithoutFiles(), "practical_photos rows whose files are not in app/.media-local").toEqual([]);
}

test("Task 7's ruling: photo uploads alongside her account's deletion (POST /api/konto/kustuta) — no practical/ file left that no row names, no row without its files", async ({ page }, info) => {
  // the first requests under `next dev` compile the account pages and API; and the wait for the turn below
  test.setTimeout(180_000 + LOCK_WAIT_MS);
  // three of the server's five database connections wait on the row it holds: one run of this test at a time (a --repeat-each run side by
  // side would leave the next one's requests no connection to reach that lock with)
  const done = await holdLocalLock("e2e-completion-race-deletion");
  try {
    await deletionDuringUploads(page, info);
  } finally {
    await done();
  }
});
