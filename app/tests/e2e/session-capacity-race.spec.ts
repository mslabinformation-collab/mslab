import postgres from "postgres";
import type { Db } from "../../src/db/client";
import type { PublicChange } from "../../src/server/cache-targets";
import { contractTemplate } from "../../src/server/contracts";
import { tallinnToday } from "../../src/domain/client-access";
import { addManualPayment } from "../../src/server/registration-money";
import { readSession, writeSession } from "../../src/server/session-edit";
import { handleRegistration, type Deps } from "../../src/server/submit";
import { inFlight, racePool, type OnDb } from "./race";
import { createScratchDatabase, type Scratch } from "./scratch-db";
import { expect, submitsForms, test } from "./test";

// A calendar session's „Kohti“ against a public registration and against Maria's „Lisa laekumine“ on real Postgres (admin UX pass piece 4c, Task 6; owed by
// piece 3b Task 2): what the unit tests' single-connection PGlite cannot show, because it runs one transaction at a time (tests/db/session-edit.test.ts shows
// them only side by side). The app's own writeSession (the work of POST /api/admin/toimumine/<id>, the Kalender drawer's autosave), handleRegistration (the group
// form's work) and addManualPayment („Lisa laekumine“, server/registration-money.ts), in this process, on a pool of a SCRATCH database (scratch-db.ts: made on
// the local server, migrated with the app's migrations, dropped afterwards), so the local test database's rows and the public pages are never touched: the
// registration needs a published course, and nothing but this spec ever sees it. The admin's sign-in and the route's `withAdmin` are not part of it: they decide
// nothing here.
//
// All three take the session's row lock as their first statement (db/queries/seats.ts lockSession; lockForPayment for the payment: the session, then the
// registration, the order course_sessions → registrations → payments), count under it and write after it. The save counts the CONFIRMED registrations
// (domain/session-fields.ts capacityBelowConfirmed: „Kohti“ is never fewer than the confirmed; an awaiting registration may lose her seat); a registration counts
// the seats TAKEN (db/queries/seats.ts takesSeat: the confirmed and the awaiting ones whose hold has not ended) against the capacity it reads under the lock; a
// payment that would confirm a place counts the others' seats the same way (`full`: paid, but kept unconfirmed). "At the same moment" is proven, not hoped for
// (race.ts inFlight, as invoices-race.spec.ts and reviews-race.spec.ts): another connection holds the session's row FOR UPDATE while both calls start, and lets
// it go only once this pool shows both waiting for it. They stand in the lock's queue in the order started, so which goes first is fixed by the test, and the
// outcome that follows is the locks', not the timing's. The session starts with capacity 4 and three confirmed registrations (3 seats taken, one free), and one
// awaiting registration (350 € group price, nothing paid, no hold: it takes no seat).
// - (a) „Kohti“ set to 3, the seats taken (= the confirmed: the very edge of the rule), and a public registration, in both orders: saved first, the registration
//   finds the session full (`session: "full"`, nothing stored); registered first, it is stored (it found the seat free) and the save is allowed all the same (the
//   confirmed are still 3). The registration is the form's own with no online payment (`montonio` absent), so it is stored awaiting and, until it is paid,
//   holds no seat.
// - (b) „Kohti“ set under the confirmed (2 against 3) and a registration, in both orders: the save is refused `capacityBelow` whichever comes first and writes
//   nothing, so the registration is stored with the capacity still 4. (A registration is never confirmed, so it cannot be the cause of a refusal: (b) shows that
//   the refusal depends on the confirmed alone, and the registration does not disturb it.)
// - (c) „Kohti“ set to 3 and „Lisa laekumine“ of 175 € (half the price: it confirms the place) on the awaiting registration, in both orders — the pair where the
//   order changes the SAVE's answer, because the payment does confirm a registration: paid first, the place is confirmed (4 confirmed) and the save is refused
//   `capacityBelow` (it counted the confirmed under the lock, after the payment committed); saved first, the capacity is 3 and the payment finds no free seat
//   (`full: true`): the money is on the registration, which stays unconfirmed.
// In every case the session ends consistent in this setting: the capacity is not under the confirmed, and the seats taken are not above the capacity (a hold that
// an online payment gives a registration is not counted by the save, so with online payments R-c allows more seats taken than the capacity for the time of the
// hold; this spec's registrations hold none). The rows are the tests' own (the course `e2e-kohti` and its session and registrations @example.test): the scratch
// database is emptied of them between the tests (`truncate … courses cascade` reaches the registrations and the contracts they froze, which a delete of the
// course alone would leave behind) and dropped at the end. No mail goes out: the work after the response (Maria's notice, the visitor's confirmation) is
// collected into nothing and never run, and the payment asks for no receipt. Nothing here depends on the screen: the desktop project runs these once.

test.skip(({ isMobile }) => isMobile, "nothing here depends on the screen: the desktop project runs these once");

/** The name this process's pool connects under, so the test finds its own backends in pg_stat_activity and no one else's. */
const APPLICATION = `mslab-e2e-session-capacity-race-${process.pid}`;
const SITE = "http://localhost:3000";
/** The seats the session starts with: capacity 4; 3 confirmed = 3 seats taken. */
const CAPACITY = 4;
const CONFIRMED = 3;
const TAKEN = 3;
/** Half of the course's group price (35 000 cents): „Lisa laekumine“ of it confirms the place. */
const HALF = 17_500;

let scratch: Scratch;
let pool: postgres.Sql;
let db: Db;
/** A connection of its own to the scratch database: the tests' reads and writes and the lock `inFlight` holds. */
let other: postgres.Sql;
/** Where the lock is held: the scratch database (race.ts inFlight defaults to the local test database). */
const onScratch: OnDb = (work) => work(other);
/** What the app told the cache (a stored registration: its seat count), and what it logged as errors. */
let changes: PublicChange[] = [];
let errors: string[] = [];
const loggedInfo = console.info;
const loggedError = console.error;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  scratch = await createScratchDatabase("capacity");
  ({ pool, db } = racePool(APPLICATION, scratch.url, 5));
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
  changes = [];
  errors = [];
  // (writeSession asks Next.js to refresh the public pages after its commit; outside a Next.js request that fails, is logged and goes on: the test collects the lines
  // and checks that nothing else was logged as an error)
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  // the previous test's rows: the courses with their sessions, registrations and the contracts those froze (a contract outlives its registration otherwise)
  await other`truncate table courses restart identity cascade`;
  const [left] = await other<{ registrations: number; contracts: number; sessions: number }[]>`
    select (select count(*) from registrations)::int as registrations, (select count(*) from contracts)::int as contracts, (select count(*) from course_sessions)::int as sessions`;
  expect(left, "rows of the previous test left").toEqual({ registrations: 0, contracts: 0, sessions: 0 });
});
test.afterEach(() => {
  console.error = loggedError;
});

/** What another connection holds while the two calls start: the session's row (the first statement of all three). */
const sessionRow = (sessionId: number) => (tx: postgres.TransactionSql) => tx`select 1 from course_sessions where id = ${sessionId} for update`;

type Fixture = { course: { id: number; slug: string }; session: { id: number }; awaiting: { id: number } };

/**
 * A published contact course (350 € for a group), one session of capacity 4 two months away, three confirmed registrations and one awaiting registration with
 * nothing paid. (The registration of a course that is not published is refused as `form: "invalid"`.)
 */
async function session(): Promise<Fixture> {
  const slug = "e2e-kohti";
  const [course] = await other<{ id: number }[]>`
    insert into courses (slug, type, level, title, summary, body, price_group, price_individual, published)
    values (${slug}, 'contact', 'basic', ${other.json({ et: "E2E kohad" })}, ${other.json({ et: "" })}, ${other.json({ et: "" })}, 35000, 45000, true)
    returning id`;
  const [made] = await other<{ id: number }[]>`
    insert into course_sessions (course_id, starts_at, city, venue, capacity)
    values (${course.id}, date_trunc('day', now()) + interval '60 days 10 hours', 'Pärnu', 'E2E saal', ${CAPACITY}) returning id`;
  const register = async (label: string, status: "confirmed" | "awaiting_prepayment") => {
    const [row] = await other<{ id: number }[]>`
      insert into registrations (course_id, course_session_id, kind, name, email, phone, payment_choice, status)
      values (${course.id}, ${made.id}, 'group', ${`E2E Koht ${label}`}, ${`e2e-seatrace-${label}@example.test`}, '+372 5555 0111', 'half', ${status})
      returning id`;
    return row.id;
  };
  for (let i = 0; i < CONFIRMED; i++) await register(`confirmed-${i}`, "confirmed");
  const awaiting = await register("awaiting", "awaiting_prepayment");
  return { course: { id: course.id, slug }, session: { id: made.id }, awaiting: { id: awaiting } };
}

/** The session as stored, from a connection of its own: its capacity, the confirmed registrations and the seats taken now (the app's takesSeat rule, written out). */
async function stored(sessionId: number) {
  const [row] = await other<{ capacity: number; confirmed: number; taken: number }[]>`
    select s.capacity,
           count(*) filter (where r.status = 'confirmed')::int as confirmed,
           count(*) filter (where r.status = 'confirmed' or (r.status = 'awaiting_prepayment' and r.seat_hold_until > now()))::int as taken
      from course_sessions s left join registrations r on r.course_session_id = s.id
     where s.id = ${sessionId} group by s.id`;
  return row;
}

/** How many registrations the visitor of the test has stored (found by her address). */
const registered = async (email: string) => (await other<{ n: number }[]>`select count(*)::int as n from registrations where email = ${email}`)[0].n;

/** A registration as stored: its status and what is paid on it. */
const storedRegistration = async (id: number) => (await other<{ status: string; paidCents: number }[]>`select status, paid_cents as "paidCents" from registrations where id = ${id}`)[0];

/** The group registration form as the course page sends it, for this session and this visitor. */
async function form(fx: Fixture, email: string): Promise<FormData> {
  const fd = new FormData();
  const fields = {
    course: fx.course.slug,
    session: String(fx.session.id),
    name: "Kati Tamm",
    email,
    phone: "+372 5555 0112",
    payment: "half",
    terms: "on",
    locale: "et",
    contractVersion: (await contractTemplate(db, "contact", "et")).version,
  };
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** The public registration through the app's own handler (in this process, on the pool): the work after the response is dropped, so nothing is sent. */
const register = (fd: FormData) => {
  const deps: Deps = {
    db,
    env: { KV: { get: async () => null, put: async () => {} }, MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE },
    ip: "203.0.113.7",
    siteUrl: SITE,
    now: new Date(),
    later: () => {},
    changed: (change) => void changes.push(change),
  };
  return handleRegistration(deps, fd);
};

/** The drawer's autosave of „Kohti“ from the version it read, as the route's `write` runs it. */
const save = (sessionId: number, capacity: string, version: string) => writeSession(db, sessionId, { capacity }, version, { email: "maria@example.test" }, new Date());

/** „Lisa laekumine“ of half the price (bank, today, no receipt) on a registration that has nothing paid, as the panel built on that total sends it. */
const pay = (registrationId: number) => {
  const now = new Date();
  return addManualPayment(db, { registrationId, cents: HALF, paidOn: tallinnToday(now), method: "bank", receipt: false, expectedPaidCents: 0 }, now);
};

type Order = "save-first" | "other-first";
const ORDERS: readonly Order[] = ["save-first", "other-first"];

/** The save and another call at the same moment on the session's lock, `first` started before `second`; both answers by who they are. */
async function race<S, O>(fx: Fixture, order: Order, doSave: () => Promise<S>, doOther: () => Promise<O>): Promise<{ saved: S; answered: O }> {
  if (order === "save-first") {
    const [saved, answered] = await inFlight(APPLICATION, sessionRow(fx.session.id), doSave, doOther, onScratch);
    return { saved, answered };
  }
  const [answered, saved] = await inFlight(APPLICATION, sessionRow(fx.session.id), doOther, doSave, onScratch);
  return { saved, answered };
}

/**
 * What every case ends with, in this setting: the capacity is what the test expects and not under the confirmed, the seats taken are not above it (the
 * registrations here hold no seat of their own, see above); and the app logged no error but the failed refresh of pages.
 */
function expectConsistent(end: Awaited<ReturnType<typeof stored>>, capacity: number) {
  expect(end.capacity, "the capacity").toBe(capacity);
  expect(end.capacity, "the capacity is not under the confirmed").toBeGreaterThanOrEqual(end.confirmed);
  expect(end.taken, "the seats taken are not above the capacity").toBeLessThanOrEqual(end.capacity);
  expect(errors.filter((line) => !line.startsWith("[public-cache] revalidating")), "nothing logged as an error but the refresh of pages").toEqual([]);
}

const SAVED = { ok: true, version: expect.stringMatching(/^s:/), savedAt: expect.any(String) };
const BELOW = { ok: false, error: "invalid", fields: { capacity: "capacityBelow" } };

for (const order of ORDERS) {
  test(`(a) „Kohti“ set to the seats taken (${TAKEN}) and a registration at the same moment, ${order === "save-first" ? "save first" : "registration first"}: ${
    order === "save-first" ? "the registration finds the session full and stores nothing" : "the registration is stored, and the save is allowed all the same"
  }`, async () => {
    const fx = await session();
    expect(await stored(fx.session.id), "the session as the test made it").toEqual({ capacity: CAPACITY, confirmed: CONFIRMED, taken: TAKEN });
    const email = "e2e-seatrace-new@example.test";
    const read = await readSession(db, fx.session.id);
    const fd = await form(fx, email);
    const { saved, answered: registration } = await race(fx, order, () => save(fx.session.id, String(TAKEN), read!.version), () => register(fd));
    // the save counts the confirmed (3): „Kohti“ 3 is not under them, whichever comes first
    expect(saved).toMatchObject(SAVED);
    if (order === "save-first") {
      expect(registration).toEqual({ ok: false, errors: { session: "full" } });
      expect(await registered(email), "a full session stores nothing").toBe(0);
      expect(changes, "and refreshes no seat count").toEqual([]);
    } else {
      expect(registration).toEqual({ ok: true });
      expect(await registered(email), "the registration stored").toBe(1);
      expect(changes, "and asked for the seat counts to be refreshed once").toEqual([{ kind: "seats", course: fx.course.slug }]);
    }
    expectConsistent(await stored(fx.session.id), TAKEN);
    // the drawer's version moved with the save: what it read is stale now
    expect((await readSession(db, fx.session.id))!.version).not.toBe(read!.version);
  });
}

for (const order of ORDERS) {
  test(`(b) „Kohti“ set under the confirmed (${CONFIRMED - 1} against ${CONFIRMED}) and a registration at the same moment, ${
    order === "save-first" ? "save first" : "registration first"
  }: the save is refused \`capacityBelow\` and writes nothing, the registration is stored`, async () => {
    const fx = await session();
    const email = "e2e-seatrace-new@example.test";
    const read = await readSession(db, fx.session.id);
    const fd = await form(fx, email);
    const { saved, answered: registration } = await race(fx, order, () => save(fx.session.id, String(CONFIRMED - 1), read!.version), () => register(fd));
    // the refusal counts the confirmed under the lock; a registration adds none (it is awaiting until it is paid), so the order changes nothing
    expect(saved).toEqual(BELOW);
    expect(registration).toEqual({ ok: true });
    expect(await registered(email), "the registration stored").toBe(1);
    expect(changes).toEqual([{ kind: "seats", course: fx.course.slug }]);
    expectConsistent(await stored(fx.session.id), CAPACITY);
    // nothing was written: the drawer's version is still the stored one
    expect((await readSession(db, fx.session.id))!.version).toBe(read!.version);
  });
}

for (const order of ORDERS) {
  test(`(c) „Kohti“ set to ${TAKEN} and „Lisa laekumine“ that confirms the awaiting registration at the same moment, ${
    order === "save-first" ? "save first" : "payment first"
  }: ${order === "save-first" ? "the payment finds no free seat (`full`) and the registration stays unconfirmed" : "the place is confirmed and the save is refused `capacityBelow`"}`, async () => {
    const fx = await session();
    const read = await readSession(db, fx.session.id);
    const { saved, answered: paid } = await race(fx, order, () => save(fx.session.id, String(TAKEN), read!.version), () => pay(fx.awaiting.id));
    const money = { ok: true, addedCents: HALF, paidCents: HALF, receiptNumber: null };
    if (order === "save-first") {
      // capacity 3 first: the three confirmed take every seat, so the money lands on the registration but does not confirm it (D2)
      expect(saved).toMatchObject(SAVED);
      expect(paid).toEqual({ ...money, status: "awaiting_prepayment", confirmedNow: false, full: true });
      expect(await storedRegistration(fx.awaiting.id)).toEqual({ status: "awaiting_prepayment", paidCents: HALF });
      expectConsistent(await stored(fx.session.id), TAKEN);
    } else {
      // the payment first: 4 confirmed, which the save counts under the lock after the payment committed — „Kohti“ 3 is under them, nothing is written
      expect(paid).toEqual({ ...money, status: "confirmed", confirmedNow: true, full: false });
      expect(saved).toEqual(BELOW);
      expect(await storedRegistration(fx.awaiting.id)).toEqual({ status: "confirmed", paidCents: HALF });
      expect(await stored(fx.session.id)).toEqual({ capacity: CAPACITY, confirmed: CONFIRMED + 1, taken: CONFIRMED + 1 });
      expectConsistent(await stored(fx.session.id), CAPACITY);
      expect((await readSession(db, fx.session.id))!.version).toBe(read!.version);
    }
  });
}
