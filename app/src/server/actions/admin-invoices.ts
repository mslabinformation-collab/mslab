"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { paidDay } from "@/domain/invoice";
import { adminEt } from "@/i18n/dict/admin";
import { ROW_ID_MAX } from "@/lib/row-id";
import { adminAction } from "../auth";
import { sendInvoice } from "../invoice-send";
import { cancelInvoice, catchUpInvoice, createInvoice, createInvoicesForUnbilled, invoiceCard, markInvoicePaid, saveInvoiceSettings, undoInvoicePaid, updateInvoiceBuyer } from "../invoices";
import { logFailure } from "../log";
import { revalidatePublic } from "../public-cache";
import { adminSendDeps } from "../send-deps";

// Maria's invoice actions (invoices Task 5, spec §5, D5–D9): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is in
// ../invoices.ts (the rules and the writes) and ../invoice-send.ts (the mail). Each action answers in plain data: `{ ok: true, … }`, or
// `{ ok: false, error, text }` with the refusal's code and its Estonian words (adminEt.invoices.errors; the codes of the work's own result
// unions, and `server` for a throw, logged by the row's id and the error's class only, never a name or an address). Each success refreshes
// the page it was made on, so the block, the list and the overview's numbers show the new state; one that moves the registration's paid
// sum (a mark and its undo) revalidates the seats of the public calendar too (as the registration drawer's own payment form does).

type ErrorCode = keyof typeof adminEt.invoices.errors;
type Failure<C extends ErrorCode = ErrorCode> = { ok: false; error: C; text: string };

const fail = <C extends ErrorCode>(error: C): Failure<C> => ({ ok: false, error, text: adminEt.invoices.errors[error] });

const rowId = z.number().int().min(1).max(ROW_ID_MAX);
const day = z.string();
const manualMethod = z.enum(["bank", "cash", "card"]);

const idOnly = z.object({ id: rowId });

const createInput = z.object({
  registrationId: rowId,
  kind: z.enum(["prepayment", "full", "balance", "ecourse"]),
  mode: z.enum(["request", "receipt"]),
  paidAt: day.optional(),
  method: manualMethod.optional(),
});

/**
 * „Koosta arve“ on a registration (D5): `{ registrationId, kind, mode, paidAt?, method? }` — a request to pay („Maksmiseks“), or a receipt
 * („Juba tasutud“) with the day money came in ("YYYY-MM-DD") and the way (bank, cash or card). Made: `{ ok: true, number }`. A form's input that
 * is none of this, or a receipt without a real day, is `invalid` before anything is read; the work refuses the rest (`notFound`,
 * `sellerMissing`, `bankMissing`, `notOpen`, `invalid`: a day after today).
 */
export const createInvoiceAction = adminAction(async (_admin, input: unknown) => {
  const parsed = createInput.safeParse(input);
  if (!parsed.success) return fail("invalid");
  const { registrationId, kind, mode, paidAt, method } = parsed.data;
  const now = new Date();
  const when = paidAt === undefined ? undefined : paidDay(paidAt, now);
  if (mode === "receipt" && (!when || !method)) return fail("invalid");
  try {
    const result = await createInvoice(getDb(), registrationId, mode === "receipt" ? { kind, mode, paidAt: when!, method } : { kind, mode }, now);
    if (!result.ok) return fail(result.error);
    refresh();
    return { ok: true as const, number: result.invoice.number };
  } catch (e) {
    logFailure(`[invoices] registration ${registrationId}: the invoice failed`, e);
    return fail("server");
  }
});

/**
 * „Saada õpilasele“ (D11): `{ id, also? }` — the invoice goes by mail to the student's address and, typed in „Saada ka aadressile“, to a second
 * one for this send only (server/invoice-send.ts). Sent: `{ ok: true }`, with `secondFailed` when only the second address was refused.
 */
export const sendInvoiceAction = adminAction(async (_admin, input: { id: number; also?: string }) => {
  const parsed = idOnly.safeParse({ id: input?.id });
  if (!parsed.success) return fail("notFound");
  const { id } = parsed.data;
  try {
    // (the second address is checked by the work: anything that is no address is `email`)
    const result = await sendInvoice(await adminSendDeps("[invoices]"), id, input.also);
    if (!result.ok) return fail(result.error);
    refresh();
    return result.secondFailed ? { ok: true as const, secondFailed: true as const } : { ok: true as const };
  } catch (e) {
    logFailure(`[invoices] invoice ${id}: the send failed`, e);
    return fail("server");
  }
});

const markInput = z.object({ id: rowId, paidAt: day, method: manualMethod });

/**
 * „Märgi tasutuks“ (§6.4): `{ id, paidAt, method }`, the day as "YYYY-MM-DD". The invoice is paid and its amount is added to the registration's
 * „Laekunud summa“, so the seats of the public pages are revalidated; `full: true` says the session was full, so the place stayed unconfirmed.
 */
export const markInvoicePaidAction = adminAction(async (_admin, input: { id: number; paidAt: string; method: "bank" | "cash" | "card" }) => {
  const parsed = markInput.safeParse(input);
  const now = new Date();
  const when = parsed.success ? paidDay(parsed.data.paidAt, now) : null;
  if (!parsed.success || !when) return fail("invalid");
  const { id, method } = parsed.data;
  try {
    const result = await markInvoicePaid(getDb(), id, { paidAt: when, method }, now);
    if (!result.ok) return fail(result.error);
    revalidatePublic({ kind: "seats" });
    refresh();
    return { ok: true as const, full: result.full === true };
  } catch (e) {
    logFailure(`[invoices] invoice ${id}: marking it paid failed`, e);
    return fail("server");
  }
});

/**
 * „Võta tasumine tagasi“ (D6; spec §9 of the admin UX pass replaces ruling R10): `{ id }`. Answers the status the invoice has now — `unpaid` (a
 * request set back) or `cancelled` (a receipt is cancelled and keeps its number) — so the screen says which; either way its amount comes off
 * its registration's „Laekunud summa“ (server/invoices.ts undoInvoicePaid). The paid sum moved: the seats are revalidated.
 */
export const undoInvoicePaidAction = adminAction(async (_admin, input: { id: number }) => {
  const parsed = idOnly.safeParse(input);
  if (!parsed.success) return fail("notFound");
  const { id } = parsed.data;
  try {
    const result = await undoInvoicePaid(getDb(), id, new Date());
    if (!result.ok) return fail(result.error);
    revalidatePublic({ kind: "seats" });
    refresh();
    return { ok: true as const, status: result.invoice.status === "cancelled" ? ("cancelled" as const) : ("unpaid" as const) };
  } catch (e) {
    logFailure(`[invoices] invoice ${id}: undoing the paid mark failed`, e);
    return fail("server");
  }
});

/** „Tühista arve“ (D6): `{ id }` — an unpaid invoice is cancelled and keeps its number. */
export const cancelInvoiceAction = adminAction(async (_admin, input: { id: number }) => {
  const parsed = idOnly.safeParse(input);
  if (!parsed.success) return fail("notFound");
  const { id } = parsed.data;
  try {
    const result = await cancelInvoice(getDb(), id, new Date());
    if (!result.ok) return fail(result.error);
    refresh();
    return { ok: true as const };
  } catch (e) {
    logFailure(`[invoices] invoice ${id}: the cancel failed`, e);
    return fail("server");
  }
});

/**
 * „Muuda saajat“ (D9): `{ id, name, address, company, companyCode, companyAddress }` as typed (updateInvoiceBuyer checks each). A refused field
 * comes back by name in `fields` (`required`, `tooLong`), with the words `invalid`; the form puts its own words under the fields.
 */
export const updateInvoiceBuyerAction = adminAction(async (_admin, input: { id: number } & Record<string, unknown>) => {
  const parsed = idOnly.safeParse({ id: input?.id });
  if (!parsed.success) return fail("notFound");
  const { id } = parsed.data;
  try {
    const result = await updateInvoiceBuyer(getDb(), id, input);
    if (!result.ok) return "fields" in result ? { ...fail("invalid"), fields: result.fields } : fail(result.error);
    refresh();
    return { ok: true as const };
  } catch (e) {
    logFailure(`[invoices] invoice ${id}: the buyer change failed`, e);
    return fail("server");
  }
});

const paymentOnly = z.object({ paymentId: rowId });

/** „Arveta maksed“ → „Koosta arve“ (§6.3): `{ paymentId }` — the paid payment gets its invoice (or pays the invoice it was started for). */
export const catchUpInvoiceAction = adminAction(async (_admin, input: { paymentId: number }) => {
  const parsed = paymentOnly.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "notFound" as const, text: adminEt.invoices.errors.notPayment };
  const { paymentId } = parsed.data;
  try {
    const result = await catchUpInvoice(getDb(), paymentId, new Date());
    if (!result.ok) {
      // (a payment's own words: the invoice's "notFound" and "notPaid" are about an invoice)
      const text = result.error === "notFound" ? adminEt.invoices.errors.notPayment : result.error === "notPaid" ? adminEt.invoices.errors.paymentNotPaid : adminEt.invoices.errors[result.error];
      return { ok: false as const, error: result.error, text };
    }
    refresh();
    return { ok: true as const, number: result.invoice.number };
  } catch (e) {
    logFailure(`[invoices] payment ${paymentId}: the catch-up failed`, e);
    return fail("server");
  }
});

/** The most payments one press of „Koosta {n} arvet“ takes (the page sends the whole list of „Arveta maksed“; this only bounds what a request can ask for). */
const BATCH_MAX = 500;
const batchInput = z.object({ ids: z.array(rowId).min(1).max(BATCH_MAX) });

/**
 * „Arveta maksed“ → „Koosta {n} arvet“ (admin UX pass B11, piece2-texts S3-l): `{ ids }` — the payments the panel listed; each gets its invoice, one
 * after the other, oldest first (server/invoices.ts createInvoicesForUnbilled). Answers what was done, as the work counted it: `{ ok: true, made,
 * already, failed, sellerMissing }` (the numbers made, how many were billed meanwhile, the payers whose invoice failed, Seaded's seller card empty);
 * the screen puts these in words. The page is refreshed when anything was made or was billed already, so „Arveta maksed“ and the list show the new state.
 * A list that is none, too long or not ids is `notFound` in the payment's words; a throw is `server`, logged by the error's class only.
 */
export const createInvoicesForUnbilledAction = adminAction(async (_admin, input: { ids: number[] }) => {
  const parsed = batchInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "notFound" as const, text: adminEt.invoices.errors.notPayment };
  try {
    const result = await createInvoicesForUnbilled(getDb(), parsed.data.ids, new Date());
    if (result.made.length > 0 || result.already > 0) refresh();
    return { ok: true as const, ...result };
  } catch (e) {
    logFailure("[invoices] the batch of unbilled payments failed", e);
    return fail("server");
  }
});

/**
 * Seaded → „Arve andmed“ → „Salvesta arve andmed“: the card's fields as typed (`{ company, registryCode, address, vatNumber, vatOn, vatRate,
 * prefix, nextYear, nextSeq, termDays, footer }`, the numbers as text), checked by saveInvoiceSettings. Saved: the card as the next issue
 * will take it (settings and the last number issued in the prefix's year). A refused field comes back by name in `fields`. A throw is
 * { ok: false, error: "server" }, logged by its label and the error's class only.
 */
export const saveInvoiceSettingsAction = adminAction(async (_admin, raw: unknown) => {
  try {
    const db = getDb();
    const now = new Date();
    const result = await saveInvoiceSettings(db, raw, now);
    if (!result.ok) return { ok: false as const, fields: result.fields };
    const card = await invoiceCard(db, now);
    refresh();
    return { ok: true as const, card };
  } catch (e) {
    logFailure("[invoices] the settings save failed", e);
    return { ok: false as const, error: "server" as const };
  }
});
