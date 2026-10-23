"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { euro, type InvoiceKind, type OpenAmounts } from "@/domain/invoice";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate } from "@/i18n/format";
import { createInvoiceAction } from "@/server/actions/admin-invoices";
import type { InvoiceView } from "./invoice-view";
import { InvoiceCatchUp } from "./InvoiceCatchUp";
import { InvoiceRow } from "./InvoiceRow";
import { PaidFields, type ManualMethod } from "./PaidFields";
import { PhoneFold } from "./PhoneFold";
import ui from "./ui.module.css";
import styles from "./InvoiceBlock.module.css";

// The registration drawer's „Arved“ (invoices Task 5, spec §5, D5): the registration's invoices, each with the actions its state allows
// (InvoiceRow); its paid online payments that have no invoice yet (they are in „Arveta maksed“: the final review's I1), each with its own
// „Koosta arve“ (InvoiceCatchUp, the catch-up); and „Koosta arve“. It offers exactly the amounts still open for the kind chosen (domain/invoice.ts
// openAmounts, read by the page: not yet covered by an unpaid or paid invoice of the registration, nor by such a payment; a request never for
// money typed by hand into „Laekunud summa“, a receipt for exactly that money: m4) as radio choices, and one of two kinds: „Maksmiseks“ (a
// request to pay, unpaid) and „Juba tasutud“ (a receipt for money already received; it asks the day and the way, and does not touch „Laekunud
// summa“); a kind with nothing to offer cannot be chosen. Without a seller (D3) „Koosta arve“ is a link to Seaded → Arve andmed instead, and the
// payments have no button. Only one „Koosta arve“ is ever in view (README A2 drawer 4): while a paid online payment waits for its invoice, its row's
// button is the one and the generic one is not drawn; with none waiting, the generic one is. On a phone the whole block is a folded row (PhoneFold:
// „Arved … 1 tasumata ▸“, README A2 phone drawer; P-3's summaries). The page is refreshed by the action, so the list then shows the new invoice. This
// file runs on old iPads: no regular expression with a lookbehind, here or in anything it imports (tests/unit/old-safari.test.ts).

type Mode = "request" | "receipt";
/** A paid online payment of the registration that no invoice names (domain/invoice.ts uninvoicedOf), as the block lists it. */
export type UninvoicedView = {
  paymentId: number;
  amountCents: number;
  /** When it was paid (ISO). */
  paidAt: string;
  /** The number of the unpaid invoice its catch-up will pay (it was started for it), or null: the catch-up makes a new one. */
  pays: string | null;
};
type Line = { tone: "idle" | "busy" | "done" | "error"; text: string };
const IDLE: Line = { tone: "idle", text: "" };
const toneClass = (tone: Line["tone"]) => (tone === "error" ? ui.error : tone === "done" ? ui.success : ui.hint);

export function InvoiceBlock({
  registrationId,
  invoices,
  uninvoiced,
  open,
  sellerReady,
  canCreate,
  today,
}: {
  registrationId: number;
  invoices: InvoiceView[];
  /** Its paid online payments that no invoice names yet, the oldest first. */
  uninvoiced: UninvoicedView[];
  /** The amounts still to invoice by kind (openAmounts), in the order the choices come. */
  open: OpenAmounts;
  /** Seaded → Arve andmed has a company, a registry code and an address (D3). */
  sellerReady: boolean;
  /** The registration has a price to invoice against (a course without one has no open amounts). */
  canCreate: boolean;
  /** Today in Tallinn, "YYYY-MM-DD": the day a receipt or a mark starts from, and the latest it may be. */
  today: string;
}) {
  const t = adminEt.invoices.block;
  const uid = useId();
  const form = useRef<HTMLFormElement>(null);
  const [opened, setOpened] = useState(false);
  const [kind, setKind] = useState<InvoiceKind | null>(null);
  const [mode, setMode] = useState<Mode>("request");
  const [date, setDate] = useState(today);
  const [method, setMethod] = useState<ManualMethod>("bank");
  const [line, setLine] = useState<Line>(IDLE);
  const [pending, start] = useTransition();

  // the kind follows what it can offer: one with no amount cannot be chosen, and the other is shown
  const offers = { request: open.request.length > 0, receipt: open.receipt.length > 0 };
  const shownMode: Mode = offers[mode] ? mode : offers.request ? "request" : "receipt";
  const amounts = open[shownMode];
  // the choice follows what is open: after an invoice is made the amounts change, and a kind no longer open falls back to the first
  const chosen = amounts.some((o) => o.kind === kind) ? kind : (amounts[0]?.kind ?? null);
  // each paid online payment without an invoice has its own „Koosta arve“ (the catch-up): while any is waiting, the generic one is not drawn
  const catchUps = sellerReady && uninvoiced.length > 0;
  // the folded row's words (P-3): the invoices still to pay, else that all are paid, else that there are none (a cancelled one is no invoice to speak of)
  const live = invoices.filter((i) => i.status !== "cancelled");
  const unpaid = live.filter((i) => i.status === "unpaid").length;
  const summary = unpaid > 0 ? fill(t.fold.unpaid, { n: unpaid }) : live.length > 0 ? t.fold.paid : t.fold.none;

  useEffect(() => {
    if (opened) form.current?.querySelector<HTMLElement>("input")?.focus();
  }, [opened]);

  const create = (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (pending || chosen === null) return;
    setLine({ tone: "busy", text: t.working });
    start(async () => {
      const r = await createInvoiceAction({ registrationId, kind: chosen, mode: shownMode, ...(shownMode === "receipt" ? { paidAt: date, method } : {}) });
      if (!r.ok) return setLine({ tone: "error", text: r.text });
      setOpened(false);
      setMode("request");
      setLine({ tone: "done", text: fill(t.done, { number: r.number }) });
    });
  };

  return (
    <PhoneFold title={adminEt.invoices.title} summary={summary} className={styles.block} bodyClassName={styles.blockBody} data-registration-invoices="">
      {invoices.length === 0 ? (
        <p className={ui.muted} data-invoices-none="">
          {t.none}
        </p>
      ) : (
        <ul className={styles.list} data-invoice-list="">
          {invoices.map((inv) => (
            <InvoiceRow key={inv.id} invoice={inv} today={today} />
          ))}
        </ul>
      )}

      {uninvoiced.length > 0 && (
        <ul className={styles.list} data-invoice-uninvoiced="">
          {uninvoiced.map((p) => (
            <li key={p.paymentId} className={styles.row} data-uninvoiced-payment={p.paymentId}>
              <p className={styles.meta} data-uninvoiced-line="">
                {fill(t.uninvoiced, { amount: euro(p.amountCents), date: formatDate(new Date(p.paidAt), "et") })}
              </p>
              <p className={styles.meta} data-uninvoiced-pays="">
                {p.pays ? fill(adminEt.invoices.uninvoiced.pays, { number: p.pays }) : adminEt.invoices.uninvoiced.makes}
              </p>
              {sellerReady && <InvoiceCatchUp paymentId={p.paymentId} />}
            </li>
          ))}
        </ul>
      )}

      {canCreate &&
        (!sellerReady ? (
          <p className={styles.seller} data-invoice-need-seller="">
            <Link className={ui.link} href="/admin/seaded#arve">
              {t.needSeller}
            </Link>
          </p>
        ) : !offers.request && !offers.receipt ? (
          <p className={ui.hint} data-invoice-all-covered="">
            {t.allCovered}
          </p>
        ) : catchUps ? null : !opened ? (
          <div>
            <button type="button" className={`${ui.btn} ${ui.smallBtn}`} onClick={() => setOpened(true)} data-invoice-create="">
              {t.create}
            </button>
          </div>
        ) : (
          <form ref={form} className={`${styles.panel} ${styles.create}`} onSubmit={create} noValidate data-invoice-create-form="">
            <fieldset className={styles.fieldset}>
              <legend className={ui.legend}>{t.amount}</legend>
              <div className={styles.choices}>
                {amounts.map((o) => (
                  <label key={o.kind} className={styles.choice}>
                    <input type="radio" name={`${uid}-kind`} value={o.kind} checked={chosen === o.kind} onChange={() => setKind(o.kind)} data-invoice-kind={o.kind} />
                    <span>{`${o.part} · ${euro(o.cents)}`}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className={styles.fieldset}>
              <legend className={ui.legend}>{t.kind}</legend>
              <div className={styles.choices}>
                <label className={styles.choice}>
                  <input
                    type="radio"
                    name={`${uid}-mode`}
                    value="request"
                    checked={shownMode === "request"}
                    disabled={!offers.request}
                    onChange={() => setMode("request")}
                    data-invoice-mode="request"
                  />
                  <span>{t.forPayment}</span>
                </label>
                <label className={styles.choice}>
                  <input
                    type="radio"
                    name={`${uid}-mode`}
                    value="receipt"
                    checked={shownMode === "receipt"}
                    disabled={!offers.receipt}
                    onChange={() => setMode("receipt")}
                    data-invoice-mode="receipt"
                  />
                  <span>{t.alreadyPaid}</span>
                </label>
              </div>
            </fieldset>
            <p className={ui.hint} data-invoice-mode-hint="">
              {shownMode === "request" ? t.forPaymentHint : t.alreadyPaidHint}
            </p>
            {shownMode === "receipt" && <PaidFields name={`${uid}-receipt`} date={date} method={method} today={today} onDate={setDate} onMethod={setMethod} dateLabel={t.paidDate} methodLabel={t.paidMethod} />}
            <div className={styles.panelActions}>
              <button type="submit" className={`${ui.btn} ${ui.smallBtn}`} aria-disabled={pending || undefined} data-invoice-create-confirm="">
                {pending ? t.working : t.submit}
              </button>
              <button
                type="button"
                className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}
                onClick={() => {
                  setOpened(false);
                  setLine(IDLE);
                }}
              >
                {t.cancel}
              </button>
            </div>
          </form>
        ))}
      <p role="status" className={`${styles.status} ${toneClass(line.tone)}`} data-invoice-create-status="">
        {line.text}
      </p>
    </PhoneFold>
  );
}
