import { and, eq, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { invoices, payments } from "../schema";

// The payments Maria has to look at (invoices spec §6.3, payments spec 8; admin UX pass S7), as SQL conditions on `payments`. One definition for
// the lists that show them (server/invoices.ts uninvoicedPayments: „Arveta maksed“) and the menu badge of „Maksed ja arved“ that counts them
// (queries/admin.ts adminCounts).

/**
 * Paid payments no invoice names as its payment (invoices.payment_id): paid while the seller was empty, or whose invoice step failed. One started for
 * an invoice is included (its catch-up pays that invoice).
 */
export const UNINVOICED_PAID: SQL = and(
  eq(payments.status, "paid"),
  sql`not exists (select 1 from ${invoices} where ${invoices.paymentId} = ${payments.id})`,
)!;

/**
 * Payments Maria must look at in Montonio's own dashboard: held (the amount or the currency did not match), or voided after it was paid (stored
 * `failed` with its paid_at; settle.ts). The SQL of domain/payments.ts needsCheck.
 */
export const NEEDS_CHECK: SQL = or(eq(payments.status, "held"), and(eq(payments.status, "failed"), isNotNull(payments.paidAt)))!;

/** What „Maksed ja arved“ asks Maria to look at: the unbilled paid payments and the ones that need a check. */
export const NEEDS_ATTENTION: SQL = or(UNINVOICED_PAID, NEEDS_CHECK)!;
