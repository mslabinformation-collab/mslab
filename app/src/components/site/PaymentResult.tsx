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
 * "Makse õnnestus." and, under it, where her login is (the owner's wording).
 */
export type PaymentResultTexts = {
  title: string;
  paid: string;
  paidEcourse: string;
  paidEcourseText: string;
  pending: string;
  cancelled: string;
  retry: string;
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
  const title = view.outcome === "makstud" ? (ecourse ? t.paidEcourse : t.paid) : view.outcome === "pooleli" ? t.pending : t.cancelled;
  const retryHref =
    view.outcome === "makstud" ? null : view.kind === "registreering" && view.payToken ? `/maksa/${view.payToken}` : view.kind === "ekoolitus" && view.course ? to(`/ostukorv?kursus=${view.course}`) : null;
  const links = ecourse && view.course ? [{ href: to(`/konto/kursus/${view.course}`), label: t.openCourse }] : [account];
  return (
    <div data-payment-result={view.outcome}>
      <Notice title={title} text={ecourse ? t.paidEcourseText : undefined} links={links}>
        {retryHref && (
          <a className={ui.btn} href={retryHref} data-payment-retry="">
            {t.retry}
            <Icon name="arrow" />
          </a>
        )}
      </Notice>
    </div>
  );
}
