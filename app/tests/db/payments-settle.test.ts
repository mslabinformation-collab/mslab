import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { payments, registrations } from "@/db/schema";
import { settlePayment, settleToken } from "@/server/payments/settle";
import { contactCourse, orderToken, pendingPayment, registrationOn, settleDeps, stubMontonio } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// settlePayment, the one door (phase 2b, spec 6.2, 7.3, 7.4): the winner of pending → paid does the once-only work, the amount must match, paid
// is a floor, a token in doubt is asked about, and the payer's mail and Maria's notice follow (after the response).

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
const subjects = (m: ReturnType<typeof stubMontonio>) => m.mails().map((x) => [x.to, x.subject]);

describe("PAID", () => {
  test("the webhook twice: pending → paid once; 50 % confirms, the hold ends, one mail to her and one notice to Maria, the seats revalidated", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const r = await registrationOn(db, c, { seatHoldUntil: new Date(NOW.getTime() + 10 * MIN) });
    const p = await pendingPayment(db, r);
    const { deps, changes, flush } = settleDeps(db, m.montonio, NOW);
    const token = m.montonio.verifyOrderToken(orderToken(p));
    expect(await settleToken(deps, token)).toMatchObject({ kind: "done", payment: { status: "paid", paidAt: NOW, method: "paymentInitiation", bank: "Swedbank" } });
    expect(await settleToken(deps, token)).toMatchObject({ kind: "done", payment: { status: "paid" } });
    await flush();
    const after = await registration(r.id);
    expect([after.status, after.paidCents, after.seatHoldUntil]).toEqual(["confirmed", 17500, null]);
    expect(subjects(m)).toEqual([
      ["kati@example.com", "Koht on kinnitatud — Kulmumeistri baaskoolitus"],
      ["maria@example.test", "Uus makse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €"],
    ]);
    expect(m.mails()[0].text).toContain("Ülejäänud 175 € tasud koolituspäeval või Minu koolitused lehel.");
    expect(m.pings()).toEqual([expect.stringContaining("Uus makse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €")]);
    expect(m.mails()[1].text).toContain("Makseviis: Pangalink · Swedbank");
    expect(changes).toEqual([{ kind: "seats", course: "kulmumeistri-baaskoolitus" }]);
    expect(m.state.gets).toEqual([]); // nothing was in doubt
  });

  test("the return and the webhook at once: one winner, the amount counted once", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    const token = m.montonio.verifyOrderToken(orderToken(p));
    await Promise.all([settleToken(deps, token), settleToken(deps, token)]);
    await flush();
    expect((await registration(r.id)).paidCents).toBe(17500);
    expect(m.mails()).toHaveLength(2);
  });

  test("the rest after 50 %: a balance payment makes it fully paid; the mail says nothing is left", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db), { status: "confirmed", paidCents: 17500 });
    const p = await pendingPayment(db, r, { kind: "balance" });
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    await flush();
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 35000]);
    expect(m.mails()[0].subject).toBe("Koht on kinnitatud — Kulmumeistri baaskoolitus");
    expect(m.mails()[0].text).toContain("Kogu summa on tasutud.");
    expect(m.mails()[1].text).toContain("Registreering on kinnitatud ja täielikult tasutud.");
  });

  test("two paid rows of one registration whose sum is over its price: both are recorded as today, and Maria gets ONE 'Ülemakse' alert (the backstop of the double-payment rule)", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db), { paymentChoice: "full" });
    const first = await pendingPayment(db, r, { amountCents: 35000 });
    const second = await pendingPayment(db, r, { amountCents: 35000 });
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    for (const p of [first, second]) {
      await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
      await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p))); // (a retry: no second alert)
    }
    await flush();
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 70000]);
    expect([(await payment(first.id)).status, (await payment(second.id)).status]).toEqual(["paid", "paid"]);
    const over = m.mails().filter((x) => x.subject.startsWith("Ülemakse"));
    expect(over.map((x) => [x.to, x.subject])).toEqual([["maria@example.test", "Ülemakse: Kati Tamm, Kulmumeistri baaskoolitus"]]);
    expect(over[0].text).toContain("Laekunud kokku 700 €, koolituse hind 350 €. Kontrolli Montonios ja tagasta liigne osa.");
    expect(over[0].text).toContain(`Viide: ${second.reference}`);
    expect(m.pings().filter((t) => t.startsWith("Ülemakse"))).toEqual([expect.stringContaining("Ülemakse: Kati Tamm, Kulmumeistri baaskoolitus")]);
    // her mails and Maria's "Uus makse" are today's, one per payment
    expect(m.mails().filter((x) => x.subject.startsWith("Uus makse"))).toHaveLength(2);
  });

  test("a payment that brings the sum exactly to the price is no overpayment", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db), { status: "confirmed", paidCents: 17500 });
    const p = await pendingPayment(db, r, { kind: "balance" });
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    await flush();
    expect((await registration(r.id)).paidCents).toBe(35000);
    expect(m.mails().map((x) => x.subject).filter((s) => s.startsWith("Ülemakse"))).toEqual([]);
  });

  test("paid when the course is full (D2): the money is recorded, the place stays unconfirmed, 'Makse laekus, aga koolitus on täis'", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db, { capacity: 1 });
    await registrationOn(db, c, { email: "teine@example.com", status: "confirmed", paidCents: 35000 });
    const r = await registrationOn(db, c, { seatHoldUntil: new Date(NOW.getTime() - MIN) }); // her hold has ended
    const p = await pendingPayment(db, r);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    await flush();
    const after = await registration(r.id);
    expect([after.status, after.paidCents, after.seatHoldUntil]).toEqual(["awaiting_prepayment", 17500, null]);
    expect(subjects(m)).toEqual([
      ["kati@example.com", "Makse on kätte saadud — Kulmumeistri baaskoolitus"],
      ["maria@example.test", "Makse laekus, aga koolitus on täis: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €"],
    ]);
    expect(m.mails()[0].text).toContain("Koolitus on vahepeal täitunud");
  });

  test("her own live hold is no obstacle on a full session: the hold is hers", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db, { capacity: 1 });
    const r = await registrationOn(db, c, { seatHoldUntil: new Date(NOW.getTime() + 10 * MIN) });
    const p = await pendingPayment(db, r);
    const { deps } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    expect((await registration(r.id)).status).toBe("confirmed");
  });

  test("the amount or the currency does not match: held, nothing confirmed, Maria alerted; held stays held", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    const p = await pendingPayment(db, r);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { grandTotal: 1 })))).toMatchObject({ kind: "done", payment: { status: "held", paidAt: null } });
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)))).toMatchObject({ payment: { status: "held" } });
    const other = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com" }));
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(other, { currency: "USD" })))).toMatchObject({ payment: { status: "held" } });
    await flush();
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["awaiting_prepayment", 0]);
    expect(subjects(m)).toEqual([
      ["maria@example.test", "Kontrolli Montonios: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €"],
      ["maria@example.test", "Kontrolli Montonios: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €"],
    ]);
    expect(m.mails()[0].text).toContain("summa või valuuta ei klapi (Montonio: 1 €)");
    expect(m.mails()[1].text).toContain("(Montonio: 175 USD)");
  });

  test("a sample address (@example.test) gets no mail; Maria is still told", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db), { email: "kati@example.test" }));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    await flush();
    expect(subjects(m).map(([to]) => to)).toEqual(["maria@example.test"]);
  });
});

describe("after paid: paid is a floor", () => {
  test("a late ABANDONED changes nothing; VOIDED is stored as failed (paid_at kept) and alerts Maria; the place stays confirmed", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { paymentStatus: "ABANDONED" })))).toMatchObject({ payment: { status: "paid" } });
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { paymentStatus: "VOIDED" })))).toMatchObject({ payment: { status: "failed", paidAt: NOW } });
    // a retried PAID after the void never runs the once-only work again
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)))).toMatchObject({ payment: { status: "failed" } });
    await flush();
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 17500]);
    expect(m.mails().map((x) => x.subject)).toEqual([
      "Koht on kinnitatud — Kulmumeistri baaskoolitus",
      "Uus makse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €",
      "Kontrolli Montonios: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €",
    ]);
    expect(m.mails()[2].text).toContain("Pank tühistas juba laekunud makse.");
    expect(m.mails()[2].text).not.toContain("VOIDED");
  });

  test("REFUNDED: refunded and an alert; paidCents and the confirmation stay (Maria adjusts in the admin)", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)));
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { paymentStatus: "PARTIALLY_REFUNDED" })))).toMatchObject({ payment: { status: "refunded" } });
    await flush();
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 17500]);
    expect(m.mails().at(-1)!.text).toContain("Montonio teatab tagastusest (osaliselt tagastatud).");
    expect(m.mails().at(-1)!.text).not.toContain("PARTIALLY_REFUNDED");
  });
});

describe("failed and pending", () => {
  test("ABANDONED on a pending prepayment: failed, the hold ends (the seat is free again), the seats revalidated; nothing mailed", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db), { seatHoldUntil: new Date(NOW.getTime() + 10 * MIN) });
    const p = await pendingPayment(db, r);
    const { deps, changes, flush } = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { paymentStatus: "ABANDONED" })))).toMatchObject({ payment: { status: "failed", paidAt: null } });
    await flush();
    expect((await registration(r.id)).seatHoldUntil).toBeNull();
    expect(changes).toEqual([{ kind: "seats", course: "kulmumeistri-baaskoolitus" }]);
    expect(m.mails()).toEqual([]);
  });

  test("a failed attempt keeps the hold while another payment of the registration is still pending", async () => {
    const m = stubMontonio();
    const hold = new Date(NOW.getTime() + 10 * MIN);
    const r = await registrationOn(db, await contactCourse(db), { seatHoldUntil: hold });
    const first = await pendingPayment(db, r);
    await pendingPayment(db, r);
    const { deps } = settleDeps(db, m.montonio, NOW);
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(first, { paymentStatus: "ABANDONED" })));
    expect((await registration(r.id)).seatHoldUntil).toEqual(hold);
  });

  test("PENDING and AUTHORIZED change nothing; a paid payment later still wins", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    const { deps } = settleDeps(db, m.montonio, NOW);
    for (const s of ["PENDING", "AUTHORIZED"]) expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { paymentStatus: s })))).toMatchObject({ payment: { status: "pending" } });
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)))).toMatchObject({ payment: { status: "paid" } });
  });

  // A local run on the same sandbox store names its payments MSLAB-L<id>, and its webhook is signed with the same keys: it may reach
  // production (its notificationUrl is SITE_URL). It is no payment of production's, whatever row of the same number production has.
  test("a token with another environment's prefix is ignored: 'unknown', nothing asked, nothing changes, the log names no reference", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    const log = vi.mocked(console.error);
    log.mockClear();
    const foreign = `MSLAB-L${p.id}`;
    // the same number, the same uuid, the right amount, PAID: and in doubt too (another key), which would otherwise ask Montonio
    for (const over of [{}, { accessKey: "someone-else" }, { paymentStatus: "REFUNDED" }])
      expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken({ ...p, reference: foreign }, over)))).toEqual({ kind: "unknown" });
    await flush();
    expect(m.state.gets).toEqual([]);
    expect(m.mails()).toEqual([]);
    expect((await db.select().from(payments).where(eq(payments.id, p.id)))[0]).toMatchObject({ status: "pending", paidAt: null });
    const lines = log.mock.calls.map((c) => c.map(String).join(" "));
    expect(lines).toEqual(Array(3).fill("[payments] an order token for a reference of another environment: nothing to settle"));
    expect(lines.join("\n")).not.toContain(foreign);
  });

  test("an unknown reference: 'unknown', nothing changes", async () => {
    const m = stubMontonio();
    const { deps } = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken({ reference: "MSLAB-M999", amountCents: 100, providerUuid: "x" })))).toEqual({ kind: "unknown" });
  });
});

describe("a token in doubt is asked about (spec 7.4)", () => {
  const snapshot = (uuid: string, reference: string, paymentStatus: string, grandTotal = "175.00") => ({ uuid, paymentStatus, merchantReference: reference, grandTotal, currency: "EUR", paymentMethodType: "paymentInitiation" });

  test("another store's key: no answer is 'unconfirmed' (nothing changes); Montonio's PAID settles it, with the token's bank", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    const { deps } = settleDeps(db, m.montonio, NOW);
    const token = m.montonio.verifyOrderToken(orderToken(p, { accessKey: "someone-else" }));
    expect(await settleToken(deps, token)).toMatchObject({ kind: "unconfirmed", payment: { status: "pending" } });
    expect(m.state.gets).toEqual([p.providerUuid]);
    m.state.snapshots.set(p.providerUuid!, snapshot(p.providerUuid!, p.reference, "PAID"));
    expect(await settleToken(deps, token)).toMatchObject({ kind: "done", payment: { status: "paid", bank: "Swedbank" } });
  });

  test("a token of another order: that order is asked about, and one of another reference changes nothing; a token naming no order: the row's own is asked about, and its ABANDONED fails the payment", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    m.state.snapshots.set("someone-elses-uuid", snapshot("someone-elses-uuid", "MSLAB-M999", "PAID"));
    m.state.snapshots.set(p.providerUuid!, snapshot(p.providerUuid!, p.reference, "ABANDONED"));
    const { deps } = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { uuid: "someone-elses-uuid" })))).toMatchObject({ kind: "done", payment: { status: "pending" } });
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { uuid: undefined })))).toMatchObject({ kind: "done", payment: { status: "failed" } });
    expect(m.state.gets).toEqual(["someone-elses-uuid", p.providerUuid]);
  });

  test("an order the payment has since replaced (a retry re-sent its reference, Task 4): its ABANDONED changes nothing, the hold stays; its PAID settles it under that order's uuid", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db), { seatHoldUntil: new Date(NOW.getTime() + 10 * MIN) });
    const p = await pendingPayment(db, r); // its first order: p.providerUuid
    await db.update(payments).set({ providerUuid: "uuid-resent" }).where(eq(payments.id, p.id)); // the retry's re-sent order
    const { deps, flush } = settleDeps(db, m.montonio, NOW);
    m.state.snapshots.set(p.providerUuid!, snapshot(p.providerUuid!, p.reference, "ABANDONED"));
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { paymentStatus: "ABANDONED" })))).toMatchObject({ kind: "done", payment: { status: "pending", providerUuid: "uuid-resent" } });
    expect((await registration(r.id)).seatHoldUntil).not.toBeNull();
    // paid at the first order's bank page in the moment before the retry replaced it: the money counts, once
    m.state.snapshots.set(p.providerUuid!, snapshot(p.providerUuid!, p.reference, "PAID"));
    expect(await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p)))).toMatchObject({ kind: "done", payment: { status: "paid", providerUuid: p.providerUuid } });
    expect(m.state.gets).toEqual([p.providerUuid, p.providerUuid]);
    await flush();
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 17500]);
  });

  test("a token expired beyond the tolerance (a late retry) is asked about; an order of another reference changes nothing", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    const { deps } = settleDeps(db, m.montonio, NOW);
    m.state.snapshots.set(p.providerUuid!, snapshot(p.providerUuid!, "MSLAB-M999", "PAID"));
    const old = m.montonio.verifyOrderToken(orderToken(p, {}, { nowSec: Math.floor(Date.now() / 1000) - 3600 }));
    expect(old.expired).toBe(true);
    expect(await settleToken(deps, old)).toMatchObject({ kind: "done", payment: { status: "pending" } });
    m.state.snapshots.set(p.providerUuid!, snapshot(p.providerUuid!, p.reference, "PAID", "1.00"));
    expect(await settleToken(deps, old)).toMatchObject({ payment: { status: "held" } }); // Montonio's own amount is checked too
  });
});

test("settlePayment is the door the daily check uses too: the same facts, the same once-only work", async () => {
  const m = stubMontonio();
  const r = await registrationOn(db, await contactCourse(db));
  const p = await pendingPayment(db, r);
  const { deps } = settleDeps(db, m.montonio, NOW);
  const facts = { uuid: p.providerUuid!, status: "paid" as const, rawStatus: "PAID", amountCents: 17500, currency: "EUR", method: "paymentInitiation", bank: "" };
  expect((await settlePayment(deps, p, facts)).status).toBe("paid");
  expect((await settlePayment(deps, await payment(p.id), facts)).status).toBe("paid");
  expect((await registration(r.id)).paidCents).toBe(17500);
});
