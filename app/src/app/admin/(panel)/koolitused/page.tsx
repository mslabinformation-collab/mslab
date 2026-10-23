import type { Metadata } from "next";
import Link from "next/link";
import { CourseList } from "@/components/admin/CourseList";
import { courseRowOf } from "@/components/admin/course-rows";
import { ListEmpty } from "@/components/admin/ListStates";
import { ListToolbar, type ListPill } from "@/components/admin/ListToolbar";
import { adminTitle } from "@/components/admin/sections";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { listAllCourses } from "@/db/queries/admin";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { requireAdmin } from "@/server/auth";
import styles from "./courses.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.courses) };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const FORMS = { e: "e_learning", k: "contact" } as const;

/**
 * Koolitused (B1): every course, drafts included, in the public order. The pills Kõik / E-õpe / Kontaktõpe carry the counts (the toolbar has no search: there
 * are six courses); the list is DragList's rows with the handle, the arrows and, on a phone, the „↕“ menu; the whole row opens the editor. The status says
 * Avaldatud, Mustand, or Avaldamata muudatused while the draft layer holds changes of a published course. "Lisa koolitus" opens an empty editor. The
 * order can be changed only in „Kõik“ (`?vorm=` filters in memory, and its neighbours are not all in sight), which the page says.
 */
export default async function CoursesPage({ searchParams }: Props) {
  await requireAdmin();
  const sp = await searchParams;
  const vorm = sp.vorm === "e" || sp.vorm === "k" ? sp.vorm : null;
  const all = await listAllCourses(getDb());
  const list = vorm ? all.filter((c) => c.type === FORMS[vorm]) : all;
  const t = adminEt.courses;
  const pills: ListPill[] = [
    { key: null, label: t.filter.all, count: all.length },
    { key: "e" as const, label: t.filter.e, count: all.filter((c) => c.type === FORMS.e).length },
    { key: "k" as const, label: t.filter.k, count: all.filter((c) => c.type === FORMS.k).length },
  ].map((p) => ({ href: p.key ? `/admin/koolitused?vorm=${p.key}` : "/admin/koolitused", label: p.label, count: p.count, current: vorm === p.key }));

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

      <ListToolbar pillRows={[{ label: t.typeLabel, pills }]} />

      <div className={styles.box}>
        <section className={`${ui.card} ${styles.card}`} aria-label={t.title}>
          <p className={`${ui.muted} ${ui.small} ${styles.count}`}>{fill(t.count, { n: list.length })}</p>
          {list.length === 0 ? (
            <ListEmpty things={t.things} filtered={vorm !== null} clearHref="/admin/koolitused" />
          ) : (
            <>
              {vorm && (
                <p className={styles.hint} data-order-hint="">
                  {t.orderHint}
                </p>
              )}
              <CourseList courses={list.map(courseRowOf)} ordered={vorm === null} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
