import postgres from "postgres";
import type { Db } from "../../src/db/client";
import { attachOrder, insertPayment } from "../../src/db/queries/payments";
import * as schema from "../../src/db/schema";
import { LOCAL_REFERENCE_PREFIX } from "../../src/domain/payments";
import { contractTemplate } from "../../src/server/contracts";
import { addRegistrationDiscount, deleteCode, readCode, setCodeActive, writeCode } from "../../src/server/discount-code-admin";
import type { Env } from "../../src/server/notify";
import { settlePayment, type Facts, type SettleDeps } from "../../src/server/payments/settle";
import { handleRegistration, type Deps } from "../../src/server/submit";
import { inFlight, lockWaits, racePool, type OnDb } from "./race";
import { createScratchDatabase, type Scratch } from "./scratch-db";
import { expect, submitsForms, test } from "./test";

// Discount codes on real Postgres (F1 Task 16): what the unit and db tests' single-connection PGlite cannot show, because it runs one transaction at a
// time (tests/db/discount-submit.test.ts, discount-code-admin.test.ts and discount-redemption-lock.test.ts show the rules side by side). The app's own
// handleRegistration (the group form's work), writeCode and setCodeActive (the Sooduskoodid drawer's autosave and its switch), deleteCode, addRegistrationDiscount
// (Maria's „Lisa sooduskood“ on a registration) and settlePayment (the one door of a paid Montonio payment), in this process, on a pool of a SCRATCH database
// (scratch-db.ts: made on the local server, migrated with the app's migrations, dropped afterwards): the codes, courses and registrations here are nobody
// else's, the welcome row (only one may exist) and the public pages of the local test database are never touched, and a test that dies leaves nothing behind.
//
// The lock order the specs hold the app to (db/queries/seats.ts; server/discount-codes.ts lockCode): a registration takes the session's row, then the code's
// (`select … for no key update`, redeem), then inserts the registration and its use; Maria's code save, switch and delete take the code's row first and
// last; her „Lisa sooduskood“ and a settlement take lockForPayment (the session, then the registration) and never the code's row (the use's insert takes only
// the key-share lock of its foreign key, which `no key update` does not block). "At the same moment" is proven, not hoped for (race.ts inFlight): another
// connection holds the row the calls meet (the code's, or the session's) while they start, and lets it go only once this pool shows every call waiting for it.
// They stand in the lock's queue in the order started, so which goes first is fixed by the test, and the outcome that follows is the locks', not the
// timing's: one of the two serial orders, never a deadlock (a 40P01 would reject a call) and never a half-written pair.
// - (a) the welcome code, one address, two courses, at the same moment: the first gets it, the second is `person` (D6's once per person, counted under the
//   code's lock: without it both would read no use and both would be stored);
// - (b) the same address, the same course, at the same moment: both get it (D7: her own unpaid booking of this very course is no use);
// - (c) a code with limit 1 and two addresses: the first gets it, the second `usedUp`;
// - (d) Maria's code save (the percent) and a booking, in both orders: both finish; saved first, the booking is `changed` (the form showed the old discount);
//   booked first, the booking keeps its frozen discount and the code has the new percent after it;
// - (e) Maria's pause and a booking, in both orders: paused first, the booking is `paused`; booked first, the booking stands and the code is paused after;
// - (f) „Lisa sooduskood“ on an unpaid registration and its prepayment's settlement, in both orders: added first, the registration has the discount and the
//   payment settles on the new total; settled first, the add is `paid` and nothing is written;
// - (g) „Kustuta sooduskood“ and a booking, in both orders: deleted first, the booking is `unknown` and stores nothing; booked first, the delete is `used`;
// - (h) „Kustuta sooduskood“ and „Lisa sooduskood“ on a registration, in both orders (the add takes no lock of the code's row but its use's foreign key's
//   key-share one, so the two never queue at one lock and `inFlight` cannot order them; each order holds the lock one of them waits at, P32): the add's use
//   first, after the delete checked there was none and while its DELETE waits, the delete meets the foreign key (23503) and answers `used` (R19); the delete
//   first, while the add waits for the registration's locks, the add finds the code gone and answers `unknown`. Never an error.
// No mail goes out (the work after the response is collected into nothing; no key is set). Nothing here depends on the screen: the desktop project runs these once.

test.skip(({ isMobile }) => isMobile, "nothing here depends on the screen: the desktop project runs these once");

/** The name this process's pool connects under, so the test finds its own backends in pg_stat_activity and no one else's. */
const APPLICATION = `mslab-e2e-discount-race-${process.pid}`;
const SITE = "http://localhost:3000";
/** The group price of the courses made here, and 10% of it (the discount the forms show). */
const LIST = 35_000;
const TEN_PERCENT = 3_500;

let scratch: Scratch;
let pool: postgres.Sql;
let db: Db;
/** A connection of its own to the scratch database: the tests' reads and writes and the lock `inFlight` holds. */
let other: postgres.Sql;
/** Where the lock is held: the scratch database (race.ts inFlight defaults to the local test database). */
const onScratch: OnDb = (work) => work(other);
const loggedInfo = console.info;
const loggedError = console.error;
let errors: string[] = [];

test.beforeAll(async () => {
  test.setTimeout(120_000);
  scratch = await createScratchDatabase("discount");
  ({ pool, db } = racePool(APPLICATION, scratch.url, 6));
  other = postgres(scratch.url, { max: 4, connect_timeout: 20, onnotice: () => {} });
  console.info = () => {}; // (the app's own log lines, ids only: not the test's output)
});
test.afterAll(async () => {
  console.info = loggedInfo;
  await pool?.end();
  await other?.end();
  await scratch?.drop();
});
test.beforeEach(async () => {
  submitsForms();
  test.setTimeout(60_000);
  errors = [];
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  // the previous test's rows: the courses with their sessions, registrations, payments and the contracts those froze, the codes with their uses, the subscribers
  await other`truncate table courses, discount_codes, subscribers restart identity cascade`;
  const [left] = await other<{ registrations: number; codes: number; uses: number; payments: number }[]>`
    select (select count(*) from registrations)::int as registrations, (select count(*) from discount_codes)::int as codes,
           (select count(*) from discount_redemptions)::int as uses, (select count(*) from payments)::int as payments`;
  expect(left, "rows of the previous test left").toEqual({ registrations: 0, codes: 0, uses: 0, payments: 0 });
});
test.afterEach(() => {
  console.error = loggedError;
  expect(errors, "the errors the app logged").toEqual([]);
});

type Fixture = { id: number; slug: string; sessionId: number };

/** `count` published contact courses (350 € for a group), each with one session of capacity 6 two months away. */
async function courses(count: number): Promise<Fixture[]> {
  const made: Fixture[] = [];
  for (let i = 0; i < count; i++) {
    const slug = `e2e-sooduskood-${i}`;
    const [course] = await other<{ id: number }[]>`
      insert into courses (slug, type, level, title, summary, body, price_group, price_individual, published)
      values (${slug}, 'contact', 'basic', ${other.json({ et: `E2E soodus ${i}` })}, ${other.json({ et: "" })}, ${other.json({ et: "" })}, ${LIST}, 45000, true)
      returning id`;
    const [session] = await other<{ id: number }[]>`
      insert into course_sessions (course_id, starts_at, city, venue, capacity)
      values (${course.id}, date_trunc('day', now()) + interval '60 days 10 hours', 'Pärnu', 'E2E saal', 6) returning id`;
    made.push({ id: course.id, slug, sessionId: session.id });
  }
  return made;
}

/** A code of the test's own (10% unless `over` says otherwise), active, for anyone, once per person: its id and text. */
async function code(text: string, over: { welcome?: boolean; maxUses?: number | null } = {}): Promise<{ id: number; code: string }> {
  const welcome = over.welcome === true;
  const [row] = await other<{ id: number }[]>`
    insert into discount_codes (code, welcome, percent, audience, once_per_person, max_uses)
    values (${text}, ${welcome}, 10, ${welcome ? "first" : "all"}, true, ${over.maxUses ?? null}) returning id`;
  return { id: row.id, code: text };
}

/** An address that signed up to the newsletter and confirmed (the welcome code asks for it). */
const subscriber = (email: string) => other`insert into subscribers (email, locale, token, consent_at, confirmed_at) values (${email}, 'et', ${`tok-${email}`}, now(), now())`;

/** What another connection holds while the calls start: the code's row, as lockCode takes it (`for no key update`)… */
const codeRow = (id: number) => (tx: postgres.TransactionSql) => tx`select 1 from discount_codes where id = ${id} for no key update`;
/** …or the session's row (the first lock of a booking, of „Lisa sooduskood“ and of a settlement). */
const sessionRow = (id: number) => (tx: postgres.TransactionSql) => tx`select 1 from course_sessions where id = ${id} for update`;

/** The group registration form as the course page sends it, with the code and the discount the page showed (10%). */
async function form(c: Fixture, email: string, typed: string, shown = TEN_PERCENT): Promise<FormData> {
  const fd = new FormData();
  const fields: Record<string, string> = {
    course: c.slug,
    session: String(c.sessionId),
    name: "Kati Tamm",
    email,
    phone: "+372 5555 0112",
    payment: "half",
    terms: "on",
    locale: "et",
    contractVersion: (await contractTemplate(db, "contact", "et")).version,
    discountCode: typed,
    discountCents: String(shown),
  };
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** The public registration through the app's own handler (in this process, on the pool): no address (so no rate limit), the work after the response dropped. */
const register = (fd: FormData) => {
  const deps: Deps = {
    db,
    env: { KV: { get: async () => null, put: async () => {} }, MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE },
    ip: null,
    siteUrl: SITE,
    now: new Date(),
    later: () => {},
    changed: () => {},
  };
  return handleRegistration(deps, fd);
};

/** A registration as stored by its address: the course, the frozen discount and its code. */
const registrationsOf = (email: string) =>
  other<{ courseId: number; discountCents: number; discountCode: string }[]>`
    select course_id as "courseId", discount_cents as "discountCents", discount_code as "discountCode" from registrations where email = ${email} order by id`;
/** The uses of a code, by who used it (registration's address) and how. */
const usesOf = (codeId: number) => other<{ email: string; via: string; discountCents: number }[]>`select email, via, discount_cents as "discountCents" from discount_redemptions where code_id = ${codeId} order by id`;
/** The stored code: its percent and switch; null when it is gone. */
const storedCode = async (id: number) => (await other<{ percent: number; active: boolean }[]>`select percent, active from discount_codes where id = ${id}`)[0] ?? null;

test("(a) two registrations of one address for two courses with the welcome code at the same moment: one gets it, the other is person", async () => {
  const [a, b] = await courses(2);
  const welcome = await code("E2E-TERE", { welcome: true });
  const email = "e2e-discount-two-courses@example.test";
  await subscriber(email);
  const [fa, fb] = [await form(a, email, welcome.code), await form(b, email, welcome.code)];
  // the two sessions are two rows: the calls meet at the code's row alone
  const [first, second] = await inFlight(APPLICATION, codeRow(welcome.id), () => register(fa), () => register(fb), onScratch);
  expect(first).toEqual({ ok: true });
  expect(second).toEqual({ ok: false, errors: { discountCode: "person" } });
  expect(await registrationsOf(email), "the refused one stored nothing").toEqual([{ courseId: a.id, discountCents: TEN_PERCENT, discountCode: "E2E-TERE" }]);
  expect(await usesOf(welcome.id)).toEqual([{ email, via: "form", discountCents: TEN_PERCENT }]);
});

test("(b) the same address, same course, at the same moment: both get it", async () => {
  const [a] = await courses(1);
  const c = await code("E2E-SAMA");
  const email = "e2e-discount-same-course@example.test";
  const [f1, f2] = [await form(a, email, c.code), await form(a, email, c.code)];
  // both meet the session's row first (the second waits there, behind the first's whole transaction) and the code's row after it
  const [first, second] = await inFlight(APPLICATION, codeRow(c.id), () => register(f1), () => register(f2), onScratch);
  expect(first).toEqual({ ok: true });
  expect(second).toEqual({ ok: true });
  expect(await registrationsOf(email)).toEqual([
    { courseId: a.id, discountCents: TEN_PERCENT, discountCode: "E2E-SAMA" },
    { courseId: a.id, discountCents: TEN_PERCENT, discountCode: "E2E-SAMA" },
  ]);
  expect(await usesOf(c.id)).toHaveLength(2);
});

test("(c) limit 1 with two addresses at the same moment: one gets it, the other usedUp", async () => {
  const [a] = await courses(1);
  const c = await code("E2E-ULE", { maxUses: 1 });
  const [one, two] = ["e2e-discount-limit-one@example.test", "e2e-discount-limit-two@example.test"];
  const [f1, f2] = [await form(a, one, c.code), await form(a, two, c.code)];
  const [first, second] = await inFlight(APPLICATION, codeRow(c.id), () => register(f1), () => register(f2), onScratch);
  expect(first).toEqual({ ok: true });
  expect(second).toEqual({ ok: false, errors: { discountCode: "usedUp" } });
  expect(await registrationsOf(one)).toEqual([{ courseId: a.id, discountCents: TEN_PERCENT, discountCode: "E2E-ULE" }]);
  expect(await registrationsOf(two), "the refused one stored nothing").toEqual([]);
  expect(await usesOf(c.id)).toEqual([{ email: one, via: "form", discountCents: TEN_PERCENT }]);
});

type Order = "booking-first" | "admin-first";
const ORDERS: readonly Order[] = ["booking-first", "admin-first"];

/** The booking and Maria's call at the same moment on the lock `hold` names, `first` started before `second`; both answers by who they are. */
async function race<B, A>(order: Order, hold: (tx: postgres.TransactionSql) => Promise<unknown>, book: () => Promise<B>, admin: () => Promise<A>): Promise<{ booked: B; answered: A }> {
  if (order === "booking-first") {
    const [booked, answered] = await inFlight(APPLICATION, hold, book, admin, onScratch);
    return { booked, answered };
  }
  const [answered, booked] = await inFlight(APPLICATION, hold, admin, book, onScratch);
  return { booked, answered };
}

for (const order of ORDERS) {
  test(`(d) Maria's code save and a booking at the same moment, ${order === "booking-first" ? "booking first" : "save first"}: both finish, ${
    order === "booking-first" ? "the booking keeps its frozen discount" : "the booking is `changed`"
  }, no deadlock`, async () => {
    const [a] = await courses(1);
    const c = await code("E2E-MUUDA");
    const email = "e2e-discount-save@example.test";
    const read = (await readCode(db, c.id))!;
    const fd = await form(a, email, c.code);
    const { booked, answered } = await race(order, codeRow(c.id), () => register(fd), () => writeCode(db, c.id, { percent: "20" }, read.version, new Date()));
    // the save is allowed whichever comes first: a booking changes no field of the code, so the version it came from still holds
    expect(answered).toMatchObject({ ok: true, version: expect.stringMatching(/^k:/) });
    expect((await storedCode(c.id))!.percent, "the code has the new percent").toBe(20);
    if (order === "booking-first") {
      expect(booked).toEqual({ ok: true });
      // the booking froze the 10% it was shown; the code's 20% is for the next one
      expect(await registrationsOf(email)).toEqual([{ courseId: a.id, discountCents: TEN_PERCENT, discountCode: "E2E-MUUDA" }]);
      expect(await usesOf(c.id)).toEqual([{ email, via: "form", discountCents: TEN_PERCENT }]);
    } else {
      // the page showed 10%, the code says 20% now
      expect(booked).toEqual({ ok: false, errors: { discountCode: "changed" } });
      expect(await registrationsOf(email)).toEqual([]);
      expect(await usesOf(c.id)).toEqual([]);
    }
  });
}

for (const order of ORDERS) {
  test(`(e) Maria's pause and a booking at the same moment, ${order === "booking-first" ? "booking first" : "pause first"}: both finish, ${
    order === "booking-first" ? "the booking stands" : "the booking is `paused`"
  }, no deadlock`, async () => {
    const [a] = await courses(1);
    const c = await code("E2E-PEATA");
    const email = "e2e-discount-pause@example.test";
    const read = (await readCode(db, c.id))!;
    const fd = await form(a, email, c.code);
    const { booked, answered } = await race(order, codeRow(c.id), () => register(fd), () => setCodeActive(db, c.id, false, read.version, new Date()));
    expect(answered).toMatchObject({ ok: true, version: expect.stringMatching(/^k:/) });
    expect((await storedCode(c.id))!.active, "the code is paused").toBe(false);
    if (order === "booking-first") {
      expect(booked).toEqual({ ok: true });
      expect(await registrationsOf(email)).toEqual([{ courseId: a.id, discountCents: TEN_PERCENT, discountCode: "E2E-PEATA" }]);
      expect(await usesOf(c.id)).toHaveLength(1);
    } else {
      expect(booked).toEqual({ ok: false, errors: { discountCode: "paused" } });
      expect(await registrationsOf(email)).toEqual([]);
      expect(await usesOf(c.id)).toEqual([]);
    }
  });
}

/** An unpaid registration (half, awaiting) of the course, with its prepayment's pending payment at Montonio: the ids. */
async function unpaid(c: Fixture, email: string): Promise<{ registrationId: number; payment: schema.Payment }> {
  const [r] = await other<{ id: number }[]>`
    insert into registrations (course_id, course_session_id, kind, name, email, phone, payment_choice, status)
    values (${c.id}, ${c.sessionId}, 'group', 'Kati Tamm', ${email}, '+372 5555 0112', 'half', 'awaiting_prepayment') returning id`;
  const now = new Date();
  const row = await insertPayment(db, { kind: "prepayment", registrationId: r.id, courseId: c.id, clientId: null, email, name: "Kati Tamm", locale: "et", amountCents: LIST / 2 }, now, LOCAL_REFERENCE_PREFIX);
  const uuid = `e2e-discount-${row.id}`;
  await attachOrder(db, row.id, uuid, now);
  return { registrationId: r.id, payment: { ...row, providerUuid: uuid } };
}

/** The settlement door's dependencies: the work after the response (the mails, Maria's notices) is dropped, so nothing is sent. */
const settleDeps = (): SettleDeps => ({
  db,
  env: { KV: { get: async () => null, put: async () => {} } } as unknown as Env,
  now: new Date(),
  siteUrl: SITE,
  later: () => {},
  montonio: {} as SettleDeps["montonio"],
});
/** Montonio's PAID for `p`, the exact sum, by bank link (the webhook's or the return's facts). */
const paidFacts = (p: schema.Payment): Facts => ({ uuid: p.providerUuid!, status: "paid", rawStatus: "PAID", amountCents: p.amountCents, currency: "EUR", method: "paymentInitiation", bank: "Swedbank" });

/** The registration as stored: its status, what is paid and the frozen discount. */
const storedRegistration = async (id: number) =>
  (await other<{ status: string; paidCents: number; discountCents: number; discountCode: string }[]>`
    select status, paid_cents as "paidCents", discount_cents as "discountCents", discount_code as "discountCode" from registrations where id = ${id}`)[0];
const paymentStatus = async (id: number) => (await other<{ status: string }[]>`select status from payments where id = ${id}`)[0].status;

for (const order of ["add-first", "settle-first"] as const) {
  test(`(f) Maria's „Lisa sooduskood“ on an unpaid registration and its prepayment's settlement at the same moment, ${
    order === "add-first" ? "add first: the registration has the discount and the payment settles on the new total" : "settle first: the add is refused `paid` and writes nothing"
  }`, async () => {
    const [a] = await courses(1);
    const c = await code("E2E-LISA");
    const email = "e2e-discount-add-settle@example.test";
    const { registrationId, payment } = await unpaid(a, email);
    const add = () => addRegistrationDiscount(db, registrationId, c.code, new Date());
    const settle = () => settlePayment(settleDeps(), payment, paidFacts(payment));
    let added: Awaited<ReturnType<typeof add>>;
    let settled: schema.Payment;
    // both take lockForPayment first: the session's row, then the registration's
    if (order === "add-first") [added, settled] = await inFlight(APPLICATION, sessionRow(a.sessionId), add, settle, onScratch);
    else [settled, added] = await inFlight(APPLICATION, sessionRow(a.sessionId), settle, add, onScratch);
    expect(settled).toMatchObject({ id: payment.id, status: "paid" });
    expect(await paymentStatus(payment.id)).toBe("paid");
    if (order === "add-first") {
      expect(added).toEqual({ ok: true });
      // the settlement read the new total under the registration's lock: 175 € of 315 € is over half, so the place is confirmed, and nothing is over the price
      expect(await storedRegistration(registrationId)).toEqual({ status: "confirmed", paidCents: LIST / 2, discountCents: TEN_PERCENT, discountCode: "E2E-LISA" });
      expect(await usesOf(c.id)).toEqual([{ email, via: "admin", discountCents: TEN_PERCENT }]);
    } else {
      expect(added).toEqual({ ok: false, error: "paid" });
      expect(await storedRegistration(registrationId)).toEqual({ status: "confirmed", paidCents: LIST / 2, discountCents: 0, discountCode: "" });
      expect(await usesOf(c.id)).toEqual([]);
    }
  });
}

for (const order of ORDERS) {
  test(`(g) „Kustuta sooduskood“ and a booking at the same moment, ${order === "booking-first" ? "booking first: the delete answers used" : "delete first: the booking answers unknown"}`, async () => {
    const [a] = await courses(1);
    const c = await code("E2E-KUSTUTA");
    const email = "e2e-discount-delete@example.test";
    const fd = await form(a, email, c.code);
    // (the booking has read the code before it waits for its lock: it found the row, and finds it gone when the lock is its turn)
    const { booked, answered } = await race(order, codeRow(c.id), () => register(fd), () => deleteCode(db, c.id));
    if (order === "booking-first") {
      expect(booked).toEqual({ ok: true });
      expect(answered).toEqual({ ok: false, error: "used" });
      expect(await storedCode(c.id), "a used code stays").not.toBeNull();
      expect(await usesOf(c.id)).toHaveLength(1);
    } else {
      expect(answered).toEqual({ ok: true });
      expect(booked).toEqual({ ok: false, errors: { discountCode: "unknown" } });
      expect(await storedCode(c.id), "the code is gone").toBeNull();
      expect(await registrationsOf(email), "the refused booking stored nothing").toEqual([]);
    }
  });
}

/**
 * `waiter` started while another connection holds `hold`, seen waiting for it (the statement it waits at is returned), and `during` run to its end
 * before the lock goes; then `waiter` finishes. For two calls that do not queue at one lock (h): the test fixes which goes first by the lock one of
 * them waits at. `during` must not finish only because the lock went: it is checked to end while `waiter` still waits.
 */
async function pastHeld<W, D>(hold: (tx: postgres.TransactionSql) => Promise<unknown>, waiter: () => Promise<W>, during: () => Promise<D>): Promise<{ waited: W; ran: D; waitedAt: string }> {
  let settled = false;
  let waiting: Promise<W> | null = null;
  let ran!: D;
  let waitedAt = "";
  try {
    await other.begin(async (tx) => {
      await hold(tx);
      const running = waiter();
      waiting = running;
      void running.then(
        () => (settled = true),
        () => (settled = true),
      );
      const waits = await lockWaits(APPLICATION, 1, () => settled);
      expect(settled, "the first call went past the held lock while it was held").toBe(false);
      expect(waits.length, "the first call waits for the held lock").toBe(1);
      waitedAt = waits[0].query;
      ran = await during();
      expect(settled, "the first call still waits once the second has finished").toBe(false);
    });
  } finally {
    if (waiting) await Promise.allSettled([waiting]); // (a failure above lets the lock go too: what is on its way finishes before the clean-up)
  }
  return { waited: await waiting!, ran, waitedAt };
}

/** A key-share lock on the code's row, as a use's foreign key takes it: lockCode's `for no key update` goes past it, a DELETE of the row waits for it. */
const codeKeyShare = (id: number) => (tx: postgres.TransactionSql) => tx`select 1 from discount_codes where id = ${id} for key share`;

test("(h) „Kustuta sooduskood“ and „Lisa sooduskood“, the add's use first while the delete waits past its check: the delete meets the foreign key (23503, R19) and answers used", async () => {
  const [a] = await courses(1);
  const c = await code("E2E-KILPLEJAD");
  const email = "e2e-discount-race-fk@example.test";
  const { registrationId } = await unpaid(a, email);
  const { waited: deleted, ran: added, waitedAt } = await pastHeld(
    codeKeyShare(c.id),
    () => deleteCode(db, c.id),
    () => addRegistrationDiscount(db, registrationId, c.code, new Date()),
  );
  // the delete waited at its DELETE, so its check of the uses had found none: what refused it is the use's foreign key, not that check
  expect(waitedAt, "the delete waits at its DELETE").toMatch(/^delete from "discount_codes"/i);
  expect(added).toEqual({ ok: true });
  expect(deleted, "the delete that met the use's foreign key").toEqual({ ok: false, error: "used" });
  expect(await storedCode(c.id), "a used code stays").not.toBeNull();
  expect(await usesOf(c.id)).toEqual([{ email, via: "admin", discountCents: TEN_PERCENT }]);
  expect(await storedRegistration(registrationId)).toMatchObject({ discountCents: TEN_PERCENT, discountCode: c.code });
});

test("(h) „Kustuta sooduskood“ and „Lisa sooduskood“, the delete first while the add waits for the registration's locks: the add finds the code gone and answers unknown", async () => {
  const [a] = await courses(1);
  const c = await code("E2E-KILPLEJAD");
  const email = "e2e-discount-race-gone@example.test";
  const { registrationId } = await unpaid(a, email);
  const { waited: added, ran: deleted } = await pastHeld(
    sessionRow(a.sessionId),
    () => addRegistrationDiscount(db, registrationId, c.code, new Date()),
    () => deleteCode(db, c.id),
  );
  expect(deleted).toEqual({ ok: true });
  expect(added, "the add of a code that is gone").toEqual({ ok: false, error: "unknown" });
  expect(await storedCode(c.id), "the code is gone").toBeNull();
  expect(await usesOf(c.id)).toEqual([]);
  expect(await storedRegistration(registrationId)).toMatchObject({ discountCents: 0, discountCode: "" });
});
