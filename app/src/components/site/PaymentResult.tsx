"use client";

import { useSyncExternalStore } from "react";
import { parseResultFragment } from "@/domain/payments";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import { Icon } from "./Icon";
import { Notice } from "./Notice";
import ui from "./ui.module.css";

/**
 * The result's texts (payment.result) and the account's "Minu koolitused". `paidEcourse` and `paidEcourseText`: an e-course's purchase says
 * "Makse õnnestus." and, under it, where her login is (the owner's wording). `pendingFinancing` and `payBank` (payment.payBank): a Järelmaks (Inbank)
 * whose application is not decided (instalments §4), and „Maksa pangalingiga“ beside „Proovi uuesti“ for it.
 */
export type PaymentResultTexts = {
  title: string;
  paid: string;
  paidEcourse: string;
  paidEcourseText: string;
  pending: string;
  pendingFinancing: string;
  cancelled: string;
  retry: string;
  payBank: string;
  openCourse: string;
  account: string;
};

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

/**
 * /makse (phase 2b, spec 6.5): the bank's way back. The page is static and the same for everyone; the result is in the fragment the return
 * route wrote (domain/payments.ts resultFragment), read here after hydration. makstud: "Makse õnnestus. …" and Minu koolitused (an e-course:
 * "Makse õnnestus.", the line about her login, and "Ava e-koolitus"); pooleli and katkestatud: their sentence, "Proovi uuesti" when the
 * fragment gives the way (the /maksa page of the registration, or the cart of the e-course; full page loads: /maksa is a route handler) and
 * Minu koolitused. A pooleli of a held payment carries no way, so it has no "Proovi uuesti": the money is at Montonio and a second payment
 * could charge her twice. No result: the title alone. Every address on the page is built here from the fragment's checked parts.
 * A Järelmaks (Inbank) that is not decided (kind „jarelmaks“, pooleli; instalments §4, Draft) says so — „Järelmaksu taotlus on pooleli või jäi lõpetamata.
 * Kui Inbank selle kinnitab, saadame sulle kinnituse.“ — and offers two ways on, whichever way is given: „Maksa pangalingiga“ (the bank, for the whole price)
 * and „Proovi uuesti“ (Inbank again). A registration's are two buttons that post to its /maksa page with the method (the page starts the payment and
 * answers with a 303 to the bank or to Inbank); an e-course's are two links to its cart, which needs her name and the terms again, the second with
 * ?makse=jarelmaks so that the cart opens with Järelmaks (Inbank) chosen. Without a way (a held loan) the sentence stands alone.
 */
export function PaymentResult({ locale, t }: { locale: Locale; t: PaymentResultTexts }) {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => "");
  const view = parseResultFragment(hash);
  const to = (path: string) => href(locale, path);
  const account = { href: to("/konto"), label: t.account };
  if (!view) {
    return (
      <div data-payment-result="">
        <Notice title={t.title} links={[account]} />
      </div>
    );
  }
  const ecourse = view.outcome === "makstud" && view.kind === "ekoolitus";
  const loan = view.kind === "jarelmaks";
  const decided = view.outcome === "makstud";
  const title = decided ? (ecourse ? t.paidEcourse : t.paid) : view.outcome === "pooleli" ? (loan ? t.pendingFinancing : t.pending) : t.cancelled;
  // the way on: the registration's /maksa page, or the e-course's cart; a loan is told from the other by which of the two it was given
  const payPath = !decided && view.payToken && (view.kind === "registreering" || loan) ? `/maksa/${view.payToken}` : null;
  const cartPath = !decided && !payPath && view.course && (view.kind === "ekoolitus" || loan) ? to(`/ostukorv?kursus=${view.course}`) : null;
  const links = ecourse && view.course ? [{ href: to(`/konto/kursus/${view.course}`), label: t.openCourse }] : [account];
  const undecidedLoan = loan && view.outcome === "pooleli";
  return (
    <div data-payment-result={view.outcome}>
      <Notice title={title} text={ecourse ? t.paidEcourseText : undefined} links={links}>
        {undecidedLoan && payPath && (
          <>
            <PayButton action={payPath} method="paymentInitiation" label={t.payBank} outline />
            <PayButton action={payPath} method="hirePurchase" label={t.retry} retry />
          </>
        )}
        {undecidedLoan && cartPath && (
          <>
            <a className={ui.btnOutline} href={cartPath}>
              {t.payBank}
              <Icon name="arrow" />
            </a>
            <a className={ui.btn} href={`${cartPath}&makse=jarelmaks`} data-payment-retry="">
              {t.retry}
              <Icon name="arrow" />
            </a>
          </>
        )}
        {!undecidedLoan && (payPath ?? cartPath) && (
          <a className={ui.btn} href={(payPath ?? cartPath) as string} data-payment-retry="">
            {t.retry}
            <Icon name="arrow" />
          </a>
        )}
      </Notice>
    </div>
  );
}

/**
 * One of a registration's two ways on (instalments §4): a plain form that posts `method` to the registration's /maksa page, which starts that payment
 * and answers with a 303 to the bank's or Inbank's page. The default form encoding, which the page reads (server/pay-page.ts postedMethod); no script.
 * The page is the registration's own (a token the fragment carried, checked by parseResultFragment), and the browser's own cross-site check applies.
 */
function PayButton({ action, method, label, outline, retry }: { action: string; method: "paymentInitiation" | "hirePurchase"; label: string; outline?: boolean; retry?: boolean }) {
  return (
    <form method="post" action={action}>
      <input type="hidden" name="method" value={method} />
      <button type="submit" className={outline ? ui.btnOutline : ui.btn} data-payment-retry={retry ? "" : undefined}>
        {label}
        <Icon name="arrow" />
      </button>
    </form>
  );
}
