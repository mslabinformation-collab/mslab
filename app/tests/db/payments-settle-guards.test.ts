import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { attachOrder, insertPayment } from "@/db/queries/payments";
import { lockForPayment } from "@/db/queries/seats";
import { mailQuota, payments, registrations, type Payment } from "@/db/schema";
import { settlePayment, settleToken, type Facts } from "@/server/payments/settle";
import { contactCourse, orderToken, pendingPayment, registrationOn, settleDeps, stubMontonio, TEST_MONTONIO } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

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
    const e = await insertPayment(logged, { kind: "ecourse", registrationId: null, courseId: c.course.id, clientId: null, email: "ostja@example.com", name: "Ostja", locale: "et", amountCents: 19000 }, NOW);
    await attachOrder(logged, e.id, "uuid-e", NOW);
    const { deps } = settleDeps(logged, m.montonio, NOW);
    queries.length = 0;
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken({ ...e, providerUuid: "uuid-e" })));
    expect(at(queries, PAYMENT_UPDATE)).toBeGreaterThanOrEqual(0);
    expect(at(queries, SESSION_LOCK)).toBe(-1);
    expect(at(queries, REGISTRATION_LOCK)).toBe(-1);
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
  test("payment mails are not counted in the daily mail caps: no mail_quota row, whatever was sent", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    const p = await pendingPayment(db, await registrationOn(db, c));
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    const held = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com" }));
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(held, { grandTotal: 1 })));
    await flush();
    expect(m.mails().length).toBeGreaterThanOrEqual(3);
    expect(await db.select().from(mailQuota)).toEqual([]);
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
