import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { payments, registrations, settings } from "@/db/schema";
import type { PublicChange } from "@/server/cache-targets";
import type { Env } from "@/server/notify";
import type { Montonio } from "@/server/payments/montonio";
import { paymentUrls, startRegistrationPayment, STARTS_PER_HOUR } from "@/server/payments/start";
import { handleRegistration, type Deps } from "@/server/submit";
import { fakeKv } from "../fakes";
import { contactCourse, loggedDb, registrationOn, SITE, stubMontonio } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// "Registreeru" starts the prepayment (phase 2b, spec 6.1): a 30-minute hold, a pending row MSLAB-M<id>, Montonio's order and { ok, paymentUrl }.
// Without payments, or with Montonio down, the registration stands and the answer is today's. startRegistrationPayment's own checks, the one
// lock order of every payment path (course_sessions → registrations → payments) and the rule that no lock is held across Montonio's call.

const NOW = new Date("2026-10-09T10:00:00Z");
const MIN = 60_000;
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function deps(montonio: Deps["montonio"], opts: { mail?: boolean; db?: Db } = {}) {
  const tasks: (() => Promise<unknown>)[] = [];
  const changes: PublicChange[] = [];
  const env: Env = { KV: fakeKv({ "tg:chat": "42" }), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, ...(opts.mail ? { RESEND_API_KEY: "re_test", TELEGRAM_BOT_TOKEN: "123:abc" } : {}) };
  const d: Deps = { db: opts.db ?? db, env, ip: "203.0.113.9", siteUrl: SITE, now: NOW, later: (t) => void tasks.push(t), changed: (c) => void changes.push(c), montonio };
  return { d, changes, flush: async () => { for (let t = tasks.shift(); t; t = tasks.shift()) await t(); } };
}

const form = (sessionId: number, over: Record<string, string> = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ course: "kulmumeistri-baaskoolitus", session: String(sessionId), name: "Kati Tamm", email: "kati@example.com", phone: "+372 5555 0101", payment: "half", terms: "on", locale: "ru", ...over })) fd.set(k, v);
  return fd;
};
const rows = () => db.select().from(payments);
const reg = async () => (await db.select().from(registrations))[0];

/**
 * `real` with a hook on its 2nd `transaction` call: handleRegistration's own transaction is the 1st, the payment start's the 2nd. The hook runs
 * first and may throw (the start then really throws: nothing inside the start catches a failing transaction) or change the database (the
 * start then meets a changed world).
 */
function onStart(real: Db, hook: () => Promise<void>): Db {
  let calls = 0;
  return new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (prop === "transaction")
        return async (...args: unknown[]) => {
          if (++calls === 2) await hook();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * `real` with every top-level `transaction` recorded: for each one, the names of the executor methods the callback called on its
 * transaction object (`execute`, `select`, `update`, `insert`, `delete`), in order. A statement that runs on the pool instead of on the
 * transaction is not in any list.
 */
function recordTransactions(real: Db): { db: Db; transactions: string[][] } {
  const transactions: string[][] = [];
  const METHODS = new Set(["execute", "select", "update", "insert", "delete"]);
  const db = new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (prop !== "transaction") return typeof value === "function" ? value.bind(target) : value;
      return (callback: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
        (value as (...a: unknown[]) => Promise<unknown>).call(
          target,
          (tx: object) => {
            const calls: string[] = [];
            transactions.push(calls);
            const recording = new Proxy(tx, {
              get(inner, name) {
                const member: unknown = Reflect.get(inner, name, inner);
                if (typeof member !== "function") return member;
                return (...args: unknown[]) => {
                  if (typeof name === "string" && METHODS.has(name)) calls.push(name);
                  return (member as (...a: unknown[]) => unknown).apply(inner, args);
                };
              },
            });
            return callback(recording);
          },
          ...rest,
        );
    },
  });
  return { db, transactions };
}

describe("Registreeru with payments", () => {
  test("the hold for 30 minutes, a pending row MSLAB-M<id> of 175 €, Montonio's order for it, and the payment page in the answer", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const { d, changes } = deps(m.montonio);
    const result = await handleRegistration(d, form(c.session.id));
    const [p] = await rows();
    expect(result).toEqual({ ok: true, paymentUrl: `https://sandbox-stargate.montonio.com/${p.providerUuid}` });
    expect(p).toMatchObject({ reference: `MSLAB-M${p.id}`, kind: "prepayment", status: "pending", amountCents: 17500, email: "kati@example.com", name: "Kati Tamm", locale: "ru", courseId: c.course.id });
    const r = await reg();
    expect([p.registrationId, r.seatHoldUntil]).toEqual([r.id, new Date(NOW.getTime() + 30 * MIN)]);
    expect(m.state.orders).toEqual([expect.objectContaining({ merchantReference: p.reference, grandTotal: 175, locale: "ru", returnUrl: `${SITE}/api/payments/return`, notificationUrl: `${SITE}/api/payments/notify` })]);
    expect(changes).toEqual([{ kind: "seats", course: "kulmumeistri-baaskoolitus" }]);
  });

  test("Montonio down: the registration is stored, today's answer; the row is failed and holds nothing", async () => {
    const m = stubMontonio();
    m.state.down = true;
    const c = await contactCourse(db);
    const { d } = deps(m.montonio);
    expect(await handleRegistration(d, form(c.session.id))).toEqual({ ok: true });
    expect((await rows()).map((p) => p.status)).toEqual(["failed"]);
    expect((await reg()).seatHoldUntil).toBeNull();
  });

  test("without payments: today's behaviour — no row, no hold", async () => {
    const c = await contactCourse(db);
    const { d } = deps(null);
    expect(await handleRegistration(d, form(c.session.id))).toEqual({ ok: true });
    expect(await rows()).toEqual([]);
    expect((await reg()).seatHoldUntil).toBeNull();
  });

  test("the confirmation mail carries 'Maksa 175 €' (/maksa/<pay_token>) and, under it, the transfer; without payments today's mail", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await db.insert(settings).values({ key: "prepayment", value: { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" } });
    const { d, flush } = deps(m.montonio, { mail: true });
    await handleRegistration(d, form(c.session.id, { locale: "et" }));
    await flush();
    const r = await reg();
    const mine = m.mails().find((x) => x.to === "kati@example.com")!;
    expect(mine.text).toContain(`Maksa 175 €: ${SITE}/maksa/${r.payToken}`);
    expect(mine.text).toContain("või tasu pangaülekandega");
    const off = deps(null, { mail: true });
    await db.delete(payments);
    await db.delete(registrations);
    await handleRegistration(off.d, form(c.session.id, { locale: "et", email: "teine@example.com" }));
    await off.flush();
    expect(m.mails().find((x) => x.to === "teine@example.com")!.text).not.toContain("Maksa");
  });

  test("an unexpected error from Montonio's client is caught inside the start: today's answer, the row failed, no hold", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const broken: Montonio = { ...m.montonio, createOrder: () => Promise.reject(new TypeError("boom")) };
    const { d } = deps(broken);
    expect(await handleRegistration(d, form(c.session.id))).toEqual({ ok: true });
    expect(await db.select().from(registrations)).toHaveLength(1);
    expect((await rows()).map((p) => p.status)).toEqual(["failed"]);
    expect((await reg()).seatHoldUntil).toBeNull();
  });

  test("the start itself throws (its database fails): the registration stands, the answer is today's, it is logged with logFailure, and the hold written with the registration is released", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const { d } = deps(m.montonio, { db: onStart(db, () => Promise.reject(new Error("db down"))) });
    expect(await handleRegistration(d, form(c.session.id))).toEqual({ ok: true });
    const logged = vi.mocked(console.error).mock.calls.map((args) => args.map(String).join(" "));
    expect(logged).toEqual(["[forms] register: the payment did not start: Error"]); // the class only, never the message
    expect(await db.select().from(registrations)).toHaveLength(1);
    expect(await rows()).toEqual([]);
    expect(m.state.orders).toEqual([]);
    expect((await reg()).seatHoldUntil).toBeNull();
  });

  test.each(["full", "nothing"] as const)("the start says %s: the registration stands with today's answer, the hold written with it is released, no order is made", async (outcome) => {
    const m = stubMontonio();
    const c = await contactCourse(db, { capacity: 1 });
    // what changes between the registration's commit and the start: a confirmed registration takes the seat, or Maria records the prepayment
    const meanwhile = async () => {
      if (outcome === "full") await db.insert(registrations).values({ courseId: c.course.id, courseSessionId: c.session.id, kind: "group", name: "Maria", email: "kinnitatud@example.com", phone: "1", paymentChoice: "full", status: "confirmed", paidCents: 35000 });
      else await db.update(registrations).set({ paidCents: 17500 }).where(eq(registrations.courseSessionId, c.session.id));
    };
    const { d } = deps(m.montonio, { db: onStart(db, meanwhile) });
    expect(await handleRegistration(d, form(c.session.id))).toEqual({ ok: true });
    expect(await rows()).toEqual([]);
    expect(m.state.orders).toEqual([]);
    const [mine] = await db.select().from(registrations).where(eq(registrations.email, "kati@example.com"));
    expect(mine.seatHoldUntil).toBeNull();
  });

  test("two registrations at the same moment for the last seat: one gets the payment page, the other 'full', and nothing is stored for it (the hold is written with the registration, under the session lock)", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db, { capacity: 1 });
    const { d } = deps(m.montonio, { mail: true });
    const results = await Promise.all([
      handleRegistration(d, form(c.session.id, { email: "esimene@example.com" })),
      handleRegistration(d, form(c.session.id, { email: "teine@example.com" })),
    ]);
    expect(results.filter((r) => r.ok && r.paymentUrl !== undefined)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, errors: { session: "full" } }]);
    const stored = await db.select().from(registrations);
    expect(stored).toHaveLength(1);
    expect(stored[0].seatHoldUntil).toEqual(new Date(NOW.getTime() + 30 * MIN));
    expect((await rows()).map((p) => [p.registrationId, p.status])).toEqual([[stored[0].id, "pending"]]);
    expect(m.state.orders).toHaveLength(1);
  });

  test("the registration is stored holding the seat already when its start begins (so one queued behind it counts it); without payments nothing holds", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    let atStart: Date | null | undefined;
    const { d } = deps(m.montonio, { db: onStart(db, async () => void (atStart = (await reg()).seatHoldUntil)) });
    await handleRegistration(d, form(c.session.id));
    expect(atStart).toEqual(new Date(NOW.getTime() + 30 * MIN));
    await db.delete(payments);
    await db.delete(registrations);
    await handleRegistration(deps(null).d, form(c.session.id, { email: "teine@example.com" }));
    expect((await reg()).seatHoldUntil).toBeNull();
  });
});

describe("startRegistrationPayment's checks", () => {
  const start = (montonio: Deps["montonio"], target: Parameters<typeof startRegistrationPayment>[1], now = NOW) => startRegistrationPayment({ db, now, siteUrl: SITE, montonio: montonio ?? null }, target);

  test("off without Montonio; notFound for another client's registration or an unknown token; nothing when enough is paid or it is cancelled", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    expect(await start(null, { registrationId: r.id })).toEqual({ kind: "off" });
    expect(await start(m.montonio, { registrationId: r.id, clientId: 999 })).toEqual({ kind: "notFound" });
    expect(await start(m.montonio, { payToken: "x".repeat(43) })).toEqual({ kind: "notFound" });
    const paid = await registrationOn(db, c, { email: "a@example.com", paidCents: 17500 });
    const cancelled = await registrationOn(db, c, { email: "b@example.com", status: "cancelled" });
    expect(await start(m.montonio, { registrationId: paid.id })).toEqual({ kind: "nothing" });
    expect(await start(m.montonio, { payToken: cancelled.payToken })).toEqual({ kind: "nothing" });
    expect(await rows()).toEqual([]);
  });

  test("a prepayment needs a free seat (the others' holds count, her own does not); the rest needs none and holds nothing", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db, { capacity: 1 });
    const hers = await registrationOn(db, c, { seatHoldUntil: new Date(NOW.getTime() + 5 * MIN) });
    expect(await start(m.montonio, { registrationId: hers.id })).toMatchObject({ kind: "started" });
    const other = await registrationOn(db, c, { email: "teine@example.com" });
    expect(await start(m.montonio, { registrationId: other.id })).toEqual({ kind: "full" });
    // later her hold has ended: the other one may start, and takes the hold
    expect(await start(m.montonio, { registrationId: other.id }, new Date(NOW.getTime() + 31 * MIN))).toMatchObject({ kind: "started" });
    const confirmed = await registrationOn(db, c, { email: "kolmas@example.com", status: "confirmed", paidCents: 17500 });
    expect(await start(m.montonio, { registrationId: confirmed.id })).toMatchObject({ kind: "started" });
    const balance = (await rows()).find((p) => p.registrationId === confirmed.id)!;
    expect([balance.kind, balance.amountCents]).toEqual(["balance", 17500]);
    expect((await db.select().from(registrations).where(eq(registrations.id, confirmed.id)))[0].seatHoldUntil).toBeNull();
  });

  test(`at most ${STARTS_PER_HOUR} new attempts a registration an hour; an hour later again`, async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    // each attempt ends unpaid before the next (Montonio's ABANDONED), so the next start is a new attempt, not a re-send of an open one
    const abandon = () => db.update(payments).set({ status: "failed" }).where(eq(payments.status, "pending"));
    for (let i = 0; i < STARTS_PER_HOUR; i++) {
      expect(await start(m.montonio, { payToken: r.payToken })).toMatchObject({ kind: "started" });
      await abandon();
    }
    expect(await start(m.montonio, { payToken: r.payToken })).toEqual({ kind: "rate" });
    expect(await start(m.montonio, { payToken: r.payToken }, new Date(NOW.getTime() + 61 * MIN))).toMatchObject({ kind: "started" });
    // every new attempt is a new order with a new reference
    expect(new Set(m.state.orders.map((o) => o.merchantReference)).size).toBe(STARTS_PER_HOUR + 1);
  });

  test("a retry while the attempt is open re-sends it — the same row and reference, Montonio's new uuid, the hold refreshed — never a second order to pay; after its window, or for another amount, a new attempt (the double-payment fix)", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const ordered = () => db.select().from(payments).orderBy(payments.id);
    expect(await start(m.montonio, { payToken: r.payToken })).toMatchObject({ kind: "started" });
    const [first] = await ordered();
    // "Proovi uuesti" 20 minutes on, the first order still open: re-sent, not doubled (and not counted as a new attempt)
    const later = new Date(NOW.getTime() + 20 * MIN);
    for (let i = 0; i < STARTS_PER_HOUR + 1; i++) expect(await start(m.montonio, { payToken: r.payToken }, later)).toMatchObject({ kind: "started" });
    const [again, ...none] = await ordered();
    expect(none).toEqual([]);
    expect([again.id, again.reference, again.status, again.updatedAt]).toEqual([first.id, first.reference, "pending", later]);
    expect(again.providerUuid).not.toBe(first.providerUuid); // the stub answers every POST with a new uuid: the row follows the newest
    expect(new Set(m.state.orders.map((o) => o.merchantReference))).toEqual(new Set([first.reference]));
    expect((await reg()).seatHoldUntil).toEqual(new Date(later.getTime() + 30 * MIN));
    // 31 minutes after the last re-send its window is over: a new attempt with a new reference
    expect(await start(m.montonio, { payToken: r.payToken }, new Date(later.getTime() + 31 * MIN))).toMatchObject({ kind: "started" });
    // another amount (Maria recorded a transfer meanwhile): a new attempt too, even with an open one
    await db.update(registrations).set({ paidCents: 5000 }).where(eq(registrations.id, r.id));
    expect(await start(m.montonio, { payToken: r.payToken }, new Date(later.getTime() + 32 * MIN))).toMatchObject({ kind: "started" });
    expect((await ordered()).map((p) => [p.reference, p.amountCents])).toEqual([
      [first.reference, 17500],
      [`MSLAB-M${first.id + 1}`, 17500],
      [`MSLAB-M${first.id + 2}`, 12500],
    ]);
  });

  test("the answer carries the page Montonio gave for this very call, and the return and notification addresses are the site's own", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const first = await start(m.montonio, { registrationId: r.id });
    const second = await start(m.montonio, { registrationId: r.id }, new Date(NOW.getTime() + MIN));
    expect([first, second]).toEqual([
      { kind: "started", paymentUrl: expect.stringMatching(/^https:\/\/sandbox-stargate\.montonio\.com\/0{8}-0000-4000-8000-0{11}1$/) },
      { kind: "started", paymentUrl: expect.stringMatching(/^https:\/\/sandbox-stargate\.montonio\.com\/0{8}-0000-4000-8000-0{11}2$/) },
    ]);
    expect((await rows())[0].providerUuid).toBe("00000000-0000-4000-8000-000000000002"); // the row follows the newest order
    expect(paymentUrls("https://mslab.example/")).toEqual({ returnUrl: "https://mslab.example/api/payments/return", notificationUrl: "https://mslab.example/api/payments/notify" });
  });
});

describe("a failed start and a failed re-send", () => {
  const start = (montonio: Montonio, target: { registrationId: number }, now = NOW) => startRegistrationPayment({ db, now, siteUrl: SITE, montonio }, target);

  test("Montonio says no at the first call: failed, the row is failed and the hold is gone; the next try is a new attempt", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    m.state.down = true;
    expect(await start(m.montonio, { registrationId: r.id })).toEqual({ kind: "failed" });
    expect((await rows()).map((p) => p.status)).toEqual(["failed"]);
    expect((await reg()).seatHoldUntil).toBeNull();
    m.state.down = false;
    expect(await start(m.montonio, { registrationId: r.id }, new Date(NOW.getTime() + MIN))).toMatchObject({ kind: "started" });
    expect((await rows()).map((p) => p.status)).toEqual(["failed", "pending"]);
  });

  test("a re-send that fails fails the row as a new attempt would (a late PAID of it still settles: paid is reachable from failed)", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    expect(await start(m.montonio, { registrationId: r.id })).toMatchObject({ kind: "started" });
    expect((await reg()).seatHoldUntil).not.toBeNull();
    m.state.down = true;
    expect(await start(m.montonio, { registrationId: r.id }, new Date(NOW.getTime() + 5 * MIN))).toEqual({ kind: "failed" });
    expect((await rows()).map((p) => [p.status, p.providerUuid === null])).toEqual([["failed", false]]); // the row keeps the uuid of the order it has
    expect((await reg()).seatHoldUntil).toBeNull();
  });

  test("the row was paid while Montonio was being called: its uuid is not replaced, Montonio is not called again, and the answer is 'nothing to pay'", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    expect(await start(m.montonio, { registrationId: r.id })).toMatchObject({ kind: "started" });
    const [open] = await rows();
    // the payer pays the OLD order while the re-send is on its way: the settlement wins the row before the re-send's uuid can be written
    const racing: Montonio = {
      ...m.montonio,
      createOrder: async (order) => {
        const created = await m.montonio.createOrder(order);
        await db.update(payments).set({ status: "paid", paidAt: NOW }).where(eq(payments.id, open.id));
        return created;
      },
    };
    expect(await start(racing, { registrationId: r.id }, new Date(NOW.getTime() + 5 * MIN))).toEqual({ kind: "nothing" });
    expect(m.state.orders).toHaveLength(2); // one re-send went out; it is not repeated
    const [after] = await rows();
    expect([after.status, after.providerUuid]).toEqual(["paid", open.providerUuid]);
  });
});

describe("no lock is held while Montonio is called", () => {
  test("a new attempt and a re-send both call Montonio with no transaction open", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    // PGlite runs one transaction at a time: a statement from outside waits until an open transaction ends, so a probe that has not
    // answered within 300 ms means the transaction was still open (and, on Postgres, its row locks held) during Montonio's call
    const probes: string[] = [];
    const probing: Montonio = {
      ...m.montonio,
      createOrder: async (order) => {
        probes.push(await Promise.race([db.execute(sql`select 1`).then(() => "free"), new Promise<string>((resolve) => setTimeout(() => resolve("held"), 300))]));
        return m.montonio.createOrder(order);
      },
    };
    const go = (now: Date) => startRegistrationPayment({ db, now, siteUrl: SITE, montonio: probing }, { registrationId: r.id });
    await go(NOW);
    await go(new Date(NOW.getTime() + MIN));
    expect(probes).toEqual(["free", "free"]);
  });
});

describe("one lock order: course_sessions → registrations → payments", () => {
  // Settlement (settle.ts) locks the session, then the registration, then writes the payment row; a start that took the registration first,
  // or wrote the payment row before its locks, would deadlock with it, and one that counted the seats before the session lock could give
  // the last seat to two payers. The SQL each path sends is logged and the order is read from the log (as in payments-settle-guards).
  const at = (queries: string[], pattern: RegExp) => queries.findIndex((q) => pattern.test(q));
  const SESSION_LOCK = /^select 1 from course_sessions where id = \(select course_session_id from registrations where id = \$1\) for update$/;
  const REGISTRATION_LOCK = /^select 1 from registrations where id = \$1 for update$/;
  const PAYMENT_WRITE = /^(insert into|update) "payments"/;
  const SEAT_COUNT = /count\(\*\) filter/;
  const REGISTRATION_WRITE = /^update "registrations"/;
  const lines = (queries: string[]) => JSON.stringify(queries.map((q) => q.slice(0, 70)), null, 1);

  async function logged() {
    const { db: ldb, queries } = await loggedDb();
    const m = stubMontonio();
    const r = await registrationOn(ldb, await contactCourse(ldb));
    const go = (now: Date) => startRegistrationPayment({ db: ldb, now, siteUrl: SITE, montonio: m.montonio }, { payToken: r.payToken });
    return { ldb, queries, go };
  }

  function expectOrder(queries: string[]) {
    const [session, registration, seats, hold, write] = [SESSION_LOCK, REGISTRATION_LOCK, SEAT_COUNT, REGISTRATION_WRITE, PAYMENT_WRITE].map((p) => at(queries, p));
    expect([session, registration, seats, hold, write].every((i) => i >= 0), lines(queries)).toBe(true);
    expect(session, lines(queries)).toBeLessThan(registration);
    expect(registration, lines(queries)).toBeLessThan(write);
    // the seats are counted, and the hold written, only under both locks
    expect(seats, lines(queries)).toBeGreaterThan(registration);
    expect(hold, lines(queries)).toBeGreaterThan(registration);
    // and no read of the registration locks it before the session is locked
    expect(queries.slice(0, session).filter((q) => /for update/i.test(q)), lines(queries)).toEqual([]);
  }

  test("a new attempt: the session is locked, then the registration, and only then the seats are counted and the hold and the payment row written", async () => {
    const { queries, go } = await logged();
    queries.length = 0;
    expect(await go(NOW)).toMatchObject({ kind: "started" });
    expectOrder(queries);
  });

  test("a re-send of the open attempt takes the same locks before it refreshes the hold and the row", async () => {
    const { queries, go } = await logged();
    await go(NOW);
    queries.length = 0;
    expect(await go(new Date(NOW.getTime() + 5 * MIN))).toMatchObject({ kind: "started" });
    expectOrder(queries);
  });

  test("a new registration: the session is locked before its seats are counted and before the registration is inserted", async () => {
    const { db: ldb, queries } = await loggedDb();
    const m = stubMontonio();
    const c = await contactCourse(ldb);
    const { d } = deps(m.montonio, { db: ldb });
    queries.length = 0;
    expect(await handleRegistration(d, form(c.session.id))).toMatchObject({ ok: true });
    const [lock, count, insert] = [/^select 1 from course_sessions where id = \$1 for update$/, SEAT_COUNT, /^insert into "registrations"/].map((p) => at(queries, p));
    expect([lock, count, insert].every((i) => i >= 0), lines(queries)).toBe(true);
    expect(lock, lines(queries)).toBeLessThan(count);
    expect(count, lines(queries)).toBeLessThan(insert);
  });

  // The release of the hold a registration was stored with (a start that left no attempt) used to be one unlocked UPDATE whose "no payment of
  // it is pending" test could run on an older snapshot than the row it then changes: a start of the same registration from /maksa or the
  // dashboard (phase 2b, Task 5), committing meanwhile, had its new hold cleared. It now takes the registration's lock first, in a
  // transaction of its own, and only then runs the conditional UPDATE, which reads the committed state.
  test("the release after a start that left no attempt: the registration's lock first (its own small transaction), then the conditional update, nothing in between", async () => {
    const { db: ldb, queries } = await loggedDb();
    const m = stubMontonio();
    const c = await contactCourse(ldb);
    // Maria records the prepayment between the registration's commit and the start: "nothing", so the hold stored with the registration must be released
    const { d } = deps(m.montonio, { db: onStart(ldb, async () => void (await ldb.update(registrations).set({ paidCents: 17500 }))) });
    queries.length = 0;
    expect(await handleRegistration(d, form(c.session.id))).toEqual({ ok: true });
    const release = queries.findIndex((q) => /^update "registrations" [\s\S]*not exists/.test(q));
    expect(release, lines(queries)).toBeGreaterThan(-1);
    const lock = queries.slice(0, release).map((q, i) => (REGISTRATION_LOCK.test(q) ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
    expect(lock, lines(queries)).toBeGreaterThan(-1);
    expect(release - lock, lines(queries)).toBe(1);
    expect((await ldb.select().from(registrations))[0].seatHoldUntil).toBeNull();
  });

  // The SQL log cannot tell a lock and an update that share a transaction from two statements on the pool, one after the other: a lock that
  // is let go at once protects nothing. So the executors are recorded: the release must be a transaction of its own whose only statements are
  // the registration's lock and then the conditional update, both run on that transaction.
  test("the release's lock and its conditional update run on one transaction of their own (the lock is held until the update is done)", async () => {
    const { db: ldb } = await loggedDb();
    const m = stubMontonio();
    const c = await contactCourse(ldb);
    const recorded = recordTransactions(ldb);
    const { d } = deps(m.montonio, { db: onStart(recorded.db, async () => void (await ldb.update(registrations).set({ paidCents: 17500 }))) });
    expect(await handleRegistration(d, form(c.session.id))).toEqual({ ok: true });
    // 1: the registration's (session lock, count, insert), 2: the payment start (answers "nothing"), 3: the release
    expect(recorded.transactions).toHaveLength(3);
    expect(recorded.transactions[2]).toEqual(["execute", "update"]);
    expect((await ldb.select().from(registrations))[0].seatHoldUntil).toBeNull();
  });
});
