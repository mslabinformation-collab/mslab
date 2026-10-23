import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { failPayment } from "@/db/queries/payments";
import { courses, payments, registrations, settings } from "@/db/schema";
import type { PublicChange } from "@/server/cache-targets";
import type { Env } from "@/server/notify";
import { MontonioError, type Montonio } from "@/server/payments/montonio";
import { paymentUrls, startEcoursePayment, startRegistrationPayment, STARTS_PER_HOUR } from "@/server/payments/start";
import { linkBase, requestOrigin } from "@/server/site";
import { handleRegistration, type Deps } from "@/server/submit";
import { fakeKv } from "../fakes";
import { contactCourse, loggedDb, pendingPayment, registrationOn, SITE, stubMontonio } from "./payments-fixtures";
import { makeTestDb, shownContractVersion } from "./helpers";

// "Registreeru" starts the prepayment (phase 2b, spec 6.1): a 30-minute hold, a pending row MSLAB-M<id>, Montonio's order and { ok, paymentUrl }.
// Without payments, or with Montonio down, the registration stands and the answer is today's. startRegistrationPayment's own checks, the one
// lock order of every payment path (course_sessions → registrations → payments) and the rule that no lock is held across Montonio's call.

const NOW = new Date("2026-10-09T10:00:00Z");
const MIN = 60_000;
let db: Db;
/** The contact contract's version the course page shows (contracts R6: the group form sends it with the box). */
let contractVersion = "";
beforeEach(async () => {
  db = await makeTestDb();
  contractVersion = await shownContractVersion(db);
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
  for (const [k, v] of Object.entries({ course: "kulmumeistri-baaskoolitus", session: String(sessionId), name: "Kati Tamm", email: "kati@example.com", phone: "+372 5555 0101", payment: "half", terms: "on", locale: "ru", contractVersion, ...over })) fd.set(k, v);
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

  test("the reference takes the prefix of this environment's store: MSLAB-L<id> on this machine, in the row and in the order", async () => {
    const m = stubMontonio({ referencePrefix: "MSLAB-L" });
    const c = await contactCourse(db);
    const { d } = deps(m.montonio);
    expect(await handleRegistration(d, form(c.session.id))).toMatchObject({ ok: true });
    const [p] = await rows();
    expect(p.reference).toBe(`MSLAB-L${p.id}`);
    expect(m.state.orders).toEqual([expect.objectContaining({ merchantReference: `MSLAB-L${p.id}`, payment: expect.objectContaining({ methodOptions: { paymentDescription: `MS LAB MSLAB-L${p.id}` } }) })]);
  });

  test("a form posted with Origin: http://localhost:3000 (allow-listed) while SITE_URL is the public site: the return comes back to that origin, Montonio's webhook always goes to SITE_URL", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const { d } = deps(m.montonio);
    // what the form action builds for that request: linkBase(requestOrigin(headers), SITE_URL) (server/actions/public.ts)
    const origin = linkBase(requestOrigin(new Headers({ origin: "http://localhost:3000", host: "mslab.example" })), SITE);
    expect(origin).toBe("http://localhost:3000");
    expect(await handleRegistration({ ...d, siteUrl: origin }, form(c.session.id))).toMatchObject({ ok: true, paymentUrl: expect.any(String) });
    expect(m.state.orders).toEqual([expect.objectContaining({ returnUrl: "http://localhost:3000/api/payments/return", notificationUrl: `${SITE}/api/payments/notify` })]);
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
  const start = (montonio: Deps["montonio"], target: Parameters<typeof startRegistrationPayment>[1], now = NOW) => startRegistrationPayment({ db, now, siteUrl: SITE, notifyBase: SITE, montonio: montonio ?? null }, target);

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
    // each new attempt marks the open one before it „Asendatud“ (B22): one open order at a time
    expect((await ordered()).map((p) => p.status)).toEqual(["replaced", "replaced", "pending"]);
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
    expect(paymentUrls("https://mslab.example/", "https://mslab.example/")).toEqual({ returnUrl: "https://mslab.example/api/payments/return", notificationUrl: "https://mslab.example/api/payments/notify" });
    expect(paymentUrls("http://localhost:3000", "https://mslab.example")).toEqual({ returnUrl: "http://localhost:3000/api/payments/return", notificationUrl: "https://mslab.example/api/payments/notify" });
  });
});

describe("a failed start and a failed re-send", () => {
  const start = (montonio: Montonio, target: { registrationId: number }, now = NOW) => startRegistrationPayment({ db, now, siteUrl: SITE, notifyBase: SITE, montonio }, target);

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

  // A re-send goes out under the reference of an order that may be paid already (its webhook late): Montonio then refuses it, or the call
  // times out. Failing the row there freed its hold, and the next press made a NEW row and reference — a second order the payer could pay too.
  test.each([
    ["refused", (m: ReturnType<typeof stubMontonio>) => m.montonio],
    ["timed out", (m: ReturnType<typeof stubMontonio>): Montonio => ({ ...m.montonio, createOrder: () => Promise.reject(new MontonioError("create", "unreachable")) })],
  ])("a re-send that is %s: 'failed', but the row stays pending with its refreshed hold; the next press re-sends the SAME reference, and no second row is made", async (_, failing) => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    expect(await start(m.montonio, { registrationId: r.id })).toMatchObject({ kind: "started" });
    const [open] = await rows();
    m.state.down = true;
    const resent = new Date(NOW.getTime() + 5 * MIN);
    expect(await start(failing(m), { registrationId: r.id }, resent)).toEqual({ kind: "failed" });
    const [kept, ...none] = await rows();
    expect(none).toEqual([]);
    expect([kept.id, kept.status, kept.providerUuid]).toEqual([open.id, "pending", open.providerUuid]); // the uuid of the order it has
    expect((await reg()).seatHoldUntil).toEqual(new Date(resent.getTime() + 30 * MIN));
    // the next press: the same row and the same reference again, never a new attempt
    m.state.down = false;
    expect(await start(m.montonio, { registrationId: r.id }, new Date(NOW.getTime() + 6 * MIN))).toMatchObject({ kind: "started" });
    expect((await rows()).map((p) => [p.id, p.reference, p.status])).toEqual([[open.id, open.reference, "pending"]]);
    expect(new Set(m.state.orders.map((o) => o.merchantReference))).toEqual(new Set([open.reference]));
  });

  test("an e-course re-send that fails: the row stays pending; the next press re-sends the same reference", async () => {
    const m = stubMontonio();
    const [course] = await db
      .insert(courses)
      .values({ slug: "kulmumeistri-e-koolitus", type: "e_learning", level: "basic", title: { et: "Kulmumeistri e-koolitus" }, summary: { et: "" }, body: { et: "" }, published: true, price: 19000, accessMonths: 6 })
      .returning();
    const buy = (montonio: Montonio, now: Date) =>
      startEcoursePayment({ db, now, siteUrl: SITE, notifyBase: SITE, montonio }, { courseId: course.id, amountCents: 19000, email: "ostja@example.com", name: "Kati Tamm", locale: "et", newsletter: false });
    expect(await buy(m.montonio, NOW)).toMatchObject({ kind: "started" });
    const [open] = await rows();
    m.state.down = true;
    expect(await buy(m.montonio, new Date(NOW.getTime() + 5 * MIN))).toEqual({ kind: "failed" });
    expect((await rows()).map((p) => [p.id, p.status])).toEqual([[open.id, "pending"]]);
    m.state.down = false;
    expect(await buy(m.montonio, new Date(NOW.getTime() + 6 * MIN))).toMatchObject({ kind: "started" });
    expect((await rows()).map((p) => [p.id, p.reference, p.status])).toEqual([[open.id, open.reference, "pending"]]);
  });

  test("the row was marked „Asendatud“ while its re-send was at Montonio (a start of another amount, B22): its uuid is kept and the payer is sent nowhere ('failed'), never to a replaced order", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    expect(await start(m.montonio, { registrationId: r.id })).toMatchObject({ kind: "started" });
    const [open] = await rows();
    const racing: Montonio = {
      ...m.montonio,
      createOrder: async (order) => {
        const created = await m.montonio.createOrder(order);
        await db.update(payments).set({ status: "replaced" }).where(eq(payments.id, open.id));
        return created;
      },
    };
    expect(await start(racing, { registrationId: r.id }, new Date(NOW.getTime() + 5 * MIN))).toEqual({ kind: "failed" });
    const [after] = await rows();
    expect([after.status, after.providerUuid]).toEqual(["replaced", open.providerUuid]);
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
    const go = (now: Date) => startRegistrationPayment({ db, now, siteUrl: SITE, notifyBase: SITE, montonio: probing }, { registrationId: r.id });
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
    const go = (now: Date) => startRegistrationPayment({ db: ldb, now, siteUrl: SITE, notifyBase: SITE, montonio: m.montonio }, { payToken: r.payToken });
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
    // (releaseHold: the hold set to what the other pending payments still hold, or ended)
    const release = queries.findIndex((q) => /^update "registrations" set "seat_hold_until" = \(select max\([\s\S]* from payments p where p\.registration_id = /.test(q));
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

describe("a start with its method: the bank, or Järelmaks (Inbank) (instalments, D5, §4)", () => {
  type Method = "paymentInitiation" | "hirePurchase";
  const start = (montonio: Montonio, target: Parameters<typeof startRegistrationPayment>[1], method?: Method, now = NOW) =>
    startRegistrationPayment({ db, now, siteUrl: SITE, notifyBase: SITE, montonio }, target, method ? { method } : undefined);
  const financingOn = (enabled = true) => db.insert(settings).values({ key: "financing", value: { enabled } }).onConflictDoUpdate({ target: settings.key, set: { value: { enabled } } });
  const ordered = () => db.select().from(payments).orderBy(payments.id);
  const claimsOf = (m: ReturnType<typeof stubMontonio>, reference: string) => m.state.orders.filter((o) => o.merchantReference === reference);
  const methodOf = (o: Record<string, unknown>) => (o.payment as { method: string }).method;

  test("a financing registration starts a hirePurchase order for the full price, 60-min hold, billing details", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await financingOn();
    // the registration is stored already holding its seat for the järelmaks' 60 minutes (so one queued behind it counts it)
    let atStart: Date | null | undefined;
    const { d } = deps(m.montonio, { db: onStart(db, async () => void (atStart = (await reg()).seatHoldUntil)) });
    const result = await handleRegistration(d, form(c.session.id, { payment: "financing", name: "Kati Maria Tamm", phone: "+372 5555-0101" }));
    expect(atStart).toEqual(new Date(NOW.getTime() + 60 * MIN));
    const [p, ...none] = await rows();
    expect(none).toEqual([]);
    expect(result).toEqual({ ok: true, paymentUrl: `https://sandbox-stargate.montonio.com/${p.providerUuid}` });
    const r = await reg();
    expect([r.paymentChoice, r.status, r.seatHoldUntil]).toEqual(["financing", "awaiting_prepayment", new Date(NOW.getTime() + 60 * MIN)]);
    // the whole price (D3), recorded with its method
    expect(p).toMatchObject({ kind: "prepayment", status: "pending", amountCents: 35000, method: "hirePurchase", registrationId: r.id });
    expect(m.state.orders).toHaveLength(1);
    expect(m.state.orders[0]).toMatchObject({ merchantReference: p.reference, grandTotal: 350, expiresIn: 60, payment: { method: "hirePurchase", amount: 350, currency: "EUR" } });
    expect(m.state.orders[0].billingAddress).toEqual({ firstName: "Kati Maria", lastName: "Tamm", email: "kati@example.com", phoneNumber: "55550101", phoneCountry: "372" });
  });

  test("a financing registration may still be paid in full by bank (the default): the bank's order and its 30-minute hold, no billing details", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await financingOn();
    const r = await registrationOn(db, c, { paymentChoice: "financing" });
    expect(await start(m.montonio, { payToken: r.payToken })).toMatchObject({ kind: "started" });
    const [p] = await rows();
    expect(p).toMatchObject({ amountCents: 35000, method: "paymentInitiation" });
    expect(methodOf(m.state.orders[0])).toBe("paymentInitiation");
    expect(m.state.orders[0]).not.toHaveProperty("billingAddress");
    expect(m.state.orders[0]).not.toHaveProperty("expiresIn");
    expect((await reg()).seatHoldUntil).toEqual(new Date(NOW.getTime() + 30 * MIN));
  });

  test("hirePurchase is refused with kind 'financing' when off, out of range, partly paid, or the choice was 100%/50% — and says which sentence applies: 'range' for a price outside 100–5000 €, else 'off'", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const r = await registrationOn(db, c, { paymentChoice: "financing" });
    const refused = async (why: string, reason: "off" | "range") => {
      expect(await start(m.montonio, { registrationId: r.id }, "hirePurchase"), why).toEqual({ kind: "financing", reason });
      expect(await rows(), why).toEqual([]);
      expect(m.state.orders, why).toEqual([]);
    };
    // Seaded's toggle: never set, then off — the price (350 €) is within the range, so it is the switched-off sentence
    await refused("no setting", "off");
    await financingOn(false);
    await refused("switched off", "off");
    // the price out of 100–5000 € and the toggle off: the price is the permanent fact, so the range sentence
    for (const price of [9999, 500001]) {
      await db.update(courses).set({ priceGroup: price }).where(eq(courses.id, c.course.id));
      await refused(`price ${price}, switched off`, "range");
    }
    await db.update(courses).set({ priceGroup: 35000 }).where(eq(courses.id, c.course.id));
    await financingOn();
    // the price out of 100–5000 € (Maria edited the course after the booking)
    for (const price of [9999, 500001]) {
      await db.update(courses).set({ priceGroup: price }).where(eq(courses.id, c.course.id));
      await refused(`price ${price}`, "range");
    }
    // partly paid (Maria recorded a transfer): only the bank, for what is left — the price is within the range, so the same "not available now" sentence
    await db.update(courses).set({ priceGroup: 35000 }).where(eq(courses.id, c.course.id));
    await db.update(registrations).set({ paidCents: 5000 }).where(eq(registrations.id, r.id));
    await refused("partly paid", "off");
    expect(await start(m.montonio, { registrationId: r.id })).toMatchObject({ kind: "started" });
    expect((await rows()).map((p) => [p.amountCents, p.method])).toEqual([[30000, "paymentInitiation"]]);
    // booked with 100% or 50%: never järelmaks later (the choice is made at booking) — the price is within the range: "not available now"
    for (const paymentChoice of ["full", "half"] as const) {
      const other = await registrationOn(db, c, { email: `${paymentChoice}@example.com`, paymentChoice });
      expect(await start(m.montonio, { registrationId: other.id }, "hirePurchase"), paymentChoice).toEqual({ kind: "financing", reason: "off" });
    }
    // ... and the same for a price outside the range, whatever the choice was: the range
    await db.update(courses).set({ priceGroup: 600_000 }).where(eq(courses.id, c.course.id));
    for (const paymentChoice of ["full", "half"] as const) {
      const other = await registrationOn(db, c, { email: `${paymentChoice}-high@example.com`, paymentChoice });
      expect(await start(m.montonio, { registrationId: other.id }, "hirePurchase"), `${paymentChoice} high`).toEqual({ kind: "financing", reason: "range" });
    }
    await db.update(courses).set({ priceGroup: 35000 }).where(eq(courses.id, c.course.id));
    // the edges of the range are in it
    for (const price of [10000, 500000]) {
      await db.update(courses).set({ priceGroup: price }).where(eq(courses.id, c.course.id));
      const edge = await registrationOn(db, c, { email: `edge-${price}@example.com`, paymentChoice: "financing" });
      expect(await start(m.montonio, { registrationId: edge.id }, "hirePurchase"), `price ${price}`).toMatchObject({ kind: "started" });
    }
    expect(m.state.orders.filter((o) => methodOf(o) === "hirePurchase").map((o) => o.grandTotal)).toEqual([100, 5000]);
  });

  test("the toggle is read inside the start: switched off between the booking and the start, the registration stands awaiting payment, its hold ends, the form is told it is switched off", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await financingOn();
    const { d } = deps(m.montonio, { db: onStart(db, async () => void (await financingOn(false))) });
    expect(await handleRegistration(d, form(c.session.id, { payment: "financing" }))).toEqual({ ok: true, financing: "off" });
    const r = await reg();
    expect([r.paymentChoice, r.status, r.seatHoldUntil]).toEqual(["financing", "awaiting_prepayment", null]);
    expect(await rows()).toEqual([]);
    expect(m.state.orders).toEqual([]);
  });

  test("the price is read inside the start: out of 100–5000 € between the booking and the start (the toggle still on) the form is told the range; with the toggle off as well, the range too", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await financingOn();
    const outOfRange = (extra?: () => Promise<unknown>) => async () => {
      await db.update(courses).set({ priceGroup: 600_000 }).where(eq(courses.id, c.course.id));
      await extra?.();
    };
    const first = deps(m.montonio, { db: onStart(db, outOfRange()) });
    expect(await handleRegistration(first.d, form(c.session.id, { payment: "financing" }))).toEqual({ ok: true, financing: "refused" });
    expect(await rows()).toEqual([]);
    expect(m.state.orders).toEqual([]);
    // the price out of range and the toggle off in the same moment: the price is the permanent fact
    await db.update(courses).set({ priceGroup: 35000 }).where(eq(courses.id, c.course.id));
    const second = deps(m.montonio, { db: onStart(db, outOfRange(() => financingOn(false))) });
    expect(await handleRegistration(second.d, form(c.session.id, { payment: "financing", email: "teine@example.com" }))).toEqual({ ok: true, financing: "refused" });
    expect(await rows()).toEqual([]);
  });

  // B22 (admin UX pass, piece 2) replaces the instalments rule „a bank payment never replaces a loan application“: a press of the other method
  // is still a new attempt (never a re-send of the other method's order), and it now marks the open one „Asendatud“ — one open order per
  // registration. The replaced row stays payable at Montonio (a loan signed later is held as „Topeltmakse — tagasta“: payments-settle).
  test("a bank press while a hirePurchase attempt is open starts a new attempt (new row and reference) and marks the loan's row „Asendatud“, never re-sends it", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await financingOn();
    const r = await registrationOn(db, c, { paymentChoice: "financing" });
    expect(await start(m.montonio, { payToken: r.payToken }, "hirePurchase")).toMatchObject({ kind: "started" });
    const [loan] = await ordered();
    // Inbank declined (the order stays PENDING at Montonio), she pays by bank 5 minutes on: a new attempt, and the loan's row is replaced —
    // its status only: its last sending (updated_at) stays, so its seat window is still its own
    const bankAt = new Date(NOW.getTime() + 5 * MIN);
    expect(await start(m.montonio, { payToken: r.payToken }, undefined, bankAt)).toMatchObject({ kind: "started" });
    const [loanAfter, bank, ...none] = await ordered();
    expect(none).toEqual([]);
    expect(loanAfter).toEqual({ ...loan, status: "replaced" });
    expect([bank.reference, bank.method, bank.amountCents, bank.status]).toEqual([`MSLAB-M${loan.id + 1}`, "paymentInitiation", 35000, "pending"]);
    expect(claimsOf(m, loan.reference)).toHaveLength(1);
    expect(claimsOf(m, bank.reference).map(methodOf)).toEqual(["paymentInitiation"]);
    // the loan's longer hold is kept: the bank's 30 minutes would end it before the loan's 60 (the replaced application may still be signed)
    expect((await reg()).seatHoldUntil).toEqual(new Date(NOW.getTime() + 60 * MIN));
    // each method pressed again inside its window re-sends its own attempt (one Inbank application per registration): the replaced loan is
    // the open order again and the bank's row is replaced; then the bank's, and the loan's is replaced. Never a third row
    expect(await start(m.montonio, { payToken: r.payToken }, "hirePurchase", new Date(NOW.getTime() + 10 * MIN))).toMatchObject({ kind: "started" });
    expect((await ordered()).map((p) => [p.id, p.status])).toEqual([
      [loan.id, "pending"],
      [bank.id, "replaced"],
    ]);
    expect(await start(m.montonio, { payToken: r.payToken }, "paymentInitiation", new Date(NOW.getTime() + 12 * MIN))).toMatchObject({ kind: "started" });
    expect((await ordered()).map((p) => [p.id, p.status])).toEqual([
      [loan.id, "replaced"],
      [bank.id, "pending"],
    ]);
    expect(claimsOf(m, loan.reference).map(methodOf)).toEqual(["hirePurchase", "hirePurchase"]);
    expect(claimsOf(m, bank.reference).map(methodOf)).toEqual(["paymentInitiation", "paymentInitiation"]);
    // the bank's press at 12 minutes would hold until 42, the loan's at 10 holds until 70: the longer one stays
    expect((await reg()).seatHoldUntil).toEqual(new Date(NOW.getTime() + 70 * MIN));
  });

  test("loan, bank, loan again inside the loan's 60 minutes: the same application, back to „Pooleli“ and re-sent with its reference; the bank's row replaced; no third row", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await financingOn();
    const r = await registrationOn(db, c, { email: "kati@example.test", paymentChoice: "financing" });
    expect(await start(m.montonio, { registrationId: r.id }, "hirePurchase")).toMatchObject({ kind: "started" });
    expect(await start(m.montonio, { registrationId: r.id }, undefined, new Date(NOW.getTime() + 5 * MIN))).toMatchObject({ kind: "started" });
    const [loan, bank] = await ordered();
    expect([loan.status, bank.status]).toEqual(["replaced", "pending"]);
    // 55 minutes after the loan's sending: still inside its window
    const again = new Date(NOW.getTime() + 55 * MIN);
    expect(await start(m.montonio, { registrationId: r.id }, "hirePurchase", again)).toEqual({ kind: "started", paymentUrl: expect.any(String) });
    const [loanAfter, bankAfter, ...none] = await ordered();
    expect(none).toEqual([]);
    expect([loanAfter.id, loanAfter.reference, loanAfter.status, loanAfter.updatedAt]).toEqual([loan.id, loan.reference, "pending", again]);
    expect(loanAfter.providerUuid).not.toBe(loan.providerUuid); // Montonio's answer to the re-send: the row follows its newest order
    expect([bankAfter.id, bankAfter.status]).toEqual([bank.id, "replaced"]);
    // the loan's order again (its method, its billing details), under the same merchantReference
    expect(claimsOf(m, loan.reference).map(methodOf)).toEqual(["hirePurchase", "hirePurchase"]);
    expect(m.state.orders).toHaveLength(3);
    // its window starts again now, as any re-send's
    expect((await reg()).seatHoldUntil).toEqual(new Date(again.getTime() + 60 * MIN));
  });

  test("…after the loan's window has ended, the loan pressed again is a new application (a new row), which replaces the bank's", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await financingOn();
    const r = await registrationOn(db, c, { email: "kati@example.test", paymentChoice: "financing" });
    expect(await start(m.montonio, { registrationId: r.id }, "hirePurchase")).toMatchObject({ kind: "started" });
    expect(await start(m.montonio, { registrationId: r.id }, undefined, new Date(NOW.getTime() + 5 * MIN))).toMatchObject({ kind: "started" });
    expect(await start(m.montonio, { registrationId: r.id }, "hirePurchase", new Date(NOW.getTime() + 61 * MIN))).toMatchObject({ kind: "started" });
    const rows = await ordered();
    expect(rows.map((p) => [p.method, p.status])).toEqual([
      ["hirePurchase", "replaced"],
      ["paymentInitiation", "replaced"],
      ["hirePurchase", "pending"],
    ]);
    expect(claimsOf(m, rows[0].reference)).toHaveLength(1);
    expect(rows[2].reference).toBe(`MSLAB-M${rows[0].id + 2}`);
  });

  test("the reverse: a järelmaks press while a bank attempt is open is a new attempt too, and the bank's row is „Asendatud“", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await financingOn();
    const r = await registrationOn(db, c, { paymentChoice: "financing" });
    expect(await start(m.montonio, { registrationId: r.id })).toMatchObject({ kind: "started" });
    const [bank] = await ordered();
    expect(await start(m.montonio, { registrationId: r.id }, "hirePurchase", new Date(NOW.getTime() + 5 * MIN))).toMatchObject({ kind: "started" });
    const [bankAfter, loan, ...none] = await ordered();
    expect(none).toEqual([]);
    expect(bankAfter).toEqual({ ...bank, status: "replaced" });
    expect([loan.method, loan.reference, loan.status]).toEqual(["hirePurchase", `MSLAB-M${bank.id + 1}`, "pending"]);
    expect((await reg()).seatHoldUntil).toEqual(new Date(NOW.getTime() + 65 * MIN));
  });

  test("a replaced application keeps its seat window: the bank attempt that replaced it ends unpaid, and the hold falls back to the loan's own 60 minutes", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await financingOn();
    const r = await registrationOn(db, c, { email: "kati@example.test", paymentChoice: "financing" });
    expect(await start(m.montonio, { registrationId: r.id }, "hirePurchase")).toMatchObject({ kind: "started" });
    // the bank 50 minutes on: its 30 minutes reach past the loan's 60, so the hold is the bank's (80); the loan's row is replaced
    expect(await start(m.montonio, { registrationId: r.id }, undefined, new Date(NOW.getTime() + 50 * MIN))).toMatchObject({ kind: "started" });
    expect((await reg()).seatHoldUntil).toEqual(new Date(NOW.getTime() + 80 * MIN));
    const [loan, bank] = await ordered();
    expect([loan.status, bank.status]).toEqual(["replaced", "pending"]);
    // the bank attempt ends unpaid (Montonio's ABANDONED: settle.ts failed → failPayment): what is still open is the replaced loan, whose
    // application may still be signed — the hold is its window (60), not none, and not the bank's 80
    await failPayment(db, bank.id, new Date(NOW.getTime() + 51 * MIN));
    expect((await reg()).seatHoldUntil).toEqual(new Date(NOW.getTime() + 60 * MIN));
    expect((await ordered()).map((p) => p.status)).toEqual(["replaced", "failed"]);
  });

  test("a re-send of the same method within its window reuses the row; the window is 60 min for hirePurchase, 30 for a bank attempt", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await financingOn();
    const r = await registrationOn(db, c, { paymentChoice: "financing" });
    expect(await start(m.montonio, { registrationId: r.id }, "hirePurchase")).toMatchObject({ kind: "started" });
    const [loan] = await ordered();
    // 45 minutes on (past the bank's 30, inside the loan's 60): the same row and reference, its window and the hold from now
    const resent = new Date(NOW.getTime() + 45 * MIN);
    expect(await start(m.montonio, { registrationId: r.id }, "hirePurchase", resent)).toMatchObject({ kind: "started" });
    const [again, ...none] = await ordered();
    expect(none).toEqual([]);
    expect([again.id, again.reference, again.updatedAt]).toEqual([loan.id, loan.reference, resent]);
    expect((await reg()).seatHoldUntil).toEqual(new Date(resent.getTime() + 60 * MIN));
    // the re-send is the loan's order again: its method, expiresIn and the billing details
    const loanOrder = expect.objectContaining({ expiresIn: 60, payment: expect.objectContaining({ method: "hirePurchase" }), billingAddress: expect.objectContaining({ lastName: "Tamm" }) });
    expect(claimsOf(m, loan.reference)).toEqual([loanOrder, loanOrder]);
    // 61 minutes after the re-send its window is over: a new attempt
    expect(await start(m.montonio, { registrationId: r.id }, "hirePurchase", new Date(resent.getTime() + 61 * MIN))).toMatchObject({ kind: "started" });
    expect((await ordered()).map((p) => p.reference)).toEqual([loan.reference, `MSLAB-M${loan.id + 1}`]);
    // a bank attempt's window stays 30 minutes: 29 minutes on the same row, 31 after that a new one
    const bankAt = new Date(NOW.getTime() + 3 * 60 * MIN);
    await db.update(payments).set({ status: "failed" }).where(eq(payments.status, "pending"));
    expect(await start(m.montonio, { registrationId: r.id }, "paymentInitiation", bankAt)).toMatchObject({ kind: "started" });
    expect(await start(m.montonio, { registrationId: r.id }, "paymentInitiation", new Date(bankAt.getTime() + 29 * MIN))).toMatchObject({ kind: "started" });
    expect(await ordered()).toHaveLength(3);
    expect(await start(m.montonio, { registrationId: r.id }, "paymentInitiation", new Date(bankAt.getTime() + 60 * MIN))).toMatchObject({ kind: "started" });
    expect((await ordered()).map((p) => p.method)).toEqual(["hirePurchase", "hirePurchase", "paymentInitiation", "paymentInitiation"]);
    // each new attempt replaced the one open before it (B22); the second loan was failed above, so the first bank attempt replaced nothing
    expect((await ordered()).map((p) => p.status)).toEqual(["replaced", "failed", "replaced", "pending"]);
  });

  test("a loan whose first send fails while a bank attempt is open: the hold falls back to the bank attempt's own window, never the loan's 60 minutes of an order that never was", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await financingOn();
    const r = await registrationOn(db, c, { email: "kati@example.test", paymentChoice: "financing" });
    expect(await start(m.montonio, { registrationId: r.id })).toMatchObject({ kind: "started" });
    expect((await reg()).seatHoldUntil).toEqual(new Date(NOW.getTime() + 30 * MIN));
    // the loan's press 5 minutes on would hold until 65; Montonio refuses its order: the bank's attempt (sent at 0) holds until 30. The loan's
    // row replaced the bank's when it was inserted (B22): the bank's order is still open at Montonio, and its window (from its own sending) counts
    m.state.down = true;
    expect(await start(m.montonio, { registrationId: r.id }, "hirePurchase", new Date(NOW.getTime() + 5 * MIN))).toEqual({ kind: "failed" });
    expect((await ordered()).map((p) => [p.method, p.status])).toEqual([["paymentInitiation", "replaced"], ["hirePurchase", "failed"]]);
    expect((await reg()).seatHoldUntil).toEqual(new Date(NOW.getTime() + 30 * MIN));
  });

  test("…and when the open bank attempt's window is over by then, the hold ends with the failed loan; with no other attempt pending it ends too", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await financingOn();
    const r = await registrationOn(db, c, { email: "kati@example.test", paymentChoice: "financing" });
    expect(await start(m.montonio, { registrationId: r.id })).toMatchObject({ kind: "started" });
    // 40 minutes on (the bank's window ended at 30, its row still pending until the daily check), the loan's order is refused
    m.state.down = true;
    expect(await start(m.montonio, { registrationId: r.id }, "hirePurchase", new Date(NOW.getTime() + 40 * MIN))).toEqual({ kind: "failed" });
    expect((await reg()).seatHoldUntil).toBeNull();
    // a loan alone, refused: no hold is left
    const alone = await registrationOn(db, c, { email: "yksi@example.test", paymentChoice: "financing" });
    expect(await start(m.montonio, { registrationId: alone.id }, "hirePurchase")).toEqual({ kind: "failed" });
    expect((await db.select().from(registrations).where(eq(registrations.id, alone.id)))[0].seatHoldUntil).toBeNull();
  });

  test("an open loan's attempt keeps its 60 minutes when a later bank attempt fails: the hold is the longest open window", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await financingOn();
    const r = await registrationOn(db, c, { email: "kati@example.test", paymentChoice: "financing" });
    expect(await start(m.montonio, { registrationId: r.id }, "hirePurchase")).toMatchObject({ kind: "started" });
    m.state.down = true;
    expect(await start(m.montonio, { registrationId: r.id }, undefined, new Date(NOW.getTime() + 5 * MIN))).toEqual({ kind: "failed" });
    expect((await reg()).seatHoldUntil).toEqual(new Date(NOW.getTime() + 60 * MIN));
  });

  test("a pending row from before the methods (method '') is a bank attempt: a bank press re-sends it, a järelmaks press does not", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    await financingOn();
    const r = await registrationOn(db, c, { paymentChoice: "financing" });
    expect(await start(m.montonio, { registrationId: r.id })).toMatchObject({ kind: "started" });
    await db.update(payments).set({ method: "" });
    const [old] = await ordered();
    expect(await start(m.montonio, { registrationId: r.id }, undefined, new Date(NOW.getTime() + 5 * MIN))).toMatchObject({ kind: "started" });
    expect((await ordered()).map((p) => p.id)).toEqual([old.id]);
    expect(await start(m.montonio, { registrationId: r.id }, "hirePurchase", new Date(NOW.getTime() + 6 * MIN))).toMatchObject({ kind: "started" });
    expect((await ordered()).map((p) => [p.id === old.id, p.method, p.status])).toEqual([[true, "", "replaced"], [false, "hirePurchase", "pending"]]);
  });
});

describe("one open order per registration (B22): a new attempt marks the older open ones „Asendatud“", () => {
  const start = (montonio: Montonio, target: Parameters<typeof startRegistrationPayment>[1], now = NOW) => startRegistrationPayment({ db, now, siteUrl: SITE, notifyBase: SITE, montonio }, target);
  const ordered = () => db.select().from(payments).orderBy(payments.id);

  test("a new start for another amount inserts its row and marks the open older one „replaced“ (its status only); another registration's open row is untouched", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const other = await registrationOn(db, c, { email: "teine@example.test" });
    const r = await registrationOn(db, c, { email: "kati@example.test" });
    expect(await start(m.montonio, { registrationId: other.id })).toMatchObject({ kind: "started" });
    expect(await start(m.montonio, { registrationId: r.id })).toMatchObject({ kind: "started" });
    const [, open] = await ordered();
    // Maria records a transfer of 50 € meanwhile: what is due is another amount, so the next start is a new attempt, not a re-send
    await db.update(registrations).set({ paidCents: 5000 }).where(eq(registrations.id, r.id));
    expect(await start(m.montonio, { registrationId: r.id }, new Date(NOW.getTime() + 5 * MIN))).toMatchObject({ kind: "started" });
    const [theirs, replaced, latest, ...none] = await ordered();
    expect(none).toEqual([]);
    expect([theirs.registrationId, theirs.status]).toEqual([other.id, "pending"]);
    // the replaced row keeps everything but its status: its order, its reference and its last sending (its seat window)
    expect(replaced).toEqual({ ...open, status: "replaced" });
    expect([latest.registrationId, latest.amountCents, latest.status]).toEqual([r.id, 12500, "pending"]);
  });

  test("whatever its kind: a confirmed registration's rest replaces the prepayment attempt left open before Maria recorded the transfer", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const prepayment = await pendingPayment(db, r);
    await db.update(registrations).set({ status: "confirmed", paidCents: 17500 }).where(eq(registrations.id, r.id));
    expect(await start(m.montonio, { registrationId: r.id })).toMatchObject({ kind: "started" });
    expect((await ordered()).map((p) => [p.id === prepayment.id, p.kind, p.status])).toEqual([
      [true, "prepayment", "replaced"],
      [false, "balance", "pending"],
    ]);
  });

  test("a re-send of the open attempt inside its window is no new row and replaces nothing (an older open row from before B22 stays open)", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const older = await pendingPayment(db, r, {}, new Date(NOW.getTime() - 50 * MIN));
    const open = await pendingPayment(db, r, {}, new Date(NOW.getTime() - 5 * MIN));
    expect(await start(m.montonio, { registrationId: r.id })).toMatchObject({ kind: "started" });
    expect((await ordered()).map((p) => [p.id, p.status])).toEqual([
      [older.id, "pending"],
      [open.id, "pending"],
    ]);
    expect(new Set(m.state.orders.map((o) => o.merchantReference))).toEqual(new Set([open.reference]));
  });

  test("a replaced order of the same amount, inside its window, is the open order again when its way is pressed: restored, re-sent, and the one in its place replaced", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    expect(await start(m.montonio, { registrationId: r.id })).toMatchObject({ kind: "started" });
    // Maria records 50 € (another amount: a new attempt), then takes the entry back (the prepayment's amount again)
    await db.update(registrations).set({ paidCents: 5000 }).where(eq(registrations.id, r.id));
    expect(await start(m.montonio, { registrationId: r.id }, new Date(NOW.getTime() + 5 * MIN))).toMatchObject({ kind: "started" });
    await db.update(registrations).set({ paidCents: 0 }).where(eq(registrations.id, r.id));
    expect(await start(m.montonio, { registrationId: r.id }, new Date(NOW.getTime() + 10 * MIN))).toMatchObject({ kind: "started" });
    const [first, second, ...none] = await ordered();
    expect(none).toEqual([]);
    expect([first.amountCents, first.status, second.amountCents, second.status]).toEqual([17500, "pending", 12500, "replaced"]);
    expect(m.state.orders.map((o) => o.merchantReference)).toEqual([first.reference, second.reference, first.reference]);
  });

  test("a replaced order that was settled since — paid (counted), or held as „Topeltmakse — tagasta“ — is never revived: the press is a new attempt", async () => {
    const c = await contactCourse(db);
    const m = stubMontonio();
    for (const settled of [{ status: "paid" as const, paidAt: NOW }, { status: "held" as const, paidAt: null }, { status: "replaced" as const, paidAt: NOW }]) {
      m.state.orders.length = 0;
      const r = await registrationOn(db, c, { email: `${settled.status}-${settled.paidAt ? "paid" : "open"}@example.test` });
      const old = await pendingPayment(db, r, { method: "paymentInitiation" }, new Date(NOW.getTime() - 5 * MIN));
      // (the row as the settlement left it; Laekunud summa is left as it was, so the same prepayment is due again)
      await db.update(payments).set(settled).where(eq(payments.id, old.id));
      expect(await start(m.montonio, { registrationId: r.id }), JSON.stringify(settled)).toMatchObject({ kind: "started" });
      const mine = (await ordered()).filter((p) => p.registrationId === r.id);
      expect(mine.map((p) => [p.id === old.id, p.status]), JSON.stringify(settled)).toEqual([
        [true, settled.status],
        [false, "pending"],
      ]);
      expect(m.state.orders.map((o) => o.merchantReference), JSON.stringify(settled)).toEqual([mine[1].reference]);
    }
  });

  test("an e-course purchase keeps today's rules: a new attempt of the same course and address replaces nothing (B22 is a registration's)", async () => {
    const m = stubMontonio();
    const [course] = await db
      .insert(courses)
      .values({ slug: "kulmumeistri-e-koolitus", type: "e_learning", level: "basic", title: { et: "Kulmumeistri e-koolitus" }, summary: { et: "" }, body: { et: "" }, published: true, price: 19000, accessMonths: 6 })
      .returning();
    const buy = (now: Date) => startEcoursePayment({ db, now, siteUrl: SITE, notifyBase: SITE, montonio: m.montonio }, { courseId: course.id, amountCents: 19000, email: "ostja@example.test", name: "Kati Tamm", locale: "et", newsletter: false });
    expect(await buy(NOW)).toMatchObject({ kind: "started" });
    // 31 minutes on its window is over: a new attempt, and the first stays as it is
    expect(await buy(new Date(NOW.getTime() + 31 * MIN))).toMatchObject({ kind: "started" });
    expect((await ordered()).map((p) => p.status)).toEqual(["pending", "pending"]);
  });
});
