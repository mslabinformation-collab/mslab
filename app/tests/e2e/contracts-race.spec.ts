import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Db } from "../../src/db/client";
import { attachOrder, insertPayment } from "../../src/db/queries/payments";
import * as schema from "../../src/db/schema";
import type { ContractSnapshot } from "../../src/domain/contract";
import { LOCAL_REFERENCE_PREFIX } from "../../src/domain/payments";
import { handleAccountApi, type AccountDeps } from "../../src/server/account-api";
import { CLIENT_COOKIE, CLIENT_SESSION_TTL_MS } from "../../src/server/client-auth";
import { courseTermsVersion } from "../../src/server/client-data";
import { contractTemplate, requestContract } from "../../src/server/contracts";
import type { Env } from "../../src/server/notify";
import { settlePayment, type Facts, type SettleDeps } from "../../src/server/payments/settle";
import { newToken, sha256 } from "../../src/server/token";
import { clientEmail, holdTerms, insertAccountFixtures, type AccountFixtures } from "./account";
import { insertContract } from "./contracts";
import { onLocalDb, removeClientRows } from "./fixtures";
import { holdInvoiceSettings } from "./invoices";
import { inFlight, racePool } from "./race";
import { expect, submitsForms, test } from "./test";

// Contracts on real Postgres (contracts Task 7; owed by Tasks 3 and 6): what the unit tests' single-connection PGlite cannot show, because it runs one
// transaction at a time. The app's own account API (handleAccountApi: the very handler of POST /api/konto/leping and /api/konto/tingimused),
// requestContract (the database half of Maria's „Saada leping kinnitamiseks“) and settlePayment (the one door of every paid Montonio payment), in
// this process, on a pool of the local Postgres:
// - (a) „Kinnitan“ twice at the same moment on one asked registration (a double tap, two devices): one answer is 200 and the other 409 „nothing“; the
//   registration has one new current contract, the old one superseded once, and Maria's ask is cleared;
// - (b) Maria's ask and the student's „Kinnitan“ at the same moment, in both orders, with the registration asked already and not: whichever comes
//   second finds the first's committed state, never two current contracts (the partial unique index `contracts_current_registration` never fires: no
//   500), and the ask flag is what the order says (set when the ask came last, cleared when „Kinnitan“ did);
// - (c) the terms gate accepted twice at the same moment for one e-course access (/api/konto/tingimused): both are 200 (accepting twice is fine), and
//   the access has one contract, one acceptance of the terms;
// - (d) settle's paid winner of an e-course purchase that kept the cart's contract (payments.contract_snapshot) and the terms gate accepted at the
//   same moment for the same access, in both orders, the cart's copy of the gate's version and of an older one: both finish (the payment paid, the
//   gate 200, and no step's error swallowed: settle's contract and invoice steps log one and go on, so a deadlock there would pass unseen
//   otherwise); the access has exactly one current contract, the one that froze last, and the one before it is superseded once, at the moment the
//   later one froze (a purchase supersedes whatever is current, R4; the gate freezes nothing when the purchase's contract is of its version).
// "At the same moment" is proven, not hoped for (race.ts inFlight, as invoices-race.spec.ts): another connection holds the row the calls meet first —
// the registration's row (askedRegistration and requestContract take it FOR UPDATE first) or the access's row (completion.ts lockAccess, the first
// lock of contractForAccess and of the gate; settle's paid winner meets it earlier, at its grant's upsert of the access, admin-clients.ts
// grantAccess, which holds the row from there to the commit, its contract step included) — while the calls start, and lets it go only once this
// pool shows every call waiting for it. They stand in the lock's queue in the order started, so which goes first is fixed by the test, and the
// outcome that follows is the locks', not the timing's. No mail goes out (`dev: true`: nothing is mailed in local development; settle's mails and
// Maria's notices, the work after its response, are dropped). The rows are the tests' own sample accounts (`e2e-client-…@example.test`), found by
// the ids they stored and deleted by them; the contracts keep their rows when the registration or the account goes, so they are deleted first (the
// purchase's payment and its invoice go with the address, removeClientRows). Nothing here depends on the screen: the desktop project runs these once.

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
  ({ pool, db } = racePool(APPLICATION));
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

/** What another connection holds while two calls start: a registration's row (the first lock of „Kinnitan“ and of the ask)… */
const registrationRow = (id: number) => (tx: postgres.TransactionSql) => tx`select 1 from registrations where id = ${id} for update`;
/** …or an e-course access's row (the first lock of the terms gate's contract). */
const accessRow = (id: number) => (tx: postgres.TransactionSql) => tx`select 1 from course_access where id = ${id} for update`;

/** A student of her own, signed in (a live session in the database: the handler reads the cookie), with these cards; her rows are noted for the clean-up. */
async function student(label: string, cards: ("confirmed" | "ecourse")[], info: { project: { name: string } }) {
  const email = clientEmail(`contract-race-${label}`, info.project.name);
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
  const s = await student("a", ["confirmed"], info);
  const { registrationId, contractId } = await registrationWithContract(s, true);
  const version = await currentVersion();
  const [first, second] = await inFlight(APPLICATION, registrationRow(registrationId), () => accept(s, registrationId, version), () => accept(s, registrationId, version));
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
    const s = await student(`b-${c.order === "ask-first" ? "af" : "ac"}${c.asked ? "1" : "0"}`, ["confirmed"], info);
    const { registrationId, contractId } = await registrationWithContract(s, c.asked);
    const version = await currentVersion();
    const ask = () => requestContract(db, registrationId, new Date());
    const tap = () => accept(s, registrationId, version);
    const [first, second] = c.order === "ask-first" ? await inFlight(APPLICATION, registrationRow(registrationId), ask, tap) : await inFlight(APPLICATION, registrationRow(registrationId), tap, ask);
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
  const s = await student("c", ["ecourse"], info);
  const [access] = await onLocalDb((sql) => sql<{ id: number; slug: string }[]>`select a.id, c.slug from course_access a join courses c on c.id = a.course_id where a.client_id = ${s.f.clientId}`, { marksPages: false });
  made.accesses.push(access.id);
  const version = await courseTermsVersion(db); // (the version the gate shows: the stored setting, "1" while there is none)
  const gate = () => post(s.cookie, "/tingimused", { slug: access.slug, version, locale: "et" });
  const [first, second] = await inFlight(APPLICATION, accessRow(access.id), gate, gate);
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

/** A pending online payment of the e-course `courseId` by the student, as „Maksa“ of the cart starts it (start.ts), keeping the contract the cart showed. */
async function purchase(s: { email: string }, courseId: number, shown: ContractSnapshot): Promise<schema.Payment> {
  const now = new Date();
  const row = await insertPayment(db, { kind: "ecourse", registrationId: null, courseId, clientId: null, email: s.email, name: "Kati Tamm", locale: "et", amountCents: 19000, contractSnapshot: shown }, now, LOCAL_REFERENCE_PREFIX);
  const uuid = `e2e-${randomUUID()}`;
  await attachOrder(db, row.id, uuid, now);
  return { ...row, providerUuid: uuid };
}

/** The settlement door's dependencies: the work after the response (the mails, Maria's notices) is dropped, so nothing is sent. */
const settleDeps = (): SettleDeps => ({ db, env: {} as Env, now: new Date(), siteUrl: SITE, later: () => {}, montonio: {} as SettleDeps["montonio"] });
/** Montonio's PAID for `p`, the exact sum, by bank link (the webhook's or the return's facts). */
const paidFacts = (p: schema.Payment): Facts => ({ uuid: p.providerUuid!, status: "paid", rawStatus: "PAID", amountCents: p.amountCents, currency: "EUR", method: "paymentInitiation", bank: "Swedbank" });

for (const c of [
  { order: "settle", same: true, frozen: ["purchase"], name: "settle first, the cart's copy of the gate's version: the purchase's contract is current, and the gate, finding it, freezes none" },
  { order: "settle", same: false, frozen: ["purchase", "terms"], name: "settle first, the cart's copy of an older version: the gate's contract supersedes the purchase's" },
  { order: "gate", same: true, frozen: ["terms", "purchase"], name: "the gate first, the cart's copy of its version: the purchase's contract supersedes the gate's" },
  { order: "gate", same: false, frozen: ["terms", "purchase"], name: "the gate first, the cart's copy of an older version: the purchase's contract supersedes the gate's" },
] as const) {
  test(`(d) settle's paid winner of an e-course purchase and the terms gate at the same moment on one access, ${c.name}`, async ({}, info) => {
    // the terms' turn, as (c); and the invoice settings' (holdInvoiceSettings: the paid winner issues its invoice, in the tests' own series)
    info.setTimeout(info.timeout + 180_000);
    const terms = await holdTerms();
    giveBack = terms;
    const settings = await holdInvoiceSettings(info);
    giveBack = async () => {
      try {
        await settings();
      } finally {
        await terms();
      }
    };
    const s = await student(`d-${c.order === "settle" ? "s" : "g"}${c.same ? "1" : "0"}`, ["ecourse"], info);
    const [access] = await onLocalDb(
      (sql) => sql<{ id: number; courseId: number; slug: string }[]>`select a.id, a.course_id as "courseId", c.slug from course_access a join courses c on c.id = a.course_id where a.client_id = ${s.f.clientId}`,
      { marksPages: false },
    );
    made.accesses.push(access.id);
    const version = await courseTermsVersion(db); // (the version the gate shows)
    // the cart's copy, filled when „Maksa“ was pressed a minute ago: of the gate's version, or of one Maria has replaced since
    const pressed = new Date(Date.now() - 60_000);
    const shown: ContractSnapshot = { version: c.same ? version : `${version}-e2e-vana`, locale: "et", title: "E2E e-koolituse leping", body: "E2E ostu tekst: Kati Tamm, 190,00 €.", acceptedAt: pressed.toISOString() };
    const payment = await purchase(s, access.courseId, shown);
    const settle = () => settlePayment(settleDeps(), payment, paidFacts(payment));
    const gate = () => post(s.cookie, "/tingimused", { slug: access.slug, version, locale: "et" });

    // the app's error log while they run: settle's contract and invoice steps catch what they throw (a deadlock too) and log it
    const errors: string[] = [];
    const loggedError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
    let paid: schema.Payment;
    let gated: Awaited<ReturnType<typeof gate>>;
    try {
      if (c.order === "settle") [paid, gated] = await inFlight(APPLICATION, accessRow(access.id), settle, gate);
      else [gated, paid] = await inFlight(APPLICATION, accessRow(access.id), gate, settle);
    } finally {
      console.error = loggedError;
    }

    // both finish: the payment paid (its transaction committed, with the grant and the contract in it), the gate's answer 200 (no 500)
    expect(paid).toMatchObject({ id: payment.id, status: "paid" });
    expect(gated).toEqual({ status: 200, body: { ok: true } });
    expect(errors, "the errors the app logged").toEqual([]);
    const stored = await onLocalDb(
      (sql) => sql<{ id: number; via: string; version: string; paymentId: number | null; acceptedAt: Date; supersededAt: Date | null }[]>`
        select id, accepted_via as via, version, payment_id as "paymentId", accepted_at as "acceptedAt", superseded_at as "supersededAt"
          from contracts where access_id = ${access.id} order by id`,
      { marksPages: false },
    );
    // the ways the access's contracts were frozen, in the order they were: the lock's
    expect(stored.map((r) => r.via)).toEqual(c.frozen);
    // the purchase's is the cart's copy (its version, the press of „Maksa“ its acceptance, R7), the payment's; the gate's, the current terms
    const bought = stored.find((r) => r.via === "purchase")!;
    expect(bought).toMatchObject({ version: shown.version, paymentId: payment.id });
    expect(bought.acceptedAt.getTime()).toBe(pressed.getTime());
    for (const t of stored.filter((r) => r.via === "terms")) expect(t).toMatchObject({ version, paymentId: null });
    // exactly one current, the one frozen last; the one before it superseded once, at the moment the later one froze (settle's now is the
    // payment's paid_at, the gate's its contract's acceptance)
    const [{ paidAt }] = await onLocalDb((sql) => sql<{ paidAt: Date }[]>`select paid_at as "paidAt" from payments where id = ${payment.id}`, { marksPages: false });
    const frozeAt = (r: (typeof stored)[number]) => (r.via === "purchase" ? paidAt : r.acceptedAt).getTime();
    expect(stored.filter((r) => r.supersededAt === null).map((r) => r.id), "the current contracts").toEqual([stored.at(-1)!.id]);
    for (const [i, r] of stored.slice(0, -1).entries()) expect(r.supersededAt?.getTime(), `the ${r.via} contract superseded when the ${stored[i + 1].via} one froze`).toBe(frozeAt(stored[i + 1]));
    // the gate's acceptance, once
    const [{ n }] = await onLocalDb(
      (sql) => sql<{ n: number }[]>`select count(*)::int as n from terms_acceptances where client_id = ${s.f.clientId} and course_id = ${access.courseId} and terms_version = ${version}`,
      { marksPages: false },
    );
    expect(n).toBe(1);
  });
}
