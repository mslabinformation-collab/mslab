"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { euro, type InvoiceKind, type OpenAmount } from "@/domain/invoice";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { createInvoiceAction } from "@/server/actions/admin-invoices";
import type { InvoiceView } from "./invoice-view";
import { InvoiceRow } from "./InvoiceRow";
import { PaidFields, type ManualMethod } from "./PaidFields";
import ui from "./ui.module.css";
import styles from "./InvoiceBlock.module.css";

// The registration drawer's „Arved“ (invoices Task 5, spec §5, D5): the registration's invoices, each with the actions its state allows
// (InvoiceRow), and „Koosta arve“. It offers exactly the amounts still open (domain/invoice.ts openAmounts, read by the page: not yet covered
// by an unpaid or paid invoice of the registration) as radio choices, and one of two kinds: „Maksmiseks“ (a request to pay, unpaid) and „Juba
// tasutud“ (a receipt for money already received; it asks the day and the way, and does not touch „Laekunud summa“). Without a seller (D3)
// „Koosta arve“ is a link to Seaded → Arve andmed instead. The page is refreshed by the action, so the list then shows the new invoice. This
// file runs on old iPads: no regular expression with a lookbehind, here or in anything it imports (tests/unit/old-safari.test.ts).

type Mode = "request" | "receipt";
type Line = { tone: "idle" | "busy" | "done" | "error"; text: string };
const IDLE: Line = { tone: "idle", text: "" };
const toneClass = (tone: Line["tone"]) => (tone === "error" ? ui.error : tone === "done" ? ui.success : ui.hint);

export function InvoiceBlock({
  registrationId,
  invoices,
  open,
  sellerReady,
  canCreate,
  today,
}: {
  registrationId: number;
  invoices: InvoiceView[];
  /** The amounts still to invoice (openAmounts), in the order the choices come. */
  open: OpenAmount[];
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

  // the choice follows what is open: after an invoice is made the amounts change, and a kind no longer open falls back to the first
  const chosen = open.some((o) => o.kind === kind) ? kind : (open[0]?.kind ?? null);

  useEffect(() => {
    if (opened) form.current?.querySelector<HTMLElement>("input")?.focus();
  }, [opened]);

  const create = (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (pending || chosen === null) return;
    setLine({ tone: "busy", text: t.working });
    start(async () => {
      const r = await createInvoiceAction({ registrationId, kind: chosen, mode, ...(mode === "receipt" ? { paidAt: date, method } : {}) });
      if (!r.ok) return setLine({ tone: "error", text: r.text });
      setOpened(false);
      setMode("request");
      setLine({ tone: "done", text: fill(t.done, { number: r.number }) });
    });
  };

  return (
    <section className={styles.block} aria-labelledby={`${uid}-title`} data-registration-invoices="">
      <h3 id={`${uid}-title`} className={ui.h3}>
        {adminEt.invoices.title}
      </h3>
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

      {canCreate &&
        (!sellerReady ? (
          <p className={styles.seller} data-invoice-need-seller="">
            <Link className={ui.link} href="/admin/seaded#arve">
              {t.needSeller}
            </Link>
          </p>
        ) : open.length === 0 ? (
          <p className={ui.hint} data-invoice-all-covered="">
            {t.allCovered}
          </p>
        ) : !opened ? (
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
                {open.map((o) => (
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
                  <input type="radio" name={`${uid}-mode`} value="request" checked={mode === "request"} onChange={() => setMode("request")} data-invoice-mode="request" />
                  <span>{t.forPayment}</span>
                </label>
                <label className={styles.choice}>
                  <input type="radio" name={`${uid}-mode`} value="receipt" checked={mode === "receipt"} onChange={() => setMode("receipt")} data-invoice-mode="receipt" />
                  <span>{t.alreadyPaid}</span>
                </label>
              </div>
            </fieldset>
            <p className={ui.hint} data-invoice-mode-hint="">
              {mode === "request" ? t.forPaymentHint : t.alreadyPaidHint}
            </p>
            {mode === "receipt" && <PaidFields name={`${uid}-receipt`} date={date} method={method} today={today} onDate={setDate} onMethod={setMethod} dateLabel={t.paidDate} methodLabel={t.paidMethod} />}
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
    </section>
  );
}
