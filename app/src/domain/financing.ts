// Järelmaks (Inbank), the pure rules (instalments, Task 1; spec §2 D2–D5, D8, §4): when the choice is offered and when it is allowed, the
// settings toggle as read, the details Montonio passes on to Inbank's own form, and how long an attempt holds a seat. No database, no React, no
// Montonio: the registration form, the cart and the account's „Maksa“ run it in the browser (no lookbehind here, tests/unit/old-safari.test.ts).

import { SEAT_HOLD_MS } from "./sessions";

/** Inbank's range through Montonio's `hirePurchase` in Estonia (D2, D4): 100–5000 €, both inclusive, in cents. */
export const FINANCING_MIN_CENTS = 10_000;
export const FINANCING_MAX_CENTS = 500_000;

/** The `settings` key (D4, §3): `{ enabled: boolean }`, off by default. Needs no migration. */
export const FINANCING_KEY = "financing";

/** Seaded → Järelmaks (Inbank): Maria's toggle, switched on once her Montonio contract includes financing. */
export type FinancingSettings = { enabled: boolean };

/** The toggle as stored, read defensively: only `{ enabled: true }` is on; a missing row, a wrong shape or any other value is off. */
export function readFinancingSettings(value: unknown): FinancingSettings {
  const enabled = typeof value === "object" && value !== null && !Array.isArray(value) && (value as { enabled?: unknown }).enabled === true;
  return { enabled };
}

/**
 * Is Järelmaks (Inbank) a choice at all (D4)? Maria has switched it on, Montonio payments are on, and the price is 100–5000 € inclusive. No price
 * (a course without one) is no choice. The course page's line, the form's radio and the cart's choice show on this.
 */
export function financingOffered(o: { enabled: boolean; paymentsOn: boolean; priceCents: number | null }): boolean {
  return o.enabled && o.paymentsOn && o.priceCents !== null && o.priceCents >= FINANCING_MIN_CENTS && o.priceCents <= FINANCING_MAX_CENTS;
}

/**
 * May this payment go to Inbank now (§4, "Which amount may go to Inbank")? Offered, and nothing paid yet with the whole price due: a registration
 * Maria has recorded a part of, or an invoice that asks for a part, can only be paid by bank. `dueCents` is what „Maksa“ would charge (payableDue).
 */
export function financingAllowed(o: { enabled: boolean; paymentsOn: boolean; priceCents: number | null; paidCents: number; dueCents: number }): boolean {
  return financingOffered(o) && o.paidCents === 0 && o.dueCents === o.priceCents;
}

/**
 * What Montonio's `billingAddress` holds for a financing order (D8): her name and e-mail, and her phone only when it is Estonian. `phoneCountry` is
 * the calling code "372", as Montonio's orders guide gives it ("The customer's phone country. (e.g 372)"), with the national digits in `phoneNumber`.
 */
export type BillingAddress = { firstName: string; lastName: string; email: string; phoneNumber?: string; phoneCountry?: "372" };

/**
 * An Estonian phone number in national digits, or null (D8, §4). Spaces, dashes, dots and brackets are taken out first. It is Estonian when it is
 * +372 or 372 followed by 7–8 digits, or 7–8 digits starting with 5 (mobile) or 3–8 (landline). A number of another country, or one of no number's
 * shape, is null: Inbank needs a number of the shop's country, and the student types her own in Inbank's form instead.
 */
export function estonianPhone(raw: string): string | null {
  const compact = raw.replace(/[\s\-().]/g, "");
  const prefixed = /^(?:\+372|372)(\d{7,8})$/.exec(compact);
  if (prefixed) return prefixed[1];
  return /^[3-8]\d{6,7}$/.test(compact) ? compact : null;
}

/**
 * The `billingAddress` of a financing order (D8, §4). `lastName` is the last word of her name and `firstName` everything before it; a one-word
 * name goes in both, as Montonio asks for both. A name with nothing in it (the forms never store one) falls back to the e-mail's local part, so
 * the address is still valid. Her phone goes as `phoneNumber` (national digits) with `phoneCountry: "372"` only when estonianPhone accepts it.
 * Nothing else is sent: personal ID codes are never collected.
 */
export function billingAddressOf(o: { name: string; email: string; phone?: string | null }): BillingAddress {
  const words = o.name.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) words.push(o.email.split("@")[0] || "-");
  const lastName = words[words.length - 1];
  const firstName = words.length > 1 ? words.slice(0, -1).join(" ") : lastName;
  const phone = o.phone ? estonianPhone(o.phone) : null;
  return { firstName, lastName, email: o.email, ...(phone ? { phoneNumber: phone, phoneCountry: "372" as const } : {}) };
}

/**
 * How long a Järelmaks (Inbank) attempt holds its seat, and the same for its re-send window and the daily check's age (D5): 60 minutes, so an
 * application in progress is not cut off (Montonio: this covers 99%). Montonio's `expiresIn` for the order is the same, in minutes.
 */
export const FINANCING_ATTEMPT_MS = 60 * 60_000;

/**
 * Is this Montonio method code the järelmaks (`hirePurchase`)? Case and spaces aside, as Montonio's codes are read everywhere (domain/payments.ts
 * METHOD_LABELS). Any other code, or none recorded (a payment row from before the methods were stored), is not: it is a bank attempt. The
 * database reads a row's method by the same rule (db/queries/payments.ts hirePurchaseRow).
 */
export function isHirePurchase(method: string): boolean {
  return method.trim().toLowerCase() === "hirepurchase";
}

/** The window of an attempt by its Montonio method: 60 minutes for `hirePurchase`, the bank's 30 (SEAT_HOLD_MS) for any other, or none recorded. */
export function attemptWindowMs(method: string): number {
  return isHirePurchase(method) ? FINANCING_ATTEMPT_MS : SEAT_HOLD_MS;
}
