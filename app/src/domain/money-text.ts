import { formatEUR } from "@/domain/money";

// The two spellings of an amount in the admin's text, in one place. The A screens wrote them five times over (InvoiceRow, MoneyCard, the registrations
// page, the cancel form of RegistrationForms, messages.ts): formatEUR(cents, "et"), and the same with its euro sign cut off for a sentence that writes
// the sign itself („Laekunud {x} €“, „väheneb {x} €“). Pure and browser-safe (a browser file: tests/unit/old-safari.test.ts).
//
// Not domain/invoice.ts' `euro`: that one is the invoice's own spelling ("175,00 €": always two cents, no-break spaces) and stays as it is.

/** "145,50 €" / "1 290 €": an amount with its euro sign, as the admin and the e-mails write it (Estonian; cents only when there are some; regular spaces). */
export function euro(cents: number): string {
  return formatEUR(cents, "et");
}

/** "145,50" / "1 290": the amount without its euro sign, for a text that writes the sign itself. */
export function euroBare(cents: number): string {
  return euro(cents).replace(/ €$/, "");
}
