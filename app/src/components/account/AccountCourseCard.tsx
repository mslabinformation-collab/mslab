"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { Icon } from "@/components/site/Icon";
import ui from "@/components/site/ui.module.css";
import {
  cardKey, cardTag, cardTitle, cardWhen, hasPrepayment, isPastCard, nextStep, type AccountCard, type ContactCard, type PrepaymentInfo as PaySettings,
} from "@/domain/account-cards";
import { formatEUR } from "@/domain/money";
import { amountDue, type Due } from "@/domain/payments";
import { fill } from "@/i18n/format";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import { isDone, sendJson } from "@/lib/json-request";
import { navigate } from "@/lib/navigate";
import { NextStepLine } from "./NextStepLine";
import { PrepaymentInfo } from "./PrepaymentInfo";
import { ProgressBar } from "./ProgressBar";
import type { CoursesTexts } from "./texts";
import styles from "./AccountCourseCard.module.css";

export type CardProps = {
  card: AccountCard;
  now: Date;
  locale: Locale;
  t: CoursesTexts;
  pay: PaySettings | null;
  readOnly: boolean;
  /** A change request was sent for this registration from this tab: the card says so instead of offering the button. */
  sent: boolean;
  /** It was sent just now: "Saadetud …" takes the focus the dialog gives back. */
  focusSent?: boolean;
  /** "Tühista või muuda aega": opens the dialog (the button is handed over, for the focus to return to it). */
  onChangeRequest(card: ContactCard, opener: HTMLElement): void;
  /** Online payments are on (phase 2b, Dashboard.payOnline): the pay steps get "Maksa {summa}" / "Maksa ülejäänud {summa}". */
  payOnline?: boolean;
};

/** A ref that focuses its element once, when it appears (stable, so a later render does not focus it again). */
const focusOnMount = (el: HTMLElement | null) => el?.focus();

/** The page Montonio answers with is a web address of its own; anything else is no page to send the browser to. */
const isPageUrl = (url: unknown): url is string => typeof url === "string" && /^https?:\/\//i.test(url);

/** What a contact card can pay online now (phase 2b, domain/payments.ts amountDue): the prepayment still due, the rest, or nothing. */
function onlineDue(card: AccountCard, now: Date): Due {
  if (card.kind !== "contact") return { kind: "none" };
  return amountDue(
    { status: card.status, paymentChoice: card.paymentChoice, priceCents: card.priceCents, paidCents: card.paidCents, startsAt: new Date(card.session.startsAt), sessionCancelled: card.session.cancelled },
    now,
  );
}

/**
 * One course card of "Minu koolitused" (prototype B's dashboard .card): the type tag, the course, when and where, the one
 * next-step sentence and at most one main button (spec 2.1 rule 5):
 * - pay → "Vaata juhiseid" opens the prepayment instructions in place; with online payments (phase 2b) the main button is "Maksa {summa}"
 *   and "Vaata juhiseid" is a text button under it, after "või tasu pangaülekandega";
 * - changeRequest → "Tühista või muuda aega" opens the dialog (after sending: "Saadetud. Maria võtab sinuga ühendust."); with online
 *   payments a confirmed card with a rest has "Maksa ülejäänud {summa}" as its main button and the change request as the text button;
 * - openCourse → "Ava koolitus" → /konto/kursus/{slug}.
 * "Maksa" posts /api/konto/maksa and the page goes on to Montonio; a refusal says why under the button. If the browser comes back to this
 * page from its back-forward cache (the payer pressed Back), the button is ready again.
 * An open e-course with lessons shows '{done} / {total}' with the e-course page's bar, or 'Läbitud ✓' (phase 2c).
 * `readOnly`: the buttons are there but aria-disabled, and do nothing.
 */
export function AccountCourseCard({ card, now, locale, t, pay, readOnly, sent, focusSent, onChangeRequest, payOnline = false }: CardProps) {
  const step = nextStep(card, now, pay, locale, payOnline);
  const [open, setOpen] = useState(false);
  const [paying, setPaying] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const titleId = useId();
  const panelId = useId();
  const when = cardWhen(card, locale);
  const action = step.action;
  const progress = card.kind === "ecourse" && !isPastCard(card, now) ? (card.progress ?? null) : null;
  const due = payOnline ? onlineDue(card, now) : ({ kind: "none" } as const);
  // the main button is "Maksa …" when the step is a payment and an amount can be paid online now
  const online = due.kind !== "none" && (action.kind === "pay" || step.key === "confirmedRest") ? due : null;

  // "Avan makse…" stays while the browser leaves for Montonio; Back brings the page back from the cache in that state, so it is reset then
  useEffect(() => {
    const restored = (e: PageTransitionEvent) => {
      if (e.persisted) setPaying({ busy: false, error: null });
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);

  async function payNow(registrationId: number) {
    if (readOnly || paying.busy) return;
    setPaying({ busy: true, error: null });
    const answer = await sendJson("/api/konto/maksa", { registrationId });
    const url = answer.data.paymentUrl;
    if (isDone(answer) && isPageUrl(url)) return navigate(url);
    const error = answer.data.error === "full" ? t.online.full : answer.data.error === "nothing" ? t.online.nothing : answer.status === 429 ? t.online.rate : t.online.failed;
    setPaying({ busy: false, error });
  }

  const payButton =
    online && card.kind === "contact" ? (
      <button
        type="button"
        className={`${ui.btn} ${styles.action}`}
        aria-disabled={readOnly || paying.busy || undefined}
        onClick={() => void payNow(card.registrationId)}
        data-card-action="pay-online"
      >
        {paying.busy ? t.online.starting : fill(online.kind === "balance" ? t.online.payRest : t.online.pay, { amount: formatEUR(online.cents, locale) })}
      </button>
    ) : null;

  /** "Vaata juhiseid" / "Peida juhised": the main button without online payments, the text button with them. */
  const instructions = (main: boolean) => (
    <button
      type="button"
      className={main ? `${ui.btn} ${styles.action}` : styles.second}
      aria-expanded={readOnly ? undefined : open}
      aria-controls={readOnly || !open ? undefined : panelId}
      aria-disabled={readOnly || undefined}
      onClick={() => !readOnly && setOpen((v) => !v)}
      {...(main ? { "data-card-action": "pay" } : { "data-card-transfer": "" })}
    >
      {open ? t.payHide : t.pay}
    </button>
  );

  /** "Tühista või muuda aega" (or, once sent, the line that says so): the main outline button, or the text button next to "Maksa ülejäänud". */
  const changeRequest = (main: boolean) =>
    sent ? (
      <p ref={focusSent ? focusOnMount : undefined} className={styles.sent} role="status" tabIndex={-1} data-card-sent="">
        <Icon name="check" size={18} />
        {t.request.sent}
      </p>
    ) : (
      <button
        type="button"
        className={main ? `${ui.btnOutline} ${styles.action}` : styles.second}
        aria-haspopup="dialog"
        aria-disabled={readOnly || undefined}
        onClick={(e) => !readOnly && card.kind === "contact" && onChangeRequest(card, e.currentTarget)}
        {...(main ? { "data-card-action": "change" } : { "data-card-change": "" })}
      >
        {t.change}
      </button>
    );

  let button: React.ReactNode = null;
  let second: React.ReactNode = null;
  if (action.kind === "pay") {
    if (payButton) {
      button = payButton;
      if (hasPrepayment(pay))
        second = (
          <>
            <p className={styles.or}>{t.online.transfer}</p>
            {instructions(false)}
          </>
        );
    } else button = instructions(true);
  } else if (action.kind === "changeRequest") {
    if (payButton) {
      button = payButton;
      second = changeRequest(false);
    } else button = changeRequest(true);
  } else if (action.kind === "openCourse") {
    button = readOnly ? (
      <a className={`${ui.btn} ${styles.action}`} role="link" aria-disabled="true" data-card-action="open">
        {t.open}
        <Icon name="arrow" />
      </a>
    ) : (
      <Link className={`${ui.btn} ${styles.action}`} href={href(locale, `/konto/kursus/${action.slug}`)} data-card-action="open">
        {t.open}
        <Icon name="arrow" />
      </Link>
    );
  }

  return (
    <article
      className={styles.card}
      aria-labelledby={titleId}
      data-card={cardKey(card)}
      data-step={step.key}
      data-past={isPastCard(card, now) || undefined}
    >
      <span className={styles.tag}>{t.tag[cardTag(card)]}</span>
      {/* tabIndex -1: the dashboard puts the focus here after the card has changed under the student (a refused request) */}
      <h2 id={titleId} className={styles.title} tabIndex={-1}>
        {cardTitle(card, locale, t.untitled)}
      </h2>
      {when && (
        <p className={styles.when}>
          <span>{when.time}</span>
          {when.place && <span className={styles.place}>{when.place}</span>}
        </p>
      )}
      <NextStepLine className={styles.next} step={step} texts={t.next} />
      {progress && (
        <div className={styles.progress} data-card-progress="">
          {progress.done === progress.total ? (
            <p className={styles.finished} data-card-finished="">
              {t.finished}
            </p>
          ) : (
            <>
              <p className={styles.count} aria-hidden="true">
                {fill(t.lessonCount, { done: progress.done, total: progress.total })}
              </p>
              <ProgressBar done={progress.done} total={progress.total} label={fill(t.resumeProgress, { done: progress.done, total: progress.total })} />
            </>
          )}
        </div>
      )}
      {button && <div className={styles.foot}>{button}</div>}
      {paying.error && (
        <p className={styles.payError} role="alert" data-card-pay-error="">
          {paying.error}
        </p>
      )}
      {second && <div className={styles.secondRow}>{second}</div>}
      {action.kind === "pay" && open && !readOnly && pay && (
        <PrepaymentInfo id={panelId} pay={pay} registrationId={action.registrationId} amount={step.vars.amount} t={t.payment} />
      )}
    </article>
  );
}
