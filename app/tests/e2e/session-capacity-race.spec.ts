import postgres from "postgres";
import type { Db } from "../../src/db/client";
import type { PublicChange } from "../../src/server/cache-targets";
import { contractTemplate } from "../../src/server/contracts";
import { readSession, writeSession } from "../../src/server/session-edit";
import { handleRegistration, type Deps } from "../../src/server/submit";
import { insertAdminFixtures, onLocalDb, removeAdminFixtures, type AdminFixtures } from "./fixtures";
import { inFlight, racePool } from "./race";
import { expect, submitsForms, test } from "./test";

// A calendar session's „Kohti“ against a public registration on real Postgres (admin UX pass piece 4c, Task 6; owed by piece 3b Task 2): what the unit tests'
// single-connection PGlite cannot show, because it runs one transaction at a time (tests/db/session-edit.test.ts shows the two only side by side). The
// app's own writeSession (the work of POST /api/admin/toimumine/<id>, the Kalender drawer's autosave) and handleRegistration (the work of the group form's
// POST), in this process, on a pool of the local Postgres. The admin's sign-in and the route's `withAdmin` are not part of it: they decide nothing here.
//
// Both take the session's row lock as their first statement (db/queries/seats.ts lockSession: the first lock of the order course_sessions → registrations →
// payments), count the registrations under it and write after it. The save counts the CONFIRMED ones (domain/session-fields.ts capacityBelowConfirmed: „Kohti“
// is never fewer than the confirmed, an awaiting registration may lose her seat); the registration counts the seats TAKEN (db/queries/seats.ts takesSeat:
// the confirmed and the awaiting ones whose hold has not ended) against the capacity it reads under the lock. "At the same moment" is proven, not hoped for
// (race.ts inFlight, as invoices-race.spec.ts and reviews-race.spec.ts): another connection holds the session's row FOR UPDATE while both start, and lets
// it go only once this pool shows both waiting for it. They stand in the lock's queue in the order started, so which goes first is fixed by the test, and
// the outcome that follows is the locks', not the timing's. The session starts with capacity 4 and three confirmed registrations (3 seats taken, one free),
// and an awaiting one with no hold (it takes none); the registration is the form's own, with no online payment (`montonio` absent), so it is stored awaiting
// and, until it is paid, holds no seat.
// - (a) „Kohti“ set to the seats taken (3, the confirmed: the very edge of the rule) and a registration, in both orders: saved first, the registration finds
//   the session full (`session: "full"`, nothing stored); registered first, it is stored (it found the seat free) and the save is allowed all the same (the
//   confirmed are still 3).
// - (b) „Kohti“ set under the confirmed (2 against 3) and a registration, in both orders: the save is refused `capacityBelow` whichever comes first and
//   writes nothing, so the registration is stored with the capacity still 4. (A registration that is not paid adds no confirmed one, so it can never be the
//   cause of a refusal: the refusal depends on the confirmed alone, which the lock keeps still while a save counts them.)
// In every case the session ends consistent: the capacity is never under the confirmed, and the seats taken never above the capacity. The rows are the
// tests' own (the course `e2e-admin-<tag>` of insertAdminFixtures, not published until the registration needs it, the registrations @example.test), found
// by the ids noted and deleted by them. No mail goes out: the work after the response (Maria's notice, the visitor's confirmation) is collected and never
// run. Nothing here depends on the screen: the desktop project runs these once. The registration needs a published course, which the catalogue and the
// calendar show for the few seconds a test takes, so playwright.config.ts runs this spec after the others (EDITS).

test.skip(({ isMobile }) => isMobile, "nothing here depends on the screen: the desktop project runs these once");

/** The name this process's pool connects under, so the test finds its own backends in pg_stat_activity and no one else's. */
const APPLICATION = `mslab-e2e-session-capacity-race-${process.pid}`;
const SITE = "http://localhost:3000";
/** The seats the session starts with: capacity 4; 3 confirmed = 3 seats taken. */
const CAPACITY = 4;
const CONFIRMED = 3;
const TAKEN = 3;
let pool: postgres.Sql | null = null;
let db: Db;
/** The course of the test that is running (the clean-up deletes exactly its rows: the course with its session and registrations, and the contracts they froze). */
let made: AdminFixtures | null = null;
/** What the app told the cache (a stored registration: its seat count), the work it queued for after the response (dropped), and what it logged as errors. */
let changes: PublicChange[] = [];
let errors: string[] = [];
const loggedInfo = console.info;
const loggedError = console.error;

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
  test.setTimeout(60_000);
  changes = [];
  errors = [];
  // (writeSession asks Next.js to refresh the public pages after its commit; outside a Next.js request that fails, is logged and goes on: the test collects the lines
  // and checks that nothing else was logged as an error)
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
});
test.afterEach(async () => {
  console.error = loggedError;
  const fx = made;
  try {
    if (fx) {
      // exactly the rows of the course the test made: the contracts the registrations froze (they outlive them), then the course with its sessions and registrations
      await onLocalDb(
        async (sql) => {
          await sql`delete from contracts where registration_id in (select id from registrations where course_id = ${fx.course.id})`;
        },
        { marksPages: false },
      );
      expect(await removeAdminFixtures(fx.tag), "the fixture rows left").toBe(0);
    }
  } finally {
    made = null;
  }
});

/** What another connection holds while the two calls start: the session's row (the first statement of both). */
const sessionRow = (sessionId: number) => (tx: postgres.TransactionSql) => tx`select 1 from course_sessions where id = ${sessionId} for update`;

/**
 * A session of a fresh fixture course with its seats as above, and the course published (the registration of a course that is not published is refused as
 * `form: "invalid"`). The extra registrations are the course's own, so the course's clean-up takes them.
 */
async function session(info: { project: { name: string } }): Promise<AdminFixtures> {
  const fx = await insertAdminFixtures(info.project.name);
  made = fx;
  await onLocalDb(
    async (sql) => {
      for (let i = 0; i < CONFIRMED; i++)
        await sql`
          insert into registrations (course_id, course_session_id, kind, name, email, phone, payment_choice, status)
          values (${fx.course.id}, ${fx.session.id}, 'group', ${`E2E Kinnitatud ${i}`}, ${`e2e-seatrace-confirmed-${i}-${fx.tag}@example.test`}, '+372 5555 0111', 'full', 'confirmed')`;
    },
    { marksPages: false },
  );
  await onLocalDb((sql) => sql`update courses set published = true where id = ${fx.course.id}`);
  return fx;
}

/** The session as stored, from a connection of its own: its capacity, the confirmed registrations and the seats taken now (the app's takesSeat rule, written out). */
async function stored(sessionId: number) {
  const [row] = await onLocalDb(
    (sql) =>
      sql<{ capacity: number; confirmed: number; taken: number }[]>`
        select s.capacity,
               count(*) filter (where r.status = 'confirmed')::int as confirmed,
               count(*) filter (where r.status = 'confirmed' or (r.status = 'awaiting_prepayment' and r.seat_hold_until > now()))::int as taken
          from course_sessions s left join registrations r on r.course_session_id = s.id
         where s.id = ${sessionId} group by s.id`,
    { marksPages: false },
  );
  return row;
}

/** How many registrations the visitor of the test has stored (found by her address). */
const registered = async (email: string) =>
  (await onLocalDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from registrations where email = ${email}`, { marksPages: false }))[0].n;

/** The group registration form as the course page sends it, for this session and this visitor. */
async function form(fx: AdminFixtures, email: string): Promise<FormData> {
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

/** The two calls at the same moment on the session's lock, `first` started before `second`; both answers by who they are. */
async function race<S, R>(fx: AdminFixtures, order: "save-first" | "registration-first", doSave: () => Promise<S>, doRegister: () => Promise<R>): Promise<{ saved: S; registration: R }> {
  if (order === "save-first") {
    const [saved, registration] = await inFlight(APPLICATION, sessionRow(fx.session.id), doSave, doRegister);
    return { saved, registration };
  }
  const [registration, saved] = await inFlight(APPLICATION, sessionRow(fx.session.id), doRegister, doSave);
  return { saved, registration };
}

/** What every case ends with: the capacity never under the confirmed, the seats taken never above the capacity; and the app logged no error but the failed refresh of pages. */
function expectConsistent(end: Awaited<ReturnType<typeof stored>>, capacity: number) {
  expect(end.capacity, "the capacity").toBe(capacity);
  expect(end.capacity, "the capacity is never under the confirmed").toBeGreaterThanOrEqual(end.confirmed);
  expect(end.taken, "the seats taken are never above the capacity").toBeLessThanOrEqual(end.capacity);
  expect(errors.filter((line) => !line.startsWith("[public-cache] revalidating")), "nothing logged as an error but the refresh of pages").toEqual([]);
}

const SAVED = { ok: true, version: expect.stringMatching(/^s:/), savedAt: expect.any(String) };

for (const order of ["save-first", "registration-first"] as const) {
  test(`(a) „Kohti“ set to the seats taken (${TAKEN}) and a registration at the same moment, ${order}: ${
    order === "save-first" ? "the registration finds the session full and stores nothing" : "the registration is stored, and the save is allowed all the same"
  }`, async ({}, info) => {
    const fx = await session(info);
    expect(await stored(fx.session.id), "the session as the test made it").toEqual({ capacity: CAPACITY, confirmed: CONFIRMED, taken: TAKEN });
    const email = `e2e-seatrace-new-${fx.tag}@example.test`;
    const read = await readSession(db, fx.session.id);
    const fd = await form(fx, email);
    const { saved, registration } = await race(fx, order, () => save(fx.session.id, String(TAKEN), read!.version), () => register(fd));
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

for (const order of ["save-first", "registration-first"] as const) {
  test(`(b) „Kohti“ set under the confirmed (${CONFIRMED - 1} against ${CONFIRMED}) and a registration at the same moment, ${order}: the save is refused \`capacityBelow\` and writes nothing, the registration is stored`, async ({}, info) => {
    const fx = await session(info);
    const email = `e2e-seatrace-new-${fx.tag}@example.test`;
    const read = await readSession(db, fx.session.id);
    const fd = await form(fx, email);
    const { saved, registration } = await race(fx, order, () => save(fx.session.id, String(CONFIRMED - 1), read!.version), () => register(fd));
    // the refusal counts the confirmed under the lock; a registration adds none (it is awaiting until it is paid), so the order changes nothing
    expect(saved).toEqual({ ok: false, error: "invalid", fields: { capacity: "capacityBelow" } });
    expect(registration).toEqual({ ok: true });
    expect(await registered(email), "the registration stored").toBe(1);
    expect(changes).toEqual([{ kind: "seats", course: fx.course.slug }]);
    expectConsistent(await stored(fx.session.id), CAPACITY);
    // nothing was written: the drawer's version is still the stored one
    expect((await readSession(db, fx.session.id))!.version).toBe(read!.version);
  });
}
