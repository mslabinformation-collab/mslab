import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "@/db/client";
import { courses, discountCodes, discountRedemptions, invoices, payments, registrations, type Course, type CourseSession } from "@/db/schema";
import { addRegistrationDiscount, removeRegistrationDiscount } from "@/server/discount-code-admin";
import { usesOf } from "@/server/discount-codes";
import { startRegistrationPayment } from "@/server/payments/start";
import { contactCourse, registrationOn, SITE, stubMontonio } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// „Lisa sooduskood“ / „Eemalda sooduskood“ on the registration's Raha card (F1 Task 14; spec D11, §10 answer 2, R12), on PGlite: no rule of the code is
// checked, the use counts, the refusals, the removal, and the next start charging the new total.

const NOW = new Date("2026-11-11T10:00:00Z");
let db: Db;
let contact: { course: Course; session: CourseSession };
let n = 0;

beforeEach(async () => {
  db = await makeTestDb();
  contact = await contactCourse(db); // 350 €
});

async function makeCode(over: Partial<typeof discountCodes.$inferInsert> = {}) {
  const [row] = await db
    .insert(discountCodes)
    .values({ code: `ADMIN${++n}`, percent: over.amountCents ? null : 10, audience: "all", ...over })
    .returning();
  return row;
}
const reg = async (id: number) => (await db.select().from(registrations).where(eq(registrations.id, id)))[0];
const usesRows = (registrationId: number) => db.select().from(discountRedemptions).where(eq(discountRedemptions.registrationId, registrationId));
async function invoiceOf(registrationId: number, status: "unpaid" | "paid" | "cancelled") {
  await db.insert(invoices).values({
    number: `MSL2026-${++n}`,
    prefix: "MSL",
    year: 2026,
    seq: n,
    kind: "prepayment",
    registrationId,
    courseId: contact.course.id,
    amountCents: 17500,
    vatRate: null,
    status,
    line: { course: "K", session: "14.11.2026 Tallinn", part: "Ettemaks 50%" },
    seller: { company: "MS LAB OÜ", registryCode: "12345678", address: "Pärnu mnt 1", vatNumber: "", receiver: "MS LAB OÜ", iban: "EE000000000000000000", bank: "Pank" },
    buyer: { name: "Kati Tamm", email: "kati@example.test", address: "", company: "", companyCode: "", companyAddress: "" },
    issuedAt: NOW,
  });
}

describe("Lisa sooduskood", () => {
  test("Lisa sooduskood ignores the code's dates, limit, scope and person rules and counts the use", async () => {
    // paused, ended, used up (limit 1, a live use already), for e-courses only, for people who have trained, once per person
    const code = await makeCode({ active: false, endsOn: "2026-01-01", maxUses: 1, scope: "ecourse", audience: "returning", oncePerPerson: true });
    const other = await registrationOn(db, contact, { email: "teine@example.test", status: "confirmed" });
    await db.insert(discountRedemptions).values({ codeId: code.id, email: "teine@example.test", courseId: contact.course.id, registrationId: other.id, listCents: 35000, discountCents: 3500, via: "form" });
    expect(await usesOf(db, code.id, NOW)).toBe(1);
    const r = await registrationOn(db, contact);
    expect(await addRegistrationDiscount(db, r.id, ` ${code.code.toLowerCase()} `, NOW)).toEqual({ ok: true });
    expect(await reg(r.id)).toMatchObject({ discountCents: 3500, discountCode: code.code });
    expect(await usesRows(r.id)).toMatchObject([{ codeId: code.id, via: "admin", email: "kati@example.com", courseId: contact.course.id, listCents: 35000, discountCents: 3500 }]);
    expect(await usesOf(db, code.id, NOW)).toBe(2);
  });

  test("the discount is the code's on the live list price and keeps the 1 € floor", async () => {
    const euros = await makeCode({ percent: null, amountCents: 20000 });
    const a = await registrationOn(db, contact);
    expect(await addRegistrationDiscount(db, a.id, euros.code, NOW)).toEqual({ ok: true });
    expect((await reg(a.id)).discountCents).toBe(20000);
    const big = await makeCode({ percent: null, amountCents: 99999 });
    const b = await registrationOn(db, contact, { email: "b@example.test" });
    expect(await addRegistrationDiscount(db, b.id, big.code, NOW)).toEqual({ ok: true });
    expect((await reg(b.id)).discountCents).toBe(34900); // 350 € − 1 €
  });

  test("refuses paid, unpaid invoice, cancelled and unknown", async () => {
    const code = await makeCode();
    const paid = await registrationOn(db, contact, { email: "a@example.test", paidCents: 100 });
    const cancelled = await registrationOn(db, contact, { email: "b@example.test", status: "cancelled" });
    const plain = await registrationOn(db, contact, { email: "c@example.test" });
    const invoiced = await registrationOn(db, contact, { email: "d@example.test" });
    await invoiceOf(invoiced.id, "unpaid");
    expect(await addRegistrationDiscount(db, paid.id, code.code, NOW)).toEqual({ ok: false, error: "paid" });
    expect(await addRegistrationDiscount(db, cancelled.id, code.code, NOW)).toEqual({ ok: false, error: "cancelled" });
    expect(await addRegistrationDiscount(db, invoiced.id, code.code, NOW)).toEqual({ ok: false, error: "unpaidInvoice" });
    expect(await addRegistrationDiscount(db, plain.id, "EI-OLE-SEDA", NOW)).toEqual({ ok: false, error: "unknown" });
    expect(await addRegistrationDiscount(db, plain.id, "!!", NOW)).toEqual({ ok: false, error: "unknown" });
    expect(await addRegistrationDiscount(db, 999_999, code.code, NOW)).toEqual({ ok: false, error: "stale" });
    // a refusal writes nothing
    for (const x of [paid, cancelled, invoiced, plain]) {
      expect(await reg(x.id)).toMatchObject({ discountCents: 0, discountCode: "" });
      expect(await usesRows(x.id)).toEqual([]);
    }
    // a cancelled or a paid invoice is no unpaid invoice
    const voided = await registrationOn(db, contact, { email: "e@example.test" });
    await invoiceOf(voided.id, "cancelled");
    expect(await addRegistrationDiscount(db, voided.id, code.code, NOW)).toEqual({ ok: true });
    // P28: a paid invoice on a registration with nothing in „Laekunud summa“ (Maria marked it paid without adding the money) refuses neither
    // as `unpaidInvoice` (only status 'unpaid' is, not "anything not cancelled") nor as `paid` (that is paid_cents alone)
    const markedPaid = await registrationOn(db, contact, { email: "f@example.test" });
    await invoiceOf(markedPaid.id, "paid");
    expect(await addRegistrationDiscount(db, markedPaid.id, code.code, NOW)).toEqual({ ok: true });
    // and one cent received is already money in
    const cent = await registrationOn(db, contact, { email: "g@example.test", paidCents: 1 });
    expect(await addRegistrationDiscount(db, cent.id, code.code, NOW)).toEqual({ ok: false, error: "paid" });
  });

  test("a code already on the registration is stale; a code that takes nothing off is worthless", async () => {
    const code = await makeCode();
    const r = await registrationOn(db, contact);
    expect(await addRegistrationDiscount(db, r.id, code.code, NOW)).toEqual({ ok: true });
    expect(await addRegistrationDiscount(db, r.id, code.code, NOW)).toEqual({ ok: false, error: "stale" });
    expect(await usesRows(r.id)).toHaveLength(1);
    // a list price of 1,00 € or less: discountCents keeps the total at 1 € and so gives 0
    const [cheap] = await db.insert(courses).values({ slug: "odav", type: "contact", level: "basic", title: { et: "Odav" }, summary: { et: "" }, body: { et: "" }, published: true, priceGroup: 100 }).returning();
    const c = await registrationOn(db, { course: cheap, session: contact.session }, { email: "odav@example.test" });
    expect(await addRegistrationDiscount(db, c.id, code.code, NOW)).toEqual({ ok: false, error: "worthless" });
    // a course with no price at all
    const [free] = await db.insert(courses).values({ slug: "hinnata", type: "contact", level: "basic", title: { et: "Hinnata" }, summary: { et: "" }, body: { et: "" }, published: true }).returning();
    const d = await registrationOn(db, { course: free, session: contact.session }, { email: "hinnata@example.test" });
    expect(await addRegistrationDiscount(db, d.id, code.code, NOW)).toEqual({ ok: false, error: "worthless" });
    for (const x of [c, d]) expect(await usesRows(x.id)).toEqual([]);
  });
});

describe("Eemalda sooduskood", () => {
  test("Eemalda deletes the use and restores the list price", async () => {
    const code = await makeCode();
    const r = await registrationOn(db, contact);
    await addRegistrationDiscount(db, r.id, code.code, NOW);
    expect(await removeRegistrationDiscount(db, r.id)).toEqual({ ok: true });
    expect(await reg(r.id)).toMatchObject({ discountCents: 0, discountCode: "" });
    expect(await usesRows(r.id)).toEqual([]);
    expect(await usesOf(db, code.id, NOW)).toBe(0);
    // none there: stale
    expect(await removeRegistrationDiscount(db, r.id)).toEqual({ ok: false, error: "stale" });
    // a use written by the booking form goes too (any `via`), and only this registration's
    const form = await registrationOn(db, contact, { email: "vorm@example.test", discountCents: 3500, discountCode: code.code });
    const keep = await registrationOn(db, contact, { email: "jaab@example.test", discountCents: 3500, discountCode: code.code });
    for (const x of [form, keep]) await db.insert(discountRedemptions).values({ codeId: code.id, email: x.email, courseId: contact.course.id, registrationId: x.id, listCents: 35000, discountCents: 3500, via: "form" });
    expect(await removeRegistrationDiscount(db, form.id)).toEqual({ ok: true });
    expect(await usesRows(form.id)).toEqual([]);
    expect(await usesRows(keep.id)).toHaveLength(1);
  });

  test("the same refusals as the add: paid, cancelled, unpaid invoice, gone", async () => {
    const code = await makeCode();
    const mk = (email: string, over: Parameters<typeof registrationOn>[2]) => registrationOn(db, contact, { email, discountCents: 3500, discountCode: code.code, ...over });
    const paid = await mk("a@example.test", { paidCents: 500 });
    const cancelled = await mk("b@example.test", { status: "cancelled" });
    const invoiced = await mk("c@example.test", {});
    await invoiceOf(invoiced.id, "unpaid");
    expect(await removeRegistrationDiscount(db, paid.id)).toEqual({ ok: false, error: "paid" });
    expect(await removeRegistrationDiscount(db, cancelled.id)).toEqual({ ok: false, error: "cancelled" });
    expect(await removeRegistrationDiscount(db, invoiced.id)).toEqual({ ok: false, error: "unpaidInvoice" });
    expect(await removeRegistrationDiscount(db, 999_999)).toEqual({ ok: false, error: "stale" });
    expect(await reg(invoiced.id)).toMatchObject({ discountCents: 3500, discountCode: code.code });
    // P28: a paid invoice with nothing received does not block the removal; one cent received does
    const markedPaid = await mk("d@example.test", {});
    await invoiceOf(markedPaid.id, "paid");
    expect(await removeRegistrationDiscount(db, markedPaid.id)).toEqual({ ok: true });
    const cent = await mk("e@example.test", { paidCents: 1 });
    expect(await removeRegistrationDiscount(db, cent.id)).toEqual({ ok: false, error: "paid" });
  });
});

describe("the new total", () => {
  test("the pay page and the next start charge the new total", async () => {
    const m = stubMontonio();
    // list 400 €: 10 % off = 360 €, its half 180 €; after Eemalda 200 €
    await db.update(courses).set({ priceGroup: 40000 }).where(eq(courses.id, contact.course.id));
    const code = await makeCode();
    const r = await registrationOn(db, contact);
    const start = () => startRegistrationPayment({ db, now: NOW, siteUrl: SITE, notifyBase: SITE, montonio: m.montonio }, { registrationId: r.id });
    const amounts = async () => (await db.select().from(payments).where(eq(payments.registrationId, r.id))).map((p) => p.amountCents).sort((a, b) => a - b);
    await addRegistrationDiscount(db, r.id, code.code, NOW);
    expect(await start()).toMatchObject({ kind: "started" });
    expect(await amounts()).toEqual([18000]);
    await removeRegistrationDiscount(db, r.id);
    // the open order was for the old sum: the next start has a new amount, so it is a new attempt
    expect(await start()).toMatchObject({ kind: "started" });
    expect(await amounts()).toContain(20000);
  });
});
