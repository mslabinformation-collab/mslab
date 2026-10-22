import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { setSetting } from "@/db/queries/admin";
import { attachOrder, insertPayment } from "@/db/queries/payments";
import { lockForPayment } from "@/db/queries/seats";
import { courseAccess, courses, invoices, payments, registrations, type Payment } from "@/db/schema";
import { settlePayment, settleToken, type Facts } from "@/server/payments/settle";
import { contactCourse, orderToken, pendingPayment, registrationOn, settleDeps, stubMontonio, TEST_MONTONIO } from "./payments-fixtures";
import { capRows, countedMails, makeTestDb } from "./helpers";

// The properties the one door must keep, each pinned on its own (phase 2b, spec 7.3, 7.4; the security review of Task 3): the token's keys,
// the exact amount, once-only work for callers holding a stale row, one transaction, no secret in a log, no payment mail in the daily caps.

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

const registration = async (id: number) => (await db.select().from(registrations).where(eq(registrations.id, id)))[0];
const payment = async (id: number) => (await db.select().from(payments).where(eq(payments.id, id)))[0];
/** Montonio's facts about `p` as the daily check would bring them: PAID, the exact amount, in euros. */
const facts = (p: Payment, over: Partial<Facts> = {}): Facts => ({ uuid: p.providerUuid!, status: "paid", rawStatus: "PAID", amountCents: p.amountCents, currency: "EUR", method: "paymentInitiation", bank: "", ...over });
const snapshot = (uuid: string, reference: string, paymentStatus: string, grandTotal = "175.00") => ({ uuid, paymentStatus, merchantReference: reference, grandTotal, currency: "EUR", paymentMethodType: "paymentInitiation" });

describe("the token: our key, our row, Montonio's word when in doubt", () => {
  test("a token with another accessKey, or none at all, is never trusted: Montonio is asked, and no answer changes nothing", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    for (const accessKey of ["someone-else", undefined, null, "", "   "]) {
      expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { accessKey }))), String(accessKey)).toMatchObject({ kind: "unconfirmed", payment: { status: "pending" } });
    }
    await flush();
    expect(m.state.gets).toEqual(Array(5).fill(p.providerUuid));
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents, (await payment(p.id)).status]).toEqual(["awaiting_prepayment", 0, "pending"]);
    expect(m.mails()).toEqual([]);
  });

  test("a uuid that is not the row's is asked about even when everything else in the token is right; without an answer nothing is paid", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    const { deps } = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { uuid: "another-order" })))).toMatchObject({ kind: "unconfirmed", payment: { status: "pending" } });
    expect(m.state.gets).toEqual(["another-order"]);
    expect((await payment(p.id)).status).toBe("pending");
  });

  test("a token expired beyond the tolerance is asked about; without an answer nothing is paid", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    const { deps } = settleDeps(db, m.montonio, NOW);
    const old = m.montonio.verifyOrderToken(orderToken(p, {}, { nowSec: Math.floor(Date.now() / 1000) - 3600 }));
    expect(await settleToken(deps, old)).toMatchObject({ kind: "unconfirmed", payment: { status: "pending" } });
    expect(m.state.gets).toEqual([p.providerUuid]);
    expect((await payment(p.id)).status).toBe("pending");
  });

  test("a pending token in doubt is not worth a question: nothing moves, nobody is asked", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    const { deps } = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { accessKey: "someone-else", paymentStatus: "PENDING" })))).toMatchObject({ kind: "done", payment: { status: "pending" } });
    expect(m.state.gets).toEqual([]);
  });

  test("a reference we do not have is 'unknown' without asking Montonio or touching a row", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken({ reference: "MSLAB-M99999", amountCents: 17500, providerUuid: p.providerUuid }, { accessKey: "someone-else" })))).toEqual({ kind: "unknown" });
    await flush();
    expect(m.state.gets).toEqual([]);
    expect(m.mails()).toEqual([]);
    expect((await payment(p.id)).status).toBe("pending");
  });

  test("Montonio's own answer about an order of this reference, of another amount, holds the row; its answer for another reference is ignored", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    const { deps } = settleDeps(db, m.montonio, NOW);
    m.state.snapshots.set(p.providerUuid!, snapshot(p.providerUuid!, "MSLAB-M99999", "PAID"));
    const token = m.montonio.verifyOrderToken(orderToken(p, { accessKey: "someone-else" }));
    expect(await settleToken(deps, token)).toMatchObject({ kind: "done", payment: { status: "pending" } });
    m.state.snapshots.set(p.providerUuid!, snapshot(p.providerUuid!, p.reference, "PAID", "175.50"));
    expect(await settleToken(deps, token)).toMatchObject({ payment: { status: "held" } });
  });
});

describe("the amount: exact in cents, euros only; anything else holds the row", () => {
  const WRONG_AMOUNTS: [string, unknown][] = [
    ["missing", undefined],
    ["null", null],
    ["not a number", "abc"],
    ["a third decimal", "175.504"],
    ["a cent less", 174.99],
    ["a cent more", 175.01],
    ["negative", -175],
    ["zero", 0],
    ["a boolean", true],
    ["a list", [175]],
    ["absurdly large", 1e21],
  ];
  test.each(WRONG_AMOUNTS)("a PAID token whose grandTotal is %s: held (never read as zero, never rounded into the right one), Maria alerted, nothing confirmed", async (_name, grandTotal) => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { grandTotal })))).toMatchObject({ kind: "done", payment: { status: "held", paidAt: null } });
    await flush();
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["awaiting_prepayment", 0]);
    expect(m.mails().map((x) => x.subject)).toEqual(["Kontrolli Montonios: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €"]);
  });

  test.each([["USD"], ["eur"], ["EURO"], [""], [" "], [undefined], [null], [175]])("a PAID token whose currency is %j: held", async (currency) => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    const { deps } = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { currency })))).toMatchObject({ payment: { status: "held", paidAt: null } });
    expect((await registration(r.id)).paidCents).toBe(0);
  });

  test("the daily check's facts are held the same way: no amount, another amount, another currency", async () => {
    const m = stubMontonio();
    const { deps } = settleDeps(db, m.montonio, NOW);
    const c = await contactCourse(db);
    for (const over of [{ amountCents: null }, { amountCents: 17499 }, { amountCents: 17501 }, { currency: "USD" }, { currency: null }] as Partial<Facts>[]) {
      const p = await pendingPayment(db, await registrationOn(db, c, { email: `check${Math.random()}@example.com` }));
      expect((await settlePayment(deps, p, facts(p, over))).status, JSON.stringify(over)).toBe("held");
    }
  });

  test("a held payment is no longer anybody's to pay: a correct PAID, an ABANDONED and a second wrong one change nothing and alert once", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { grandTotal: 1 })));
    for (const over of [{}, { paymentStatus: "ABANDONED" }, { grandTotal: 2 }]) await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, over)));
    await flush();
    expect((await payment(p.id)).status).toBe("held");
    expect((await registration(r.id)).paidCents).toBe(0);
    expect(m.mails()).toHaveLength(1);
  });
});

describe("once-only: only the winner of pending → paid does the work", () => {
  test("a caller holding a stale 'pending' row (the webhook, the return and the daily check at once) cannot pay it twice", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    const { deps, changes, flush } = settleDeps(db, m.montonio, NOW);
    expect((await settlePayment(deps, p, facts(p))).status).toBe("paid");
    expect((await settlePayment(deps, p, facts(p))).status).toBe("paid"); // the same stale row again
    expect((await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)))).kind).toBe("done");
    await flush();
    expect((await registration(r.id)).paidCents).toBe(17500);
    expect(m.mails()).toHaveLength(2);
    expect(changes).toHaveLength(1);
  });

  test("a stale 'pending' row meeting VOIDED after the payment was paid: failed, paid_at kept, Maria alerted, the confirmation stays", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settlePayment(deps, p, facts(p));
    expect(await settlePayment(deps, p, facts(p, { status: "failed", rawStatus: "VOIDED" }))).toMatchObject({ status: "failed", paidAt: NOW });
    await flush();
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 17500]);
    expect(m.mails().map((x) => x.subject).at(-1)).toMatch(/^Kontrolli Montonios:/);
  });

  test("a stale 'pending' row meeting ABANDONED after the payment was paid: still paid (paid is a floor), the hold and the money untouched", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    const { deps } = settleDeps(db, m.montonio, NOW);
    await settlePayment(deps, p, facts(p));
    for (const rawStatus of ["ABANDONED", "FAILED", "CANCELLED"]) expect((await settlePayment(deps, p, facts(p, { status: "failed", rawStatus }))).status, rawStatus).toBe("paid");
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 17500]);
  });

  test("VOIDED twice alerts once; a refund twice alerts once; a refund never comes back to paid", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    const voided = await pendingPayment(db, await registrationOn(db, c));
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(voided)));
    for (let i = 0; i < 2; i++) await settleToken(deps, m.montonio.verifyOrderToken(orderToken(voided, { paymentStatus: "VOIDED" })));
    const refunded = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com" }));
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(refunded)));
    for (let i = 0; i < 2; i++) await settleToken(deps, m.montonio.verifyOrderToken(orderToken(refunded, { paymentStatus: "REFUNDED" })));
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(refunded)))).toMatchObject({ payment: { status: "refunded" } });
    await flush();
    expect(m.mails().filter((x) => x.subject.startsWith("Kontrolli Montonios:"))).toHaveLength(2);
    expect((await payment(refunded.id)).status).toBe("refunded");
  });

  test("a failed attempt can still be paid (the payer finished at the bank after ABANDONED): paid once, the place confirmed", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db), { seatHoldUntil: new Date(NOW.getTime() + 10 * MIN) });
    const p = await pendingPayment(db, r);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { paymentStatus: "ABANDONED" })));
    expect((await registration(r.id)).seatHoldUntil).toBeNull();
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)))).toMatchObject({ payment: { status: "paid", paidAt: NOW } });
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    await flush();
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 17500]);
    expect(m.mails()).toHaveLength(2);
  });

  test("a payment settled elsewhere is returned as the database has it, not as the caller's stale row", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    const { deps } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    expect(await settlePayment(deps, p, facts(p, { status: "failed", rawStatus: "ABANDONED" }))).toMatchObject({ status: "paid", paidAt: NOW });
  });
});

describe("a second paid order for one payment: the money is not lost, Maria is told (the replaced order and the live one both paid)", () => {
  const paidSnapshot = (uuid: string, reference: string, grandTotal = "175.00") => ({ uuid, paymentStatus: "PAID", merchantReference: reference, grandTotal, currency: "EUR", paymentMethodType: "paymentInitiation" });

  /** A payment whose live order ("uuid-live", which a re-send gave it) was paid first. The first order is `p.providerUuid`. */
  async function paidOnItsLiveOrder() {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    await db.update(payments).set({ providerUuid: "uuid-live" }).where(eq(payments.id, p.id));
    const live = { ...p, providerUuid: "uuid-live" };
    const harness = settleDeps(db, m.montonio, NOW);
    await settleToken(harness.deps, m.montonio.verifyOrderToken(orderToken(live)));
    return { m, r, p, live, ...harness };
  }

  test("the replaced order is paid too: the row stays as it is, 200, and Maria gets 'Topeltmakse' with both order ids", async () => {
    const { m, r, p, deps, flush } = await paidOnItsLiveOrder();
    m.state.snapshots.set(p.providerUuid!, paidSnapshot(p.providerUuid!, p.reference));
    const before = await payment(p.id);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)))).toMatchObject({ kind: "done", payment: { status: "paid", providerUuid: "uuid-live", paidAt: NOW } });
    await flush();
    expect(await payment(p.id)).toEqual(before); // nothing in the row changed
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 17500]); // and the money is not counted twice
    expect(m.mails().map((x) => x.subject)).toEqual([
      "Koht on kinnitatud — Kulmumeistri baaskoolitus",
      "Uus makse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €",
      "Topeltmakse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €",
    ]);
    const alert = m.mails()[2];
    expect(alert.to).toBe("maria@example.test");
    expect(alert.text).toContain("Sama makse eest laekus teine tasumine (teine Montonio tellimus). Tagasta üks neist Montonio halduses.");
    expect(alert.text).toContain("Montonio: uuid-live");
    expect(alert.text).toContain(`Montonio: ${p.providerUuid}`);
    expect(m.pings().at(-1)).toContain("Topeltmakse: Kati Tamm");
  });

  test("the same order told twice (the webhook again, the return, the daily check) is no second payment: no alert", async () => {
    const { m, live, deps, flush } = await paidOnItsLiveOrder();
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(live)));
    await settlePayment(deps, live, facts(live, { uuid: "uuid-live" }));
    await settlePayment(deps, await payment(live.id), facts(live, { uuid: "" })); // a fact without an order id says nothing about another order
    await flush();
    expect(m.mails().map((x) => x.subject)).toEqual(["Koht on kinnitatud — Kulmumeistri baaskoolitus", "Uus makse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €"]);
  });

  test("the same second order told again — the payer reloads the return, the webhook comes again — is one 'Topeltmakse', recorded for 14 days", async () => {
    const { m, p, deps, flush, kv } = await paidOnItsLiveOrder();
    m.state.snapshots.set(p.providerUuid!, paidSnapshot(p.providerUuid!, p.reference));
    for (let i = 0; i < 3; i++) await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    await flush();
    expect(m.mails().filter((x) => x.subject.startsWith("Topeltmakse"))).toHaveLength(1);
    expect(m.pings().filter((x) => x.startsWith("Topeltmakse"))).toHaveLength(1);
    expect([...kv.store.keys()].filter((k) => k.startsWith("pay:double:"))).toEqual([`pay:double:${p.id}:${p.providerUuid}`]);
    expect(kv.ttl.get(`pay:double:${p.id}:${p.providerUuid}`)).toBe(14 * 24 * 3600);
    // a third order is a new alert; the second still is not
    m.state.snapshots.set("uuid-third", paidSnapshot("uuid-third", p.reference));
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken({ ...p, providerUuid: "uuid-third" })));
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    await flush();
    expect(m.mails().filter((x) => x.subject.startsWith("Topeltmakse"))).toHaveLength(2);
  });

  test("two reloads at the same moment: one alert (the record is taken in one step)", async () => {
    const { m, p, deps, flush } = await paidOnItsLiveOrder();
    m.state.snapshots.set(p.providerUuid!, paidSnapshot(p.providerUuid!, p.reference));
    await Promise.all([1, 2, 3].map(() => settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)))));
    await flush();
    expect(m.mails().filter((x) => x.subject.startsWith("Topeltmakse"))).toHaveLength(1);
  });

  test("an alert that reached no one is not recorded: the next reload tells Maria; and a store that fails never loses the alert", async () => {
    const { m, p, deps, flush, kv } = await paidOnItsLiveOrder();
    m.state.snapshots.set(p.providerUuid!, paidSnapshot(p.providerUuid!, p.reference));
    const { RESEND_API_KEY, TELEGRAM_BOT_TOKEN } = deps.env;
    deps.env.RESEND_API_KEY = undefined;
    deps.env.TELEGRAM_BOT_TOKEN = undefined;
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    await flush();
    expect(m.mails().filter((x) => x.subject.startsWith("Topeltmakse"))).toHaveLength(0);
    deps.env.RESEND_API_KEY = RESEND_API_KEY;
    deps.env.TELEGRAM_BOT_TOKEN = TELEGRAM_BOT_TOKEN;
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    await flush();
    expect(m.mails().filter((x) => x.subject.startsWith("Topeltmakse"))).toHaveLength(1);
    // the store failing: a repeat is better than a lost alert
    deps.env.KV = { ...kv, reserve: async () => { throw new Error("kv down"); } };
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    await flush();
    expect(m.mails().filter((x) => x.subject.startsWith("Topeltmakse"))).toHaveLength(2);
  });

  test("the alert shows what the second order paid, not the row's amount: 1 € here, 175 € in the row", async () => {
    const { m, p, deps, flush } = await paidOnItsLiveOrder();
    m.state.snapshots.set(p.providerUuid!, paidSnapshot(p.providerUuid!, p.reference, "1.00"));
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    // and from a trusted token (Montonio's own key, the row's order told again as a second one)
    await settlePayment(deps, await payment(p.id), facts(p, { uuid: "uuid-from-token", amountCents: 12550, currency: "PLN" }));
    await flush();
    const alerts = m.mails().filter((x) => x.subject.startsWith("Topeltmakse"));
    expect(alerts).toHaveLength(2);
    expect(alerts[0].subject).toBe("Topeltmakse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €");
    expect(alerts[0].text).toContain("Teine tasumine: 1 €");
    expect(alerts[0].text).toContain("Summa: 175 €");
    expect(alerts[1].text).toContain("Teine tasumine: 125,50 PLN");
  });

  test("a second order paid with another amount is told the same way; a payment voided after paid and then paid again on another order too", async () => {
    const { m, p, deps, flush } = await paidOnItsLiveOrder();
    expect((await settlePayment(deps, await payment(p.id), facts(p, { uuid: "uuid-other", amountCents: 100 }))).status).toBe("paid");
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken({ ...p, providerUuid: "uuid-live" }, { paymentStatus: "VOIDED" })));
    expect((await settlePayment(deps, await payment(p.id), facts(p, { uuid: "uuid-third" }))).status).toBe("failed");
    await flush();
    expect(m.mails().map((x) => x.subject.split(":")[0])).toEqual(["Koht on kinnitatud — Kulmumeistri baaskoolitus", "Uus makse", "Topeltmakse", "Kontrolli Montonios", "Topeltmakse"]);
  });

  test("a second payment of a payment that never was paid is not 'double': a held row stays held and tells nothing new", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { grandTotal: 1 })));
    await settlePayment(deps, await payment(p.id), facts(p, { uuid: "uuid-other" }));
    await flush();
    expect(m.mails().map((x) => x.subject.split(":")[0])).toEqual(["Kontrolli Montonios"]);
  });
});

describe("a late järelmaks after a paid bank payment (instalments §4, Review Focus 1): held as „Topeltmakse“, never counted twice", () => {
  // A declined application stays PENDING at Montonio for 7 days: she pays by bank meanwhile (a new attempt, start.ts), and Inbank may still
  // approve the old one. The loan that turns PAID then is a second payment of something paid in full: held („Ootel kontrollil“), never added
  // to Laekunud summa, never opening the course again, no invoice; Maria is told „Topeltmakse“ and refunds it in Montonio (which cancels the loan).
  const LOAN = { paymentMethod: "hirePurchase", paymentProviderName: "Inbank" };
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const errors = () => vi.mocked(console.error).mock.calls.map((c) => c.map(String).join(" "));
  /** Seaded's seller, so that a paid payment gets its invoice (and a held one visibly none). */
  const sellerReady = () => setSetting(db, "invoice", { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu", vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: 2026, nextSeq: 1, termDays: 7, footer: "" });
  const NOTE_REGISTRATION = "Järelmaks (Inbank) laekus, kui koolitus oli juba täies ulatuses tasutud. Seda ei pandud kirja: makse on lehel Maksed \"Ootel kontrollil\". Tagasta see Montonio halduses: täielik tagastus tühistab järelmaksu.";
  const NOTE_ECOURSE = "Järelmaks (Inbank) laekus, kui e-koolitus oli juba tasutud. Seda ei pandud kirja ja ligipääsu ei pikendatud: makse on lehel Maksed \"Ootel kontrollil\". Tagasta see Montonio halduses: täielik tagastus tühistab järelmaksu.";
  const NOTE_BANK_AFTER_LOAN = "Pangamakse laekus, kui e-koolitus oli juba järelmaksuga (Inbank) tasutud. Seda ei pandud kirja ja ligipääsu ei pikendatud: makse on lehel Maksed \"Ootel kontrollil\". Tagasta see Montonio halduses.";

  test("a hirePurchase PAID after a bank payment already paid the registration in full is held, alerted as Topeltmakse, not counted", async () => {
    const m = stubMontonio();
    await sellerReady();
    const r = await registrationOn(db, await contactCourse(db), { email: "kati@example.test", paymentChoice: "financing", seatHoldUntil: new Date(NOW.getTime() + 40 * MIN) });
    const loan = await pendingPayment(db, r, { amountCents: 35000, method: "hirePurchase" }, ago(20 * MIN));
    const bank = await pendingPayment(db, r, { amountCents: 35000, method: "paymentInitiation" }, ago(10 * MIN));
    const { deps, flush, kv } = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(bank)))).toMatchObject({ payment: { status: "paid" } });
    // Inbank approves the old application after all
    const late = m.montonio.verifyOrderToken(orderToken(loan, LOAN));
    expect(await settleToken(deps, late)).toMatchObject({ kind: "done", payment: { status: "held", paidAt: null, method: "hirePurchase", bank: "Inbank", providerUuid: loan.providerUuid } });
    // told again — the webhook's retry, the return, the daily check: still held, nothing counted, no second alert
    expect(await settleToken(deps, late)).toMatchObject({ payment: { status: "held" } });
    expect(await settlePayment(deps, loan, facts(loan, { method: "hirePurchase", amountCents: 35000 }))).toMatchObject({ status: "held" });
    await flush();
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 35000]);
    expect([(await payment(bank.id)).status, (await payment(loan.id)).status]).toEqual(["paid", "held"]);
    // the bank payment has its invoice; the held loan none
    expect((await db.select().from(invoices)).map((i) => [i.paymentId, i.status, i.paidMethod])).toEqual([[bank.id, "paid", "montonio"]]);
    expect(m.mails().map((x) => [x.to, x.subject])).toEqual([
      ["maria@example.test", "Uus makse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 350 €"],
      ["maria@example.test", "Topeltmakse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 350 €"],
    ]);
    const alert = m.mails()[1].text;
    expect(alert).toContain(NOTE_REGISTRATION);
    expect(alert).not.toContain("Sama makse eest laekus teine tasumine");
    expect(alert).toContain("Teine tasumine: 350 €");
    expect(alert).toContain(`Viide: ${loan.reference}`);
    // its own order, named once (it is the second payment itself, not a second order of it)
    expect(alert.split("\n").filter((l) => l.startsWith("Montonio: "))).toEqual([`Montonio: ${loan.providerUuid}`]);
    expect(m.pings().at(-1)).toContain("Topeltmakse: Kati Tamm");
    expect([...kv.store.keys()].filter((k) => k.startsWith("pay:double:"))).toEqual([`pay:double:${loan.id}:${loan.providerUuid}`]);
    // never an „Ülemakse“: nothing went over the price
    expect(m.mails().filter((x) => x.subject.startsWith("Ülemakse"))).toEqual([]);
    // the log line docs/deploy.md section 21 item 5 quotes: once (only the winner of the held update logs it), with the id only
    expect(errors().filter((l) => l.includes("paid after the whole price"))).toEqual([`[payments] payment ${loan.id}: a järelmaks was paid after the whole price had been, held`]);
  });

  test("Maria refunds the held loan in Montonio, as the „Topeltmakse“ mail says: her refund notice says it was never recorded, nothing to change; a counted payment's refund keeps its sentence", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db), { email: "kati@example.test", paymentChoice: "financing" });
    const loan = await pendingPayment(db, r, { amountCents: 35000, method: "hirePurchase" }, ago(20 * MIN));
    const bank = await pendingPayment(db, r, { amountCents: 35000, method: "paymentInitiation" }, ago(10 * MIN));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(bank)));
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(loan, LOAN)));
    await flush();
    const refund = (p: Payment) => settlePayment(deps, p, facts(p, { status: "refunded", rawStatus: "REFUNDED" }));
    // the loan: held, never counted (paid_at null); its refund is the end of the story Maria was told to finish
    expect(await refund(await payment(loan.id))).toMatchObject({ status: "refunded", paidAt: null });
    await flush();
    const mails = () => m.mails().filter((x) => x.subject.startsWith("Kontrolli Montonios"));
    expect(mails()).toHaveLength(1);
    expect(mails()[0].text).toContain("Montonio teatab tagastusest (tagastatud). Seda makset ei pandud kirja: adminis pole vaja midagi muuta.");
    expect(mails()[0].text).not.toContain("jäid muutmata");
    // the bank payment is counted (paid_at set): its refund keeps the sentence about adjusting what was recorded
    expect(await refund(await payment(bank.id))).toMatchObject({ status: "refunded" });
    await flush();
    expect(mails()).toHaveLength(2);
    expect(mails()[1].text).toContain("Montonio teatab tagastusest (tagastatud). Laekunud summa, registreering ja ligipääs jäid muutmata: muuda neid adminis, kui vaja.");
    expect(mails()[1].text).not.toContain("Seda makset ei pandud kirja");
    // the sum is as it was: only the bank payment's
    expect((await registration(r.id)).paidCents).toBe(35000);
  });

  test("Maria recorded the whole price by hand (a transfer) before the loan was approved: the same, held as „Topeltmakse“", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db), { email: "kati@example.test", paymentChoice: "financing", status: "confirmed", paidCents: 35000 });
    const loan = await pendingPayment(db, r, { amountCents: 35000, method: "hirePurchase" }, ago(20 * MIN));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(loan, LOAN)))).toMatchObject({ payment: { status: "held" } });
    await flush();
    expect((await registration(r.id)).paidCents).toBe(35000);
    expect(m.mails().map((x) => x.subject)).toEqual(["Topeltmakse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 350 €"]);
  });

  // The daily check found a loan PAID but could not settle it: Maria was told „Makse vajab kontrolli“ (pay:stuck:<payment>) and recorded the
  // whole price by hand, as that mail says. When the app records the loan after all, that sum is hers, not a bank payment's: counted, with the
  // follow-up that tells her to remove her own sum, never held as „Topeltmakse“ (which would have her refund the only real payment).
  describe("a loan Maria was told to record by hand", () => {
    const handRecorded = async () => {
      const m = stubMontonio();
      const r = await registrationOn(db, await contactCourse(db), { email: "kati@example.test", paymentChoice: "financing", status: "confirmed", paidCents: 35000 });
      const loan = await pendingPayment(db, r, { amountCents: 35000, method: "hirePurchase" }, ago(20 * MIN));
      return { m, r, loan, ...settleDeps(db, m.montonio, NOW) };
    };

    test("the stuck record says she was told, and she recorded the price by hand: the loan is recorded (not held), the follow-up goes out, no „Topeltmakse“", async () => {
      const { m, r, loan, deps, flush, kv } = await handRecorded();
      kv.store.set(`pay:stuck:${loan.id}`, "1");
      expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(loan, LOAN)))).toMatchObject({ kind: "done", payment: { status: "paid", paidAt: NOW, method: "hirePurchase", bank: "Inbank" } });
      await flush();
      // both sums are there (hers and the loan's): the follow-up and the „Ülemakse“ are what tell her to take hers away
      expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 70000]);
      expect(m.mails().map((x) => x.subject.split(":")[0])).toEqual(["Uus makse", "Ülemakse", "Makse on nüüd kirja pandud"]);
      expect(m.mails().filter((x) => x.subject.startsWith("Topeltmakse"))).toEqual([]);
      expect(m.mails()[2].text).toContain("eemalda oma käsitsi lisatud summa");
      expect([...kv.store.keys()].filter((k) => k.startsWith("pay:double:") || k.startsWith("pay:stuck:"))).toEqual([]);
    });

    test("a record given back (\"0\": the alert reached no one) says nobody was told: the late hold stands", async () => {
      const { m, r, loan, deps, flush, kv } = await handRecorded();
      kv.store.set(`pay:stuck:${loan.id}`, "0");
      expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(loan, LOAN)))).toMatchObject({ payment: { status: "held", paidAt: null } });
      await flush();
      expect((await registration(r.id)).paidCents).toBe(35000);
      expect(m.mails().map((x) => x.subject.split(":")[0])).toEqual(["Topeltmakse"]);
    });

    test("the KV cannot be read: it reads as „not told“ (logged without an address), the late hold stands as before", async () => {
      const { m, r, loan, deps, flush, kv } = await handRecorded();
      kv.store.set(`pay:stuck:${loan.id}`, "1");
      const get = kv.get.bind(kv);
      vi.spyOn(kv, "get").mockImplementation(async (key: string) => {
        if (key.startsWith("pay:stuck:")) throw new Error("kv down for kati@example.test");
        return get(key);
      });
      expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(loan, LOAN)))).toMatchObject({ payment: { status: "held", paidAt: null } });
      await flush();
      expect((await registration(r.id)).paidCents).toBe(35000);
      expect(m.mails().map((x) => x.subject.split(":")[0])).toEqual(["Topeltmakse"]);
      const logged = vi.mocked(console.error).mock.calls.map((c) => c.map(String).join(" "));
      expect(logged.filter((l) => l.includes("could not be read"))).toEqual([`[payments] payment ${loan.id}: the record of an earlier alert could not be read: Error`]);
      expect(logged.join("\n")).not.toMatch(/kati|@/);
    });

    test("no look at the KV for a payment that is no registration's loan", async () => {
      const m = stubMontonio();
      const r = await registrationOn(db, await contactCourse(db), { email: "kati@example.test", paymentChoice: "financing" });
      const bank = await pendingPayment(db, r, { amountCents: 35000, method: "paymentInitiation" }, ago(10 * MIN));
      const { deps, kv } = settleDeps(db, m.montonio, NOW);
      const get = vi.spyOn(kv, "get");
      await settleToken(deps, m.montonio.verifyOrderToken(orderToken(bank)));
      expect(get.mock.calls.filter(([key]) => String(key).startsWith("pay:stuck:"))).toEqual([]);
    });
  });

  test("not paid in full yet (a part recorded by hand, or nothing): the loan is counted as today — an „Ülemakse“ when it goes over", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const part = await registrationOn(db, c, { email: "osa@example.test", paymentChoice: "financing", paidCents: 34999 });
    const loan = await pendingPayment(db, part, { amountCents: 35000, method: "hirePurchase" }, ago(20 * MIN));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(loan, LOAN)))).toMatchObject({ payment: { status: "paid" } });
    await flush();
    expect([(await registration(part.id)).status, (await registration(part.id)).paidCents]).toEqual(["confirmed", 69999]);
    expect(m.mails().map((x) => x.subject.split(":")[0])).toEqual(["Uus makse", "Ülemakse"]);
  });

  test("a bank payment that turns PAID after the loan was counted keeps today's rule: recorded, „Ülemakse“ (only a loan is held)", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db), { email: "kati@example.test", paymentChoice: "financing" });
    const loan = await pendingPayment(db, r, { amountCents: 35000, method: "hirePurchase" }, ago(20 * MIN));
    const bank = await pendingPayment(db, r, { amountCents: 35000, method: "paymentInitiation" }, ago(10 * MIN));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(loan, LOAN)));
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(bank)))).toMatchObject({ payment: { status: "paid" } });
    await flush();
    expect((await registration(r.id)).paidCents).toBe(70000);
    expect(m.mails().map((x) => x.subject.split(":")[0])).toEqual(["Uus makse", "Uus makse", "Ülemakse"]);
  });

  describe("an e-course", () => {
    async function ecourse() {
      const [c] = await db
        .insert(courses)
        .values({ slug: "kulmumeistri-e-koolitus", type: "e_learning", level: "basic", title: { et: "Kulmumeistri e-koolitus", ru: "Онлайн-курс бровиста" }, summary: { et: "" }, body: { et: "" }, published: true, price: 19000, accessMonths: 6 })
        .returning();
      return c;
    }
    /** A pending purchase of `courseId` started at `at` with `method`, its order at Montonio. */
    async function purchase(courseId: number, method: string, at: Date, email = "mari@example.test"): Promise<Payment> {
      const row = await insertPayment(db, { kind: "ecourse", registrationId: null, courseId, clientId: null, email, name: "Mari Maasikas", locale: "et", amountCents: 19000, method }, at, TEST_MONTONIO.referencePrefix);
      await attachOrder(db, row.id, `uuid-${row.id}`, at);
      return { ...row, providerUuid: `uuid-${row.id}` };
    }
    const access = () => db.select().from(courseAccess).orderBy(courseAccess.id);

    test("the same for an e-course: a late loan after a paid bank purchase is held and alerted, the access is not granted twice", async () => {
      const m = stubMontonio();
      await sellerReady();
      const course = await ecourse();
      const loan = await purchase(course.id, "hirePurchase", ago(30 * MIN));
      const bank = await purchase(course.id, "paymentInitiation", ago(20 * MIN));
      const atBank = settleDeps(db, m.montonio, ago(15 * MIN));
      await settleToken(atBank.deps, m.montonio.verifyOrderToken(orderToken(bank)));
      await atBank.flush();
      const opened = await access();
      expect(opened).toEqual([expect.objectContaining({ courseId: course.id, grantedBy: "payment", grantedAt: ago(15 * MIN) })]);
      // Inbank approves the old application a quarter of an hour later
      const { deps, flush } = settleDeps(db, m.montonio, NOW);
      expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(loan, LOAN)))).toMatchObject({ kind: "done", payment: { status: "held", paidAt: null, clientId: null } });
      expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(loan, LOAN)))).toMatchObject({ payment: { status: "held" } });
      await flush();
      // her access is the bank purchase's, as it was: not granted or prolonged again
      expect(await access()).toEqual(opened);
      expect([(await payment(bank.id)).status, (await payment(loan.id)).status]).toEqual(["paid", "held"]);
      expect((await db.select().from(invoices)).map((i) => i.paymentId)).toEqual([bank.id]);
      expect(m.mails().map((x) => [x.to, x.subject])).toEqual([
        ["maria@example.test", "Uus makse: Mari Maasikas, Kulmumeistri e-koolitus (e-koolitus), 190 €"],
        ["maria@example.test", "Topeltmakse: Mari Maasikas, Kulmumeistri e-koolitus (e-koolitus), 190 €"],
      ]);
      expect(m.mails()[1].text).toContain(NOTE_ECOURSE);
      expect(m.mails()[1].text).toContain("Teine tasumine: 190 €");
    });

    test("a stuck record changes nothing for an e-course (its check reads payment rows, there is no sum to record by hand): the late loan is held", async () => {
      const m = stubMontonio();
      const course = await ecourse();
      const loan = await purchase(course.id, "hirePurchase", ago(30 * MIN));
      const bank = await purchase(course.id, "paymentInitiation", ago(20 * MIN));
      const atBank = settleDeps(db, m.montonio, ago(15 * MIN));
      await settleToken(atBank.deps, m.montonio.verifyOrderToken(orderToken(bank)));
      const { deps, flush, kv } = settleDeps(db, m.montonio, NOW);
      kv.store.set(`pay:stuck:${loan.id}`, "1");
      expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(loan, LOAN)))).toMatchObject({ payment: { status: "held", paidAt: null } });
      await flush();
      expect(m.mails().filter((x) => x.subject.startsWith("Topeltmakse"))).toHaveLength(1);
    });

    test("a loan of a purchase paid before it started — a renewal, past the cart's 30 minutes — is counted as today: paid, the access renewed", async () => {
      const m = stubMontonio();
      const course = await ecourse();
      const first = await purchase(course.id, "paymentInitiation", ago(3 * 86_400_000));
      const atFirst = settleDeps(db, m.montonio, ago(3 * 86_400_000));
      await settleToken(atFirst.deps, m.montonio.verifyOrderToken(orderToken(first)));
      const loan = await purchase(course.id, "hirePurchase", ago(20 * MIN));
      const { deps, flush } = settleDeps(db, m.montonio, NOW);
      expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(loan, LOAN)))).toMatchObject({ payment: { status: "paid", paidAt: NOW } });
      await flush();
      expect(await access()).toEqual([expect.objectContaining({ grantedBy: "payment", grantedAt: NOW })]);
      expect(m.mails().map((x) => x.subject.split(":")[0])).toEqual(["Uus makse"]);
    });

    test("a paid purchase of another course, or by another address, holds nothing: the loan is paid and opens its course", async () => {
      const m = stubMontonio();
      const course = await ecourse();
      const [other] = await db
        .insert(courses)
        .values({ slug: "ripsmed-e-koolitus", type: "e_learning", level: "basic", title: { et: "Ripsmete e-koolitus" }, summary: { et: "" }, body: { et: "" }, published: true, price: 19000, accessMonths: 6 })
        .returning();
      const loan = await purchase(course.id, "hirePurchase", ago(30 * MIN));
      const elsewhere = await purchase(other.id, "paymentInitiation", ago(20 * MIN));
      const someoneElse = await purchase(course.id, "paymentInitiation", ago(20 * MIN), "teine@example.test");
      const atBank = settleDeps(db, m.montonio, ago(15 * MIN));
      for (const p of [elsewhere, someoneElse]) await settleToken(atBank.deps, m.montonio.verifyOrderToken(orderToken(p)));
      const { deps } = settleDeps(db, m.montonio, NOW);
      expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(loan, LOAN)))).toMatchObject({ payment: { status: "paid" } });
      expect((await access()).filter((a) => a.courseId === course.id)).toHaveLength(2);
    });

    // the other way round (D5: "if both are paid … the second goes under „Ootel kontrollil“ as „Topeltmakse“"): Inbank approved first, and her
    // bank payment, still open at the bank, was paid after. An e-course has no Laekunud summa and no „Ülemakse“: without this, the course
    // would be opened again and invoiced again with nobody told.
    test("the loan paid first: the bank purchase paid after it is held and alerted „Topeltmakse“ once; the access and the invoice are the loan's", async () => {
      const m = stubMontonio();
      await sellerReady();
      const course = await ecourse();
      const loan = await purchase(course.id, "hirePurchase", ago(30 * MIN));
      const bank = await purchase(course.id, "paymentInitiation", ago(20 * MIN));
      const atLoan = settleDeps(db, m.montonio, ago(15 * MIN));
      expect(await settleToken(atLoan.deps, m.montonio.verifyOrderToken(orderToken(loan, LOAN)))).toMatchObject({ payment: { status: "paid" } });
      await atLoan.flush();
      const opened = await access();
      expect(opened).toEqual([expect.objectContaining({ courseId: course.id, grantedBy: "payment", grantedAt: ago(15 * MIN) })]);
      const { deps, flush, kv } = settleDeps(db, m.montonio, NOW);
      const token = m.montonio.verifyOrderToken(orderToken(bank));
      expect(await settleToken(deps, token)).toMatchObject({ kind: "done", payment: { status: "held", paidAt: null, clientId: null, method: "paymentInitiation", bank: "Swedbank" } });
      // told again — the webhook's retry, the return, the daily check: still held, no second alert
      expect(await settleToken(deps, token)).toMatchObject({ payment: { status: "held" } });
      expect(await settlePayment(deps, bank, facts(bank, { amountCents: 19000 }))).toMatchObject({ status: "held" });
      await flush();
      expect(await access()).toEqual(opened);
      expect([(await payment(loan.id)).status, (await payment(bank.id)).status]).toEqual(["paid", "held"]);
      expect((await db.select().from(invoices)).map((i) => [i.paymentId, i.paidMethod])).toEqual([[loan.id, "financing"]]);
      expect(m.mails().map((x) => [x.to, x.subject])).toEqual([
        ["maria@example.test", "Uus makse: Mari Maasikas, Kulmumeistri e-koolitus (e-koolitus), 190 €"],
        ["maria@example.test", "Topeltmakse: Mari Maasikas, Kulmumeistri e-koolitus (e-koolitus), 190 €"],
      ]);
      const alert = m.mails()[1].text;
      expect(alert).toContain(NOTE_BANK_AFTER_LOAN);
      expect(alert).toContain(`Viide: ${bank.reference}`);
      expect(alert.split("\n").filter((l) => l.startsWith("Montonio: "))).toEqual([`Montonio: ${bank.providerUuid}`]);
      expect([...kv.store.keys()].filter((k) => k.startsWith("pay:double:"))).toEqual([`pay:double:${bank.id}:${bank.providerUuid}`]);
      expect(errors().filter((l) => l.includes("paid after the whole price"))).toEqual([`[payments] payment ${bank.id}: a bank payment was paid after the whole price had been, held`]);
    });

    test("a bank purchase started after the loan was paid — a renewal, past the cart's 30 minutes — is counted as today: paid, the access renewed", async () => {
      const m = stubMontonio();
      const course = await ecourse();
      const loan = await purchase(course.id, "hirePurchase", ago(3 * 86_400_000));
      const atLoan = settleDeps(db, m.montonio, ago(3 * 86_400_000));
      await settleToken(atLoan.deps, m.montonio.verifyOrderToken(orderToken(loan, LOAN)));
      const bank = await purchase(course.id, "paymentInitiation", ago(20 * MIN));
      const { deps, flush } = settleDeps(db, m.montonio, NOW);
      expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(bank)))).toMatchObject({ payment: { status: "paid", paidAt: NOW } });
      await flush();
      expect(await access()).toEqual([expect.objectContaining({ grantedBy: "payment", grantedAt: NOW })]);
      expect(m.mails().map((x) => x.subject.split(":")[0])).toEqual(["Uus makse"]);
    });

    test("a paid loan of another course or by another address, or a paid bank purchase of her own, holds nothing: the bank purchase is paid as today", async () => {
      const m = stubMontonio();
      const course = await ecourse();
      const [other] = await db
        .insert(courses)
        .values({ slug: "ripsmed-e-koolitus", type: "e_learning", level: "basic", title: { et: "Ripsmete e-koolitus" }, summary: { et: "" }, body: { et: "" }, published: true, price: 19000, accessMonths: 6 })
        .returning();
      const bank = await purchase(course.id, "paymentInitiation", ago(30 * MIN));
      const elsewhere = await purchase(other.id, "hirePurchase", ago(20 * MIN));
      const someoneElse = await purchase(course.id, "hirePurchase", ago(20 * MIN), "teine@example.test");
      const ownBank = await purchase(course.id, "paymentInitiation", ago(20 * MIN));
      const atFirst = settleDeps(db, m.montonio, ago(15 * MIN));
      for (const p of [elsewhere, someoneElse]) await settleToken(atFirst.deps, m.montonio.verifyOrderToken(orderToken(p, LOAN)));
      await settleToken(atFirst.deps, m.montonio.verifyOrderToken(orderToken(ownBank)));
      const { deps } = settleDeps(db, m.montonio, NOW);
      expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(bank)))).toMatchObject({ payment: { status: "paid" } });
      expect((await db.select().from(payments)).map((p) => p.status)).toEqual(["paid", "paid", "paid", "paid"]);
    });
  });
});

describe("a registration's payment: one transaction, under the row's lock", () => {
  test("the payment and the registration are written together: when the registration cannot be, the payment stays pending and nothing is sent", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    await db.execute(sql`create function mslab_refuse_paid() returns trigger language plpgsql as $$ begin if new.paid_cents > 0 then raise exception 'refused'; end if; return new; end $$`);
    await db.execute(sql`create trigger mslab_refuse_paid before update on registrations for each row execute function mslab_refuse_paid()`);
    const { deps, changes, flush } = settleDeps(db, m.montonio, NOW);
    await expect(settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)))).rejects.toThrow();
    await flush();
    expect(await payment(p.id)).toMatchObject({ status: "pending", paidAt: null });
    expect((await registration(r.id)).paidCents).toBe(0);
    expect(m.mails()).toEqual([]);
    expect(changes).toEqual([]);
    // and when the cause is gone, the same webhook (Montonio retries after the 503) pays it
    await db.execute(sql`drop trigger mslab_refuse_paid on registrations`);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)))).toMatchObject({ payment: { status: "paid" } });
    expect((await registration(r.id)).paidCents).toBe(17500);
  });

  test("the registration is read FOR UPDATE, as recordRegistrationPayment reads it", async () => {
    const { db: logged, queries } = await loggedDb();
    const m = stubMontonio();
    const p = await pendingPayment(logged, await registrationOn(logged, await contactCourse(logged)));
    const { deps } = settleDeps(logged, m.montonio, NOW);
    queries.length = 0;
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    expect(queries.filter((q) => /from "registrations"/.test(q) && /for update of "registrations"/i.test(q))).toHaveLength(1);
  });

  test("Maria's confirmation is never taken back by a payment: confirmed by hand, then a small payment arrives, the place stays confirmed", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const r = await registrationOn(db, c, { status: "confirmed", paidCents: 0 }); // Maria confirmed it by hand, nothing paid yet
    const p = await pendingPayment(db, r, { kind: "balance", amountCents: 5000 }); // 50 € of 350 €: far under half
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    await flush();
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 5000]);
    expect(m.mails()[0].subject).toBe("Koht on kinnitatud — Kulmumeistri baaskoolitus");
    expect(m.mails()[1].text).toContain("Registreering on kinnitatud. Ülejäänud 300 € tasub ta koolituspäeval või Minu koolitustes.");
  });

  test("a payment under half on an unconfirmed registration still confirms nothing", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r, { kind: "balance", amountCents: 5000 });
    const { deps } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["awaiting_prepayment", 5000]);
  });

  test("a late payment on a full course keeps the place unconfirmed, still revalidates the seats, and tells Maria and the payer so", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db, { capacity: 1 });
    await registrationOn(db, c, { email: "teine@example.com", status: "confirmed", paidCents: 35000 });
    const r = await registrationOn(db, c, { seatHoldUntil: new Date(NOW.getTime() - MIN) });
    const p = await pendingPayment(db, r);
    const { deps, changes, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    await flush();
    expect(changes).toEqual([{ kind: "seats", course: "kulmumeistri-baaskoolitus" }]);
    expect(m.pings()[0]).toContain("Makse laekus, aga koolitus on täis");
    expect(m.mails()[1].text).toContain("Koolitus on täis: koht jäi kinnitamata");
    expect((await payment(p.id)).status).toBe("paid");
  });

  test("a cancelled registration stays cancelled: the money is recorded and Maria hears of it", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db), { status: "cancelled" });
    const p = await pendingPayment(db, r);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    await flush();
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["cancelled", 17500]);
    expect(m.mails().map((x) => x.subject)).toEqual(["Makse on kätte saadud — Kulmumeistri baaskoolitus", "Uus makse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €"]);
    expect(m.mails()[1].text).toContain("Makse on registreeringule kirja pandud.");
  });

  test("a registration deleted meanwhile: the payment is still paid and Maria is told; there is nobody to mail", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    await db.delete(registrations).where(eq(registrations.id, r.id));
    const { deps, changes, flush } = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)))).toMatchObject({ payment: { status: "paid", registrationId: null } });
    await flush();
    expect(m.mails().map((x) => x.to)).toEqual(["maria@example.test"]);
    expect(changes).toEqual([]);
  });

  test("the payer is mailed in the language of the payment", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db), { locale: "ru" }));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    await flush();
    expect(m.mails()[0].subject).toBe("Место подтверждено — Базовый курс бровиста");
    expect(m.mails()[1].subject).toBe("Uus makse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €"); // Maria's texts are Estonian
  });
});

describe("one lock order for every payment path: course_sessions → registrations → payments", () => {
  // The start of a payment (Task 4) locks the session, then the registration, then writes the payment row; a settlement that took the
  // payment row first and the registration after would deadlock with it, and one that counted the seats under the registration's lock alone
  // could confirm two payers for the last seat. The SQL each path sends is logged, and the order of the locks is read from the log.
  const at = (queries: string[], pattern: RegExp) => queries.findIndex((q) => pattern.test(q));
  const SESSION_LOCK = /^select 1 from course_sessions where id = \(select course_session_id from registrations where id = \$1\) for update$/;
  const REGISTRATION_LOCK = /^select 1 from registrations where id = \$1 for update$/;
  const PAYMENT_UPDATE = /^update "payments"/;

  test("PAID: the session is locked, then the registration, and only then is the payment row written", async () => {
    const { db: logged, queries } = await loggedDb();
    const m = stubMontonio();
    const p = await pendingPayment(logged, await registrationOn(logged, await contactCourse(logged)));
    const { deps } = settleDeps(logged, m.montonio, NOW);
    queries.length = 0;
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    const [session, registrationLock, payment] = [at(queries, SESSION_LOCK), at(queries, REGISTRATION_LOCK), at(queries, PAYMENT_UPDATE)];
    expect([session, registrationLock, payment].every((i) => i >= 0), JSON.stringify(queries.map((q) => q.slice(0, 60)))).toBe(true);
    expect(session).toBeLessThan(registrationLock);
    expect(registrationLock).toBeLessThan(payment);
    // the seats are counted after the locks, never before
    expect(at(queries, /count\(\*\)/)).toBeGreaterThan(registrationLock);
  });

  test("a failed prepayment: the registration is locked before the payment row is written (a session lock is not needed to free a seat)", async () => {
    const { db: logged, queries } = await loggedDb();
    const m = stubMontonio();
    const r = await registrationOn(logged, await contactCourse(logged), { seatHoldUntil: new Date(NOW.getTime() + 10 * MIN) });
    const p = await pendingPayment(logged, r);
    const { deps } = settleDeps(logged, m.montonio, NOW);
    queries.length = 0;
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { paymentStatus: "ABANDONED" })));
    expect(at(queries, REGISTRATION_LOCK)).toBeGreaterThanOrEqual(0);
    expect(at(queries, REGISTRATION_LOCK)).toBeLessThan(at(queries, PAYMENT_UPDATE));
    expect(at(queries, SESSION_LOCK)).toBe(-1);
  });

  test("the e-course's payment, which has no registration, takes no registration or session lock", async () => {
    const { db: logged, queries } = await loggedDb();
    const m = stubMontonio();
    const c = await contactCourse(logged);
    const e = await insertPayment(logged, { kind: "ecourse", registrationId: null, courseId: c.course.id, clientId: null, email: "ostja@example.com", name: "Ostja", locale: "et", amountCents: 19000 }, NOW, TEST_MONTONIO.referencePrefix);
    await attachOrder(logged, e.id, "uuid-e", NOW);
    const { deps } = settleDeps(logged, m.montonio, NOW);
    queries.length = 0;
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken({ ...e, providerUuid: "uuid-e" })));
    expect(at(queries, PAYMENT_UPDATE)).toBeGreaterThanOrEqual(0);
    expect(at(queries, SESSION_LOCK)).toBe(-1);
    expect(at(queries, REGISTRATION_LOCK)).toBe(-1);
  });

  test("a loan: whether the registration is paid in full is read under the session's and the registration's locks, before the payment row is written", async () => {
    const { db: logged, queries } = await loggedDb();
    const m = stubMontonio();
    const r = await registrationOn(logged, await contactCourse(logged), { email: "kati@example.test", paymentChoice: "financing", status: "confirmed", paidCents: 35000 });
    const loan = await pendingPayment(logged, r, { amountCents: 35000, method: "hirePurchase" });
    const { deps } = settleDeps(logged, m.montonio, NOW);
    queries.length = 0;
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(loan, { paymentMethod: "hirePurchase" })))).toMatchObject({ payment: { status: "held" } });
    const [session, registrationLock, paidRead, payment] = [at(queries, SESSION_LOCK), at(queries, REGISTRATION_LOCK), at(queries, /^select [\s\S]*"paid_cents"[\s\S]* from "registrations" inner join "courses"/), at(queries, PAYMENT_UPDATE)];
    expect([session, registrationLock, paidRead, payment].every((i) => i >= 0), JSON.stringify(queries.map((q) => q.slice(0, 80)))).toBe(true);
    expect(session).toBeLessThan(registrationLock);
    expect(registrationLock).toBeLessThan(paidRead);
    expect(paidRead).toBeLessThan(payment);
  });

  test("an e-course's settlement (a bank one too) takes its purchase's lock first — start.ts lockEcoursePurchase — so its look for the other paid purchase cannot miss one settled at the same moment", async () => {
    const { db: logged, queries } = await loggedDb();
    const m = stubMontonio();
    const [course] = await logged
      .insert(schema.courses)
      .values({ slug: "kulmumeistri-e-koolitus", type: "e_learning", level: "basic", title: { et: "Kulmumeistri e-koolitus" }, summary: { et: "" }, body: { et: "" }, published: true, price: 19000, accessMonths: 6 })
      .returning();
    const buy = async (method: string) => {
      const row = await insertPayment(logged, { kind: "ecourse", registrationId: null, courseId: course.id, clientId: null, email: "mari@example.test", name: "Mari Maasikas", locale: "et", amountCents: 19000, method }, NOW, TEST_MONTONIO.referencePrefix);
      await attachOrder(logged, row.id, `uuid-${row.id}`, NOW);
      return { ...row, providerUuid: `uuid-${row.id}` };
    };
    const { deps } = settleDeps(logged, m.montonio, NOW);
    const PURCHASE_LOCK = /^select pg_advisory_xact_lock\(\$1::int, hashtext\(\$2\)\)$/;
    const PAID_LOOK = /^select [\s\S]* from "payments" where [\s\S]*"paid_at" >= /;
    for (const method of ["paymentInitiation", "hirePurchase"]) {
      const p = await buy(method);
      queries.length = 0;
      await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { paymentMethod: method })));
      const [lock, look, write] = [at(queries, PURCHASE_LOCK), at(queries, PAID_LOOK), at(queries, PAYMENT_UPDATE)];
      expect(lock, method).toBeGreaterThanOrEqual(0);
      expect(lock, method).toBeLessThan(write);
      // the look for the other paid purchase (a loan's for any, a bank payment's for a loan) runs under the lock, before the write
      expect([lock < look, look < write], method).toEqual([true, true]);
    }
  });

  test("lockForPayment: a registration with a session locks both, one without a session (or none at all) locks what there is and never fails", async () => {
    const { db: logged, queries } = await loggedDb();
    const c = await contactCourse(logged);
    const withSession = await registrationOn(logged, c);
    const without = await registrationOn(logged, c, { email: "yksi@example.com", courseSessionId: null });
    for (const id of [withSession.id, without.id, 99999]) {
      queries.length = 0;
      await logged.transaction(async (tx) => {
        await lockForPayment(tx, id);
      });
      expect(queries.filter((q) => SESSION_LOCK.test(q) || REGISTRATION_LOCK.test(q)).map((q) => (SESSION_LOCK.test(q) ? "session" : "registration"))).toEqual(["session", "registration"]);
    }
  });

  test("a registration with no session is settled all the same (an individual course)", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const r = await registrationOn(db, c, { courseSessionId: null });
    const p = await pendingPayment(db, r);
    const { deps } = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)))).toMatchObject({ payment: { status: "paid" } });
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 17500]);
  });
});

describe("mail, revalidation and logs", () => {
  test("payment mails are not counted in the daily mail caps: no cap row, whatever was sent; the day's count of every mail has them all", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    const p = await pendingPayment(db, await registrationOn(db, c));
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    const held = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com" }));
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(held, { grandTotal: 1 })));
    await flush();
    expect(m.mails().length).toBeGreaterThanOrEqual(3);
    expect(await capRows(db)).toEqual([]);
    expect(await countedMails(db)).toBe(m.mails().length); // Maria's notices and the payer's mails, each counted once Resend took it
  });

  test("a revalidation that fails (it throws, or it rejects) does not undo the payment or lose its mails", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const p = await pendingPayment(db, await registrationOn(db, c));
    const second = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com" }));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    deps.changed = () => {
      throw new Error("revalidate failed");
    };
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)))).toMatchObject({ kind: "done", payment: { status: "paid" } });
    deps.changed = () => Promise.reject(new Error("revalidate failed"));
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(second)))).toMatchObject({ kind: "done", payment: { status: "paid" } });
    await flush();
    expect(m.mails().map((x) => x.to)).toEqual(["kati@example.com", "maria@example.test", "teine@example.com", "maria@example.test"]);
  });

  test("Maria's notice does not depend on the course being readable after the response: it goes without the course's name", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    deps.db = { select: () => { throw Object.assign(new Error("connection lost"), { code: "ECONNRESET" }); } } as unknown as Db;
    await flush();
    expect(m.mails().map((x) => [x.to, x.subject])).toEqual([
      ["kati@example.com", "Koht on kinnitatud — Kulmumeistri baaskoolitus"],
      ["maria@example.test", "Uus makse: Kati Tamm, —, 175 €"],
    ]);
  });

  test("a whole life of payments logs no address, token, key or pay token", async () => {
    const lines: string[] = [];
    for (const method of ["info", "error", "warn", "log"] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    const m = stubMontonio();
    const c = await contactCourse(db);
    const r = await registrationOn(db, c, { seatHoldUntil: new Date(NOW.getTime() + 10 * MIN) });
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    const tokens: string[] = [];
    const token = (p: Parameters<typeof orderToken>[0], over: Record<string, unknown> = {}) => {
      const t = orderToken(p, over);
      tokens.push(t);
      return m.montonio.verifyOrderToken(t);
    };
    const p = await pendingPayment(db, r);
    const held = await pendingPayment(db, await registrationOn(db, c, { email: "held@example.com" }));
    const voided = await pendingPayment(db, await registrationOn(db, c, { email: "voided@example.test" }));
    const refunded = await pendingPayment(db, await registrationOn(db, c, { email: "refunded@example.com" }));
    const failing = await pendingPayment(db, await registrationOn(db, c, { email: "failing@example.com", seatHoldUntil: new Date(NOW.getTime() + 10 * MIN) }));
    await settleToken(deps, token(p));
    await settleToken(deps, token(p, { accessKey: "someone-else" })); // in doubt, no answer: 503 for the webhook
    await settleToken(deps, token(held, { grandTotal: 1 }));
    await settleToken(deps, token(voided));
    await settleToken(deps, token(voided, { paymentStatus: "VOIDED" }));
    await settleToken(deps, token(refunded));
    await settleToken(deps, token(refunded, { paymentStatus: "REFUNDED" }));
    await settleToken(deps, token(failing, { paymentStatus: "ABANDONED" }));
    await settleToken(deps, token({ reference: "MSLAB-M99999", amountCents: 100, providerUuid: "x" }));
    await flush();
    const secrets = [
      "kati@example.com", "held@example.com", "voided@example.test", "refunded@example.com", "failing@example.com", "teine@example.com", "maria@example.test",
      TEST_MONTONIO.secretKey, TEST_MONTONIO.accessKey, "re_test", "123:abc",
      ...[r, ...(await db.select().from(registrations))].map((x) => x.payToken),
      ...tokens.flatMap((t) => [t, ...t.split(".")]),
    ];
    expect(lines.length).toBeGreaterThan(5);
    const log = lines.join("\n");
    for (const secret of secrets) expect(log, secret.slice(0, 12)).not.toContain(secret);
  });
});

/** A fresh database whose every statement is kept in `queries` (drizzle's logger), to read the order of the locks and writes from. */
async function loggedDb(): Promise<{ db: Db; queries: string[] }> {
  const queries: string[] = [];
  const logged = drizzle(new PGlite(), { schema, logger: { logQuery: (query: string) => void queries.push(query) } }) as unknown as Db;
  await migrate(logged as Parameters<typeof migrate>[0], { migrationsFolder: "./drizzle" });
  return { db: logged, queries };
}
