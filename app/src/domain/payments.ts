// Online payments' pure rules (phase 2b): the reference Montonio knows a payment by, and Maria's word for how it was paid. No database,
// no React.

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
