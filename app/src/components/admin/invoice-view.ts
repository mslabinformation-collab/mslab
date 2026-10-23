import type { InvoiceBuyer, InvoiceKind, InvoiceStatus, PaidMethod } from "@/domain/invoice";
import type { AdminInvoice } from "@/server/invoices";

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
  /**
   * Unpaid, but its online payment is paid and waits for its catch-up in „Arveta maksed“ (R14; the final review's m2): its money is in, so it is
   * neither sent as a request nor marked paid (markInvoicePaid refuses it).
   */
  paidOnline: boolean;
  /** Paid, its online payment refunded or voided since (spec D5, the final review's I3): it reads „Tagastatud“. */
  refunded: boolean;
  /**
   * The paid mark added the amount to „Laekunud summa“ (server/invoices.ts). The screens do not tell a receipt by it any more: a receipt is a paid
   * invoice with no due date (`dueAt === null`), and its undo — every receipt's — lowers „Laekunud summa“ (S3-f; `takeBack`).
   */
  paidAdds: boolean;
  /**
   * What „Võta tasumine tagasi“ of a receipt will do to its registration (domain/invoice.ts receiptTakeBack: the sum the server takes off „Laekunud
   * summa“, capped at what no other paid invoice covers, and whether a confirmed registration then falls under 50 %), for the S3-f panel. Only
   * where the page has the registration (its drawer); null elsewhere (the Arved list), where the panel shows the receipt's own amount and says
   * nothing of the status.
   */
  takeBack: { cents: number; backToAwaiting: boolean } | null;
  sentAt: string | null;
  /** The second address of the last send, or "". */
  sentNote: string;
  buyer: InvoiceBuyer;
  registrationId: number | null;
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * An invoice of server/invoices.ts's reads for Maria (invoicesOfRegistration, listInvoices: AdminInvoice, the row and its R14 and refund flags)
 * as the screens take it. `takeBack`: what undoing it would do to the registration (InvoiceView.takeBack), for a receipt of a drawer's registration.
 */
export function invoiceView(inv: AdminInvoice, takeBack: InvoiceView["takeBack"] = null): InvoiceView {
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
    online: inv.paidMethod === "montonio" || inv.paidMethod === "financing" || inv.paymentId !== null,
    paidOnline: inv.paidOnline,
    refunded: inv.refunded,
    paidAdds: inv.paidAdds,
    takeBack,
    sentAt: iso(inv.sentAt),
    sentNote: inv.sentNote,
    buyer: inv.buyer,
    registrationId: inv.registrationId,
  };
}
