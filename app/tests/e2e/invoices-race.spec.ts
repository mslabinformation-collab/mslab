import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Db } from "../../src/db/client";
import { attachOrder, insertPayment } from "../../src/db/queries/payments";
import type { Payment } from "../../src/db/schema";
import { LOCAL_REFERENCE_PREFIX } from "../../src/domain/payments";
import { createInvoice, markInvoicePaid, uninvoicedPayments } from "../../src/server/invoices";
import type { Env } from "../../src/server/notify";
import { settlePayment, type Facts, type SettleDeps } from "../../src/server/payments/settle";
import { insertAdminFixtures, onLocalDb, removeAdminFixtures, storedAdminRegistration, type AdminFixtures } from "./fixtures";
import { holdInvoiceSettings, INVOICE_NUMBER, today } from "./invoices";
import { inFlight, racePool } from "./race";
import { expect, submitsForms, test } from "./test";

// Invoices on real Postgres (invoices Task 7; owed by Tasks 3 and 4): what the unit tests' single-connection PGlite cannot show, because it
// runs one transaction at a time. The app's own markInvoicePaid and settlePayment (the one door of every paid Montonio payment), in this
// process, on a pool of the local Postgres:
// - two „Märgi tasutuks" on one invoice at the same moment: exactly one wins, the other finds the invoice paid, and „Laekunud summa" gets the
//   amount once (spec §6.4, D6);
// - a „Märgi tasutuks" and a Montonio settlement of a payment started for that same invoice at the same moment (rulings R7, R13, R14), in both
//   orders. Whichever comes second finds the first's committed state: settle first, the invoice is Montonio's and the mark is refused; the mark
//   first, the invoice is Maria's, and the payment's money gets an invoice of its own. Either way the invoice is paid once, „Laekunud summa"
//   counts every real payment, and nothing is left unpaid and charged;
// - two invoices issued at the same moment under the same prefix, on two registrations of two sessions (no row lock between them): the
//   number series' transaction lock (pg_advisory_xact_lock(hashtext('invoice-number'))) puts one after the other, so under READ COMMITTED the
//   second reads the first's committed highest seq and setting, and the two take consecutive numbers, never one twice (the final review's m14).
// "At the same moment" is proven, not hoped for (inFlight): another connection holds the lock the calls meet first — the registration's
// session row, the first lock of every payment path (db/queries/seats.ts lockForPayment: the session, then the registration, then the payment or
// the invoice), or the number series' lock — while the calls start, and lets it go only once this pool shows every call waiting for it. They
// stand in the lock's queue in the order started (a lock queue is first come, first served), so which of the two goes first is fixed by the
// test, and the outcome that follows is the locks', not the timing's. The settlement's mails and Maria's notices (the work after the response) are not run here: no mail goes out. Nothing here depends
// on the screen: the desktop project runs these once.

test.skip(({ isMobile }) => isMobile, "nothing here depends on the screen: the desktop project runs these once");

/** The name this process's pool connects under, so the test finds its own backends in pg_stat_activity and no one else's. */
const APPLICATION = `mslab-e2e-invoices-race-${process.pid}`;
let pool: postgres.Sql | null = null;
let db: Db;
let fx: AdminFixtures | null = null;
let giveBack: (() => Promise<void>) | null = null;
const loggedInfo = console.info;

test.beforeAll(() => {
  ({ pool, db } = racePool(APPLICATION));
  console.info = () => {}; // (the app's own log lines of the invoices and the payments, ids only: not the test's output)
});
test.afterAll(async () => {
  console.info = loggedInfo;
  await pool?.end();
});
test.beforeEach(() => {
  submitsForms();
  test.setTimeout(60_000);
});
test.afterEach(async () => {
  try {
    if (fx) expect(await removeAdminFixtures(fx.tag), "the fixture rows left").toBe(0); // (its invoices and payments go with them)
  } finally {
    fx = null;
    await giveBack?.();
    giveBack = null;
  }
});

/** What another connection holds while two calls start: the session row of a registration (the first statement of lockForPayment). */
const sessionRow = (sessionId: number) => (tx: postgres.TransactionSql) => tx`select 1 from course_sessions where id = ${sessionId} for update`;
/** …or the number series' transaction lock, which every issue takes after its row locks (server/invoices.ts lockNumbers). */
const numberSeries = (tx: postgres.TransactionSql) => tx`select pg_advisory_xact_lock(hashtext('invoice-number'))`;

/** The registration of a fresh fixture course (a half-choice group registration at 350 €) with the shared settings in place. */
async function fixtures(info: { project: { name: string }; setTimeout(ms: number): void; timeout: number }): Promise<AdminFixtures> {
  giveBack = await holdInvoiceSettings(info);
  fx = await insertAdminFixtures(info.project.name);
  return fx;
}

/** Maria's request to pay for the prepayment (175 €) of the fixture registration, unpaid. */
async function request(f: AdminFixtures) {
  const made = await createInvoice(db, f.registration.id, { kind: "prepayment", mode: "request" }, new Date());
  if (!made.ok) throw new Error(`createInvoice: ${made.error}`);
  return made.invoice;
}

/** A pending Montonio payment of the registration's prepayment, started to pay `invoiceId` (payments.invoice_id: what „Maksa" does, payments/start.ts). */
async function startedFor(f: AdminFixtures, invoiceId: number): Promise<Payment> {
  const r = f.registration;
  const now = new Date();
  const row = await insertPayment(db, { kind: "prepayment", registrationId: r.id, courseId: f.course.id, clientId: null, email: r.email, name: r.name, locale: "et", amountCents: 17500, invoiceId }, now, LOCAL_REFERENCE_PREFIX);
  const uuid = `e2e-${randomUUID()}`;
  await attachOrder(db, row.id, uuid, now);
  return { ...row, providerUuid: uuid };
}

/** The settlement door's dependencies: the work after the response (the mails, Maria's notices) is dropped, so nothing is sent. */
const deps = (): SettleDeps => ({
  db,
  env: {} as Env,
  now: new Date(),
  siteUrl: "http://localhost:3000",
  later: () => {},
  montonio: {} as SettleDeps["montonio"],
});

/** Montonio's PAID for `p`, the exact sum, by bank link (the webhook's or the return's facts). */
const paidFacts = (p: Payment): Facts => ({ uuid: p.providerUuid!, status: "paid", rawStatus: "PAID", amountCents: p.amountCents, currency: "EUR", method: "paymentInitiation", bank: "Swedbank" });

/** The invoices of the fixture registration as stored, in the order they were made. */
const storedInvoices = (f: AdminFixtures) =>
  onLocalDb(
    (sql) =>
      sql<{ status: string; method: string | null; paymentId: number | null; paidAdds: boolean; cents: number }[]>`
        select status, paid_method as method, payment_id as "paymentId", paid_adds as "paidAdds", amount_cents as cents
          from invoices where registration_id = ${f.registration.id} order by id`,
    { marksPages: false },
  );
const storedPaymentStatus = async (id: number) => (await onLocalDb((sql) => sql<{ status: string }[]>`select status from payments where id = ${id}`, { marksPages: false }))[0].status;

const mark = (id: number) => markInvoicePaid(db, id, { paidAt: new Date(), method: "bank" }, new Date());

test("two „Märgi tasutuks“ at the same moment on one invoice: exactly one wins, and „Laekunud summa“ gets the amount once", async ({}, info) => {
  const f = await fixtures(info);
  const invoice = await request(f);
  const [first, second] = await inFlight(APPLICATION, sessionRow(f.session.id), () => mark(invoice.id), () => mark(invoice.id));
  expect(first).toMatchObject({ ok: true });
  expect(second).toEqual({ ok: false, error: "notUnpaid" });
  // one paid invoice, Maria's mark; the registration holds the 175 € once and confirms at 50 %
  expect(await storedInvoices(f)).toEqual([{ status: "paid", method: "bank", paymentId: null, paidAdds: true, cents: 17500 }]);
  expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ paidCents: 17500, status: "confirmed" });
});

test("a „Märgi tasutuks“ first and a Montonio settlement of the payment started for the same invoice at the same moment: the invoice is paid once, the payment's money has an invoice of its own, and every euro is counted", async ({}, info) => {
  const f = await fixtures(info);
  const invoice = await request(f);
  const payment = await startedFor(f, invoice.id);
  const [marked, settled] = await inFlight(APPLICATION, sessionRow(f.session.id), () => mark(invoice.id), () => settlePayment(deps(), payment, paidFacts(payment)));
  expect(marked).toMatchObject({ ok: true });
  expect(settled).toMatchObject({ id: payment.id, status: "paid" });
  expect(await storedPaymentStatus(payment.id)).toBe("paid");
  // R7: Maria's mark paid the request (it added its 175 €); the online payment is a second real payment, and got its own invoice (Montonio, the
  // payment's), of the request's part. Two real payments, two invoices, both counted
  expect(await storedInvoices(f)).toEqual([
    { status: "paid", method: "bank", paymentId: null, paidAdds: true, cents: 17500 },
    { status: "paid", method: "montonio", paymentId: payment.id, paidAdds: false, cents: 17500 },
  ]);
  expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ paidCents: 35000, status: "confirmed" });
  // nothing is left unpaid, and the payment is not waiting in „Arveta maksed"
  expect((await storedInvoices(f)).filter((i) => i.status === "unpaid")).toEqual([]);
  expect((await uninvoicedPayments(db)).filter((p) => p.id === payment.id)).toEqual([]);
});

test("a Montonio settlement first and a „Märgi tasutuks“ of the invoice it was started for at the same moment: the invoice is Montonio's, the mark is refused, and nothing is counted twice", async ({}, info) => {
  const f = await fixtures(info);
  const invoice = await request(f);
  const payment = await startedFor(f, invoice.id);
  const [settled, marked] = await inFlight(APPLICATION, sessionRow(f.session.id), () => settlePayment(deps(), payment, paidFacts(payment)), () => mark(invoice.id));
  expect(settled).toMatchObject({ id: payment.id, status: "paid" });
  expect(marked).toEqual({ ok: false, error: "notUnpaid" });
  expect(await storedPaymentStatus(payment.id)).toBe("paid");
  // R13: the request is the payment's invoice (paid by Montonio, no second one), and the 175 € is on „Laekunud summa" once, from the payment
  expect(await storedInvoices(f)).toEqual([{ status: "paid", method: "montonio", paymentId: payment.id, paidAdds: false, cents: 17500 }]);
  expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ paidCents: 17500, status: "confirmed" });
  expect((await uninvoicedPayments(db)).filter((p) => p.id === payment.id)).toEqual([]);
});

test("m14: two invoices issued at the same moment under the same prefix, on two registrations of two sessions: consecutive numbers, never one twice", async ({}, info) => {
  const f = await fixtures(info);
  // a second registration of the fixture course on a session of its own, so the two issues share no row lock: only the number series' lock
  // stands between them (its address is the fixture's pattern, so the clean-up takes it and its invoice; the course takes its session)
  const second = await onLocalDb(
    async (sql) => {
      const [session] = await sql<{ id: number }[]>`
        insert into course_sessions (course_id, starts_at, city, venue, capacity)
        values (${f.course.id}, date_trunc('day', now()) + interval '61 days 10 hours', 'Tartu', 'E2E saal 2', 4) returning id`;
      const [registration] = await sql<{ id: number }[]>`
        insert into registrations (course_id, course_session_id, kind, name, email, payment_choice, status)
        values (${f.course.id}, ${session.id}, 'group', ${`E2E Teine ${f.tag}`}, ${`e2e-admin-reg2-${f.tag}@example.com`}, 'half', 'awaiting_prepayment')
        returning id`;
      return { session: session.id, registration: registration.id };
    },
    { marksPages: false },
  );
  const issue = (registrationId: number) => () => createInvoice(db, registrationId, { kind: "prepayment", mode: "request" }, new Date());
  const [a, b] = await inFlight(APPLICATION, numberSeries, issue(f.registration.id), issue(second.registration));
  if (!a.ok || !b.ok) throw new Error(`createInvoice: ${a.ok ? "" : a.error} ${b.ok ? "" : b.error}`);
  // both are the tests' series (E2E, this Tallinn year); the first started is the first issued, and the second takes the very next number
  for (const inv of [a.invoice, b.invoice]) {
    expect(inv.number).toMatch(INVOICE_NUMBER);
    expect([inv.prefix, inv.year]).toEqual(["E2E", Number(today().slice(0, 4))]);
  }
  expect(b.invoice.seq).toBe(a.invoice.seq + 1);
  expect(b.invoice.number).not.toBe(a.invoice.number);
  // the database agrees: one row per number, and the setting moved on past both
  const stored = await onLocalDb(
    (sql) => sql<{ number: string; n: number }[]>`select number, count(*)::int as n from invoices where number in (${a.invoice.number}, ${b.invoice.number}) group by number order by number`,
    { marksPages: false },
  );
  expect(stored).toEqual([{ number: a.invoice.number, n: 1 }, { number: b.invoice.number, n: 1 }].sort((x, y) => x.number.localeCompare(y.number)));
  const [{ setting }] = await onLocalDb((sql) => sql<{ setting: { nextSeq: number } }[]>`select value as setting from settings where key = 'invoice'`, { marksPages: false });
  expect(setting.nextSeq).toBe(b.invoice.seq + 1);
});
