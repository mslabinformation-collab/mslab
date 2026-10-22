import type { PaymentRow } from "@/db/queries/payments";
import type { PaymentStatus } from "@/db/schema";
import { formatEUR } from "@/domain/money";
import { isCheckReason, needsCheck, paymentMethodLabel, type CheckReason } from "@/domain/payments";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { formatDate, formatTime } from "@/i18n/format";
import ui from "./ui.module.css";
import styles from "./PaymentLines.module.css";

/**
 * A payment status's tag colour: paid ok, pending and held to look at, failed bad, refunded plain, replaced („Asendatud“, B22: an older order
 * a newer attempt took the place of) muted.
 */
export const PAYMENT_TONE: Record<PaymentStatus, string> = { paid: ui.ok, pending: ui.warn, held: ui.warn, failed: ui.bad, refunded: "", replaced: ui.muted };

/**
 * A status in Maria's Estonian, never a code. A payment the bank took back after it was paid (stored as failed, with its paid_at) is
 * "Tühistatud pangas": the owner's word for a bank reversal. (Stored, a partial refund is a refund like any other: "Tagastatud".)
 */
export function paymentStatusLabel(p: { status: PaymentStatus; paidAt: Date | null }): string {
  const t = adminEt.payments;
  return p.status === "failed" && p.paidAt !== null ? t.statusVoided : t.status[p.status];
}

/** A held payment's check reason in Maria's Estonian (B22): "double" is „Topeltmakse — tagasta“. */
export const checkReasonLabel = (reason: CheckReason): string => adminEt.payments.reason[reason];

/**
 * What a payment Maria must check (domain/payments.ts needsCheck) says: its check reason's words when it has one this code knows
 * („Topeltmakse — tagasta“, P-8), else "Kontrolli Montonios" (a held amount, a bank reversal, or a reason a newer version wrote).
 */
export function checkText(p: { checkReason: string | null }): string {
  return isCheckReason(p.checkReason) ? checkReasonLabel(p.checkReason) : adminEt.payments.check;
}

/**
 * How a payment was made, in Maria's Estonian ("Pangalink · Swedbank", "Kaart": domain/payments.ts paymentMethodLabel), or null while
 * nothing is known (a row with no method recorded: a payment started before the start recorded its method, instalments D5, and not paid
 * since; a pending one started since shows the method it was started with, „Pangalink“ or „Järelmaks (Inbank)“). Montonio's own code is
 * never shown.
 */
export function paymentMethodText(p: { method: string; bank: string }): string | null {
  return p.method.trim() || p.bank.trim() ? paymentMethodLabel(p.method, p.bank) : null;
}

/**
 * Online payments as short lines (phase 2b, spec 8): when, how much, the kind (`withWhat`: and the course), how it was paid, the status, and
 * "Kontrolli Montonios" on a held payment or one voided after it was paid — or, for a held one with a check reason, that reason („Topeltmakse —
 * tagasta“, B22). A registration's drawer (under "Laekunud") and the Õpilased drawer show them (without replaced orders: listPaymentsOf).
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
                {checkText(p)}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
