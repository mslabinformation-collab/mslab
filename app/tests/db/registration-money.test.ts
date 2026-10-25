import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { readSetting } from "@/db/queries/public";
import { courses, invoices, registrations, type Registration } from "@/db/schema";
import { tallinnInstant } from "@/domain/calendar";
import { createInvoice } from "@/server/invoices";
import { addManualPayment, manualPaymentForm, type ManualPaymentInput } from "@/server/registration-money";
import { makeTestDb } from "./helpers";
import { contactCourse, loggedDb, registrationOn } from "./payments-fixtures";

// „Lisa laekumine“ on the server (admin UX pass B4, spec §9–§10; README A2 drawer 2): Maria's one money path. One transaction under the payment
// locks: the paid total re-read and compared with what her panel showed (`stale`), „Muu summa“ above what is left refused (`overRemainder`), the
// amount added as an online payment adds it (addRegistrationPayment: confirmed from 50 %, never taken back, the seat checked), and with
// „Koosta kviitung“ a „Juba tasutud“ invoice for exactly that amount — all or nothing. Then the action that the drawer's panel (Task 5) calls.

const state = vi.hoisted(() => ({ db: null as unknown }));
const cache = vi.hoisted(() => ({ refresh: vi.fn() }));
const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => cache);
vi.mock("@/server/public-cache", () => pub);
vi.mock("@/server/auth", () => ({ adminAction: (fn: (admin: unknown, ...args: unknown[]) => unknown) => (...args: unknown[]) => fn({ email: "admin@example.test" }, ...args) }));

const actions = await import("@/server/actions/admin");

/** 16.10.2026 12:00 in Tallinn (summer time, UTC+3). */
const NOW = new Date("2026-10-16T09:00:00Z");
const TODAY = "2026-10-16";
/** Seaded → Maksmine filled in: the seller, VAT off, MSL from 1 in 2026. */
const CARD = { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu", vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: 2026, nextSeq: 1, termDays: 7, footer: "" };
const BANK = { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  cache.refresh.mockClear();
  pub.revalidatePublic.mockClear();
  for (const method of ["info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** The design's example: a group course of 290 € (half 145 €), its session in Pärnu of `capacity` seats. */
async function course290(opts: { capacity?: number } = {}) {
  const c = await contactCourse(db, opts);
  const [course] = await db.update(courses).set({ priceGroup: 29000 }).where(eq(courses.id, c.course.id)).returning();
  return { course, session: c.session };
}

const registration = async (id: number) => (await db.select().from(registrations).where(eq(registrations.id, id)))[0];
const allInvoices = () => db.select().from(invoices).orderBy(invoices.id);
const seller = () => setSetting(db, "invoice", CARD);

/** „Lisa laekumine“ on `r` as the panel sends it: `cents` today by bank transfer, no receipt, built on the paid total `r` holds; `over` changes it. */
const add = (r: Registration, cents: number, over: Partial<ManualPaymentInput> = {}, now = NOW) =>
  addManualPayment(db, { registrationId: r.id, cents, paidOn: TODAY, method: "bank", receipt: false, expectedPaidCents: r.paidCents, ...over }, now);

describe("addManualPayment: the money", () => {
  test("145 € of 290 € reaches 50 %: the seat is confirmed now (its hold ended), the total is the stored one plus the amount; no receipt asked, none made", async () => {
    const c = await course290();
    const r = await registrationOn(db, c, { seatHoldUntil: new Date(NOW.getTime() + 60_000) });
    expect(await add(r, 14500)).toEqual({ ok: true, addedCents: 14500, paidCents: 14500, status: "confirmed", confirmedNow: true, full: false, receiptNumber: null });
    expect(await registration(r.id)).toMatchObject({ paidCents: 14500, status: "confirmed", seatHoldUntil: null });
    expect(await allInvoices()).toEqual([]);
  });

  test("100 € of 290 € stays „Ootab ettemaksu“; the next 45 €, built on 100 €, confirms it; money after that never un-confirms", async () => {
    const c = await course290();
    const r = await registrationOn(db, c);
    expect(await add(r, 10000)).toEqual({ ok: true, addedCents: 10000, paidCents: 10000, status: "awaiting_prepayment", confirmedNow: false, full: false, receiptNumber: null });
    expect(await registration(r.id)).toMatchObject({ paidCents: 10000, status: "awaiting_prepayment" });
    expect(await add(r, 4500, { expectedPaidCents: 10000 })).toMatchObject({ ok: true, paidCents: 14500, status: "confirmed", confirmedNow: true });
    expect(await add(r, 14500, { expectedPaidCents: 14500 })).toMatchObject({ ok: true, paidCents: 29000, status: "confirmed", confirmedNow: false });
  });

  test("a registration Maria confirmed by hand with nothing paid stays confirmed, and the money is added (confirmedNow false)", async () => {
    const c = await course290();
    const r = await registrationOn(db, c, { status: "confirmed" });
    expect(await add(r, 5000)).toMatchObject({ ok: true, paidCents: 5000, status: "confirmed", confirmedNow: false, full: false });
  });

  test("a full session: the money is added, `full: true`, the status stays „Ootab ettemaksu“ and her hold ends, as the online path does (D2)", async () => {
    const c = await course290({ capacity: 1 });
    await registrationOn(db, c, { email: "first@example.test", status: "confirmed", paidCents: 14500 });
    const r = await registrationOn(db, c, { email: "second@example.test", seatHoldUntil: new Date(NOW.getTime() + 60_000) });
    expect(await add(r, 14500)).toEqual({ ok: true, addedCents: 14500, paidCents: 14500, status: "awaiting_prepayment", confirmedNow: false, full: true, receiptNumber: null });
    expect(await registration(r.id)).toMatchObject({ paidCents: 14500, status: "awaiting_prepayment", seatHoldUntil: null });
  });

  test("an individual registration (no session) confirms at 50 % of the individual price; there is no seat to be full", async () => {
    const c = await course290();
    await db.update(courses).set({ priceIndividual: 45000 }).where(eq(courses.id, c.course.id));
    const r = await registrationOn(db, c, { kind: "individual", courseSessionId: null });
    expect(await add(r, 22500)).toMatchObject({ ok: true, paidCents: 22500, status: "confirmed", confirmedNow: true, full: false });
  });

  test("Review Focus 2: a press built on an old total is `stale` — off by any amount, up or down — and nothing is written, a receipt neither", async () => {
    const c = await course290();
    await seller();
    const r = await registrationOn(db, c, { paidCents: 10000 });
    for (const expectedPaidCents of [0, 9999, 10001, 14500]) {
      expect(await add(r, 1000, { expectedPaidCents, receipt: true }), String(expectedPaidCents)).toEqual({ ok: false, error: "stale" });
    }
    expect(await registration(r.id)).toMatchObject({ paidCents: 10000, status: "awaiting_prepayment" });
    expect(await allInvoices()).toEqual([]);
    expect(await add(r, 1000, { expectedPaidCents: 10000 })).toMatchObject({ ok: true, paidCents: 11000 });
  });

  test("Review Focus 2: more than is left of the price is `overRemainder` (the server's own check, not only the field's); exactly the rest passes; paid in full, any amount is over", async () => {
    const c = await course290();
    const r = await registrationOn(db, c);
    expect(await add(r, 29001)).toEqual({ ok: false, error: "overRemainder" });
    const part = await registrationOn(db, c, { email: "part@example.test", paidCents: 20000, status: "confirmed" });
    expect(await add(part, 9001)).toEqual({ ok: false, error: "overRemainder" });
    expect(await registration(part.id)).toMatchObject({ paidCents: 20000 });
    expect(await add(part, 9000)).toMatchObject({ ok: true, paidCents: 29000 });
    expect(await add(part, 1, { expectedPaidCents: 29000 })).toEqual({ ok: false, error: "overRemainder" });
    expect(await registration(part.id)).toMatchObject({ paidCents: 29000 });
  });

  test("a course with no price: no remainder to check and the status is not recomputed („Muu summa“ only)", async () => {
    const c = await course290();
    await db.update(courses).set({ priceGroup: null }).where(eq(courses.id, c.course.id));
    const r = await registrationOn(db, c);
    expect(await add(r, 500000)).toEqual({ ok: true, addedCents: 500000, paidCents: 500000, status: "awaiting_prepayment", confirmedNow: false, full: false, receiptNumber: null });
    expect(await registration(r.id)).toMatchObject({ paidCents: 500000, status: "awaiting_prepayment" });
  });

  test("a cancelled registration is refused (`cancelled`), an unknown one `notFound`; nothing written", async () => {
    const c = await course290();
    const r = await registrationOn(db, c, { status: "cancelled" });
    expect(await add(r, 14500)).toEqual({ ok: false, error: "cancelled" });
    expect(await registration(r.id)).toMatchObject({ paidCents: 0, status: "cancelled" });
    expect(await addManualPayment(db, { registrationId: 999_999, cents: 100, paidOn: TODAY, method: "bank", receipt: false, expectedPaidCents: 0 }, NOW)).toEqual({ ok: false, error: "notFound" });
  });

  test("the day is Tallinn's: tomorrow is `future`; just after Tallinn's midnight (still the day before in UTC) that day is today", async () => {
    const c = await course290();
    const r = await registrationOn(db, c);
    expect(await add(r, 1000, { paidOn: "2026-10-17" })).toEqual({ ok: false, error: "future" });
    expect(await registration(r.id)).toMatchObject({ paidCents: 0 });
    // 17.10.2026 00:30 in Tallinn is 16.10 21:30 UTC
    expect(await add(r, 1000, { paidOn: "2026-10-17" }, new Date("2026-10-16T21:30:00Z"))).toMatchObject({ ok: true, paidCents: 1000 });
    expect(await add(r, 1000, { paidOn: "2026-10-01", expectedPaidCents: 1000 })).toMatchObject({ ok: true, paidCents: 2000 });
  });

  test("`invalid` before anything is read: an amount that is no whole number of cents above 0, a way that is not bank, cash or card, a day that is no day, an id or a shown total that is no number", async () => {
    const c = await course290();
    const r = await registrationOn(db, c);
    const bad: Partial<ManualPaymentInput>[] = [
      { cents: 0 }, { cents: -100 }, { cents: 10.5 }, { cents: Number.NaN }, { cents: 2_147_483_648 },
      { method: "montonio" as never }, { method: "financing" as never }, { method: "" as never },
      { paidOn: "16.10.2026" }, { paidOn: "2026-02-30" }, { paidOn: "" },
      { registrationId: 0 }, { registrationId: Number.NaN },
      { expectedPaidCents: -1 }, { expectedPaidCents: 1.5 }, { expectedPaidCents: Number.NaN },
      { receipt: "yes" as never },
    ];
    for (const over of bad) expect(await add(r, 1000, over), JSON.stringify(over)).toEqual({ ok: false, error: "invalid" });
    expect(await registration(r.id)).toMatchObject({ paidCents: 0 });
  });
});

describe("addManualPayment: „Koosta kviitung“", () => {
  test("a receipt: a paid „Juba tasutud“ invoice for exactly the amount, paid_adds (its undo takes it back), on the day and the way given; its number returned", async () => {
    const c = await course290();
    await seller();
    const r = await registrationOn(db, c, { email: "kati@example.test" });
    const result = await add(r, 10000, { receipt: true, method: "cash", paidOn: "2026-10-15" });
    expect(result).toEqual({ ok: true, addedCents: 10000, paidCents: 10000, status: "awaiting_prepayment", confirmedNow: false, full: false, receiptNumber: "MSL2026-001" });
    const [inv] = await allInvoices();
    expect(inv).toMatchObject({
      number: "MSL2026-001",
      registrationId: r.id,
      paymentId: null,
      courseId: c.course.id,
      status: "paid",
      amountCents: 10000,
      paidAdds: true,
      paidMethod: "cash",
      paidAt: tallinnInstant("2026-10-15", "12:00"),
      dueAt: null,
      reference: "",
      issuedAt: NOW,
      kind: "prepayment",
      line: { course: "Kulmumeistri baaskoolitus", session: "14.11.2026 Pärnu", part: "Osamakse" },
      buyer: { name: "Kati Tamm", email: "kati@example.test", address: "", company: "", companyCode: "", companyAddress: "" },
    });
    expect(await readSetting(db, "invoice")).toMatchObject({ nextYear: 2026, nextSeq: 2 });
    expect(await registration(r.id)).toMatchObject({ paidCents: 10000 });
  });

  test("the receipt's part: the first 145 € is „Ettemaks 50%“ paid today (at the press's own time), the 145 € after it „Jääk 50%“, all 290 € at once „Kogu summa (100%)“", async () => {
    const c = await course290();
    await seller();
    const r = await registrationOn(db, c);
    expect(await add(r, 14500, { receipt: true })).toMatchObject({ ok: true, status: "confirmed", confirmedNow: true, receiptNumber: "MSL2026-001" });
    expect(await add(r, 14500, { receipt: true, expectedPaidCents: 14500 })).toMatchObject({ ok: true, paidCents: 29000, receiptNumber: "MSL2026-002" });
    const whole = await registrationOn(db, c, { email: "whole@example.test", paymentChoice: "full" });
    expect(await add(whole, 29000, { receipt: true, method: "card" })).toMatchObject({ ok: true, receiptNumber: "MSL2026-003" });
    expect((await allInvoices()).map((i) => [i.kind, i.amountCents, i.line.part, i.paidAt?.toISOString()])).toEqual([
      ["prepayment", 14500, "Ettemaks 50%", NOW.toISOString()],
      ["balance", 14500, "Jääk 50%", NOW.toISOString()],
      ["full", 29000, "Kogu summa (100%)", NOW.toISOString()],
    ]);
    // the receipts cover the price: „Koosta arve“ offers nothing more
    expect(await createInvoice(db, r.id, { kind: "balance", mode: "request" }, NOW)).toEqual({ ok: false, error: "notOpen" });
  });

  test("review m2: the receipt counts money recorded before it — 145 € without a receipt, then the next 145 € with one, is „Jääk 50%“; the later „Koosta arve“ receipt for the first 145 € is „Ettemaks 50%“", async () => {
    const c = await course290();
    await seller();
    const r = await registrationOn(db, c);
    expect(await add(r, 14500)).toMatchObject({ ok: true, receiptNumber: null });
    expect(await add(r, 14500, { receipt: true, expectedPaidCents: 14500 })).toMatchObject({ ok: true, paidCents: 29000, receiptNumber: "MSL2026-001" });
    expect(await createInvoice(db, r.id, { kind: "prepayment", mode: "receipt", paidAt: NOW, method: "bank" }, NOW)).toMatchObject({ ok: true, invoice: { number: "MSL2026-002" } });
    expect((await allInvoices()).map((i) => [i.kind, i.amountCents, i.line.part])).toEqual([
      ["balance", 14500, "Jääk 50%"],
      ["prepayment", 14500, "Ettemaks 50%"],
    ]);
  });

  test("spec §10: with a payment request open, the receipt is a new „Juba tasutud“ invoice and the request stays „Tasumata“", async () => {
    const c = await course290();
    await seller();
    await setSetting(db, "prepayment", BANK);
    const r = await registrationOn(db, c);
    const asked = await createInvoice(db, r.id, { kind: "prepayment", mode: "request" }, NOW);
    if (!asked.ok) throw new Error(asked.error);
    expect(await add(r, 14500, { receipt: true })).toMatchObject({ ok: true, receiptNumber: "MSL2026-002" });
    expect((await allInvoices()).map((i) => [i.number, i.status])).toEqual([["MSL2026-001", "unpaid"], ["MSL2026-002", "paid"]]);
  });

  test("a course with no price: the receipt's part is „Osamakse“ (no half, whole or rest to name)", async () => {
    const c = await course290();
    await db.update(courses).set({ priceGroup: null }).where(eq(courses.id, c.course.id));
    await seller();
    const r = await registrationOn(db, c);
    expect(await add(r, 8000, { receipt: true })).toMatchObject({ ok: true, receiptNumber: "MSL2026-001" });
    expect((await allInvoices())[0]).toMatchObject({ amountCents: 8000, line: { part: "Osamakse" } });
  });

  test("all or nothing: a receipt asked with no seller (Seaded → Maksmine empty at the press) is `sellerMissing` — the money is not added, the seat not confirmed, no number taken", async () => {
    const c = await course290();
    const r = await registrationOn(db, c, { seatHoldUntil: new Date(NOW.getTime() + 60_000) });
    expect(await add(r, 14500, { receipt: true })).toEqual({ ok: false, error: "sellerMissing" });
    expect(await registration(r.id)).toMatchObject({ paidCents: 0, status: "awaiting_prepayment", seatHoldUntil: new Date(NOW.getTime() + 60_000) });
    expect(await allInvoices()).toEqual([]);
    expect(await readSetting(db, "invoice")).toBeNull();
    // without the receipt the same press goes through
    expect(await add(r, 14500)).toMatchObject({ ok: true, paidCents: 14500, receiptNumber: null });
  });

  test("Review Focus 1: the order of the locks — the session, the registration, the paid sum written, then the number lock, the invoice and the setting", async () => {
    const { db: logged, queries } = await loggedDb();
    db = logged;
    const c = await course290();
    await seller();
    const r = await registrationOn(db, c);
    queries.length = 0;
    expect(await add(r, 14500, { receipt: true })).toMatchObject({ ok: true });
    const at = (re: RegExp) => queries.findIndex((q) => re.test(q));
    const sessionLock = at(/^select 1 from course_sessions [\s\S]*for update/);
    const registrationLock = at(/^select 1 from registrations where id = [\s\S]*for update/);
    const paidSum = at(/^update "registrations"/);
    const numberLock = at(/pg_advisory_xact_lock\(hashtext\(/);
    const written = at(/^insert into "invoices"/);
    const settingWrite = at(/^insert into "settings"/);
    expect(sessionLock).toBeGreaterThanOrEqual(0);
    expect([sessionLock < registrationLock, registrationLock < paidSum, paidSum < numberLock, numberLock < written, written < settingWrite]).toEqual([true, true, true, true, true]);
  });
});

describe("addManualPaymentAction: the drawer's „Lisa laekumine“ (Task 5's panel)", () => {
  const form = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };

  test("manualPaymentForm reads the panel's fields: whole numbers as digits only, the receipt ticked as „1“ or „on“", () => {
    expect(manualPaymentForm(form({ registrationId: "7", cents: "14500", paidOn: TODAY, method: "cash", receipt: "1", expectedPaidCents: "0" }))).toEqual({
      registrationId: 7, cents: 14500, paidOn: TODAY, method: "cash", receipt: true, expectedPaidCents: 0,
    });
    expect(manualPaymentForm(form({ registrationId: "7", cents: "14500", paidOn: TODAY, method: "bank", receipt: "on", expectedPaidCents: "10000" }))).toMatchObject({ receipt: true, expectedPaidCents: 10000 });
    const loose = manualPaymentForm(form({ registrationId: " 7", cents: "1e3", paidOn: TODAY, method: "bank", expectedPaidCents: "" }));
    expect(loose).toMatchObject({ receipt: false });
    expect([loose.registrationId, loose.cents, loose.expectedPaidCents].every(Number.isNaN)).toBe(true);
    expect(manualPaymentForm(new FormData())).toMatchObject({ paidOn: "", method: "", receipt: false });
    // any object with the form's get() is read as one (as the other actions read theirs: a FormData from another realm, a test's stand-in); a
    // call with no form at all is every field missing, never a throw (Task 3 review: duck-typed, not `instanceof FormData`)
    const fields: Record<string, string> = { registrationId: "7", cents: "14500", paidOn: TODAY, method: "card", receipt: "1", expectedPaidCents: "0" };
    expect(manualPaymentForm({ get: (name: string) => fields[name] ?? null })).toEqual({ registrationId: 7, cents: 14500, paidOn: TODAY, method: "card", receipt: true, expectedPaidCents: 0 });
    for (const none of [null, undefined, "x", 5, {}]) expect(manualPaymentForm(none)).toMatchObject({ paidOn: "", method: "", receipt: false });
  });

  test("a press that confirms the seat: the answer, the public seats revalidated, the page refreshed", async () => {
    const c = await course290();
    const r = await registrationOn(db, c);
    const answer = await actions.addManualPaymentAction(null, form({ registrationId: String(r.id), cents: "14500", paidOn: TODAY, method: "bank", expectedPaidCents: "0" }));
    expect(answer).toMatchObject({ ok: true, paidCents: 14500, status: "confirmed", confirmedNow: true });
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "seats" });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  test("money under 50 % moves no seat: refreshed, not revalidated; a full session ends her hold: revalidated", async () => {
    const c = await course290({ capacity: 1 });
    const r = await registrationOn(db, c);
    expect(await actions.addManualPaymentAction(null, form({ registrationId: String(r.id), cents: "10000", paidOn: TODAY, method: "bank", expectedPaidCents: "0" }))).toMatchObject({ ok: true, confirmedNow: false, full: false });
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    await registrationOn(db, c, { email: "first@example.test", status: "confirmed" });
    expect(await actions.addManualPaymentAction(null, form({ registrationId: String(r.id), cents: "4500", paidOn: TODAY, method: "bank", expectedPaidCents: "10000" }))).toMatchObject({ ok: true, full: true });
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "seats" });
  });

  test("`stale` refreshes the page (it must show the stored total); `invalid` and `future` change nothing and do not; a throw is `server`", async () => {
    const c = await course290();
    const r = await registrationOn(db, c, { paidCents: 5000 });
    expect(await actions.addManualPaymentAction(null, form({ registrationId: String(r.id), cents: "1000", paidOn: TODAY, method: "bank", expectedPaidCents: "0" }))).toEqual({ ok: false, error: "stale" });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    cache.refresh.mockClear();
    expect(await actions.addManualPaymentAction(null, form({ registrationId: String(r.id), cents: "abc", paidOn: TODAY, method: "bank", expectedPaidCents: "5000" }))).toEqual({ ok: false, error: "invalid" });
    expect(await actions.addManualPaymentAction(null, form({ registrationId: String(r.id), cents: "1000", paidOn: "2999-01-01", method: "bank", expectedPaidCents: "5000" }))).toEqual({ ok: false, error: "future" });
    expect(cache.refresh).not.toHaveBeenCalled();
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    // review m3: a call with no form (a crafted request) is `invalid`, never a throw
    for (const notAForm of [null, undefined, {}, "registrationId=1"]) expect(await actions.addManualPaymentAction(null, notAForm as never), String(notAForm)).toEqual({ ok: false, error: "invalid" });
    expect(cache.refresh).not.toHaveBeenCalled();
    state.db = { transaction: () => Promise.reject(new Error("connection lost")) };
    expect(await actions.addManualPaymentAction(null, form({ registrationId: String(r.id), cents: "1000", paidOn: TODAY, method: "bank", expectedPaidCents: "5000" }))).toEqual({ ok: false, error: "server" });
    expect(await registration(r.id)).toMatchObject({ paidCents: 5000 });
  });
});
