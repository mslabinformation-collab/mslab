import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { attachOrder, insertPayment } from "@/db/queries/payments";
import { courses, payments, registrations, type Course, type Payment } from "@/db/schema";
import * as adminClients from "@/server/admin-clients";
import { CHECK_BATCH, checkPendingPayments } from "@/server/payments/check";
import { contactCourse, loggedDb, pendingPayment, registrationOn, settleDeps, stubMontonio } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// The daily check (phase 2b, spec 6.6): Montonio is asked about every pending payment older than 45 minutes and younger than 14 days (at most
// 50 a run, within the sweep's deadline) and its answer settled through the one door; older ones, and ones whose order was never created, fail
// (through failPayment: the registration's lock comes before the payment row, and a hold that the row kept is released); holds that ended in
// the last day revalidate the seats.

const NOW = new Date("2026-10-10T03:00:00Z");
const MIN = 60_000;
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const FOREVER = Number.MAX_SAFE_INTEGER;
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const status = async (id: number) => (await db.select().from(payments).where(eq(payments.id, id)))[0].status;
const hold = async (id: number) => (await db.select().from(registrations).where(eq(registrations.id, id)))[0].seatHoldUntil;
const snapshot = (p: { providerUuid: string | null; reference: string; amountCents?: number }, paymentStatus: string, over: Record<string, unknown> = {}) => ({
  uuid: p.providerUuid,
  paymentStatus,
  merchantReference: p.reference,
  grandTotal: ((p.amountCents ?? 17500) / 100).toFixed(2),
  currency: "EUR",
  paymentMethodType: "paymentInitiation",
  ...over,
});

/** The published e-course of the e-course tests, Kulmumeistri e-koolitus (190 €). */
async function ecourse(d: Db): Promise<Course> {
  const [c] = await d
    .insert(courses)
    .values({ slug: "kulmumeistri-e-koolitus", type: "e_learning", level: "basic", title: { et: "Kulmumeistri e-koolitus", ru: "Онлайн-курс бровиста" }, summary: { et: "" }, body: { et: "" }, published: true, price: 19000, accessMonths: 6 })
    .returning();
  return c;
}

/** A pending purchase of `course` made at `at`, whose order exists at Montonio with `providerUuid` (`uuid-<id>` by default; null: never created). */
async function ecoursePayment(d: Db, course: Course, at: Date, over: { email?: string; providerUuid?: string | null } = {}): Promise<Payment> {
  const row = await insertPayment(d, { kind: "ecourse", registrationId: null, courseId: course.id, clientId: null, email: over.email ?? "ostja@example.com", name: "Kati Tamm", locale: "et", amountCents: 19000 }, at);
  const uuid = over.providerUuid === undefined ? `uuid-${row.id}` : over.providerUuid;
  if (uuid === null) return row;
  await attachOrder(d, row.id, uuid, at);
  return { ...row, providerUuid: uuid };
}

test("older than 45 minutes: asked and settled (PAID confirms the place, ABANDONED fails); a younger one waits; no answer is counted", async () => {
  const m = stubMontonio();
  const c = await contactCourse(db);
  const r = await registrationOn(db, c);
  const paid = await pendingPayment(db, r, {}, ago(2 * 60 * MIN));
  const abandoned = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com" }), {}, ago(50 * MIN));
  const silent = await pendingPayment(db, await registrationOn(db, c, { email: "kolmas@example.com" }), {}, ago(3 * DAY));
  const young = await pendingPayment(db, await registrationOn(db, c, { email: "neljas@example.com" }), {}, ago(10 * MIN));
  m.state.snapshots.set(paid.providerUuid!, snapshot(paid, "PAID"));
  m.state.snapshots.set(abandoned.providerUuid!, snapshot(abandoned, "ABANDONED"));
  const { deps, flush } = settleDeps(db, m.montonio, NOW);
  expect(await checkPendingPayments(deps, FOREVER)).toEqual({ checked: 3, settled: 2, unanswered: 1, expired: 0, left: 0, outOfTime: false, holdsEnded: 0, errors: 0 });
  await flush();
  expect([await status(paid.id), await status(abandoned.id), await status(silent.id), await status(young.id)]).toEqual(["paid", "failed", "pending", "pending"]);
  expect((await db.select().from(registrations).where(eq(registrations.id, r.id)))[0].status).toBe("confirmed");
  expect(m.state.gets.sort()).toEqual([abandoned.providerUuid, paid.providerUuid, silent.providerUuid].sort());
  expect(m.mails().map((x) => x.subject)).toEqual(["Koht on kinnitatud — Kulmumeistri baaskoolitus", "Uus makse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €"]);
});

test("14 days old: failed without asking; an order never created (no Montonio uuid) 45 minutes on: failed", async () => {
  const m = stubMontonio();
  const c = await contactCourse(db);
  const old = await pendingPayment(db, await registrationOn(db, c), {}, ago(14 * DAY));
  const orphan = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com" }), { providerUuid: null }, ago(46 * MIN));
  const fresh = await pendingPayment(db, await registrationOn(db, c, { email: "kolmas@example.com" }), { providerUuid: null }, ago(5 * MIN));
  const { deps } = settleDeps(db, m.montonio, NOW);
  expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: 0, expired: 2 });
  expect([await status(old.id), await status(orphan.id), await status(fresh.id)]).toEqual(["failed", "failed", "pending"]);
  expect(m.state.gets).toEqual([]);
});

test(`at most ${CHECK_BATCH} a run, oldest first; out of time: no new one is asked about`, async () => {
  const m = stubMontonio();
  const r = await registrationOn(db, await contactCourse(db));
  for (let i = 0; i < CHECK_BATCH + 2; i++) await pendingPayment(db, r, {}, ago(DAY + i * MIN));
  const { deps } = settleDeps(db, m.montonio, NOW);
  expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: CHECK_BATCH, unanswered: CHECK_BATCH, left: 1, outOfTime: false });
  m.state.gets.length = 0;
  expect(await checkPendingPayments(deps, 0)).toMatchObject({ checked: 0, outOfTime: true });
  expect(m.state.gets).toEqual([]);
});

test("holds that ended in the last day revalidate the seats; none: nothing", async () => {
  const m = stubMontonio();
  const c = await contactCourse(db);
  const { deps, changes } = settleDeps(db, m.montonio, NOW);
  await checkPendingPayments(deps, FOREVER);
  expect(changes).toEqual([]);
  await registrationOn(db, c, { seatHoldUntil: ago(5 * 60 * MIN) });
  await registrationOn(db, c, { email: "teine@example.com", seatHoldUntil: ago(2 * DAY) });
  expect((await checkPendingPayments(deps, FOREVER)).holdsEnded).toBe(1);
  expect(changes).toEqual([{ kind: "seats" }]);
});

describe("what is asked, and what the answer does", () => {
  test("the age limits: 45 minutes exactly is asked, 14 days exactly is failed without asking; a payment with no order is never asked about", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const edge = await pendingPayment(db, await registrationOn(db, c), {}, ago(45 * MIN));
    const justUnder = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com" }), {}, ago(45 * MIN - 1));
    const lastDay = await pendingPayment(db, await registrationOn(db, c, { email: "kolmas@example.com" }), {}, ago(14 * DAY - 1));
    const gone = await pendingPayment(db, await registrationOn(db, c, { email: "neljas@example.com" }), {}, ago(14 * DAY));
    const { deps } = settleDeps(db, m.montonio, NOW);
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: 2, unanswered: 2, expired: 1 });
    expect(m.state.gets.sort()).toEqual([edge.providerUuid, lastDay.providerUuid].sort());
    expect([await status(edge.id), await status(justUnder.id), await status(lastDay.id), await status(gone.id)]).toEqual(["pending", "pending", "pending", "failed"]);
  });

  test("a row that is not pending is never asked about", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    for (const s of ["paid", "failed", "held", "refunded"] as const) {
      const p = await pendingPayment(db, r, {}, ago(2 * DAY));
      await db.update(payments).set({ status: s }).where(eq(payments.id, p.id));
    }
    const { deps } = settleDeps(db, m.montonio, NOW);
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: 0, expired: 0, left: 0 });
    expect(m.state.gets).toEqual([]);
  });

  test("PENDING (the payer is still at the bank): nothing changes and it is not counted as settled or unanswered", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)), {}, ago(2 * 60 * MIN));
    m.state.snapshots.set(p.providerUuid!, snapshot(p, "PENDING"));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: 1, settled: 0, unanswered: 0 });
    await flush();
    expect(await status(p.id)).toBe("pending");
    expect(m.mails()).toEqual([]);
  });

  test("PAID with another amount is held and Maria is told, counted as settled; an order that is not this payment's changes nothing", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const wrongAmount = await pendingPayment(db, await registrationOn(db, c), {}, ago(2 * 60 * MIN));
    const someoneElses = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com" }), {}, ago(3 * 60 * MIN));
    m.state.snapshots.set(wrongAmount.providerUuid!, snapshot(wrongAmount, "PAID", { grandTotal: "170.00" }));
    m.state.snapshots.set(someoneElses.providerUuid!, snapshot({ ...someoneElses, reference: "MSLAB-M999" }, "PAID"));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: 2, settled: 1, unanswered: 0 });
    await flush();
    expect([await status(wrongAmount.id), await status(someoneElses.id)]).toEqual(["held", "pending"]);
    expect(m.mails().map((x) => x.to)).toEqual(["maria@example.test"]);
    expect(m.mails()[0].subject).toBe("Kontrolli Montonios: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €");
  });

  test("an e-course row is checked the same way: PAID opens the course", async () => {
    const m = stubMontonio();
    const e = await ecoursePayment(db, await ecourse(db), ago(2 * 60 * MIN));
    m.state.snapshots.set(e.providerUuid!, snapshot(e, "PAID"));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: 1, settled: 1 });
    await flush();
    expect((await db.select().from(payments))[0]).toMatchObject({ status: "paid" });
    expect((await db.select().from(payments))[0].clientId).not.toBeNull();
    expect(m.mails().map((x) => x.subject)).toEqual(["E-koolitus on avatud — Kulmumeistri e-koolitus", "Uus makse: Kati Tamm, Kulmumeistri e-koolitus (e-koolitus), 190 €"]);
  });

  test("a PAID e-course row whose grant throws ends paid, and Maria is told at once to open it by hand (no payer mail)", async () => {
    const m = stubMontonio();
    const e = await ecoursePayment(db, await ecourse(db), ago(2 * 60 * MIN));
    m.state.snapshots.set(e.providerUuid!, snapshot(e, "PAID"));
    vi.spyOn(adminClients, "grantAccess").mockRejectedValue(Object.assign(new Error("boom for ostja@example.com"), { code: "XX000" }));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: 1, settled: 1 });
    await flush();
    expect((await db.select().from(payments))[0]).toMatchObject({ status: "paid", clientId: null });
    expect(m.mails().map((x) => x.to)).toEqual(["maria@example.test"]);
    expect(m.mails()[0].text).toContain("E-koolitust ei avatud. Ava ligipääs käsitsi (Õpilased) või tagasta raha Montonios.");
    // it is paid for good: tomorrow's check does not ask about it again
    m.state.gets.length = 0;
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: 0 });
    expect(m.state.gets).toEqual([]);
  });

  test("a transient database error while settling is counted (errors: 1), not thrown; the payment stays pending and tomorrow's check settles it", async () => {
    const m = stubMontonio();
    const e = await ecoursePayment(db, await ecourse(db), ago(2 * 60 * MIN));
    m.state.snapshots.set(e.providerUuid!, snapshot(e, "PAID"));
    const grant = vi.spyOn(adminClients, "grantAccess").mockRejectedValueOnce(Object.assign(new Error("deadlock detected"), { code: "40P01" }));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: 1, settled: 0, errors: 1 });
    await flush();
    expect((await db.select().from(payments))[0]).toMatchObject({ status: "pending", paidAt: null, clientId: null });
    expect(m.mails()).toEqual([]);
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: 1, settled: 1, errors: 0 });
    await flush();
    expect((await db.select().from(payments))[0]).toMatchObject({ status: "paid" });
    expect(grant).toHaveBeenCalledTimes(2);
    expect(m.mails().map((x) => x.subject)[0]).toBe("E-koolitus on avatud — Kulmumeistri e-koolitus");
  });

  test("no lock and no transaction is open while Montonio is asked", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const paid = await pendingPayment(db, await registrationOn(db, c), {}, ago(2 * 60 * MIN));
    const abandoned = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com" }), {}, ago(3 * 60 * MIN));
    await pendingPayment(db, await registrationOn(db, c, { email: "kolmas@example.com" }), {}, ago(4 * 60 * MIN));
    await pendingPayment(db, await registrationOn(db, c, { email: "vana@example.com", seatHoldUntil: ago(DAY) }), {}, ago(20 * DAY)); // (one to fail before the asking)
    m.state.snapshots.set(paid.providerUuid!, snapshot(paid, "PAID"));
    m.state.snapshots.set(abandoned.providerUuid!, snapshot(abandoned, "ABANDONED"));
    // PGlite runs one transaction at a time: a plain query made while another call's transaction is open waits for it. One that is answered
    // while Montonio is being asked proves that no transaction (so no lock) is open across the call.
    const blocked: boolean[] = [];
    const probe = async () => Promise.race([db.execute(sql`select 1`).then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 1500))]);
    const montonio = {
      ...m.montonio,
      fetchOrder: async (uuid: string) => {
        blocked.push(await probe());
        return m.montonio.fetchOrder(uuid);
      },
    };
    const { deps, flush } = settleDeps(db, montonio, NOW);
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: 3, expired: 1 });
    await flush();
    expect(blocked).toEqual([false, false, false]);
  });
});

describe("the rows that fail: through failPayment, the registration's lock first (course_sessions → registrations → payments)", () => {
  // A prepayment's failure ends its seat hold, and failPayment locks its registration before it writes the payment row. One bulk UPDATE of
  // every stale row would write payments first and a registration after (a concurrent re-send of the same payment locks them the other way
  // round): the log of the SQL it sends shows the order.
  const REGISTRATION_LOCK = /^select 1 from registrations where id = \$1 for update$/;
  const SESSION_LOCK = /^select 1 from course_sessions where id = \(select course_session_id from registrations where id = \$1\) for update$/;
  const PAYMENT_UPDATE = /^update "payments"/;

  test("a stale prepayment: the registration is locked before its payment row is written (a session lock is not needed to free a seat)", async () => {
    const { db: logged, queries } = await loggedDb();
    const m = stubMontonio();
    const c = await contactCourse(logged);
    const stale = await pendingPayment(logged, await registrationOn(logged, c, { seatHoldUntil: ago(14 * DAY) }), {}, ago(14 * DAY));
    const { deps } = settleDeps(logged, m.montonio, NOW);
    queries.length = 0;
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ expired: 1 });
    const lock = queries.findIndex((q) => REGISTRATION_LOCK.test(q));
    const update = queries.findIndex((q) => PAYMENT_UPDATE.test(q));
    expect([lock, update].every((i) => i >= 0), JSON.stringify(queries.map((q) => q.slice(0, 60)))).toBe(true);
    expect(lock).toBeLessThan(update);
    expect(queries.some((q) => SESSION_LOCK.test(q))).toBe(false);
    expect((await logged.select().from(payments).where(eq(payments.id, stale.id)))[0].status).toBe("failed");
  });

  test("several stale rows (two registrations, three payments): each payment row is written right after its own registration's lock, one transaction each", async () => {
    const { db: logged, queries } = await loggedDb();
    const m = stubMontonio();
    const c = await contactCourse(logged);
    const r1 = await registrationOn(logged, c);
    const r2 = await registrationOn(logged, c, { email: "teine@example.com" });
    await pendingPayment(logged, r1, {}, ago(20 * DAY));
    await pendingPayment(logged, r1, { providerUuid: null }, ago(3 * 60 * MIN));
    await pendingPayment(logged, r2, {}, ago(15 * DAY));
    const { deps } = settleDeps(logged, m.montonio, NOW);
    queries.length = 0;
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ expired: 3 });
    const writes = queries.flatMap((q) => (REGISTRATION_LOCK.test(q) ? ["lock"] : PAYMENT_UPDATE.test(q) ? ["payment"] : []));
    expect(writes).toEqual(["lock", "payment", "lock", "payment", "lock", "payment"]);
    expect((await logged.select().from(payments)).map((p) => p.status)).toEqual(["failed", "failed", "failed"]);
  });

  test("a stale e-course purchase has no registration: it is failed with no registration or session lock", async () => {
    const { db: logged, queries } = await loggedDb();
    const m = stubMontonio();
    const e = await ecoursePayment(logged, await ecourse(logged), ago(15 * DAY));
    const { deps, changes } = settleDeps(logged, m.montonio, NOW);
    queries.length = 0;
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ expired: 1 });
    expect(queries.some((q) => PAYMENT_UPDATE.test(q))).toBe(true);
    expect(queries.some((q) => REGISTRATION_LOCK.test(q) || SESSION_LOCK.test(q))).toBe(false);
    expect((await logged.select().from(payments).where(eq(payments.id, e.id)))[0].status).toBe("failed");
    expect(changes).toEqual([]);
  });

  test("a row that is paid between the choosing and the failing is left alone and not counted", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const a = await pendingPayment(db, await registrationOn(db, c), {}, ago(15 * DAY));
    const b = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com" }), {}, ago(14 * DAY));
    const { deps } = settleDeps(db, m.montonio, NOW);
    // the webhook wins for `a` at the moment the first failing begins (its transaction)
    const transaction = db.transaction as unknown as (...args: unknown[]) => Promise<unknown>;
    let first = true;
    vi.spyOn(db, "transaction").mockImplementation(((...args: unknown[]) => {
      const run = () => transaction.apply(db, args);
      if (!first) return run();
      first = false;
      return db.update(payments).set({ status: "paid", paidAt: NOW }).where(eq(payments.id, a.id)).then(run);
    }) as unknown as Db["transaction"]);
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ expired: 1 });
    expect([await status(a.id), await status(b.id)]).toEqual(["paid", "failed"]);
  });

  test("a prepayment with no order, which a later failed attempt's hold hung on, fails and frees the seat; with another attempt still pending the hold stays", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const until = new Date(NOW.getTime() + 10 * MIN);
    // r1: the first start broke off (no order), a second one was started 20 minutes ago and failed; the first row kept the second one's hold
    const r1 = await registrationOn(db, c, { seatHoldUntil: until });
    const orphan1 = await pendingPayment(db, r1, { providerUuid: null }, ago(46 * MIN));
    const second = await pendingPayment(db, r1, {}, ago(20 * MIN));
    await db.update(payments).set({ status: "failed" }).where(eq(payments.id, second.id));
    // r2: the same, but a third attempt is still open (pending, its order younger than the window)
    const r2 = await registrationOn(db, c, { email: "teine@example.com", seatHoldUntil: until });
    const orphan2 = await pendingPayment(db, r2, { providerUuid: null }, ago(46 * MIN));
    const open = await pendingPayment(db, r2, {}, ago(20 * MIN));
    const { deps, changes } = settleDeps(db, m.montonio, NOW);
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: 0, expired: 2, holdsEnded: 0 });
    expect([await status(orphan1.id), await status(orphan2.id), await status(open.id)]).toEqual(["failed", "failed", "pending"]);
    expect(await hold(r1.id)).toBeNull(); // (the seat is free at once: the calendar is told once)
    expect(await hold(r2.id)).toEqual(until);
    expect(changes).toEqual([{ kind: "seats" }]);
  });

  test("a balance payment, or a prepayment whose hold has ended, fails without touching any hold or the calendar", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const confirmed = await registrationOn(db, c, { status: "confirmed", paidCents: 17500 });
    await pendingPayment(db, confirmed, { kind: "balance", amountCents: 17500 }, ago(15 * DAY));
    const ended = await registrationOn(db, c, { email: "teine@example.com", seatHoldUntil: ago(14 * DAY) });
    await pendingPayment(db, ended, {}, ago(15 * DAY));
    const { deps, changes } = settleDeps(db, m.montonio, NOW);
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ expired: 2, holdsEnded: 0 });
    expect(changes).toEqual([]);
    expect((await db.select().from(registrations).where(eq(registrations.id, ended.id)))[0].seatHoldUntil).toEqual(ago(14 * DAY));
  });

  test(`at most ${CHECK_BATCH} fail a run, oldest first; the rest wait for the next run and are counted as left`, async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const rows: Payment[] = [];
    for (let i = 0; i < CHECK_BATCH + 2; i++) rows.push(await pendingPayment(db, r, {}, ago(15 * DAY + i * MIN))); // (the last is the oldest)
    const { deps } = settleDeps(db, m.montonio, NOW);
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: 0, expired: CHECK_BATCH, left: 1 });
    expect(await Promise.all(rows.slice(0, 2).map((p) => status(p.id)))).toEqual(["pending", "pending"]); // the two youngest
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ expired: 2, left: 0 });
    expect(await Promise.all(rows.map((p) => status(p.id)))).toEqual(rows.map(() => "failed"));
    expect(m.state.gets).toEqual([]);
  });
});

describe("one payment that cannot be settled does not stop the check", () => {
  // A row whose settlement (or whose failing) throws on every run used to abort the whole check: the rows behind it were never asked about, and
  // a stale one never left the stale set. Now each row is its own try: the error is counted and logged (class and code), the next row goes on;
  // three in a row stop the run (a dead database must not burn fifty rows), and what was not reached is counted as left.
  const poison = async (table: "registrations" | "payments") => {
    const condition = table === "registrations" ? "new.paid_cents > 0" : "new.status = 'failed'";
    await db.execute(sql.raw(`create function mslab_poison() returns trigger language plpgsql as $$ begin if ${condition} and new.email like 'giftig%' then raise exception 'refused'; end if; return new; end $$`));
    await db.execute(sql.raw(`create trigger mslab_poison before update on ${table} for each row execute function mslab_poison()`));
  };
  const logged = () => vi.mocked(console.error).mock.calls.map((c) => c.map(String).join(" "));

  test("a settlement that throws on every run: the next row is still asked about and settled; the error is counted and logged without an address", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await poison("registrations");
    const bad = await pendingPayment(db, await registrationOn(db, c, { email: "giftig@example.com" }), {}, ago(3 * 60 * MIN));
    const good = await pendingPayment(db, await registrationOn(db, c, { email: "hea@example.com" }), {}, ago(2 * 60 * MIN));
    for (const p of [bad, good]) m.state.snapshots.set(p.providerUuid!, snapshot(p, "PAID"));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    expect(await checkPendingPayments(deps, FOREVER)).toEqual({ checked: 2, settled: 1, unanswered: 0, expired: 0, left: 0, outOfTime: false, holdsEnded: 0, errors: 1 });
    await flush();
    expect([await status(bad.id), await status(good.id)]).toEqual(["pending", "paid"]);
    expect(m.mails().map((x) => x.to)).toEqual(["hea@example.com", "maria@example.test"]);
    // the log has the payment's id, the error's class and code: no address, no message
    expect(logged().filter((l) => l.includes("could not be settled"))).toEqual([`[payments] a payment could not be settled (payment ${bad.id}): DrizzleQueryError (code P0001)`]);
    expect(logged().join("\n")).not.toMatch(/giftig|refused|@/);
    // tomorrow, with the cause gone, the same row is settled
    await db.execute(sql`drop trigger mslab_poison on registrations`);
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: 1, settled: 1, errors: 0 });
    expect(await status(bad.id)).toBe("paid");
  });

  test("a stale row whose failing throws does not stop the check: the other stale row is failed and the pending payments are still asked about", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await poison("payments");
    const bad = await pendingPayment(db, await registrationOn(db, c, { email: "giftig@example.com" }), {}, ago(20 * DAY));
    const stale = await pendingPayment(db, await registrationOn(db, c, { email: "vana@example.com" }), {}, ago(15 * DAY));
    const open = await pendingPayment(db, await registrationOn(db, c, { email: "hea@example.com" }), {}, ago(2 * 60 * MIN));
    m.state.snapshots.set(open.providerUuid!, snapshot(open, "PAID"));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: 1, settled: 1, expired: 1, left: 0, errors: 1 });
    await flush();
    expect([await status(bad.id), await status(stale.id), await status(open.id)]).toEqual(["pending", "failed", "paid"]);
    expect(m.state.gets).toEqual([open.providerUuid]);
    expect(logged().filter((l) => l.includes("could not be settled"))).toEqual([`[payments] a payment could not be settled (payment ${bad.id}): DrizzleQueryError (code P0001)`]);
  });

  test("three errors in a row stop the asking (what was not reached is left), and the seats are still revalidated", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await poison("registrations");
    const rows: Payment[] = [];
    for (let i = 1; i <= 4; i++) rows.push(await pendingPayment(db, await registrationOn(db, c, { email: `giftig${i}@example.com` }), {}, ago((10 - i) * 60 * MIN)));
    rows.push(await pendingPayment(db, await registrationOn(db, c, { email: "hea@example.com" }), {}, ago(2 * 60 * MIN)));
    for (const p of rows) m.state.snapshots.set(p.providerUuid!, snapshot(p, "PAID"));
    await registrationOn(db, c, { email: "hold@example.com", seatHoldUntil: ago(5 * 60 * MIN) }); // a hold that ended in the last day
    const { deps, changes } = settleDeps(db, m.montonio, NOW);
    expect(await checkPendingPayments(deps, FOREVER)).toEqual({ checked: 3, settled: 0, unanswered: 0, expired: 0, left: 2, outOfTime: false, holdsEnded: 1, errors: 3 });
    expect(m.state.gets).toHaveLength(3);
    expect(await Promise.all(rows.map((p) => status(p.id)))).toEqual(["pending", "pending", "pending", "pending", "pending"]);
    expect(changes).toEqual([{ kind: "seats" }]);
  });

  test("errors that are not in a row do not stop it: a good row in between starts the count again", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await poison("registrations");
    const rows: Payment[] = [];
    // two bad, a good one, two bad, a good one: four errors, never three in a row
    for (const [i, who] of ["giftig1", "giftig2", "hea1", "giftig3", "giftig4", "hea2"].entries()) rows.push(await pendingPayment(db, await registrationOn(db, c, { email: `${who}@example.com` }), {}, ago((10 - i) * 60 * MIN)));
    for (const p of rows) m.state.snapshots.set(p.providerUuid!, snapshot(p, "PAID"));
    const { deps } = settleDeps(db, m.montonio, NOW);
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: 6, settled: 2, left: 0, errors: 4 });
    expect(await Promise.all(rows.map((p) => status(p.id)))).toEqual(["pending", "pending", "paid", "pending", "pending", "paid"]);
  });

  test("three stale rows in a row that cannot be failed stop the failing (the rest is left); the asking goes on", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await poison("payments");
    const rows: Payment[] = [];
    for (let i = 1; i <= 4; i++) rows.push(await pendingPayment(db, await registrationOn(db, c, { email: `giftig${i}@example.com` }), {}, ago((21 - i) * DAY)));
    rows.push(await pendingPayment(db, await registrationOn(db, c, { email: "vana@example.com" }), {}, ago(15 * DAY)));
    const open = await pendingPayment(db, await registrationOn(db, c, { email: "hea@example.com" }), {}, ago(2 * 60 * MIN));
    m.state.snapshots.set(open.providerUuid!, snapshot(open, "PENDING"));
    const { deps } = settleDeps(db, m.montonio, NOW);
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ checked: 1, expired: 0, left: 2, errors: 3 });
    expect(await Promise.all(rows.map((p) => status(p.id)))).toEqual(["pending", "pending", "pending", "pending", "pending"]);
    expect(m.state.gets).toEqual([open.providerUuid]);
  });

  test("stale rows that fail now and then: the good ones are failed, nothing is left, nothing stops", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await poison("payments");
    const rows: Payment[] = [];
    for (const [i, who] of ["giftig1", "vana1", "giftig2", "vana2", "giftig3", "vana3"].entries()) rows.push(await pendingPayment(db, await registrationOn(db, c, { email: `${who}@example.com` }), {}, ago((20 - i) * DAY)));
    const { deps } = settleDeps(db, m.montonio, NOW);
    expect(await checkPendingPayments(deps, FOREVER)).toMatchObject({ expired: 3, left: 0, errors: 3 });
    expect(await Promise.all(rows.map((p) => status(p.id)))).toEqual(["pending", "failed", "pending", "failed", "pending", "failed"]);
  });
});

describe("what the check says", () => {
  test("it tells no address, reference or uuid: neither in what it logs nor in what it answers", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const paid = await pendingPayment(db, await registrationOn(db, c), {}, ago(2 * 60 * MIN));
    const abandoned = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com" }), {}, ago(3 * 60 * MIN));
    const silent = await pendingPayment(db, await registrationOn(db, c, { email: "kolmas@example.com" }), {}, ago(4 * 60 * MIN));
    const old = await pendingPayment(db, await registrationOn(db, c, { email: "neljas@example.com" }), {}, ago(15 * DAY));
    m.state.snapshots.set(paid.providerUuid!, snapshot(paid, "PAID"));
    m.state.snapshots.set(abandoned.providerUuid!, snapshot(abandoned, "ABANDONED"));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    const answer = await checkPendingPayments(deps, FOREVER);
    await flush();
    expect(Object.values(answer).every((v) => typeof v === "number" || typeof v === "boolean")).toBe(true);
    const logged = [...vi.mocked(console.info).mock.calls, ...vi.mocked(console.error).mock.calls].map((c) => c.map(String).join(" "));
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of ["@", "MSLAB-M", paid.providerUuid!, abandoned.providerUuid!, silent.providerUuid!, old.providerUuid!]) expect(logged.join("\n"), secret).not.toContain(secret);
  });

  test("a failing revalidation does not lose the answer", async () => {
    const m = stubMontonio();
    await registrationOn(db, await contactCourse(db), { seatHoldUntil: ago(5 * 60 * MIN) });
    const { deps } = settleDeps(db, m.montonio, NOW);
    expect(await checkPendingPayments({ ...deps, changed: () => Promise.reject(new Error("no cache")) }, FOREVER)).toMatchObject({ holdsEnded: 1 });
  });
});
