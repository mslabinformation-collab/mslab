import { eq } from "drizzle-orm";
import { invoices, payments, registrations } from "@/db/schema";
import { isEmail, isSampleAddress, normalizeEmail } from "@/domain/email";
import { invoiceMail } from "./account-mail";
import { invoiceForAdmin, invoicePdf } from "./invoices";
import { logNote } from "./log";
import { mailConfigured, sendMail } from "./notify";
import type { SendDeps } from "./protocols";

// Maria's „Saada õpilasele“ (invoices Task 5, spec §4, D11, rulings R1): the invoice's PDF, rendered now from its frozen row, goes by mail to
// the student's address (the invoice's buyer e-mail, which is the registration's or the payer's) and, when Maria typed one, to a second
// address („Saada ka aadressile“, say the student's accountant) for this send only. The mail is invoiceMail (account-mail.ts) in the student's
// language. It is sent while Maria waits (the answer says whether it went), it is not counted in the daily caps (it follows Maria's own tap,
// like the protocol mail), and it never goes to a sample address (a test address: `…@example.test`): that counts as sent, so the flow can be
// tried without mailing anyone. The send is recorded on the invoice (`sent_at`, and `sent_note` holding the second address when it went).
// Logs carry the invoice's id and counts only, never an address.

export type SendInvoiceResult =
  | { ok: true; secondFailed?: true }
  | { ok: false; error: "notFound" | "cancelled" | "email" | "mailFailed" };

/** The second address as Maria typed it: "" for none, the address in lower case, or null when it is no address. */
function secondAddress(raw: unknown): string | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  const address = normalizeEmail(raw);
  return address === "" || isEmail(address) ? address : null;
}

/** The language of the mail: the registration's, else the payer's (an e-course's invoice), else Estonian. */
async function localeOf(deps: Pick<SendDeps, "db">, inv: { registrationId: number | null; paymentId: number | null }): Promise<"et" | "ru"> {
  const [row] =
    inv.registrationId !== null
      ? await deps.db.select({ locale: registrations.locale }).from(registrations).where(eq(registrations.id, inv.registrationId)).limit(1)
      : inv.paymentId !== null
        ? await deps.db.select({ locale: payments.locale }).from(payments).where(eq(payments.id, inv.paymentId)).limit(1)
        : [];
  return row?.locale === "ru" ? "ru" : "et";
}

/**
 * Sends invoice `id` by mail: to its buyer's address, and to `also` (typed by Maria; blank for none; an address that is the student's own is
 * sent once). `email`: `also` is no address, nothing done. `notFound` for an unknown id, `cancelled` for a void invoice (never mailed). `mailFailed`:
 * the student's mail was not accepted (the mail is not set up here, or Resend refused it), nothing recorded. Otherwise the send is recorded at
 * `deps.now` and `ok` answers; when the second address was refused after the student's went, the note stays empty and `secondFailed` says so.
 * A paid invoice (a receipt, an online payment's) may be sent too: its mail asks for no money.
 */
export async function sendInvoice(deps: Pick<SendDeps, "db" | "env" | "siteUrl" | "now">, id: number, also: unknown): Promise<SendInvoiceResult> {
  const second = secondAddress(also);
  if (second === null) return { ok: false, error: "email" };
  const inv = await invoiceForAdmin(deps.db, id);
  if (!inv) return { ok: false, error: "notFound" };
  if (inv.status === "cancelled") return { ok: false, error: "cancelled" };
  const student = normalizeEmail(inv.buyer.email);
  const targets = [student, ...(second && second !== student ? [second] : [])];
  // (a mail that is not set up fails here before any PDF is drawn; sample addresses need no mail)
  if (targets.some((address) => !isSampleAddress(address)) && !mailConfigured(deps.env)) return { ok: false, error: "mailFailed" };
  const locale = await localeOf(deps, inv);
  const pdf = await invoicePdf(inv);
  const went: boolean[] = [];
  for (const [i, address] of targets.entries()) {
    if (isSampleAddress(address)) went.push(true);
    // (the second address's copy greets no one by name and has no „Ava minu konto“: its reader is not the student, m9)
    else went.push(await sendMail(deps.env, invoiceMail({ siteUrl: deps.siteUrl, email: address, name: inv.buyer.name, locale, invoice: inv, pdf, second: i > 0 })));
    // (the student's first: when hers is not accepted the second is not tried)
    if (!went[0]) break;
  }
  if (!went[0]) {
    logNote(`[invoices] invoice ${id}: the mail was not sent`);
    return { ok: false, error: "mailFailed" };
  }
  const secondWent = targets.length > 1 && went[1] === true;
  await deps.db
    .update(invoices)
    .set({ sentAt: deps.now, sentNote: secondWent ? targets[1] : "" })
    .where(eq(invoices.id, id));
  console.info(`[invoices] invoice ${id}: sent to ${secondWent ? 2 : 1} address${secondWent ? "es" : ""}`);
  if (targets.length > 1 && !secondWent) {
    logNote(`[invoices] invoice ${id}: the second address was not sent to`);
    return { ok: true, secondFailed: true };
  }
  return { ok: true };
}
