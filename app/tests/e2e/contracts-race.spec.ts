import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Db } from "../../src/db/client";
import * as schema from "../../src/db/schema";
import { handleAccountApi, type AccountDeps } from "../../src/server/account-api";
import { CLIENT_COOKIE, CLIENT_SESSION_TTL_MS } from "../../src/server/client-auth";
import { courseTermsVersion } from "../../src/server/client-data";
import { contractTemplate, requestContract } from "../../src/server/contracts";
import type { Env } from "../../src/server/notify";
import { newToken, sha256 } from "../../src/server/token";
import { clientEmail, holdTerms, insertAccountFixtures, type AccountFixtures } from "./account";
import { insertContract } from "./contracts";
import { localDatabaseUrl, onLocalDb, removeClientRows } from "./fixtures";
import { expect, submitsForms, test } from "./test";

// Contracts on real Postgres (contracts Task 7; owed by Tasks 3 and 6): what the unit tests' single-connection PGlite cannot show, because it runs one
// transaction at a time. The app's own account API (handleAccountApi: the very handler of POST /api/konto/leping and /api/konto/tingimused) and
// requestContract (the database half of Maria's „Saada leping kinnitamiseks“), in this process, on a pool of the local Postgres:
// - (a) „Kinnitan“ twice at the same moment on one asked registration (a double tap, two devices): one answer is 200 and the other 409 „nothing“; the
//   registration has one new current contract, the old one superseded once, and Maria's ask is cleared;
// - (b) Maria's ask and the student's „Kinnitan“ at the same moment, in both orders, with the registration asked already and not: whichever comes
//   second finds the first's committed state, never two current contracts (the partial unique index `contracts_current_registration` never fires: no
//   500), and the ask flag is what the order says (set when the ask came last, cleared when „Kinnitan“ did);
// - (c) the terms gate accepted twice at the same moment for one e-course access (/api/konto/tingimused): both are 200 (accepting twice is fine), and
//   the access has one contract, one acceptance of the terms.
// "At the same moment" is proven, not hoped for (inFlight, as invoices-race.spec.ts): another connection holds the row the calls meet first — the
// registration's row (askedRegistration and requestContract take it FOR UPDATE first) or the access's row (completion.ts lockAccess, the first lock of
// contractForAccess) — while the calls start, and lets it go only once this pool shows every call waiting for it. They stand in the lock's queue in
// the order started, so which goes first is fixed by the test, and the outcome that follows is the locks', not the timing's. No mail goes out
// (`dev: true`: nothing is mailed in local development). The rows are the tests' own sample accounts (`e2e-client-…@example.test`), found by the ids
// they stored and deleted by them; the contracts keep their rows when the registration or the account goes, so they are deleted first. Nothing here
// depends on the screen: the desktop project runs these once.

test.skip(({ isMobile }) => isMobile, "nothing here depends on the screen: the desktop project runs these once");

/** The name this process's pool connects under, so the test finds its own backends in pg_stat_activity and no one else's. */
const APPLICATION = `mslab-e2e-contracts-race-${process.pid}`;
const SITE = "http://localhost:3000";
let pool: postgres.Sql | null = null;
let db: Db;
let giveBack: (() => Promise<void>) | null = null;
/** The rows of the test that is running, by id (the clean-up deletes exactly these). */
const made: { emails: string[]; registrations: number[]; accesses: number[]; clients: number[] } = { emails: [], registrations: [], accesses: [], clients: [] };
const loggedInfo = console.info;

test.beforeAll(() => {
  pool = postgres(localDatabaseUrl(), { max: 6, connect_timeout: 20, onnotice: () => {}, connection: { application_name: APPLICATION } });
  db = drizzle(pool, { schema }) as unknown as Db;
  console.info = () => {}; // (the app's own log lines, ids only: not the test's output)
});
test.afterAll(async () => {
  console.info = loggedInfo;
  await pool?.end();
});
test.beforeEach(() => {
  submitsForms();
  test.setTimeout(90_000);
});
test.afterEach(async () => {
  try {
    await onLocalDb(
      async (sql) => {
        const ids = (await sql<{ id: number }[]>`select id from contracts where registration_id = any(${made.registrations}::int[]) or access_id = any(${made.accesses}::int[]) or client_id = any(${made.clients}::int[])`).map((c) => c.id);
        if (ids.length) await sql`delete from contracts where id in ${sql(ids)}`;
      },
      { marksPages: false },
    );
    for (const email of made.emails) expect(await removeClientRows(email), `rows of ${email} left`).toBe(0);
  } finally {
    made.emails = [];
    made.registrations = [];
    made.accesses = [];
    made.clients = [];
    await giveBack?.();
    giveBack = null;
  }
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

/** What another connection holds while two calls start: a registration's row (the first lock of „Kinnitan“ and of the ask)… */
const registrationRow = (id: number) => (tx: postgres.TransactionSql) => tx`select 1 from registrations where id = ${id} for update`;
/** …or an e-course access's row (the first lock of the terms gate's contract). */
const accessRow = (id: number) => (tx: postgres.TransactionSql) => tx`select 1 from course_access where id = ${id} for update`;

/**
 * Two calls in flight at the same moment, `first` started before `second`. Another connection holds a lock (`hold`) while they start; the test
 * starts `first`, waits until this pool shows it waiting, starts `second`, waits until it shows both waiting, and only then lets the lock go (its
 * transaction ends). A call that ran its whole transaction before the other began would never be seen waiting beside it. Their results, in the
 * order started.
 */
async function inFlight<A, B>(hold: (tx: postgres.TransactionSql) => Promise<unknown>, first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
  let settled = 0;
  const started: Promise<unknown>[] = [];
  const start = <T,>(call: () => Promise<T>): Promise<T> => {
    const running = call();
    started.push(running);
    void running.then(
      () => settled++,
      () => settled++,
    );
    return running;
  };
  let a!: Promise<A>;
  let b!: Promise<B>;
  try {
    await onLocalDb(
      (sql) =>
        sql.begin(async (tx) => {
          await hold(tx);
          a = start(first);
          expect((await lockWaits(1, () => settled > 0)).length, "the first call waits for the held lock").toBe(1);
          b = start(second);
          const waiting = await lockWaits(2, () => settled > 0);
          expect(settled, "a call went past the held lock while it was held").toBe(0);
          expect(waiting.length, `both calls wait for the lock (${waiting.map((w) => w.query.slice(0, 60)).join(" | ")})`).toBe(2);
        }),
      { marksPages: false },
    );
  } finally {
    await Promise.allSettled(started); // a failure above lets the lock go too: what is on its way finishes before the clean-up
  }
  return [await a, await b];
}

/** A student of her own, signed in (a live session in the database: the handler reads the cookie), with these cards; her rows are noted for the clean-up. */
async function student(label: string, cards: ("confirmed" | "ecourse")[], info: { project: { name: string } }) {
  const email = clientEmail(label, info.project.name);
  await removeClientRows(email);
  made.emails.push(email);
  const f: AccountFixtures = await insertAccountFixtures(email, { name: "Kati Tamm", cards });
  made.clients.push(f.clientId);
  const raw = newToken();
  const now = new Date();
  await db.insert(schema.clientSessions).values({ idHash: await sha256(raw), clientId: f.clientId, createdAt: now, expiresAt: new Date(now.getTime() + CLIENT_SESSION_TTL_MS) });
  return { email, f, cookie: `${CLIENT_COOKIE}=${raw}` };
}

/** The account API as the handler answers it (in this process, on the pool): POST `path` with a JSON body, as the signed-in student. */
async function post(cookie: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const deps: AccountDeps = { db, env: {} as Env, now: new Date(), siteUrl: SITE, later: () => {}, dev: true };
  const res = await handleAccountApi(new Request(`${SITE}/api/konto${path}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), deps);
  if (!res) throw new Error(`POST ${path}: no such route`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A group registration of the student's with a contract of its own, accepted at the form, and Maria's ask on it when `asked`. */
async function registrationWithContract(s: Awaited<ReturnType<typeof student>>, asked: boolean) {
  const registrationId = s.f.registrations.confirmed!;
  made.registrations.push(registrationId);
  const contractId = await insertContract({ id: registrationId, courseId: s.f.course.id, clientId: s.f.clientId }, { name: "Kati Tamm", email: s.email });
  if (asked) expect(await requestContract(db, registrationId, new Date())).toEqual({ ok: true });
  return { registrationId, contractId };
}

/** The contract text the card would read: its version goes back with „Kinnitan“ (ruling R6). */
const currentVersion = async () => (await contractTemplate(db, "contact", "et")).version;
const accept = (s: { cookie: string }, registrationId: number, version: string) => post(s.cookie, "/leping", { registrationId, version, locale: "et" });

/** A registration's contracts as stored, the oldest first, and the ask flag. */
async function storedRegistration(registrationId: number) {
  const contracts = await onLocalDb(
    (sql) => sql<{ id: number; via: string; superseded: boolean }[]>`select id, accepted_via as via, superseded_at is not null as superseded from contracts where registration_id = ${registrationId} order by id`,
    { marksPages: false },
  );
  const [{ asked }] = await onLocalDb((sql) => sql<{ asked: boolean }[]>`select contract_requested_at is not null as asked from registrations where id = ${registrationId}`, { marksPages: false });
  return { contracts, asked, current: contracts.filter((c) => !c.superseded) };
}

test("(a) two „Kinnitan“ at the same moment on one asked registration: one new current contract, the old one superseded once, the ask cleared, one answer 200 and one 409", async ({}, info) => {
  const s = await student("race-a", ["confirmed"], info);
  const { registrationId, contractId } = await registrationWithContract(s, true);
  const version = await currentVersion();
  const [first, second] = await inFlight(registrationRow(registrationId), () => accept(s, registrationId, version), () => accept(s, registrationId, version));
  // the one that took the lock first made the contract; the other found the ask answered
  expect(first).toEqual({ status: 200, body: { ok: true } });
  expect(second).toEqual({ status: 409, body: { ok: false, error: "nothing" } });
  const stored = await storedRegistration(registrationId);
  expect(stored.contracts).toEqual([
    { id: contractId, via: "form", superseded: true },
    { id: stored.contracts[1].id, via: "account", superseded: false },
  ]);
  expect(stored.current).toHaveLength(1);
  expect(stored.asked).toBe(false);
});

for (const c of [
  { name: "asked already: „Kinnitan“ first, Maria's ask second — the new contract, and the ask stands again", asked: true, order: "accept-first", contracts: 2, flag: true },
  { name: "asked already: Maria's ask first, „Kinnitan“ second — the new contract, and the ask is cleared", asked: true, order: "ask-first", contracts: 2, flag: false },
  { name: "not asked: „Kinnitan“ first, Maria's ask second — nothing to accept yet (409), the old contract stands, and the ask is recorded", asked: false, order: "accept-first", contracts: 1, flag: true },
  { name: "not asked: Maria's ask first, „Kinnitan“ second — the new contract, and the ask is cleared", asked: false, order: "ask-first", contracts: 2, flag: false },
] as const) {
  test(`(b) Maria's ask and „Kinnitan“ at the same moment, ${c.name}`, async ({}, info) => {
    const s = await student(`race-b-${c.order === "ask-first" ? "af" : "ac"}${c.asked ? "1" : "0"}`, ["confirmed"], info);
    const { registrationId, contractId } = await registrationWithContract(s, c.asked);
    const version = await currentVersion();
    const ask = () => requestContract(db, registrationId, new Date());
    const tap = () => accept(s, registrationId, version);
    const [first, second] = c.order === "ask-first" ? await inFlight(registrationRow(registrationId), ask, tap) : await inFlight(registrationRow(registrationId), tap, ask);
    const [asked, accepted] = c.order === "ask-first" ? [first as Awaited<ReturnType<typeof ask>>, second as Awaited<ReturnType<typeof tap>>] : [second as Awaited<ReturnType<typeof ask>>, first as Awaited<ReturnType<typeof tap>>];
    // the ask is recorded in every order; „Kinnitan“ is a 200 when the ask was open when it got the lock, else a 409 (never a 500)
    expect(asked).toEqual({ ok: true });
    const accepts = c.contracts === 2;
    expect(accepted).toEqual(accepts ? { status: 200, body: { ok: true } } : { status: 409, body: { ok: false, error: "nothing" } });
    const stored = await storedRegistration(registrationId);
    // never two current contracts, and never none: the old one only when a new one replaced it
    expect(stored.current, "exactly one current contract").toHaveLength(1);
    expect(stored.contracts).toHaveLength(c.contracts);
    if (accepts) expect(stored.contracts).toEqual([{ id: contractId, via: "form", superseded: true }, { id: stored.contracts[1].id, via: "account", superseded: false }]);
    else expect(stored.contracts).toEqual([{ id: contractId, via: "form", superseded: false }]);
    expect(stored.asked).toBe(c.flag);
  });
}

test("(c) the terms gate accepted twice at the same moment for one access: both 200, one contract, one acceptance", async ({}, info) => {
  // the terms are shared by the e-course tests of both projects: this test takes the turn from reading the version to the end, so that none of them saves other terms between
  info.setTimeout(info.timeout + 180_000);
  giveBack = await holdTerms();
  const s = await student("race-c", ["ecourse"], info);
  const [access] = await onLocalDb((sql) => sql<{ id: number; slug: string }[]>`select a.id, c.slug from course_access a join courses c on c.id = a.course_id where a.client_id = ${s.f.clientId}`, { marksPages: false });
  made.accesses.push(access.id);
  const version = await courseTermsVersion(db); // (the version the gate shows: the stored setting, "1" while there is none)
  const gate = () => post(s.cookie, "/tingimused", { slug: access.slug, version, locale: "et" });
  const [first, second] = await inFlight(accessRow(access.id), gate, gate);
  expect(first).toEqual({ status: 200, body: { ok: true } });
  expect(second).toEqual({ status: 200, body: { ok: true } });
  const contracts = await onLocalDb(
    (sql) => sql<{ id: number; kind: string; via: string; version: string; superseded: boolean }[]>`select id, kind, accepted_via as via, version, superseded_at is not null as superseded from contracts where access_id = ${access.id} order by id`,
    { marksPages: false },
  );
  expect(contracts).toEqual([{ id: contracts[0].id, kind: "ecourse", via: "terms", version, superseded: false }]);
  const [{ n }] = await onLocalDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from terms_acceptances where client_id = ${s.f.clientId}`, { marksPages: false });
  expect(n).toBe(1);
});
