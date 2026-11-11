import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CatalogueFilters, type CatalogueCourse } from "@/components/site/CatalogueFilters";
import { PreviewLabelBar } from "@/components/site/PreviewBar";
import { courseCardData } from "@/components/site/course-card-data";
import ui from "@/components/site/ui.module.css";
import { getDb } from "@/db/client";
import { listCourseAreas, listPublishedCourses, listUpcomingSessions } from "@/db/queries/public";
import { firstSentence, normalizeSearch } from "@/domain/catalogue";
import { areaChips, areaSlug } from "@/domain/course-areas";
import { nextSessionByCourse } from "@/domain/home";
import { pick } from "@/i18n/field";
import { href } from "@/i18n/href";
import { getDict, isLocale } from "@/i18n/locales";
import styles from "./catalogue.module.css";
import { upcomingFrom } from "@/domain/calendar";
import { previewActive } from "@/server/preview";

type Props = { params: Promise<{ locale: string }> };

/**
 * This page lists course dates, and a date is listed only until its session begins. So it is rendered again when it is
 * older than 5 minutes (the first visit after that still gets the cached copy and starts the new render), and a session
 * that has begun drops off without anyone saving. Saves revalidate it at once (server/public-cache.ts).
 */
export const revalidate = 300;

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.nav.courses} — ${d.common.siteName}`, description: d.catalogue.intro };
}

/**
 * Catalogue (Task 8, K1–K13). Page head from D with Maria's smaller sizes (K9, K10), then B's filter arrangement
 * with D's explainer. Every course is either e-learning or contact; hybrid is only explained, never a filter.
 * The filters read the URL themselves (CatalogueFilters), so the server render and the client always agree.
 * The area chips (course areas, spec 2026-11-11-course-areas-filter-design.md §5.2) are the areas the listed courses have, in Maria's order, named in
 * the page's language; none when fewer than two (domain/course-areas.ts areaChips). In the admin's draft preview a course's area is its draft's.
 */
export default async function CataloguePage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale);
  const to = (path: string) => href(locale, path);
  const db = getDb();
  // the signed-in admin's draft preview shows each course's unpublished changes (api/admin/eelvaade; R-h): previewActive() is false, with no cookie read,
  // for every visitor and for the static render, so the page stays the one cached by revalidation
  const drafts = await previewActive();
  const [list, sessions, areaRows] = await Promise.all([
    listPublishedCourses(db, undefined, { drafts }),
    listUpcomingSessions(db, upcomingFrom(new Date())),
    listCourseAreas(db),
  ]);

  const next = nextSessionByCourse(sessions);
  const areaKey = new Map(areaRows.map((a) => [a.id, areaSlug(a.name)]));
  const courses: CatalogueCourse[] = list.map((c) => ({
    card: courseCardData(c, next.get(c.id), locale, d, to),
    level: c.level,
    text: normalizeSearch(`${pick(c.title, locale)} ${pick(c.summary, locale)}`),
    area: c.areaId === null ? null : (areaKey.get(c.areaId) ?? null),
  }));
  const areas = areaChips(
    areaRows.map((a) => ({ id: a.id, slug: areaSlug(a.name), label: pick(a.name, locale) })),
    list.map((c) => c.areaId),
  );

  // the admin's draft preview only (Dim 24.10, D-4): „Eelvaade“ and the way out „Lõpeta eelvaade“; a visitor's page, and the page Next keeps, has none
  let previewBar: React.ReactNode = null;
  if (drafts) {
    const { catalogueBarProps } = await import("@/server/preview-bar");
    previewBar = <PreviewLabelBar {...catalogueBarProps(to("/koolitused"))} />;
  }

  const f = d.formats;
  const c = d.catalogue;
  return (
    <div className={`${ui.wrap} ${styles.page}`}>
      <header className={styles.head}>
        <p className={ui.eyebrow}>{d.nav.courses}</p>
        <h1 className={`${ui.pageTitle} ${styles.title}`}>{c.title}</h1>
        <p className={styles.intro} data-catalogue-intro="">
          {c.intro}
        </p>
      </header>
      <CatalogueFilters
        courses={courses}
        areas={areas}
        formats={{
          e: { name: f.elearning.name, question: f.elearning.question, definition: f.elearning.definition, card: firstSentence(f.elearning.definition), steps: f.elearning.steps },
          k: { name: f.contact.name, question: f.contact.question, definition: f.contact.definition, card: firstSentence(f.contact.definition), steps: f.contact.steps },
          // Hybrid: description only (K8) — no steps.
          h: { name: f.hybrid.name, question: f.hybrid.question, definition: f.hybrid.definition, card: firstSentence(f.hybrid.definition) },
        }}
        t={{
          overview: f.overviewTitle,
          journey: f.eyebrow,
          howItWorks: f.howItWorks,
          readMore: c.readMore,
          hybridNote: c.hybridNote,
          search: c.search,
          formatLabel: c.formatLabel,
          levelLabel: c.levelLabel,
          areaLabel: c.areaLabel,
          filterAll: c.filterAll,
          allLevels: c.allLevels,
          levelBasic: c.levelBasic,
          levelAdvanced: c.levelAdvanced,
          emptyTitle: c.emptyTitle,
          emptyText: c.emptyText,
          resetFilters: c.resetFilters,
          results: c.results,
        }}
      />
      {previewBar}
    </div>
  );
}
