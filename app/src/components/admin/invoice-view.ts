import type { Invoice } from "@/db/schema";
import type { InvoiceBuyer, InvoiceKind, InvoiceStatus, PaidMethod } from "@/domain/invoice";

// One invoice as Maria's screens get it (invoices Task 5): plain data the server page hands to the client components InvoiceRow and
// InvoiceBlock — dates as ISO text, no row id but the invoice's own and its registration's, nothing the screens do not show.

export type InvoiceView = {
  id: number;
  number: string;
  kind: InvoiceKind;
  /** What the invoice is for, in words: "Ettemaks 50%" (the frozen line's part). */
  part: string;
  course: string;
  session: string;
  amountCents: number;
  status: InvoiceStatus;
  issuedAt: string;
  dueAt: string | null;
  paidAt: string | null;
  paidMethod: PaidMethod | null;
  /** Paid online (Montonio's): the site's, never undone or changed by Maria (server/invoices.ts undoInvoicePaid's `notManual`). */
  online: boolean;
  /** The paid mark added the amount to „Laekunud summa“: its undo takes it back; a receipt's undo cancels it (ruling R10). */
  paidAdds: boolean;
  sentAt: string | null;
  /** The second address of the last send, or "". */
  sentNote: string;
  buyer: InvoiceBuyer;
  registrationId: number | null;
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function invoiceView(inv: Invoice): InvoiceView {
  return {
    id: inv.id,
    number: inv.number,
    kind: inv.kind,
    part: inv.line.part,
    course: inv.line.course,
    session: inv.line.session,
    amountCents: inv.amountCents,
    status: inv.status,
    issuedAt: inv.issuedAt.toISOString(),
    dueAt: iso(inv.dueAt),
    paidAt: iso(inv.paidAt),
    paidMethod: inv.paidMethod,
    online: inv.paidMethod === "montonio" || inv.paymentId !== null,
    paidAdds: inv.paidAdds,
    sentAt: iso(inv.sentAt),
    sentNote: inv.sentNote,
    buyer: inv.buyer,
    registrationId: inv.registrationId,
  };
}
