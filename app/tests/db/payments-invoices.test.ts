import { desc, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { attachOrder, insertPayment } from "@/db/queries/payments";
import { clients, clientSessions, courses, invoices, payments, registrations, type Invoice, type Payment, type Registration } from "@/db/schema";
import type { PaidMethod } from "@/domain/invoice";
import { formatEUR } from "@/domain/money";
import { invoiceDue, invoicePaymentKind, payableDue, type DueInput } from "@/domain/payments";
import { ecourseOpenMail, registrationPaidMail, type EcourseOpenInput, type RegistrationPaidInput } from "@/server/account-mail";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { renderInvoice } from "@/server/invoice-pdf";
import {
  cancelInvoice, catchUpInvoice, createInvoice, invoicePdf, invoicesOfClient, invoicesOfRegistration, listInvoices, markInvoicePaid, undoInvoicePaid, uninvoicedPayments, unpaidInvoiceOf,
} from "@/server/invoices";
import { loadPayView, payPage } from "@/server/pay-page";
import { settleToken } from "@/server/payments/settle";
import { startRegistrationPayment } from "@/server/payments/start";
import { newToken, sha256 } from "@/server/token";
import { fakeKv } from "../fakes";
import { readPdf } from "../pdf-read";
import { capRows, countedMails, makeTestDb } from "./helpers";
import { contactCourse, loggedDb, orderToken, registrationOn, settleDeps, SITE, stubMontonio, TEST_MONTONIO } from "./payments-fixtures";

// Payments that make and pay invoices (invoices, Task 4; spec D5, §4, §6.1–§6.2): a paid Montonio payment gets its invoice (born paid, or the
// unpaid one it was started for paid) in settle's winning transaction, and the paid mail carries the PDF with „Arve on lisatud."; „Maksa"
// charges an unpaid invoice's exact amount (the pay page, the account's button, the start), the course day too; a payment and Maria's mark on
// the same invoice, in either order, invoice every euro once (ruling R7). Montonio, Resend and Telegram are faked as the other payment tests
// fake them; the PDF renderer is the real one, wrapped (to make it fail once).

vi.mock("@/server/invoice-pdf", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/invoice-pdf")>();
  return { ...real, renderInvoice: vi.fn(real.renderInvoice) };
});

/** 16.10.2026 12:00 in Tallinn (summer time, UTC+3). */
const NOW = new Date("2026-10-16T09:00:00Z");
const MIN = 60_000;
/** When Montonio's answer comes: five minutes after the start. */
const LATER = new Date(NOW.getTime() + 5 * MIN);
/** Seaded → Arve andmed: the seller, VAT off, MSL from 1 in 2026, a week to pay. */
const SELLER = { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu", vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: 2026, nextSeq: 1, termDays: 7, footer: "" };
/** Seaded → Ettemaksu juhised. */
const BANK = { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };

/** A Resend call's body as the fake keeps it (the SDK's own field names). */
type SentMail = { to: string; subject: string; text: string; html?: string; attachments?: { filename: string; content: string; content_type: string }[] };

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  vi.mocked(renderInvoice).mockClear();
  for (const method of ["info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const allInvoices = () => db.select().from(invoices).orderBy(invoices.id);
const registration = async (id: number) => (await db.select().from(registrations).where(eq(registrations.id, id)))[0];
const newest = async (): Promise<Payment> => (await db.select().from(payments).orderBy(desc(payments.id)).limit(1))[0];
const sent = (m: ReturnType<typeof stubMontonio>) => m.mails() as SentMail[];
const logged = (method: "info" | "error") => vi.mocked(console[method]).mock.calls.map((c) => c.map(String).join(" "));

/** Every `op` on invoices fails from now (a trigger), as a broken invoice step would; allowAgain ends it. */
async function refuse(op: "insert" | "update") {
  await db.execute(sql.raw("create or replace function mslab_refuse_invoice() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$"));
  await db.execute(sql.raw(`create trigger mslab_refuse_invoice_${op} before ${op} on invoices for each row execute function mslab_refuse_invoice()`));
}
const allowAgain = (op: "insert" | "update") => db.execute(sql.raw(`drop trigger mslab_refuse_invoice_${op} on invoices`));

/** Seaded's seller card and the bank details filled in. */
async function ready() {
  await setSetting(db, "invoice", SELLER);
  await setSetting(db, "prepayment", BANK);
}

/** Maria's request to pay („Maksmiseks") of `kind` on `r`, which must be made. */
async function request(r: Registration, kind: "prepayment" | "full" | "balance", now = NOW): Promise<Invoice> {
  const made = await createInvoice(db, r.id, { kind, mode: "request" }, now);
  if (!made.ok) throw new Error(`request: ${made.error}`);
  return made.invoice;
}

/** „Maksa" of `r` (the /maksa page's and the account's start) at `now`. */
const start = (m: ReturnType<typeof stubMontonio>, r: Registration, now = NOW) =>
  startRegistrationPayment({ db, now, siteUrl: SITE, notifyBase: SITE, montonio: m.montonio }, { registrationId: r.id });

/** Montonio's PAID for `p` (the webhook) at `at`, and the work after the response done. */
async function pay(m: ReturnType<typeof stubMontonio>, p: Payment, at = LATER) {
  const s = settleDeps(db, m.montonio, at);
  const result = await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(p)));
  await s.flush();
  return result;
}

/** The text a PDF attachment draws (its runs, one a line). */
async function pdfText(attachment: { content: string }): Promise<string> {
  const bytes = Buffer.from(attachment.content, "base64");
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  return (await readPdf(new Uint8Array(bytes))).runs.map((r) => r.text).join("\n");
}

/**
 * Every euro of `r` invoiced once (spec §1's anti-goals, rulings R7 and R13): the paid invoices add up to Laekunud summa, each paid payment is
 * named by exactly one invoice (invoices.payment_id: its own born-paid one, or the unpaid one it was started for, paid by Montonio — `method`:
 * „financing“ for a järelmaks, instalments D6), and no invoice is left unpaid.
 */
async function expectEachEuroInvoicedOnce(r: Registration, method: PaidMethod = "montonio") {
  const all = await allInvoices();
  expect(all.filter((i) => i.status === "paid").reduce((sum, i) => sum + i.amountCents, 0)).toBe((await registration(r.id)).paidCents);
  for (const p of (await db.select().from(payments)).filter((x) => x.status === "paid")) {
    const its = all.filter((i) => i.paymentId === p.id);
    expect(its.map((i) => [i.status, i.paidMethod]), `payment ${p.id}`).toEqual([["paid", method]]);
  }
  expect(all.filter((i) => i.status === "unpaid")).toEqual([]);
  expect(await uninvoicedPayments(db)).toEqual([]);
}

describe("a paid payment's invoice (D5: born paid), and the paid mail that carries it", () => {
  test("the seller ready: a paid prepayment has one invoice, MSL2026-001, paid by Montonio on the payment's time; her mail attaches its PDF with „Arve on lisatud.\"", async () => {
    const m = stubMontonio();
    await ready();
    const r = await registrationOn(db, await contactCourse(db));
    expect(await start(m, r)).toMatchObject({ kind: "started" });
    const p = await newest();
    expect(p.invoiceId).toBeNull();
    expect(await pay(m, p)).toMatchObject({ kind: "done", payment: { status: "paid" } });
    expect(await allInvoices()).toEqual([
      expect.objectContaining({ number: "MSL2026-001", kind: "prepayment", status: "paid", paidMethod: "montonio", paidAt: LATER, paidAdds: false, paymentId: p.id, registrationId: r.id, amountCents: 17500 }),
    ]);
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 17500]);
    const [hers, marias] = sent(m);
    expect([hers.to, hers.subject]).toEqual(["kati@example.com", "Koht on kinnitatud — Kulmumeistri baaskoolitus"]);
    expect(hers.attachments).toHaveLength(1);
    expect(hers.attachments![0]).toMatchObject({ filename: "MS-LAB-arve-MSL2026-001.pdf", content_type: "application/pdf" });
    const drawn = await pdfText(hers.attachments![0]);
    expect(drawn).toContain("MSL2026-001");
    expect(drawn).toContain("Tasutud 16.10.2026 (Montonio)");
    expect(hers.text).toContain("Arve on lisatud.");
    expect(hers.html).toContain("Arve on lisatud.");
    // Maria's notice carries nothing
    expect(marias.to).toBe("maria@example.test");
    expect(marias.attachments).toBeUndefined();
    expect(logged("info")).toContain(`[invoices] payment ${p.id}: issued MSL2026-001 (invoice ${(await allInvoices())[0].id})`);
  });

  test("the seller missing (D3): the payment is paid and has no invoice; it is listed in „Arveta maksed\", and her mail goes as today", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    expect(await start(m, r)).toMatchObject({ kind: "started" });
    const p = await newest();
    expect(await pay(m, p)).toMatchObject({ payment: { status: "paid" } });
    expect(await allInvoices()).toEqual([]);
    expect((await uninvoicedPayments(db)).map((x) => x.id)).toEqual([p.id]);
    const [hers] = sent(m);
    expect(hers.subject).toBe("Koht on kinnitatud — Kulmumeistri baaskoolitus");
    expect(hers.attachments).toBeUndefined();
    expect(hers.text).not.toContain("Arve on lisatud.");
    expect(renderInvoice).not.toHaveBeenCalled();
  });

  test("the rest paid online: its own invoice „Jääk 50%\"; the mail „Kogu summa on tasutud.\" attaches it", async () => {
    const m = stubMontonio();
    await ready();
    const r = await registrationOn(db, await contactCourse(db), { status: "confirmed", paidCents: 17500 });
    expect(await start(m, r)).toMatchObject({ kind: "started" });
    const p = await newest();
    expect(p).toMatchObject({ kind: "balance", amountCents: 17500, invoiceId: null });
    await pay(m, p);
    expect(await allInvoices()).toEqual([expect.objectContaining({ number: "MSL2026-001", kind: "balance", status: "paid", paymentId: p.id, line: expect.objectContaining({ part: "Jääk 50%" }) })]);
    const [hers] = sent(m);
    expect(hers.text).toContain("Kogu summa on tasutud.");
    expect(hers.attachments!.map((a) => a.filename)).toEqual(["MS-LAB-arve-MSL2026-001.pdf"]);
  });

  test("the PDF fails to render: the mail still goes, without the PDF and without the line; logged with the number", async () => {
    const m = stubMontonio();
    await ready();
    const r = await registrationOn(db, await contactCourse(db));
    await start(m, r);
    vi.mocked(renderInvoice).mockRejectedValueOnce(new Error("the font is gone"));
    await pay(m, await newest());
    expect(await allInvoices()).toEqual([expect.objectContaining({ number: "MSL2026-001", status: "paid" })]);
    const [hers, marias] = sent(m);
    expect(hers.subject).toBe("Koht on kinnitatud — Kulmumeistri baaskoolitus");
    expect(hers.attachments).toBeUndefined();
    expect(hers.text).not.toContain("Arve on lisatud.");
    expect(marias.to).toBe("maria@example.test");
    expect(logged("error")).toContain("[invoices] MSL2026-001: the paid mail went without its PDF: Error");
  });

  test("R13: the invoice step runs in a savepoint — when its invoice cannot be written, the payment is still recorded, the mail goes without a PDF, it waits in „Arveta maksed\", and its catch-up makes the invoice", async () => {
    const m = stubMontonio();
    await ready();
    const r = await registrationOn(db, await contactCourse(db));
    await start(m, r);
    const p = await newest();
    await refuse("insert");
    expect(await pay(m, p)).toMatchObject({ kind: "done", payment: { status: "paid", paidAt: LATER } });
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 17500]);
    expect(await allInvoices()).toEqual([]);
    expect((await uninvoicedPayments(db)).map((x) => x.id)).toEqual([p.id]);
    const [hers, marias] = sent(m);
    expect(hers.subject).toBe("Koht on kinnitatud — Kulmumeistri baaskoolitus");
    expect(hers.attachments).toBeUndefined();
    expect(hers.text).not.toContain("Arve on lisatud.");
    expect(marias.to).toBe("maria@example.test");
    expect(logged("error")).toContain(`[invoices] payment ${p.id}: no invoice: DrizzleQueryError (code P0001)`);
    // the setting did not move: the series has no gap
    await allowAgain("insert");
    expect(await catchUpInvoice(db, p.id, LATER)).toMatchObject({ ok: true, invoice: { number: "MSL2026-001", paymentId: p.id, paidAt: LATER, paidMethod: "montonio" } });
    await expectEachEuroInvoicedOnce(r);
  });

  test("the webhook twice and the return: one invoice, one mail with it", async () => {
    const m = stubMontonio();
    await ready();
    const r = await registrationOn(db, await contactCourse(db));
    await start(m, r);
    const p = await newest();
    await Promise.all([pay(m, p), pay(m, p)]);
    await pay(m, p);
    expect(await allInvoices()).toHaveLength(1);
    expect(sent(m).filter((x) => x.to === "kati@example.com")).toHaveLength(1);
    expect(renderInvoice).toHaveBeenCalledTimes(1);
  });

  test("an e-course bought online: its invoice „E-koolitus\" is born paid for her new client, and „E-koolitus on avatud\" attaches it", async () => {
    const m = stubMontonio();
    await ready();
    const [course] = await db
      .insert(courses)
      .values({ slug: "kulmumeistri-e-koolitus", type: "e_learning", level: "basic", title: { et: "Kulmumeistri e-koolitus", ru: "Онлайн-курс бровиста" }, summary: { et: "" }, body: { et: "" }, published: true, price: 19000, accessMonths: 6 })
      .returning();
    const row = await insertPayment(db, { kind: "ecourse", registrationId: null, courseId: course.id, clientId: null, email: "mari@example.com", name: "Mari Maasikas", locale: "et", amountCents: 19000 }, NOW, TEST_MONTONIO.referencePrefix);
    await attachOrder(db, row.id, "uuid-e", NOW);
    await pay(m, { ...row, providerUuid: "uuid-e" });
    const [client] = await db.select().from(clients).where(eq(clients.email, "mari@example.com"));
    expect(await allInvoices()).toEqual([
      expect.objectContaining({ number: "MSL2026-001", kind: "ecourse", status: "paid", paidMethod: "montonio", paymentId: row.id, registrationId: null, courseId: course.id, clientId: client.id, amountCents: 19000, line: { course: "Kulmumeistri e-koolitus", session: "", part: "E-koolitus" } }),
    ]);
    const hers = sent(m).find((x) => x.to === "mari@example.com")!;
    expect(hers.subject).toBe("E-koolitus on avatud — Kulmumeistri e-koolitus");
    expect(hers.attachments!.map((a) => [a.filename, a.content_type])).toEqual([["MS-LAB-arve-MSL2026-001.pdf", "application/pdf"]]);
    expect(await pdfText(hers.attachments![0])).toContain("Kulmumeistri e-koolitus");
    expect(hers.text).toContain("Arve on lisatud.");
    expect(hers.html).toContain("Arve on lisatud.");
  });

  test("a sample address (@example.test) is never mailed and no PDF is rendered for it; the invoice is made all the same", async () => {
    const m = stubMontonio();
    await ready();
    const r = await registrationOn(db, await contactCourse(db), { email: "kati@example.test" });
    await start(m, r);
    await pay(m, await newest());
    expect(await allInvoices()).toHaveLength(1);
    expect(sent(m).map((x) => x.to)).toEqual(["maria@example.test"]);
    expect(renderInvoice).not.toHaveBeenCalled();
  });
});

describe("Järelmaks (Inbank): the paid invoice says so (instalments D6)", () => {
  /** Montonio's PAID for a signed loan (the method hirePurchase, Inbank the provider) at `at`, and the work after the response done. */
  async function payLoan(m: ReturnType<typeof stubMontonio>, p: Payment, at = LATER) {
    const s = settleDeps(db, m.montonio, at);
    const result = await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(p, { paymentMethod: "hirePurchase", paymentProviderName: "Inbank" })));
    await s.flush();
    return result;
  }
  const financingOn = () => setSetting(db, "financing", { enabled: true });
  const startLoan = (m: ReturnType<typeof stubMontonio>, r: Registration) =>
    startRegistrationPayment({ db, now: NOW, siteUrl: SITE, notifyBase: SITE, montonio: m.montonio }, { registrationId: r.id }, { method: "hirePurchase" });

  test("a hirePurchase PAID on an unpaid financing registration confirms it like a bank payment (full price, invoice „Järelmaks (Inbank)“)", async () => {
    const m = stubMontonio();
    await ready();
    await financingOn();
    const r = await registrationOn(db, await contactCourse(db), { email: "kati@example.test", paymentChoice: "financing" });
    expect(await startLoan(m, r)).toMatchObject({ kind: "started" });
    const p = await newest();
    expect(p).toMatchObject({ kind: "prepayment", amountCents: 35000, method: "hirePurchase", invoiceId: null });
    expect(await payLoan(m, p)).toMatchObject({ kind: "done", payment: { status: "paid", paidAt: LATER, method: "hirePurchase", bank: "Inbank" } });
    const after = await registration(r.id);
    expect([after.status, after.paidCents, after.seatHoldUntil]).toEqual(["confirmed", 35000, null]);
    const [inv, ...none] = await allInvoices();
    expect(none).toEqual([]);
    expect(inv).toMatchObject({ number: "MSL2026-001", kind: "full", status: "paid", paidMethod: "financing", paidAt: LATER, paidAdds: false, paymentId: p.id, amountCents: 35000 });
    // the receipt: „Tasutud <day> · Järelmaks (Inbank)“, never brackets in brackets
    const drawn = (await readPdf(await invoicePdf(inv))).runs.map((x) => x.text).join("\n");
    expect(drawn).toContain("Tasutud 16.10.2026 · Järelmaks (Inbank)");
    expect(drawn).not.toContain("(Järelmaks (Inbank))");
    // Maria's notice: confirmed, paid in full, the method in her words
    const [marias] = sent(m);
    expect(marias.subject).toBe("Uus makse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 350 €");
    expect(marias.text).toContain("Registreering on kinnitatud ja täielikult tasutud.");
    expect(marias.text).toContain("Makseviis: Järelmaks (Inbank)\n");
    await expectEachEuroInvoicedOnce(r, "financing");
  });

  test("a loan started for her unpaid invoice of the whole price pays THAT invoice, by „Järelmaks (Inbank)“; no second invoice", async () => {
    const m = stubMontonio();
    await ready();
    await financingOn();
    const r = await registrationOn(db, await contactCourse(db), { email: "kati@example.test", paymentChoice: "financing" });
    const asked = await request(r, "full");
    expect(await startLoan(m, r)).toMatchObject({ kind: "started" });
    const p = await newest();
    expect(p).toMatchObject({ amountCents: 35000, method: "hirePurchase", invoiceId: asked.id });
    await payLoan(m, p);
    expect(await allInvoices()).toEqual([expect.objectContaining({ id: asked.id, status: "paid", paidMethod: "financing", paidAt: LATER, paidAdds: false, paymentId: p.id })]);
    await expectEachEuroInvoicedOnce(r, "financing");
  });

  test("an e-course bought with Järelmaks (Inbank): its born-paid invoice says „Järelmaks (Inbank)“; a bank purchase's still says Montonio", async () => {
    const m = stubMontonio();
    await ready();
    const [course] = await db
      .insert(courses)
      .values({ slug: "kulmumeistri-e-koolitus", type: "e_learning", level: "basic", title: { et: "Kulmumeistri e-koolitus" }, summary: { et: "" }, body: { et: "" }, published: true, price: 19000, accessMonths: 6 })
      .returning();
    const buy = async (email: string, method: string) => {
      const row = await insertPayment(db, { kind: "ecourse", registrationId: null, courseId: course.id, clientId: null, email, name: "Mari Maasikas", locale: "et", amountCents: 19000, method }, NOW, TEST_MONTONIO.referencePrefix);
      await attachOrder(db, row.id, `uuid-${row.id}`, NOW);
      return { ...row, providerUuid: `uuid-${row.id}` };
    };
    const loan = await buy("mari@example.test", "hirePurchase");
    const bank = await buy("teine@example.test", "paymentInitiation");
    expect(await payLoan(m, loan)).toMatchObject({ payment: { status: "paid" } });
    expect(await pay(m, bank)).toMatchObject({ payment: { status: "paid" } });
    expect((await allInvoices()).map((i) => [i.paymentId, i.kind, i.paidMethod])).toEqual([
      [loan.id, "ecourse", "financing"],
      [bank.id, "ecourse", "montonio"],
    ]);
    const drawn = async (inv: Invoice) => (await readPdf(await invoicePdf(inv))).runs.map((x) => x.text).join("\n");
    const [loanInvoice, bankInvoice] = await allInvoices();
    expect(await drawn(loanInvoice)).toContain("Tasutud 16.10.2026 · Järelmaks (Inbank)");
    expect(await drawn(bankInvoice)).toContain("Tasutud 16.10.2026 (Montonio)");
  });
});

describe("an unpaid invoice paid online (D5): „Maksa\" charges exactly its amount, and paying it makes no second invoice", () => {
  test("a 50% registration with an unpaid 100% invoice: the start charges 35000 and records the invoice; once paid, that invoice is paid, Laekunud summa 35000, no second invoice (Review Focus 3)", async () => {
    const m = stubMontonio();
    await ready();
    const r = await registrationOn(db, await contactCourse(db));
    const inv = await request(r, "full");
    expect(await start(m, r)).toMatchObject({ kind: "started" });
    const p = await newest();
    expect(p).toMatchObject({ kind: "prepayment", amountCents: 35000, invoiceId: inv.id, status: "pending" });
    expect(m.state.orders).toEqual([expect.objectContaining({ merchantReference: p.reference, grandTotal: 350 })]);
    await pay(m, p);
    expect(await allInvoices()).toEqual([expect.objectContaining({ id: inv.id, number: "MSL2026-001", status: "paid", paidMethod: "montonio", paidAt: LATER, paidAdds: false, paymentId: p.id })]);
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 35000]);
    const [hers] = sent(m);
    expect(hers.attachments!.map((a) => a.filename)).toEqual(["MS-LAB-arve-MSL2026-001.pdf"]);
    expect(await pdfText(hers.attachments![0])).toContain("Tasutud 16.10.2026 (Montonio)");
    expect(hers.text).toContain("Arve on lisatud.");
    expect(hers.text).toContain("Kogu summa on tasutud.");
    await expectEachEuroInvoicedOnce(r);
    // nothing is left to pay
    expect(await start(m, r, new Date(LATER.getTime() + MIN))).toEqual({ kind: "nothing" });
  });

  test("an unpaid invoice on the course day is still payable online (amountDue's window is not the invoice's)", async () => {
    const m = stubMontonio();
    await ready();
    // the session at 14:00 in Tallinn on NOW's day: the rest is no longer due online by amountDue
    const r = await registrationOn(db, await contactCourse(db, { startsAt: new Date("2026-10-16T11:00:00Z") }), { status: "confirmed", paidCents: 17500 });
    expect(await createInvoice(db, r.id, { kind: "prepayment", mode: "receipt", paidAt: NOW, method: "bank" }, NOW)).toMatchObject({ ok: true });
    expect(await start(m, r)).toEqual({ kind: "nothing" });
    const rest = await request(r, "balance");
    expect(await start(m, r)).toMatchObject({ kind: "started" });
    const p = await newest();
    expect(p).toMatchObject({ kind: "balance", amountCents: 17500, invoiceId: rest.id });
    await pay(m, p);
    expect((await allInvoices()).map((i) => [i.number, i.status, i.paidMethod])).toEqual([["MSL2026-001", "paid", "bank"], ["MSL2026-002", "paid", "montonio"]]);
    expect((await registration(r.id)).paidCents).toBe(35000);
  });

  test("of two unpaid invoices „Maksa\" pays the latest", async () => {
    const m = stubMontonio();
    await ready();
    const r = await registrationOn(db, await contactCourse(db));
    await request(r, "prepayment");
    const rest = await request(r, "balance");
    expect(await start(m, r)).toMatchObject({ kind: "started" });
    expect(await newest()).toMatchObject({ kind: "balance", amountCents: 17500, invoiceId: rest.id });
  });

  test("an unconfirmed registration paying an invoice's rest needs a free seat, as a prepayment does: „full\" on the start and the page, nothing started", async () => {
    const m = stubMontonio();
    await ready();
    const c = await contactCourse(db, { capacity: 1 });
    const r = await registrationOn(db, c);
    await request(r, "prepayment");
    await request(r, "balance");
    await registrationOn(db, c, { email: "teine@example.com", status: "confirmed", paidCents: 35000 });
    expect(await start(m, r)).toEqual({ kind: "full" });
    expect((await loadPayView(db, r.payToken, NOW))?.full).toBe(true);
    expect(await db.select().from(payments)).toEqual([]);
  });

  test("…and holds the seat for 30 minutes; an order Montonio refuses ends that hold at once, as a prepayment's", async () => {
    const m = stubMontonio();
    await ready();
    const r = await registrationOn(db, await contactCourse(db));
    await request(r, "prepayment");
    const rest = await request(r, "balance");
    m.state.down = true;
    expect(await start(m, r)).toEqual({ kind: "failed" });
    expect(await newest()).toMatchObject({ kind: "balance", invoiceId: rest.id, status: "failed" });
    expect((await registration(r.id)).seatHoldUntil).toBeNull();
    m.state.down = false;
    expect(await start(m, r)).toMatchObject({ kind: "started" });
    expect(await newest()).toMatchObject({ kind: "balance", invoiceId: rest.id, status: "pending" });
    expect((await registration(r.id)).seatHoldUntil).toEqual(new Date(NOW.getTime() + 30 * MIN));
  });

  test("a cancelled registration, or a session called off, pays nothing online, invoice or not", async () => {
    const m = stubMontonio();
    await ready();
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    await request(r, "prepayment");
    await db.update(registrations).set({ status: "cancelled" }).where(eq(registrations.id, r.id));
    expect(await start(m, r)).toEqual({ kind: "nothing" });
    expect((await loadPayView(db, r.payToken, NOW))?.due).toEqual({ kind: "none" });
    expect(await db.select().from(payments)).toEqual([]);
  });

  test("the open attempt is re-sent only for the same invoice: a start for an invoice is a new attempt beside one without (which it marks „Asendatud“, B22), and one without after the invoice is cancelled re-sends that one again", async () => {
    const m = stubMontonio();
    await ready();
    const r = await registrationOn(db, await contactCourse(db));
    expect(await start(m, r)).toMatchObject({ kind: "started" });
    const plain = await newest();
    const inv = await request(r, "prepayment");
    // the same kind and amount (17500 prepayment), but for the invoice: a new attempt that records it, and the one without is replaced
    expect(await start(m, r, new Date(NOW.getTime() + MIN))).toMatchObject({ kind: "started" });
    const forInvoice = await newest();
    expect(forInvoice.id).not.toBe(plain.id);
    expect(forInvoice).toMatchObject({ kind: "prepayment", amountCents: 17500, invoiceId: inv.id });
    // pressed again while it is open: the same attempt, sent again
    expect(await start(m, r, new Date(NOW.getTime() + 2 * MIN))).toMatchObject({ kind: "started" });
    expect((await newest()).id).toBe(forInvoice.id);
    // the invoice cancelled: the attempt without an invoice, replaced but still inside its window, is the open one again — sent again, and
    // the invoice's is replaced in its turn (one open order per registration)
    expect(await cancelInvoice(db, inv.id, NOW)).toEqual({ ok: true });
    expect(await start(m, r, new Date(NOW.getTime() + 3 * MIN))).toMatchObject({ kind: "started" });
    expect(m.state.orders.map((o) => o.merchantReference)).toEqual([plain.reference, forInvoice.reference, forInvoice.reference, plain.reference]);
    expect((await db.select().from(payments).orderBy(payments.id)).map((p) => [p.id, p.status])).toEqual([
      [plain.id, "pending"],
      [forInvoice.id, "replaced"],
    ]);
  });

  test("the /maksa page shows the invoice's amount: „Maksa 350 €\" and the transfer of 350 € for a 100% invoice of a 50% registration", async () => {
    await ready();
    const r = await registrationOn(db, await contactCourse(db));
    const inv = await request(r, "full");
    const view = await loadPayView(db, r.payToken, NOW);
    expect(view?.due).toEqual({ kind: "prepayment", cents: 35000, invoiceId: inv.id });
    expect(view?.full).toBe(false);
    const html = payPage(view, { online: true });
    expect(html).toContain(`Maksa ${formatEUR(35000, "et")}`);
    expect(html).toContain(`<dd>${formatEUR(35000, "et")}</dd>`);
    expect(html).not.toContain(formatEUR(17500, "et"));
  });

  test("the /maksa page reads only, with an invoice too", async () => {
    const { db: ldb, queries } = await loggedDb();
    db = ldb;
    await ready();
    const r = await registrationOn(db, await contactCourse(db));
    const inv = await request(r, "full");
    queries.length = 0;
    expect((await loadPayView(db, r.payToken, NOW))?.due).toEqual({ kind: "prepayment", cents: 35000, invoiceId: inv.id });
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.filter((q) => !/^select /i.test(q) || /for update/i.test(q))).toEqual([]);
  });

  test("POST /api/konto/maksa (the account's „Maksa\") charges her unpaid invoice's amount", async () => {
    const m = stubMontonio();
    await ready();
    const [client] = await db.insert(clients).values({ email: "kati@example.com" }).returning();
    const raw = newToken();
    await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId: client.id, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
    const r = await registrationOn(db, await contactCourse(db), { clientId: client.id });
    const inv = await request(r, "full");
    const deps: AccountDeps = { db, env: { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE }, now: NOW, siteUrl: SITE, later: () => {}, dev: false, montonio: m.montonio };
    const res = (await handleAccountApi(
      new Request(`${SITE}/api/konto/maksa`, { method: "POST", headers: { cookie: `__Host-mslab_client=${raw}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify({ registrationId: r.id }) }),
      deps,
    ))!;
    expect(res.status).toBe(200);
    expect(await newest()).toMatchObject({ amountCents: 35000, invoiceId: inv.id });
  });
});

describe("a Montonio payment and Maria's „Märgi tasutuks\" on the same invoice (Review Focus 1, ruling R7)", () => {
  /** Seller ready, a 50% registration with Maria's unpaid prepayment invoice, and „Maksa" pressed for it: the pending payment records it. */
  async function startedForInvoice(m: ReturnType<typeof stubMontonio>) {
    await ready();
    const r = await registrationOn(db, await contactCourse(db));
    const inv = await request(r, "prepayment");
    expect(await start(m, r)).toMatchObject({ kind: "started" });
    const p = await newest();
    expect(p.invoiceId).toBe(inv.id);
    return { r, inv, p };
  }

  test("Montonio first: the invoice is paid by Montonio once; Maria's mark then finds it paid, and Laekunud summa grows once", async () => {
    const m = stubMontonio();
    const { r, inv, p } = await startedForInvoice(m);
    await pay(m, p);
    expect(await markInvoicePaid(db, inv.id, { paidAt: LATER, method: "bank" }, LATER)).toEqual({ ok: false, error: "notUnpaid" });
    expect((await allInvoices()).map((i) => [i.id, i.status, i.paidMethod, i.paymentId])).toEqual([[inv.id, "paid", "montonio", p.id]]);
    expect((await registration(r.id)).paidCents).toBe(17500);
    await expectEachEuroInvoicedOnce(r);
  });

  test("Maria first: her mark pays the invoice once (bank); the Montonio money that comes after has an invoice of its own, and Laekunud summa counts both", async () => {
    const m = stubMontonio();
    const { r, inv, p } = await startedForInvoice(m);
    expect(await markInvoicePaid(db, inv.id, { paidAt: NOW, method: "bank" }, NOW)).toMatchObject({ ok: true });
    await pay(m, p);
    expect((await allInvoices()).map((i) => [i.number, i.status, i.paidMethod, i.paymentId, i.amountCents])).toEqual([
      ["MSL2026-001", "paid", "bank", null, 17500],
      ["MSL2026-002", "paid", "montonio", p.id, 17500],
    ]);
    expect((await registration(r.id)).paidCents).toBe(35000);
    expect(sent(m)[0].attachments!.map((a) => a.filename)).toEqual(["MS-LAB-arve-MSL2026-002.pdf"]);
    await expectEachEuroInvoicedOnce(r);
  });

  test("Maria cancels the invoice while the student pays: the payment has an invoice of its own", async () => {
    const m = stubMontonio();
    const { r, inv, p } = await startedForInvoice(m);
    expect(await cancelInvoice(db, inv.id, NOW)).toEqual({ ok: true });
    await pay(m, p);
    expect((await allInvoices()).map((i) => [i.number, i.status, i.paymentId])).toEqual([["MSL2026-001", "cancelled", null], ["MSL2026-002", "paid", p.id]]);
    await expectEachEuroInvoicedOnce(r);
  });

  test("the payment's own invoice keeps the part of the invoice it was started for: a 100% invoice cancelled while paid is invoiced „Kogu summa (100%)\" at 350 €, not „Ettemaks 50%\"", async () => {
    const m = stubMontonio();
    await ready();
    const r = await registrationOn(db, await contactCourse(db));
    const inv = await request(r, "full");
    await start(m, r);
    const p = await newest();
    expect(p).toMatchObject({ kind: "prepayment", amountCents: 35000, invoiceId: inv.id });
    expect(await cancelInvoice(db, inv.id, NOW)).toEqual({ ok: true });
    await pay(m, p);
    expect((await allInvoices()).map((i) => [i.number, i.kind, i.status, i.amountCents, i.line.part, i.paymentId])).toEqual([
      ["MSL2026-001", "full", "cancelled", 35000, "Kogu summa (100%)", null],
      ["MSL2026-002", "full", "paid", 35000, "Kogu summa (100%)", p.id],
    ]);
    await expectEachEuroInvoicedOnce(r);
  });

  test("both at the same moment: whichever wins, the invoice is paid once and every euro is invoiced once", async () => {
    const m = stubMontonio();
    const { r, inv, p } = await startedForInvoice(m);
    const [, marked] = await Promise.all([pay(m, p), markInvoicePaid(db, inv.id, { paidAt: NOW, method: "bank" }, NOW)]);
    const after = (await allInvoices()).find((i) => i.id === inv.id)!;
    expect(after.status).toBe("paid");
    if (after.paidMethod === "montonio") {
      expect(marked).toEqual({ ok: false, error: "notUnpaid" });
      expect(await allInvoices()).toHaveLength(1);
      expect((await registration(r.id)).paidCents).toBe(17500);
    } else {
      expect(marked).toMatchObject({ ok: true });
      expect(await allInvoices()).toHaveLength(2);
      expect((await registration(r.id)).paidCents).toBe(35000);
    }
    await expectEachEuroInvoicedOnce(r);
  });
});

describe("m1 (the final review): R14's trap is only a payment that has no invoice of its own", () => {
  test("Maria marks the invoice, the payment started for it settles (its own invoice, R7), and she undoes her mark: the invoice is an ordinary unpaid one again — not „paid online“, payable, markable, on her screens and the student's card", async () => {
    const m = stubMontonio();
    await ready();
    const [client] = await db.insert(clients).values({ email: "kati@example.com" }).returning();
    const r = await registrationOn(db, await contactCourse(db), { clientId: client.id });
    const inv = await request(r, "prepayment");
    expect(await start(m, r)).toMatchObject({ kind: "started" });
    const p = await newest();
    expect(p.invoiceId).toBe(inv.id);
    expect(await markInvoicePaid(db, inv.id, { paidAt: NOW, method: "bank" }, NOW)).toMatchObject({ ok: true });
    await pay(m, p);
    expect(await undoInvoicePaid(db, inv.id, LATER)).toMatchObject({ ok: true, invoice: { status: "unpaid" } });
    // the payment is invoiced by its own (R7), so nothing waits for a catch-up: the invoice is not „paid online“ anywhere
    expect(await uninvoicedPayments(db)).toEqual([]);
    expect((await invoicesOfRegistration(db, r.id)).map((i) => [i.number, i.status, i.paymentId, i.paidOnline])).toEqual([
      ["MSL2026-001", "unpaid", null, false],
      ["MSL2026-002", "paid", p.id, false],
    ]);
    expect((await listInvoices(db, {}, 1)).rows.map((i) => [i.number, i.paidOnline])).toEqual([["MSL2026-002", false], ["MSL2026-001", false]]);
    expect((await invoicesOfClient(db, client.id)).map((i) => [i.number, i.paidOnline])).toEqual([["MSL2026-001", false], ["MSL2026-002", false]]);
    // „Maksa“ charges it (the start and the page agree), and „Märgi tasutuks“ is no dead end
    expect(await unpaidInvoiceOf(db, r.id)).toMatchObject({ id: inv.id });
    expect((await loadPayView(db, r.payToken, LATER))?.due).toEqual({ kind: "prepayment", cents: 17500, invoiceId: inv.id });
    expect(await markInvoicePaid(db, inv.id, { paidAt: LATER, method: "bank" }, LATER)).toMatchObject({ ok: true });
  });
});

describe("R14: a payment whose invoice step failed, started for an invoice that still reads unpaid, until its catch-up", () => {
  /** A 50% registration's unpaid 100% invoice, „Maksa" pressed for it, and its payment settled while invoice updates fail (the savepoint rolls back). */
  async function failedForInvoice(m: ReturnType<typeof stubMontonio>) {
    await ready();
    const r = await registrationOn(db, await contactCourse(db));
    const inv = await request(r, "full");
    await start(m, r);
    const p = await newest();
    await refuse("update");
    expect(await pay(m, p)).toMatchObject({ payment: { status: "paid" } });
    await allowAgain("update");
    return { r, inv, p };
  }

  test("its money is counted while the invoice reads unpaid: „Maksa\" does not charge it again, Maria's mark refuses with paidOnline, and the catch-up pays THAT invoice", async () => {
    const m = stubMontonio();
    const { r, inv, p } = await failedForInvoice(m);
    expect([(await registration(r.id)).status, (await registration(r.id)).paidCents]).toEqual(["confirmed", 35000]);
    expect(await allInvoices()).toEqual([expect.objectContaining({ id: inv.id, status: "unpaid", paymentId: null })]);
    expect((await uninvoicedPayments(db)).map((x) => x.id)).toEqual([p.id]);
    expect(logged("error")).toContain(`[invoices] payment ${p.id}: no invoice: DrizzleQueryError (code P0001)`);
    expect(sent(m)[0].attachments).toBeUndefined();
    // not charged again: the page and the start find nothing to pay (its money is counted)
    expect((await loadPayView(db, r.payToken, LATER))?.due).toEqual({ kind: "none" });
    expect(await start(m, r, LATER)).toEqual({ kind: "nothing" });
    // Maria's mark would count it twice
    expect(await markInvoicePaid(db, inv.id, { paidAt: LATER, method: "bank" }, LATER)).toEqual({ ok: false, error: "paidOnline" });
    expect((await registration(r.id)).paidCents).toBe(35000);
    // „Koosta arve" in „Arveta maksed": that invoice, paid by Montonio on the payment's time, adding nothing
    expect(await catchUpInvoice(db, p.id, LATER)).toEqual({
      ok: true,
      invoice: expect.objectContaining({ id: inv.id, number: "MSL2026-001", status: "paid", paidMethod: "montonio", paidAt: LATER, paidAdds: false, paymentId: p.id }),
    });
    expect(logged("info")).toContain(`[invoices] payment ${p.id}: paid MSL2026-001 (invoice ${inv.id})`);
    expect(await allInvoices()).toHaveLength(1);
    expect(await catchUpInvoice(db, p.id, LATER)).toEqual({ ok: false, error: "already" });
    expect((await registration(r.id)).paidCents).toBe(35000);
    await expectEachEuroInvoicedOnce(r);
  });

  test("Maria cancels that invoice before the catch-up: the catch-up issues the payment's own, of that invoice's part", async () => {
    const m = stubMontonio();
    const { r, inv, p } = await failedForInvoice(m);
    expect(await cancelInvoice(db, inv.id, LATER)).toEqual({ ok: true });
    expect(await catchUpInvoice(db, p.id, LATER)).toMatchObject({
      ok: true,
      invoice: { number: "MSL2026-002", kind: "full", status: "paid", paymentId: p.id, amountCents: 35000, paidAt: LATER, line: { part: "Kogu summa (100%)" } },
    });
    await expectEachEuroInvoicedOnce(r);
  });
});

describe("I1 (the final review) with R14: a payment started for a prepayment invoice whose invoice step failed", () => {
  test("that invoice counts as paid, once: „Koosta arve“ offers the rest only and never a receipt for the payment's money; Maria's screens flag it until the catch-up pays THAT invoice", async () => {
    const m = stubMontonio();
    await ready();
    const r = await registrationOn(db, await contactCourse(db));
    const inv = await request(r, "prepayment");
    await start(m, r);
    const p = await newest();
    await refuse("update");
    expect(await pay(m, p)).toMatchObject({ payment: { status: "paid" } });
    await allowAgain("update");
    expect((await registration(r.id)).paidCents).toBe(17500);
    // Maria's reads: unpaid, paid online, waiting for its catch-up (the screens hide „Saada õpilasele“ and „Märgi tasutuks“)
    expect((await invoicesOfRegistration(db, r.id)).map((i) => [i.id, i.status, i.paidOnline])).toEqual([[inv.id, "unpaid", true]]);
    expect((await listInvoices(db, {}, 1)).rows.map((i) => [i.id, i.paidOnline])).toEqual([[inv.id, true]]);
    // the 175 € is in once: no receipt for it, no request for it, no whole sum
    for (const [kind, mode] of [["prepayment", "receipt"], ["prepayment", "request"], ["full", "request"], ["full", "receipt"]] as const)
      expect(await createInvoice(db, r.id, mode === "receipt" ? { kind, mode, paidAt: LATER, method: "bank" } : { kind, mode }, LATER), `${kind} ${mode}`).toEqual({ ok: false, error: "notOpen" });
    const rest = await request(r, "balance", LATER);
    expect(rest).toMatchObject({ kind: "balance", amountCents: 17500 });
    // the catch-up pays THAT invoice; nothing is flagged any more, and the paid invoices hold Laekunud summa
    expect(await catchUpInvoice(db, p.id, LATER)).toMatchObject({ ok: true, invoice: { id: inv.id, status: "paid", paymentId: p.id } });
    expect((await invoicesOfRegistration(db, r.id)).map((i) => [i.id, i.status, i.paidOnline])).toEqual([[inv.id, "paid", false], [rest.id, "unpaid", false]]);
    expect((await allInvoices()).filter((i) => i.status === "paid").reduce((sum, i) => sum + i.amountCents, 0)).toBe((await registration(r.id)).paidCents);
  });
});

describe("the locks: the order of the plan's Global Constraints", () => {
  const at = (queries: string[], pattern: RegExp) => queries.findIndex((q) => pattern.test(q));
  const SESSION_LOCK = /^select 1 from course_sessions where id = \(select course_session_id from registrations where id = \$1\) for update$/;
  const REGISTRATION_LOCK = /^select 1 from registrations where id = \$1 for update$/;
  const PAYMENT_UPDATE = /^update "payments"/;
  const INVOICE_LOCK = /from "invoices"[\s\S]*for update/;
  const INVOICE_UPDATE = /^update "invoices"/;
  const NUMBER_LOCK = /pg_advisory_xact_lock\(hashtext\(/;
  const SETTING_READ = /^select [\s\S]* from "settings"/;
  const INVOICE_INSERT = /^insert into "invoices"/;
  const lines = (queries: string[]) => JSON.stringify(queries.map((q) => q.slice(0, 70)), null, 1);

  test("settling: the session, the registration, the payment row; then a born-paid invoice's series lock, the setting and the insert", async () => {
    const { db: ldb, queries } = await loggedDb();
    db = ldb;
    const m = stubMontonio();
    await ready();
    const r = await registrationOn(db, await contactCourse(db));
    await start(m, r);
    const p = await newest();
    queries.length = 0;
    const s = settleDeps(db, m.montonio, LATER);
    await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(p)));
    const [session, registrationLock, payment, numbers, setting, insert] = [SESSION_LOCK, REGISTRATION_LOCK, PAYMENT_UPDATE, NUMBER_LOCK, SETTING_READ, INVOICE_INSERT].map((x) => at(queries, x));
    expect([session, registrationLock, payment, numbers, setting, insert].every((i) => i >= 0), lines(queries)).toBe(true);
    expect([session < registrationLock, registrationLock < payment, payment < numbers, numbers < setting, setting < insert], lines(queries)).toEqual([true, true, true, true, true]);
  });

  test("settling a payment started for an invoice: the payment row, then the invoice row FOR UPDATE and its update; no number is taken", async () => {
    const { db: ldb, queries } = await loggedDb();
    db = ldb;
    const m = stubMontonio();
    await ready();
    const r = await registrationOn(db, await contactCourse(db));
    await request(r, "prepayment");
    await start(m, r);
    const p = await newest();
    queries.length = 0;
    const s = settleDeps(db, m.montonio, LATER);
    await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(p)));
    const [registrationLock, payment, invoiceLock, invoiceUpdate] = [REGISTRATION_LOCK, PAYMENT_UPDATE, INVOICE_LOCK, INVOICE_UPDATE].map((x) => at(queries, x));
    expect([registrationLock, payment, invoiceLock, invoiceUpdate].every((i) => i >= 0), lines(queries)).toBe(true);
    expect([registrationLock < payment, payment < invoiceLock, invoiceLock < invoiceUpdate], lines(queries)).toEqual([true, true, true]);
    expect(at(queries, NUMBER_LOCK), lines(queries)).toBe(-1);
  });

  test("starting: the registration's invoices are read under the session's and the registration's locks, before the payment row is written", async () => {
    const { db: ldb, queries } = await loggedDb();
    db = ldb;
    const m = stubMontonio();
    await ready();
    const r = await registrationOn(db, await contactCourse(db));
    await request(r, "full");
    queries.length = 0;
    expect(await start(m, r)).toMatchObject({ kind: "started" });
    const [session, registrationLock, invoiceRead, write] = [SESSION_LOCK, REGISTRATION_LOCK, /from "invoices"/, /^insert into "payments"/].map((x) => at(queries, x));
    expect([session, registrationLock, invoiceRead, write].every((i) => i >= 0), lines(queries)).toBe(true);
    expect([session < registrationLock, registrationLock < invoiceRead, invoiceRead < write], lines(queries)).toEqual([true, true, true]);
  });
});

describe("the mail quota: invoice mails are not counted (controller ruling, as the paid and protocol mails)", () => {
  test("a paid mail with its invoice takes no place of a cap; the day's count of every mail has it", async () => {
    const m = stubMontonio();
    await ready();
    const r = await registrationOn(db, await contactCourse(db));
    await start(m, r);
    await pay(m, await newest());
    expect(sent(m)[0].attachments).toHaveLength(1);
    expect(await capRows(db)).toEqual([]);
    expect(await countedMails(db)).toBe(sent(m).length);
  });
});

describe("the paid mails' line (account-mail.ts)", () => {
  const paidInput = (over: Partial<RegistrationPaidInput> = {}): RegistrationPaidInput => ({
    siteUrl: SITE,
    email: "kati@example.com",
    name: "Kati Tamm",
    locale: "et",
    course: { et: "Kulmumeistri baaskoolitus", ru: "Базовый курс бровиста" },
    session: { startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio" },
    paidCents: 17500,
    restCents: 17500,
    confirmed: true,
    full: false,
    ...over,
  });
  const ecourseInput = (over: Partial<EcourseOpenInput> = {}): EcourseOpenInput => ({
    siteUrl: SITE,
    email: "mari@example.com",
    name: "Mari Maasikas",
    locale: "et",
    course: { et: "Kulmumeistri e-koolitus", ru: "Онлайн-курс бровиста" },
    expiresAt: new Date("2027-04-16T20:59:59.999Z"),
    login: null,
    ...over,
  });

  test("„Arve on lisatud.\" (et) and „Счёт во вложении.\" (ru, Draft) when the PDF is attached; without it, the mail is today's", () => {
    for (const [locale, line] of [["et", "Arve on lisatud."], ["ru", "Счёт во вложении."]] as const) {
      for (const mail of [registrationPaidMail(paidInput({ locale, invoiceAttached: true })), ecourseOpenMail(ecourseInput({ locale, invoiceAttached: true }))]) {
        expect(mail.text, locale).toContain(line);
        expect(mail.html, locale).toContain(line);
      }
    }
    expect(registrationPaidMail(paidInput({ invoiceAttached: false }))).toEqual(registrationPaidMail(paidInput()));
    expect(ecourseOpenMail(ecourseInput({ invoiceAttached: false }))).toEqual(ecourseOpenMail(ecourseInput()));
    expect(registrationPaidMail(paidInput()).text).not.toContain("Arve on lisatud.");
  });
});

describe("domain/payments.ts: what „Maksa\" charges", () => {
  const due = (over: Partial<DueInput> = {}): DueInput => ({ status: "awaiting_prepayment", paymentChoice: "half", priceCents: 35000, paidCents: 0, startsAt: new Date("2026-11-14T08:00:00Z"), sessionCancelled: false, ...over });

  test("invoiceDue: an unpaid invoice's whole amount; nothing for a paid or a cancelled one", () => {
    expect(invoiceDue({ status: "unpaid", amountCents: 35000 })).toEqual({ kind: "invoice", cents: 35000 });
    expect(invoiceDue({ status: "paid", amountCents: 35000 })).toBeNull();
    expect(invoiceDue({ status: "cancelled", amountCents: 35000 })).toBeNull();
  });

  test("invoicePaymentKind: a prepayment or a whole sum is paid as a prepayment, the rest as the rest", () => {
    expect([invoicePaymentKind("prepayment"), invoicePaymentKind("full"), invoicePaymentKind("balance")]).toEqual(["prepayment", "prepayment", "balance"]);
  });

  test("payableDue: the invoice's amount (with its id) at any time, the course day and after too; amountDue without one (no id); nothing for a cancelled registration or a session called off", () => {
    const full = { id: 7, kind: "full" as const, status: "unpaid" as const, amountCents: 35000 };
    expect(payableDue(due(), full, NOW)).toEqual({ kind: "prepayment", cents: 35000, invoiceId: 7 });
    expect(payableDue(due(), null, NOW)).toEqual({ kind: "prepayment", cents: 17500 });
    const courseDay = new Date("2026-11-14T12:00:00Z");
    const rest = { id: 8, kind: "balance" as const, status: "unpaid" as const, amountCents: 17500 };
    expect(payableDue(due({ status: "confirmed", paidCents: 17500 }), null, courseDay)).toEqual({ kind: "none" });
    expect(payableDue(due({ status: "confirmed", paidCents: 17500 }), rest, courseDay)).toEqual({ kind: "balance", cents: 17500, invoiceId: 8 });
    expect(payableDue(due({ status: "confirmed", paidCents: 17500, startsAt: null }), rest, NOW)).toEqual({ kind: "balance", cents: 17500, invoiceId: 8 });
    expect(payableDue(due({ status: "cancelled" }), full, NOW)).toEqual({ kind: "none" });
    expect(payableDue(due({ sessionCancelled: true }), full, NOW)).toEqual({ kind: "none" });
    // a paid or cancelled invoice is no invoice to pay: amountDue
    expect(payableDue(due(), { ...full, status: "paid" }, NOW)).toEqual({ kind: "prepayment", cents: 17500 });
  });
});
