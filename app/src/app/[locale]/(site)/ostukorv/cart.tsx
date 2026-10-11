import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EcoursePurchase } from "@/components/site/EcoursePurchase";
import { Notice } from "@/components/site/Notice";
import { PurchaseInterest } from "@/components/site/PurchaseInterest";
import ui from "@/components/site/ui.module.css";
import { getDb } from "@/db/client";
import { getCourseBySlug } from "@/db/queries/public";
import { formatEUR } from "@/domain/money";
import { pick } from "@/i18n/field";
import { fill } from "@/i18n/format";
import { href } from "@/i18n/href";
import { getDict, type Locale } from "@/i18n/locales";
import { mediaUrl } from "@/lib/media";
import { paymentsConfigured } from "@/server/payments/montonio";
import styles from "./cart.module.css";

export function cartMetadata(locale: Locale): Metadata {
  const d = getDict(locale);
  return { title: `${d.cart.title} — ${d.common.siteName}` };
}

/**
 * Cart (/ostukorv?kursus=<slug>), target of "Osta kohe" on an e-learning page (P9). With online payments (phase 2b, spec 6.4) it sums up the
 * course and takes the purchase: name, e-mail, the terms, the newsletter box and "Maksa {hind}" (components/site/EcoursePurchase.tsx); without
 * them it says payment opens soon and takes an e-mail to tell the visitor, and when Montonio does not open the payment at the moment of buying
 * the form gives way to that same interest form under "Makse ei avanenud…". Whether payments are on is a setting of the deployment, read while
 * the page renders (the page stays one cached page per course): nothing about the visitor is in it, her name and e-mail are filled in by the
 * browser from /api/konto/me.
 * Only e-learning courses can be bought; contact courses are registered on their own page.
 * The middleware serves "?kursus=<slug>" from ./[kursus] (one cached page per course); /ostukorv alone is the empty cart.
 * A course that does not exist or is not published is a 404 (./[kursus]/not-found.tsx says the cart is empty). Next.js
 * stores that 404 in its cache like any page, one ISR entry per made-up ?kursus=, so each such address is rendered once.
 */
export async function Cart({ locale, slug }: { locale: Locale; slug: string }) {
  const d = getDict(locale);
  const to = (path: string) => href(locale, path);
  const course = slug ? await getCourseBySlug(getDb(), slug) : null;
  if (slug && !course) notFound();

  if (!course || course.type !== "e_learning" || course.price == null) {
    return <Notice title={d.cart.emptyTitle} text={d.cart.emptyText} links={[{ href: to("/koolitused?vorm=e"), label: d.formats.elearning.link }]} />;
  }

  const title = pick(course.title, locale);
  const image = course.images[0];
  const price = formatEUR(course.price, locale);
  const c = d.course;
  // today's purchase-interest form under a line saying why: "Makse lisandub peagi" without payments, "Makse ei avanenud" when Montonio is down
  // at the moment of buying (phase 2b: nothing is lost)
  const interest = (line: string) => (
    <>
      <p className={styles.soon}>{line}</p>
      <PurchaseInterest
        course={course.slug}
        locale={locale}
        t={{
          email: d.forms.email,
          newsletterConsent: d.forms.newsletterConsent,
          submit: d.forms.interestSubmit,
          sending: d.forms.sending,
          sent: d.forms.interestSent,
          errorEmail: d.forms.errorEmail,
          errorTooMany: d.forms.errorTooMany,
          errorGeneric: d.forms.errorGeneric,
        }}
      />
    </>
  );
  return (
    <div className={`${ui.wrap} ${styles.page}`}>
      <p className={ui.eyebrow}>{d.formats.elearning.name}</p>
      <h1 className={styles.title}>{d.cart.title}</h1>
      <div className={styles.layout}>
        <article className={styles.item}>
          <div className={styles.photo}>{image && <Image className={styles.image} src={mediaUrl(image.key)} alt="" fill unoptimized sizes="160px" />}</div>
          <div className={styles.itemBody}>
            <h2 className={styles.itemTitle}>
              <Link href={to(`/koolitused/${course.slug}`)}>{title}</Link>
            </h2>
            <p className={styles.itemSummary}>{pick(course.summary, locale)}</p>
            <dl className={styles.facts}>
              {course.accessMonths ? (
                <div>
                  <dt>{c.accessLabel}</dt>
                  <dd>
                    {course.accessMonths} {c.monthsUnit}
                  </dd>
                </div>
              ) : null}
              {course.videoCount ? (
                <div>
                  <dt>{c.videosLabel}</dt>
                  <dd>{course.videoCount}</dd>
                </div>
              ) : null}
              <div>
                <dt>{c.languageLabel}</dt>
                <dd>{course.language}</dd>
              </div>
            </dl>
          </div>
          <p className={styles.itemPrice}>{price}</p>
        </article>

        <aside className={styles.summary} data-cart-summary="">
          <p className={styles.total}>
            <span>{d.cart.total}</span>
            <b>{price}</b>
          </p>
          {paymentsConfigured() ? (
            <EcoursePurchase
              course={course.slug}
              locale={locale}
              t={{
                name: d.forms.name,
                email: d.forms.email,
                terms: d.forms.terms,
                termsLink: { label: d.footer.terms, href: to("/tingimused") },
                newsletterConsent: d.forms.newsletterConsent,
                submit: fill(d.payment.pay, { amount: price }),
                starting: d.payment.starting,
                alreadyPaid: d.payment.alreadyPaid,
                errorRequired: d.forms.errorRequired,
                errorEmail: d.forms.errorEmail,
                errorTooMany: d.forms.errorTooMany,
                errorGeneric: d.forms.errorGeneric,
              }}
              fallback={interest(d.payment.cartDown)}
            />
          ) : (
            interest(c.checkoutSoon)
          )}
        </aside>
      </div>
    </div>
  );
}
