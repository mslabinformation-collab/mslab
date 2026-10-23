import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { listPaymentsOf, pagePayments, paymentCounts, type PaymentFilter } from "@/db/queries/payments";
import { adminCounts } from "@/db/queries/admin";
import { overviewQueue } from "@/db/queries/overview";
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
  const all = await pagePayments(db, { filter: "all" }, 1);
  expect(all.total).toBe(4);
  expect(all.rows.map((p) => p.id)).toEqual([other.id, e.id, b.id, a.id]);
  expect(all.rows[3]).toMatchObject({ reference: a.reference, kind: "prepayment", courseTitle: { et: "Kulmumeistri baaskoolitus", ru: "Базовый курс бровиста" }, courseSlug: "kulmumeistri-baaskoolitus", startsAt: new Date("2026-11-14T08:00:00Z") });
  expect(all.rows[1]).toMatchObject({ kind: "ecourse", courseTitle: { et: "Kulmumeistri e-koolitus" }, startsAt: null });
  expect((await pagePayments(db, { filter: "kontroll" }, 1)).rows.map((p) => p.id)).toEqual([other.id, b.id]); // (the held one, and the one voided after it was paid: B14)
  expect((await pagePayments(db, { filter: "makstud" }, 1)).rows.map((p) => p.id)).toEqual([e.id]);
  const second = await pagePayments(db, { filter: "all" }, 2, 2);
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

// ---------- B14: the pills of Maksed, the counts and the search (admin UX pass, piece 2, Task 13) ----------

const FILTERS: PaymentFilter[] = ["all", "makstud", "pooleli", "ebaonnestunud", "tagastatud", "kontroll"];

/** One payment of every state there is, each with its own payer, so a search can pick one: Maksed's pills must put each in exactly one place. */
async function everyState() {
  const db = await makeTestDb();
  const c = await contactCourse(db);
  const mk = async (name: string, email: string, minute: number, status: "pending" | "paid" | "failed" | "held" | "refunded" | "replaced", over: { paidAt?: Date | null; providerUuid?: string | null; checkReason?: "double" | null } = {}) => {
    const r = await registrationOn(db, c, { name, email });
    const p = await pendingPayment(db, r, { providerUuid: over.providerUuid }, at(minute));
    await db.update(payments).set({ status, paidAt: over.paidAt ?? null, checkReason: over.checkReason ?? null }).where(eq(payments.id, p.id));
    return p;
  };
  const rows = {
    pending: await mk("Pille Pooleli", "pooleli@example.test", 1, "pending"),
    paid: await mk("Mari Makstud", "makstud@example.test", 2, "paid", { paidAt: at(2), providerUuid: "11111111-aaaa-4bbb-8ccc-000000000001" }),
    // failed and never paid (the bank said no, or the order ran out): „Ebaõnnestunud“
    declined: await mk("Dina Declined", "declined@example.test", 3, "failed"),
    // failed with a pay day: the bank took it back after it was paid, „Tühistatud pangas“ (B14: counted with „Ootel kontrollil“)
    voided: await mk("Vera Voided", "voided@example.test", 4, "failed", { paidAt: at(4), providerUuid: "22222222-aaaa-4bbb-8ccc-000000000002" }),
    held: await mk("Hilda Held", "held@example.test", 5, "held", { paidAt: at(5) }),
    double: await mk("Dora Double", "double@example.test", 6, "held", { paidAt: at(6), checkReason: "double" }),
    refunded: await mk("Reeda Refunded", "refunded@example.test", 7, "refunded", { paidAt: at(7) }),
    // an older open order a newer attempt took the place of (B22): under „Kõik“ only
    replaced: await mk("Rea Replaced", "replaced@example.test", 8, "replaced"),
  };
  return { db, rows };
}

const idsOf = async (db: Awaited<ReturnType<typeof everyState>>["db"], filter: PaymentFilter, search?: string) => (await pagePayments(db, { filter, search }, 1)).rows.map((p) => p.id);

test("B14: a payment voided after it was paid is under „Ootel kontrollil“ (kontroll) and not under „Ebaõnnestunud“; a failed one that was never paid is the other way round", async () => {
  const { db, rows } = await everyState();
  const kontroll = await idsOf(db, "kontroll");
  const failed = await idsOf(db, "ebaonnestunud");
  expect(kontroll).toContain(rows.voided.id);
  expect(failed).not.toContain(rows.voided.id);
  expect(failed).toEqual([rows.declined.id]);
  expect(kontroll).not.toContain(rows.declined.id);
  // newest first by the day it was paid (else started): the held ones and the voided one
  expect(kontroll).toEqual([rows.double.id, rows.held.id, rows.voided.id]);
});

test("B14: each state is under exactly one pill; a replaced order is under „Kõik“ only", async () => {
  const { db, rows } = await everyState();
  const where = new Map<number, PaymentFilter[]>();
  for (const filter of FILTERS.filter((f) => f !== "all"))
    for (const id of await idsOf(db, filter)) where.set(id, [...(where.get(id) ?? []), filter]);
  expect(where.get(rows.pending.id)).toEqual(["pooleli"]);
  expect(where.get(rows.paid.id)).toEqual(["makstud"]);
  expect(where.get(rows.declined.id)).toEqual(["ebaonnestunud"]);
  expect(where.get(rows.voided.id)).toEqual(["kontroll"]);
  expect(where.get(rows.held.id)).toEqual(["kontroll"]);
  expect(where.get(rows.double.id)).toEqual(["kontroll"]);
  expect(where.get(rows.refunded.id)).toEqual(["tagastatud"]);
  expect(where.has(rows.replaced.id)).toBe(false);
  expect(await idsOf(db, "all")).toContain(rows.replaced.id);
  expect((await idsOf(db, "all")).length).toBe(8);
});

test("B14: „Ootel kontrollil“ shows what the overview's „Makse ootel kontrollil“ counts and what the menu badge counts of it", async () => {
  const { db, rows } = await everyState();
  const now = new Date("2026-10-23T09:00:00Z");
  const queue = await overviewQueue(db, now);
  const { paymentsAttention } = await adminCounts(db, "maria@example.test", now);
  const counts = await paymentCounts(db);
  // the overview row opens /admin/maksed?staatus=kontroll: its count is that list's, its rows are that list's (held, with a reason, voided after it was paid)
  expect(queue.check.count).toBe(3);
  expect(counts.kontroll).toBe(queue.check.count);
  expect((await pagePayments(db, { filter: "kontroll" }, 1)).total).toBe(queue.check.count);
  expect(await idsOf(db, "kontroll")).toEqual([rows.double.id, rows.held.id, rows.voided.id]);
  // the menu badge of „Maksed ja arved“ is those, plus the paid ones no invoice names (the Arved tab's „Arveta maksed“)
  expect(queue.unbilled.count).toBe(1);
  expect(paymentsAttention).toBe(counts.kontroll + queue.unbilled.count);
  // a payment voided after it was paid moves the three together
  await db.update(payments).set({ status: "failed", paidAt: at(2) }).where(eq(payments.id, rows.pending.id));
  const after = await paymentCounts(db);
  expect(after.kontroll).toBe(4);
  expect(after.pooleli).toBe(0);
  expect((await overviewQueue(db, now)).check.count).toBe(after.kontroll);
  expect((await adminCounts(db, "maria@example.test", now)).paymentsAttention).toBe(after.kontroll + 1);
});

test("B14: the counts are the rows each pill shows, with and without a search (B9)", async () => {
  const { db } = await everyState();
  expect(await paymentCounts(db)).toEqual({ all: 8, makstud: 1, pooleli: 1, ebaonnestunud: 1, tagastatud: 1, kontroll: 3 });
  for (const search of [undefined, "", "e", "held", "example.test", "11111111", "MSLAB-M", "nothing-like-this"]) {
    const under = await paymentCounts(db, { search });
    for (const filter of FILTERS) {
      const page = await pagePayments(db, { filter, search }, 1);
      expect(under[filter], `${filter} under „${search ?? ""}“`).toBe(page.total);
      expect(page.rows.length, `${filter} under „${search ?? ""}“`).toBe(page.total);
    }
  }
  // a search narrows every pill; the pill chosen does not narrow the others (each count is what that pill would show)
  expect(await paymentCounts(db, { search: "voided" })).toEqual({ all: 1, makstud: 0, pooleli: 0, ebaonnestunud: 0, tagastatud: 0, kontroll: 1 });
});

test("B14: the search finds a payment by the payer's name or e-mail, the Montonio id or Maria's reference — any case, taken literally", async () => {
  const { db, rows } = await everyState();
  expect(await idsOf(db, "all", "vera")).toEqual([rows.voided.id]);
  expect(await idsOf(db, "all", "VERA VOIDED")).toEqual([rows.voided.id]);
  expect(await idsOf(db, "all", "makstud@example")).toEqual([rows.paid.id]);
  // the Montonio uuid, whole or in part
  expect(await idsOf(db, "all", "11111111-aaaa-4bbb-8ccc-000000000001")).toEqual([rows.paid.id]);
  expect(await idsOf(db, "all", "22222222-AAAA")).toEqual([rows.voided.id]);
  expect(await idsOf(db, "all", "  000000000002 ")).toEqual([rows.voided.id]);
  // the reference (MSLAB-M<id>), whole: the row whose reference it is, and no other that merely starts the same way
  expect(await idsOf(db, "all", rows.pending.reference)).toContain(rows.pending.id);
  expect(await idsOf(db, "all", rows.paid.reference)).toContain(rows.paid.id);
  expect((await idsOf(db, "all", rows.paid.reference)).every((id) => id === rows.paid.id || rows.paid.reference.startsWith(`MSLAB-M${id}`))).toBe(true);
  // the search keeps the pill: a voided payment is found under „Ootel kontrollil“, not under „Ebaõnnestunud“
  expect(await idsOf(db, "kontroll", "vera")).toEqual([rows.voided.id]);
  expect(await idsOf(db, "ebaonnestunud", "vera")).toEqual([]);
});

test("B14: % _ and a backslash in the search are letters, not wildcards; Cyrillic matches in either case", async () => {
  const { db, rows } = await everyState();
  const [odd] = await db
    .insert(payments)
    .values({ reference: "MSLAB-M901", kind: "ecourse", courseId: null, email: "a_b@example.test", name: "50% Анна Иванова \\ x", amountCents: 1000, status: "paid", paidAt: at(9), createdAt: at(9) })
    .returning();
  expect(await idsOf(db, "all", "50%")).toEqual([odd.id]);
  expect(await idsOf(db, "all", "%")).toEqual([odd.id]);
  expect(await idsOf(db, "all", "_")).toEqual([odd.id]); // a_b@example.test: an underscore, not "any one letter"
  expect(await idsOf(db, "all", "\\")).toEqual([odd.id]);
  expect(await idsOf(db, "all", "АННА")).toEqual([odd.id]);
  expect(await idsOf(db, "all", "иванова")).toEqual([odd.id]);
  expect(await idsOf(db, "all", "a_b@")).toEqual([odd.id]);
  expect(await idsOf(db, "all", "a%b")).toEqual([]);
  expect(await idsOf(db, "all", "vera")).toEqual([rows.voided.id]);
});
