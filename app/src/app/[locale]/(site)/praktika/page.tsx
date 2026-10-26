import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Icon } from "@/components/site/Icon";
import { PracticeBlock } from "@/components/site/PracticeBlock";
import { PracticeRequest } from "@/components/site/PracticeRequest";
import { PreviewBar } from "@/components/site/PreviewBar";
import ui from "@/components/site/ui.module.css";
import { getDb } from "@/db/client";
import { getPracticePackages } from "@/db/queries/public";
import { formatEUR } from "@/domain/money";
import { pick, pickList } from "@/i18n/field";
import { href } from "@/i18n/href";
import { getDict, isLocale } from "@/i18n/locales";
import { previewActive } from "@/server/preview";
import styles from "./practice.module.css";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.practice.title} — ${d.common.siteName}`, description: d.practice.onlyParnu };
}

/**
 * Practice (Task 9, R1–R5) on prototype B's practice page, with Maria's changes: "Praktika" is the H1 and comes first
 * (C08 / H11); "Ainult Pärnus" above it and a visible line "Praktika toimub ainult Pärnus, MS LAB stuudios." (C22 / R4);
 * B's dark panel with Maria's text and the praktikaprotokoll explanation (R2) and the MINI / MAXI cards from the
 * database with their durations and Jost prices (R3, R5); then the request form (#taotlus), preselected from ?pakett.
 */
export default async function PracticePage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale);
  const p = d.practice;
  const to = (path: string) => href(locale, path);
  const db = getDb();
  // the signed-in admin's draft preview (api/admin/eelvaade; piece 4a, R-f) shows the packages' drafts: previewActive() is false, with no cookie read, for
  // every visitor and for the static render, so the page stays the one cached
  const drafts = await previewActive();
  const packages = await getPracticePackages(db, { drafts });

  const views = packages.map((x) => ({
    code: x.code,
    name: pick(x.name, locale),
    tagline: pick(x.tagline, locale),
    items: pickList(x.items, locale),
    duration: pick(x.durationLabel, locale),
    price: formatEUR(x.price, locale),
    href: `${to("/praktika")}?pakett=${encodeURIComponent(x.code)}#taotlus`,
  }));

  // the admin's draft preview only (R-f): the practice bar; a visitor's page, and the page Next keeps, has none
  let previewBar: React.ReactNode = null;
  if (drafts) {
    const { sitePreviewBarProps } = await import("@/server/preview-bar");
    previewBar = <PreviewBar {...await sitePreviewBarProps(db, "practice", to("/praktika"))} />;
  }

  return (
    <>
      <header className={`${ui.wrap} ${styles.head}`}>
        <p className={`${ui.eyebrow} ${styles.eyebrow}`}>{p.onlyParnuShort}</p>
        <h1 className={`${ui.pageTitle} ${styles.title}`}>{p.title}</h1>
        <p className={styles.where} data-practice-where="">
          <Icon name="pin" size={18} className={styles.pin} />
          {p.onlyParnu}
        </p>
        <p className={styles.intro}>{p.intro}</p>
      </header>

      {views.length > 0 && (
        <PracticeBlock
          variant="page"
          t={{
            eyebrow: p.eyebrow,
            title: p.slogan,
            text: p.panelText,
            protocolTitle: p.protocolTitle,
            protocolText: p.protocolText,
            protocolPoints: p.protocolPoints,
            packageLabel: p.package,
            durationLabel: p.duration,
            register: p.register,
          }}
          packages={views}
        />
      )}

      {/* No packages (none set up in admin): no panel and no request form; the contact page takes questions instead. */}
      {views.length === 0 ? (
        <div className={`${ui.wrap} ${styles.request}`}>
          <Link className={ui.btnOutline} href={to("/kontakt")}>
            {d.footer.contactCta}
            <Icon name="arrow" />
          </Link>
        </div>
      ) : (
        <section id="taotlus" className={`${ui.wrap} ${styles.request}`} aria-labelledby="taotlus-title">
          <div className={styles.requestInner}>
            <h2 id="taotlus-title" className={styles.requestTitle}>
              {p.requestTitle}
            </h2>
            <PracticeRequest
              packages={views.map((v) => ({ code: v.code, name: v.name, duration: v.duration, price: v.price }))}
              locale={locale}
              t={{
                selectedPackage: p.selectedPackage,
                packageLabel: p.package,
                packageRequired: p.packageRequired,
                durationLabel: p.duration,
                name: d.forms.name,
                email: d.forms.email,
                phone: d.forms.phone,
                completedCourse: p.completedCourse,
                optional: d.forms.optional,
                preferredTimes: p.preferredTimes,
                preferredTimesPlaceholder: p.preferredTimesPlaceholder,
                note: p.requestNote,
                submit: p.requestSubmit,
                sending: d.forms.sending,
                sent: p.requestSent,
                sentText: p.requestSentText,
                errorRequired: d.forms.errorRequired,
                errorEmail: d.forms.errorEmail,
                errorTooMany: d.forms.errorTooMany,
                errorGeneric: d.forms.errorGeneric,
              }}
            />
          </div>
        </section>
      )}
      {previewBar}
    </>
  );
}
