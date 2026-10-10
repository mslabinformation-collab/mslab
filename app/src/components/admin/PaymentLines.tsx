import type { PaymentRow } from "@/db/queries/payments";
import type { PaymentStatus } from "@/db/schema";
import { formatEUR } from "@/domain/money";
import { needsCheck, paymentMethodLabel } from "@/domain/payments";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { formatDate, formatTime } from "@/i18n/format";
import ui from "./ui.module.css";
import styles from "./PaymentLines.module.css";

/** A payment status's tag colour: paid ok, pending and held to look at, failed bad, refunded plain. */
export const PAYMENT_TONE: Record<PaymentStatus, string> = { paid: ui.ok, pending: ui.warn, held: ui.warn, failed: ui.bad, refunded: "" };

/**
 * A status in Maria's Estonian, never a code. A payment the bank took back after it was paid (stored as failed, with its paid_at) is
 * "Tühistatud pangas": the owner's word for a bank reversal. (Stored, a partial refund is a refund like any other: "Tagastatud".)
 */
export function paymentStatusLabel(p: { status: PaymentStatus; paidAt: Date | null }): string {
  const t = adminEt.payments;
  return p.status === "failed" && p.paidAt !== null ? t.statusVoided : t.status[p.status];
}

/**
 * How a payment was made, in Maria's Estonian ("Pangalink · Swedbank", "Kaart": domain/payments.ts paymentMethodLabel), or null while
 * nothing is known (a payment still pending has no method yet). Montonio's own code is never shown.
 */
export function paymentMethodText(p: { method: string; bank: string }): string | null {
  return p.method.trim() || p.bank.trim() ? paymentMethodLabel(p.method, p.bank) : null;
}

/**
 * Online payments as short lines (phase 2b, spec 8): when, how much, the kind (`withWhat`: and the course), how it was paid, the status, and
 * "Kontrolli Montonios" on a held payment or one voided after it was paid. A registration's drawer (under "Laekunud") and the Õpilased
 * drawer show them.
 */
export function PaymentLines({ rows, withWhat = false }: { rows: PaymentRow[]; withWhat?: boolean }) {
  const t = adminEt.payments;
  return (
    <ul className={styles.lines} data-payment-lines="">
      {rows.map((p) => {
        const method = paymentMethodText(p);
        return (
          <li key={p.id} className={styles.line} data-payment={p.reference} data-payment-status={p.status}>
            <span className={styles.when}>
              {formatDate(p.createdAt, "et")} {formatTime(p.createdAt, "et")}
            </span>
            <strong>{formatEUR(p.amountCents, "et")}</strong>
            <span>
              {t.kind[p.kind]}
              {withWhat ? ` · ${p.courseTitle ? pick(p.courseTitle, "et") : t.courseGone}` : ""}
            </span>
            {method && <span data-payment-method="">{method}</span>}
            <span className={`${ui.tag} ${PAYMENT_TONE[p.status]}`}>{paymentStatusLabel(p)}</span>
            {needsCheck(p) && (
              <span className={`${ui.tag} ${ui.bad}`} data-payment-check="">
                {t.check}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
