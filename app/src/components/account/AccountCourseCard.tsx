"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { Icon } from "@/components/site/Icon";
import ui from "@/components/site/ui.module.css";
import {
  cardInvoices, cardKey, cardTag, cardTitle, cardWhen, hasPrepayment, isPastCard, nextStep, type AccountCard, type CardInvoice, type ContactCard,
  type PrepaymentInfo as PaySettings,
} from "@/domain/account-cards";
import { euro } from "@/domain/invoice";
import { formatEUR } from "@/domain/money";
import { payableDue, type PayableDue } from "@/domain/payments";
import { fill, formatDate } from "@/i18n/format";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import { isDone, sendJson } from "@/lib/json-request";
import { navigate } from "@/lib/navigate";
import type { CertificateView } from "@/server/certificates";
import { CertificateForm } from "./CertificateForm";
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
  /**
   * The server refused a pay start because this card is out of date (a 401, a 404 or "nothing to pay"): the cards are loaded again behind
   * the page (CoursesView's quiet reload). Answers whether the server answered the new load; absent (the admin's view): nothing to load.
   */
  onStale?(card: ContactCard): Promise<boolean>;
  /** Her account's name (the dashboard's client.name): the first value of an ended access's "Nimi tunnistusel", as on the e-course page. */
  certificateName?: string;
};

/** A ref that focuses its element once, when it appears (stable, so a later render does not focus it again). */
const focusOnMount = (el: HTMLElement | null) => el?.focus();

/** The page Montonio answers with is a web address of its own; anything else is no page to send the browser to. */
const isPageUrl = (url: unknown): url is string => typeof url === "string" && /^https?:\/\//i.test(url);

/**
 * What a contact card can pay online now, as the server decides it (domain/payments.ts payableDue, which the start and the /maksa page ask): the
 * prepayment still due, the rest, or nothing (amountDue, phase 2b) — or, while the registration has an open unpaid invoice (`openInvoice`, invoices
 * D5: the one the server would charge), exactly that invoice's amount, "ülejäänud" for a „Jääk", also on the course day.
 */
function onlineDue(card: AccountCard, now: Date): PayableDue {
  if (card.kind !== "contact") return { kind: "none" };
  return payableDue(
    { status: card.status, paymentChoice: card.paymentChoice, priceCents: card.priceCents, paidCents: card.paidCents, startsAt: new Date(card.session.startsAt), sessionCancelled: card.session.cancelled },
    card.openInvoice ? { ...card.openInvoice, status: "unpaid" } : null,
    now,
  );
}

/**
 * Her invoices of a card (invoices Task 6, spec §4): a quiet line each, „Arve MSL2026-001 · 175,00 € · Tasutud“ or „… · Tasumata · tasu {date}“,
 * with „Laadi alla (PDF)“ (GET /api/konto/arve/<id>, a download; `readOnly`: aria-disabled, as the certificate's link). An unpaid invoice also
 * shows the bank details and the reference frozen on it (PrepaymentInfo's rows, with "Kopeeri"). The invoice's own sum, not the card's. An
 * invoice paid online that waits for its catch-up (R14: `awaitingCatchUp`) reads „Tasutud" with no download: its PDF would still read unpaid.
 * A paid one whose payment was refunded or voided reads „Tagastatud“ (`refunded`, I3), its download as it was. No bank details for an invoice
 * the card may not pay (a cancelled registration's, m8: the server sends it without `transfer`).
 */
function InvoiceLines({ invoices, locale, t, readOnly }: { invoices: CardInvoice[]; locale: Locale; t: CoursesTexts; readOnly: boolean }) {
  const base = useId();
  return (
    <ul className={styles.invoices} data-card-invoices="">
      {invoices.map((inv) => {
        const unpaid = inv.status === "unpaid";
        const line = [
          fill(t.invoices.number, { number: inv.number }),
          euro(inv.amountCents),
          unpaid ? t.invoices.unpaid : inv.refunded ? t.invoices.refunded : t.invoices.paid,
          ...(unpaid && inv.dueAt ? [fill(t.invoices.payBy, { date: formatDate(new Date(inv.dueAt), locale) })] : []),
        ].join(" · ");
        // (named by its invoice for a screen reader: a card may have several, and the visible words come first)
        const label = `${t.invoices.download}: ${inv.number}`;
        return (
          <li key={inv.id} className={styles.invoice} data-card-invoice={inv.id} data-invoice-status={inv.status} data-invoice-refunded={inv.refunded || undefined}>
            <div className={styles.invoiceHead}>
              <span className={styles.invoiceLine} data-invoice-line="">
                {line}
              </span>
              {inv.awaitingCatchUp ? null : readOnly ? (
                <a className={styles.second} role="link" aria-disabled="true" aria-label={label} data-card-invoice-download="">
                  {t.invoices.download}
                </a>
              ) : (
                <a className={styles.second} href={`/api/konto/arve/${inv.id}`} download aria-label={label} data-card-invoice-download="">
                  {t.invoices.download}
                </a>
              )}
            </div>
            {inv.transfer && (
              <PrepaymentInfo
                id={`${base}-invoice-${inv.id}`}
                pay={{ receiver: inv.transfer.receiver, iban: inv.transfer.iban, bank: inv.transfer.bank, referencePrefix: "" }}
                invoiceReference={inv.transfer.reference}
                amount={euro(inv.amountCents)}
                t={t.payment}
              />
            )}
          </li>
        );
      })}
    </ul>
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
 * - a sent protocol (phase protocols) → "Vaata protokolli" → /konto/protokoll#id={registration}: the main button of a card that has none, else a text link under it.
 * "Maksa" posts /api/konto/maksa and the page goes on to Montonio; a refusal says why under the button. A refusal that says the card is
 * out of date (a 401, a 404, or "nothing to pay") also loads the cards again quietly (`onStale`), so the card shows what is true now: the
 * line is left for "nothing" (its sentence is true after the reload too) and for a reload that got no answer, and not for a 401 or a 404.
 * If the browser comes back to this page from its back-forward cache (the payer pressed Back), the button is ready again.
 * An open e-course with lessons shows '{done} / {total}' with the e-course page's bar, or 'Läbitud ✓' (phase 2c).
 * A completed e-course says 'Lõpetatud {date}' (e-course completion), also after its access has ended.
 * An ended e-course with a certificate links its PDF, "Laadi tunnistus alla" (phase 3d), a quiet text link: the course page has closed.
 * An ended e-course completed without one yet has the e-course page's name form instead (CertificateForm: `certificateName` to start with),
 * as that page needs an active access; once it is made, the link takes its place and the focus.
 * Her invoices (invoices Task 6) are quiet lines under the next-step sentence (InvoiceLines); "Maksa" charges the open unpaid invoice's amount when
 * the card has one (onlineDue).
 * `readOnly`: the buttons are there but aria-disabled, and do nothing.
 */
export function AccountCourseCard({ card, now, locale, t, pay, readOnly, sent, focusSent, onChangeRequest, payOnline = false, onStale, certificateName = "" }: CardProps) {
  const step = nextStep(card, now, pay, locale, payOnline);
  const [open, setOpen] = useState(false);
  const [paying, setPaying] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  // the certificate made on this card (an ended access's name form)
  const [made, setMade] = useState<CertificateView | null>(null);
  const titleId = useId();
  const panelId = useId();
  const when = cardWhen(card, locale);
  const action = step.action;
  const progress = card.kind === "ecourse" && !isPastCard(card, now) ? (card.progress ?? null) : null;
  // "Lõpetatud {date}" (e-course completion, spec §4.1): once the course is completed, also after its access has ended
  const completedAt = card.kind === "ecourse" ? (card.completedAt ?? null) : null;
  const due = payOnline ? onlineDue(card, now) : ({ kind: "none" } as const);
  const invoices = cardInvoices(card);
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

  async function payNow(card: ContactCard) {
    if (readOnly || paying.busy) return;
    setPaying({ busy: true, error: null });
    const answer = await sendJson("/api/konto/maksa", { registrationId: card.registrationId });
    const url = answer.data.paymentUrl;
    if (isDone(answer) && isPageUrl(url)) return navigate(url);
    const nothing = answer.data.error === "nothing";
    const error = answer.data.error === "full" ? t.online.full : nothing ? t.online.nothing : answer.status === 429 ? t.online.rate : t.online.failed;
    // signed out or replaced (401), gone or not hers (404), nothing due (409): the card is out of date; load the cards again, quietly
    const outOfDate = answer.status === 401 || answer.status === 404 || nothing;
    const reloaded = outOfDate && onStale ? await onStale(card) : false;
    setPaying({ busy: false, error: reloaded && !nothing ? null : error });
  }

  const payButton =
    online && card.kind === "contact" ? (
      <button
        type="button"
        className={`${ui.btn} ${styles.action}`}
        aria-disabled={readOnly || paying.busy || undefined}
        onClick={() => void payNow(card)}
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

  // "Vaata protokolli" (phase protocols, spec §5): once Maria has sent it. The card's one button when it has none (a course that has been),
  // else a text link under its button. Its registration in the fragment: an account page never has a query.
  const protocolHref = (card.kind === "contact" || card.kind === "individual") && card.protocolSent ? `${href(locale, "/konto/protokoll")}#id=${card.registrationId}` : null;
  if (protocolHref) {
    const main = button === null;
    const cls = main ? `${ui.btnOutline} ${styles.action}` : styles.second;
    const link = readOnly ? (
      <a className={cls} role="link" aria-disabled="true" data-card-protocol="">
        {t.viewProtocol}
      </a>
    ) : (
      <Link className={cls} href={protocolHref} data-card-protocol="">
        {t.viewProtocol}
      </Link>
    );
    if (main) button = link;
    else
      second = (
        <>
          {second}
          {link}
        </>
      );
  }

  // "Laadi tunnistus alla" (phase 3d, spec §5): an ended access's way back to its certificate, since the e-course page needs an active access.
  // A revoked access has none (certificateId is null). A plain link: the API answers with the PDF as a download, named by its number.
  // Completed without one yet (certificateId null, as loadDashboard says it): the name form, whose certificate the link then gives.
  const ended = card.kind === "ecourse" && !card.revoked && isPastCard(card, now) ? card : null;
  const certificateId = ended ? (made?.id ?? ended.certificateId ?? null) : null;
  const toConfirm = ended !== null && made === null && Boolean(ended.completedAt) && ended.certificateId === null ? ended : null;
  if (certificateId !== null) {
    const link = readOnly ? (
      <a className={styles.second} role="link" aria-disabled="true" data-card-certificate="">
        {t.certificate.cardLink}
      </a>
    ) : (
      <a ref={made ? focusOnMount : undefined} className={styles.second} href={`/api/konto/tunnistus/${certificateId}`} download data-card-certificate="">
        {t.certificate.cardLink}
      </a>
    );
    second = (
      <>
        {second}
        {link}
      </>
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
      {completedAt && (
        <p className={styles.completed} data-card-completed="">
          <Icon name="check" size={18} />
          {fill(t.completed, { date: formatDate(new Date(completedAt), locale) })}
        </p>
      )}
      {toConfirm && (
        <div className={styles.certificate} data-card-certificate-form="">
          <CertificateForm slug={toConfirm.course.slug} startName={certificateName} t={t.certificate} readOnly={readOnly} quiet={false} onIssued={setMade} />
        </div>
      )}
      {invoices.length > 0 && <InvoiceLines invoices={invoices} locale={locale} t={t} readOnly={readOnly} />}
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
