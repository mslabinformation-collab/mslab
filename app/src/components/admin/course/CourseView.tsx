"use client";

import { Fragment, useMemo, type ReactNode } from "react";
import { courseCardData } from "@/components/site/course-card-data";
import type { CourseCardData } from "@/components/site/CourseCard";
import type { CourseWithImages } from "@/db/queries/public";
import { newCourseDraft, type CourseDraft, type CourseType } from "@/domain/course-editor";
import type { EditorPart } from "@/domain/course-parts";
import { parseEuroCents } from "@/domain/money";
import { adminEt } from "@/i18n/dict/admin";
import { et } from "@/i18n/dict/et";
import type { AdminModule } from "@/server/admin-lessons";
import { SectionMap } from "../SectionMap";
import ui from "../ui.module.css";
import styles from "../CourseEditor.module.css";
import { BadgeCard } from "./BadgeCard";
import { BasicsCard } from "./BasicsCard";
import { CertificateCard } from "./CertificateCard";
import { cardsOf, sectionsOf, type MapPart } from "./course-view";
import { CourseHeader } from "./CourseHeader";
import { GalleryCard } from "./GalleryCard";
import { IncludesCard } from "./IncludesCard";
import { ModulesCard } from "./ModulesCard";
import { OutcomesCard } from "./OutcomesCard";
import { PublishCard } from "./PublishCard";
import { RecommendationsCard } from "./RecommendationsCard";
import { StagesCard } from "./StagesCard";
import { TestCard } from "./TestCard";
import { TypeCard } from "./TypeCard";
import type { CourseParts, OtherCourse } from "./types";

const cents = (s: string) => (s.trim() ? parseEuroCents(s) : null);

/** The course card of the cards' fields as the catalogue would show it (the real card's data), for the badge's preview. */
function previewCard(d: CourseDraft, next: { startsAt: string; city: string } | null): CourseCardData {
  const online = d.type === "e_learning";
  const course = {
    id: d.id ?? 0,
    slug: d.slug || "uus",
    type: d.type,
    level: d.level,
    title: d.title.et.trim() ? d.title : { et: adminEt.courseEditor.newTitle },
    summary: d.summary,
    price: online ? cents(d.price) : null,
    priceGroup: online ? null : cents(d.priceGroup),
    priceIndividual: online ? null : cents(d.priceIndividual),
    badge: d.badge,
    images: d.images.map((img, i) => ({ id: i, courseId: d.id ?? 0, key: img.key, alt: img.alt, sort: i })),
  } as unknown as CourseWithImages;
  return courseCardData(course, next ? { startsAt: new Date(next.startsAt), city: next.city } : undefined, "et", et, (p) => p);
}

export type PublishSwitches = { published: boolean; sample: boolean; onPublished: (on: boolean) => void; onSample: (on: boolean) => void; busy?: boolean; error?: string | null };

/**
 * The course editor's page (README B2; the Part 3 desktop frame, Part 4 phone frame): the header, then under the H1 the PublishBar (`bar`, a published
 * course's), then from 1180 px three columns — the 190 px section map, the cards, the 300 px sticky side column („Avaldamine“, „Koolituse märgis“) —
 * and below 1180 px one: the map's „Jaotised ▾“ select under the header, the side column straight after it, then the cards. The cards are only the
 * ones of the (drafted) type, in screen order; the modules' card is the existing LessonsEditor in its place.
 */
export function CourseView({
  title,
  published,
  sample,
  status,
  publicHref,
  notice,
  bar,
  parts,
  courseId,
  modules,
  others,
  next,
  locked,
  liveType,
  priceMissing,
  blocked,
  frozen,
  switches,
}: {
  title: string;
  published: boolean;
  sample: boolean;
  status: ReactNode;
  publicHref: string | null;
  notice?: ReactNode;
  bar?: ReactNode;
  parts: CourseParts;
  courseId: number | null;
  modules: AdminModule[];
  others: OtherCourse[];
  next: { startsAt: string; city: string } | null;
  locked: boolean;
  liveType: CourseType;
  priceMissing: boolean;
  /** The parts the last publish could not publish: their map entries say „Kontrolli“. */
  blocked: readonly string[];
  /** The editor waits for the page's new read (it starts over from it): the cards are inert and aria-busy meanwhile. */
  frozen?: boolean;
  switches: PublishSwitches;
}) {
  const type = parts.basics.fields.type;
  const online = type === "e_learning";
  const { basics, price, badge, gallery } = parts;
  const card = useMemo(
    () => previewCard({ ...newCourseDraft(), id: courseId, ...basics.fields, ...price.fields, badge: badge.fields.badge, images: gallery.fields.images }, next),
    [courseId, basics.fields, price.fields, badge.fields.badge, gallery.fields.images, next],
  );
  const sections = sectionsOf(
    type,
    Object.fromEntries(Object.entries(parts).map(([part, api]) => [part, { value: api.fields, attention: api.attention }])) as { [P in EditorPart]: MapPart<P> },
    modules.length,
    // the type card holds the basics' type: its refusal or the basics' conflict is that card's look too (review M-5)
    parts.basics.conflict || parts.basics.error("type") ? [...blocked, "price"] : blocked,
  );

  const cards: Record<string, ReactNode> = {
    basics: <BasicsCard api={parts.basics} />,
    price: <TypeCard basics={parts.basics} price={parts.price} locked={locked} liveType={liveType} priceMissing={priceMissing} />,
    outcomes: <OutcomesCard api={parts.outcomes} />,
    outline: <ModulesCard courseId={courseId} online={online} modules={modules} />,
    includes: <IncludesCard api={parts.includes} />,
    protocolStages: <StagesCard api={parts.protocolStages} type={type} />,
    test: <TestCard api={parts.test} />,
    certificate: <CertificateCard api={parts.certificate} outcomes={parts.outcomes.fields.outcomes} />,
    gallery: <GalleryCard api={parts.gallery} />,
    recommendations: <RecommendationsCard api={parts.recommendations} others={others} />,
  };

  return (
    <div className={ui.page} data-course-editor="">
      <CourseHeader title={title} published={published} sample={sample} type={type} status={status} publicHref={publicHref} />
      {notice}
      {bar}
      <div className={styles.layout} inert={frozen || undefined} aria-busy={frozen || undefined} data-cards-waiting={frozen ? "" : undefined}>
        <SectionMap sections={sections} />
        <div className={styles.main}>
          {cardsOf(type).map((part) => (
            <Fragment key={part}>{cards[part]}</Fragment>
          ))}
        </div>
        {/* (sticky at the top, not a bottom bar: no data-fab-avoid — the 💬 bubble would lift over the PublishBar's buttons above it) */}
        <aside className={styles.side}>
          <PublishCard {...switches} />
          <BadgeCard api={parts.badge} card={card} />
        </aside>
      </div>
    </div>
  );
}
