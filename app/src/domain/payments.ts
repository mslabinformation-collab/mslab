// Online payments' pure rules (phase 2b): the reference Montonio knows a payment by, what a registration can pay now, and Maria's word for
// how it was paid. No database, no React.

import { startOfDayTallinn, upcomingFrom } from "./calendar";
import { prepaymentDue, type RegStatus } from "./registration";

/** The prefix of every merchantReference (spec 4): MSLAB-M<the payment row's id>. */
export const ORDER_REFERENCE_PREFIX = "MSLAB-M";

/** Montonio's merchantReference of a payment row: unique per store, and a new one for every attempt (a new row). */
export const orderReference = (paymentId: number): string => `${ORDER_REFERENCE_PREFIX}${paymentId}`;

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
]);

/**
 * How a payment was made, for Maria: her notice (server/messages.ts) and the admin's "Maksed" list use this one word. `method` is
 * Montonio's code ("paymentInitiation", "cardPayments", "applePay", "googlePay", "blik"), `bank` the bank's name when there is one:
 * "Pangalink · Swedbank". An empty or unknown code is "Muu"; the code itself is never shown.
 */
export function paymentMethodLabel(method: string, bank: string): string {
  const label = METHOD_LABELS.get(method.trim().toLowerCase()) ?? "Muu";
  return [label, bank.trim()].filter(Boolean).join(" · ");
}

/** What amountDue reads of a registration: its status and payment choice, its price and what is paid, and its session. */
export type DueInput = {
  status: RegStatus;
  paymentChoice: "full" | "half";
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
 * registration, a called-off session, no price or no session. The /maksa page, Minu koolitused and the start itself all ask this.
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
