import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { addRegistrationPayment, setSetting } from "@/db/queries/admin";
import { insertPayment } from "@/db/queries/payments";
import { readSetting } from "@/db/queries/public";
import { lockForPayment } from "@/db/queries/seats";
import * as schema from "@/db/schema";
import { clients, courses, invoices, payments, registrations, type Invoice, type Payment, type Registration } from "@/db/schema";
import { tallinnDateText } from "@/domain/certificate";
import { renderInvoice } from "@/server/invoice-pdf";
import { addManualPayment } from "@/server/registration-money";
import {
  cancelInvoice, catchUpInvoice, createInvoice, getInvoiceSettings, invoiceCard, invoiceForAdmin, invoiceForPaidPayment, invoiceForStudent, invoicePdf,
  invoicesCsv, invoicesOfClient, invoicesOfRegistration, listInvoices, markInvoicePaid, markLinkedInvoicePaid, saveInvoiceSettings, uninvoicedPayments,
  undoInvoicePaid, updateInvoiceBuyer,
} from "@/server/invoices";
import { makeTestDb } from "./helpers";
import { contactCourse, pendingPayment, registrationOn } from "./payments-fixtures";

// The invoices' server (invoices, Task 3; spec D2–D9, §6) against a real (PGlite) database: Seaded → Arve andmed (the save under the number
// series' lock, the prefix's own series, R3's reset), Maria's invoice on a registration (a request to pay or a receipt), „Märgi tasutuks" (the
// amount added once, under the registration's locks), its undo, the cancel, the buyer's editor, a paid payment's invoice (born paid, or the
// linked unpaid one paid) and the catch-up of one paid without, the student's and Maria's reads, the list, the month's CSV, and the PDF. The lock
// order of every write is read off drizzle's query log, as the certificate's tests do. The renderer is the real one, wrapped.

vi.mock("@/server/invoice-pdf", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/invoice-pdf")>();
  return { ...real, renderInvoice: vi.fn(real.renderInvoice) };
});

/** 16.10.2026 12:00 in Tallinn (summer time, UTC+3). */
const NOW = new Date("2026-10-16T09:00:00Z");
const DAY = 86_400_000;
const PAID_AT = new Date("2026-10-15T08:00:00Z");
const SELLER = { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu" };
/** A save of Seaded → Arve andmed that passes: the seller, VAT off, MSL from 1 in 2026, a week to pay. */
const VALID = { ...SELLER, vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: 2026, nextSeq: 1, termDays: 7, footer: "" };
/** Seaded → Ettemaksu juhised. */
const BANK = { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  vi.mocked(renderInvoice).mockClear();
  for (const method of ["info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

type LogEntry = { query: string; params: unknown[] };
/** A fresh migrated database that records every query it runs (drizzle's logger); it replaces `db`, which the helpers below write through. */
async function useLoggedDb(): Promise<LogEntry[]> {
  const log: LogEntry[] = [];
  const logged: Db = drizzle(new PGlite(), { schema, logger: { logQuery: (query: string, params: unknown[]) => void log.push({ query, params }) } });
  await migrate(logged, { migrationsFolder: "./drizzle" });
  db = logged;
  log.length = 0;
  return log;
}
/** Where in a query log each lock is taken, the series' highest seq read, the invoice setting read and written, and the invoice written. */
const at = (log: LogEntry[]) => ({
  sessionLock: log.findIndex((e) => /^select 1 from course_sessions [\s\S]*for update/.test(e.query)),
  registrationLock: log.findIndex((e) => /^select 1 from registrations where id = [\s\S]*for update/.test(e.query)),
  invoiceLock: log.findIndex((e) => /from "invoices"[\s\S]*for update/.test(e.query)),
  paymentLock: log.findIndex((e) => /from "payments"[\s\S]*for update/.test(e.query)),
  numberLock: log.findIndex((e) => /pg_advisory_xact_lock\(hashtext\(/.test(e.query) && e.params.includes("invoice-number")),
  maxSeq: log.findIndex((e) => /max\("invoices"."seq"\)|max\("seq"\)/.test(e.query)),
  settingRead: log.findIndex((e) => /^select .* from "settings"/.test(e.query) && e.params.includes("invoice")),
  written: log.findIndex((e) => /^insert into "invoices"/.test(e.query)),
  settingWrite: log.findIndex((e) => /^insert into "settings"/.test(e.query) && e.params.includes("invoice")),
  paidSumWrite: log.findIndex((e) => /^update "registrations"/.test(e.query)),
  invoiceWrite: log.findIndex((e) => /^update "invoices"/.test(e.query)),
});

const infoLog = () => vi.mocked(console.info).mock.calls.flat().join("\n");
const stored = () => readSetting(db, "invoice");
const allInvoices = () => db.select().from(invoices).orderBy(invoices.id);
const registration = async (id: number) => (await db.select().from(registrations).where(eq(registrations.id, id)))[0];

/** Seaded's seller card and the bank details filled in (`over` changes the card). */
async function ready(over: Partial<typeof VALID> = {}) {
  await setSetting(db, "invoice", { ...VALID, ...over });
  await setSetting(db, "prepayment", BANK);
}

/** Maria's request to pay (Maksmiseks) of `kind` on `r`, which must be made. */
async function request(r: Registration, kind: "prepayment" | "full" | "balance" = "prepayment", now = NOW): Promise<Invoice> {
  const result = await createInvoice(db, r.id, { kind, mode: "request" }, now);
  if (!result.ok) throw new Error(`request: ${result.error}`);
  return result.invoice;
}

/** What settle.ts paid() does with `p` inside its transaction (Task 4): the locks, the paid update, the amount added; then the invoice. */
async function settle(p: Payment, paidAt = PAID_AT): Promise<Invoice | null> {
  return db.transaction(async (tx) => {
    if (p.registrationId !== null) await lockForPayment(tx, p.registrationId);
    const [paid] = await tx.update(payments).set({ status: "paid", paidAt, updatedAt: paidAt }).where(eq(payments.id, p.id)).returning();
    if (paid.registrationId !== null) await addRegistrationPayment(tx, paid.registrationId, paid.amountCents, paidAt);
    return invoiceForPaidPayment(tx, paid, NOW);
  });
}

/** An e-course, Kulmude e-kursus (95 €), and its pending purchase by a new client. */
async function ecoursePurchase(email = "mari@example.com") {
  const [course] = await db
    .insert(courses)
    .values({ slug: "kulmud-e", type: "e_learning", level: "basic", title: { et: "Kulmude e-kursus", ru: "Онлайн-курс бровей" }, summary: { et: "" }, body: { et: "" }, price: 9500, published: true })
    .onConflictDoNothing()
    .returning();
  const courseId = course?.id ?? (await db.select().from(courses).where(eq(courses.slug, "kulmud-e")))[0].id;
  const [client] = await db.insert(clients).values({ email, name: "Mari Maasikas" }).returning();
  const payment = await insertPayment(db, { kind: "ecourse", registrationId: null, courseId, clientId: client.id, email, name: "Mari Maasikas", locale: "et", amountCents: 9500 }, NOW, "MSLAB-M");
  return { client, payment, courseId };
}

describe("Seaded → Arve andmed: getInvoiceSettings, saveInvoiceSettings, invoiceCard (D2, D7)", () => {
  test("nothing stored: the defaults, this Tallinn year and number 1", async () => {
    expect(await getInvoiceSettings(db, NOW)).toEqual({
      company: "", registryCode: "", address: "", vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: 2026, nextSeq: 1, termDays: 7, footer: "",
    });
  });

  test("the round trip: texts on one line and trimmed, numbers from the form's text, VAT on with its number; what the save stores the read keeps", async () => {
    const raw = { company: "  MS LAB   OÜ ", registryCode: " 16346048", address: "Rüütli 1,\n80010 Pärnu", vatNumber: "EE102345678", vatOn: true, vatRate: "22", prefix: " ABC1 ", nextSeq: "5", termDays: "0", footer: " Täname! " };
    const result = await saveInvoiceSettings(db, raw, NOW);
    const settings = { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu", vatNumber: "EE102345678", vatOn: true, vatRate: 22, prefix: "ABC1", nextYear: 2026, nextSeq: 5, termDays: 0, footer: "Täname!" };
    expect(result).toEqual({ ok: true, settings });
    expect(await stored()).toEqual(settings);
    expect(await getInvoiceSettings(db, NOW)).toEqual(settings);
    // the form's checkbox ("on") and VAT off with a number kept
    expect(await saveInvoiceSettings(db, { ...VALID, vatOn: "on", vatNumber: "EE102345678" }, NOW)).toMatchObject({ ok: true, settings: { vatOn: true } });
    expect(await saveInvoiceSettings(db, { ...VALID, vatNumber: "EE102345678" }, NOW)).toMatchObject({ ok: true, settings: { vatOn: false, vatNumber: "EE102345678" } });
    // the limits themselves pass, and the read keeps them
    const longest = { ...VALID, company: "C".repeat(120), registryCode: "1".repeat(20), address: "A".repeat(200), vatNumber: "V".repeat(20), footer: "F".repeat(300), vatRate: 50, termDays: 90, nextSeq: 2_147_483_647 };
    const saved = await saveInvoiceSettings(db, longest, NOW);
    expect(saved).toMatchObject({ ok: true, settings: { nextSeq: 2_147_483_647, vatRate: 50, termDays: 90 } });
    expect(await getInvoiceSettings(db, NOW)).toEqual(saved.ok ? saved.settings : null);
    const tenLetters = await saveInvoiceSettings(db, { ...VALID, prefix: "ABCDEFGHIJ", vatRate: 1 }, NOW);
    expect(tenLetters).toMatchObject({ ok: true, settings: { prefix: "ABCDEFGHIJ", vatRate: 1 } });
    expect(await getInvoiceSettings(db, NOW)).toEqual(tenLetters.ok ? tenLetters.settings : null);
  });

  test("the refusals: VAT on without a VAT number, a bad prefix, a missing seller field, over-long texts, numbers out of range — nothing is stored", async () => {
    const refused = async (over: Record<string, unknown>) => {
      const result = await saveInvoiceSettings(db, { ...VALID, ...over }, NOW);
      expect(result.ok, JSON.stringify(over)).toBe(false);
      return result.ok ? {} : result.fields;
    };
    expect(await refused({ vatOn: true, vatNumber: "  " })).toEqual({ vatNumber: "required" });
    expect(await refused({ prefix: "MS-L" })).toEqual({ prefix: "invalid" });
    expect(await refused({ prefix: "MSLÄ" })).toEqual({ prefix: "invalid" });
    expect(await refused({ prefix: "MS L" })).toEqual({ prefix: "invalid" });
    expect(await refused({ prefix: "" })).toEqual({ prefix: "required" });
    expect(await refused({ prefix: "ABCDEFGHIJK" })).toEqual({ prefix: "tooLong" });
    expect(await refused({ company: " ", registryCode: "", address: undefined })).toEqual({ company: "required", registryCode: "required", address: "required" });
    expect(await refused({ company: "C".repeat(121), registryCode: "1".repeat(21), address: "A".repeat(201), vatNumber: "V".repeat(21), footer: "F".repeat(301) })).toEqual({
      company: "tooLong", registryCode: "tooLong", address: "tooLong", vatNumber: "tooLong", footer: "tooLong",
    });
    for (const vatRate of [0, 51, 24.5, "abc", "", null]) expect(await refused({ vatRate }), String(vatRate)).toEqual({ vatRate: "invalid" });
    for (const termDays of [-1, 91, 1.5, "x"]) expect(await refused({ termDays }), String(termDays)).toEqual({ termDays: "invalid" });
    for (const nextSeq of [0, -1, 2_147_483_648, "12345678901", 1.5, null]) expect(await refused({ nextSeq }), String(nextSeq)).toEqual({ nextSeq: "invalid" });
    expect(await saveInvoiceSettings(db, "nonsense", NOW)).toMatchObject({ ok: false });
    expect(await stored()).toBeNull();
  });

  test("'taken': a next number at or below one already issued in that prefix and year is refused under the lock; above it passes", async () => {
    const c = await contactCourse(db);
    await ready();
    await request(await registrationOn(db, c, { email: "a@example.com" }));
    await request(await registrationOn(db, c, { email: "b@example.com" }));
    expect(await saveInvoiceSettings(db, { ...VALID, nextSeq: 2 }, NOW)).toEqual({ ok: false, fields: { nextSeq: "taken" } });
    expect(await stored()).toMatchObject({ nextSeq: 3 });
    expect(await saveInvoiceSettings(db, { ...VALID, nextSeq: 10 }, NOW)).toMatchObject({ ok: true, settings: { nextSeq: 10 } });
  });

  test("invoiceCard: the next number as the next issue takes it (never at or below the series' highest), and the last one issued", async () => {
    const c = await contactCourse(db);
    expect(await invoiceCard(db, NOW)).toMatchObject({ prefix: "MSL", nextYear: 2026, nextSeq: 1, last: null });
    await ready();
    await request(await registrationOn(db, c, { email: "a@example.com" }));
    await request(await registrationOn(db, c, { email: "b@example.com" }));
    // the stored number pushed back below the series' highest: the card shows what an issue would take
    await setSetting(db, "invoice", { ...VALID, nextSeq: 1 });
    expect(await invoiceCard(db, NOW)).toEqual({ ...VALID, nextSeq: 3, last: "MSL2026-002" });
  });

  test("B21: the year is never typed — a sent nextYear is ignored and this Tallinn year is stored", async () => {
    const now = new Date("2026-11-30T12:00:00Z");
    const r = await saveInvoiceSettings(db, { ...VALID, nextYear: "2027", nextSeq: "5" }, now);
    expect(r.ok).toBe(true);
    expect(await stored()).toMatchObject({ nextYear: 2026, nextSeq: 5 });
    // the year edge is Tallinn's: at 23:30 UTC on 31.12 it is already 1.1.2027 there
    expect(await saveInvoiceSettings(db, { ...VALID, nextYear: "2026", nextSeq: "1" }, new Date("2026-12-31T22:30:00Z"))).toMatchObject({ ok: true, settings: { nextYear: 2027, nextSeq: 1 } });
    // no year at all is no refusal either (the field is gone from the card)
    const withoutYear: Record<string, unknown> = { ...VALID };
    delete withoutYear.nextYear;
    expect(await saveInvoiceSettings(db, { ...withoutYear, nextSeq: "9" }, now)).toMatchObject({ ok: true, settings: { nextYear: 2026, nextSeq: 9 } });
  });

  test("B21: 'taken' is checked against this Tallinn year's series, whatever year was sent", async () => {
    const c = await contactCourse(db);
    await ready();
    await request(await registrationOn(db, c, { email: "a@example.com" }));
    expect(await saveInvoiceSettings(db, { ...VALID, nextYear: 2027, nextSeq: 1 }, NOW)).toEqual({ ok: false, fields: { nextSeq: "taken" } });
    expect(await saveInvoiceSettings(db, { ...VALID, nextYear: 2027, nextSeq: 2 }, NOW)).toMatchObject({ ok: true, settings: { nextYear: 2026, nextSeq: 2 } });
  });

  test("B21: the card always shows this year's counter, even over an old next-year preset", async () => {
    await setSetting(db, "invoice", { ...VALID, nextYear: 2027, nextSeq: 40 });
    const card = await invoiceCard(db, new Date("2026-11-10T12:00:00Z"));
    expect(card).toMatchObject({ nextYear: 2026, nextSeq: 1, last: null });
  });

  test("R3, Review Focus 5: a prefix change starts the new prefix at 001, and back to the old one continues its own series; no number twice", async () => {
    const c = await contactCourse(db);
    await ready();
    expect((await request(await registrationOn(db, c, { email: "a@example.com" }))).number).toBe("MSL2026-001");
    expect((await request(await registrationOn(db, c, { email: "b@example.com" }))).number).toBe("MSL2026-002");
    // Maria types the new prefix and keeps the number the card shows (3): the new prefix's series starts at 1
    const card = await invoiceCard(db, NOW);
    expect(card.nextSeq).toBe(3);
    expect(await saveInvoiceSettings(db, { ...VALID, prefix: "ABC", nextSeq: card.nextSeq }, NOW)).toMatchObject({ ok: true, settings: { prefix: "ABC", nextSeq: 1 } });
    expect((await request(await registrationOn(db, c, { email: "c@example.com" }))).number).toBe("ABC2026-001");
    // and back: MSL's own series goes on from its highest (2), not from ABC's count
    expect((await invoiceCard(db, NOW)).nextSeq).toBe(2);
    expect(await saveInvoiceSettings(db, { ...VALID, prefix: "MSL", nextSeq: 2 }, NOW)).toMatchObject({ ok: true, settings: { prefix: "MSL", nextSeq: 1 } });
    expect((await invoiceCard(db, NOW)).nextSeq).toBe(3);
    expect((await request(await registrationOn(db, c, { email: "d@example.com" }))).number).toBe("MSL2026-003");
    const numbers = (await allInvoices()).map((i) => i.number);
    expect(numbers).toEqual(["MSL2026-001", "MSL2026-002", "ABC2026-001", "MSL2026-003"]);
    expect(new Set(numbers).size).toBe(4);
    // the very first save has no stored prefix to change: its number is kept
    db = await makeTestDb();
    expect(await saveInvoiceSettings(db, { ...VALID, prefix: "XYZ", nextSeq: 50 }, NOW)).toMatchObject({ ok: true, settings: { prefix: "XYZ", nextSeq: 50 } });
  });

  test("the prefix is stored in capitals: „msl“ is MSL's own series (no reset, no second MSL2026-001 as msl2026-001), „abc“ a new one", async () => {
    const c = await contactCourse(db);
    expect(await saveInvoiceSettings(db, { ...VALID, prefix: " msl " }, NOW)).toMatchObject({ ok: true, settings: { prefix: "MSL" } });
    await setSetting(db, "prepayment", BANK);
    expect((await request(await registrationOn(db, c, { email: "a@example.com" }))).number).toBe("MSL2026-001");
    // the same series whatever its case: the number is checked against it (taken) and kept, not reset
    expect(await saveInvoiceSettings(db, { ...VALID, prefix: "msl", nextSeq: 1 }, NOW)).toEqual({ ok: false, fields: { nextSeq: "taken" } });
    expect(await saveInvoiceSettings(db, { ...VALID, prefix: "Msl", nextSeq: 7 }, NOW)).toMatchObject({ ok: true, settings: { prefix: "MSL", nextSeq: 7 } });
    expect((await request(await registrationOn(db, c, { email: "b@example.com" }))).number).toBe("MSL2026-007");
    expect(await saveInvoiceSettings(db, { ...VALID, prefix: "abc1", nextSeq: 8 }, NOW)).toMatchObject({ ok: true, settings: { prefix: "ABC1", nextSeq: 1 } });
    expect((await request(await registrationOn(db, c, { email: "d@example.com" }))).number).toBe("ABC12026-001");
    expect((await allInvoices()).map((i) => i.prefix)).toEqual(["MSL", "MSL", "ABC1"]);
  });

  test("Review Focus 1: the save takes the number lock before it reads the setting and the series' highest, and before it writes; a refused field touches nothing", async () => {
    const log = await useLoggedDb();
    expect((await saveInvoiceSettings(db, VALID, NOW)).ok).toBe(true);
    const p = at(log);
    expect(p.numberLock).toBeGreaterThanOrEqual(0);
    expect([p.numberLock < p.settingRead, p.numberLock < p.maxSeq, p.maxSeq < p.settingWrite]).toEqual([true, true, true]);
    log.length = 0;
    expect((await saveInvoiceSettings(db, { ...VALID, prefix: "" }, NOW)).ok).toBe(false);
    expect(log).toEqual([]);
  });
});

describe("createInvoice: Maria's invoice on a registration (D5)", () => {
  test("a request to pay on a half registration: MSL2026-001, unpaid, due in 7 days, the bank details and the reference frozen; nothing paid; the series moves on", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    await ready();
    const inv = await request(r);
    expect(inv).toMatchObject({
      number: "MSL2026-001", prefix: "MSL", year: 2026, seq: 1, kind: "prepayment", registrationId: r.id, paymentId: null, courseId: c.course.id, clientId: null,
      status: "unpaid", amountCents: 17500, vatRate: null,
      line: { course: "Kulmumeistri baaskoolitus", session: "14.11.2026 Pärnu", part: "Ettemaks 50%" },
      seller: { ...SELLER, vatNumber: "", receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank" },
      buyer: { name: "Kati Tamm", email: "kati@example.com", address: "", company: "", companyCode: "", companyAddress: "" },
      reference: `MSLAB-${r.id}`, issuedAt: NOW, dueAt: new Date(NOW.getTime() + 7 * DAY), paidAt: null, paidMethod: null, paidAdds: false, cancelledAt: null,
    });
    expect(tallinnDateText(inv.dueAt!)).toBe("23.10.2026");
    expect(await registration(r.id)).toMatchObject({ paidCents: 0, status: "awaiting_prepayment" });
    expect(await stored()).toMatchObject({ nextYear: 2026, nextSeq: 2 });
    expect(infoLog()).toContain(`[invoices] registration ${r.id}: issued MSL2026-001`);
    expect(infoLog()).not.toMatch(/Kati|kati@/);
  });

  test("open amounts only: a second prepayment, or the whole sum after it, is notOpen; the rest is open; a whole-sum registration is offered the whole sum alone", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    await ready();
    await request(r);
    expect(await createInvoice(db, r.id, { kind: "prepayment", mode: "request" }, NOW)).toEqual({ ok: false, error: "notOpen" });
    expect(await createInvoice(db, r.id, { kind: "full", mode: "request" }, NOW)).toEqual({ ok: false, error: "notOpen" });
    expect(await request(r, "balance")).toMatchObject({ number: "MSL2026-002", kind: "balance", amountCents: 17500, line: { part: "Jääk 50%" } });
    expect(await createInvoice(db, r.id, { kind: "balance", mode: "request" }, NOW)).toEqual({ ok: false, error: "notOpen" });
    const whole = await registrationOn(db, c, { email: "t@example.com", paymentChoice: "full" });
    expect(await createInvoice(db, whole.id, { kind: "prepayment", mode: "request" }, NOW)).toEqual({ ok: false, error: "notOpen" });
    expect(await request(whole, "full")).toMatchObject({ kind: "full", amountCents: 35000, line: { part: "Kogu summa (100%)" } });
  });

  test("the refusals: an unknown registration, an invalid input, no seller (D3), and for a request no bank account (R6) — nothing written, the series unmoved", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    expect(await createInvoice(db, 999_999, { kind: "prepayment", mode: "request" }, NOW)).toEqual({ ok: false, error: "notFound" });
    for (const input of [
      { kind: "other", mode: "request" },
      { kind: "prepayment", mode: "other" },
      { kind: "prepayment", mode: "receipt" },
      { kind: "prepayment", mode: "receipt", paidAt: PAID_AT },
      { kind: "prepayment", mode: "receipt", method: "bank" },
      { kind: "prepayment", mode: "receipt", paidAt: new Date("nope"), method: "bank" },
      { kind: "prepayment", mode: "receipt", paidAt: PAID_AT, method: "montonio" },
    ]) expect(await createInvoice(db, r.id, input as never, NOW), JSON.stringify(input)).toEqual({ ok: false, error: "invalid" });
    // no seller: the card is empty, or a field of the three is missing
    expect(await createInvoice(db, r.id, { kind: "prepayment", mode: "request" }, NOW)).toEqual({ ok: false, error: "sellerMissing" });
    await setSetting(db, "invoice", { ...VALID, address: "" });
    await setSetting(db, "prepayment", BANK);
    expect(await createInvoice(db, r.id, { kind: "prepayment", mode: "receipt", paidAt: PAID_AT, method: "cash" }, NOW)).toEqual({ ok: false, error: "sellerMissing" });
    // the seller, but no receiver or no IBAN: a request is refused, a receipt is made
    await setSetting(db, "invoice", VALID);
    await setSetting(db, "prepayment", { ...BANK, iban: " " });
    expect(await createInvoice(db, r.id, { kind: "prepayment", mode: "request" }, NOW)).toEqual({ ok: false, error: "bankMissing" });
    await setSetting(db, "prepayment", { ...BANK, receiver: "" });
    expect(await createInvoice(db, r.id, { kind: "prepayment", mode: "request" }, NOW)).toEqual({ ok: false, error: "bankMissing" });
    expect(await allInvoices()).toEqual([]);
    expect(await stored()).toEqual(VALID);
    await db.delete(schema.settings).where(eq(schema.settings.key, "prepayment"));
    expect(await createInvoice(db, r.id, { kind: "prepayment", mode: "request" }, NOW)).toEqual({ ok: false, error: "bankMissing" });
    const receipt = await createInvoice(db, r.id, { kind: "prepayment", mode: "receipt", paidAt: PAID_AT, method: "cash" }, NOW);
    expect(receipt).toMatchObject({ ok: true, invoice: { status: "paid", seller: { ...SELLER, receiver: "", iban: "", bank: "" } } });
  });

  test("VAT on: the rate and the seller's VAT number frozen on the invoice; a later change of the card leaves it as it was", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    await ready({ vatOn: true, vatNumber: "EE102345678", vatRate: 24 });
    const inv = await request(r);
    expect(inv).toMatchObject({ vatRate: 24, seller: { vatNumber: "EE102345678" } });
    await ready({ company: "Uus OÜ", vatOn: false });
    expect(await invoiceForAdmin(db, inv.id)).toMatchObject({ vatRate: 24, seller: { company: "MS LAB OÜ", vatNumber: "EE102345678" } });
  });

  test("the due date is the term's days later on Tallinn's calendar, across the change to winter time too", async () => {
    const c = await contactCourse(db);
    await ready();
    // 21.10.2026 00:30 in Tallinn (summer time); 7 days later is 28.10 00:30, winter time (25.10 the clocks went back)
    const night = new Date("2026-10-20T21:30:00Z");
    const inv = await request(await registrationOn(db, c), "prepayment", night);
    expect(inv.dueAt).toEqual(new Date("2026-10-27T22:30:00Z"));
    expect(tallinnDateText(inv.dueAt!)).toBe("28.10.2026");
    await ready({ termDays: 0 });
    expect((await request(await registrationOn(db, c, { email: "b@example.com" }))).dueAt).toEqual(NOW);
  });

  test("Review Focus 2: a receipt (Juba tasutud) for money already in Laekunud summa is born paid and leaves paid_cents and the status as they were", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c, { paidCents: 17500, status: "confirmed" });
    await ready();
    const result = await createInvoice(db, r.id, { kind: "prepayment", mode: "receipt", paidAt: PAID_AT, method: "bank" }, NOW);
    expect(result).toMatchObject({
      ok: true,
      invoice: { number: "MSL2026-001", status: "paid", paidAt: PAID_AT, paidMethod: "bank", paidAdds: false, dueAt: null, reference: "", amountCents: 17500, issuedAt: NOW },
    });
    expect(await registration(r.id)).toMatchObject({ paidCents: 17500, status: "confirmed" });
  });
});

describe("markInvoicePaid: „Märgi tasutuks“ adds the amount (§6.4)", () => {
  test("the amount is added to Laekunud summa and the registration confirms at 50%; the invoice is paid with the date and the way; a second mark is notUnpaid", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c, { seatHoldUntil: new Date(NOW.getTime() + 60_000) });
    await ready();
    const inv = await request(r);
    const result = await markInvoicePaid(db, inv.id, { paidAt: PAID_AT, method: "bank" }, NOW);
    expect(result).toEqual({ ok: true, invoice: expect.objectContaining({ id: inv.id, status: "paid", paidAt: PAID_AT, paidMethod: "bank", paidAdds: true }) });
    expect(await registration(r.id)).toMatchObject({ paidCents: 17500, status: "confirmed", seatHoldUntil: null });
    expect(await markInvoicePaid(db, inv.id, { paidAt: PAID_AT, method: "cash" }, NOW)).toEqual({ ok: false, error: "notUnpaid" });
    expect(await markInvoicePaid(db, 999_999, { paidAt: PAID_AT, method: "cash" }, NOW)).toEqual({ ok: false, error: "notFound" });
    expect(await registration(r.id)).toMatchObject({ paidCents: 17500 });
    expect(infoLog()).toContain(`[invoices] invoice ${inv.id}: marked paid`);
  });

  // PGlite runs one transaction at a time, so this race cannot fail here: the locks it relies on are proven by the query log ("the order of the
  // locks" below: lockForPayment, then the invoice FOR UPDATE, before the paid sum and the invoice are written). Task 7 races on real Postgres.
  test("Review Focus 1: two marks at the same moment — one is ok, the other notUnpaid, and the amount is added once", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    await ready();
    const inv = await request(r);
    const both = await Promise.all([
      markInvoicePaid(db, inv.id, { paidAt: PAID_AT, method: "bank" }, NOW),
      markInvoicePaid(db, inv.id, { paidAt: PAID_AT, method: "cash" }, NOW),
    ]);
    expect(both.map((x) => (x.ok ? "ok" : x.error)).sort()).toEqual(["notUnpaid", "ok"]);
    expect(await registration(r.id)).toMatchObject({ paidCents: 17500, status: "confirmed" });
  });

  test("a full session: the invoice is paid and the amount added, but the registration stays unconfirmed (full: true), as the online path does", async () => {
    const c = await contactCourse(db, { capacity: 1 });
    await registrationOn(db, c, { email: "first@example.com", status: "confirmed", paidCents: 17500 });
    const r = await registrationOn(db, c);
    await ready();
    const inv = await request(r);
    expect(await markInvoicePaid(db, inv.id, { paidAt: PAID_AT, method: "card" }, NOW)).toEqual({ ok: true, invoice: expect.objectContaining({ status: "paid" }), full: true });
    expect(await registration(r.id)).toMatchObject({ paidCents: 17500, status: "awaiting_prepayment" });
  });

  test("R11: an odd price — „Ettemaks 50%“ is the site's own prepayment (rounded up), so once paid it confirms at 50 %; the rest is what is left", async () => {
    const c = await contactCourse(db);
    await db.update(courses).set({ priceGroup: 35001 }).where(eq(courses.id, c.course.id));
    const r = await registrationOn(db, c);
    await ready();
    const inv = await request(r);
    expect(inv.amountCents).toBe(17501);
    expect((await markInvoicePaid(db, inv.id, { paidAt: PAID_AT, method: "bank" }, NOW)).ok).toBe(true);
    expect(await registration(r.id)).toMatchObject({ paidCents: 17501, status: "confirmed" });
    expect((await request(r, "balance")).amountCents).toBe(17500);
  });

  test("the date and the way are checked: a date that is no date or after today (Tallinn), a way that is not bank, cash or card — invalid, nothing changed", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    await ready();
    const inv = await request(r);
    // NOW is 16.10.2026 12:00 in Tallinn: its last minute is 23:59 (20:59 UTC), the next day begins at 21:00 UTC
    for (const input of [
      { paidAt: new Date("nope"), method: "bank" },
      { paidAt: new Date("2026-10-16T21:00:00Z"), method: "bank" },
      { paidAt: PAID_AT, method: "montonio" },
      { paidAt: PAID_AT, method: "cheque" },
      { paidAt: "2026-10-15", method: "bank" },
    ]) expect(await markInvoicePaid(db, inv.id, input as never, NOW), JSON.stringify(input)).toEqual({ ok: false, error: "invalid" });
    expect(await invoiceForAdmin(db, inv.id)).toMatchObject({ status: "unpaid", paidAt: null });
    expect(await registration(r.id)).toMatchObject({ paidCents: 0 });
    // the receipt's date is held to the same day
    expect(await createInvoice(db, r.id, { kind: "balance", mode: "receipt", paidAt: new Date("2026-10-16T21:00:00Z"), method: "cash" }, NOW)).toEqual({ ok: false, error: "invalid" });
    // later today is today
    const tonight = new Date("2026-10-16T20:59:00Z");
    expect(await markInvoicePaid(db, inv.id, { paidAt: tonight, method: "cash" }, NOW)).toMatchObject({ ok: true, invoice: { paidAt: tonight } });
  });
});

describe("undoInvoicePaid: „Võta tasumine tagasi“ (D6)", () => {
  test("a mark that added the amount: the amount is taken back and the place with it (below 50%); the invoice is unpaid again with its due date", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    await ready();
    const inv = await request(r);
    await markInvoicePaid(db, inv.id, { paidAt: PAID_AT, method: "bank" }, NOW);
    const result = await undoInvoicePaid(db, inv.id, NOW);
    expect(result).toEqual({ ok: true, invoice: expect.objectContaining({ id: inv.id, status: "unpaid", paidAt: null, paidMethod: null, paidAdds: false, dueAt: inv.dueAt }) });
    expect(await registration(r.id)).toMatchObject({ paidCents: 0, status: "awaiting_prepayment" });
    expect(await undoInvoicePaid(db, inv.id, NOW)).toEqual({ ok: false, error: "notPaid" });
    expect(await undoInvoicePaid(db, 999_999, NOW)).toEqual({ ok: false, error: "notFound" });
  });

  test("the place stays when the payments rule allows it: the rest's mark undone leaves the half paid, confirmed", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c, { paidCents: 17500, status: "confirmed" });
    await ready();
    await createInvoice(db, r.id, { kind: "prepayment", mode: "receipt", paidAt: PAID_AT, method: "bank" }, NOW);
    const rest = await request(r, "balance");
    await markInvoicePaid(db, rest.id, { paidAt: NOW, method: "cash" }, NOW);
    expect(await registration(r.id)).toMatchObject({ paidCents: 35000, status: "confirmed" });
    expect((await undoInvoicePaid(db, rest.id, NOW)).ok).toBe(true);
    expect(await registration(r.id)).toMatchObject({ paidCents: 17500, status: "confirmed" });
  });

  test("spec §9 (replaces R10): an old receipt (paid_adds false) is cancelled — its number kept, gone from her reads, never marked paid again — and its amount comes off Laekunud summa, the place with it", async () => {
    const c = await contactCourse(db);
    const [kati] = await db.insert(clients).values({ email: "kati@example.test", name: "Kati Tamm" }).returning();
    const r = await registrationOn(db, c, { email: "kati@example.test", paidCents: 17500, status: "confirmed", clientId: kati.id });
    await ready();
    const receipt = await createInvoice(db, r.id, { kind: "prepayment", mode: "receipt", paidAt: PAID_AT, method: "bank" }, NOW);
    if (!receipt.ok) throw new Error(receipt.error);
    expect(receipt.invoice.paidAdds).toBe(false);
    expect(await invoicesOfClient(db, kati.id)).toHaveLength(1);
    const later = new Date(NOW.getTime() + 60_000);
    expect(await undoInvoicePaid(db, receipt.invoice.id, later)).toEqual({
      ok: true,
      invoice: expect.objectContaining({ id: receipt.invoice.id, number: "MSL2026-001", status: "cancelled", cancelledAt: later, paidAt: null, paidMethod: null, paidAdds: false }),
    });
    // the design undoes a wrong entry through its receipt: the money goes, and below 50 % the registration waits again
    expect(await registration(r.id)).toMatchObject({ paidCents: 0, status: "awaiting_prepayment" });
    expect(await invoiceForStudent(db, kati.id, receipt.invoice.id)).toBeNull();
    expect(await invoicesOfClient(db, kati.id)).toEqual([]);
    // no „Märgi tasutuks" on it (that would add the money back as a request's), no second undo (the amount taken once)
    expect(await markInvoicePaid(db, receipt.invoice.id, { paidAt: PAID_AT, method: "bank" }, NOW)).toEqual({ ok: false, error: "notUnpaid" });
    expect(await undoInvoicePaid(db, receipt.invoice.id, NOW)).toEqual({ ok: false, error: "notPaid" });
    expect(await registration(r.id)).toMatchObject({ paidCents: 0, status: "awaiting_prepayment" });
    // the money is no longer in: the prepayment may be asked for again
    expect(await request(r)).toMatchObject({ number: "MSL2026-002", status: "unpaid", amountCents: 17500 });
  });

  test("spec §9: a receipt „Lisa laekumine“ made (paid_adds) is cancelled and lowers Laekunud summa by exactly its amount; the status follows (back to „Ootab ettemaksu“ below 50 %)", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    await ready();
    const press = (cents: number, receipt: boolean, expectedPaidCents: number) =>
      addManualPayment(db, { registrationId: r.id, cents, paidOn: "2026-10-16", method: "bank", receipt, expectedPaidCents }, NOW);
    expect(await press(10000, false, 0)).toMatchObject({ ok: true, receiptNumber: null });
    expect(await press(7500, true, 10000)).toMatchObject({ ok: true, paidCents: 17500, status: "confirmed", receiptNumber: "MSL2026-001" });
    const [receipt] = await allInvoices();
    expect(receipt).toMatchObject({ status: "paid", amountCents: 7500, paidAdds: true, dueAt: null });
    expect(await undoInvoicePaid(db, receipt.id, NOW)).toEqual({ ok: true, invoice: expect.objectContaining({ id: receipt.id, number: "MSL2026-001", status: "cancelled", cancelledAt: NOW, paidAdds: false }) });
    expect(await registration(r.id)).toMatchObject({ paidCents: 10000, status: "awaiting_prepayment" });
    expect(await undoInvoicePaid(db, receipt.id, NOW)).toEqual({ ok: false, error: "notPaid" });
    expect(await registration(r.id)).toMatchObject({ paidCents: 10000 });
  });

  test("spec §9: a receipt's undo never takes Laekunud summa below 0, and a receipt whose registration is gone is only cancelled", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c, { paidCents: 17500, status: "confirmed" });
    await ready();
    const receipt = await createInvoice(db, r.id, { kind: "prepayment", mode: "receipt", paidAt: PAID_AT, method: "bank" }, NOW);
    if (!receipt.ok) throw new Error(receipt.error);
    await db.update(registrations).set({ paidCents: 5000 }).where(eq(registrations.id, r.id));
    expect((await undoInvoicePaid(db, receipt.invoice.id, NOW)).ok).toBe(true);
    expect(await registration(r.id)).toMatchObject({ paidCents: 0, status: "awaiting_prepayment" });
    const other = await registrationOn(db, c, { email: "gone@example.test", paidCents: 17500, status: "confirmed" });
    const orphan = await createInvoice(db, other.id, { kind: "prepayment", mode: "receipt", paidAt: PAID_AT, method: "cash" }, NOW);
    if (!orphan.ok) throw new Error(orphan.error);
    await db.delete(registrations).where(eq(registrations.id, other.id));
    expect(await undoInvoicePaid(db, orphan.invoice.id, NOW)).toEqual({ ok: true, invoice: expect.objectContaining({ status: "cancelled", registrationId: null }) });
    expect(await registration(r.id)).toMatchObject({ paidCents: 0 });
  });

  test("a Montonio invoice is notManual: the site never changes it", async () => {
    const c = await contactCourse(db);
    await ready();
    const other = await registrationOn(db, c, { email: "online@example.com" });
    const online = await settle(await pendingPayment(db, other));
    expect(online).toMatchObject({ paidMethod: "montonio" });
    expect(await undoInvoicePaid(db, online!.id, NOW)).toEqual({ ok: false, error: "notManual" });
    expect(await registration(other.id)).toMatchObject({ paidCents: 17500 });
  });
});

describe("cancelInvoice: „Tühista arve“ (D6, §6.4)", () => {
  test("an unpaid invoice is cancelled and keeps its number; its amount is open again under a new number; a paid one, or one cancelled, is notUnpaid", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    await ready();
    const inv = await request(r);
    expect(await cancelInvoice(db, inv.id, NOW)).toEqual({ ok: true });
    expect(await invoiceForAdmin(db, inv.id)).toMatchObject({ status: "cancelled", cancelledAt: NOW, number: "MSL2026-001" });
    expect(await registration(r.id)).toMatchObject({ paidCents: 0, status: "awaiting_prepayment" });
    expect(await cancelInvoice(db, inv.id, NOW)).toEqual({ ok: false, error: "notUnpaid" });
    const again = await request(r);
    expect(again.number).toBe("MSL2026-002");
    await markInvoicePaid(db, again.id, { paidAt: PAID_AT, method: "bank" }, NOW);
    expect(await cancelInvoice(db, again.id, NOW)).toEqual({ ok: false, error: "notUnpaid" });
    expect(await cancelInvoice(db, 999_999, NOW)).toEqual({ ok: false, error: "notFound" });
    expect(infoLog()).toContain(`[invoices] invoice ${inv.id}: cancelled`);
  });
});

describe("updateInvoiceBuyer: „Muuda saajat“ (D9)", () => {
  test("an unpaid invoice's buyer: the name, an address, a company with its code and address; the e-mail stays", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    await ready();
    const inv = await request(r);
    const raw = { name: "  Kati   Tamm ", address: "Rüütli 2, Pärnu", company: "Kati Ilu OÜ", companyCode: "12345678", companyAddress: "Pikk 1,\nTallinn", email: "other@example.com" };
    const buyer = { name: "Kati Tamm", email: "kati@example.com", address: "Rüütli 2, Pärnu", company: "Kati Ilu OÜ", companyCode: "12345678", companyAddress: "Pikk 1, Tallinn" };
    expect(await updateInvoiceBuyer(db, inv.id, raw)).toEqual({ ok: true, invoice: expect.objectContaining({ buyer }) });
    expect(await invoiceForAdmin(db, inv.id)).toMatchObject({ buyer });
    // the editor sends every field: one left out is stored empty
    expect(await updateInvoiceBuyer(db, inv.id, { name: "Kati Tamm" })).toMatchObject({ ok: true, invoice: { buyer: { name: "Kati Tamm", address: "", company: "", companyCode: "", companyAddress: "" } } });
  });

  test("the refusals: a missing name, over-long fields, a company's code without its name; a paid invoice; an unknown one", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    await ready();
    const inv = await request(r);
    expect(await updateInvoiceBuyer(db, inv.id, { name: " " })).toEqual({ ok: false, error: "invalid", fields: { name: "required" } });
    expect(await updateInvoiceBuyer(db, inv.id, { name: "N".repeat(121), address: "A".repeat(201), company: "C".repeat(121), companyCode: "1".repeat(21), companyAddress: "A".repeat(201) })).toEqual({
      ok: false, error: "invalid", fields: { name: "tooLong", address: "tooLong", company: "tooLong", companyCode: "tooLong", companyAddress: "tooLong" },
    });
    expect(await updateInvoiceBuyer(db, inv.id, { name: "Kati", companyCode: "12345678" })).toEqual({ ok: false, error: "invalid", fields: { company: "required" } });
    expect(await invoiceForAdmin(db, inv.id)).toMatchObject({ buyer: { name: "Kati Tamm" } });
    await markInvoicePaid(db, inv.id, { paidAt: PAID_AT, method: "bank" }, NOW);
    expect(await updateInvoiceBuyer(db, inv.id, { name: "Kati Kask" })).toEqual({ ok: false, error: "notUnpaid" });
    expect(await updateInvoiceBuyer(db, 999_999, { name: "Kati Kask" })).toEqual({ ok: false, error: "notFound" });
  });
});

describe("a paid payment's invoice: invoiceForPaidPayment, markLinkedInvoicePaid, uninvoicedPayments, catchUpInvoice (D3, D5, §6.1–§6.3)", () => {
  test("Review Focus 4: no seller — the payment is paid with no invoice and listed in Arveta maksed; filled in, its catch-up carries the payment's paid time; a second is 'already'", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    const p = await pendingPayment(db, r);
    expect(await settle(p)).toBeNull();
    expect(await allInvoices()).toEqual([]);
    expect(await uninvoicedPayments(db)).toEqual([expect.objectContaining({ id: p.id, status: "paid", paidAt: PAID_AT })]);
    expect(await catchUpInvoice(db, p.id, NOW)).toEqual({ ok: false, error: "sellerMissing" });
    await ready();
    const caught = await catchUpInvoice(db, p.id, NOW);
    expect(caught).toEqual({
      ok: true,
      invoice: expect.objectContaining({
        number: "MSL2026-001", kind: "prepayment", status: "paid", paymentId: p.id, registrationId: r.id, courseId: c.course.id, amountCents: 17500,
        paidAt: PAID_AT, paidMethod: "montonio", paidAdds: false, issuedAt: NOW, dueAt: null, reference: "",
        line: { course: "Kulmumeistri baaskoolitus", session: "14.11.2026 Pärnu", part: "Ettemaks 50%" },
        buyer: { name: "Kati Tamm", email: "kati@example.com", address: "", company: "", companyCode: "", companyAddress: "" },
      }),
    });
    expect(await catchUpInvoice(db, p.id, NOW)).toEqual({ ok: false, error: "already" });
    expect(await uninvoicedPayments(db)).toEqual([]);
    // the payment's money was added once, by the payment itself
    expect(await registration(r.id)).toMatchObject({ paidCents: 17500, status: "confirmed" });
    expect(infoLog()).toContain(`[invoices] payment ${p.id}: issued MSL2026-001`);
  });

  test("catchUpInvoice's refusals: an unknown payment, one not paid (pending, held)", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    await ready();
    const p = await pendingPayment(db, r);
    expect(await catchUpInvoice(db, 999_999, NOW)).toEqual({ ok: false, error: "notFound" });
    expect(await catchUpInvoice(db, p.id, NOW)).toEqual({ ok: false, error: "notPaid" });
    await db.update(payments).set({ status: "held" }).where(eq(payments.id, p.id));
    expect(await catchUpInvoice(db, p.id, NOW)).toEqual({ ok: false, error: "notPaid" });
    expect(await allInvoices()).toEqual([]);
  });

  test("the seller ready: a born-paid invoice (Montonio, on the payment's time, the payer as the buyer); a whole-sum registration's prepayment is the whole sum", async () => {
    const c = await contactCourse(db);
    await ready();
    const half = await registrationOn(db, c);
    const p = await pendingPayment(db, half);
    const inv = await settle(p);
    expect(inv).toMatchObject({
      number: "MSL2026-001", kind: "prepayment", status: "paid", paymentId: p.id, paidAt: PAID_AT, paidMethod: "montonio", paidAdds: false, dueAt: null,
      buyer: { name: "Kati Tamm", email: "kati@example.com" }, issuedAt: NOW,
    });
    expect(await registration(half.id)).toMatchObject({ paidCents: 17500 });
    const whole = await registrationOn(db, c, { email: "t@example.com", paymentChoice: "full" });
    const full = await settle(await pendingPayment(db, whole, { amountCents: 35000 }));
    expect(full).toMatchObject({ number: "MSL2026-002", kind: "full", amountCents: 35000, line: { part: "Kogu summa (100%)" } });
    expect(await uninvoicedPayments(db)).toEqual([]);
    expect(await catchUpInvoice(db, p.id, NOW)).toEqual({ ok: false, error: "already" });
  });

  test("an e-course purchase: the course's line with no session, the client's id; the student reads it by the payment's client", async () => {
    await ready();
    const { client, payment, courseId } = await ecoursePurchase();
    const inv = await settle(payment);
    expect(inv).toMatchObject({ kind: "ecourse", registrationId: null, courseId, clientId: client.id, amountCents: 9500, line: { course: "Kulmude e-kursus", session: "", part: "E-koolitus" } });
    expect(await invoiceForStudent(db, client.id, inv!.id)).toMatchObject({ id: inv!.id });
  });

  test("a payment started for an unpaid invoice (payments.invoice_id) pays that invoice — Montonio, not added by the mark — and no second invoice is made", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    await ready();
    const inv = await request(r);
    const p = await pendingPayment(db, r);
    await db.update(payments).set({ invoiceId: inv.id }).where(eq(payments.id, p.id));
    const paid = await settle({ ...p, invoiceId: inv.id });
    // ruling R13: the invoice it paid is the payment's (payment_id), as a born-paid one is
    expect(paid).toMatchObject({ id: inv.id, number: "MSL2026-001", status: "paid", paidMethod: "montonio", paidAt: PAID_AT, paidAdds: false, paymentId: p.id });
    expect(await allInvoices()).toHaveLength(1);
    expect(await registration(r.id)).toMatchObject({ paidCents: 17500, status: "confirmed" });
    expect(await uninvoicedPayments(db)).toEqual([]);
    expect(await catchUpInvoice(db, p.id, NOW)).toEqual({ ok: false, error: "already" });
    expect(await markInvoicePaid(db, inv.id, { paidAt: NOW, method: "bank" }, NOW)).toEqual({ ok: false, error: "notUnpaid" });
    expect(await undoInvoicePaid(db, inv.id, NOW)).toEqual({ ok: false, error: "notManual" });
    expect(await stored()).toMatchObject({ nextSeq: 2 });
  });

  test("markLinkedInvoicePaid: null for a payment with no linked invoice, or one whose invoice is no longer unpaid, of another registration or another sum", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    const other = await registrationOn(db, c, { email: "other@example.com" });
    await ready();
    const inv = await request(r);
    const p = await pendingPayment(db, r);
    const inTx = (payment: Payment) => db.transaction((tx) => markLinkedInvoicePaid(tx, payment, NOW));
    expect(await inTx(p)).toBeNull();
    expect(await inTx({ ...p, invoiceId: inv.id, registrationId: other.id })).toBeNull();
    expect(await inTx({ ...p, invoiceId: inv.id, amountCents: 35000 })).toBeNull();
    await cancelInvoice(db, inv.id, NOW);
    expect(await inTx({ ...p, invoiceId: inv.id, paidAt: PAID_AT })).toBeNull();
    expect(await invoiceForAdmin(db, inv.id)).toMatchObject({ status: "cancelled" });
  });

  test("§6.2 never both: a payment with its own born-paid invoice never pays a linked one too, and a call again returns that invoice — no second one", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    await ready();
    const p = await pendingPayment(db, r);
    const own = await settle(p);
    expect(own).toMatchObject({ number: "MSL2026-001", paymentId: p.id });
    // an unpaid invoice of the same registration and sum, named as if the payment had been started for it
    const rest = await request(r, "balance");
    const [paid] = await db.select().from(payments).where(eq(payments.id, p.id));
    for (const payment of [paid, { ...paid, invoiceId: rest.id }]) {
      expect(await db.transaction((tx) => invoiceForPaidPayment(tx, payment, NOW))).toMatchObject({ id: own!.id });
    }
    expect(await invoiceForAdmin(db, rest.id)).toMatchObject({ status: "unpaid", paidAt: null });
    expect((await allInvoices()).map((i) => i.number)).toEqual(["MSL2026-001", "MSL2026-002"]);
  });

  test("the invoice the payment was started for was cancelled meanwhile: the payment gets its own born-paid invoice, so its money is invoiced once", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    await ready();
    const inv = await request(r);
    const p = await pendingPayment(db, r);
    await db.update(payments).set({ invoiceId: inv.id }).where(eq(payments.id, p.id));
    await cancelInvoice(db, inv.id, NOW);
    const own = await settle({ ...p, invoiceId: inv.id });
    expect(own).toMatchObject({ number: "MSL2026-002", status: "paid", paymentId: p.id, paidMethod: "montonio" });
    expect(await invoiceForAdmin(db, inv.id)).toMatchObject({ status: "cancelled" });
  });
});

describe("the reads: the student's own, Maria's, a registration's, the list, the month's CSV", () => {
  test("invoiceForStudent and invoicesOfClient: by the registration's client or the payment's; another client's is null; a cancelled one is not hers to see; Maria sees every one", async () => {
    const c = await contactCourse(db);
    const [kati] = await db.insert(clients).values({ email: "kati@example.com", name: "Kati Tamm" }).returning();
    const [other] = await db.insert(clients).values({ email: "other@example.com" }).returning();
    await ready();
    const r = await registrationOn(db, c, { clientId: kati.id });
    const first = await request(r);
    const rest = await request(r, "balance");
    // a registration linked to her account after the invoice was made (link-at-creation) is hers too
    const later = await registrationOn(db, c, { email: "kati@example.com" });
    const third = await request(later);
    await db.update(registrations).set({ clientId: kati.id }).where(eq(registrations.id, later.id));
    const bought = await ecoursePurchase("kati-e@example.com");
    const online = await settle(bought.payment);
    expect(await invoiceForStudent(db, kati.id, first.id)).toMatchObject({ id: first.id, number: "MSL2026-001" });
    expect(await invoiceForStudent(db, other.id, first.id)).toBeNull();
    expect(await invoiceForStudent(db, kati.id, online!.id)).toBeNull();
    expect(await invoiceForStudent(db, bought.client.id, online!.id)).toMatchObject({ id: online!.id });
    expect(await invoiceForStudent(db, kati.id, 999_999)).toBeNull();
    expect((await invoicesOfClient(db, kati.id)).map((i) => i.id)).toEqual([first.id, rest.id, third.id]);
    expect(await invoicesOfClient(db, other.id)).toEqual([]);
    await cancelInvoice(db, rest.id, NOW);
    expect(await invoiceForStudent(db, kati.id, rest.id)).toBeNull();
    expect((await invoicesOfClient(db, kati.id)).map((i) => i.id)).toEqual([first.id, third.id]);
    expect(await invoiceForAdmin(db, rest.id)).toMatchObject({ status: "cancelled" });
    expect(await invoiceForAdmin(db, 999_999)).toBeNull();
    expect((await invoicesOfRegistration(db, r.id)).map((i) => [i.number, i.status])).toEqual([["MSL2026-001", "unpaid"], ["MSL2026-002", "cancelled"]]);
    expect(await invoicesOfRegistration(db, 999_999)).toEqual([]);
  });

  test("listInvoices and invoicesCsv: the Tallinn month of the issue, the state; newest first, 50 a page; the CSV holds exactly the month's invoices, a cancelled one marked", async () => {
    const c = await contactCourse(db);
    await ready();
    const issue = async (email: string, at: Date) => request(await registrationOn(db, c, { email }), "prepayment", at);
    const sept = await issue("a@example.com", new Date("2026-09-30T20:30:00Z")); // 30.09 23:30 in Tallinn
    const oct1 = await issue("b@example.com", new Date("2026-09-30T21:30:00Z")); // 1.10 00:30
    const oct31 = await issue("c@example.com", new Date("2026-10-31T21:30:00Z")); // 31.10 23:30 (winter time)
    const nov = await issue("d@example.com", new Date("2026-10-31T22:30:00Z")); // 1.11 00:30
    await cancelInvoice(db, oct31.id, NOW);
    const october = await listInvoices(db, { month: "2026-10" }, 1);
    expect(october).toMatchObject({ page: 1, pages: 1, total: 2 });
    expect(october.rows.map((i) => i.id)).toEqual([oct31.id, oct1.id]);
    expect((await listInvoices(db, { month: "2026-10", status: "cancelled" }, 1)).rows.map((i) => i.id)).toEqual([oct31.id]);
    expect((await listInvoices(db, { status: "unpaid" }, 1)).rows.map((i) => i.id)).toEqual([nov.id, oct1.id, sept.id]);
    expect(await listInvoices(db, {}, 7)).toMatchObject({ page: 1, total: 4 });
    expect(await listInvoices(db, { month: "2026-13" }, 1)).toMatchObject({ total: 0, rows: [] });
    const csv = await invoicesCsv(db, "2026-10");
    expect(csv.startsWith("﻿Arve nr;")).toBe(true);
    const lines = csv.slice(1).trimEnd().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines.slice(1).map((l) => l.split(";")[0])).toEqual([`"${oct1.number}"`, `"${oct31.number}"`]);
    expect(lines[2]).toContain("Tühistatud");
    expect(csv).not.toContain(sept.number);
    expect(csv).not.toContain(nov.number);
    expect((await invoicesCsv(db, "2026-12")).slice(1).trimEnd().split("\r\n")).toHaveLength(1);
    expect((await invoicesCsv(db, "oktoober")).slice(1).trimEnd().split("\r\n")).toHaveLength(1);
  });
});

describe("invoicePdf (spec §7)", () => {
  test("I2: the row's frozen copy, its footer line too (the one of the issue, not Seaded's of today), rendered with the fonts; a PDF", async () => {
    const c = await contactCourse(db);
    await ready({ footer: "Täname, et valisite MS LABi!" });
    const inv = await request(await registrationOn(db, c));
    expect(inv.footer).toBe("Täname, et valisite MS LABi!");
    await ready({ footer: "Uus jalus" });
    const bytes = await invoicePdf(inv);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    expect(renderInvoice).toHaveBeenCalledTimes(1);
    const [content, assets] = vi.mocked(renderInvoice).mock.calls[0];
    expect(content).toEqual({
      number: inv.number, kind: inv.kind, status: inv.status, amountCents: inv.amountCents, vatRate: inv.vatRate, line: inv.line, seller: inv.seller, buyer: inv.buyer,
      reference: inv.reference, issuedAt: inv.issuedAt, dueAt: inv.dueAt, paidAt: inv.paidAt, paidMethod: inv.paidMethod, footer: "Täname, et valisite MS LABi!",
    });
    expect(assets.sans).toBeInstanceOf(Uint8Array);
  });
});

describe("the final review's wave: what covers a registration (I1, m4), the frozen footer (I2), „Tagastatud“ (I3), an odd part's words (m10)", () => {
  const notOpen = { ok: false, error: "notOpen" };
  /** „Koosta arve“ of `kind` as `mode` on `r` (a receipt paid on PAID_AT by bank). */
  const make = (r: Registration, kind: "prepayment" | "full" | "balance", mode: "request" | "receipt") =>
    createInvoice(db, r.id, mode === "request" ? { kind, mode } : { kind, mode, paidAt: PAID_AT, method: "bank" }, NOW);

  test("I1: a paid online prepayment with no invoice yet (the card was empty) counts as covered — „Koosta arve“ offers only the rest, as a request or a receipt; its own catch-up then gives it its one invoice", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    const p = await pendingPayment(db, r);
    expect(await settle(p)).toBeNull(); // no seller: paid, counted on Laekunud summa, no invoice
    await ready();
    for (const kind of ["prepayment", "full"] as const) for (const mode of ["request", "receipt"] as const) expect(await make(r, kind, mode), `${kind} ${mode}`).toEqual(notOpen);
    const rest = await request(r, "balance");
    expect(rest).toMatchObject({ number: "MSL2026-001", kind: "balance", amountCents: 17500, line: { part: "Jääk 50%" } });
    // the payment's own „Koosta arve“ („Arveta maksed“, also on the registration's block): its one invoice, the prepayment
    expect(await catchUpInvoice(db, p.id, NOW)).toMatchObject({ ok: true, invoice: { number: "MSL2026-002", kind: "prepayment", status: "paid", paymentId: p.id, amountCents: 17500 } });
    for (const kind of ["prepayment", "full", "balance"] as const) for (const mode of ["request", "receipt"] as const) expect(await make(r, kind, mode), `${kind} ${mode}`).toEqual(notOpen);
    expect(await uninvoicedPayments(db)).toEqual([]);
    // the paid invoices hold what Laekunud summa holds: 175 € once
    expect((await allInvoices()).filter((i) => i.status === "paid").reduce((sum, i) => sum + i.amountCents, 0)).toBe((await registration(r.id)).paidCents);
  });

  test("I1: a whole-sum registration's paid payment without an invoice covers the whole sum: nothing is offered", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c, { paymentChoice: "full" });
    expect(await settle(await pendingPayment(db, r, { amountCents: 35000 }))).toBeNull();
    await ready();
    for (const kind of ["prepayment", "full", "balance"] as const) for (const mode of ["request", "receipt"] as const) expect(await make(r, kind, mode), `${kind} ${mode}`).toEqual(notOpen);
  });

  test("m4: money typed by hand into Laekunud summa — no request asks for it again; a receipt („Juba tasutud“) is offered for exactly it, in the words of its part", async () => {
    const c = await contactCourse(db);
    await ready();
    const typed = await registrationOn(db, c, { paidCents: 17500, status: "confirmed" });
    for (const [kind, mode] of [["prepayment", "request"], ["full", "request"], ["full", "receipt"], ["balance", "receipt"]] as const) expect(await make(typed, kind, mode), `${kind} ${mode}`).toEqual(notOpen);
    expect(await make(typed, "prepayment", "receipt")).toMatchObject({ ok: true, invoice: { kind: "prepayment", status: "paid", amountCents: 17500, paidAdds: false, line: { part: "Ettemaks 50%" } } });
    expect(await registration(typed.id)).toMatchObject({ paidCents: 17500, status: "confirmed" });
    // the typed money has its receipt now: the rest is requested as before
    expect(await request(typed, "balance")).toMatchObject({ amountCents: 17500, line: { part: "Jääk 50%" } });
    // an odd sum typed: its receipt is that sum, an „Osamakse“; a request asks for the rest only, never the 100 € again
    const odd = await registrationOn(db, c, { email: "o@example.com", paidCents: 10000 });
    expect(await make(odd, "prepayment", "request")).toEqual(notOpen);
    expect(await make(odd, "prepayment", "receipt")).toMatchObject({ ok: true, invoice: { amountCents: 10000, line: { part: "Osamakse" } } });
    expect(await request(odd, "balance")).toMatchObject({ amountCents: 25000, line: { part: "Osamakse" } });
  });

  test("m10: a whole-sum registration's rest paid online after a part typed by hand is an „Osamakse“ (not „Kogu summa (100%)“ for less than the price), and the typed part gets its receipt", async () => {
    const c = await contactCourse(db);
    await ready();
    const r = await registrationOn(db, c, { paymentChoice: "full", paidCents: 10000 });
    expect(await settle(await pendingPayment(db, r, { amountCents: 25000 }))).toMatchObject({ kind: "full", amountCents: 25000, line: { part: "Osamakse" } });
    expect(await make(r, "balance", "request")).toEqual(notOpen);
    expect(await make(r, "balance", "receipt")).toMatchObject({ ok: true, invoice: { kind: "balance", amountCents: 10000, line: { part: "Osamakse" } } });
    expect((await allInvoices()).reduce((sum, i) => sum + i.amountCents, 0)).toBe((await registration(r.id)).paidCents);
  });

  test("I2: every invoice freezes Seaded's footer line of its issue — Maria's request, a receipt and a payment's own; a later change of the card reaches none of them", async () => {
    const c = await contactCourse(db);
    await ready({ footer: "Viivis 0,05% päevas." });
    const r = await registrationOn(db, c);
    const req = await request(r);
    const receipt = await createInvoice(db, (await registrationOn(db, c, { email: "b@example.com" })).id, { kind: "prepayment", mode: "receipt", paidAt: PAID_AT, method: "cash" }, NOW);
    const online = await settle(await pendingPayment(db, await registrationOn(db, c, { email: "d@example.com" })));
    expect([req.footer, receipt.ok && receipt.invoice.footer, online?.footer]).toEqual(["Viivis 0,05% päevas.", "Viivis 0,05% päevas.", "Viivis 0,05% päevas."]);
    await ready({ footer: "" });
    await ready({ footer: "Uus jalus" });
    expect((await allInvoices()).map((i) => i.footer)).toEqual(["Viivis 0,05% päevas.", "Viivis 0,05% päevas.", "Viivis 0,05% päevas."]);
    // one issued after the change has the new one
    expect((await request(await registrationOn(db, c, { email: "e@example.com" }))).footer).toBe("Uus jalus");
  });

  test("I3: an invoice whose payment was refunded, or voided (failed with its paid_at), is `refunded` on Maria's and the student's reads and „Tagastatud“ in the CSV; stored paid, its sums as issued", async () => {
    const c = await contactCourse(db);
    const [kati] = await db.insert(clients).values({ email: "kati@example.com", name: "Kati Tamm" }).returning();
    await ready();
    const paidOne = async (email: string) => {
      const r = await registrationOn(db, c, { email, clientId: kati.id });
      const p = await pendingPayment(db, r);
      return { r, p, inv: (await settle(p))! };
    };
    const refunded = await paidOne("a@example.com");
    const voided = await paidOne("b@example.com");
    const kept = await paidOne("d@example.com");
    await db.update(payments).set({ status: "refunded" }).where(eq(payments.id, refunded.p.id));
    await db.update(payments).set({ status: "failed" }).where(eq(payments.id, voided.p.id)); // the bank took it back: its paid_at stays
    const flags = (list: { number: string; status: string; refunded: boolean }[]) => list.map((i) => [i.number, i.status, i.refunded]);
    expect(flags((await listInvoices(db, {}, 1)).rows)).toEqual([["MSL2026-003", "paid", false], ["MSL2026-002", "paid", true], ["MSL2026-001", "paid", true]]);
    expect(flags((await listInvoices(db, { status: "paid" }, 1)).rows)).toHaveLength(3); // (the filter is the stored state)
    expect(flags(await invoicesOfRegistration(db, refunded.r.id))).toEqual([["MSL2026-001", "paid", true]]);
    expect(flags(await invoicesOfRegistration(db, kept.r.id))).toEqual([["MSL2026-003", "paid", false]]);
    expect(flags(await invoicesOfClient(db, kati.id))).toEqual([["MSL2026-001", "paid", true], ["MSL2026-002", "paid", true], ["MSL2026-003", "paid", false]]);
    const states = (await invoicesCsv(db, "2026-10")).slice(1).trimEnd().split("\r\n").slice(1).map((l) => [l.split(";")[0], l.split(";")[10], l.split(";")[9]]);
    expect(states).toEqual([['"MSL2026-001"', "Tagastatud", "175,00"], ['"MSL2026-002"', "Tagastatud", "175,00"], ['"MSL2026-003"', "Tasutud", "175,00"]]);
    // nothing stored changed
    expect((await allInvoices()).map((i) => [i.status, i.amountCents, i.paidMethod])).toEqual([["paid", 17500, "montonio"], ["paid", 17500, "montonio"], ["paid", 17500, "montonio"]]);
    // a failed payment that was never paid (no paid_at) is no refund
    await db.update(payments).set({ paidAt: null }).where(eq(payments.id, voided.p.id));
    expect(flags(await invoicesOfRegistration(db, voided.r.id))).toEqual([["MSL2026-002", "paid", false]]);
  });
});

describe("Review Focus 1: the order of the locks (Global Constraints): the registration's (its session, then it), the invoice or payment row, the number lock, the setting", () => {
  test("createInvoice: the session and the registration, then the number lock, then the setting and the series' highest, the invoice written and the number moved on", async () => {
    const log = await useLoggedDb();
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    await ready();
    log.length = 0;
    await request(r);
    const p = at(log);
    expect(p.sessionLock).toBeGreaterThanOrEqual(0);
    expect([p.sessionLock < p.registrationLock, p.registrationLock < p.numberLock, p.numberLock < p.settingRead, p.numberLock < p.maxSeq, p.settingRead < p.written, p.maxSeq < p.written, p.written < p.settingWrite]).toEqual([
      true, true, true, true, true, true, true,
    ]);
    expect(log.filter((e) => /pg_advisory/.test(e.query))).toHaveLength(1);
    // a refusal for what is open answers under the registration's lock alone
    log.length = 0;
    expect((await createInvoice(db, r.id, { kind: "prepayment", mode: "request" }, NOW)).ok).toBe(false);
    expect(at(log).registrationLock).toBeGreaterThanOrEqual(0);
    expect(log.some((e) => /pg_advisory/.test(e.query))).toBe(false);
  });

  test("markInvoicePaid, undoInvoicePaid (a request and a receipt), cancelInvoice: the session and the registration, then the invoice FOR UPDATE, and only then the paid sum and the invoice written; no number lock", async () => {
    const log = await useLoggedDb();
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    await ready();
    const inv = await request(r);
    for (const [name, run, writesSum] of [
      ["mark", () => markInvoicePaid(db, inv.id, { paidAt: PAID_AT, method: "bank" }, NOW), true],
      ["undo", () => undoInvoicePaid(db, inv.id, NOW), true],
      ["cancel", () => cancelInvoice(db, inv.id, NOW), false],
    ] as const) {
      log.length = 0;
      expect((await run()).ok, name).toBe(true);
      const p = at(log);
      expect(p.sessionLock, name).toBeGreaterThanOrEqual(0);
      expect([p.sessionLock < p.registrationLock, p.registrationLock < p.invoiceLock, p.invoiceLock < p.invoiceWrite], name).toEqual([true, true, true]);
      // the mark's addRegistrationPayment and the undo's take-back write the paid sum after the invoice's lock, before the invoice
      if (writesSum) expect([p.invoiceLock < p.paidSumWrite, p.paidSumWrite < p.invoiceWrite], name).toEqual([true, true]);
      else expect(p.paidSumWrite, name).toBe(-1);
      expect(p.numberLock, name).toBe(-1);
    }
    // a receipt's undo (spec §9) takes its amount back in the same order
    const made = await addManualPayment(db, { registrationId: r.id, cents: 17500, paidOn: "2026-10-16", method: "cash", receipt: true, expectedPaidCents: 0 }, NOW);
    const receipt = (await allInvoices()).find((i) => made.ok && i.number === made.receiptNumber)!;
    log.length = 0;
    expect((await undoInvoicePaid(db, receipt.id, NOW)).ok).toBe(true);
    const p = at(log);
    expect(p.sessionLock).toBeGreaterThanOrEqual(0);
    expect([p.sessionLock < p.registrationLock, p.registrationLock < p.invoiceLock, p.invoiceLock < p.paidSumWrite, p.paidSumWrite < p.invoiceWrite, p.numberLock]).toEqual([true, true, true, true, -1]);
  });

  test("an e-course's catch-up: no registration to lock — the payment FOR UPDATE, the number lock, the setting", async () => {
    const log = await useLoggedDb();
    const { payment } = await ecoursePurchase();
    await settle(payment);
    await ready();
    log.length = 0;
    expect((await catchUpInvoice(db, payment.id, NOW)).ok).toBe(true);
    const p = at(log);
    expect([p.sessionLock, p.registrationLock]).toEqual([-1, -1]);
    expect(p.paymentLock).toBeGreaterThanOrEqual(0);
    expect([p.paymentLock < p.numberLock, p.numberLock < p.settingRead, p.settingRead < p.written, p.written < p.settingWrite]).toEqual([true, true, true, true]);
  });

  test("catchUpInvoice: the session and the registration, the payment FOR UPDATE, the number lock, the setting", async () => {
    const log = await useLoggedDb();
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    const pay = await pendingPayment(db, r);
    await settle(pay);
    await ready();
    log.length = 0;
    expect((await catchUpInvoice(db, pay.id, NOW)).ok).toBe(true);
    const p = at(log);
    expect(p.sessionLock).toBeGreaterThanOrEqual(0);
    expect([p.sessionLock < p.registrationLock, p.registrationLock < p.paymentLock, p.paymentLock < p.numberLock, p.numberLock < p.settingRead, p.settingRead < p.written, p.written < p.settingWrite]).toEqual([
      true, true, true, true, true, true,
    ]);
  });

  test("invoiceForPaidPayment in settle's transaction, its linked invoice cancelled: after settle's locks the invoice FOR UPDATE, then the number lock, then the setting", async () => {
    const log = await useLoggedDb();
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    await ready();
    const inv = await request(r);
    const pay = await pendingPayment(db, r);
    await db.update(payments).set({ invoiceId: inv.id }).where(eq(payments.id, pay.id));
    await cancelInvoice(db, inv.id, NOW);
    log.length = 0;
    expect(await settle({ ...pay, invoiceId: inv.id })).toMatchObject({ paymentId: pay.id });
    const p = at(log);
    expect(p.sessionLock).toBeGreaterThanOrEqual(0);
    expect([p.sessionLock < p.registrationLock, p.registrationLock < p.invoiceLock, p.invoiceLock < p.numberLock, p.numberLock < p.settingRead, p.settingRead < p.written, p.written < p.settingWrite]).toEqual([
      true, true, true, true, true, true,
    ]);
  });
});
