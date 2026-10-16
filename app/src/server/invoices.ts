import { and, asc, count, desc, eq, gte, isNull, lt, max, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import type { Db, Q, Tx } from "@/db/client";
import { addRegistrationPayment, paged, setSetting, type Paged } from "@/db/queries/admin";
import { readSetting } from "@/db/queries/public";
import { lockForPayment } from "@/db/queries/seats";
import { courses, courseSessions, invoices, payments, registrations, type CourseSession, type Invoice, type Payment, type Registration } from "@/db/schema";
import { hasPrepayment, parsePrepayment, paymentReference, PREPAYMENT_KEY } from "@/domain/account-cards";
import { tallinnFormParts, tallinnInstant } from "@/domain/calendar";
import { tallinnDateText, tallinnYear } from "@/domain/certificate";
import {
  formatInvoiceNumber, INVOICE_KEY, INVOICE_LIMITS, invoiceCsv, invoiceKindOfPayment, invoiceSeq, openAmounts, partText, readInvoiceSettings, sellerReady,
  type InvoiceBuyer, type InvoiceKind, type InvoiceSettings, type InvoiceStatus, type PaidMethod,
} from "@/domain/invoice";
import { PAGE_SIZE } from "@/domain/paging";
import { registrationPrice, registrationStatusAfterPayment } from "@/domain/registration";
import { prepaymentDraft, type PrepaymentDraft } from "@/domain/site-editor";
import { toStorable } from "@/lib/to-storable";

// The invoices (invoices, Task 3; spec D2–D9, §6), without Next.js: the issue of a number in the setting's series, Maria's invoice on a
// registration (a request to pay or a receipt), „Märgi tasutuks" and its undo, the cancel, the buyer's editor, a paid payment's invoice (born
// paid, or the unpaid one it was started for paid) and the catch-up of a payment paid without one, the student's and Maria's reads, the list,
// the month's CSV, Seaded → Arve andmed (the settings key `invoice`) and the PDF.
//
// The locks, always in this order (the plan's Global Constraints), so no two writes ever wait for each other the other way round:
// 1. lockForPayment (db/queries/seats.ts: the registration's session, then the registration) when a registration is involved;
// 2. the payment row or the invoice row, FOR UPDATE;
// 3. the number series' transaction lock, pg_advisory_xact_lock(hashtext('invoice-number'));
// 4. the `invoice` setting, read and written.
// Every issue holds 3 and 4 in one transaction: the setting is read under the lock, the number taken (never at or below the prefix-year's
// highest: domain/invoice.ts invoiceSeq, the certificate's rule), the frozen copies written and the setting moved on; the unique
// (prefix, year, seq) and number are the backstop. Seaded's save holds 3 as well. A paid payment's invoice is issued inside settle.ts's own
// transaction, after its locks (1, and its payment row by the paid update): invoiceForPaidPayment and markLinkedInvoicePaid take a `tx` and
// open none. Logs carry ids and numbers only, never a name, an e-mail or an amount.

/** The number series' transaction lock (hashtext of this): every issue and Seaded's save hold it. */
const NUMBER_LOCK = "invoice-number";
/** The largest value of the integer column invoices.seq (domain/invoice.ts readInvoiceSettings keeps a next number up to it). */
const INT4_MAX = 2_147_483_647;
/** What a prefix may be (Seaded → Arve andmed): letters A–Z a–z and digits, 1–10 of them. */
const PREFIX = /^[A-Za-z0-9]{1,10}$/;
const KINDS: readonly InvoiceKind[] = ["prepayment", "full", "balance", "ecourse"];
/** The ways Maria marks or records a payment (D6); Montonio's is the site's own. */
const MANUAL_METHODS: readonly PaidMethod[] = ["bank", "cash", "card"];

/** Seaded's refusal of one field: "required" empty, "tooLong" over its INVOICE_LIMITS, "invalid" not a value the field takes, "taken" a next number already issued. */
export type InvoiceFieldError = "required" | "tooLong" | "invalid" | "taken";
/** The buyer editor's refusal of one field (D9). */
export type BuyerFieldError = "required" | "tooLong";

export type SaveInvoiceSettingsResult = { ok: true; settings: InvoiceSettings } | { ok: false; fields: Record<string, InvoiceFieldError> };
export type CreateInvoiceResult = { ok: true; invoice: Invoice } | { ok: false; error: "notFound" | "sellerMissing" | "bankMissing" | "notOpen" | "invalid" };
export type MarkPaidResult = { ok: true; invoice: Invoice; full?: true } | { ok: false; error: "notFound" | "notUnpaid" };
export type UndoPaidResult = { ok: true; invoice: Invoice } | { ok: false; error: "notFound" | "notPaid" | "notManual" };
export type CancelResult = { ok: true } | { ok: false; error: "notFound" | "notUnpaid" };
export type BuyerResult = { ok: true; invoice: Invoice } | { ok: false; error: "notFound" | "notUnpaid" } | { ok: false; error: "invalid"; fields: Record<string, BuyerFieldError> };
export type CatchUpResult = { ok: true; invoice: Invoice } | { ok: false; error: "notFound" | "sellerMissing" | "already" | "notPaid" };

// ---------- the number series ----------

/** Waits for and takes the number series' lock; it is held to the end of `tx`'s transaction. */
const lockNumbers = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${NUMBER_LOCK}))`);

/** The highest seq issued under `prefix` in `year`, 0 for none: what invoiceSeq and Seaded's "taken" read; inside a write, after lockNumbers. */
async function highestSeq(q: Q, prefix: string, year: number): Promise<number> {
  const [{ top }] = await q.select({ top: max(invoices.seq) }).from(invoices).where(and(eq(invoices.prefix, prefix), eq(invoices.year, year)));
  return top ?? 0;
}

/** Seaded → Arve andmed as stored, or its defaults (domain/invoice.ts readInvoiceSettings); inside a write, after lockNumbers. */
const readSettings = async (q: Q, now: Date): Promise<InvoiceSettings> => readInvoiceSettings(await readSetting(q, INVOICE_KEY), now);

/** What an issue's caller decides of the invoice; the number, the seller's copy, the VAT rate and the issue time are the issue's. */
type IssueDraft = Pick<
  typeof invoices.$inferInsert,
  "kind" | "registrationId" | "paymentId" | "courseId" | "clientId" | "status" | "amountCents" | "line" | "buyer" | "reference" | "dueAt" | "paidAt" | "paidMethod"
>;

/**
 * Issues one invoice inside `tx`, after the caller's row locks: the number series' lock, Seaded read (no seller: "sellerMissing", nothing
 * written), the bank details from Ettemaksu juhised, then `build` (which may refuse with its own word, R6's "bankMissing"), the number for the
 * Tallinn year of `now` under the setting's prefix (invoiceSeq: never at or below that prefix-year's highest), the row with its frozen seller
 * (Arve andmed and the bank details as they are now), VAT rate (null when VAT is off) and issue time, and the setting moved on.
 */
async function issue<R extends string = never>(
  tx: Tx,
  now: Date,
  build: (ctx: { settings: InvoiceSettings; bank: PrepaymentDraft; bankReady: boolean }) => IssueDraft | R,
): Promise<Invoice | "sellerMissing" | R> {
  await lockNumbers(tx);
  const settings = await readSettings(tx, now);
  if (!sellerReady(settings)) return "sellerMissing";
  const storedBank = await readSetting(tx, PREPAYMENT_KEY);
  const bank = prepaymentDraft(storedBank);
  const draft = build({ settings, bank, bankReady: hasPrepayment(parsePrepayment(storedBank)) });
  if (typeof draft === "string") return draft;
  const year = tallinnYear(now);
  const { seq, next } = invoiceSeq(settings, year, await highestSeq(tx, settings.prefix, year));
  const [row] = await tx
    .insert(invoices)
    .values({
      ...draft,
      number: formatInvoiceNumber(settings.prefix, year, seq),
      prefix: settings.prefix,
      year,
      seq,
      vatRate: settings.vatOn ? settings.vatRate : null,
      seller: {
        company: settings.company,
        registryCode: settings.registryCode,
        address: settings.address,
        vatNumber: settings.vatNumber,
        receiver: bank.receiver.trim(),
        iban: bank.iban.trim(),
        bank: bank.bank.trim(),
      },
      issuedAt: now,
      paidAdds: false,
    })
    .returning();
  await setSetting(tx, INVOICE_KEY, { ...settings, ...next });
  return row;
}

// ---------- the pieces of an invoice ----------

const two = (n: number) => String(n).padStart(2, "0");

/**
 * The due date of a request issued at `now` (D5): `days` later on Tallinn's calendar at the same Tallinn time, so the date printed is the
 * issue's date plus the term also across a change of the clocks (25.10.2026: 21.10 00:30 + 7 days is 28.10 00:30, not 27.10 23:30).
 */
function dueDate(now: Date, days: number): Date {
  const { date, time } = tallinnFormParts(now);
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d + days));
  return tallinnInstant(`${String(day.getUTCFullYear()).padStart(4, "0")}-${two(day.getUTCMonth() + 1)}-${two(day.getUTCDate())}`, time) ?? new Date(now.getTime() + days * 86_400_000);
}

/** The line's session (InvoiceLine.session): "14.11.2026 Pärnu", its Tallinn date and city. */
const sessionText = (s: Pick<CourseSession, "startsAt" | "city">): string => `${tallinnDateText(s.startsAt)} ${s.city.trim()}`.trim();

/** The buyer as the registration or the payment names her (D9): the name and the e-mail; what Maria adds later is empty. */
const buyerOf = (who: { name: string; email: string }): InvoiceBuyer => ({ name: who.name, email: who.email, address: "", company: "", companyCode: "", companyAddress: "" });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const validDate = (v: unknown): v is Date => v instanceof Date && !Number.isNaN(v.getTime());

/** The invoice row FOR UPDATE (the order's step 2), or null. */
async function lockInvoice(tx: Tx, id: number): Promise<Invoice | null> {
  const [row] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
  return row ?? null;
}

// ---------- Maria's invoice on a registration ----------

/**
 * „Koosta arve" on a registration (D5, §6.1–§6.2): the amount of `kind` while it is open (domain/invoice.ts openAmounts: not yet covered by an
 * unpaid or paid invoice of the registration), as a request to pay („Maksmiseks": unpaid, due in Seaded's term, the bank details and the
 * registration's payment reference, `{referencePrefix}{registrationId}` as the account shows it) or a receipt („Juba tasutud": born paid on
 * `paidAt` by `method`, bank, cash or card; it does not touch Laekunud summa, which already holds the money). `invalid` before anything is
 * read for a kind or mode it does not know, or a receipt without a date or a way. Then ONE transaction: lockForPayment, the registration
 * (`notFound`) and its invoices (an amount not open: `notOpen`, under the registration's lock alone), then the issue: no seller (D3)
 * `sellerMissing`; a request without the receiver and the IBAN of Ettemaksu juhised (R6) `bankMissing`. The frozen line is the course's
 * Estonian title, its session's date and city (empty for none) and the part; the buyer is the registration's name and e-mail. Logs
 * `[invoices] registration N: issued <number>` after the commit.
 */
export async function createInvoice(
  db: Db,
  registrationId: number,
  input: { kind: InvoiceKind; mode: "request" | "receipt"; paidAt?: Date; method?: PaidMethod },
  now: Date,
): Promise<CreateInvoiceResult> {
  if (!KINDS.includes(input.kind) || (input.mode !== "request" && input.mode !== "receipt")) return { ok: false, error: "invalid" };
  const receipt = input.mode === "receipt";
  const paidAt = input.paidAt;
  const method = input.method;
  if (receipt && (!validDate(paidAt) || method === undefined || !MANUAL_METHODS.includes(method))) return { ok: false, error: "invalid" };
  const result = await db.transaction(async (tx): Promise<CreateInvoiceResult> => {
    await lockForPayment(tx, registrationId);
    const [found] = await tx
      .select({ registration: registrations, course: courses, session: courseSessions })
      .from(registrations)
      .innerJoin(courses, eq(registrations.courseId, courses.id))
      .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
      .where(eq(registrations.id, registrationId))
      .limit(1);
    if (!found) return { ok: false, error: "notFound" };
    const { registration: r, course, session } = found;
    const price = registrationPrice(course, r.kind);
    const invoiced = await tx.select({ kind: invoices.kind, status: invoices.status, amountCents: invoices.amountCents }).from(invoices).where(eq(invoices.registrationId, r.id));
    const open = price === null ? undefined : openAmounts({ priceCents: price, paymentChoice: r.paymentChoice }, invoiced).find((o) => o.kind === input.kind);
    if (!open) return { ok: false, error: "notOpen" };
    const made = await issue(tx, now, ({ settings, bank, bankReady }): IssueDraft | "bankMissing" => {
      if (!receipt && !bankReady) return "bankMissing";
      return {
        kind: open.kind,
        registrationId: r.id,
        paymentId: null,
        courseId: course.id,
        clientId: r.clientId,
        status: receipt ? "paid" : "unpaid",
        amountCents: open.cents,
        line: { course: course.title.et, session: session ? sessionText(session) : "", part: open.part },
        buyer: buyerOf(r),
        reference: receipt ? "" : paymentReference(bank, r.id),
        dueAt: receipt ? null : dueDate(now, settings.termDays),
        paidAt: receipt ? paidAt : null,
        paidMethod: receipt ? method : null,
      };
    });
    return typeof made === "string" ? { ok: false, error: made } : { ok: true, invoice: made };
  });
  if (result.ok) console.info(`[invoices] registration ${registrationId}: issued ${result.invoice.number} (invoice ${result.invoice.id})`);
  return result;
}

/** The registration's paid sum less `cents` (not below 0), its status recomputed as Maria's own write recomputes it (recordRegistrationPayment). */
async function takeBackRegistrationPayment(tx: Tx, registrationId: number, cents: number): Promise<void> {
  const [current] = await tx
    .select({ registration: registrations, course: courses })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .where(eq(registrations.id, registrationId))
    .for("update", { of: registrations });
  if (!current) return;
  const { registration: r, course } = current;
  const paidCents = Math.max(0, r.paidCents - cents);
  const total = registrationPrice(course, r.kind);
  // confirmed from 50 %, back to awaiting below it, cancelled stays cancelled; without a price the status is left as it is
  const status = total == null ? r.status : registrationStatusAfterPayment({ status: r.status, paidCents }, total);
  await tx.update(registrations).set({ paidCents, status }).where(eq(registrations.id, registrationId));
}

/**
 * The transaction of a change to one invoice: lockForPayment for its registration (read before, without a lock: the registration's lock
 * comes first), then the invoice FOR UPDATE. `notFound` when the id is unknown.
 */
async function withInvoiceLocked<T>(db: Db, id: number, change: (tx: Tx, inv: Invoice) => Promise<T>): Promise<T | { ok: false; error: "notFound" }> {
  const [known] = await db.select({ registrationId: invoices.registrationId }).from(invoices).where(eq(invoices.id, id)).limit(1);
  if (!known) return { ok: false, error: "notFound" };
  return db.transaction(async (tx) => {
    if (known.registrationId !== null) await lockForPayment(tx, known.registrationId);
    const inv = await lockInvoice(tx, id);
    return inv ? change(tx, inv) : { ok: false as const, error: "notFound" as const };
  });
}

/**
 * „Märgi tasutuks" (§6.4): an unpaid invoice is paid on `paidAt` by `method`, and in the same transaction its amount is added to the
 * registration's Laekunud summa (db/queries/admin.ts addRegistrationPayment: confirmed from 50 %, unless the session is full, D2: then `full`,
 * and the registration stays unconfirmed, as the online path does). `paidAdds` says the mark added it, so its undo takes it back; an invoice
 * whose registration was deleted is paid and adds nothing. Under lockForPayment and the invoice's lock: of two marks at the same moment the
 * second finds it paid (`notUnpaid`), and the amount is added once. Logs `[invoices] invoice N: marked paid`.
 */
export async function markInvoicePaid(db: Db, id: number, input: { paidAt: Date; method: Exclude<PaidMethod, "montonio"> }, now: Date): Promise<MarkPaidResult> {
  const result = await withInvoiceLocked(db, id, async (tx, inv): Promise<MarkPaidResult> => {
    if (inv.status !== "unpaid") return { ok: false, error: "notUnpaid" };
    const added = inv.registrationId === null ? null : await addRegistrationPayment(tx, inv.registrationId, inv.amountCents, now);
    const [row] = await tx
      .update(invoices)
      .set({ status: "paid", paidAt: input.paidAt, paidMethod: input.method, paidAdds: added !== null })
      .where(eq(invoices.id, inv.id))
      .returning();
    return added?.full ? { ok: true, invoice: row, full: true } : { ok: true, invoice: row };
  });
  if (result.ok) console.info(`[invoices] invoice ${id}: marked paid${result.full ? " (the session is full: not confirmed)" : ""}`);
  return result;
}

/**
 * „Võta tasumine tagasi" (D6): a paid invoice that Maria marked or recorded (not Montonio's: `notManual`; not paid: `notPaid`) is unpaid
 * again, its date and way cleared. When the mark added the amount (`paidAdds`), the same transaction takes it back off Laekunud summa and
 * recomputes the status as Maria's own write does (recordRegistrationPayment): the place stays while the rest still makes 50 %, else it is
 * awaiting again. A receipt's mark added nothing, so nothing is taken back. Its due date and reference stay as issued (a receipt has none).
 * Under lockForPayment and the invoice's lock. Logs `[invoices] invoice N: paid mark undone`.
 */
export async function undoInvoicePaid(db: Db, id: number, now: Date): Promise<UndoPaidResult> {
  void now; // the actions' one shape (Task 5): an undo stores no time
  const result = await withInvoiceLocked(db, id, async (tx, inv): Promise<UndoPaidResult> => {
    if (inv.status !== "paid") return { ok: false, error: "notPaid" };
    if (inv.paidMethod === "montonio" || inv.paymentId !== null) return { ok: false, error: "notManual" };
    if (inv.paidAdds && inv.registrationId !== null) await takeBackRegistrationPayment(tx, inv.registrationId, inv.amountCents);
    const [row] = await tx.update(invoices).set({ status: "unpaid", paidAt: null, paidMethod: null, paidAdds: false }).where(eq(invoices.id, inv.id)).returning();
    return { ok: true, invoice: row };
  });
  if (result.ok) console.info(`[invoices] invoice ${id}: paid mark undone`);
  return result;
}

/**
 * „Tühista arve" (D6, §6.4): an unpaid invoice is cancelled at `now` and keeps its number (never given again, never deleted); nothing else
 * changes, and its amount is open again on the registration. A paid or cancelled one is `notUnpaid`. Under lockForPayment and the invoice's
 * lock, so it never crosses a mark or the online payment of the same invoice. Logs `[invoices] invoice N: cancelled`.
 */
export async function cancelInvoice(db: Db, id: number, now: Date): Promise<CancelResult> {
  const result = await withInvoiceLocked(db, id, async (tx, inv): Promise<CancelResult> => {
    if (inv.status !== "unpaid") return { ok: false, error: "notUnpaid" };
    await tx.update(invoices).set({ status: "cancelled", cancelledAt: now }).where(eq(invoices.id, inv.id));
    return { ok: true };
  });
  if (result.ok) console.info(`[invoices] invoice ${id}: cancelled`);
  return result;
}

/** A text of a form: what Postgres can hold, on one line (each run of white space one space), trimmed. */
const oneLine = (value: unknown): string => (typeof value === "string" ? toStorable(value).replace(/\s+/g, " ").trim() : "");

/**
 * „Muuda saajat" (D9): the buyer of an unpaid invoice, as the editor sends it — the name (required), an address, and a company with its
 * registry code and address when her company pays (a code or an address without the company's name: "required" on `company`). Each field
 * is one line, trimmed, within INVOICE_LIMITS (the name `name`, the addresses `buyerAddress`, the company `company`, its code `registryCode`);
 * one left out is empty. The e-mail
 * stays the registration's or the payment's. A paid or cancelled invoice keeps its buyer (`notUnpaid`). Field errors (`invalid`) before
 * anything is read; then under the invoice's lock. Logs `[invoices] invoice N: buyer changed`.
 */
export async function updateInvoiceBuyer(db: Db, id: number, raw: unknown): Promise<BuyerResult> {
  const input = isObject(raw) ? raw : {};
  const fields: Record<string, BuyerFieldError> = {};
  const text = (key: "name" | "address" | "company" | "companyCode" | "companyAddress", limit: number, required = false): string => {
    const value = oneLine(input[key]);
    if (!value && required) fields[key] = "required";
    else if (value.length > limit) fields[key] = "tooLong";
    return value;
  };
  const name = text("name", INVOICE_LIMITS.name, true);
  const address = text("address", INVOICE_LIMITS.buyerAddress);
  const company = text("company", INVOICE_LIMITS.company);
  const companyCode = text("companyCode", INVOICE_LIMITS.registryCode);
  const companyAddress = text("companyAddress", INVOICE_LIMITS.buyerAddress);
  if (!company && (companyCode || companyAddress) && !fields.company) fields.company = "required";
  if (Object.keys(fields).length > 0) return { ok: false, error: "invalid", fields };
  const [known] = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, id)).limit(1);
  if (!known) return { ok: false, error: "notFound" };
  const result = await db.transaction(async (tx): Promise<BuyerResult> => {
    const inv = await lockInvoice(tx, id);
    if (!inv) return { ok: false, error: "notFound" };
    if (inv.status !== "unpaid") return { ok: false, error: "notUnpaid" };
    const buyer: InvoiceBuyer = { name, email: inv.buyer.email, address, company, companyCode, companyAddress };
    const [row] = await tx.update(invoices).set({ buyer }).where(eq(invoices.id, inv.id)).returning();
    return { ok: true, invoice: row };
  });
  if (result.ok) console.info(`[invoices] invoice ${id}: buyer changed`);
  return result;
}

// ---------- a paid payment's invoice ----------

/** A born-paid invoice of `paymentId` (invoices.payment_id), or null. */
async function bornPaidOf(q: Q, paymentId: number): Promise<Invoice | null> {
  const [row] = await q.select().from(invoices).where(eq(invoices.paymentId, paymentId)).limit(1);
  return row ?? null;
}

/**
 * The born-paid invoice of a paid payment (D5, §6.3), issued at `now`: Montonio, paid on the payment's time (now when it has none), the
 * payment's id; the kind by invoiceKindOfPayment (a whole-sum registration's prepayment is the whole sum); the course's Estonian title, the
 * registration's session (none for an e-course), the payer's name and e-mail as the buyer; the payment's client, else the registration's.
 */
async function issueForPayment(tx: Tx, p: Payment, now: Date): Promise<Invoice | "sellerMissing"> {
  const [reg] =
    p.registrationId === null
      ? []
      : await tx
          .select({ registration: registrations, session: courseSessions })
          .from(registrations)
          .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
          .where(eq(registrations.id, p.registrationId))
          .limit(1);
  const r: Registration | null = reg?.registration ?? null;
  const courseId = p.courseId ?? r?.courseId ?? null;
  const [course] = courseId === null ? [] : await tx.select({ title: courses.title }).from(courses).where(eq(courses.id, courseId)).limit(1);
  const kind = invoiceKindOfPayment(p, r);
  return issue<never>(tx, now, () => ({
    kind,
    registrationId: p.registrationId,
    paymentId: p.id,
    courseId: course ? courseId : null,
    clientId: p.clientId ?? r?.clientId ?? null,
    status: "paid",
    amountCents: p.amountCents,
    line: { course: course?.title.et ?? "", session: reg?.session ? sessionText(reg.session) : "", part: partText(kind) },
    buyer: buyerOf(p),
    reference: "",
    dueAt: null,
    paidAt: p.paidAt ?? now,
    paidMethod: "montonio",
  }));
}

/**
 * settle.ts's paid() (Task 4), inside its transaction after its own locks: the unpaid invoice `payment.invoice_id` names (D5, the payment was
 * started to pay it) becomes paid — Montonio, on the payment's time, `paidAdds` false (the payment itself adds its amount through
 * addRegistrationPayment). Under the invoice's lock (the order's step 2). null when the payment names none, or its invoice is no longer
 * unpaid (Maria cancelled or marked it meanwhile), is another registration's or is of another sum: then it pays no invoice of hers.
 */
export async function markLinkedInvoicePaid(tx: Tx, payment: Payment, now: Date): Promise<Invoice | null> {
  if (payment.invoiceId === null) return null;
  const inv = await lockInvoice(tx, payment.invoiceId);
  if (!inv || inv.status !== "unpaid" || inv.registrationId !== payment.registrationId || inv.amountCents !== payment.amountCents) return null;
  const [row] = await tx
    .update(invoices)
    .set({ status: "paid", paidAt: payment.paidAt ?? now, paidMethod: "montonio", paidAdds: false })
    .where(eq(invoices.id, inv.id))
    .returning();
  console.info(`[invoices] invoice ${row.id}: paid online by payment ${payment.id}`);
  return row;
}

/**
 * A paid payment's invoice, inside settle.ts's paid() transaction after its locks (Task 4; §6.1: a paid payment has its invoice once the
 * seller is filled in). It opens no transaction of its own.
 * - The payment was started for an unpaid invoice (`invoiceId`): that invoice is paid (markLinkedInvoicePaid) and returned; no second
 *   invoice. If that invoice is no longer unpaid (cancelled, or marked by Maria while the student paid), the payment's money would have no
 *   invoice: it gets its own born-paid one below, so it is invoiced once.
 * - Otherwise its born-paid invoice (issueForPayment), or the one it already has (a call again finds it).
 * - No seller (D3): null, never a throw. The payment stays paid without an invoice and is listed in „Arveta maksed" (uninvoicedPayments).
 */
export async function invoiceForPaidPayment(tx: Tx, payment: Payment, now: Date): Promise<Invoice | null> {
  const linked = await markLinkedInvoicePaid(tx, payment, now);
  if (linked) return linked;
  const own = await bornPaidOf(tx, payment.id);
  if (own) return own;
  const made = await issueForPayment(tx, payment, now);
  if (made === "sellerMissing") {
    console.info(`[invoices] payment ${payment.id}: paid without an invoice (Arve andmed not filled in)`);
    return null;
  }
  console.info(`[invoices] payment ${payment.id}: issued ${made.number} (invoice ${made.id})`);
  return made;
}

/**
 * „Koosta arve" of a row of „Arveta maksed" (§6.3): the invoice of a payment paid while the seller was not filled in, issued now, paid on the
 * payment's time, Montonio, not mailed. Under lockForPayment (a registration's payment), then the payment row FOR UPDATE, so two at once give
 * one invoice: the second finds it (`already`). `already` too for a payment that paid the invoice it was started for; `notPaid` for one that
 * is not paid (pending, failed, held, refunded without an invoice); `sellerMissing` while the card is still empty. Logs
 * `[invoices] payment N: issued <number>` after the commit.
 */
export async function catchUpInvoice(db: Db, paymentId: number, now: Date): Promise<CatchUpResult> {
  const [known] = await db.select({ registrationId: payments.registrationId, kind: payments.kind }).from(payments).where(eq(payments.id, paymentId)).limit(1);
  if (!known) return { ok: false, error: "notFound" };
  const result = await db.transaction(async (tx): Promise<CatchUpResult> => {
    if (known.kind !== "ecourse" && known.registrationId !== null) await lockForPayment(tx, known.registrationId);
    const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
    if (!p) return { ok: false, error: "notFound" };
    if (await bornPaidOf(tx, p.id)) return { ok: false, error: "already" };
    if (p.status !== "paid") return { ok: false, error: "notPaid" };
    if (p.invoiceId !== null) return { ok: false, error: "already" };
    const made = await issueForPayment(tx, p, now);
    return made === "sellerMissing" ? { ok: false, error: "sellerMissing" } : { ok: true, invoice: made };
  });
  if (result.ok) console.info(`[invoices] payment ${paymentId}: issued ${result.invoice.number} (invoice ${result.invoice.id})`);
  return result;
}

// ---------- the reads ----------

/** A registration's invoices, every state, in the order they were issued (the drawer's „Arved"). */
export async function invoicesOfRegistration(db: Db, registrationId: number): Promise<Invoice[]> {
  return db.select().from(invoices).where(eq(invoices.registrationId, registrationId)).orderBy(asc(invoices.issuedAt), asc(invoices.id));
}

/**
 * Hers (the Global Constraints): an invoice of a registration whose client she is, or of a payment whose client she is (an e-course). A
 * cancelled invoice is void and not hers to see (the account does not show it, and its download is a 404).
 */
const ofClient = (clientId: number): SQL | undefined =>
  and(or(eq(registrations.clientId, clientId), eq(payments.clientId, clientId)), ne(invoices.status, "cancelled"));

/** Her invoices (the account's course cards), in the order they were issued; see ofClient. */
export async function invoicesOfClient(db: Db, clientId: number): Promise<Invoice[]> {
  const rows = await db
    .select({ invoice: invoices })
    .from(invoices)
    .leftJoin(registrations, eq(invoices.registrationId, registrations.id))
    .leftJoin(payments, eq(invoices.paymentId, payments.id))
    .where(ofClient(clientId))
    .orderBy(asc(invoices.issuedAt), asc(invoices.id));
  return rows.map((r) => r.invoice);
}

/** Her invoice `id` (GET /api/konto/arve/<id>), or null: another's, a cancelled one, none. */
export async function invoiceForStudent(db: Db, clientId: number, id: number): Promise<Invoice | null> {
  const [row] = await db
    .select({ invoice: invoices })
    .from(invoices)
    .leftJoin(registrations, eq(invoices.registrationId, registrations.id))
    .leftJoin(payments, eq(invoices.paymentId, payments.id))
    .where(and(eq(invoices.id, id), ofClient(clientId)))
    .limit(1);
  return row?.invoice ?? null;
}

/** Any invoice, for Maria; null for an unknown id. */
export async function invoiceForAdmin(db: Db, id: number): Promise<Invoice | null> {
  const [row] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  return row ?? null;
}

/** The instants a "YYYY-MM" month of Tallinn's calendar starts and ends (the next month's start); null for anything else. */
function monthRange(month: string): { from: Date; to: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const [y, mo] = [Number(m[1]), Number(m[2])];
  if (mo < 1 || mo > 12) return null;
  const next = mo === 12 ? `${String(y + 1).padStart(4, "0")}-01` : `${m[1]}-${two(mo + 1)}`;
  const from = tallinnInstant(`${month}-01`, "00:00");
  const to = tallinnInstant(`${next}-01`, "00:00");
  return from && to ? { from, to } : null;
}

/** The invoices issued in a Tallinn month; a month that is not "YYYY-MM" matches none. */
function issuedIn(month: string): SQL {
  const range = monthRange(month);
  return range ? (and(gte(invoices.issuedAt, range.from), lt(invoices.issuedAt, range.to)) as SQL) : sql`false`;
}

/** The „Arved" page (§5): every invoice, newest first, 50 a page (a page past the end is the last); by the Tallinn month of the issue and the state. */
export async function listInvoices(db: Db, filter: { month?: string; status?: InvoiceStatus }, page: number): Promise<Paged<Invoice>> {
  const where = and(filter.month === undefined ? undefined : issuedIn(filter.month), filter.status ? eq(invoices.status, filter.status) : undefined);
  return paged(
    page,
    PAGE_SIZE,
    async () => (await db.select({ n: count() }).from(invoices).where(where))[0].n,
    (range) => db.select().from(invoices).where(where).orderBy(desc(invoices.issuedAt), desc(invoices.id)).limit(range.limit).offset(range.offset),
  );
}

/** „Arveta maksed" (D3, §6.3): the paid payments with no invoice — none born of them, and not started for one — the oldest first. */
export async function uninvoicedPayments(db: Db): Promise<Payment[]> {
  return db
    .select()
    .from(payments)
    .where(and(eq(payments.status, "paid"), isNull(payments.invoiceId), notExists(db.select({ one: sql`1` }).from(invoices).where(eq(invoices.paymentId, payments.id)))))
    .orderBy(asc(payments.paidAt), asc(payments.id));
}

/** The accountant's file of a Tallinn month, "2026-10" (§6.5, domain/invoice.ts invoiceCsv): every invoice issued in it, cancelled ones too, in the order they were issued. */
export async function invoicesCsv(db: Db, month: string): Promise<string> {
  const rows = await db.select().from(invoices).where(issuedIn(month)).orderBy(asc(invoices.issuedAt), asc(invoices.id));
  return invoiceCsv(rows);
}

// ---------- Seaded → Arve andmed ----------

/** Seaded → Arve andmed as stored, or its defaults. */
export async function getInvoiceSettings(db: Db, now: Date): Promise<InvoiceSettings> {
  return readSettings(db, now);
}

/** The number issued with the highest seq under `prefix` in `year`, for the card's "viimane väljastatud"; null without one. */
async function lastIssued(db: Db, prefix: string, year: number): Promise<string | null> {
  const [row] = await db
    .select({ number: invoices.number })
    .from(invoices)
    .where(and(eq(invoices.prefix, prefix), eq(invoices.year, year)))
    .orderBy(desc(invoices.seq))
    .limit(1);
  return row?.number ?? null;
}

/**
 * Seaded's „Arve andmed" card: the stored setting with „Järgmine number" as the next issue will take it (invoiceSeq for this Tallinn year
 * and the prefix's highest: never at or below it), and the last number issued in the prefix-year the card shows. A setting for a LATER year
 * (Maria's preset in December) is shown as she saved it (as certificates.ts certificateCard).
 */
export async function invoiceCard(db: Db, now: Date): Promise<InvoiceSettings & { last: string | null }> {
  const stored = await getInvoiceSettings(db, now);
  const year = tallinnYear(now);
  if (stored.nextYear > year) return { ...stored, last: await lastIssued(db, stored.prefix, stored.nextYear) };
  const { seq } = invoiceSeq(stored, year, await highestSeq(db, stored.prefix, year));
  return { ...stored, nextYear: year, nextSeq: seq, last: await lastIssued(db, stored.prefix, year) };
}

/** A whole number from the form: a number, or up to 10 digits as a string; null for anything else. */
function wholeNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  return typeof value === "string" && /^\d{1,10}$/.test(value.trim()) ? Number(value.trim()) : null;
}

/**
 * Seaded → „Arve andmed" „Salvesta" (D2, D7, D8).
 * - The texts are kept on one line and trimmed, each within INVOICE_LIMITS (UTF-16 units, as readInvoiceSettings measures them, so what is
 *   saved here is never dropped by the read). The company, its registry code and its address are required (D3: no invoice without them);
 *   the VAT number and the footer are optional, but VAT on requires the VAT number ("required" on `vatNumber`).
 * - The prefix is letters A–Z a–z and digits, 1–10 ("required", "tooLong", "invalid").
 * - The VAT rate a whole 1–50 and the term a whole 0–90 days ("invalid"); "Järgmine number" a year that is this Tallinn year or the next
 *   and a number 1–2 147 483 647 (the seq column's largest) ("invalid").
 * Then under the number series' lock (the setting read under it):
 * - Ruling R3: a prefix different from the stored one resets the next number to 1 (the setting holds one counter; the max rule of every
 *   issue then continues each prefix's own series: a new prefix from 001, an old one from its highest + 1). The very first save has no stored
 *   prefix to differ from, so its number is kept.
 * - The same prefix: a number at or below that prefix-year's highest is refused (`nextSeq: "taken"`): two invoices must never share a
 *   number, and an issue between Maria's loading the card and her save moves the series on.
 * Nothing is stored when a field is refused.
 */
export async function saveInvoiceSettings(db: Db, raw: unknown, now: Date): Promise<SaveInvoiceSettingsResult> {
  const input = isObject(raw) ? raw : {};
  const fields: Record<string, InvoiceFieldError> = {};
  const text = (key: "company" | "registryCode" | "address" | "vatNumber" | "footer", required: boolean): string => {
    const value = oneLine(input[key]);
    if (!value && required) fields[key] = "required";
    else if (value.length > INVOICE_LIMITS[key]) fields[key] = "tooLong";
    return value;
  };
  const company = text("company", true);
  const registryCode = text("registryCode", true);
  const address = text("address", true);
  const vatNumber = text("vatNumber", false);
  const footer = text("footer", false);
  const vatOn = input.vatOn === true || input.vatOn === "on" || input.vatOn === "true";
  if (vatOn && !vatNumber && !fields.vatNumber) fields.vatNumber = "required";
  const prefix = oneLine(input.prefix);
  if (!prefix) fields.prefix = "required";
  else if (prefix.length > INVOICE_LIMITS.prefix) fields.prefix = "tooLong";
  else if (!PREFIX.test(prefix)) fields.prefix = "invalid";
  const vatRate = wholeNumber(input.vatRate);
  if (vatRate === null || vatRate < 1 || vatRate > INVOICE_LIMITS.vatRate) fields.vatRate = "invalid";
  const termDays = wholeNumber(input.termDays);
  if (termDays === null || termDays < 0 || termDays > INVOICE_LIMITS.termDays) fields.termDays = "invalid";
  const year = tallinnYear(now);
  const nextYear = wholeNumber(input.nextYear);
  if (nextYear !== year && nextYear !== year + 1) fields.nextYear = "invalid";
  const nextSeq = wholeNumber(input.nextSeq);
  if (nextSeq === null || nextSeq < 1 || nextSeq > INT4_MAX) fields.nextSeq = "invalid";
  // the null checks again, written out: the transaction's closure below sees the numbers as numbers
  if (vatRate === null || termDays === null || nextYear === null || nextSeq === null || Object.keys(fields).length > 0) return { ok: false, fields };
  return db.transaction(async (tx): Promise<SaveInvoiceSettingsResult> => {
    await lockNumbers(tx);
    const storedValue = await readSetting(tx, INVOICE_KEY);
    const prefixChanged = storedValue !== null && readInvoiceSettings(storedValue, now).prefix !== prefix;
    if (!prefixChanged && nextSeq <= (await highestSeq(tx, prefix, nextYear))) return { ok: false, fields: { nextSeq: "taken" } };
    const settings: InvoiceSettings = { company, registryCode, address, vatNumber, vatOn, vatRate, prefix, nextYear, nextSeq: prefixChanged ? 1 : nextSeq, termDays, footer };
    await setSetting(tx, INVOICE_KEY, settings);
    return { ok: true, settings };
  });
}

// ---------- the PDF ----------

/**
 * The PDF of an invoice row, rendered on each download (spec §7) from its frozen copy, with Maria's footer line from Seaded as it is now (the
 * row does not hold it). invoice-pdf.ts (pdf-lib and its fontkit) and the fonts' loader are imported here, when an invoice is rendered: this
 * module comes with the account API, the payment routes and the admin pages, which then never load the PDF stack at a cold start. The fonts
 * are the certificate's (no new font); the invoice draws the sans alone.
 */
export async function invoicePdf(db: Db, inv: Invoice): Promise<Uint8Array> {
  const [{ renderInvoice }, { loadCertificateAssets }] = await Promise.all([import("./invoice-pdf"), import("./certificate-pdf")]);
  const [settings, fonts] = await Promise.all([getInvoiceSettings(db, new Date()), loadCertificateAssets()]);
  return renderInvoice(
    {
      number: inv.number,
      kind: inv.kind,
      status: inv.status,
      amountCents: inv.amountCents,
      vatRate: inv.vatRate,
      line: inv.line,
      seller: inv.seller,
      buyer: inv.buyer,
      reference: inv.reference,
      issuedAt: inv.issuedAt,
      dueAt: inv.dueAt,
      paidAt: inv.paidAt,
      paidMethod: inv.paidMethod,
      footer: settings.footer,
    },
    { sans: fonts.sans },
  );
}
