"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import type { ManualPaidMethod } from "@/domain/invoice";
import { formatEUR, parseEuroCents } from "@/domain/money";
import { prepaymentDue, type PaymentChoice, type RegStatus } from "@/domain/registration";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { addManualPaymentAction } from "@/server/actions/admin";
import type { ManualPaymentAnswer, ManualPaymentResult } from "@/server/registration-money";
import { PillChoice } from "./PillChoice";
import ui from "./ui.module.css";
import styles from "./MoneyCard.module.css";

// The registration drawer's Raha card (admin UX pass, piece 2, Task 5; README A2 drawer 2, the Part 2 prototype's drawer frames; piece2-texts P-2,
// S3-a…e): what has come in against the price („{laekunud} / {hind} laekunud“, an 8 px bar with its marker at 50 %), from where the place is
// confirmed and the session's free seats, the online payments (PaymentLines, drawn on the server and handed in as paymentLines so the rows stay out of the browser's page; without replaced orders: listPaymentsOf), and „Lisa laekumine“ — the one
// way Maria records money that came in outside the site (B4: server/registration-money.ts addManualPayment, one transaction with the seat check and
// the receipt). The panel opens in place of its button: the amount pills (P-2: what is missing up to 50 %, preselected; the remainder; „Muu summa“,
// refused in the field above what is left, S3-e), the day (today, never later), the way (Pangaülekanne by default), „Koosta kviitung“ (ticked when
// Seaded → Arve andmed has a seller; else the S3-c line in its place), the submit „Lisa {summa}“ (+ „· koht kinnitub“ when this amount reaches 50 %
// and the place is not confirmed yet; S3-d's words without a session) and „Katkesta“. The press sends the paid total the card was drawn with: the
// server refuses one built on an old total (`stale`) and refreshes the page. Hidden on a cancelled registration. This file runs on old iPads: no
// regular expression with a lookbehind here or in what it imports (tests/unit/old-safari.test.ts).

type Texts = typeof adminEt.registrations.drawer;
type Money = Texts["money"];

/** The panel's three kinds of amount (P-2): what is missing up to 50 %, the whole remainder, and one she types. */
export type AmountKey = "half" | "rest" | "other";
type Offer = { key: AmountKey; cents: number | null; label: string };
const METHODS: readonly ManualPaidMethod[] = ["bank", "cash", "card"];

const eur = (cents: number) => formatEUR(cents, "et");
/** "290" or "145,50": an amount without its euro sign (S3-e writes the sign itself). */
const bare = (cents: number) => eur(cents).replace(/ €$/, "");

/**
 * The amount pills by P-2. A course with no price offers only „Muu summa“. Else: under 50 % paid, what is missing up to 50 % („{x} · ettemaks“) first;
 * then what is left of the price („{x} · kogu summa“ while nothing is paid, „{x} · ülejäänud summa“ after); and „Muu summa“. The first is preselected.
 */
export function amountOffers(paidCents: number, priceCents: number | null): Offer[] {
  const t: Money = adminEt.registrations.drawer.money;
  const other: Offer = { key: "other", cents: null, label: t.other };
  if (priceCents === null) return [other];
  const pool = prepaymentDue(priceCents, "half");
  const left = priceCents - paidCents;
  const out: Offer[] = [];
  if (paidCents < pool) out.push({ key: "half", cents: pool - paidCents, label: fill(t.half, { x: eur(pool - paidCents) }) });
  if (left > 0) out.push({ key: "rest", cents: left, label: fill(paidCents === 0 ? t.full : t.rest, { x: eur(left) }) });
  return [...out, other];
}

type Registration = { id: number; paidCents: number; priceCents: number | null; status: RegStatus; cancelled: boolean; choice: PaymentChoice };
type Refusal = Extract<ManualPaymentAnswer, { ok: false }>["error"];
/** Why the panel refused before sending: „Muu summa“ is no amount, or more than is left (S3-e). */
type FieldError = "invalid" | "over";
type Result = { text: string; full: boolean };

/** The line of a press that went through (README, S3-a, S3-b, S3-d): the amount, the receipt's number, and what it did to the place. */
function resultOf(r: Extract<ManualPaymentResult, { ok: true }>, priceCents: number | null, hasSession: boolean): Result {
  const d = adminEt.registrations.drawer.money.done;
  const pool = priceCents === null ? null : prepaymentDue(priceCents, "half");
  const vars = { x: eur(r.addedCents), nr: r.receiptNumber ?? "", pool: pool === null ? "" : eur(pool) };
  const pick = (plain: string, receipt: string) => fill(r.receiptNumber ? receipt : plain, vars);
  if (r.full) return { text: pick(d.full, d.fullReceipt), full: true };
  if (r.confirmedNow) return { text: hasSession ? pick(d.confirmed, d.confirmedReceipt) : pick(d.confirmedAlone, d.confirmedAloneReceipt), full: false };
  if (pool !== null && r.status === "awaiting_prepayment" && r.paidCents < pool) {
    return { text: hasSession ? pick(d.under, d.underReceipt) : pick(d.underAlone, d.underAloneReceipt), full: false };
  }
  return { text: pick(d.plain, d.plainReceipt), full: false };
}

/** A refusal in Maria's words (S3-c, S3-e, the drawer's stale line, the existing invoice and registration texts). `left`: what the price leaves. */
function refusalText(error: Refusal | "future", left: number): string {
  const t = adminEt.registrations.drawer;
  switch (error) {
    case "stale":
      return t.stale;
    case "overRemainder":
      return fill(t.money.overRemainder, { x: bare(Math.max(0, left)) });
    case "sellerMissing":
      return adminEt.invoices.errors.sellerMissing;
    case "future":
    case "invalid":
      return adminEt.invoices.errors.invalid;
    case "cancelled":
      return t.cancelled;
    case "notFound":
      return t.notFound;
    default:
      return adminEt.common.saveError;
  }
}

export function MoneyCard({
  registration,
  session,
  sellerReady,
  paymentLines,
  today,
}: {
  /** The registration as the drawer shows it: what has come in, the price it is measured against (null: the course has none), its state, its choice. */
  registration: Registration;
  /** The session's seats now (taken by anyone, its capacity), or null: an individual or an e-learning registration, which has none. */
  session: { taken: number; capacity: number } | null;
  /** Seaded → Arve andmed has a seller (domain/invoice.ts sellerReady): a receipt can be made. */
  sellerReady: boolean;
  /**
   * Its online payments, newest first (listPaymentsOf: no replaced orders), as PaymentLines drawn by the page on the server — or null when there are
   * none. A node, not the rows: a payment's provider id, e-mail and name are not sent to the browser for the card to draw (the Task 5 review).
   */
  paymentLines: ReactNode;
  /** Today in Tallinn, "YYYY-MM-DD": the day a payment is recorded on unless she changes it, and the latest it may be. */
  today: string;
}) {
  const t = adminEt.registrations.drawer;
  const m = t.money;
  const uid = useId();
  const { id, paidCents, priceCents, status, choice: paymentChoice } = registration;
  const cancelled = registration.cancelled || status === "cancelled";
  const pool = priceCents === null ? null : prepaymentDue(priceCents, "half");
  const left = priceCents === null ? 0 : priceCents - paidCents;

  const [opened, setOpened] = useState(false);
  const [choice, setChoice] = useState<AmountKey | null>(null);
  const [other, setOther] = useState("");
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const [date, setDate] = useState(today);
  const [method, setMethod] = useState<ManualPaidMethod>("bank");
  const [receipt, setReceipt] = useState(true);
  const [refusal, setRefusal] = useState<Refusal | "future" | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [pending, start] = useTransition();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLFormElement>(null);
  const otherField = useRef<HTMLInputElement>(null);
  /** Where the focus goes once the panel has opened or closed (the chosen amount; the button again). */
  const focusNext = useRef<"panel" | "button" | null>(null);

  // the offers follow the total: after a refresh (a press, a stale refusal, a payment elsewhere) a kind no longer offered falls back to the first
  const offers = amountOffers(paidCents, priceCents);
  const chosen: AmountKey = offers.some((o) => o.key === choice) ? choice! : offers[0].key;
  const offer = offers.find((o) => o.key === chosen)!;
  const typed = chosen === "other" ? parseEuroCents(other) : null;
  /** The amount the press would send, or null while „Muu summa“ holds no amount. */
  const cents = chosen === "other" ? (typed !== null && typed > 0 ? typed : null) : offer.cents;
  const reaches = priceCents !== null && status === "awaiting_prepayment" && cents !== null && (paidCents + cents) * 2 >= priceCents;
  const submitLabel = cents === null ? m.add : fill(reaches ? (session ? m.submitSeat : m.submitAlone) : m.submit, { x: eur(cents) });

  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (next === "panel") panel.current?.querySelector<HTMLInputElement>(`[data-amount="${chosen}"]`)?.focus();
    else if (next === "button") button.current?.focus();
  });

  const reset = () => {
    setChoice(null);
    setOther("");
    setFieldError(null);
    setDate(today);
    setMethod("bank");
    setReceipt(true);
    setRefusal(null);
  };
  const open = () => {
    setResult(null);
    focusNext.current = "panel";
    setOpened(true);
  };
  const close = () => {
    reset();
    focusNext.current = "button";
    setOpened(false);
  };

  /** „Muu summa“ as typed: no amount, or above what is left (when the course has a price), refuses in the field; nothing is sent. */
  const checkOther = (): FieldError | null => {
    if (typed === null || typed <= 0) return "invalid";
    if (priceCents !== null && typed > left) return "over";
    return null;
  };

  const send = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    setRefusal(null);
    if (chosen === "other") {
      const wrong = checkOther();
      setFieldError(wrong);
      if (wrong) {
        otherField.current?.focus();
        return;
      }
    }
    if (cents === null) return;
    if (!date || date > today) {
      setRefusal("future");
      return;
    }
    const fd = new FormData();
    fd.set("registrationId", String(id));
    fd.set("cents", String(cents));
    fd.set("paidOn", date);
    fd.set("method", method);
    if (sellerReady && receipt) fd.set("receipt", "1");
    fd.set("expectedPaidCents", String(paidCents));
    const hasSession = session !== null;
    start(async () => {
      let r: ManualPaymentAnswer;
      try {
        r = await addManualPaymentAction(null, fd);
      } catch {
        // no answer (the connection dropped): if it was stored after all, a second press is refused as `stale` (its total is old), never added twice
        return setRefusal("server");
      }
      if (!r.ok) return setRefusal(r.error);
      setResult(resultOf(r, priceCents, hasSession));
      close();
    });
  };

  const [sellerBefore, sellerAfter] = m.needSeller.split("{link}");
  const otherError = fieldError === null ? null : fieldError === "over" ? fill(m.overRemainder, { x: bare(left) }) : t.paidInvalid;

  return (
    <section className={styles.card} aria-labelledby={`${uid}-title`} data-money-card="">
      <div className={styles.head}>
        <h3 id={`${uid}-title`} className={styles.title}>
          {m.title}
        </h3>
        {priceCents !== null && (
          <span className={styles.choice} data-money-choice="">
            {m.chosen[paymentChoice]}
          </span>
        )}
      </div>
      <p className={styles.sum}>
        <span className={styles.paid} data-paid="">
          {eur(paidCents)}
        </span>{" "}
        <span className={styles.of} data-money-total={priceCents === null ? undefined : ""}>
          {priceCents === null ? adminEt.registrations.paidWord : fill(m.of, { price: eur(priceCents) })}
        </span>
      </p>
      {priceCents === null || pool === null ? (
        <p className={`${ui.notice} ${styles.notice}`}>{t.noPrice}</p>
      ) : (
        <>
          <div className={styles.bar} aria-hidden="true" data-money-bar="">
            <span className={styles.fill} style={{ width: `${Math.min(100, Math.max(0, (paidCents / Math.max(1, priceCents)) * 100))}%` }} />
            <span className={styles.mark} style={{ left: "50%" }} data-money-mark="" />
          </div>
          <p className={styles.seat} data-money-seat="">
            {session
              ? fill(m.seat, { pool: eur(pool), free: Math.max(0, session.capacity - session.taken), cap: session.capacity })
              : fill(m.seatAlone, { pool: eur(pool) })}
          </p>
        </>
      )}

      {/* the online payments (phase 2b, spec 8), as today: when, how much, the kind, the way, the status */}
      {paymentLines && (
        <div className={styles.online} data-registration-payments="">
          <h4 className={styles.onlineTitle}>{adminEt.payments.online}</h4>
          {paymentLines}
        </div>
      )}

      <p role="status" className={result?.full ? styles.full : styles.result} data-add-payment-result="">
        {result?.text ?? ""}
      </p>

      {!cancelled &&
        (!opened ? (
          <button ref={button} type="button" className={`${ui.btn} ${styles.add}`} onClick={open} data-add-payment="">
            {m.add}
          </button>
        ) : (
          <form ref={panel} className={styles.panel} onSubmit={send} noValidate aria-labelledby={`${uid}-panel`} data-add-payment-panel="">
            <h4 id={`${uid}-panel`} className={styles.panelTitle}>
              {m.add}
            </h4>
            <PillChoice
              name={`${uid}-amount`}
              legend={m.amount}
              options={offers.map((o) => ({ value: o.key, label: o.label, data: { "data-amount": o.key } }))}
              value={chosen}
              onChange={(v) => {
                setChoice(v as AmountKey);
                setFieldError(null);
              }}
              plain
            />
            {chosen === "other" && (
              <div className={styles.other}>
                <input
                  ref={otherField}
                  className={`${ui.input} ${styles.input}`}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  aria-label={m.amount}
                  aria-invalid={otherError ? true : undefined}
                  aria-describedby={otherError ? `${uid}-other-error` : undefined}
                  value={other}
                  onChange={(e) => {
                    setOther(e.target.value);
                    setFieldError(null);
                  }}
                  data-other-amount=""
                />
                {otherError && (
                  <p id={`${uid}-other-error`} className={ui.error} data-other-amount-error="">
                    {otherError}
                  </p>
                )}
              </div>
            )}
            <div className={styles.when}>
              <div className={styles.dateField}>
                <label className={ui.sr} htmlFor={`${uid}-date`}>
                  {m.date}
                </label>
                <input
                  id={`${uid}-date`}
                  className={`${ui.input} ${styles.input}`}
                  type="date"
                  required
                  max={today}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  data-paid-date=""
                />
              </div>
              <div className={styles.methods}>
                <PillChoice
                  name={`${uid}-method`}
                  legend={m.method}
                  options={METHODS.map((value) => ({ value, label: m.methods[value], data: { "data-paid-method": value } }))}
                  value={method}
                  onChange={(v) => setMethod(v as ManualPaidMethod)}
                  plain
                />
              </div>
            </div>
            {sellerReady ? (
              <label className={styles.check}>
                <input type="checkbox" checked={receipt} onChange={(e) => setReceipt(e.target.checked)} data-receipt="" />
                <span>{m.receipt}</span>
              </label>
            ) : (
              <p className={styles.seller} data-receipt-need-seller="">
                {sellerBefore}
                <Link className={styles.sellerLink} href="/admin/seaded#arve">
                  {m.needSellerLink}
                </Link>
                {sellerAfter}
              </p>
            )}
            <div className={styles.actions}>
              <button type="submit" className={ui.btn} aria-disabled={pending || undefined} data-add-payment-submit="">
                {pending ? adminEt.common.saving : submitLabel}
              </button>
              <button type="button" className={`${ui.btn} ${ui.secondary}`} onClick={close}>
                {adminEt.common.cancel}
              </button>
            </div>
            <p role="alert" className={`${ui.error} ${styles.refusal}`} data-add-payment-error="">
              {refusal ? refusalText(refusal, left) : ""}
            </p>
          </form>
        ))}
    </section>
  );
}
