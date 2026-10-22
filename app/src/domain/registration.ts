export type RegStatus = "awaiting_prepayment" | "confirmed" | "cancelled";

/**
 * How a registration pays: the whole price at once, half now and half on the training day, or Järelmaks (Inbank) (instalments, spec D2/D3):
 * always the whole price, paid to Maria at once by Inbank through Montonio. The values of the database enum `payment_choice` (db/schema.ts payChoice).
 */
export type PaymentChoice = "full" | "half" | "financing";

/** What a registration owes first: half the price (rounded up to the cent) for „half“, the whole price for „full“ and for Järelmaks (Inbank). */
export function prepaymentDue(cents: number, choice: PaymentChoice): number {
  return choice === "half" ? Math.ceil(cents / 2) : cents;
}

// Maria: a place is confirmed only after at least 50% has been paid.
export function registrationStatusAfterPayment(r: { status: RegStatus; paidCents: number }, totalCents: number): RegStatus {
  if (r.status === "cancelled") return "cancelled";
  return r.paidCents * 2 >= totalCents ? "confirmed" : "awaiting_prepayment";
}

/**
 * The price a registration's payment is measured against: the e-learning price, or for a contact course the group
 * price (group registration) or the individual price. null when the course has no such price.
 */
export function registrationPrice(
  course: { type: "e_learning" | "contact"; price: number | null; priceGroup: number | null; priceIndividual: number | null },
  kind: "group" | "individual",
): number | null {
  if (course.type === "e_learning") return course.price;
  return kind === "group" ? course.priceGroup : course.priceIndividual;
}

/** Longest admin note on a registration (the drawer's "Märkus"). */
export const NOTE_MAX = 2000;
