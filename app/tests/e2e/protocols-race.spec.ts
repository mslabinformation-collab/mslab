import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Db } from "../../src/db/client";
import * as schema from "../../src/db/schema";
import { deleteClient } from "../../src/server/client-data";
import { saveProtocol, sendProtocol, type SendDeps } from "../../src/server/protocols";
import { localDatabaseUrl, onLocalDb, removeClientRows } from "./fixtures";
import { E2E_HEADINGS, insertProtocolFixtures, runName, storedProtocol } from "./protocols";
import { submitsForms, test, expect } from "./test";

// Spec §10 "Real Postgres": what the unit tests' single-connection PGlite cannot show. The app's own sendProtocol, in this process, on a pool of
// the local Postgres: two sends of one protocol at the same moment (two taps, two devices) give one frozen copy and one mail — the other finds
// it sent. The race alone may not overlap every run, so the locks have tests that never miss (as payments.spec.ts):
// - another connection holds the registration's row lock, and a send waits for it;
// - the order: another connection holds the address lock, the send waits for it and has not touched the registration (which the logins,
//   addClient and deleteClient lock after the address) — a send that took the registration first would hold it while it waited;
// - the once-only: two sends queue behind the address lock (both have read the protocol by then), and when it is let go one sends, the other
//   finds it sent — a check made before the lock, on what was read before it, lets both through;
// - deleteClient locks the registrations of the account FOR UPDATE: a feedback answer committed while it waits is deleted with the rest.
// Each was run once against a mutation of the app's code (registration first; the check before the lock; no FOR UPDATE) and failed there.
// No browser: the desktop project runs these once.

test.skip(({ isMobile }) => isMobile, "no browser in these tests: the desktop project runs them once");

const made = new Set<string>();
let pool: postgres.Sql | null = null;
let db: Db;

test.beforeAll(() => {
  pool = postgres(localDatabaseUrl(), { max: 6, connect_timeout: 20, onnotice: () => {} });
  db = drizzle(pool, { schema }) as unknown as Db;
});
test.afterAll(async () => {
  await pool?.end();
});
test.beforeEach(() => {
  submitsForms();
  test.setTimeout(60_000);
});
test.afterEach(async () => {
  for (const email of made) await removeClientRows(email);
  made.clear();
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The send's dependencies; its mail job (only a send that froze the copy queues one) is collected, never run: nothing is mailed. */
function deps(jobs: (() => Promise<unknown>)[]): SendDeps {
  const site = "http://localhost:3000";
  return {
    db,
    env: { KV: { get: async () => null, put: async () => {} }, MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: site },
    siteUrl: site,
    now: new Date(),
    later: (task) => void jobs.push(task),
  };
}

/** Mari with a written protocol, version 1. */
async function written(label: string, project: string) {
  const fx = await insertProtocolFixtures(label, project, ["Mari Maasikas"]);
  for (const s of fx.students) made.add(s.email);
  const [mari] = fx.students;
  expect(await saveProtocol(db, { registrationId: mari.id, version: 0, titles: E2E_HEADINGS, notes: ["Hea algus", "", ""], generalNote: "" }, new Date())).toMatchObject({ kind: "saved", version: 1 });
  return mari;
}

/** Her account, made and linked already (a first send would make it and write the registration; the lock itself is what a test of the lock needs to meet). */
async function withAccount(mari: { id: number; name: string; email: string }): Promise<number> {
  return onLocalDb(
    async (sql) => {
      const [client] = await sql<{ id: number }[]>`insert into clients (email, name, locale) values (${mari.email}, ${mari.name}, 'et') returning id`;
      await sql`update registrations set client_id = ${client.id} where id = ${mari.id}`;
      return client.id;
    },
    { marksPages: false },
  );
}

/** How many accounts the address has. */
const accountsOf = async (email: string) => (await onLocalDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from clients where email = ${email}`, { marksPages: false }))[0].n;

test("two sends of one protocol at the same moment: one frozen copy and one mail; the other finds it sent", async ({}, info) => {
  const mari = await written("race", runName(info));
  const jobs: (() => Promise<unknown>)[] = [];
  const results = await Promise.all([sendProtocol(deps(jobs), { registrationId: mari.id, version: 1 }), sendProtocol(deps(jobs), { registrationId: mari.id, version: 1 })]);
  expect(results.map((r) => r.kind).sort()).toEqual(["already", "sent"]);
  expect(jobs).toHaveLength(1);
  // one frozen copy: it carries the time of the send that made it, and the other send reports exactly that time
  const winner = results.find((r) => r.kind === "sent") as { kind: "sent"; sentAt: string };
  expect(results.find((r) => r.kind === "already")).toMatchObject({ sentAt: winner.sentAt });
  const stored = (await storedProtocol(mari.id))!;
  expect(stored).toMatchObject({ version: 1, sentVersion: 1, sent: { stages: [{ title: "Ettevalmistus", note: "Hea algus" }, { note: "" }, { note: "" }] } });
  expect(stored.sentAt!.toISOString()).toBe(winner.sentAt);
  // one account for her, linked once
  expect(await accountsOf(mari.email)).toBe(1);
});

test("a send waits while another transaction holds the registration's row lock, and goes on when it is let go", async ({}, info) => {
  const mari = await written("held", runName(info));
  await withAccount(mari); // (linked already: this send writes nothing of the registration, so only its own lock can make it wait)
  const jobs: (() => Promise<unknown>)[] = [];
  let sending!: ReturnType<typeof sendProtocol>;
  let finished = false;
  await onLocalDb(
    (sql) =>
      sql.begin(async (tx) => {
        await tx`select 1 from registrations where id = ${mari.id} for update`;
        sending = sendProtocol(deps(jobs), { registrationId: mari.id, version: 1 });
        void sending.then(
          () => (finished = true),
          () => (finished = true),
        );
        await pause(2_000);
        expect(finished, "the send went past the registration's lock while it was held").toBe(false);
        expect((await storedProtocol(mari.id))!.sentAt).toBeNull();
      }),
    { marksPages: false },
  );
  expect(await sending).toMatchObject({ kind: "sent", again: false, version: 1 });
  expect(jobs).toHaveLength(1);
});

test("the lock order: while another transaction holds her address lock the send waits, with the registration still free; let go, it goes on", async ({}, info) => {
  const mari = await written("order", runName(info));
  const jobs: (() => Promise<unknown>)[] = [];
  let sending!: ReturnType<typeof sendProtocol>;
  let finished = false;
  await onLocalDb(
    (sql) =>
      sql.begin(async (tx) => {
        // client-auth.ts lockAddress: the logins', addClient's and deleteClient's lock, taken first by every path that writes for an address
        await tx`select pg_advisory_xact_lock(hashtext(${`client-login:${mari.email}`}))`;
        sending = sendProtocol(deps(jobs), { registrationId: mari.id, version: 1 });
        void sending.then(
          () => (finished = true),
          () => (finished = true),
        );
        await pause(1_500);
        expect(finished, "the send went past the address lock while it was held").toBe(false);
        // the send waits on the address and holds nothing of the registration: another connection locks it at once (NOWAIT fails otherwise, 55P03)
        await onLocalDb((other) => other.begin((t) => t`select 1 from registrations where id = ${mari.id} for update nowait`), { marksPages: false });
      }),
    { marksPages: false },
  );
  expect(await sending).toMatchObject({ kind: "sent", version: 1 });
  expect(jobs).toHaveLength(1);
});

test("the once-only holds under the address lock: two sends queue behind it, and when it is let go one sends and the other finds it sent", async ({}, info) => {
  const mari = await written("queue", runName(info));
  const jobs: (() => Promise<unknown>)[] = [];
  let first!: ReturnType<typeof sendProtocol>;
  let second!: ReturnType<typeof sendProtocol>;
  await onLocalDb(
    (sql) =>
      sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`client-login:${mari.email}`}))`;
        first = sendProtocol(deps(jobs), { registrationId: mari.id, version: 1 });
        second = sendProtocol(deps(jobs), { registrationId: mari.id, version: 1 });
        await pause(1_500); // both have read what they read before the lock, and wait for it
        expect((await storedProtocol(mari.id))!.sentAt).toBeNull();
      }),
    { marksPages: false },
  );
  const results = await Promise.all([first, second]);
  expect(results.map((r) => r.kind).sort()).toEqual(["already", "sent"]);
  expect(jobs).toHaveLength(1);
  expect(await storedProtocol(mari.id)).toMatchObject({ version: 1, sentVersion: 1 });
});

test("deleteClient locks her registrations FOR UPDATE: a feedback answer committed while it waits is deleted with the rest", async ({}, info) => {
  const mari = await written("delete", runName(info));
  const clientId = await withAccount(mari);
  let deleting!: ReturnType<typeof deleteClient>;
  let finished = false;
  await onLocalDb(
    (sql) =>
      sql.begin(async (tx) => {
        // another connection (a feedback answer on its way: its insert takes a share lock on the registration) holds the registration …
        await tx`select 1 from registrations where id = ${mari.id} for share`;
        deleting = deleteClient(db, clientId);
        void deleting.then(
          () => (finished = true),
          () => (finished = true),
        );
        await pause(1_500);
        // … so the deletion waits, at the statement that locks the registrations (not later, after it has already deleted the feedback it saw)
        expect(finished, "the deletion went past the registration's lock while it was held").toBe(false);
        const waiting = await onLocalDb(
          (other) => other<{ query: string }[]>`select query from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
          { marksPages: false },
        );
        expect(waiting.map((w) => w.query).join("\n"), "what the deletion waits at").toMatch(/\bfor update\b/i);
        // the late answer, committed with the lock let go
        await tx`insert into course_feedback (registration_id, answers, locale, submitted_at) values (${mari.id}, ${tx.json({ score: 7 })}, 'et', now())`;
      }),
    { marksPages: false },
  );
  expect(await deleting).toMatchObject({ email: mari.email, locale: "et" });
  const left = await onLocalDb(
    (sql) => sql<{ feedback: number; protocols: number; clients: number; linked: number }[]>`
      select (select count(*) from course_feedback where registration_id = ${mari.id})::int as feedback,
             (select count(*) from protocols where registration_id = ${mari.id})::int as protocols,
             (select count(*) from clients where id = ${clientId})::int as clients,
             (select count(*) from registrations where id = ${mari.id} and client_id is null)::int as linked`,
    { marksPages: false },
  );
  expect(left[0], "after the deletion: the late feedback and her protocol gone with the account, the registration left with Maria, unlinked").toEqual({ feedback: 0, protocols: 0, clients: 0, linked: 1 });
});
