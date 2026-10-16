import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Db } from "../../src/db/client";
import { attachOrder, insertPayment } from "../../src/db/queries/payments";
import * as schema from "../../src/db/schema";
import type { Payment } from "../../src/db/schema";
import { LOCAL_REFERENCE_PREFIX } from "../../src/domain/payments";
import { createInvoice, markInvoicePaid, uninvoicedPayments } from "../../src/server/invoices";
import type { Env } from "../../src/server/notify";
import { settlePayment, type Facts, type SettleDeps } from "../../src/server/payments/settle";
import { insertAdminFixtures, localDatabaseUrl, onLocalDb, removeAdminFixtures, storedAdminRegistration, type AdminFixtures } from "./fixtures";
import { holdInvoiceSettings } from "./invoices";
import { expect, submitsForms, test } from "./test";

// Invoices on real Postgres (invoices Task 7; owed by Tasks 3 and 4): what the unit tests' single-connection PGlite cannot show, because it
// runs one transaction at a time. The app's own markInvoicePaid and settlePayment (the one door of every paid Montonio payment), in this
// process, on a pool of the local Postgres:
// - two „Märgi tasutuks" on one invoice at the same moment: exactly one wins, the other finds the invoice paid, and „Laekunud summa" gets the
//   amount once (spec §6.4, D6);
// - a „Märgi tasutuks" and a Montonio settlement of a payment started for that same invoice at the same moment (rulings R7, R13, R14), in both
//   orders. Whichever comes second finds the first's committed state: settle first, the invoice is Montonio's and the mark is refused; the mark
//   first, the invoice is Maria's, and the payment's money gets an invoice of its own. Either way the invoice is paid once, „Laekunud summa"
//   counts every real payment, and nothing is left unpaid and charged.
// "At the same moment" is proven, not hoped for (inFlight): another connection holds the registration's session row, the first lock of every
// payment path (db/queries/seats.ts lockForPayment: the session, then the registration, then the payment or the invoice), while the calls
// start, and lets it go only once this pool shows every call waiting for it. They stand in the lock's queue in the order started (a lock queue
// is first come, first served), so which of the two goes first is fixed by the test, and the outcome that follows is the locks', not the
// timing's. The settlement's mails and Maria's notices (the work after the response) are not run here: no mail goes out. Nothing here depends
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
  pool = postgres(localDatabaseUrl(), { max: 6, connect_timeout: 20, onnotice: () => {}, connection: { application_name: APPLICATION } });
  db = drizzle(pool, { schema }) as unknown as Db;
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

/**
 * Two calls in flight at the same moment, `first` started before `second`. Another connection holds the session row of the registration
 * (the first statement of lockForPayment) while they start; the test starts `first`, waits until this pool shows it waiting, starts `second`,
 * waits until it shows both waiting, and only then lets the row go (its transaction ends). A call that ran its whole transaction before the
 * other began would never be seen waiting beside it. Their results, in the order started.
 */
async function inFlight<A, B>(sessionId: number, first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
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
          await tx`select 1 from course_sessions where id = ${sessionId} for update`;
          a = start(first);
          expect((await lockWaits(1, () => settled > 0)).length, "the first call waits for the session row").toBe(1);
          b = start(second);
          const waiting = await lockWaits(2, () => settled > 0);
          expect(settled, "a call went past the session row's lock while it was held").toBe(0);
          expect(waiting.length, `both calls wait for the lock (${waiting.map((w) => w.query.slice(0, 60)).join(" | ")})`).toBe(2);
        }),
      { marksPages: false },
    );
  } finally {
    await Promise.allSettled(started); // a failure above lets the lock go too: what is on its way finishes before the clean-up
  }
  return [await a, await b];
}

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
  const [first, second] = await inFlight(f.session.id, () => mark(invoice.id), () => mark(invoice.id));
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
  const [marked, settled] = await inFlight(f.session.id, () => mark(invoice.id), () => settlePayment(deps(), payment, paidFacts(payment)));
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
  const [settled, marked] = await inFlight(f.session.id, () => settlePayment(deps(), payment, paidFacts(payment)), () => mark(invoice.id));
  expect(settled).toMatchObject({ id: payment.id, status: "paid" });
  expect(marked).toEqual({ ok: false, error: "notUnpaid" });
  expect(await storedPaymentStatus(payment.id)).toBe("paid");
  // R13: the request is the payment's invoice (paid by Montonio, no second one), and the 175 € is on „Laekunud summa" once, from the payment
  expect(await storedInvoices(f)).toEqual([{ status: "paid", method: "montonio", paymentId: payment.id, paidAdds: false, cents: 17500 }]);
  expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ paidCents: 17500, status: "confirmed" });
  expect((await uninvoicedPayments(db)).filter((p) => p.id === payment.id)).toEqual([]);
});
