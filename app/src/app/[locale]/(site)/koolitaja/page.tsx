import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Icon } from "@/components/site/Icon";
import { PreviewBar } from "@/components/site/PreviewBar";
import { trainerSettings } from "@/components/site/settings";
import ui from "@/components/site/ui.module.css";
import { WorksGallery } from "@/components/site/WorksGallery";
import { getDb } from "@/db/client";
import { getTrainerPage } from "@/db/queries/public";
import { previewActive } from "@/server/preview";
import type { Page } from "@/db/schema";
import { paragraphs } from "@/domain/catalogue";
import { pick } from "@/i18n/field";
import { fill } from "@/i18n/format";
import { href } from "@/i18n/href";
import { getDict, isLocale, type Locale } from "@/i18n/locales";
import { mediaUrl } from "@/lib/media";
import styles from "./trainer.module.css";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.nav.trainer} — ${d.common.siteName}` };
}

/**
 * An editable text block of the trainer page (T3, T4): the page title in this locale, else the dictionary's section name
 * (so /ru gets a Russian heading even before the Russian title is entered), and the body as paragraphs (ET fallback).
 */
function Story({ id, page, fallbackTitle, locale }: { id: string; page: Page | null; fallbackTitle: string; locale: Locale }) {
  const body = paragraphs(pick(page?.body, locale));
  if (body.length === 0) return null;
  const title = (locale === "ru" ? page?.title.ru : page?.title.et)?.trim() || fallbackTitle;
  return (
    <article className={styles.story} data-story={id} aria-labelledby={`story-${id}`}>
      <h2 id={`story-${id}`} className={styles.storyTitle}>
        {title}
      </h2>
      <div className={styles.storyBody}>
        {body.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    </article>
  );
}

/**
 * Trainer page (Task 9, T1–T4): prototype D `pTrainer` kept as the base (Maria C29) — name, bio, stats, "Vaata koolitusi"
 * and the portrait — with her additions: the works carousel right under the portrait (T2), then "Koolituskeskuse lugu"
 * (page center_story, T3) and "Koolitaja teekond" (page trainer_journey, T4) as two editorial blocks under a thin rose
 * rule. All texts and images are edited in admin.
 */
export default async function TrainerPage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale);
  const db = getDb();
  // the signed-in admin's draft preview (api/admin/eelvaade; piece 4a, R-f) shows the trainer's drafts: previewActive() is false, with no cookie read, for
  // every visitor and for the static render, so the page stays the one cached
  const drafts = await previewActive();
  const { trainer: setting, bio, story, journey, works } = await getTrainerPage(db, { drafts });

  const trainer = trainerSettings({ trainer: setting }, locale);
  const name = trainer.name || pick(bio?.title, locale);
  const bioText = paragraphs(pick(bio?.body, locale));
  const lead = bioText.length > 0 ? bioText : [pick(trainer.role, locale)].filter(Boolean);
  const portrait = mediaUrl(trainer.portraitKey);
  const images = works.map((w) => ({ src: mediaUrl(w.key), alt: pick(w.alt, locale) }));

  // the admin's draft preview only (R-f): the trainer's bar; a visitor's page, and the page Next keeps, has none
  let previewBar: React.ReactNode = null;
  if (drafts) {
    const { sitePreviewBarProps } = await import("@/server/preview-bar");
    previewBar = <PreviewBar {...await sitePreviewBarProps(db, "trainer", href(locale, "/koolitaja"))} />;
  }

  return (
    <>
      <section className={`${ui.wrap} ${styles.intro}`} aria-labelledby="trainer-name">
        <div className={styles.text}>
          <p className={ui.caps}>{d.trainer.pageEyebrow}</p>
          <h1 id="trainer-name" className={`${ui.pageTitle} ${styles.name}`}>
            {name}
          </h1>
          {lead.map((p, i) => (
            <p key={i} className={styles.lead}>
              {p}
            </p>
          ))}
          {trainer.stats.length > 0 && (
            <dl className={styles.stats}>
              {trainer.stats.map((s) => (
                <div key={s.value + s.label.et}>
                  <dt className={styles.statValue}>{s.value}</dt>
                  <dd className={styles.statLabel}>{pick(s.label, locale)}</dd>
                </div>
              ))}
            </dl>
          )}
          <div>
            <Link className={ui.btn} href={href(locale, "/koolitused")}>
              {d.trainer.viewCourses}
              <Icon name="arrow" />
            </Link>
          </div>
        </div>

        <div className={styles.media}>
          <div className={styles.portrait} data-portrait="">
            {portrait && (
              <Image
                className={`${styles.portraitImage} ${trainer.portraitZoom ? styles.seedZoom : ""}`}
                style={{ objectPosition: trainer.portraitPos }}
                src={portrait}
                alt={fill(d.trainer.portraitAlt, { name })}
                fill
                preload
                unoptimized
                sizes="(max-width: 860px) 100vw, 45vw"
              />
            )}
          </div>
          <WorksGallery
            images={images}
            t={{
              title: d.trainer.worksTitle,
              open: d.common.openImage,
              dialog: d.common.imageViewer,
              close: d.common.close,
              previous: d.common.previous,
              next: d.common.next,
            }}
          />
        </div>
      </section>

      <div className={`${ui.wrap} ${styles.stories}`}>
        <Story id="center_story" page={story} fallbackTitle={d.trainer.storyTitle} locale={locale} />
        <Story id="trainer_journey" page={journey} fallbackTitle={d.trainer.journeyTitle} locale={locale} />
      </div>
      {previewBar}
    </>
  );
}
