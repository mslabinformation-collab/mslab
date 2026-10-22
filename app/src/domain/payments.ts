// Online payments' pure rules (phase 2b): the reference Montonio knows a payment by, what a registration can pay now (with an unpaid
// invoice, invoices Task 4: its amount), and Maria's word for how it was paid. No database, no React: the account's card runs it in the
// browser.

import type { Invoice, PaymentStatus } from "@/db/schema";
import { isSlug } from "@/lib/slug";
import { startOfDayTallinn, upcomingFrom } from "./calendar";
import { isHirePurchase } from "./financing";
import type { InvoiceKind } from "./invoice";
import { prepaymentDue, type PaymentChoice, type RegStatus } from "./registration";

/**
 * The prefix of production's merchantReferences (spec 4): MSLAB-M<the payment row's id>. Every other place has a prefix of its own
 * (server/payments/montonio.ts montonioConfig): while production runs on the sandbox store, a local database numbers its payments from 1 as
 * production's does, and with one prefix a local order would replace production's order of the same reference in the one store, and its
 * webhook, signed with the same keys, could settle production's row.
 */
export const ORDER_REFERENCE_PREFIX = "MSLAB-M";
/** The prefix on this machine: `next dev`, the e2e run, a local production build, `vercel dev`. */
export const LOCAL_REFERENCE_PREFIX = "MSLAB-L";
/** The prefix of a Vercel preview deployment. */
export const PREVIEW_REFERENCE_PREFIX = "MSLAB-P";

/** 2 to 16 capitals, digits and hyphens, starting with a capital and never ending in a digit: the id that follows can never run into it. */
const PREFIX = /^[A-Z][A-Z0-9-]{0,14}[A-Z-]$/;

/** Can `value` be a reference prefix (MONTONIO_REFERENCE_PREFIX)? */
export const isReferencePrefix = (value: string): boolean => PREFIX.test(value);

/** Montonio's merchantReference of a payment row: `prefix` (this environment's) and the row's id; unique per store, a new one for every attempt. */
export const orderReference = (paymentId: number, prefix: string): string => `${prefix}${paymentId}`;

/**
 * The payment id in a merchantReference of this environment (`prefix`), or null: another environment's reference, or none of ours at all. Only
 * the exact form orderReference writes counts (no leading zero, no sign, no space, a safe integer).
 */
export function referenceId(reference: string, prefix: string): number | null {
  if (!reference.startsWith(prefix)) return null;
  const digits = reference.slice(prefix.length);
  if (!/^[1-9][0-9]{0,15}$/.test(digits)) return null;
  const id = Number(digits);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Montonio's payment methods in Maria's Estonian (the owner's decision of 09.10: no English Montonio codes in her texts). Keyed by the
 * lower-cased code, in a Map: a code is data from outside and must never reach an object's own properties ("constructor").
 */
const METHOD_LABELS: ReadonlyMap<string, string> = new Map([
  ["paymentinitiation", "Pangalink"],
  ["cardpayments", "Kaart"],
  ["applepay", "Apple Pay"],
  ["googlepay", "Google Pay"],
  ["blik", "BLIK"],
  // Inbank's instalments through Montonio (instalments, spec D6): the method of a financing order is `hirePurchase`
  ["hirepurchase", "Järelmaks (Inbank)"],
]);

/**
 * How a payment was made, for Maria: her notice (server/messages.ts) and the admin's "Maksed" list use this one word. `method` is
 * Montonio's code ("paymentInitiation", "cardPayments", "applePay", "googlePay", "blik", "hirePurchase"), `bank` the bank's name when there is one:
 * "Pangalink · Swedbank". An empty or unknown code is "Muu"; the code itself is never shown. A järelmaks takes no provider after it: Montonio
 * names Inbank as its provider, which „Järelmaks (Inbank)“ says already.
 */
export function paymentMethodLabel(method: string, bank: string | null): string {
  const label = METHOD_LABELS.get(method.trim().toLowerCase()) ?? "Muu";
  return isHirePurchase(method) ? label : [label, (bank ?? "").trim()].filter(Boolean).join(" · ");
}

/** What amountDue reads of a registration: its status and payment choice, its price and what is paid, and its session. */
export type DueInput = {
  status: RegStatus;
  paymentChoice: PaymentChoice;
  /** The registration's price (domain/registration.ts registrationPrice), cents; null without one. */
  priceCents: number | null;
  paidCents: number;
  /** The session's start; null for a registration without one (an individual course). */
  startsAt: Date | null;
  sessionCancelled: boolean;
};

/** What can be paid online now: the prepayment still due, or the rest after it (cents), or nothing. */
export type Due = { kind: "prepayment" | "balance"; cents: number } | { kind: "none" };

const NONE: Due = { kind: "none" };

/**
 * The amount a registration can pay online now (phase 2b, spec 6.3, D5). Not confirmed: the prepayment (domain/registration.ts
 * prepaymentDue) minus what is paid, while the session has not begun (calendar.ts upcomingFrom, the booking's own "upcoming"). Confirmed:
 * the price minus what is paid, until the training day begins in Tallinn (paying on the day is Maria's, by hand). Nothing for a cancelled
 * registration, a called-off session, no price or no session. The /maksa page, Minu koolitused and the start itself all ask this (each through
 * payableDue, which charges an unpaid invoice's amount instead).
 */
export function amountDue(r: DueInput, now: Date): Due {
  if (r.status === "cancelled" || r.sessionCancelled || r.priceCents === null || r.startsAt === null) return NONE;
  if (r.status === "awaiting_prepayment") {
    const cents = prepaymentDue(r.priceCents, r.paymentChoice) - r.paidCents;
    return cents > 0 && r.startsAt >= upcomingFrom(now) ? { kind: "prepayment", cents } : NONE;
  }
  const cents = r.priceCents - r.paidCents;
  return cents > 0 && now < startOfDayTallinn(r.startsAt) ? { kind: "balance", cents } : NONE;
}

/** What „Maksa" charges for an invoice (spec D5): an unpaid invoice's whole amount; null for one that is paid or cancelled. */
export function invoiceDue(inv: Pick<Invoice, "status" | "amountCents">): { kind: "invoice"; cents: number } | null {
  return inv.status === "unpaid" && inv.amountCents > 0 ? { kind: "invoice", cents: inv.amountCents } : null;
}

/**
 * The kind of the online payment of an invoice (D5): a prepayment or a whole sum is paid as the prepayment is, the rest as the rest. (An
 * e-course's invoice is only ever born paid, never paid by „Maksa".)
 */
export const invoicePaymentKind = (kind: InvoiceKind): "prepayment" | "balance" => (kind === "balance" ? "balance" : "prepayment");

/** What „Maksa" charges (payableDue): amountDue's answer, or an unpaid invoice's amount with that invoice's id (`invoiceId`). */
export type PayableDue = Due | { kind: "prepayment" | "balance"; cents: number; invoiceId: number };

/**
 * What „Maksa" charges a registration now (D5): while it has an unpaid invoice (`invoice`: its latest that may be charged, server/invoices.ts
 * unpaidInvoiceOf), exactly that invoice's amount, as its kind's payment (invoicePaymentKind), with its id — the invoice the payment pays —
 * at any time: amountDue's window is not the invoice's, so it is payable on the course day too. Nothing for a cancelled registration or a
 * session called off (as amountDue says). Without one (or with one no longer unpaid): amountDue, with no invoice. The start, the /maksa page
 * and the account's card (AccountCourseCard onlineDue, with the card's `openInvoice`, client-data.ts) all ask this, so the button says what
 * the start will charge.
 */
export function payableDue(r: DueInput, invoice: Pick<Invoice, "id" | "kind" | "status" | "amountCents"> | null, now: Date): PayableDue {
  const charge = invoice ? invoiceDue(invoice) : null;
  if (!invoice || !charge) return amountDue(r, now);
  if (r.status === "cancelled" || r.sessionCancelled) return NONE;
  return { kind: invoicePaymentKind(invoice.kind), cents: charge.cents, invoiceId: invoice.id };
}

/** What the bank's way back says (spec 6.5): paid, still pending, or not paid. */
export type PaymentOutcome = "makstud" | "pooleli" | "katkestatud";

/**
 * What /makse shows: the outcome, what was paid for, and the way on — the registration's "Maksa" token for "Proovi uuesti", or the e-course's
 * slug ("Ava e-koolitus" after a purchase, the cart for a retry). null where there is none. Nothing else is ever in it: no address, no
 * Montonio uuid, no amount (the fragment is only the payer's browser's, but it stays in its history).
 * `kind` "jarelmaks" (instalments §4): the payment was a Järelmaks (Inbank) application (Montonio's `hirePurchase`) that is not paid. The page
 * words it as an application (a declined or abandoned one stays pending at Montonio for 7 days), and tells a registration from an e-course by the
 * way on it was given: `payToken` or `course`. A paid one reads like any paid payment (its kind is the registration's or the e-course's), so
 * "jarelmaks" is only ever on a result that is pooleli or katkestatud.
 */
export type ResultView = { outcome: PaymentOutcome; kind: "registreering" | "ekoolitus" | "jarelmaks" | null; payToken: string | null; course: string | null };

/** /makse's fragment: tulemus, liik, and maksa or kursus when they are given. */
export function resultFragment(v: ResultView): string {
  const q = new URLSearchParams({ tulemus: v.outcome });
  if (v.kind) q.set("liik", v.kind);
  if (v.payToken) q.set("maksa", v.payToken);
  if (v.course) q.set("kursus", v.course);
  return q.toString();
}

const OUTCOMES: readonly string[] = ["makstud", "pooleli", "katkestatud"];

/** /makse's fragment read back, or null when it carries no result. A value that cannot be ours (not a token, not a slug) is dropped. */
export function parseResultFragment(hash: string): ResultView | null {
  const q = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const outcome = q.get("tulemus");
  if (!outcome || !OUTCOMES.includes(outcome)) return null;
  const kind = q.get("liik");
  const token = q.get("maksa");
  const course = q.get("kursus");
  return {
    outcome: outcome as PaymentOutcome,
    kind: kind === "registreering" || kind === "ekoolitus" || kind === "jarelmaks" ? kind : null,
    payToken: token && /^[A-Za-z0-9_-]{20,100}$/.test(token) ? token : null,
    course: course && isSlug(course) ? course : null,
  };
}

/**
 * A payment Maria must look at in Montonio's own dashboard (spec 8): held (paid, but not counted: the amount or the currency did not match, or
 * it is a second payment, its CheckReason), or failed after it was paid (the bank voided it). The admin marks it "Kontrolli Montonios", or
 * with its reason's words when it has one ("Topeltmakse — tagasta"). A replaced order (B22) is not one: no money of it has arrived.
 */
export function needsCheck(p: { status: PaymentStatus; paidAt: Date | null }): boolean {
  return p.status === "held" || (p.status === "failed" && p.paidAt !== null);
}

/**
 * Why a held payment waits for Maria (B22; payments.check_reason stores the code): "double" — a second payment of something paid in full (a
 * replaced order paid after its registration was, a late järelmaks, an e-course paid twice; server/payments/settle.ts), which she refunds in
 * Montonio. The words are the admin's (adminEt.payments.reason, components/admin/PaymentLines.tsx checkReasonLabel): this module also runs in
 * the student's browser, which never needs them.
 */
export type CheckReason = "double";

/** Every CheckReason there is. */
export const CHECK_REASONS: readonly CheckReason[] = ["double"];

/** Is `value` a CheckReason this code knows? (A code that a newer version stored, or none, is not: the row is then a plain check.) */
export const isCheckReason = (value: unknown): value is CheckReason => typeof value === "string" && (CHECK_REASONS as readonly string[]).includes(value);
