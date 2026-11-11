import type { Metadata } from "next";
import Link from "next/link";
import { CourseList } from "@/components/admin/CourseList";
import { coursePills, courseRowOf, coursesIn, courseView } from "@/components/admin/course-rows";
import { ListEmpty } from "@/components/admin/ListStates";
import { ListToolbar } from "@/components/admin/ListToolbar";
import { adminTitle } from "@/components/admin/sections";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { listAllCourses } from "@/db/queries/admin";
import { listCourseAreas } from "@/db/queries/public";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { requireAdmin } from "@/server/auth";
import styles from "./courses.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.courses) };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Koolitused (B1): every course, drafts included, in the public order. The pills Kõik / E-õpe / Kontaktõpe carry the counts (the toolbar has no search: there
 * are six courses); the list is DragList's rows with the handle, the arrows and, on a phone, the „↕“ menu; the whole row opens the editor. The status says
 * Avaldatud, Mustand, or Avaldamata muudatused while the draft layer holds changes of a published course. "Lisa koolitus" opens an empty editor. The
 * order can be changed only in „Kõik“ (`?vorm=` filters in memory, and its neighbours are not all in sight), which the page says. UX pass A5: the line
 * under a title names its area, and a fourth pill „Määramata valdkond“ (`?valdkond=puudub`) shows the courses that have none.
 */
export default async function CoursesPage({ searchParams }: Props) {
  await requireAdmin();
  const sp = await searchParams;
  const view = courseView(sp);
  const db = getDb();
  const [all, areas] = await Promise.all([listAllCourses(db), listCourseAreas(db)]);
  const areaName = new Map(areas.map((a) => [a.id, a.name.et]));
  const list = coursesIn(all, view);
  const t = adminEt.courses;

  return (
    <div className={ui.page}>
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={ui.h1}>{t.title}</h1>
          <p className={ui.lead}>{t.lead}</p>
        </div>
        <Link className={ui.btn} href="/admin/koolitused/uus" data-add-course="">
          {t.add} +
        </Link>
      </div>

      <ListToolbar pillRows={[{ label: t.filterLabel, pills: coursePills(all, view) }]} />

      <div className={styles.box}>
        <section className={`${ui.card} ${styles.card}`} aria-label={t.title}>
          <p className={`${ui.muted} ${ui.small} ${styles.count}`}>{fill(t.count, { n: list.length })}</p>
          {list.length === 0 ? (
            <ListEmpty things={t.things} filtered={view !== null} clearHref="/admin/koolitused" />
          ) : (
            <>
              {view && (
                <p className={styles.hint} data-order-hint="">
                  {t.orderHint}
                </p>
              )}
              <CourseList courses={list.map((c) => courseRowOf(c, c.areaId == null ? null : (areaName.get(c.areaId) ?? null)))} ordered={view === null} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
