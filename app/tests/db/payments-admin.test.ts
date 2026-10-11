import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { listPaymentsOf, pagePayments } from "@/db/queries/payments";
import { clients, courses, payments, registrations } from "@/db/schema";
import { needsCheck } from "@/domain/payments";
import { clientDetail } from "@/server/admin-clients";
import { contactCourse, pendingPayment, registrationOn } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// The admin's view of the payments (phase 2b, spec 8): "Maksed" newest first with its status filter and pages, the payments of one
// registration and of one student (hers, and her registrations' made before she had an account), and the rows Maria must check in Montonio.

const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 10, minute));

async function fixture() {
  const db = await makeTestDb();
  const c = await contactCourse(db);
  const [ecourse] = await db
    .insert(courses)
    .values({ slug: "kulmumeistri-e-koolitus", type: "e_learning", level: "basic", title: { et: "Kulmumeistri e-koolitus" }, summary: { et: "" }, body: { et: "" }, price: 19000 })
    .returning();
  const [kati] = await db.insert(clients).values({ email: "kati@example.com" }).returning();
  const r = await registrationOn(db, c); // before she had an account: no client_id
  const a = await pendingPayment(db, r, {}, at(1));
  const b = await pendingPayment(db, r, { kind: "balance" }, at(2));
  const [e] = await db
    .insert(payments)
    .values({ reference: "MSLAB-M900", kind: "ecourse", courseId: ecourse.id, clientId: kati.id, email: "kati@example.com", name: "Kati Tamm", amountCents: 19000, status: "paid", paidAt: at(3), createdAt: at(3) })
    .returning();
  const other = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com", name: "Teine" }), {}, at(4));
  await db.update(payments).set({ status: "held" }).where(eq(payments.id, b.id));
  await db.update(payments).set({ status: "failed", paidAt: at(5) }).where(eq(payments.id, other.id)); // voided after paid
  await db.update(registrations).set({ clientId: kati.id }).where(eq(registrations.id, r.id)); // her later login linked the registration
  return { db, c, r, a, b, e, other, kati };
}

test("pagePayments: newest first with the course, the session's day and the kind; the status filter; 50 a page (2 here)", async () => {
  const { db, a, b, e, other } = await fixture();
  const all = await pagePayments(db, "all", 1);
  expect(all.total).toBe(4);
  expect(all.rows.map((p) => p.id)).toEqual([other.id, e.id, b.id, a.id]);
  expect(all.rows[3]).toMatchObject({ reference: a.reference, kind: "prepayment", courseTitle: { et: "Kulmumeistri baaskoolitus", ru: "Базовый курс бровиста" }, courseSlug: "kulmumeistri-baaskoolitus", startsAt: new Date("2026-11-14T08:00:00Z") });
  expect(all.rows[1]).toMatchObject({ kind: "ecourse", courseTitle: { et: "Kulmumeistri e-koolitus" }, startsAt: null });
  expect((await pagePayments(db, "held", 1)).rows.map((p) => p.id)).toEqual([b.id]);
  expect((await pagePayments(db, "paid", 1)).rows.map((p) => p.id)).toEqual([e.id]);
  const second = await pagePayments(db, "all", 2, 2);
  expect([second.page, second.pages, second.rows.map((p) => p.id)]).toEqual([2, 2, [b.id, a.id]]);
});

test("one registration's payments; one student's: her own and her registrations' (paid before she had an account)", async () => {
  const { db, r, a, b, e, kati } = await fixture();
  expect((await listPaymentsOf(db, { registrationId: r.id })).map((p) => p.id)).toEqual([b.id, a.id]);
  expect((await listPaymentsOf(db, { clientId: kati.id })).map((p) => p.id)).toEqual([e.id, b.id, a.id]);
  expect((await clientDetail(db, kati.id))!.payments.map((p) => p.id)).toEqual([e.id, b.id, a.id]);
});

test("'Kontrolli Montonios': held, and failed after it was paid (voided); not a plain failure", () => {
  expect(needsCheck({ status: "held", paidAt: null })).toBe(true);
  expect(needsCheck({ status: "failed", paidAt: at(1) })).toBe(true);
  expect(needsCheck({ status: "failed", paidAt: null })).toBe(false);
  for (const status of ["pending", "paid", "refunded"] as const) expect(needsCheck({ status, paidAt: at(1) })).toBe(false);
});
